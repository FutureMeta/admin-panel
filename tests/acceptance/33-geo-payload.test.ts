// Passo 7 — la mappa nel payload, e il suo cancello. §8.5, §8.6, I5.
//
// I5 E' IL CANCELLO: la somma delle barre della mappa DEVE fare esattamente
// `kpi.uniques`, per lo stesso periodo e la stessa modalita'. Se le due cose
// contassero popolazioni diverse si finirebbe con «37.800 italiani» accanto a
// «5.000 giocatori» sullo stesso schermo, con scritto «giocatori» in entrambe
// le legende — ed e' il tipo di errore che nessuno segnala, perche' i due
// numeri sono in riquadri diversi.
//
// Qui non si verifica che la somma torni «di solito»: si verifica che le due
// cose escano dalla STESSA CTE, cioe' che tornare sia l'unica cosa che possano
// fare. Il modo di provarlo e' costruire dati in cui un conteggio ingenuo
// sbaglierebbe: giocatori visti in giorni diversi, da paesi diversi, su
// modalita' diverse.

import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createKysely, createPool, type Database } from '#src/db/pool.ts';
import { assertPayload } from '#src/stats/contract.ts';
import { buildAll } from '#src/stats/read.ts';
import { connect, createTestDatabase, type TestDatabase } from '#tests/support/postgres.ts';

let testDb: TestDatabase;
let pool: pg.Pool;
let db: Database;
let sql: pg.Client;

const ARENA = 'duels_1';
const EVENTO = 'evento_1';

beforeAll(async () => {
  testDb = await createTestDatabase('geopayload');
  pool = createPool({
    connectionString: testDb.statsUrl,
    max: 4,
    applicationName: 'metamc-test-geo-read',
    statementTimeout: '10s',
    searchPath: 'stats, public',
  });
  db = createKysely(pool);
  sql = await connect(testDb.migrateUrl, 'metamc-test-geo-sql');
}, 180_000);

afterAll(async () => {
  await sql?.end().catch(() => undefined);
  await db?.destroy().catch(() => undefined);
  await testDb?.drop();
});

beforeEach(async () => {
  await sql.query(`
    DELETE FROM stats.player_day_server; DELETE FROM stats.player_day;
    DELETE FROM stats.rollup_1d; DELETE FROM stats.rollup_1h;
    DELETE FROM stats.mode_alias; DELETE FROM stats.mode;
    DELETE FROM stats.server WHERE server_id > 1;`);

  await sql.query('INSERT INTO stats.server (server_key) VALUES ($1), ($2)', [ARENA, EVENTO]);
  await sql.query(
    `INSERT INTO stats.mode (mode_key, display_name) VALUES ('arena', 'Arena'), ('eventi', 'Eventi')`,
  );
  for (const [key, server] of [
    ['arena', ARENA],
    ['eventi', EVENTO],
  ] as const) {
    await sql.query(
      `INSERT INTO stats.mode_alias (match_kind, match_value, mode_id)
       SELECT 'server', $1, mode_id FROM stats.mode WHERE mode_key = $2`,
      [server, key],
    );
  }

  // Un minimo di serie, altrimenti `modes` e` vuoto e non c'e` niente da
  // tagliare per modalita`.
  await sql.query(
    `WITH h AS (
       SELECT g AS bucket FROM generate_series(date_trunc('hour', now()) - interval '8 days',
                                               date_trunc('hour', now()) - interval '1 hour',
                                               interval '1 hour') g
     )
     INSERT INTO stats.rollup_1h
       (bucket, server_id, samples, covered_s, player_seconds, players_max, players_max_at)
     -- La riga di rete vale la SOMMA delle due modalita, che e la invariante
     -- I1: mettendoci 100 come sulle altre due il payload viene rifiutato —
     -- cosa successa scrivendo questo test, ed e esattamente il suo scopo.
     SELECT h.bucket, v.server_id, 120, 3600,
            CASE WHEN v.server_id = 0 THEN 200 * 3600 ELSE 100 * 3600 END,
            CASE WHEN v.server_id = 0 THEN 200 ELSE 100 END,
            h.bucket
       FROM h CROSS JOIN stats.server v
      WHERE v.server_id IN (0, (SELECT server_id FROM stats.server WHERE server_key = $1),
                               (SELECT server_id FROM stats.server WHERE server_key = $2))`,
    [ARENA, EVENTO],
  );
});

/** Un giocatore presente in un giorno, con un paese e i server toccati. */
async function seen(
  playerId: number,
  daysAgo: number,
  country: string | null,
  servers: string[],
): Promise<void> {
  await sql.query(
    `INSERT INTO stats.player_day (day, player_id, first_seen_at, last_seen_at, sessions, country)
     VALUES (stats.civil_day(now()) - $2::int, $1, now(), now(), 1, $3)
     ON CONFLICT (day, player_id) DO UPDATE SET country = COALESCE(stats.player_day.country, EXCLUDED.country)`,
    [playerId, daysAgo, country],
  );
  for (const s of servers) {
    await sql.query(
      `INSERT INTO stats.player_day_server (day, server_id, player_id)
       SELECT stats.civil_day(now()) - $2::int, server_id, $1
         FROM stats.server WHERE server_key = $3
       ON CONFLICT DO NOTHING`,
      [playerId, daysAgo, s],
    );
  }
}

describe('I5 — la mappa e il KPI contano la stessa gente', () => {
  it('la somma delle barre fa esattamente kpi.uniques', async () => {
    await seen(1, 3, 'IT', [ARENA]);
    await seen(2, 3, 'IT', [ARENA]);
    await seen(3, 2, 'DE', [EVENTO]);
    await seen(4, 1, 'FR', [ARENA, EVENTO]);

    const { overview } = await buildAll(db, '7d');
    expect(() => assertPayload(overview)).not.toThrow();

    const somma = overview.geo?.v.reduce((a, b) => a + b, 0);
    expect(overview.kpi.uniques).toBe(4);
    expect(somma).toBe(4);
  });

  it('un giocatore visto in tre giorni conta UNA volta', async () => {
    // La metrica e` «giocatori», non «giocatori-giorno»: con poll da trenta
    // secondi un giocatore connesso un'ora produce 120 campioni, e una mappa
    // costruita sui campioni misurerebbe quanto la gente sta online, non da
    // dove viene.
    await seen(1, 1, 'IT', [ARENA]);
    await seen(1, 2, 'IT', [ARENA]);
    await seen(1, 3, 'IT', [ARENA]);

    const { overview } = await buildAll(db, '7d');
    expect(overview.kpi.uniques).toBe(1);
    expect(overview.geo?.v).toEqual([1]);
    expect(overview.geo?.cc).toEqual(['IT']);
  });

  it('un giocatore visto da due paesi diversi conta una volta, nel piu` recente', async () => {
    await seen(1, 5, 'DE', [ARENA]);
    await seen(1, 1, 'IT', [ARENA]);

    const { overview } = await buildAll(db, '7d');
    expect(overview.kpi.uniques).toBe(1);
    expect(overview.geo?.cc).toEqual(['IT']);
    expect(overview.geo?.v).toEqual([1]);
  });

  it('un paese noto batte un giorno piu` recente SENZA paese', async () => {
    // Il giorno piu` recente e` quello a geolocalizzazione spenta. Ordinando
    // solo per data, questo giocatore diventerebbe «non determinato» pur
    // avendo un paese noto quattro giorni prima.
    await seen(1, 4, 'IT', [ARENA]);
    await seen(1, 1, null, [ARENA]);

    const { overview } = await buildAll(db, '7d');
    expect(overview.geo?.cc).toEqual(['IT']);
  });

  it('I5 vale anche per il payload di UNA modalita`', async () => {
    await seen(1, 2, 'IT', [ARENA]);
    await seen(2, 2, 'IT', [ARENA]);
    await seen(3, 2, 'DE', [EVENTO]);
    // Chi ha giocato a due modalita` conta in ENTRAMBE, e una volta sola nel
    // totale di rete: per questo la rete non e` la somma delle modalita`.
    await seen(4, 1, 'FR', [ARENA, EVENTO]);

    const { overview, perMode } = await buildAll(db, '7d');
    const arena = perMode.get('arena');
    const eventi = perMode.get('eventi');

    expect(() => arena && assertPayload(arena)).not.toThrow();
    expect(arena?.kpi.uniques).toBe(3);
    expect(arena?.geo?.v.reduce((a, b) => a + b, 0)).toBe(3);
    expect(eventi?.kpi.uniques).toBe(2);
    expect(eventi?.geo?.v.reduce((a, b) => a + b, 0)).toBe(2);

    // 3 + 2 = 5, ma le persone sono 4.
    expect(overview.kpi.uniques).toBe(4);
  });
});

describe('XX e` un valore, non uno scarto', () => {
  it('chi non si risolve finisce in una barra visibile', async () => {
    await seen(1, 2, 'IT', [ARENA]);
    await seen(2, 2, 'XX', [ARENA]);

    const { overview } = await buildAll(db, '7d');
    // Scartando gli XX la mappa continuerebbe a sembrare corretta mentre
    // misura meno gente del KPI accanto — e I5 lo intercetterebbe.
    expect(overview.geo?.cc).toContain('XX');
    expect(overview.geo?.v.reduce((a, b) => a + b, 0)).toBe(overview.kpi.uniques);
  });

  it('le barre sono ordinate dalla piu` grande', async () => {
    await seen(1, 2, 'DE', [ARENA]);
    await seen(2, 2, 'IT', [ARENA]);
    await seen(3, 2, 'IT', [ARENA]);
    await seen(4, 2, 'IT', [ARENA]);

    const { overview } = await buildAll(db, '7d');
    expect(overview.geo?.cc[0]).toBe('IT');
    expect(overview.geo?.v[0]).toBe(3);
  });
});

describe('a geolocalizzazione spenta il widget sparisce', () => {
  it('nessun paese in tutto il periodo significa geo: null', async () => {
    await seen(1, 2, null, [ARENA]);
    await seen(2, 2, null, [ARENA]);

    const { overview, perMode } = await buildAll(db, '7d');
    // `null` e non una mappa di XX al 100%: l'interfaccia nasconde il widget
    // invece di disegnare «non viene nessuno da nessuna parte», che sarebbe
    // una risposta a una domanda che non abbiamo posto.
    expect(overview.geo).toBeNull();
    expect(perMode.get('arena')?.geo).toBeNull();
    // Il KPI degli unici c'e` lo stesso: non sapere DA DOVE non impedisce di
    // sapere QUANTI.
    expect(overview.kpi.uniques).toBe(2);
  });

  it('attiva ma che non risolve NIENTE mostra le barre XX, non le nasconde', async () => {
    await seen(1, 2, 'XX', [ARENA]);
    await seen(2, 2, 'XX', [ARENA]);

    const { overview } = await buildAll(db, '7d');
    // E` la differenza fra «funzione spenta» e «funzione accesa che non
    // funziona». La seconda e` un guasto, e nasconderla sarebbe nascondere
    // proprio il sintomo che dice che il campo ip ha cambiato significato.
    expect(overview.geo).not.toBeNull();
    expect(overview.geo?.cc).toEqual(['XX']);
    expect(overview.geo?.v).toEqual([2]);
  });
});
