// La rotta di Svetlana. Una sola, e in streaming.
//
// STA SOTTO `/api/stream/` PER FORZA, non per gusto. nginx ha un blocco
// dedicato a quel prefisso con `proxy_buffering off`, `proxy_cache off` e
// `X-Accel-Buffering: no` (deploy/nginx.conf:125): fu predisposto in fase 2
// proprio per la prima rotta SSE. Sotto qualunque altro percorso la risposta
// finirebbe nel buffer di nginx, la chat resterebbe muta per minuti e poi
// arriverebbe tutta insieme — e la diagnosi sarebbe lunga, perche' in locale
// senza proxy funziona benissimo.
//
// E' UNA POST, non una GET con EventSource. Tre ragioni, tutte e tre
// sufficienti: `EventSource` non manda intestazioni, quindi non potrebbe
// portare il token CSRF; una GET che consuma soldi e scrive nel registro e'
// esattamente cio' che `assertNoStateChangingGet` esiste per impedire; e una
// GET con i cookie e' innescabile da un altro sito, cioe' un modo per far
// spendere a qualcun altro.
//
// LA CHIAVE DELL'API NON ESCE DA QUI. Il browser parla con questa rotta, e'
// questa rotta a parlare con Anthropic. Non c'e' nessun percorso in cui la
// chiave raggiunga il client.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '#src/app-context.ts';
import { ASSISTANT_MODEL, costUsd } from '#src/assistant/config.ts';
import { screenOf } from '#src/assistant/pages.ts';
import type { AssistantEvent, RunResult } from '#src/assistant/runner.ts';
import { runAssistant } from '#src/assistant/runner.ts';
import { AUDIT_ACTIONS, AUDIT_VIA_ASSISTANT } from '#src/audit/actions.ts';
import { writeAudit } from '#src/audit/log.ts';
import { require as requireLevel } from '#src/authz/can.ts';
import { RANGES } from '#src/stats/contract.ts';
import { requireAuth } from '../guards.ts';
import { actorOf, auditActorOf, auditContextOf, requestIps } from '../request-context.ts';

const chatSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['text', 'page'],
    properties: {
      /**
       * L'identificativo della conversazione. Assente = se ne comincia una.
       *
       * Non e' un segreto: la chiave in Valkey comprende anche l'id utente,
       * quindi lo stesso identificativo in mano a un'altra persona apre una
       * conversazione diversa e vuota.
       */
      conversationId: { type: 'string', pattern: '^[0-9a-f-]{36}$' },
      // Duemila caratteri. Piu' lunga di cosi' non e' una domanda, ed e' il
      // primo tetto che rende prevedibile il costo di un messaggio.
      text: { type: 'string', minLength: 1, maxLength: 2000 },
      page: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: {
          // Il TITOLO non arriva dal client: lo sceglie `screenOf`. Vedi il
          // commento in testa a `src/assistant/pages.ts` — quel testo finisce
          // in un messaggio di sistema, e li' dentro non entra niente che
          // qualcun altro abbia scritto.
          path: { type: 'string', maxLength: 128 },
          range: { type: 'string', enum: [...RANGES] },
          // Lo stesso alfabeto chiuso del contratto delle statistiche: una
          // chiave fuori da qui non puo' esistere in `stats.mode`, e non e'
          // una stringa in cui ci stia una frase.
          mode: { type: 'string', pattern: '^[a-z0-9_]{1,32}$' },
        },
      },
    },
  },
} as const;

type ChatBody = {
  conversationId?: string;
  text: string;
  page: { path: string; range?: string; mode?: string };
};

/** Un evento SSE. Una riga `data:` e una riga vuota, che e' cio' che chiude il pacchetto. */
function sseLine(event: AssistantEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export function registerAssistantRoutes(app: FastifyInstance, ctx: AppContext): void {
  const notConfigured = (reply: FastifyReply) =>
    // 503 e non 404: la rotta esiste, e' l'installazione che non ha una
    // chiave. Un 404 manderebbe a cercare un errore di instradamento.
    reply.code(503).send({
      error: 'assistente non configurato',
      code: 'non_configurato',
      detail: 'manca ANTHROPIC_API_KEY nell`ambiente del processo',
    });

  app.post(
    '/api/stream/assistant',
    { schema: chatSchema, preHandler: [requireAuth(ctx)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = actorOf(request);
      requireLevel(actor, 'assistente', 1);

      const assistant = ctx.assistant;
      if (!assistant) return notConfigured(reply);

      const body = request.body as ChatBody;
      const now = new Date();

      // I DUE LIMITI IN AND, come ovunque nel pannello: quello per persona e
      // il tetto per rotta. Il secondo e' l'unico che protegge dalla somma di
      // dieci persone che indagano insieme.
      await ctx.rateLimit.consumeAll([
        ['assistantUser', actor.userId],
        ['assistantGlobal', 'tutti'],
      ]);

      // IL TETTO DI SPESA SI GUARDA PRIMA, non dopo. Superato, Svetlana si
      // spegne con un messaggio che dice cosa e' successo: fallire a meta'
      // risposta lascerebbe chi legge a chiedersi se il pannello e' rotto.
      if (await assistant.spend.exhausted(now)) {
        assistant.meter.recordOverBudget();
        ctx.logger.warn(
          { spentUsd: assistant.spend.lastSeenUsd, capUsd: assistant.spend.capUsd },
          'assistente: tetto di spesa del mese raggiunto, messaggi rifiutati',
        );
        return reply.code(503).send({
          error: 'tetto di spesa raggiunto',
          code: 'tetto_di_spesa',
          detail:
            'il budget mensile dell`assistente e` esaurito: Svetlana resta spenta ' +
            'fino al mese prossimo, o finche` qualcuno non alza il tetto',
        });
      }

      const conversationId = body.conversationId ?? crypto.randomUUID();
      const history = await assistant.conversations.read(actor.userId, conversationId);
      const screen = screenOf(body.page.path);

      // Da qui in poi la risposta e' nostra: Fastify non ci mette piu' mano, e
      // qualunque errore va detto DENTRO lo stream. Un errore lanciato dopo
      // questo punto lascerebbe la richiesta appesa.
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        // Cintura e bretelle: nginx ha gia' il blocco per questo prefisso, ma
        // la difesa non deve dipendere da un file di configurazione altrui.
        'x-accel-buffering': 'no',
      });

      const controller = new AbortController();
      // Il client che chiude la scheda non deve lasciare in volo una richiesta
      // che si sta pagando.
      raw.on('close', () => controller.abort());

      const write = (event: AssistantEvent): void => {
        if (!raw.writableEnded) raw.write(sseLine(event));
      };

      const run = runAssistant(
        {
          client: assistant.client,
          data: assistant.data,
          effort: assistant.effort,
          logger: ctx.logger,
          signal: controller.signal,
        },
        {
          conversationId,
          actor,
          text: body.text,
          page: {
            path: screen.path,
            title: screen.title,
            ...(body.page.range ? { range: body.page.range } : {}),
            ...(body.page.mode ? { mode: body.page.mode } : {}),
          },
          history,
          now,
        },
      );

      let outcome: 'success' | 'failure' = 'success';
      let final: RunResult | null = null;

      try {
        // Il generatore restituisce il riepilogo con `return`, quindi si
        // scorre a mano: un `for await` scarterebbe proprio quel valore.
        for (;;) {
          const step = await run.next();
          if (step.done) {
            final = step.value;
            break;
          }
          write(step.value);
        }
      } catch (err) {
        outcome = 'failure';
        assistant.meter.recordError();
        // UN GUASTO DELL'API DIVENTA UN MESSAGGIO NELLA CHAT, mai una
        // richiesta appesa. Il dettaglio resta nei log: al browser va una
        // frase, non lo stack di una libreria.
        ctx.logger.error({ err, conversationId }, 'assistente: la chiamata all`API non e` riuscita');
        write({
          type: 'error',
          code: 'api_non_raggiungibile',
          message:
            'Non sono riuscita a completare la risposta. Riprova fra poco; ' +
            'se continua, il problema e` il collegamento verso il fornitore.',
        });
      }

      if (final) {
        await assistant.conversations
          .write(actor.userId, conversationId, final.turns)
          .catch((err) => ctx.logger.error({ err }, 'assistente: conversazione non conservata'));

        assistant.meter.recordMessage({
          usage: final.usage,
          iterations: final.iterations,
          truncated: final.truncated,
        });
        for (const call of final.calls) assistant.meter.recordTool(call.name, call.outcome);
        await assistant.spend
          .add(now, costUsd(final.usage))
          .catch((err) => ctx.logger.error({ err }, 'assistente: spesa non contabilizzata'));
      }

      // ---------------------------------------------------------------------
      // Il registro attivita'.
      //
      // Non blocca la risposta e un guasto non la fa fallire — e' gia' finita.
      // La riga dice CHI, CHE COSA HA CHIESTO e QUALI TOOL sono partiti con
      // quali argomenti: senza gli argomenti, «ha usato panel_user_search» non
      // risponde a «chi ha guardato i dati di quella persona», che e' la
      // domanda per cui questa riga esiste.
      // ---------------------------------------------------------------------
      const denied = (final?.calls ?? []).filter((c) => c.outcome === 'denied').map((c) => c.name);
      void writeAudit(ctx.db, {
        action: AUDIT_ACTIONS.assistantMessage,
        outcome: denied.length > 0 && outcome === 'success' ? 'denied' : outcome,
        actor: auditActorOf(actor),
        request: auditContextOf(request, requestIps(request)),
        moduleKey: 'assistente',
        targetType: 'assistant_conversation',
        targetId: conversationId,
        targetLabel: screen.title,
        meta: {
          via: AUDIT_VIA_ASSISTANT,
          model: ASSISTANT_MODEL,
          question: body.text,
          screen: screen.path,
          iterations: final?.iterations ?? 0,
          truncated: final?.truncated ?? false,
          calls: (final?.calls ?? []).map((c) => ({ tool: c.name, outcome: c.outcome, args: c.args })),
          tokens: final?.usage ?? null,
        },
      }).catch((err) => {
        ctx.logger.error({ err }, 'assistente: interazione non registrata, la riga di registro manca');
      });

      if (!raw.writableEnded) raw.end();
    },
  );
}
