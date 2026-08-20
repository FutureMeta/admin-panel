// La scrittura di un ciclo di campionamento. Fase 2, passo 2.
//
// Due statement e una transazione: il registro dei cicli e le righe per
// server. Stanno insieme perche' la convenzione sparsa lo esige — «nessuna
// riga per (tick, server) dentro un tick ok significa zero giocatori» e' vera
// solo se il tick e le sue righe compaiono nello stesso istante. Scritti
// separatamente, un lettore che arriva in mezzo vede un tick `ok` senza righe,
// cioe' una rete vuota che non c'e' mai stata.

import { sql } from 'kysely';
import type { Database } from '#src/db/pool.ts';

/** Il sentinella del transito, fissato dalla migration 011. */
export const TRANSIT_SERVER_ID = 1;
/** Il totale di rete: vive in poll_cycle.players, mai nel grezzo. */
export const NETWORK_SERVER_ID = 0;

export type CycleStatus = 'ok' | 'partial' | 'failed' | 'skipped';

/**
 * Una riga del registro dei cicli.
 *
 * `deltaS` e' valorizzato ESATTAMENTE quando lo stato e' `ok`: e' il vincolo
 * `poll_cycle_ok_covers` della 011, e dice che solo un ciclo riuscito copre
 * del tempo. Un ciclo fallito che dichiarasse una copertura accrediterebbe
 * alla media del tempo che nessuno ha osservato.
 */
export type CycleRow = {
  tickAt: Date;
  runId: string;
  status: CycleStatus;
  deltaS: number | null;
  durationMs: number | null;
  players: number | null;
  keysRead: number | null;
  keysSkipped: number | null;
  serversSeen: number | null;
  scanIterations: number | null;
  scanTruncated: boolean;
  dbsize: number | null;
  pttlMinS: number | null;
  pttlMaxS: number | null;
  skewS: number | null;
  skewRejected: number;
  serversPlayers: number | null;
  errorKind: string | null;
};

/** Quanti giocatori su un server, in un tick. Mai zero: la 011 lo rifiuta. */
export type ServerCount = { serverId: number; players: number };

/** SQLSTATE di «nessuna partizione trovata per la riga». */
const NO_PARTITION = '23514';

function sqlState(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

/**
 * Il dizionario dei server, tenuto in memoria.
 *
 * Un server nuovo non deve far fallire un ciclo e non deve costare una query
 * per giocatore: si risolve dalla cache, e i soli nomi mai visti si inseriscono
 * in un colpo. A regime, dopo il primo ciclo, questa classe non parla piu' col
 * database.
 */
export class ServerDictionary {
  readonly #byKey = new Map<string, number>();

  get size(): number {
    return this.#byKey.size;
  }

  /** Ricarica tutto. Si chiama all'avvio: 22 righe, una query. */
  async load(db: Database): Promise<void> {
    const res = await sql<{ server_id: number; server_key: string }>`
      SELECT server_id, server_key FROM stats.server
    `.execute(db);
    this.#byKey.clear();
    for (const r of res.rows) this.#byKey.set(r.server_key, r.server_id);
  }

  /**
   * Gli id dei nomi dati, creando le righe mancanti.
   *
   * `ON CONFLICT DO UPDATE` e non `DO NOTHING`: con DO NOTHING la RETURNING
   * non emette niente per le righe gia' presenti, e un'altra istanza che
   * inserisse lo stesso server nello stesso istante ci lascerebbe senza id.
   */
  async resolve(db: Database, keys: Iterable<string>): Promise<Map<string, number>> {
    const missing = [...new Set(keys)].filter((k) => k !== '' && !this.#byKey.has(k));
    if (missing.length > 0) {
      const res = await sql<{ server_id: number; server_key: string }>`
        INSERT INTO stats.server (server_key)
        SELECT k FROM unnest(${missing}::text[]) AS k
        ON CONFLICT (server_key) DO UPDATE SET last_seen_at = now()
        RETURNING server_id, server_key
      `.execute(db);
      for (const r of res.rows) this.#byKey.set(r.server_key, r.server_id);
    }
    return new Map(this.#byKey);
  }

  /** L'id di un nome gia' noto, o quello del transito per la stringa vuota. */
  idOf(key: string): number | undefined {
    return key === '' ? TRANSIT_SERVER_ID : this.#byKey.get(key);
  }

  /** Segna vivi i server visti. Non a ogni ciclo: vedi il chiamante. */
  async touch(db: Database, serverIds: number[]): Promise<void> {
    if (serverIds.length === 0) return;
    await sql`
      UPDATE stats.server SET last_seen_at = now()
       WHERE server_id = ANY(${serverIds}::smallint[])
    `.execute(db);
  }
}

/**
 * Scrive un ciclo e le sue righe, in una transazione sola.
 *
 * Ritenta UNA volta se manca la partizione: e' il guasto che a mezzanotte
 * farebbe fallire ogni ciclo fino a che qualcuno non se ne accorge, e il
 * grafico diventerebbe bianco senza che il codice del grafico c'entri niente.
 * Una volta e non in ciclo: se `ensure_partitions` non risolve, il problema e'
 * un altro e va visto.
 */
export async function writeCycle(db: Database, cycle: CycleRow, samples: ServerCount[]): Promise<void> {
  try {
    await insertCycle(db, cycle, samples);
  } catch (err) {
    if (sqlState(err) !== NO_PARTITION) throw err;
    await sql`SELECT stats.ensure_partitions()`.execute(db);
    await insertCycle(db, cycle, samples);
  }
}

async function insertCycle(db: Database, c: CycleRow, samples: ServerCount[]): Promise<void> {
  await db.transaction().execute(async (tx) => {
    await sql`
      INSERT INTO stats.poll_cycle (
        tick_at, run_id, status, delta_s, duration_ms, players,
        keys_read, keys_skipped, servers_seen, scan_iterations, scan_truncated,
        dbsize, pttl_min_s, pttl_max_s, skew_s, skew_rejected, servers_players, error_kind)
      VALUES (
        ${c.tickAt}, ${c.runId}::uuid, ${c.status}::stats.cycle_status, ${c.deltaS},
        ${c.durationMs}, ${c.players}, ${c.keysRead}, ${c.keysSkipped}, ${c.serversSeen},
        ${c.scanIterations}, ${c.scanTruncated}, ${c.dbsize}, ${c.pttlMinS}, ${c.pttlMaxS},
        ${c.skewS}, ${c.skewRejected}, ${c.serversPlayers}, ${c.errorKind})
      -- Due cicli sullo stesso istante li respinge il database, non una if:
      -- succede riversando l'anello dei cicli non scritti dopo un guasto.
      ON CONFLICT (tick_at) DO NOTHING
    `.execute(tx);

    if (samples.length > 0) {
      await sql`
        INSERT INTO stats.sample_server (tick_at, server_id, delta_s, players)
        SELECT ${c.tickAt}, s.server_id, ${c.deltaS}, s.players
          FROM unnest(${samples.map((s) => s.serverId)}::smallint[],
                      ${samples.map((s) => s.players)}::int[]) AS s(server_id, players)
        ON CONFLICT (tick_at, server_id) DO NOTHING
      `.execute(tx);
    }

    if (c.status === 'ok') {
      await sql`
        UPDATE stats.ingest_state
           SET last_tick_at = ${c.tickAt},
               last_ok_tick_at = ${c.tickAt},
               last_tick_players = ${c.players}
         WHERE id = 1
      `.execute(tx);
    } else {
      // `last_tick_at` avanza anche sui cicli non riusciti: dice «il poller
      // stava girando». `last_ok_tick_at` no, ed e' la differenza da cui si
      // ricava il ritardo vero della raccolta.
      await sql`
        UPDATE stats.ingest_state SET last_tick_at = ${c.tickAt} WHERE id = 1
      `.execute(tx);
    }
  });
}

/** I parametri di campionamento, letti dal database e non da una costante. */
export type IngestSettings = {
  nominalDeltaS: number;
  maxDeltaS: number;
  graceTicks: number;
  reaperAfterS: number;
};

export async function readSettings(db: Database): Promise<IngestSettings> {
  const res = await sql<{
    nominal_delta_s: number;
    max_delta_s: number;
    grace_ticks: number;
    reaper_after_s: number;
  }>`
    SELECT nominal_delta_s, max_delta_s, grace_ticks, reaper_after_s FROM stats.ingest_state WHERE id = 1
  `.execute(db);
  const row = res.rows[0];
  if (!row) throw new Error('stats.ingest_state vuota: la migration 011 non e` stata applicata');
  return {
    nominalDeltaS: Number(row.nominal_delta_s),
    maxDeltaS: Number(row.max_delta_s),
    graceTicks: Number(row.grace_ticks),
    reaperAfterS: Number(row.reaper_after_s),
  };
}
