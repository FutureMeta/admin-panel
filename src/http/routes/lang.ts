// Le rotte di «Lingue».
//
// SEI ROTTE, TUTTE DEL PANNELLO. Non ce n'e' una per i server di gioco,
// e non e' una mancanza: i server parlano col database di Metaverse, non con
// noi. Ci scrivono i testi del jar all'avvio e ne rileggono l'impronta ogni
// minuto. Il pannello scrive nello stesso posto, e loro se ne accorgono da
// soli. Nessuna riga di Java cambia.
//
// DUE MODULI, uno per schermata (migration 023):
//
//   `lingue` — Bundle, con le chiavi e la traduzione
//      1  legge i testi
//      2  li traduce e li corregge, anche con l'AI — arrivano in gioco entro
//         un minuto, senza bozza sul server
//   `lingue_elenco` — Elenco
//      1  vede le lingue
//      3  le crea, le accende per i giocatori, le rinomina, le riordina, le
//         cancella — coi loro testi
//
// IL MINIMESSAGE NON SI CONTROLLA. I tag li risolve il plugin — `<player>`,
// `<server>` e quelli che ogni bundle si inventa — e il pannello non ha la
// lista: un controllo qui rifiuterebbe testi giusti. L'unico «no» e' il testo
// vuoto, che ha un rimedio preciso: `<reset>`.
//
// L'AI PROPONE, NON SALVA. «Genera con l'AI» restituisce un testo che finisce
// nel campo come bozza; lo salva una persona con la PUT di sempre. Usa la
// chiave e il tetto di spesa dell'assistente: un portafoglio solo.

import { Anthropic } from '@anthropic-ai/sdk';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '#src/app-context.ts';
import { costUsdOn, type TokenUsage } from '#src/assistant/config.ts';
import { AUDIT_ACTIONS } from '#src/audit/actions.ts';
import { writeAudit } from '#src/audit/log.ts';
import { can, require as requireLevel } from '#src/authz/can.ts';
import type { DuelsMysql } from '#src/duels/mysql.ts';
import { AiTranslationFailed, TRANSLATE_MODEL, translateWithAi } from '#src/lang/ai.ts';
import {
  createLanguage,
  deleteLanguage,
  LanguageExists,
  listLanguages,
  moveLanguage,
  readBundleKeys,
  readKey,
  readOverview,
  setValue,
  UnknownBundle,
  UnknownKey,
  UnknownLanguage,
  UnsafeClick,
  updateLanguage,
} from '#src/lang/store.ts';
import { RateLimited } from '#src/ratelimit/limiter.ts';
import { REFERENCE } from '#web/lib/lang.ts';
import { requireAuth } from '../guards.ts';
import { actorOf, auditActorOf, auditContextOf, requestIps } from '../request-context.ts';

/** Un testo di gioco: una riga di chat, una lore, una scoreboard. 4 kB bastano. */
const MAX_VALUE = 4096;

/**
 * Le tre forme che arrivano dal client, strette QUI e non solo nello store.
 *
 * NON E' PIGNOLERIA: le colonne di Metaverse sono `ascii_bin`, che in MariaDB
 * ignora gli spazi in coda nei confronti. `en ` sarebbe uguale a `en` per il
 * database e diverso per il controllo «l'inglese non si cancella»: cancellava
 * l'inglese. Un codice e' `Locale.toString()` minuscolo — `en`, `pt_br`.
 */
const NS = { type: 'string', pattern: '^[a-z0-9_-]+\\.[a-z0-9_-]+$', maxLength: 64 } as const;
const KEY = { type: 'string', pattern: '^[A-Za-z0-9_][A-Za-z0-9_.-]*$', maxLength: 255 } as const;
const CODE = { type: 'string', pattern: '^[a-z]{2,3}(_[a-z0-9]{2,8})*$', maxLength: 16 } as const;

const nsQuery = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    required: ['ns'],
    properties: { ns: NS },
  },
} as const;

const valueBody = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['ns', 'key', 'code', 'value'],
    properties: {
      ns: NS,
      key: KEY,
      code: CODE,
      value: { type: 'string', maxLength: MAX_VALUE },
    },
  },
} as const;

const translateBody = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['ns', 'key', 'code'],
    properties: { ns: NS, key: KEY, code: CODE },
  },
} as const;

/** Traduzioni con l'AI in corso, per persona. */
const MAX_IN_FLIGHT = 3;
// ponytail: contatore del processo; con piu' istanze del pannello il tetto
// vale per istanza — allora va spostato su Redis, come i limiti di frequenza.
const inFlight = new Map<string, number>();

function acquireSlot(userId: string): boolean {
  const now = inFlight.get(userId) ?? 0;
  if (now >= MAX_IN_FLIGHT) return false;
  inFlight.set(userId, now + 1);
  return true;
}

function releaseSlot(userId: string): void {
  const left = (inFlight.get(userId) ?? 1) - 1;
  if (left <= 0) inFlight.delete(userId);
  else inFlight.set(userId, left);
}

const languageBody = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['code', 'display'],
    properties: {
      code: { type: 'string', pattern: '^[a-z]{2}$' },
      display: { type: 'string', minLength: 1, maxLength: 255 },
    },
  },
} as const;

const languagePatch = {
  params: {
    type: 'object',
    additionalProperties: false,
    required: ['code'],
    properties: { code: CODE },
  },
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      display: { type: 'string', minLength: 1, maxLength: 255 },
      active: { type: 'boolean' },
      move: { type: 'string', enum: ['up', 'down'] },
    },
  },
} as const;

/** Il testo e' scrivibile? Vuoto no, e il rifiuto dice cosa scrivere al suo posto. */
function refuse(reply: FastifyReply, value: string): FastifyReply | null {
  if (value.trim() === '') {
    return reply.code(400).send({
      error: 'testo vuoto',
      code: 'TESTO_VUOTO',
      detail: 'un testo vuoto non si salva: per un messaggio senza contenuto scrivi <reset>',
    });
  }
  return null;
}

export async function registerLangRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  /**
   * Senza `METAVERSE_MYSQL_URL` la sezione non esiste, e lo dice.
   *
   * 503 e non 404: la rotta c'e', e' l'installazione che non ha la connessione
   * al database di Metaverse. Un 404 manderebbe a cercare un errore di
   * instradamento.
   */
  const gameDb = (reply: FastifyReply): DuelsMysql | null => {
    if (ctx.metaverseMysql) return ctx.metaverseMysql;
    reply.code(503).send({
      error: 'lingue non disponibili',
      detail: 'manca METAVERSE_MYSQL_URL: il pannello non ha una connessione al database di Metaverse',
    });
    return null;
  };

  /**
   * A registro, dopo che la scrittura e' riuscita. Un guasto qui non fa
   * fallire la richiesta — il dato e' gia' salvato — ma lascia una riga di
   * errore forte: per questi valori il registro e' l'unico storico, e un
   * testo cambiato senza traccia e' un testo di cui nessuno sapra' piu'
   * com'era.
   */
  const audit = (
    request: FastifyRequest,
    actor: ReturnType<typeof actorOf>,
    action: (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS],
    target: { module: 'lingue' | 'lingue_elenco'; type: string; label: string },
    meta: Record<string, unknown>,
    outcome: 'success' | 'failure' = 'success',
  ): Promise<void> =>
    writeAudit(ctx.db, {
      action,
      outcome,
      actor: auditActorOf(actor),
      request: auditContextOf(request, requestIps(request)),
      moduleKey: target.module,
      targetType: target.type,
      targetId: null,
      targetLabel: target.label,
      meta,
    }).catch((err) => {
      ctx.logger.error({ err, action, target: target.label }, 'modifica NON registrata');
    });

  app.get('/api/lang', { preHandler: [requireAuth(ctx)] }, async (request, reply) => {
    // La leggono tutte e due le schermate: Bundle per i bundle, Elenco per le
    // lingue e quanto sono complete. Basta uno dei due moduli.
    const actor = actorOf(request);
    if (!can(actor, 'lingue', 1)) requireLevel(actor, 'lingue_elenco', 1);
    const db = gameDb(reply);
    if (db === null) return reply;
    reply.header('Cache-Control', 'private, no-store');
    return readOverview(db);
  });

  app.get('/api/lang/keys', { schema: nsQuery, preHandler: [requireAuth(ctx)] }, async (request, reply) => {
    requireLevel(actorOf(request), 'lingue', 1);
    const db = gameDb(reply);
    if (db === null) return reply;
    const { ns } = request.query as { ns: string };
    reply.header('Cache-Control', 'private, no-store');
    try {
      return await readBundleKeys(db, ns);
    } catch (err) {
      if (err instanceof UnknownBundle)
        return reply.code(404).send({ error: 'bundle sconosciuto', detail: ns });
      throw err;
    }
  });

  app.put(
    '/api/lang/value',
    { schema: valueBody, preHandler: [requireAuth(ctx)] },
    async (request, reply) => {
      const actor = actorOf(request);
      requireLevel(actor, 'lingue', 2);
      const db = gameDb(reply);
      if (db === null) return reply;
      const body = request.body as { ns: string; key: string; code: string; value: string };

      const refused = refuse(reply, body.value);
      if (refused !== null) return refused;

      let before: string | null;
      try {
        before = (await setValue(db, { ...body, author: actor.actorEmail })).before;
      } catch (err) {
        if (err instanceof UnsafeClick) {
          return reply.code(400).send({
            error: 'comando non previsto',
            code: 'COMANDO_NON_PREVISTO',
            detail: err.command,
          });
        }
        if (err instanceof UnknownBundle || err instanceof UnknownKey) {
          return reply.code(404).send({ error: 'chiave sconosciuta', detail: `${body.ns} ${body.key}` });
        }
        if (err instanceof UnknownLanguage) {
          return reply.code(404).send({ error: 'lingua sconosciuta', detail: body.code });
        }
        throw err;
      }

      await audit(
        request,
        actor,
        AUDIT_ACTIONS.langValueSet,
        { module: 'lingue', type: 'lang_value', label: `${body.ns} ${body.key} [${body.code}]` },
        { ns: body.ns, key: body.key, code: body.code, before, after: body.value },
      );

      return { ok: true };
    },
  );

  app.post(
    '/api/lang/language',
    { schema: languageBody, preHandler: [requireAuth(ctx)] },
    async (request, reply) => {
      const actor = actorOf(request);
      requireLevel(actor, 'lingue_elenco', 3);
      const db = gameDb(reply);
      if (db === null) return reply;
      const body = request.body as { code: string; display: string };

      const refused = refuse(reply, body.display);
      if (refused !== null) return refused;

      let language: Awaited<ReturnType<typeof createLanguage>>;
      try {
        language = await createLanguage(db, { ...body, author: actor.actorEmail });
      } catch (err) {
        if (err instanceof LanguageExists) {
          return reply.code(409).send({ error: 'lingua già presente', detail: body.code });
        }
        throw err;
      }

      await audit(
        request,
        actor,
        AUDIT_ACTIONS.langLanguageCreated,
        { module: 'lingue_elenco', type: 'lang_language', label: body.code },
        body,
      );

      return reply.code(201).send(language);
    },
  );

  app.delete(
    '/api/lang/language/:code',
    { schema: { params: languagePatch.params }, preHandler: [requireAuth(ctx)] },
    async (request, reply) => {
      const actor = actorOf(request);
      requireLevel(actor, 'lingue_elenco', 3);
      const db = gameDb(reply);
      if (db === null) return reply;
      const { code } = request.params as { code: string };
      // L'inglese e' il ripiego di tutto: senza, un giocatore con una lingua
      // incompleta non avrebbe piu' niente da leggere.
      if (code === REFERENCE) {
        return reply.code(400).send({ error: 'l’inglese è il riferimento', code: 'riferimento' });
      }

      let gone: Awaited<ReturnType<typeof deleteLanguage>>;
      try {
        gone = await deleteLanguage(db, code);
      } catch (err) {
        if (err instanceof UnknownLanguage) {
          return reply.code(404).send({ error: 'lingua sconosciuta', detail: code });
        }
        throw err;
      }

      await audit(
        request,
        actor,
        AUDIT_ACTIONS.langLanguageDeleted,
        { module: 'lingue_elenco', type: 'lang_language', label: code },
        { code, display: gone.display, texts: gone.texts },
      );
      return reply.code(204).send();
    },
  );

  app.patch(
    '/api/lang/language/:code',
    { schema: languagePatch, preHandler: [requireAuth(ctx)] },
    async (request, reply) => {
      const actor = actorOf(request);
      requireLevel(actor, 'lingue_elenco', 3);
      const db = gameDb(reply);
      if (db === null) return reply;
      const { code } = request.params as { code: string };
      const body = request.body as { display?: string; active?: boolean; move?: 'up' | 'down' };

      if (body.display !== undefined) {
        const refused = refuse(reply, body.display);
        if (refused !== null) return refused;
      }

      try {
        if (body.move !== undefined) await moveLanguage(db, code, body.move);
        const patch = {
          ...(body.display === undefined ? {} : { display: body.display }),
          ...(body.active === undefined ? {} : { active: body.active }),
        };
        const language = await updateLanguage(db, code, patch);

        await audit(
          request,
          actor,
          AUDIT_ACTIONS.langLanguageChanged,
          { module: 'lingue_elenco', type: 'lang_language', label: code },
          { code, ...body },
        );

        return language;
      } catch (err) {
        if (err instanceof UnknownLanguage) {
          return reply.code(404).send({ error: 'lingua sconosciuta', detail: code });
        }
        throw err;
      }
    },
  );

  app.post(
    '/api/lang/translate',
    { schema: translateBody, preHandler: [requireAuth(ctx)] },
    async (request, reply) => {
      const actor = actorOf(request);
      requireLevel(actor, 'lingue', 2);
      const db = gameDb(reply);
      if (db === null) return reply;
      const ai = ctx.assistant;
      if (ai === null) {
        return reply.code(503).send({
          error: 'AI non configurata',
          code: 'ai_non_configurata',
          detail: 'manca ANTHROPIC_API_KEY nell’ambiente del processo',
        });
      }
      const body = request.body as { ns: string; key: string; code: string };
      if (body.code === REFERENCE) {
        return reply.code(400).send({ error: 'l’inglese è il riferimento', code: 'riferimento' });
      }

      await ctx.rateLimit.consumeAll([
        ['langAiUser', actor.userId],
        ['langAiGlobal', 'tutti'],
      ]);
      // Tre in corso per persona, come la traduzione in blocco. Il tetto di
      // spesa si guarda PRIMA di ogni chiamata e si aggiorna DOPO: senza un
      // limite alle chiamate contemporanee, una raffica le farebbe passare
      // tutte sotto il tetto prima che la prima abbia pagato. Il posto si
      // prende SUBITO, prima di qualunque attesa, e si lascia su ogni uscita.
      if (!acquireSlot(actor.userId)) throw new RateLimited('langAiInFlight', 2000);
      try {
        const now = new Date();
        if (await ai.spend.exhausted(now)) {
          return reply.code(503).send({
            error: 'tetto di spesa raggiunto',
            code: 'tetto_di_spesa',
            detail: 'il budget mensile dell’AI è esaurito: si traduce a mano fino al mese prossimo',
          });
        }

        // L'inglese lo legge il server. Se lo mandasse il client, questa rotta
        // sarebbe un traduttore gratuito per qualunque testo.
        let source: string | undefined;
        try {
          source = (await readKey(db, body.ns, body.key))[REFERENCE];
        } catch (err) {
          if (err instanceof UnknownBundle || err instanceof UnknownKey) {
            return reply.code(404).send({ error: 'chiave sconosciuta', detail: `${body.ns} ${body.key}` });
          }
          throw err;
        }
        if (source === undefined || source.trim() === '') {
          return reply.code(409).send({ error: 'niente da tradurre', code: 'niente_da_tradurre' });
        }
        // Una lingua che non c'e' non si traduce: il salvataggio poi la
        // rifiuterebbe, e la chiamata sarebbe pagata per niente.
        if (!(await listLanguages(db)).some((l) => l.code === body.code)) {
          return reply.code(404).send({ error: 'lingua sconosciuta', detail: body.code });
        }

        const target = {
          module: 'lingue' as const,
          type: 'lang_value',
          label: `${body.ns} ${body.key} [${body.code}]`,
        };
        const meta = { ns: body.ns, key: body.key, code: body.code, model: TRANSLATE_MODEL };
        const charge = (usage: TokenUsage): Promise<void> =>
          ai.spend.add(now, costUsdOn(TRANSLATE_MODEL, usage)).catch((err) => {
            ctx.logger.error({ err }, 'lingue: spesa dell’AI NON contata');
          });

        try {
          // La spesa si conta a ogni tentativo, appena arriva: anche quello che
          // un guasto dell'API sul secondo farebbe altrimenti dimenticare.
          const result = await translateWithAi(ai.client, { ...body, source }, charge);
          await audit(request, actor, AUDIT_ACTIONS.langAiTranslated, target, {
            ...meta,
            attempts: result.attempts,
          });
          return { text: result.text };
        } catch (err) {
          if (err instanceof AiTranslationFailed) {
            await audit(
              request,
              actor,
              AUDIT_ACTIONS.langAiTranslated,
              target,
              { ...meta, failure: err.code },
              'failure',
            );
            return reply.code(422).send({ error: 'traduzione non riuscita', code: err.code });
          }
          if (err instanceof Anthropic.APIError) {
            ctx.logger.warn({ err, status: err.status }, 'lingue: AI non raggiungibile');
            return reply.code(503).send({ error: 'AI non raggiungibile', code: 'ai_non_raggiungibile' });
          }
          throw err;
        }
      } finally {
        releaseSlot(actor.userId);
      }
    },
  );
}
