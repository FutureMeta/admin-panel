// L'endpoint della panoramica. Fase 2, passo 4 — e il suo cancello.
//
// QUI SI VEDE SE LA CATENA HA SENSO. I passi precedenti producono numeri
// giusti in tabelle che nessuno guarda; questo li mette nella forma in cui
// finiranno su uno schermo, ed e' la forma il punto:
//
//  * il buco e' un `null`, mai uno zero. Uno zero al posto di un buco
//    trasforma un guasto in un evento di business e falsa ogni media a valle,
//    in modo permanente e plausibile;
//  * il breakdown chiude sul totale, perche' `__transit__` e `__unknown__`
//    sono serie visibili. Senza, la torta non somma mai e il primo che se ne
//    accorge normalizza le percentuali — cioe' spalma i non classificati
//    sulle modalita' vere;
//  * gli array paralleli hanno la stessa lunghezza. Un disallineamento di un
//    elemento non solleva niente: il grafico disegna, e mostra numeri
//    corretti sotto l'etichetta sbagliata. E' il difetto peggiore perche' non
//    ha sintomi.
//
// Il cancello del passo 4 e' il range 90g, il piu' pesante, sotto i 500 ms
// senza cache.

import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createKysely, createPool, type Database } from '#src/db/pool.ts';
import { assertPayload } from '#src/stats/contract.ts';
import { buildOverview } from '#src/stats/read.ts';
import { connect, createTestDatabase, type TestDatabase } from '#tests/support/postgres.ts';

let testDb: TestDatabase;
let pool: pg.Pool;
/** Il pool di SOLA LETTURA: e' quello che usera' la rotta. */
let db: Database;
let sql: pg.Client;

const ARENA = 'duels_1';
const EVENTO = 'evento_1';

beforeAll(async () => {
  testDb = await createTestDatabase('overview');
  pool = createPool({
    connectionString: testDb.statsUrl,
    // QUATTRO, non otto come in produzione. Su questa macchina Postgres
    // accetta le connessioni UNA ALLA VOLTA, ~750 ms ciascuna (misurato):
    // otto pool aperti insieme da piu` suite parallele sforano qualunque
    // timeout di acquisizione. Le nove query del payload si accodano su
    // quattro connessioni e le riusano, che qui costa meno che aprirne altre.
    max: 4,
    applicationName: 'metamc-test-stats-read',
    connectionTimeoutMillis: 20_000,
    statementTimeout: '10s',
    searchPath: 'stats, public',
  });
  db = createKysely(pool);
  sql = await connect(testDb.migrateUrl, 'metamc-test-overview-sql');
}, 180_000);

afterAll(async () => {
  await sql?.end().catch(() => undefined);
  await db?.destroy().catch(() => undefined);
  await testDb?.drop();
});

beforeEach(async () => {
  await sql.query(`
    DELETE FROM stats.rollup_1d; DELETE FROM stats.rollup_1h; DELETE FROM stats.rollup_5m;
    DELETE FROM stats.mode_alias; DELETE FROM stats.mode;
    DELETE FROM stats.server WHERE server_id > 1;`);
});

/** Due modalita' vere, cosi' le serie hanno un nome e non sono tutte `__unknown__`. */
async function dictionary(): Promise<void> {
  // Uno statement per query: con i parametri `pg` usa il protocollo esteso,
  // che non accetta piu' istruzioni insieme.
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
}

/**
 * N giorni di storico orario.
 *
 * L'arena c'e' a ogni ora con 150 giocatori medi; l'evento solo a mezzogiorno,
 * con 200. Copertura piena, tranne dove `holeHours` dice di saltare — e li'
 * non si scrive NIENTE, che e' come si rappresenta un buco.
 */
async function seedHours(days: number, holeHours: number[] = []): Promise<void> {
  await sql.query(
    `WITH h AS (
       SELECT g AS bucket, extract(hour FROM g AT TIME ZONE 'Europe/Rome')::int AS ora
         FROM generate_series(date_trunc('hour', now()) - make_interval(days => $1::int),
                              date_trunc('hour', now()) - interval '1 hour',
                              interval '1 hour') g
        WHERE extract(hour FROM g AT TIME ZONE 'Europe/Rome')::int <> ALL ($2::int[])
     )
     INSERT INTO stats.rollup_1h
       (bucket, server_id, samples, covered_s, player_seconds, players_max, players_max_at)
     SELECT h.bucket, v.server_id, 120, 3600,
            CASE v.server_id
              WHEN 0 THEN (150 + CASE WHEN h.ora = 12 THEN 200 ELSE 0 END) * 3600
              ELSE CASE WHEN v.server_key = $3 THEN 150 * 3600
                        ELSE CASE WHEN h.ora = 12 THEN 200 * 3600 ELSE 0 END END
            END,
            CASE v.server_id
              WHEN 0 THEN 150 + CASE WHEN h.ora = 12 THEN 200 ELSE 0 END
              ELSE CASE WHEN v.server_key = $3 THEN 150 ELSE CASE WHEN h.ora = 12 THEN 200 ELSE 0 END END
            END,
            h.bucket
       FROM h CROSS JOIN stats.server v
      WHERE v.server_id = 0 OR v.server_key IN ($3, $4)
        -- La convenzione sparsa: dove non c'era nessuno non si scrive la riga.
        AND NOT (v.server_key = $4 AND h.ora <> 12)`,
    [days, holeHours, ARENA, EVENTO],
  );
  // Il livello giornaliero, per il range 1y.
  await sql.query(
    `INSERT INTO stats.rollup_1d
       (day, server_id, samples, covered_s, expected_s, player_seconds, players_max, players_max_at)
     SELECT stats.civil_day(bucket), server_id, sum(samples)::int, sum(covered_s)::int,
            stats.day_seconds(stats.civil_day(bucket)), sum(player_seconds),
            max(players_max), max(players_max_at)
       FROM stats.rollup_1h GROUP BY 1, 2
     ON CONFLICT DO NOTHING`,
  );
}

describe('la forma del payload e` verificata prima di spedirlo', () => {
  beforeEach(async () => {
    await dictionary();
    await seedHours(10);
  });

  it('ogni range produce un payload valido', async () => {
    for (const range of ['24h', '7d', '30d', '90d', '1y'] as const) {
      const { payload } = await buildOverview(db, range);
      expect(() => assertPayload(payload), `range ${range}`).not.toThrow();
      expect(payload.v).toBe(2);
      expect(payload.tz).toBe('Europe/Rome');
      expect(payload.online.total).toHaveLength(payload.online.t.length);
      expect(payload.heatmap.v).toHaveLength(168);
    }
  });

  it('l`asse dei tempi non ha buchi: il buco sta nei VALORI', async () => {
    const { payload } = await buildOverview(db, '7d');
    const t = payload.online.t;
    for (let i = 1; i < t.length; i += 1) {
      expect((t[i] as number) - (t[i - 1] as number)).toBe(payload.bucketSec);
    }
  });

  it('le modalita` hanno un nome, e il totale non e` una di loro', async () => {
    const { payload } = await buildOverview(db, '7d');
    expect(payload.modes).toContain('arena');
    expect(payload.modes).toContain('eventi');
    expect(payload.modes).not.toContain('__network__');
    expect(payload.labels['arena']).toBe('Arena');
    for (const m of payload.modes) expect(payload.online.series[m]).toBeDefined();
  });
});

describe('l`evento intermittente non diventa la modalita` piu` popolosa', () => {
  beforeEach(async () => {
    await dictionary();
    await seedHours(10);
  });

  it('a un`ora su ventiquattro, l`evento vale una frazione dell`arena', async () => {
    // Con il denominatore preso dalle righe dell'evento uscirebbe 200, cioe'
    // sopra l'arena. E' lo stesso difetto del rollup, che qui si
    // ripresenterebbe in lettura se il payload dividesse per la copertura
    // sbagliata.
    const { payload } = await buildOverview(db, '30d');
    const arena = payload.online.series['arena']?.filter((v) => v !== null) ?? [];
    const eventi = payload.online.series['eventi']?.filter((v) => v !== null) ?? [];
    const media = (a: (number | null)[]) =>
      (a.reduce((s, v) => (s as number) + (v ?? 0), 0) as number) / Math.max(1, a.length);

    expect(media(arena)).toBeGreaterThan(media(eventi));
    expect(media(eventi)).toBeLessThan(60);
  });
});

describe('i buchi restano buchi', () => {
  beforeEach(async () => {
    await dictionary();
    // Tre serate perse, come un deploy fatto sempre alla stessa ora.
    await seedHours(10, [20, 21, 22]);
  });

  it('le ore mancanti sono null, non zero', async () => {
    const { payload } = await buildOverview(db, '7d');
    const nulli = payload.online.total.filter((v) => v === null).length;
    const zeri = payload.online.total.filter((v) => v === 0).length;
    expect(nulli).toBeGreaterThan(0);
    expect(zeri).toBe(0);
  });

  it('la copertura racconta il buco, e la media normalizzata non lo subisce', async () => {
    // E' il punto della §6.5: i buchi non sono mai indipendenti dall'ora del
    // giorno. Se la media fosse player_seconds/covered_s sul periodo intero,
    // perdere tre ore SERALI la sposterebbe; normalizzata sul profilo orario,
    // sposta la copertura e non la media.
    const { payload } = await buildOverview(db, '7d');
    expect(payload.kpi.coverage).toBeLessThan(0.9);
    expect(payload.kpi.coverage).toBeGreaterThan(0.8);
    expect(payload.kpi.avg).not.toBeNull();
  });
});

describe('il cancello del passo 4', () => {
  it('il range 90g, il piu` pesante, resta servibile senza cache', async () => {
    await dictionary();
    await seedHours(90);
    // Un giro a vuoto per non misurare la prima pianificazione.
    await buildOverview(db, '90d');
    const t0 = Date.now();
    const { payload, queryMs } = await buildOverview(db, '90d');
    const totalMs = Date.now() - t0;
    assertPayload(payload);

    // Il numero si STAMPA, non solo si asserisce: una soglia dice «passa o
    // no», il numero dice quanto margine e' rimasto, ed e' quello che serve
    // per accorgersi che si sta consumando prima che finisca.
    //
    // Misurato: ~260 ms di query su novanta giorni di storico orario, dentro
    // la suite in parallelo. Il cancello del passo 4 e' 500 ms senza cache.
    console.log(`[90d] query ${queryMs} ms, totale ${totalMs} ms`);
    expect(queryMs).toBeLessThan(500);
    expect(totalMs).toBeLessThan(500);
  });
});

describe('il record di sempre', () => {
  beforeEach(async () => {
    await dictionary();
    await seedHours(10);
  });

  it('e` il massimo di TUTTO lo storico, non della finestra', async () => {
    // Un picco fuori dalla finestra del range: il record deve vederlo lo
    // stesso, perche' «record» non significa «record del periodo scelto».
    await sql.query(
      `UPDATE stats.rollup_1d SET players_max = 4242
         WHERE server_id = 0 AND day = stats.civil_day(now()) - 9`,
    );

    const { payload } = await buildOverview(db, '24h');
    expect(payload.record?.players).toBe(4242);
  });

  it('porta la data da cui si guarda', async () => {
    // Un «record di sempre» calcolato su tre giorni di raccolta e` un record
    // di tre giorni: senza questa data, chi legge non ha modo di saperlo.
    const { payload } = await buildOverview(db, '7d');
    expect(payload.record?.since).toBeGreaterThan(0);
  });

  it('e` nullo quando non c`e` nemmeno un giorno con dati', async () => {
    await sql.query('DELETE FROM stats.rollup_1d');
    const { payload } = await buildOverview(db, '7d');
    // Nullo, non zero: zero direbbe «il record e` zero giocatori».
    expect(payload.record).toBeNull();
  });
});
