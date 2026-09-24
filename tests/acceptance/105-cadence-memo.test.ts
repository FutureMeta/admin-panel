// Le cadenze dei giorni chiusi stanno in memoria: il risultato deve restare
// quello della query diretta, su ogni forma di finestra.
//
// Le forme che contano sono gli ESTREMI: una finestra che comincia a meta'
// giornata (il 24h, e il tetto dei novanta giorni) non deve prendere le
// cadenze della mattina, che sta fuori; una che finisce nel passato non deve
// leggere oggi; e una seconda chiamata, servita dalla memoria, deve dire lo
// stesso della prima.

import type pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createKysely, createPool, type Database } from '#src/db/pool.ts';
import { romeMidnight, shiftDays } from '#src/stats/calendar.ts';
import { deltasIn } from '#src/stats/queries.ts';
import { connect, createTestDatabase, type TestDatabase } from '#tests/support/postgres.ts';

let testDb: TestDatabase;
let pool: pg.Pool;
let db: Database;
let admin: pg.Client;

const today = romeMidnight(new Date());
const day = (n: number) => shiftDays(today, n);
const at = (d: Date, hours: number) => new Date(d.getTime() + hours * 3_600_000);

beforeAll(async () => {
  testDb = await createTestDatabase('cadenze');
  admin = await connect(testDb.adminUrl, 'metamc-test-cadenze');
  // Le migration creano le partizioni attorno a oggi: i giorni qui sotto
  // cadono dove capita, e la DEFAULT li raccoglie tutti.
  await admin.query('CREATE TABLE stats.poll_cycle_test PARTITION OF stats.poll_cycle DEFAULT');

  // Un tick all'ora. -5, -4, -2: 30 s. -3: 10 s. -1: 60 s la mattina, 30 s
  // dal pomeriggio. Oggi: 15 s, fino a un'ora fa.
  const ticks: Array<[Date, number]> = [];
  for (const [n, delta] of [
    [-5, 30],
    [-4, 30],
    [-3, 10],
    [-2, 30],
  ] as const) {
    for (let h = 0; h < 24; h += 1) ticks.push([at(day(n), h), delta]);
  }
  for (let h = 0; h < 24; h += 1) ticks.push([at(day(-1), h), h < 6 ? 60 : 30]);
  for (let t = today.getTime(); t < Date.now() - 3_600_000; t += 3_600_000) ticks.push([new Date(t), 15]);
  await admin.query(
    `INSERT INTO stats.poll_cycle (tick_at, run_id, status, delta_s, players)
     SELECT t, gen_random_uuid(), 'ok', d, 100 FROM unnest($1::timestamptz[], $2::int[]) AS x(t, d)`,
    [ticks.map(([t]) => t), ticks.map(([, d]) => d)],
  );

  pool = createPool({
    connectionString: testDb.statsUrl,
    max: 2,
    applicationName: 'metamc-test-cadenze',
    connectionTimeoutMillis: 20_000,
    statementTimeout: '30s',
    searchPath: 'stats, public',
  });
  db = createKysely(pool);
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await admin?.end();
  await testDb?.drop();
});

async function direct(from: Date, to: Date): Promise<number[]> {
  const res = await admin.query(
    `SELECT DISTINCT delta_s FROM stats.v_cadence
      WHERE tick_at >= GREATEST($1::timestamptz, now() - interval '90 days') AND tick_at < $2
      ORDER BY 1`,
    [from, to],
  );
  return res.rows.map((r) => Number(r.delta_s));
}

it.each([
  ['cinque giorni fino a domani', day(-5), day(1)],
  ['da meta` di ieri: la mattina a 60 s resta fuori', at(day(-1), 12), new Date()],
  ['solo giorni chiusi, oggi escluso', day(-4), day(-1)],
  ['un giorno chiuso che finisce a meta`', day(-3), at(day(-2), 12)],
  ['dentro un giorno solo', at(day(-1), 1), at(day(-1), 3)],
])('%s', async (_label, from, to) => {
  const expected = await direct(from, to);
  // Due volte: la seconda passa dalla memoria.
  expect(await deltasIn(db, { curFrom: from, curTo: to })).toEqual(expected);
  expect(await deltasIn(db, { curFrom: from, curTo: to })).toEqual(expected);
});
