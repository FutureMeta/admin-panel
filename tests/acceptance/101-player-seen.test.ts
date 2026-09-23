// `player_seen` e `player_server_seen` (migration 025) al posto dei giorni.
//
// LA CONDIZIONE DI SICUREZZA E' UNA SOLA: per ogni range, giocatori distinti
// e mappa — di rete e per modalita' — devono uscire IDENTICI a quelli contati
// sui giorni. Il modo di provarlo e' costruire lo stesso payload due volte:
// una con le tabelle riassuntive, una dopo aver messo una riga nel futuro,
// che le rende inservibili (`seenIsCurrent`) e riporta la costruzione ai
// giorni. La riga futura non cambia niente di cio' che si conta: ogni finestra
// si ferma a oggi.
//
// I dati sono i casi in cui una tabella riassuntiva sbaglia: il paese noto
// solo in un giorno vecchio, il paese riempito dopo (NULL -> noto), due server
// della stessa modalita', un giorno vecchio scritto DOPO uno recente, righe
// cancellate.

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKysely, createPool, type Database } from '#src/db/pool.ts';
import { RANGES } from '#src/stats/contract.ts';
import { buildAll } from '#src/stats/read.ts';
import { connect, createTestDatabase, type TestDatabase } from '#tests/support/postgres.ts';

let testDb: TestDatabase;
let pool: pg.Pool;
let db: Database;
let sql: pg.Client;
const NOW = new Date();

/** Un giocatore presente in un giorno, con un paese e i server toccati. */
async function seen(playerId: number, daysAgo: number, country: string | null, servers: string[]) {
  await sql.query(
    `INSERT INTO stats.player_day (day, player_id, first_seen_at, last_seen_at, sessions, country)
     VALUES (stats.civil_day(now()) - $2::int, $1, now(), now(), 1, $3)
     ON CONFLICT (day, player_id) DO UPDATE SET country = COALESCE(stats.player_day.country, EXCLUDED.country)`,
    [playerId, daysAgo, country],
  );
  for (const s of servers) {
    await sql.query(
      `INSERT INTO stats.player_day_server (day, server_id, player_id)
       SELECT stats.civil_day(now()) - $2::int, server_id, $1 FROM stats.server WHERE server_key = $3
       ON CONFLICT DO NOTHING`,
      [playerId, daysAgo, s],
    );
  }
}

beforeAll(async () => {
  testDb = await createTestDatabase('playerseen');
  pool = createPool({
    connectionString: testDb.statsUrl,
    max: 4,
    applicationName: 'metamc-test-player-seen',
    connectionTimeoutMillis: 20_000,
    statementTimeout: '10s',
    searchPath: 'stats, public',
  });
  db = createKysely(pool);
  sql = await connect(testDb.migrateUrl, 'metamc-test-player-seen-sql');

  // Le partizioni dell'anno: `ensure_partitions` parte dal mese scorso, e qui
  // serve un giocatore visto 200 giorni fa. In UTC, come le crea lei.
  await sql.query(`SET TimeZone = 'UTC'`);
  await sql.query(`DO $$ DECLARE t text; m date; BEGIN
    FOREACH t IN ARRAY ARRAY['player_day', 'player_day_server'] LOOP
      FOR m IN SELECT generate_series(date_trunc('month', now() - interval '210 days'),
                                      date_trunc('month', now()), interval '1 month')::date LOOP
        CONTINUE WHEN to_regclass(format('stats.%I', t || '_' || to_char(m, 'YYYY_MM'))) IS NOT NULL;
        EXECUTE format('CREATE TABLE stats.%I PARTITION OF stats.%I FOR VALUES FROM (%L) TO (%L)',
                       t || '_' || to_char(m, 'YYYY_MM'), t, m, (m + interval '1 month')::date);
      END LOOP;
    END LOOP; END $$`);

  await sql.query(`INSERT INTO stats.server (server_key) VALUES ('duels_1'), ('duels_2'), ('lobby_1')`);
  await sql.query(
    `INSERT INTO stats.mode (mode_key, display_name) VALUES ('duels', 'Duels'), ('lobby', 'Lobby')`,
  );
  await sql.query(`INSERT INTO stats.mode_alias (match_kind, match_value, mode_id)
     SELECT 'prefix', mode_key, mode_id FROM stats.mode`);
  // Una serie oraria su 300 giorni, e il giornaliero che ne discende: senza,
  // le modalita' non compaiono e non c'e' nessun payload per modalita' da
  // confrontare. La riga di rete e' la somma dei server.
  await sql.query(`
    INSERT INTO stats.rollup_1h (bucket, server_id, samples, covered_s, player_seconds, players_max, players_max_at)
    SELECT g, v.server_id, 120, 3600, CASE WHEN v.server_id = 0 THEN 30 ELSE 10 END * 3600,
           CASE WHEN v.server_id = 0 THEN 30 ELSE 10 END, g
      FROM generate_series(date_trunc('hour', now()) - interval '300 days',
                           date_trunc('hour', now()) - interval '1 hour', interval '1 hour') g
     CROSS JOIN stats.server v WHERE v.server_id = 0 OR v.server_id >= 100`);
  await sql.query(`
    INSERT INTO stats.rollup_1d (day, server_id, samples, covered_s, expected_s, player_seconds, players_max, players_max_at)
    SELECT stats.civil_day(bucket), server_id, sum(samples)::int, sum(covered_s)::int,
           stats.day_seconds(stats.civil_day(bucket)), sum(player_seconds), max(players_max), max(players_max_at)
      FROM stats.rollup_1h GROUP BY 1, 2`);

  await seen(1, 40, 'FR', ['duels_1']);
  await seen(1, 3, null, ['duels_1']); // noto solo 40 giorni fa
  await seen(2, 2, null, ['lobby_1']);
  await seen(2, 2, 'IT', []); // lo stesso giorno, il paese arriva dopo
  await seen(3, 5, 'DE', ['duels_1', 'duels_2']); // due server, una modalita'
  await seen(4, 0, 'IT', ['duels_2']);
  await seen(4, 10, 'ES', ['lobby_1']); // un giorno vecchio scritto dopo
  await seen(5, 200, 'BR', ['lobby_1']); // solo nell'anno
  await seen(6, 1, 'IT', ['lobby_1']);
  await seen(6, 0, null, ['duels_1']);
  await seen(8, 0, null, ['duels_1']); // mai un paese
  await seen(9, 4, 'PL', ['duels_2']);
  await seen(10, 50, 'NL', ['lobby_1']);
  await seen(10, 1, 'NL', ['duels_1']);
  // Cancellazioni: 9 sparisce del tutto, 10 perde il giorno recente.
  await sql.query('DELETE FROM stats.player_day_server WHERE player_id = 9');
  await sql.query('DELETE FROM stats.player_day WHERE player_id = 9');
  await sql.query(
    `DELETE FROM stats.player_day_server WHERE player_id = 10 AND day = stats.civil_day(now()) - 1`,
  );
  await sql.query(`DELETE FROM stats.player_day WHERE player_id = 10 AND day = stats.civil_day(now()) - 1`);
  await sql.query('ANALYZE');
}, 180_000);

afterAll(async () => {
  await sql?.end().catch(() => undefined);
  await db?.destroy().catch(() => undefined);
  await testDb?.drop();
});

/** La parte di un payload che viene dalle persone: distinti e mappa. */
function people(built: Awaited<ReturnType<typeof buildAll>>) {
  const modes = [...built.perMode.entries()].map(([m, p]) => [m, p.kpi.uniques, p.geo?.cc, p.geo?.v]);
  return { uniques: built.overview.kpi.uniques, cc: built.overview.geo?.cc, v: built.overview.geo?.v, modes };
}

/** Una riga nel futuro: `player_seen` smette di valere e si torna ai giorni. */
async function withFutureRow<T>(work: () => Promise<T>): Promise<T> {
  await seen(999, -3, 'IT', ['duels_1']);
  try {
    return await work();
  } finally {
    await sql.query('DELETE FROM stats.player_day_server WHERE player_id = 999');
    await sql.query('DELETE FROM stats.player_day WHERE player_id = 999');
  }
}

describe('le tabelle riassuntive dicono quello che dicono i giorni', () => {
  it.each(RANGES)('%s: distinti e mappa, di rete e per modalita`', async (range) => {
    const fast = people(await buildAll(db, range, NOW));
    const exact = people(await withFutureRow(() => buildAll(db, range, NOW)));
    expect(fast).toEqual(exact);
  });

  it('e i numeri sono quelli giusti, non solo uguali fra loro', async () => {
    const built = await buildAll(db, '7d', NOW);
    const map = (g: { cc: string[]; v: number[] } | null | undefined) =>
      Object.fromEntries((g?.cc ?? []).map((c, i) => [c, g?.v[i]]));
    // 1 senza paese nella finestra, 2 riempito dopo, 3 una volta sola, 4 con
    // il paese di oggi e non quello scritto dopo, 6 con quello di ieri, 8 mai.
    expect(built.overview.kpi.uniques).toBe(6);
    expect(map(built.overview.geo)).toEqual({ IT: 3, DE: 1, '--': 2 });
    expect(map(built.perMode.get('duels')?.geo)).toEqual({ IT: 2, DE: 1, '--': 2 });
    expect(built.perMode.get('duels')?.kpi.uniques).toBe(5);
    expect(map(built.perMode.get('lobby')?.geo)).toEqual({ IT: 2 });

    const quarter = await buildAll(db, '90d', NOW);
    // Su 90 giorni 1 ritrova il paese di 40 giorni fa, e 10 c'e' con il suo.
    expect(map(quarter.overview.geo)).toEqual({ IT: 3, DE: 1, FR: 1, NL: 1, '--': 1 });
  });

  it('la costruzione veloce legge davvero le tabelle riassuntive', async () => {
    // Senza questo, i confronti sopra passerebbero anche se il ramo veloce
    // non partisse mai: sarebbero i giorni contro i giorni.
    await sql.query(`UPDATE stats.player_seen SET last_day = stats.civil_day(now()) - 364,
                            country = NULL, country_day = NULL WHERE player_id = 3`);
    try {
      const built = await buildAll(db, '7d', NOW);
      expect(built.overview.kpi.uniques).toBe(5);
    } finally {
      await sql.query(`UPDATE stats.player_seen SET last_day = stats.civil_day(now()) - 5,
                              country = 'DE', country_day = stats.civil_day(now()) - 5 WHERE player_id = 3`);
    }
  });
});
