// I tool di Svetlana. Sono l'UNICA porta sui dati.
//
// Il modello non riceve mai una connessione al database ne' una query da
// eseguire: riceve queste funzioni, con parametri validati e uno schema
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
// I TOOL CI SONO SEMPRE TUTTI, anche per chi non ha i permessi.
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
  readNetworkCountries,
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
    detail: `la sorgente ${what} non risulta configurata su questa installazione`,
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
      if (err instanceof BadArgument) {
        return reply({ ok: false, error: 'argomento_non_valido', detail: err.message });
      }
      // Il dettaglio resta nei log del pannello. Al modello va una frase che
      // non descrive lo schema del database a chi ha scritto in chat.
      throw err;
    }
  };
}

const rangeSchema = z.enum(RANGES as unknown as [Range, ...Range[]]);

// ---------------------------------------------------------------------------
// I LIMITI SUI VALORI STANNO NEL CODICE, NON NELLO SCHEMA.
//
// Non e' una scelta di stile: `strict: true` accetta un SOTTOINSIEME di JSON
// Schema, e `minimum`/`maximum` non ne fanno parte. L'API rifiuta l'intera
// richiesta con
//
//     tools.0.custom: For 'integer' type, properties maximum, minimum are
//     not supported
//
// e la chat non risponde affatto — non «risponde male»: non parte. Scoperto al
// primo messaggio in produzione, il 2026-08-23, perche' nessun test parla con
// l'API vera.
//
// LO SCHEMA RESTA `strict` E GARANTISCE LA FORMA: tipi giusti, nessuna
// proprieta' in piu', tutte obbligatorie. Il VALORE lo governano queste due
// funzioni, ed e' un posto migliore di prima: un limite dichiarato in uno
// schema e' una richiesta al modello, un limite applicato qui e' un fatto.
// ---------------------------------------------------------------------------

/**
 * Le parole di JSON Schema che `strict: true` NON accetta.
 *
 * NON BASTA NON SCRIVERLE. `z.int()` da solo emette `minimum` e `maximum` con
 * i limiti dell'intero sicuro di JavaScript — nessuno le ha chieste, e la
 * richiesta viene rifiutata lo stesso. Lo schema lo genera una libreria di cui
 * non controlliamo l'uscita, quindi si normalizza al CONFINE: cosi' la
 * prossima versione di zod che aggiunge una parola non ferma la chat in
 * produzione.
 *
 * E' un elenco di NEGAZIONE, come le altre guardie del progetto: non prova che
 * lo schema sia valido — quello lo dice solo l'API — impedisce di ripetere
 * questa classe esatta di errore.
 */
export const UNSUPPORTED_BY_STRICT = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'pattern',
  'format',
  'multipleOf',
  // Non porta niente che l'API debba sapere, e ogni parola in piu' in uno
  // schema `strict` e' un'occasione di essere rifiutati. Toglierlo non puo'
  // rompere niente.
  '$schema',
] as const;

/**
 * Porta lo schema dentro il sottoinsieme che `strict` accetta.
 *
 * Toglie le parole di troppo e aggiunge `required` dove manca: senza
 * proprieta', zod non lo emette affatto, e uno schema che dichiara
 * `additionalProperties: false` senza dire cosa e' obbligatorio e' scritto in
 * un modo diverso da tutti gli altri per nessuna ragione.
 */
function normaliseSchema(node: unknown): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) normaliseSchema(child);
    return;
  }
  const record = node as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if ((UNSUPPORTED_BY_STRICT as readonly string[]).includes(key)) {
      delete record[key];
      continue;
    }
    normaliseSchema(record[key]);
  }
  if (record.type === 'object' && record.properties && !record.required) {
    record.required = Object.keys(record.properties as object);
  }
}

/** Un intero riportato dentro i limiti. Fuori scala si taglia, non si rifiuta. */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Una stringa tagliata alla lunghezza massima. */
function cut(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/**
 * L'alfabeto delle chiavi di modalita', lo stesso del contratto delle
 * statistiche.
 *
 * Serve QUI perche' la chiave entra in una chiave di cache: una stringa
 * qualunque costruirebbe voci che nessuno riscaldera' mai. La rotta
 * `/api/stats/mode` lo impone con un `pattern` nello schema di Fastify; qui
 * `pattern` non si puo' usare, quindi lo impone il codice.
 */
const MODE_KEY = /^[a-z0-9_]{1,32}$/;

/**
 * Un parametro che lo schema non puo' piu' rifiutare da solo.
 *
 * Si lancia e `guarded` la traduce, come per le altre due: cosi' il controllo
 * sta accanto alla lettura che protegge invece che in un ramo lontano.
 */
class BadArgument extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'BadArgument';
  }
}

// ---------------------------------------------------------------------------
// I tool, in ORDINE ALFABETICO.
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
          action: z.string().nullable(),
          moduleKey: z.string().nullable(),
          outcome: z.enum(['success', 'failure', 'denied']).nullable(),
          actorEmail: z.string().nullable(),
          limit: z.int().describe('quante voci, dalla piu` recente. Da 1 a 25'),
        }),
        run: guarded({ name: 'audit_recent', module: 'audit', level: 1 }, context, (input) =>
          readRecentAudit(context.data, {
            ...(input.action ? { action: cut(input.action, 96) } : {}),
            ...(input.moduleKey ? { moduleKey: cut(input.moduleKey, 32) } : {}),
            ...(input.outcome ? { outcome: input.outcome } : {}),
            ...(input.actorEmail ? { actorEmail: cut(input.actorEmail, 120) } : {}),
            limit: clamp(input.limit, 1, 25),
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
      name: 'network_countries',
      kind: 'read',
      requires: { module: 'statistiche', level: 1 },
      tool: betaZodTool({
        name: 'network_countries',
        description:
          'Da quali PAESI vengono i giocatori nel periodo. Conta PERSONE, non accessi: ogni giocatore ' +
          'compare una volta sola, con il paese noto piu` recente. I codici sono ISO 3166-1 alpha-2 ' +
          '("IQ" e` l`Iraq). DUE VALORI NON SONO PAESI e non vanno mai riportati come tali: "XX" e` chi ' +
          'ha un indirizzo che non si e` riusciti a risolvere, "--" chi e` stato visto quando la ' +
          'geolocalizzazione era spenta. Se `enabled` e` falso la funzione non e` attiva su questa ' +
          'installazione, che e` diverso da «nessuno in questo periodo». Segue il periodo scelto: su ' +
          '24 ore e su un anno sono due domande diverse.',
        inputSchema: z.strictObject({
          range: rangeSchema.describe('il periodo: 24h, 7d, 30d, 90d o 1y'),
          mode: z.string().nullable(),
          limit: z.int().describe('quanti paesi al massimo, dal piu` popolato. Da 1 a 60'),
        }),
        run: guarded({ name: 'network_countries', module: 'statistiche', level: 1 }, context, (input) => {
          if (input.mode !== null && !MODE_KEY.test(input.mode)) {
            throw new BadArgument(
              'la chiave di una modalita` e` fatta di lettere minuscole, cifre e trattini bassi',
            );
          }
          return readNetworkCountries(context.data, input.range, input.mode, clamp(input.limit, 1, 60));
        }),
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
          mode: z.string().nullable(),
        }),
        run: guarded({ name: 'network_trend', module: 'statistiche', level: 1 }, context, (input) => {
          // La chiave entra in una chiave di CACHE, quindi si controlla prima
          // di leggere: una stringa qualunque costruirebbe voci che nessuno
          // riscaldera' mai.
          if (input.mode !== null && !MODE_KEY.test(input.mode)) {
            throw new BadArgument(
              'la chiave di una modalita` e` fatta di lettere minuscole, cifre e trattini bassi',
            );
          }
          return readNetworkTrend(context.data, input.range, input.mode);
        }),
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
          query: z.string().describe('parte del nome o dell`indirizzo email'),
          limit: z.int().describe('quante persone al massimo. Da 1 a 10'),
        }),
        run: guarded({ name: 'panel_user_search', module: 'utenti', level: 1 }, context, (input) => {
          // UNA RICERCA VUOTA NON E' UNA RICERCA: `ILIKE '%%'` restituisce
          // l'elenco completo dello staff, che finirebbe a un fornitore
          // esterno al posto di una riga. Prima lo impediva `min(1)` nello
          // schema; adesso lo impedisce questa riga.
          const query = cut(input.query.trim(), 120);
          if (query === '') throw new BadArgument('serve un nome o una parte di indirizzo da cercare');
          return searchPanelUsers(context.data, context.actor.userId, query, clamp(input.limit, 1, 10));
        }),
      }),
    },
  ];

  // `strict: true` sullo schema: `tool_use.input` arriva gia' conforme, e i
  // parametri fuori sagoma non diventano un ramo da gestire dentro `run`.
  // Si applica QUI e non dentro `betaZodTool`, che non lo espone.
  for (const entry of tools) {
    (entry.tool as { strict?: boolean }).strict = true;
    // Dopo `strict`, e non prima: le due cose vanno insieme. `strict` chiede
    // uno schema dentro un sottoinsieme di JSON Schema, e questa riga e' cio'
    // che ce lo tiene qualunque cosa generi la libreria.
    normaliseSchema((entry.tool as { input_schema?: unknown }).input_schema);
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
