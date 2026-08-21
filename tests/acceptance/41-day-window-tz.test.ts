// La finestra sulle colonne `date` non deve dipendere dal fuso del PROCESSO.
//
// QUESTO FILE FORZA TZ=UTC PRIMA DI TUTTO IL RESTO, e non e' un dettaglio: e'
// l'unica ragione per cui esiste. Il difetto che difende era invisibile su una
// macchina italiana e presente in produzione, dove il container sta a UTC.
//
// IL DIFETTO. `stats.rollup_1d.day` e' una DATE. Scrivendo `day >= $1`,
// PostgreSQL inferisce il parametro come `date`, e il driver serializza la
// `Date` di JavaScript nel fuso del processo. La mezzanotte romana del 21
// agosto e' «2026-08-20T22:00Z»: letta come data diventa il 20. La finestra
// scivola indietro di un giorno e taglia via l'ultimo — che su un pannello
// acceso da poco e' l'unico giorno che esista.
//
// Il sintomo in produzione era il range 1y con il grafico vuoto e il picco a
// «—», mentre 24h, 7g, 30g e 90g funzionavano: quelli confrontano `bucket`,
// che e' timestamptz, e non passano di qui.

process.env['TZ'] = 'UTC';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKysely, createPool, type Database } from '#src/db/pool.ts';
import { buildOverview } from '#src/stats/read.ts';
import { connect, createTestDatabase, type TestDatabase } from '#tests/support/postgres.ts';

let testDb: TestDatabase;
let pool: pg.Pool;
let db: Database;
let sql: pg.Client;

const ARENA = 'duels_1';

/** Pomeriggio del 21 agosto, ora legale: la mezzanotte romana e' alle 22Z. */
const ADESSO = new Date('2026-08-21T12:00:00Z');

beforeAll(async () => {
  testDb = await createTestDatabase('fuso');
  pool = createPool({
    connectionString: testDb.statsUrl,
    max: 4,
    applicationName: 'metamc-test-fuso',
    connectionTimeoutMillis: 20_000,
    statementTimeout: '30s',
    searchPath: 'stats, public',
  });
  db = createKysely(pool);
  sql = await connect(testDb.migrateUrl, 'metamc-test-fuso-sql');

  await sql.query('INSERT INTO stats.server (server_key) VALUES ($1)', [ARENA]);
  await sql.query("INSERT INTO stats.mode (mode_key, display_name) VALUES ('duels', 'Duels')");
  await sql.query(
    `INSERT INTO stats.mode_alias (match_kind, match_value, mode_id)
     SELECT 'server', $1, mode_id FROM stats.mode WHERE mode_key = 'duels'`,
    [ARENA],
  );

  // SOLO IL 20 AGOSTO, cioe` l'ultimo giorno della finestra del 1y — che
  // esclude oggi perche` e` parziale. E` la forma della produzione: pannello
  // acceso la sera del 20, un solo giorno chiuso.
  await sql.query(
    `INSERT INTO stats.rollup_1h (bucket, server_id, samples, covered_s, player_seconds, players_max, players_max_at)
     SELECT g, v.server_id, 120, 3546, 700 * 3546, 824, g + interval '17 minutes'
       FROM generate_series(timestamptz '2026-08-20 17:00Z', timestamptz '2026-08-20 21:00Z', interval '1 hour') g
       CROSS JOIN stats.server v
      WHERE v.server_id = 0 OR v.server_key = $1`,
    [ARENA],
  );
  await sql.query(
    `INSERT INTO stats.rollup_1d (day, server_id, samples, covered_s, expected_s, player_seconds, players_max, players_max_at)
     SELECT stats.civil_day(bucket), server_id, sum(samples)::int, sum(covered_s)::int,
            stats.day_seconds(stats.civil_day(bucket)), sum(player_seconds),
            max(players_max), max(players_max_at)
       FROM stats.rollup_1h GROUP BY 1, 2 ON CONFLICT DO NOTHING`,
  );
}, 300_000);

afterAll(async () => {
  await sql?.end().catch(() => undefined);
  await db?.destroy().catch(() => undefined);
  await testDb?.drop();
});

describe('il fuso del processo non sposta la finestra dei giorni', () => {
  it('il processo sta davvero a UTC', () => {
    // Se questa cade, il resto del file non prova piu` niente: a Roma il
    // difetto non si manifesta.
    expect(new Date('2026-08-21T00:00:00Z').getHours()).toBe(0);
  });

  it("l'ultimo giorno della finestra c'e`, e porta il suo picco", async () => {
    const { payload } = await buildOverview(db, '1y', ADESSO);

    // Con il parametro nudo, la finestra diventava [2025-08-20, 2026-08-20):
    // il 20 restava fuori, la query non tornava NIENTE, e il pannello
    // mostrava 365 punti nulli con il picco a «—».
    expect(payload.online.total.filter((v) => v !== null)).toHaveLength(1);
    expect(payload.kpi.peak).toBe(824);
    expect(payload.modes).toEqual(['duels']);
  });

  it('e il punto sta sull`ultima casella dell`asse, non altrove', async () => {
    const { payload } = await buildOverview(db, '1y', ADESSO);
    const i = payload.online.total.findIndex((v) => v !== null);
    // L'ultimo punto dell'asse e` la mezzanotte del 20: oggi si esclude
    // perche` e` un giorno parziale.
    expect(i).toBe(payload.online.t.length - 1);
  });
});
