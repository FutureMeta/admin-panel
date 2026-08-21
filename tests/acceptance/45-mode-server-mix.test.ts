// La ripartizione per SERVER dentro una modalita'. Schermata di dettaglio.
//
// PERCHE' ESISTE UN RIQUADRO IN PIU' RISPETTO AL MOCKUP. Quasi tutte le
// modalita' girano su piu' di un server, e «duels ha 286 giocatori» non dice
// se sono tutti su uno o sparsi su sei — che e' esattamente la domanda che si
// fa aprendo il dettaglio. La panoramica divide la rete per modalita'; qui si
// scende di un gradino e si divide la modalita' per server.
//
// RESTA ANCHE CON UN SERVER SOLO. Una fetta sola non e' un riquadro sprecato:
// dice «questa modalita' sta tutta su duels_1», che e' un fatto. Un riquadro
// che compare e scompare a seconda dei dati costringe invece chi guarda a
// chiedersi ogni volta se manchi qualcosa, ed e' il tipo di incertezza che
// rende un pannello inaffidabile anche quando i numeri sono giusti.

import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createKysely, createPool, type Database } from '#src/db/pool.ts';
import { buildAll } from '#src/stats/read.ts';
import { connect, createTestDatabase, type TestDatabase } from '#tests/support/postgres.ts';

let testDb: TestDatabase;
let pool: pg.Pool;
let db: Database;
let sql: pg.Client;

/** Duels su tre server, lobby su uno solo: i due casi che contano. */
const DUELS = ['duels_1', 'duels_2', 'duels_3'];
const LOBBY = ['lobby_1'];

beforeAll(async () => {
  testDb = await createTestDatabase('mixserver');
  pool = createPool({
    connectionString: testDb.statsUrl,
    max: 4,
    applicationName: 'metamc-test-mixserver',
    connectionTimeoutMillis: 20_000,
    statementTimeout: '30s',
    searchPath: 'stats, public',
  });
  db = createKysely(pool);
  sql = await connect(testDb.migrateUrl, 'metamc-test-mixserver-sql');
}, 180_000);

afterAll(async () => {
  await sql?.end().catch(() => undefined);
  await db?.destroy().catch(() => undefined);
  await testDb?.drop();
});

beforeEach(async () => {
  await sql.query(`
    DELETE FROM stats.rollup_5m; DELETE FROM stats.rollup_1h; DELETE FROM stats.rollup_1d;
    DELETE FROM stats.mode_alias; DELETE FROM stats.mode;
    DELETE FROM stats.server WHERE server_id > 1;`);

  await sql.query('INSERT INTO stats.server (server_key) SELECT unnest($1::text[])', [[...DUELS, ...LOBBY]]);
  await sql.query(
    `INSERT INTO stats.mode (mode_key, display_name) VALUES ('duels', 'Duels'), ('lobby', 'Lobby')`,
  );
  for (const [key, servers] of [
    ['duels', DUELS],
    ['lobby', LOBBY],
  ] as const) {
    for (const server of servers) {
      await sql.query(
        `INSERT INTO stats.mode_alias (match_kind, match_value, mode_id)
         SELECT 'server', $1, mode_id FROM stats.mode WHERE mode_key = $2`,
        [server, key],
      );
    }
  }

  // Un bucket da cinque minuti, chiuso. I tre duels con popolazioni diverse,
  // la lobby con la sua. La riga di rete e' la somma: e' lei il denominatore.
  await sql.query(
    `INSERT INTO stats.rollup_5m (bucket, server_id, samples, covered_s, player_seconds, players_max, players_max_at)
     SELECT date_trunc('hour', now()) - interval '10 minutes', v.server_id, 10, 300,
            CASE v.server_key WHEN 'duels_1' THEN 100 WHEN 'duels_2' THEN 50
                              WHEN 'duels_3' THEN 30 ELSE 20 END * 300,
            40, date_trunc('hour', now()) - interval '10 minutes'
       FROM stats.server v WHERE v.server_id > 1`,
  );
  await sql.query(
    `INSERT INTO stats.rollup_5m (bucket, server_id, samples, covered_s, player_seconds, players_max, players_max_at)
     VALUES (date_trunc('hour', now()) - interval '10 minutes', 0, 10, 300, 200 * 300, 200,
             date_trunc('hour', now()) - interval '10 minutes')`,
  );
  // Un'ora di storico, o la serie della modalita' resta vuota e `perMode` non
  // contiene niente da guardare.
  await sql.query(
    `INSERT INTO stats.rollup_1h (bucket, server_id, samples, covered_s, player_seconds, players_max, players_max_at)
     SELECT g, v.server_id, 120, 3600, 50 * 3600, 60, g
       FROM generate_series(date_trunc('hour', now()) - interval '2 days',
                            date_trunc('hour', now()) - interval '1 hour', interval '1 hour') g
       CROSS JOIN stats.server v WHERE v.server_id > 1`,
  );
  await sql.query(
    `INSERT INTO stats.rollup_1h (bucket, server_id, samples, covered_s, player_seconds, players_max, players_max_at)
     SELECT g, 0, 120, 3600, 200 * 3600, 240, g
       FROM generate_series(date_trunc('hour', now()) - interval '2 days',
                            date_trunc('hour', now()) - interval '1 hour', interval '1 hour') g`,
  );
});

describe('il dettaglio di una modalita` dice su quali server sta', () => {
  it('tre server danno tre fette, con i loro numeri', async () => {
    const built = await buildAll(db, '7d', undefined, ['duels']);
    const mix = built.perMode.get('duels')?.serverMix;

    expect(mix).not.toBeNull();
    expect(mix?.byServer).toEqual({ duels_1: 100, duels_2: 50, duels_3: 30 });
  });

  it('e un server solo ne da` una, che resta un fatto', async () => {
    const built = await buildAll(db, '7d', undefined, ['lobby']);
    expect(built.perMode.get('lobby')?.serverMix?.byServer).toEqual({ lobby_1: 20 });
  });

  it('i server di una modalita` non compaiono in quella accanto', async () => {
    // Il difetto che si scriverebbe raggruppando male: la torta di duels con
    // dentro la lobby. Somma giusta, ripartizione falsa, e nessun modo di
    // accorgersene senza conoscere i server a memoria.
    const built = await buildAll(db, '7d', undefined, ['duels', 'lobby']);
    expect(Object.keys(built.perMode.get('duels')?.serverMix?.byServer ?? {})).not.toContain('lobby_1');
    expect(Object.keys(built.perMode.get('lobby')?.serverMix?.byServer ?? {})).toEqual(['lobby_1']);
  });

  it('la somma delle fette e` il totale della modalita`', async () => {
    // L'invariante del riquadro: se non chiudesse, le percentuali sarebbero
    // calcolate su un totale che non esiste.
    const built = await buildAll(db, '7d', undefined, ['duels']);
    const byServer = built.perMode.get('duels')?.serverMix?.byServer ?? {};
    const total = Object.values(byServer).reduce((a, b) => a + b, 0);
    expect(total).toBe(180);
  });

  it('la panoramica non ne produce nessuna', async () => {
    // La torta per server e` un riquadro del solo dettaglio. Che la QUERY sia
    // saltata quando nessuno ha chiesto una modalita` non lo prova questo
    // test — e` costo, non correttezza, e nessun test di correttezza lo puo`
    // vedere: lo tiene la regola `stats/per-mode-behind-the-gate` in
    // check-guards, che ora nomina anche `serverMix`.
    const built = await buildAll(db, '7d', undefined, []);
    expect(built.perMode.size).toBe(0);
  });
});
