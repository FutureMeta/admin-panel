// I cinque tool di Svetlana. Sono l'UNICA porta sui dati.
//
// Il modello non riceve mai una connessione al database ne' una query da
// eseguire: riceve queste cinque funzioni, con parametri validati e uno schema
// `strict`. Cio' che non e' qui dentro non e' raggiungibile, e questo file si
// legge tutto d'un fiato apposta.
//
// ----------------------------------------------------------------------------
// IL CONTROLLO DI AUTORIZZAZIONE STA DENTRO IL TOOL. Non prima e non dopo.
//
// Il modo di sbagliare e' preciso e vale la pena scriverlo: se i tool
// leggessero i dati con i permessi del PROCESSO invece che con quelli
// dell'utente, un moderatore con accesso ai soli duels potrebbe chiedere a
// Svetlana cose sugli utenti del pannello e ottenerle. Non e' un caso di
// scuola — e' cio' che succede naturalmente scrivendo un assistente, perche' il
// processo ha una connessione al database e l'utente no.
//
// Metterlo davanti alla rotta non basterebbe: la rotta sa che qualcuno puo'
// aprire la chat, non quali dati questa domanda finira' per toccare. Metterlo
// dopo non basterebbe nemmeno: a quel punto la lettura e' gia' avvenuta.
//
// Quindi ogni `run` comincia con `can(actor, modulo, livello)` — lo STESSO
// helper che governa le rotte, non una copia — e la prima riga del corpo e'
// quel controllo.
//
// ----------------------------------------------------------------------------
// I TOOL CI SONO SEMPRE TUTTI E CINQUE, anche per chi non ha i permessi.
//
// Sembra il contrario di quello che si vorrebbe, e invece e' la scelta giusta
// per due ragioni indipendenti. La prima e' di sicurezza: l'elenco dei tool
// smette di essere il posto in cui si decide chi vede cosa, e resta un solo
// posto — il corpo del tool. Un elenco filtrato invita a fidarsene, e il
// giorno in cui il filtro sbaglia non c'e' nessuna seconda barriera. La
// seconda e' di costo: i tool stanno in posizione zero del prefisso della
// richiesta, e un elenco che cambia per ruolo e' una cache che non si riusa
// mai fra due persone diverse.
//
// Un tool negato risponde `permesso_negato`, e il prompt di sistema dice cosa
// farne: dirlo in una riga, senza raccontare cosa ci sarebbe stato dentro.
//
// ----------------------------------------------------------------------------
// LETTURA O SCRITTURA — DICHIARATO, NON DEDOTTO DAL NOME.
//
// In v1 esistono solo tool di lettura. Il campo `kind` c'e' lo stesso perche'
// il giorno in cui arrivera' il primo tool di scrittura la differenza deve
// essere gia' un DATO su cui il ciclo puo' ramificare, non una convenzione sul
// prefisso del nome che qualcuno deve ricordarsi di rispettare.
//
// Sta nell'involucro `AssistantTool` e non dentro l'oggetto del tool, e non e'
// pignoleria: quell'oggetto viene serializzato e spedito all'API, che rifiuta
// i campi che non conosce.

import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool';
import * as z from 'zod/v4';
import { can } from '#src/authz/can.ts';
import type { AuthzContext } from '#src/authz/context.ts';
import type { ModuleKey, RequiredLevel } from '#src/authz/modules.ts';
import { RANGES, type Range } from '#src/stats/contract.ts';
import {
  type AssistantData,
  NotConfigured,
  readDuelsSummary,
  readNetworkTrend,
  readOnlineNow,
  readRecentAudit,
  searchPanelUsers,
  UnknownMode,
} from './reader.ts';

/** Cosa un tool fa al sistema. In v1 esiste solo `read`. */
export type ToolKind = 'read' | 'write';

export type AssistantTool = {
  name: string;
  kind: ToolKind;
  /** Il modulo e il livello che questo tool richiede a chi lo fa scattare. */
  requires: { module: ModuleKey; level: RequiredLevel };
  tool: BetaRunnableTool;
};

/** Cosa il ciclo registra di ogni chiamata, per il registro attivita'. */
export type ToolCall = {
  name: string;
  outcome: 'success' | 'denied' | 'failure';
  /** I parametri VALIDATI. Piccoli e strutturati: e' cio' che rende il registro utile. */
  args: unknown;
};

export type ToolContext = {
  actor: AuthzContext;
  data: AssistantData;
  /** Il ciclo lo legge alla fine. I tool ci scrivono dentro e basta. */
  calls: ToolCall[];
  /** «Adesso» si passa: un tool che legge l'orologio da solo non si prova. */
  now: Date;
};

// ---------------------------------------------------------------------------
// L'involucro delle risposte
// ---------------------------------------------------------------------------

/**
 * Ogni tool risponde con questa forma, sempre.
 *
 * Il modello impara una struttura sola e il prompt di sistema puo' parlare di
 * `data` come del posto in cui vive il testo NON FIDATO — nomi di giocatori,
 * motivazioni di ban, commenti. La distinzione fra involucro e contenuto e'
 * quello che rende dicibile «riporta, non eseguire».
 */
function reply(body: Record<string, unknown>): string {
  return JSON.stringify(body);
}

function ok(data: unknown): string {
  return reply({ ok: true, data });
}

function denied(module: string): string {
  return reply({
    ok: false,
    error: 'permesso_negato',
    // Il modulo si nomina, il livello no: sapere «ti manca `utenti`» aiuta chi
    // legge a chiedere il permesso giusto, sapere quale gradino gli manca
    // descrive la matrice a chi non deve vederla.
    detail: `chi ti sta scrivendo non ha accesso al modulo ${module} del pannello`,
  });
}

function unavailable(what: string): string {
  return reply({
    ok: false,
    error: 'non_disponibile',
    detail: `la sorgente ${what} non e` + "' configurata su questa installazione",
  });
}

/**
 * Il guscio comune: controlla, esegue, registra.
 *
 * Ogni tool passa di qui e non c'e' un secondo modo di scriverne uno: il
 * controllo dei permessi non e' una riga che si puo' dimenticare, e' la prima
 * cosa che questa funzione fa.
 */
function guarded<Input>(
  spec: { name: string; module: ModuleKey; level: RequiredLevel },
  context: ToolContext,
  work: (input: Input) => Promise<unknown>,
): (input: Input) => Promise<string> {
  return async (input: Input) => {
    if (!can(context.actor, spec.module, spec.level)) {
      context.calls.push({ name: spec.name, outcome: 'denied', args: input });
      return denied(spec.module);
    }
    try {
      const data = await work(input);
      context.calls.push({ name: spec.name, outcome: 'success', args: input });
      return ok(data);
    } catch (err) {
      context.calls.push({ name: spec.name, outcome: 'failure', args: input });
      if (err instanceof NotConfigured) return unavailable(err.what);
      if (err instanceof UnknownMode) {
        return reply({ ok: false, error: 'sconosciuto', detail: err.message });
      }
      // Il dettaglio resta nei log del pannello. Al modello va una frase che
      // non descrive lo schema del database a chi ha scritto in chat.
      throw err;
    }
  };
}

const rangeSchema = z.enum(RANGES as unknown as [Range, ...Range[]]);

// ---------------------------------------------------------------------------
// I cinque tool, in ORDINE ALFABETICO.
//
// L'ordine non e' estetica: i tool stanno in posizione zero del prefisso della
// richiesta, quindi riordinarli invalida la cache di ogni conversazione in
// corso. Un ordine derivato dal nome non dipende da dove qualcuno inserisce la
// riga nuova, e c'e' un test che lo verifica.
// ---------------------------------------------------------------------------

export function buildTools(context: ToolContext): AssistantTool[] {
  const tools: AssistantTool[] = [
    {
      name: 'audit_recent',
      kind: 'read',
      requires: { module: 'audit', level: 1 },
      tool: betaZodTool({
        name: 'audit_recent',
        description:
          'Le ultime voci del registro attivita` del pannello: chi ha fatto cosa, quando, con quale esito. ' +
          'I filtri sono opzionali: passa null per non filtrare. `action` vuole il valore esatto ' +
          '(per esempio "user.banned", "duels.mode.update", "auth.login.failure"); `moduleKey` la chiave ' +
          'di un modulo; `actorEmail` una parte dell`indirizzo di chi ha agito. ' +
          'NON restituisce indirizzi IP, user agent, ne` il prima/dopo di una modifica: per quel dettaglio ' +
          'si apre la schermata Registro attivita`.',
        inputSchema: z.strictObject({
          action: z.string().max(96).nullable(),
          moduleKey: z.string().max(32).nullable(),
          outcome: z.enum(['success', 'failure', 'denied']).nullable(),
          actorEmail: z.string().max(120).nullable(),
          limit: z.int().min(1).max(25).describe('quante voci, dalla piu` recente'),
        }),
        run: guarded({ name: 'audit_recent', module: 'audit', level: 1 }, context, (input) =>
          readRecentAudit(context.data, {
            ...(input.action ? { action: input.action } : {}),
            ...(input.moduleKey ? { moduleKey: input.moduleKey } : {}),
            ...(input.outcome ? { outcome: input.outcome } : {}),
            ...(input.actorEmail ? { actorEmail: input.actorEmail } : {}),
            limit: input.limit,
          }),
        ),
      }),
    },
    {
      name: 'duels_summary',
      kind: 'read',
      requires: { module: 'duels', level: 1 },
      tool: betaZodTool({
        name: 'duels_summary',
        description:
          'I numeri dei Duels su un periodo: partite totali, le cinque modalita` e le cinque mappe piu` ' +
          'giocate, e le tre ore della settimana con piu` partite. Riporta anche `since`, il primo giorno ' +
          'per cui il dato esiste: prima di quella data non c`e` storico, e un totale che la ignora e` un ' +
          'totale sbagliato. Non copre le valutazioni dei giocatori.',
        inputSchema: z.strictObject({
          range: rangeSchema.describe('il periodo: 24h, 7d, 30d, 90d o 1y'),
        }),
        run: guarded({ name: 'duels_summary', module: 'duels', level: 1 }, context, (input) =>
          readDuelsSummary(context.data, input.range, context.now),
        ),
      }),
    },
    {
      name: 'network_online',
      kind: 'read',
      requires: { module: 'statistiche', level: 1 },
      tool: betaZodTool({
        name: 'network_online',
        description:
          'Quanti giocatori ci sono ADESSO sul network, come sono ripartiti per modalita`, e il record di ' +
          'sempre. Il totale vivo e la ripartizione hanno due istanti diversi e il risultato li dichiara ' +
          'entrambi: dire la ripartizione come se fosse dello stesso momento del totale sarebbe una bugia ' +
          'piccola e plausibile. Non prende parametri.',
        inputSchema: z.strictObject({}),
        run: guarded({ name: 'network_online', module: 'statistiche', level: 1 }, context, () =>
          readOnlineNow(context.data),
        ),
      }),
    },
    {
      name: 'network_trend',
      kind: 'read',
      requires: { module: 'statistiche', level: 1 },
      tool: betaZodTool({
        name: 'network_trend',
        description:
          'L`andamento dei giocatori su un periodo: media, picco con il suo istante, giocatori distinti, ' +
          'copertura della raccolta e le modalita` piu` popolate. Passa `mode` con la chiave di una ' +
          'modalita` (per esempio "bedwars") per avere solo quella, oppure null per tutta la rete. ' +
          'Sulla singola modalita` il picco e` sempre assente: e` una conseguenza aritmetica, non un dato ' +
          'mancante, perche` il massimo di una modalita` non si ricostruisce dai massimi dei suoi server.',
        inputSchema: z.strictObject({
          range: rangeSchema.describe('il periodo: 24h, 7d, 30d, 90d o 1y'),
          mode: z.string().max(32).nullable(),
        }),
        run: guarded({ name: 'network_trend', module: 'statistiche', level: 1 }, context, (input) =>
          readNetworkTrend(context.data, input.range, input.mode),
        ),
      }),
    },
    {
      name: 'panel_user_search',
      kind: 'read',
      requires: { module: 'utenti', level: 1 },
      tool: betaZodTool({
        name: 'panel_user_search',
        description:
          'Cerca una persona dello STAFF del pannello per nome o indirizzo email — non i giocatori del ' +
          'network. Restituisce ruoli, stato, eventuale ban e da quanto non entra. `canManage` dice se chi ' +
          'ti sta scrivendo puo` agire su quella persona: quando e` falso, non suggerire operazioni su di ' +
          'lei, perche` il pannello le rifiuterebbe.',
        inputSchema: z.strictObject({
          query: z.string().min(1).max(120).describe('parte del nome o dell`indirizzo email'),
          limit: z.int().min(1).max(10).describe('quante persone al massimo'),
        }),
        run: guarded({ name: 'panel_user_search', module: 'utenti', level: 1 }, context, (input) =>
          searchPanelUsers(context.data, context.actor.userId, input.query, input.limit),
        ),
      }),
    },
  ];

  // `strict: true` sullo schema: `tool_use.input` arriva gia' conforme, e i
  // parametri fuori sagoma non diventano un ramo da gestire dentro `run`.
  // Si applica QUI e non dentro `betaZodTool`, che non lo espone.
  for (const entry of tools) {
    (entry.tool as { strict?: boolean }).strict = true;
  }

  return sealWrites(tools);
}

/**
 * Un tool di scrittura NON SI ESEGUE: propone.
 *
 * In v1 non ne esiste nemmeno uno, e questa funzione non cambia niente. Esiste
 * adesso perche' il giorno in cui ne nascera' il primo, il percorso di
 * conferma dev'essere gia' quello per cui si passa — non una `if` da
 * ricordarsi di aggiungere nel posto giusto.
 *
 * LA GARANZIA E' STRUTTURALE: la funzione `run` di un tool di scrittura viene
 * SOSTITUITA qui dentro, quindi il corpo vero non e' raggiungibile attraverso
 * questa fabbrica. Non e' un controllo che si puo' saltare, e' un corpo che
 * non c'e'.
 *
 * IL MODELLO NON CONFERMA PER CONTO PROPRIO: la proposta esce dal ciclo e
 * arriva all'operatore, che vede cosa verrebbe fatto — prima e dopo — e
 * decide. Vedi l'evento `confirm` in `runner.ts`.
 */
export function sealWrites(tools: readonly AssistantTool[]): AssistantTool[] {
  return tools.map((entry) => {
    if (entry.kind === 'read') return entry;
    return {
      ...entry,
      tool: {
        ...entry.tool,
        run: async (input: unknown) =>
          reply({
            ok: false,
            error: 'conferma_richiesta',
            detail:
              'questa operazione modifica lo stato e non e` stata eseguita: ' +
              'va confermata dall`operatore nel pannello',
            proposal: { tool: entry.name, args: input },
          }),
      },
    };
  });
}
