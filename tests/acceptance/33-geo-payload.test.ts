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
    // QUATTRO, non otto come in produzione. Su questa macchina Postgres
    // accetta le connessioni UNA ALLA VOLTA, ~750 ms ciascuna (misurato):
    // otto pool aperti insieme da piu` suite parallele sforano qualunque
    // timeout di acquisizione. Le nove query del payload si accodano su
    // quattro connessioni e le riusano, che qui costa meno che aprirne altre.
    max: 4,
    applicationName: 'metamc-test-geo-read',
    connectionTimeoutMillis: 20_000,
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

describe('la mappa segue il selettore, oggi compreso', () => {
  it('copre la finestra del range e arriva fino a ORA', async () => {
    await seen(1, 0, 'IT', [ARENA]);
    await seen(2, 0, 'DE', [ARENA]);
    await seen(3, 1, 'FR', [ARENA]);
    // Fuori dai sette giorni: non deve entrare.
    await seen(4, 30, 'ES', [ARENA]);

    const { overview } = await buildAll(db, '7d');
    expect(() => assertPayload(overview)).not.toThrow();
    // IT, DE e FR sì; ES no. E il giorno IN CORSO c'e`: legare la mappa alla
    // finestra dei grafici, che esclude apposta il giorno parziale, la
    // renderebbe vecchia di un giorno per sempre.
    expect(overview.geo?.cc.slice().sort()).toEqual(['DE', 'FR', 'IT']);
    expect(overview.geo?.v.reduce((a, b) => a + b, 0)).toBe(3);
  });

  it('CAMBIA al cambiare del range', async () => {
    await seen(1, 0, 'IT', [ARENA]);
    await seen(2, 3, 'DE', [ARENA]);
    await seen(3, 40, 'FR', [ARENA]);

    // Il selettore in alto governa tutta la pagina: un widget che lo ignora e`
    // peggio di un widget assente, perche` chi guarda non ha modo di sapere
    // che quel riquadro sta rispondendo a un'altra domanda.
    const day = await buildAll(db, '24h');
    expect(day.overview.geo?.cc).toEqual(['IT']);

    const week = await buildAll(db, '7d');
    expect(week.overview.geo?.cc.slice().sort()).toEqual(['DE', 'IT']);

    const quarter = await buildAll(db, '90d');
    expect(quarter.overview.geo?.cc.slice().sort()).toEqual(['DE', 'FR', 'IT']);
  });

  it('un giocatore visto in piu` giorni conta UNA volta', async () => {
    // E` l'errore che I5 nasce per impedire: una mappa contata in
    // giocatori-GIORNO accanto a un KPI contato in giocatori. Con poll da
    // trenta secondi un giocatore connesso un'ora produce 120 campioni, e una
    // mappa costruita su quelli misurerebbe QUANTO la gente sta online, non DA
    // DOVE viene.
    await seen(1, 0, 'IT', [ARENA]);
    await seen(1, 1, 'IT', [ARENA]);
    await seen(1, 2, 'IT', [ARENA]);

    const { overview } = await buildAll(db, '7d');
    expect(overview.geo?.v).toEqual([1]);
  });
});

describe('la mappa per modalita`', () => {
  it('e` un SOTTOINSIEME di quella di rete', async () => {
    await seen(1, 0, 'IT', [ARENA]);
    await seen(2, 0, 'IT', [ARENA]);
    await seen(3, 0, 'DE', [EVENTO]);
    // Chi gioca a due modalita` conta in ENTRAMBE, e una volta sola nella
    // rete: per questo la rete non e` la somma delle modalita`.
    await seen(4, 0, 'FR', [ARENA, EVENTO]);

    const { overview, perMode } = await buildAll(db, '7d');
    const arena = perMode.get('arena');
    const eventi = perMode.get('eventi');

    expect(overview.geo?.v.reduce((a, b) => a + b, 0)).toBe(4);
    expect(arena?.geo?.v.reduce((a, b) => a + b, 0)).toBe(3);
    expect(eventi?.geo?.v.reduce((a, b) => a + b, 0)).toBe(2);
    // 3 + 2 = 5, ma le persone sono 4.
  });

  it('un giocatore su DUE server della stessa modalita` conta una volta', async () => {
    // Se il join duplicasse la riga, quella modalita` avrebbe piu` persone
    // della rete intera — e un numero piu` grande del totale non ha sintomi
    // finche` qualcuno non li mette accanto. `buildAll` lo verifica e
    // solleva.
    await sql.query('INSERT INTO stats.server (server_key) VALUES ($1)', ['duels_2']);
    await sql.query(
      `INSERT INTO stats.mode_alias (match_kind, match_value, mode_id)
       SELECT 'server', $1, mode_id FROM stats.mode WHERE mode_key = 'arena'`,
      ['duels_2'],
    );
    await seen(1, 0, 'IT', [ARENA, 'duels_2']);

    const { overview, perMode } = await buildAll(db, '7d');
    expect(perMode.get('arena')?.geo?.v).toEqual([1]);
    expect(overview.geo?.v).toEqual([1]);
  });
});

describe('XX e` un valore, non uno scarto', () => {
  it('chi non si risolve finisce in una barra visibile', async () => {
    await seen(1, 0, 'IT', [ARENA]);
    await seen(2, 0, 'XX', [ARENA]);

    const { overview } = await buildAll(db, '7d');
    // Scartando gli XX la mappa continuerebbe a sembrare corretta mentre
    // misura meno gente di quanta ce ne sia.
    expect(overview.geo?.cc).toContain('XX');
    expect(overview.geo?.v.reduce((a, b) => a + b, 0)).toBe(2);
  });

  it('le barre sono ordinate dalla piu` grande', async () => {
    await seen(1, 0, 'DE', [ARENA]);
    await seen(2, 0, 'IT', [ARENA]);
    await seen(3, 0, 'IT', [ARENA]);
    await seen(4, 0, 'IT', [ARENA]);

    const { overview } = await buildAll(db, '7d');
    expect(overview.geo?.cc[0]).toBe('IT');
    expect(overview.geo?.v[0]).toBe(3);
  });
});

describe('spenta, non rilevata e non risolta sono TRE cose', () => {
  it('nessun paese oggi significa geo: null', async () => {
    await seen(1, 0, null, [ARENA]);
    await seen(2, 0, null, [ARENA]);

    const { overview, perMode } = await buildAll(db, '7d');
    // `null` e non una mappa tutta «non rilevato»: l`interfaccia nasconde il
    // widget invece di disegnare una risposta a una domanda non posta.
    expect(overview.geo).toBeNull();
    expect(perMode.get('arena')?.geo).toBeNull();
  });

  it('chi e` stato visto prima dell`accensione e` «non rilevato», non «non risolto»', async () => {
    await seen(1, 0, 'IT', [ARENA]);
    await seen(2, 0, null, [ARENA]);

    const { overview } = await buildAll(db, '7d');
    // `--` e non `XX`: il giorno in cui si accende la geolocalizzazione, chi
    // era gia` passato non e` «non determinato» — non lo si e` proprio
    // guardato. Confonderli accenderebbe l`allarme che XX esiste per dare.
    expect(overview.geo?.cc).toContain('--');
    expect(overview.geo?.cc).not.toContain('XX');
  });

  it('attiva ma che non risolve NIENTE mostra le barre XX', async () => {
    await seen(1, 0, 'XX', [ARENA]);
    await seen(2, 0, 'XX', [ARENA]);

    const { overview } = await buildAll(db, '7d');
    // E` la differenza fra «funzione spenta» e «funzione accesa che non
    // funziona». La seconda e` un guasto, e nasconderla sarebbe nascondere
    // il sintomo che dice che il campo dell`indirizzo ha cambiato
    // significato.
    expect(overview.geo).not.toBeNull();
    expect(overview.geo?.cc).toEqual(['XX']);
    expect(overview.geo?.v).toEqual([2]);
  });
});

describe('spenta e «accesa ma senza dati» sono diverse nel payload', () => {
  it('geoEnabled segue il verdetto della sonda, non i dati', async () => {
    await sql.query('UPDATE stats.ingest_state SET geo_enabled = TRUE WHERE id = 1');
    await seen(1, 0, null, [ARENA]);

    const { overview } = await buildAll(db, '7d');
    expect(overview.geo).toBeNull();
    // ...ma la funzione E` accesa, e il segnaposto non deve mandare a
    // cercare una configurazione che c`e` gia`.
    expect(overview.geoEnabled).toBe(true);
  });

  it('con la sonda non approvata resta falso', async () => {
    await sql.query('UPDATE stats.ingest_state SET geo_enabled = NULL WHERE id = 1');
    await seen(1, 0, null, [ARENA]);

    const { overview } = await buildAll(db, '7d');
    expect(overview.geoEnabled).toBe(false);
  });
});
