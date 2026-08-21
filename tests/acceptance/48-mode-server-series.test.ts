// L'andamento di una modalita' SPEZZATO PER SERVER.
//
// LA DOMANDA A CUI RISPONDE. Con una riga sola, un gradino nella curva di
// duels puo' voler dire due cose molto diverse: la modalita' si e' svuotata,
// oppure si e' spento uno dei suoi sei server e gli altri stanno come prima.
// Sono la stessa figura e richiedono azioni opposte, e da una riga sola non si
// distinguono.
//
// COSA PUO' ROMPERSI QUI SENZA FARE RUMORE. Le righe per server hanno il loro
// denominatore possibile — il tempo in cui QUEL server era acceso — che e'
// sbagliato ma plausibilissimo: ogni riga sembrerebbe giusta da sola, e solo
// la somma non farebbe piu' il totale disegnato sopra. Il denominatore giusto
// e' quello di RETE, lo stesso della riga della modalita', ed e' l'unica
// scelta che fa chiudere le parti sul totale.

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
  testDb = await createTestDatabase('serieserver');
  pool = createPool({
    connectionString: testDb.statsUrl,
    max: 4,
    applicationName: 'metamc-test-serieserver',
    connectionTimeoutMillis: 20_000,
    statementTimeout: '30s',
    searchPath: 'stats, public',
  });
  db = createKysely(pool);
  sql = await connect(testDb.migrateUrl, 'metamc-test-serieserver-sql');
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

  // Due giorni di ore piene. Popolazioni DIVERSE per server, cosi' che una
  // riga scambiata con un'altra si veda: 100 / 50 / 30 su duels, 20 su lobby.
  await sql.query(
    `INSERT INTO stats.rollup_1h (bucket, server_id, samples, covered_s, player_seconds, players_max, players_max_at)
     SELECT g, v.server_id, 120, 3600,
            CASE v.server_key WHEN 'duels_1' THEN 100 WHEN 'duels_2' THEN 50
                              WHEN 'duels_3' THEN 30 ELSE 20 END * 3600,
            60, g
       FROM generate_series(date_trunc('hour', now()) - interval '2 days',
                            date_trunc('hour', now()) - interval '1 hour', interval '1 hour') g
       CROSS JOIN stats.server v WHERE v.server_id > 1`,
  );
  // La riga di RETE: 200 = 100 + 50 + 30 + 20. E' lei il denominatore.
  await sql.query(
    `INSERT INTO stats.rollup_1h (bucket, server_id, samples, covered_s, player_seconds, players_max, players_max_at)
     SELECT g, 0, 120, 3600, 200 * 3600, 240, g
       FROM generate_series(date_trunc('hour', now()) - interval '2 days',
                            date_trunc('hour', now()) - interval '1 hour', interval '1 hour') g`,
  );
});

/** L'ultimo punto non nullo di una riga: il piu' recente davvero misurato. */
function lastMeasured(line: (number | null)[]): number | null {
  for (let i = line.length - 1; i >= 0; i -= 1) {
    const v = line[i];
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

describe('l`andamento di una modalita` si scompone nei suoi server', () => {
  it('tre server danno tre righe, con i loro numeri', async () => {
    const built = await buildAll(db, '7d', undefined, ['duels']);
    const byServer = built.perMode.get('duels')?.byServer;

    expect(byServer?.keys).toEqual(['duels_1', 'duels_2', 'duels_3']);
    expect(lastMeasured(byServer?.series['duels_1'] ?? [])).toBeCloseTo(100, 1);
    expect(lastMeasured(byServer?.series['duels_2'] ?? [])).toBeCloseTo(50, 1);
    expect(lastMeasured(byServer?.series['duels_3'] ?? [])).toBeCloseTo(30, 1);
  });

  it('le righe SOMMANO il totale disegnato sopra, in ogni punto', async () => {
    // L'invariante che il denominatore sbagliato romperebbe, ed e` l'unico
    // modo di accorgersene: preso per server, ogni riga sembrerebbe giusta da
    // sola e solo la somma non tornerebbe.
    const built = await buildAll(db, '7d', undefined, ['duels']);
    const mode = built.perMode.get('duels');
    const byServer = mode?.byServer;
    expect(byServer).not.toBeNull();

    let punti = 0;
    (mode?.online.total ?? []).forEach((total, i) => {
      if (total === null) return;
      punti += 1;
      const somma = (byServer?.keys ?? []).reduce((a, k) => a + (byServer?.series[k]?.[i] ?? 0), 0);
      expect(somma).toBeCloseTo(total, 1);
    });
    expect(punti).toBeGreaterThan(0);
  });

  it('ogni riga e` lunga quanto l`asse, buchi compresi', async () => {
    // Il difetto peggiore di un contratto colonnare: un array corto disegna,
    // non lancia, e i valori scivolano sotto l'istante sbagliato.
    const built = await buildAll(db, '7d', undefined, ['duels']);
    const mode = built.perMode.get('duels');
    const n = mode?.online.t.length ?? 0;

    expect(n).toBeGreaterThan(0);
    for (const k of mode?.byServer?.keys ?? []) {
      expect(mode?.byServer?.series[k]).toHaveLength(n);
    }
  });

  it('un server solo non produce nessuna scomposizione', async () => {
    // La sua riga sarebbe identica al totale, disegnata sopra di esso: due
    // tratti coincidenti che si leggono come uno spessore, piu` una legenda
    // che promette una divisione che non c'e`.
    const built = await buildAll(db, '7d', undefined, ['lobby']);
    expect(built.perMode.get('lobby')?.byServer).toBeNull();
  });

  it('i server di una modalita` non entrano in quella accanto', async () => {
    const built = await buildAll(db, '7d', undefined, ['duels', 'lobby']);
    expect(built.perMode.get('duels')?.byServer?.keys ?? []).not.toContain('lobby_1');
  });

  it('vale su ogni sorgente: 24h dai 5m, 1y dai giorni', async () => {
    // Le tre sorgenti hanno tre query diverse, e l'asse del ramo orario si
    // costruisce in un modo tutto suo. Una che sbagliasse la chiave del
    // bucket darebbe righe piene di soli null, cioe` un grafico vuoto solo su
    // certi periodi — la forma piu` difficile da attribuire a una causa.
    await sql.query(
      `INSERT INTO stats.rollup_5m (bucket, server_id, samples, covered_s, player_seconds, players_max, players_max_at)
       SELECT g, v.server_id, 10, 300,
              CASE v.server_key WHEN 'duels_1' THEN 100 WHEN 'duels_2' THEN 50
                                WHEN 'duels_3' THEN 30 ELSE 20 END * 300,
              40, g
         FROM generate_series(date_trunc('hour', now()) - interval '3 hours',
                              date_trunc('hour', now()) - interval '5 minutes', interval '5 minutes') g
         CROSS JOIN stats.server v WHERE v.server_id > 1`,
    );
    await sql.query(
      `INSERT INTO stats.rollup_5m (bucket, server_id, samples, covered_s, player_seconds, players_max, players_max_at)
       SELECT g, 0, 10, 300, 200 * 300, 200, g
         FROM generate_series(date_trunc('hour', now()) - interval '3 hours',
                              date_trunc('hour', now()) - interval '5 minutes', interval '5 minutes') g`,
    );
    await sql.query(
      `INSERT INTO stats.rollup_1d (day, server_id, samples, covered_s, player_seconds, players_max, players_max_at, uniques, expected_s, final)
       SELECT g::date, v.server_id, 288, 86400,
              CASE v.server_key WHEN 'duels_1' THEN 100 WHEN 'duels_2' THEN 50
                                WHEN 'duels_3' THEN 30 ELSE 20 END * 86400,
              60, g, 10, 86400, true
         FROM generate_series(stats.civil_day(now()) - 30, stats.civil_day(now()) - 1, interval '1 day') g
         CROSS JOIN stats.server v WHERE v.server_id > 1`,
    );
    await sql.query(
      `INSERT INTO stats.rollup_1d (day, server_id, samples, covered_s, player_seconds, players_max, players_max_at, uniques, expected_s, final)
       SELECT g::date, 0, 288, 86400, 200 * 86400, 240, g, 40, 86400, true
         FROM generate_series(stats.civil_day(now()) - 30, stats.civil_day(now()) - 1, interval '1 day') g`,
    );

    for (const range of ['24h', '1y'] as const) {
      const built = await buildAll(db, range, undefined, ['duels']);
      const byServer = built.perMode.get('duels')?.byServer;
      expect(byServer?.keys, range).toEqual(['duels_1', 'duels_2', 'duels_3']);
      expect(lastMeasured(byServer?.series['duels_1'] ?? []), range).toBeCloseTo(100, 1);
    }
  });

  it('la panoramica non ne produce nessuna', async () => {
    // E` un disegno del solo dettaglio: sull'anno sarebbero venti server per
    // ogni giorno, raggruppati per niente. Che la QUERY sia saltata non lo
    // prova questo test — e` costo, non correttezza — lo tiene la regola
    // `stats/per-mode-behind-the-gate`, che ora nomina anche
    // `serverSeriesRows`.
    const built = await buildAll(db, '7d', undefined, []);
    expect(built.perMode.size).toBe(0);
  });
});
