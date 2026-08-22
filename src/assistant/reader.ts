// Le letture che i tool di Svetlana possono fare, e nient'altro.
//
// PERCHE' STANNO QUI E NON DENTRO I TOOL. I tool sono la superficie che il
// modello vede: nomi, descrizioni, schemi. Le query sono cio' che quella
// superficie puo' raggiungere, e tenerle separate rende leggibile in un file
// solo l'intera area che l'assistente puo' toccare. Se un giorno qualcuno
// aggiunge una colonna a una di queste SELECT, il diff dice esattamente «e'
// uscito un dato in piu' verso un fornitore esterno», che e' la frase che
// merita una revisione.
//
// LA MINIMIZZAZIONE E' QUI DENTRO, riga per riga: si seleziona cio' che serve
// alla risposta, non la riga intera. Nessun indirizzo IP esce da nessuna di
// queste funzioni — il registro ne ha due colonne e non compaiono, e nello
// schema delle statistiche non ci sono gia' oggi.
//
// I NUMERI SONO GLI STESSI DELLE SCHERMATE, e non per caso: le statistiche e i
// duels passano dagli stessi costruttori di payload e dalla stessa cache che
// servono le rotte. Una seconda aggregazione «piu' semplice» darebbe risposte
// che somigliano a quelle del pannello senza coincidere, ed e' la forma di
// errore piu' difficile da scoprire — perche' nessuno confronta due numeri che
// si aspetta uguali.

import { sql } from 'kysely';
import { dominates } from '#src/authz/dominance.ts';
import type { Database } from '#src/db/pool.ts';
import { DK, type DuelsTrends, duelsQuality, TOP_LIMIT } from '#src/duels/contract.ts';
import type { DuelsProvider } from '#src/duels/provider.ts';
import { inflate, type StatsCache } from '#src/stats/cache.ts';
import type { OverviewPayload, Range } from '#src/stats/contract.ts';
import { buildAll } from '#src/stats/read.ts';
import { K, ttlOf } from '#src/stats/warm.ts';

/** Le porte sui dati. Ognuna puo' mancare: il tool corrispondente lo dice. */
export type AssistantData = {
  /**
   * Il pool di SOLA LETTURA dell'assistente: `auth` e `audit`.
   *
   * Non e' `ctx.db`. Quello scrive, e la regola della v1 e' che nessun tool
   * possa modificare niente — una regola che vale quanto il posto in cui e'
   * scritta. Qui sta nel database (migration 019, ruolo `metamc_assistant`).
   */
  panelDb: Database | null;
  /** Il pool di sola lettura delle statistiche, gia' esistente dalla fase 2. */
  statsDb: Database | null;
  duels: DuelsProvider | null;
  cache: StatsCache;
};

// ---------------------------------------------------------------------------
// Statistiche di rete
// ---------------------------------------------------------------------------

/**
 * Il payload della panoramica, dalla stessa cache che serve la schermata.
 *
 * Se il giro di riscaldamento l'ha gia' costruito — e nel caso normale l'ha
 * fatto — questa funzione non lancia nessuna query. E' anche il motivo per cui
 * il numero che Svetlana dice e quello che si legge sulla schermata sono lo
 * stesso numero, byte per byte, e non due calcoli che si assomigliano.
 */
async function overview(data: AssistantData, range: Range): Promise<OverviewPayload> {
  const db = data.statsDb;
  if (!db) throw new NotConfigured('statistiche');
  const env = await data.cache.envelope(
    K.ov(range),
    async () => {
      const built = await buildAll(db, range, undefined, []);
      return Buffer.from(JSON.stringify(built.overview), 'utf8');
    },
    ttlOf(),
    11,
  );
  // `inflate(env)` e NON `env.body`: i byte in cache sono COMPRESSI in brotli.
  // Le rotte non se ne accorgono perche' li rispediscono cosi' come sono —
  // decomprimere per far ricomprimere a valle sarebbe pagare due volte — ma
  // qui quei byte si LEGGONO, e `JSON.parse` su un flusso brotli non fallisce
  // con un messaggio che si capisce: fallisce su un carattere qualunque.
  return JSON.parse(await inflate(env)) as OverviewPayload;
}

/** Una porta non configurata. La rotta la traduce in un risultato, non in un 500. */
export class NotConfigured extends Error {
  readonly what: string;
  constructor(what: string) {
    super(`sorgente non configurata: ${what}`);
    this.name = 'NotConfigured';
    this.what = what;
  }
}

export type OnlineNow = {
  /** L'ultimo ciclo riuscito. `null` se non ce n'e' uno abbastanza recente. */
  live: { players: number; at: number } | null;
  /**
   * La popolazione per modalita', dall'ultimo payload costruito.
   *
   * E' PIU' VECCHIA del numero vivo, e l'istante lo dice. Le due cose non si
   * possono mescolare: il totale vivo si legge a ogni richiesta con una
   * lettura per chiave primaria, la ripartizione arriva da un payload
   * costruito ogni pochi minuti. Presentarle come un unico «adesso» e'
   * esattamente il tipo di piccola bugia che rende inutile un pannello.
   */
  byMode: { at: number; players: Record<string, number> } | null;
  /** Il massimo di sempre, con l'istante e da quando si guarda. */
  record: { players: number; at: number | null; since: number } | null;
  /** Come si conta «online»: la definizione viaggia col numero. */
  note: string;
};

export async function readOnlineNow(data: AssistantData): Promise<OnlineNow> {
  const db = data.statsDb;
  if (!db) throw new NotConfigured('statistiche');

  const res = await sql<{ players: number; tick_at: Date }>`
    SELECT players, tick_at FROM stats.v_online_now
     WHERE tick_at > now() - interval '10 minutes'
  `.execute(db);
  const row = res.rows[0];

  const payload = await overview(data, '24h');
  const labels = payload.labels;

  return {
    live: row ? { players: Number(row.players), at: Math.floor(row.tick_at.getTime() / 1000) } : null,
    byMode: payload.current
      ? {
          at: payload.current.at,
          players: Object.fromEntries(
            Object.entries(payload.current.byMode).map(([key, v]) => [labels[key] ?? key, v]),
          ),
        }
      : null,
    record: payload.record,
    note:
      'Online = identita` con una chiave viva nel Redis di gioco (TTL ~104 s), ' +
      'quindi strutturalmente piu` alto del conteggio del proxy. La ripartizione ' +
      'per modalita` viene dall`ultimo payload costruito, non dall`istante vivo.',
  };
}

export type NetworkTrend = {
  range: Range;
  /** La modalita' chiesta, o `null` per tutta la rete. */
  mode: string | null;
  /** Media normalizzata sul profilo orario; `null` se la copertura e' zero. */
  average: number | null;
  /** Massimo nei soli bucket chiusi, con l'istante e la copertura di quel bucket. */
  peak: { players: number; at: number | null; coverage: number } | null;
  /** Giocatori distinti nel periodo. Non la somma degli unici giornalieri. */
  uniques: number | null;
  /** Secondi osservati / secondi nominali. Sotto 1 il periodo ha buchi. */
  coverage: number;
  /** Ultimo istante definitivo: oltre, il dato e' ancora in formazione. */
  closedThrough: number;
  /** Le modalita' piu' popolate del periodo, per media. */
  topModes: Array<{ mode: string; average: number }>;
};

export async function readNetworkTrend(
  data: AssistantData,
  range: Range,
  mode: string | null,
): Promise<NetworkTrend> {
  const db = data.statsDb;
  if (!db) throw new NotConfigured('statistiche');

  if (mode !== null) {
    // Una modalita' sola: si costruisce quella e basta. Costruirle tutte per
    // servirne una paga le tre query per modalita', che sono le piu' care.
    const env = await data.cache.envelope(
      K.md(mode, range),
      async () => {
        const built = await buildAll(db, range, undefined, [mode]);
        const one = built.perMode.get(mode);
        if (!one) throw new UnknownMode(mode);
        return Buffer.from(JSON.stringify(one), 'utf8');
      },
      ttlOf(),
      5,
    );
    const payload = JSON.parse(await inflate(env)) as OverviewPayload;
    return project(payload, range, mode);
  }

  return project(await overview(data, range), range, null);
}

export class UnknownMode extends Error {
  constructor(mode: string) {
    super(`modalita\` sconosciuta: ${mode}`);
    this.name = 'UnknownMode';
  }
}

/**
 * Da un payload da centinaia di punti a una manciata di numeri.
 *
 * SI TAGLIA QUI E NON NEL PROMPT. Un payload della panoramica sono migliaia di
 * token — la serie, la heatmap 7x24, gli unici per giorno, la geografia — e
 * quasi tutto serve a DISEGNARE, non a rispondere. Mandarlo intero costerebbe
 * a ogni domanda quanto l'intera conversazione, e la parte in piu' non
 * migliorerebbe una sola risposta.
 */
function project(payload: OverviewPayload, range: Range, mode: string | null): NetworkTrend {
  const averageOf = (values: (number | null)[]): number => {
    const seen = values.filter((v): v is number => v !== null);
    if (seen.length === 0) return 0;
    return seen.reduce((a, b) => a + b, 0) / seen.length;
  };

  const topModes = payload.modes
    .filter((key) => !payload.outOfBreakdown.includes(key))
    .map((key) => ({
      mode: payload.labels[key] ?? key,
      average: Math.round(averageOf(payload.online.series[key] ?? []) * 10) / 10,
    }))
    .sort((a, b) => b.average - a.average)
    .slice(0, 8);

  return {
    range,
    mode: mode === null ? null : (payload.labels[mode] ?? mode),
    average: payload.kpi.avg === null ? null : Math.round(payload.kpi.avg * 10) / 10,
    peak:
      payload.kpi.peak === null
        ? null
        : { players: payload.kpi.peak, at: payload.kpi.peakAt, coverage: payload.kpi.peakCoverage },
    uniques: payload.kpi.uniques,
    coverage: Math.round(payload.kpi.coverage * 1000) / 1000,
    closedThrough: payload.closedThrough,
    topModes,
  };
}

// ---------------------------------------------------------------------------
// Duels
// ---------------------------------------------------------------------------

export type DuelsSummary = {
  range: Range;
  matches: number;
  /** 'YYYY-MM-DD': prima di questo giorno il dato non esiste. */
  since: string | null;
  topModes: Array<{ name: string; matches: number; type: string | null; ranking: string | null }>;
  topMaps: Array<{ name: string | null; matches: number; type: string | null }>;
  /** Le tre ore della settimana con piu' partite, in fuso locale. */
  busiest: Array<{ day: string; hour: number; matches: number }>;
};

const DAYS = ['lunedi', 'martedi', 'mercoledi', 'giovedi', 'venerdi', 'sabato', 'domenica'];

export async function readDuelsSummary(data: AssistantData, range: Range, now: Date): Promise<DuelsSummary> {
  const provider = data.duels;
  if (!provider) throw new NotConfigured('duels');

  const env = await data.cache.envelope(
    DK.tr(range),
    async () => Buffer.from(JSON.stringify(await provider.trends(range, now)), 'utf8'),
    ttlOf(),
    duelsQuality(range),
  );
  const trends = JSON.parse(await inflate(env)) as DuelsTrends;

  // La heatmap e' SEMPRE 168 celle, indice = dow * 24 + hour, dow 0 = lunedi.
  // Le prime tre bastano: «quando si gioca di piu`» e' una domanda a cui si
  // risponde con tre righe, non con centosessantotto.
  const busiest = trends.heatmap.cells
    .map((matches, index) => ({ index, matches: matches ?? 0 }))
    .filter((c) => c.matches > 0)
    .sort((a, b) => b.matches - a.matches)
    .slice(0, 3)
    .map((c) => ({
      day: DAYS[Math.floor(c.index / 24)] ?? '?',
      hour: c.index % 24,
      matches: c.matches,
    }));

  return {
    range,
    matches: trends.totals.matches,
    since: trends.since,
    // `TOP_LIMIT` righe escono dal provider; qui ne bastano cinque. Il totale
    // resta quello vero — e' `totals.matches`, non la somma di queste.
    topModes: trends.modes.slice(0, 5).map((m) => ({
      name: m.name,
      matches: m.matches,
      type: m.type,
      ranking: m.ranking,
    })),
    topMaps: trends.maps.slice(0, 5).map((m) => ({ name: m.name, matches: m.matches, type: m.type })),
    busiest,
  };
}

/** Quante righe il provider manda per intero prima di «Altre». Serve alla descrizione del tool. */
export { TOP_LIMIT };

// ---------------------------------------------------------------------------
// Utenti del pannello
// ---------------------------------------------------------------------------

export type PanelUser = {
  id: string;
  email: string;
  name: string;
  status: string;
  banned: boolean;
  banReason: string | null;
  banExpires: string | null;
  createdAt: string;
  /** L'ultima sessione toccata. `null` se non e' mai entrato. */
  lastSeenAt: string | null;
  roles: string[];
  /** Su quanti moduli ha almeno la lettura. */
  modules: number;
  /**
   * Chi sta chiedendo puo' AGIRE su questa persona? SEC-08.
   *
   * Viaggia perche' senza, Svetlana suggerirebbe operazioni che chi legge non
   * puo' eseguire — e scoprirlo dopo, con un 404 che sembra un errore, e' il
   * modo peggiore di imparare la gerarchia.
   */
  canManage: boolean;
};

/**
 * `LIKE` con i caratteri jolly disinnescati.
 *
 * Senza, un termine che contiene `%` cerca tutto: non e' una falla — la query
 * e' parametrica e non c'e' nessuna concatenazione — ma e' una ricerca che
 * risponde una cosa per un'altra, che qui vuol dire mandare a un fornitore
 * esterno l'elenco completo dello staff invece di una riga.
 */
function likeTerm(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export async function searchPanelUsers(
  data: AssistantData,
  actorId: string,
  term: string,
  limit: number,
): Promise<PanelUser[]> {
  const db = data.panelDb;
  if (!db) throw new NotConfigured('assistente');

  const pattern = likeTerm(term.trim());
  const rows = await db
    .selectFrom('auth.user as u')
    .select([
      'u.id',
      'u.email',
      'u.name',
      'u.status',
      'u.banned',
      'u.ban_reason',
      'u.ban_expires',
      'u.createdAt',
    ])
    // Gli eliminati non compaiono, come nella schermata: la riga esiste solo
    // per il registro e per la storia degli inviti.
    .where('u.deleted_at', 'is', null)
    .where((eb) => eb.or([eb('u.email', 'ilike', pattern), eb('u.name', 'ilike', pattern)]))
    .orderBy('u.createdAt', 'desc')
    .limit(limit)
    .execute();

  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const [roles, lastSeen, moduleCounts, manageable] = await Promise.all([
    db
      .selectFrom('auth.user_roles as ur')
      .innerJoin('auth.roles as r', 'r.id', 'ur.role_id')
      .select(['ur.user_id', 'r.name'])
      .where('ur.user_id', 'in', ids)
      .execute(),
    db
      .selectFrom('auth.session')
      .select(({ fn }) => ['userId', fn.max('updatedAt').as('lastSeenAt')])
      .where('userId', 'in', ids)
      .groupBy('userId')
      .execute(),
    db
      .selectFrom('auth.effective_permissions')
      .select(({ fn }) => ['user_id', fn.countAll<string>().as('modules')])
      .where('level', '>', 0)
      .where('user_id', 'in', ids)
      .groupBy('user_id')
      .execute(),
    // La dominanza si chiede alla stessa funzione che governa le rotte, una
    // riga per bersaglio. Riscriverne una variante «piu' efficiente» qui
    // dentro significherebbe avere due regole di escalation invece di una, e
    // la seconda non la guarda nessun test di sicurezza.
    Promise.all(ids.map((id) => dominates(db, actorId, id))),
  ]);

  const rolesByUser = new Map<string, string[]>();
  for (const r of roles) rolesByUser.set(r.user_id, [...(rolesByUser.get(r.user_id) ?? []), r.name]);
  const seenByUser = new Map(lastSeen.map((s) => [s.userId, s.lastSeenAt]));
  const modulesByUser = new Map(moduleCounts.map((m) => [m.user_id, Number(m.modules)]));

  return rows.map((u, index) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    status: u.status,
    banned: u.banned,
    banReason: u.ban_reason,
    banExpires: u.ban_expires instanceof Date ? u.ban_expires.toISOString() : (u.ban_expires ?? null),
    createdAt: u.createdAt instanceof Date ? u.createdAt.toISOString() : String(u.createdAt),
    lastSeenAt: (() => {
      const at = seenByUser.get(u.id);
      return at instanceof Date ? at.toISOString() : (at ?? null);
    })(),
    roles: rolesByUser.get(u.id) ?? [],
    modules: modulesByUser.get(u.id) ?? 0,
    canManage: manageable[index] === true,
  }));
}

// ---------------------------------------------------------------------------
// Registro attivita'
// ---------------------------------------------------------------------------

export type AuditEntry = {
  occurredAt: string;
  /** Denormalizzato: com'era l'identita' AL MOMENTO DEL FATTO. */
  actor: { email: string | null; name: string | null };
  action: string;
  moduleKey: string | null;
  target: { type: string | null; id: string | null; label: string | null };
  outcome: string;
};

export type AuditFilter = {
  action?: string | undefined;
  moduleKey?: string | undefined;
  outcome?: 'success' | 'failure' | 'denied' | undefined;
  actorEmail?: string | undefined;
  limit: number;
};

export async function readRecentAudit(data: AssistantData, filter: AuditFilter): Promise<AuditEntry[]> {
  const db = data.panelDb;
  if (!db) throw new NotConfigured('assistente');

  let query = db
    .selectFrom('audit.audit_log')
    // NIENTE `actor_ip`, NIENTE `actor_socket_ip`, NIENTE `actor_user_agent`.
    // Il GRANT sulla tabella li comprende — non si puo' concedere per colonna
    // senza rendere illeggibile la migration — quindi la barriera e' questa
    // SELECT, ed e' il motivo per cui e' scritta a mano invece che con un
    // `selectAll()`.
    //
    // Nemmeno `before`, `after` e `meta`: sono JSON arbitrari, spesso grossi e
    // pieni di testo di terzi. Per il dettaglio di una modifica si apre il
    // Registro, e la descrizione del tool lo dice.
    .select([
      'occurred_at',
      'actor_email',
      'actor_display_name',
      'action',
      'module_key',
      'target_type',
      'target_id',
      'target_label',
      'outcome',
    ])
    .orderBy('occurred_at', 'desc')
    .orderBy('id', 'desc')
    .limit(filter.limit);

  if (filter.action) query = query.where('action', '=', filter.action);
  if (filter.moduleKey) query = query.where('module_key', '=', filter.moduleKey);
  if (filter.outcome) query = query.where('outcome', '=', filter.outcome);
  if (filter.actorEmail) query = query.where('actor_email', 'ilike', likeTerm(filter.actorEmail.trim()));

  const rows = await query.execute();
  return rows.map((r) => ({
    occurredAt: r.occurred_at instanceof Date ? r.occurred_at.toISOString() : String(r.occurred_at),
    actor: { email: r.actor_email, name: r.actor_display_name },
    action: r.action,
    moduleKey: r.module_key,
    target: { type: r.target_type, id: r.target_id, label: r.target_label },
    outcome: r.outcome,
  }));
}
