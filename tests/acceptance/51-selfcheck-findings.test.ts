// I tre difetti che il giro degli invarianti ha trovato in produzione.
//
// Non li ha trovati un test. Li ha trovati `stats-selfcheck` al PRIMO giro
// sui dati veri, e ognuno era in piedi da settimane senza rompere niente:
//
//   * `network_equals_servers` e `delta_agreement` — a ogni riavvio due cicli
//     scrivevano lo stesso `tick_at`, e `ON CONFLICT DO NOTHING` su entrambe
//     le tabelle teneva la riga di ciclo del PRIMO e l'unione delle righe per
//     server. Somma per server sopra il totale di rete di uno o due
//     giocatori, e `delta_s` che valeva 30 sul ciclo e 1 sulle righe nuove;
//   * `rollup_vs_raw` — l'ora appena chiusa nasceva corta di un bucket da
//     cinque minuti, e restava corta fino all'ora dopo;
//   * `geo_sum_equals_uniques` — chi restava online oltre la mezzanotte senza
//     cambiare server non aveva riga di presenza per il giorno nuovo, quindi
//     entrava negli unici di rete e in nessuna modalita'.
//
// Questi test esistono perche' la seconda volta li prenda qualcosa prima della
// produzione. Ognuno e' stato visto FALLIRE sul codice di prima.

import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createKysely, createPool, type Database } from '#src/db/pool.ts';
import { type CycleRow, writeCycle } from '#src/stats/ingest.ts';
import { runRollup } from '#src/stats/rollup.ts';
import { connect, createTestDatabase, type TestDatabase } from '#tests/support/postgres.ts';

let testDb: TestDatabase;
let pool: pg.Pool;
let db: Database;
let sql: pg.Client;
let ids: Record<string, number> = {};

const SERVERS = ['duels_1', 'duels_2', 'duels_3'];

beforeAll(async () => {
  testDb = await createTestDatabase('findings');
  pool = createPool({
    connectionString: testDb.ingestUrl,
    max: 4,
    applicationName: 'metamc-test-findings',
    connectionTimeoutMillis: 20_000,
    statementTimeout: '60s',
    searchPath: 'stats, public',
  });
  db = createKysely(pool);
  sql = await connect(testDb.migrateUrl, 'metamc-test-findings-sql');
}, 180_000);

afterAll(async () => {
  await sql?.end().catch(() => undefined);
  await db?.destroy().catch(() => undefined);
  await testDb?.drop();
});

beforeEach(async () => {
  await sql.query(`
    DELETE FROM stats.rollup_5m; DELETE FROM stats.rollup_1h; DELETE FROM stats.rollup_1d;
    DELETE FROM stats.sample_server; DELETE FROM stats.poll_cycle;
    DELETE FROM stats.player_day_server; DELETE FROM stats.player_day;
    DELETE FROM stats.session_open;
    DELETE FROM stats.server WHERE server_id > 1;`);

  await sql.query('INSERT INTO stats.server (server_key) SELECT unnest($1::text[])', [SERVERS]);
  const found = await sql.query<{ server_key: string; server_id: number }>(
    'SELECT server_key, server_id FROM stats.server WHERE server_id > 1',
  );
  ids = Object.fromEntries(found.rows.map((r) => [r.server_key, r.server_id]));
});

/** Un ciclo `ok` con i suoi campi obbligatori e niente di superfluo. */
function cycle(tickAt: Date, deltaS: number, players: number): CycleRow {
  return {
    tickAt,
    runId: '00000000-0000-4000-8000-000000000001',
    status: 'ok',
    deltaS,
    durationMs: 10,
    players,
    keysRead: players,
    keysSkipped: 0,
    serversSeen: 2,
    scanIterations: 1,
    scanTruncated: false,
    dbsize: 1000,
    pttlMinS: 90,
    pttlMaxS: 100,
    skewS: 0,
    skewRejected: 0,
    serversPlayers: players,
    errorKind: null,
  };
}

describe('due cicli sullo stesso slot non si mescolano', () => {
  it('il secondo non aggiunge righe per server sotto il ciclo del primo', async () => {
    // E` LA SCENA DEL RIAVVIO. Il processo vecchio ha scritto lo slot con
    // delta 30 e due server; il nuovo parte, si allinea allo stesso slot,
    // calcola delta 1 e vede un server in piu`.
    const tickAt = new Date('2026-08-21T14:00:00.000Z');
    await writeCycle(db, cycle(tickAt, 30, 150), [
      { serverId: ids['duels_1'] as number, players: 100 },
      { serverId: ids['duels_2'] as number, players: 50 },
    ]);
    await writeCycle(db, cycle(tickAt, 1, 152), [
      { serverId: ids['duels_1'] as number, players: 100 },
      { serverId: ids['duels_2'] as number, players: 50 },
      { serverId: ids['duels_3'] as number, players: 2 },
    ]);

    const rows = await sql.query<{ server_id: number; players: number; delta_s: number }>(
      'SELECT server_id, players, delta_s FROM stats.sample_server WHERE tick_at = $1 ORDER BY server_id',
      [tickAt],
    );

    // Due righe, non tre: il terzo server appartiene a un ciclo che non e`
    // stato scritto, e non ha nessuno slot sotto cui stare.
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every((r) => r.delta_s === 30)).toBe(true);
  });

  it('e la somma per server torna con il totale di rete', async () => {
    // L'invariante nella sua forma diretta: e` cio` che in produzione
    // sballava di uno o due giocatori a ogni riavvio.
    const tickAt = new Date('2026-08-21T14:00:30.000Z');
    await writeCycle(db, cycle(tickAt, 30, 150), [
      { serverId: ids['duels_1'] as number, players: 100 },
      { serverId: ids['duels_2'] as number, players: 50 },
    ]);
    await writeCycle(db, cycle(tickAt, 1, 152), [{ serverId: ids['duels_3'] as number, players: 2 }]);

    const check = await sql.query<{ rete: number; server: string }>(
      `SELECT c.players AS rete, coalesce(sum(s.players), 0)::text AS server
         FROM stats.poll_cycle c LEFT JOIN stats.sample_server s ON s.tick_at = c.tick_at
        WHERE c.tick_at = $1 GROUP BY c.players`,
      [tickAt],
    );
    expect(Number(check.rows[0]?.server)).toBe(check.rows[0]?.rete);
  });

  it('un ciclo su uno slot LIBERO scrive normalmente', async () => {
    // La correzione non deve trasformarsi in «non si scrive mai piu` niente»:
    // il caso normale e` uno slot vuoto, e li` tutto passa.
    const tickAt = new Date('2026-08-21T14:01:00.000Z');
    await writeCycle(db, cycle(tickAt, 30, 150), [
      { serverId: ids['duels_1'] as number, players: 100 },
      { serverId: ids['duels_2'] as number, players: 50 },
    ]);

    const rows = await sql.query('SELECT 1 FROM stats.sample_server WHERE tick_at = $1', [tickAt]);
    expect(rows.rowCount).toBe(2);
  });
});

describe('un`ora non si aggrega finche` i suoi cinque minuti non sono completi', () => {
  /** Un'ora piena di tick da trenta secondi, 150 giocatori di rete. */
  async function seedHour(hour: Date): Promise<void> {
    await sql.query(
      `INSERT INTO stats.poll_cycle (tick_at, run_id, status, delta_s, players, keys_read)
       SELECT g, gen_random_uuid(), 'ok', 30, 150, 150
         FROM generate_series($1::timestamptz, $1::timestamptz + interval '59 minutes 30 seconds',
                              interval '30 seconds') g`,
      [hour],
    );
    await sql.query(
      `INSERT INTO stats.sample_server (tick_at, server_id, delta_s, players)
       SELECT c.tick_at, $2::smallint, 30, 150 FROM stats.poll_cycle c WHERE c.tick_at >= $1`,
      [hour, ids['duels_1']],
    );
  }

  it('il giro orario aspetta la grazia, e quando arriva l`ora e` intera', async () => {
    const hour = new Date('2026-08-21T10:00:00.000Z');
    const nextHour = hour.getTime() + 3_600_000;
    await seedHour(hour);
    await sql.query(`UPDATE stats.rollup_state SET watermark = $1, max_buckets = 400`, [hour]);

    // Il giro dei cinque minuti si ferma un bucket prima della fine dell'ora:
    // e` esattamente lo stato in cui il giro orario lo trovava arrivando
    // troppo presto.
    await runRollup(db, '5m', nextHour - 300_000);
    const partial = await sql.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM stats.rollup_5m WHERE server_id = 0 AND bucket >= $1`,
      [hour],
    );
    expect(Number(partial.rows[0]?.n)).toBe(11);

    // Un minuto dopo lo scoccare dell'ora: la grazia non e` finita, e il giro
    // orario non deve scrivere un'ora che sa incompleta.
    await runRollup(db, '1h', nextHour + 60_000);
    const tooEarly = await sql.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM stats.rollup_1h WHERE bucket = $1`,
      [hour],
    );
    expect(Number(tooEarly.rows[0]?.n), 'ora scritta prima della grazia').toBe(0);

    // Nel frattempo il giro dei cinque minuti chiude il dodicesimo bucket.
    await runRollup(db, '5m', nextHour + 60_000);

    // Sei minuti dopo: la grazia e` passata, e l'ora nasce INTERA.
    await runRollup(db, '1h', nextHour + 360_000);
    const hourRow = await sql.query<{ player_seconds: string }>(
      `SELECT player_seconds::text FROM stats.rollup_1h WHERE bucket = $1 AND server_id = 0`,
      [hour],
    );
    // 120 tick x 150 giocatori x 30 secondi.
    expect(Number(hourRow.rows[0]?.player_seconds)).toBe(120 * 150 * 30);
  });

  it('e coincide con il conto rifatto dal grezzo', async () => {
    // La forma esatta dell'invariante `rollup_vs_raw`, che in produzione
    // trovava undici bucket su dodici.
    const hour = new Date('2026-08-21T11:00:00.000Z');
    const nextHour = hour.getTime() + 3_600_000;
    await seedHour(hour);
    await sql.query(`UPDATE stats.rollup_state SET watermark = $1, max_buckets = 400`, [hour]);

    await runRollup(db, '5m', nextHour + 60_000);
    await runRollup(db, '1h', nextHour + 360_000);

    const compared = await sql.query<{ memorizzato: string; ricalcolato: string }>(
      `SELECT r.player_seconds::text AS memorizzato,
              (SELECT sum(c.players::bigint * c.delta_s)::text
                 FROM stats.poll_cycle c
                WHERE date_bin('1 hour', c.tick_at, 'epoch'::timestamptz) = r.bucket
                  AND c.status = 'ok') AS ricalcolato
         FROM stats.rollup_1h r WHERE r.bucket = $1 AND r.server_id = 0`,
      [hour],
    );
    expect(compared.rows[0]?.memorizzato).toBe(compared.rows[0]?.ricalcolato);
  });
});

describe('chi attraversa la mezzanotte resta nella sua modalita`', () => {
  it('il giorno nuovo riceve la riga di presenza senza che la sessione si muova', async () => {
    // Nessuna apertura e nessun cambio di server: prima questi due erano gli
    // unici momenti in cui `player_day_server` si scriveva, e chi non faceva
    // ne` l'una ne` l'altro spariva dagli unici per modalita`.
    const { SessionTracker } = await import('#src/stats/sessions.ts');
    const sessions = new SessionTracker();

    const beforeMidnight = new Date('2026-08-20T21:30:00.000Z'); // 23:30 a Roma
    const afterMidnight = new Date('2026-08-20T22:10:00.000Z'); // 00:10 a Roma, giorno dopo

    await sql.query(
      `INSERT INTO stats.session_open
         (player_id, started_at, last_seen_at, accounted_through, server_id_first, server_id_last, legs, seen_ticks)
       VALUES (7001, $1, $1, $1, $2, $2, 1, 10)`,
      [beforeMidnight, ids['duels_1']],
    );
    await sql.query(
      `INSERT INTO stats.player_day_server (day, server_id, player_id)
       VALUES (stats.civil_day($1), $2, 7001)`,
      [beforeMidnight, ids['duels_1']],
    );

    // Un tick dopo la mezzanotte, senza nuove sessioni e senza spostamenti.
    await sessions.observe(db, afterMidnight, new Map(), () => undefined);

    const rows = await sql.query<{ day: string }>(
      `SELECT day::text FROM stats.player_day_server WHERE player_id = 7001 ORDER BY day`,
    );
    expect(rows.rows.map((r) => r.day)).toEqual(['2026-08-20', '2026-08-21']);
  });
});
