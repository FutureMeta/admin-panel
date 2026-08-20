// La catena di rollup 5m -> 1h -> 1d. Fase 2, passo 3 — e il suo cancello.
//
// LO SCENARIO CHE VALE PER TUTTI GLI ALTRI, e che qui si costruisce apposta:
// un evento aperto cinque minuti nell'ora con 200 giocatori, accanto a
// un'arena aperta l'ora intera con 150.
//
// Se il denominatore di una media viene dalle righe della modalita' — cioe'
// dal tempo in cui era APERTA — l'evento riporta media 200 e risulta piu'
// popoloso dell'arena. Il numero e' plausibile, la classifica e' ribaltata, e
// nessuno se ne accorge guardando il grafico. Con il denominatore preso dal
// registro dei cicli, l'evento esce a 16,7 sull'ora e a 0,7 sul giorno, che e'
// quanto vale davvero.
//
// Gli altri due invarianti del cancello:
//
// I3 — il massimo giornaliero e' il massimo dei massimi orari, che e' il
// massimo dei massimi da cinque minuti. Se si rompe, il «record di giocatori
// contemporanei» diventa un numero diverso a ogni livello di zoom, e
// l'utente lo scopre da solo passando da 24h a 30g.
//
// I4 — l'orario ricalcolato dal grezzo coincide con l'orario memorizzato.
// Senza, un difetto nel rollup scoperto dopo quarantacinque giorni si corregge
// sui trenta ancora coperti dal grezzo e resta per sempre sui quindici
// precedenti, senza che nessuna colonna dica che sono sbagliati.

import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createKysely, createPool, type Database } from '#src/db/pool.ts';
import { rewind, runRollup } from '#src/stats/rollup.ts';
import { connect, createTestDatabase, type TestDatabase } from '#tests/support/postgres.ts';

let testDb: TestDatabase;
let pool: pg.Pool;
let db: Database;
let sql: pg.Client;

/** Un'ora piena di oggi: cade dentro le partizioni che la migration ha creato. */
let hourStart: Date;

const RUN = '00000000-0000-4000-8000-0000000000aa';
/** L'arena, aperta tutta l'ora. */
const ARENA = 'duels_1';
/** L'evento, aperto solo nei primi cinque minuti. */
const EVENTO = 'evento_1';

beforeAll(async () => {
  testDb = await createTestDatabase('rollup');
  pool = createPool({
    connectionString: testDb.ingestUrl,
    max: 2,
    applicationName: 'metamc-test-rollup',
    statementTimeout: '20s',
    searchPath: 'stats, public',
  });
  db = createKysely(pool);
  sql = await connect(testDb.migrateUrl, 'metamc-test-rollup-sql');
}, 180_000);

afterAll(async () => {
  await sql?.end().catch(() => undefined);
  await db?.destroy().catch(() => undefined);
  await testDb?.drop();
});

beforeEach(async () => {
  await sql.query(`
    DELETE FROM stats.rollup_1d;
    DELETE FROM stats.rollup_1h;
    DELETE FROM stats.rollup_5m;
    DELETE FROM stats.sample_server;
    DELETE FROM stats.poll_cycle;
    DELETE FROM stats.server WHERE server_id > 1;`);
  // Lo stato dei livelli e' condiviso fra i test di questo file: il test sul
  // recupero limitato abbassa `max_buckets` e senza questo ripristino i test
  // successivi non sarebbero mai in pari — un guasto che dipende dall'ORDINE
  // di esecuzione, cioe' quello che si scopre il giorno in cui se ne aggiunge
  // uno in mezzo.
  await sql.query('UPDATE stats.rollup_state SET max_buckets = 288, rows_written = 0, behind_buckets = 0');
  // Un'ora piena, oggi, gia' passata rispetto al momento in cui i test
  // chiamano il rollup: cosi' nessun bucket e' «in corso».
  const res = await sql.query<{ h: Date }>(`SELECT date_trunc('hour', now()) - interval '2 hours' AS h`);
  hourStart = res.rows[0]?.h as Date;
});

/**
 * Semina un'ora di campionamento: 120 tick a 30 secondi.
 *
 * L'arena c'e' sempre con 150 giocatori; l'evento solo nei primi cinque
 * minuti con 200. Il totale di rete e' la somma, come lo scriverebbe il
 * poller: l'insieme deduplicato delle identita'.
 */
async function seedHour(): Promise<void> {
  await sql.query(`INSERT INTO stats.server (server_key) VALUES ($1), ($2) ON CONFLICT DO NOTHING`, [
    ARENA,
    EVENTO,
  ]);
  await sql.query(
    `WITH t AS (
       SELECT g AS tick_at,
              (g < $1::timestamptz + interval '5 minutes') AS evento
         FROM generate_series($1::timestamptz,
                              $1::timestamptz + interval '59 minutes 30 seconds',
                              interval '30 seconds') g
     ),
     c AS (
       INSERT INTO stats.poll_cycle (tick_at, run_id, status, delta_s, players)
       SELECT tick_at, $2::uuid, 'ok', 30, 150 + CASE WHEN evento THEN 200 ELSE 0 END FROM t
       RETURNING tick_at
     )
     INSERT INTO stats.sample_server (tick_at, server_id, delta_s, players)
     SELECT t.tick_at, s.server_id, 30,
            CASE WHEN s.server_key = $3 THEN 150 ELSE 200 END
       FROM t JOIN stats.server s ON s.server_key IN ($3, $4)
      WHERE s.server_key = $3 OR t.evento`,
    [hourStart, RUN, ARENA, EVENTO],
  );
}

/** Riporta i tre segnalibri prima dei dati e fa girare la catena. */
async function rollAll(): Promise<void> {
  const after = new Date(hourStart.getTime() + 3_600_000 + 600_000);
  for (const level of ['5m', '1h', '1d'] as const) {
    await rewind(db, level, hourStart);
    await runRollup(db, level, after.getTime());
  }
}

type Row = Record<string, string | number | null>;
const rows = async (q: string, p: unknown[] = []): Promise<Row[]> => (await sql.query(q, p)).rows as Row[];

describe('il denominatore non viene mai dalle righe del numeratore (I2)', () => {
  beforeEach(seedHour);

  it('covered_s e samples sono identici per tutti i server dello stesso bucket', async () => {
    await rollAll();
    for (const table of ['rollup_5m', 'rollup_1h']) {
      const divergenti = await rows(
        `SELECT count(*)::int AS n FROM (
           SELECT bucket FROM stats.${table}
            GROUP BY bucket HAVING count(DISTINCT covered_s) > 1 OR count(DISTINCT samples) > 1) t`,
      );
      expect(divergenti[0]?.n, `${table}: covered_s non uniforme nel bucket`).toBe(0);
    }
  });

  it('l`evento aperto cinque minuti esce a 16,7 sull`ora, non a 200', async () => {
    await rollAll();
    const r = await rows(
      `SELECT m.mode_key, round((h.player_seconds::numeric / h.covered_s), 1)::float8 AS media,
              h.covered_s
         FROM stats.rollup_1h h
         JOIN stats.server v ON v.server_id = h.server_id
         LEFT JOIN LATERAL (SELECT v.server_key AS mode_key) m ON true
        WHERE v.server_key IN ($1, $2) ORDER BY v.server_key`,
      [ARENA, EVENTO],
    );
    const arena = r.find((x) => x['mode_key'] === ARENA);
    const evento = r.find((x) => x['mode_key'] === EVENTO);

    expect(Number(arena?.['media'])).toBeCloseTo(150, 1);
    // 200 giocatori per 300 secondi su 3600 di ora = 16,7. Se qui esce 200,
    // il denominatore e' stato preso dalle righe dell'evento.
    expect(Number(evento?.['media'])).toBeCloseTo(16.7, 1);
    // E la prova diretta: stesso denominatore per entrambi.
    expect(Number(evento?.['covered_s'])).toBe(Number(arena?.['covered_s']));
    expect(Number(arena?.['covered_s'])).toBe(3600);
  });

  it('sul giorno l`evento vale 0,7: e` quanto vale davvero', async () => {
    await rollAll();
    const r = await rows(
      `SELECT d.player_seconds, d.covered_s, d.expected_s
         FROM stats.rollup_1d d JOIN stats.server v ON v.server_id = d.server_id
        WHERE v.server_key = $1`,
      [EVENTO],
    );
    // 200 x 30 x 10 tick = 60.000 secondi-giocatore su un giorno da 86.400.
    expect(Number(r[0]?.['player_seconds'])).toBe(60_000);
    expect(Number(r[0]?.['player_seconds']) / Number(r[0]?.['expected_s'])).toBeCloseTo(0.7, 1);
  });
});

describe('la gerarchia e` esatta, non approssimata', () => {
  beforeEach(seedHour);

  it('i secondi-giocatore sono identici ai tre livelli', async () => {
    await rollAll();
    const r = await rows(
      `SELECT (SELECT sum(player_seconds) FROM stats.rollup_5m WHERE server_id = 0) AS a,
              (SELECT sum(player_seconds) FROM stats.rollup_1h WHERE server_id = 0) AS b,
              (SELECT sum(player_seconds) FROM stats.rollup_1d WHERE server_id = 0) AS c`,
    );
    // 150 x 30 x 120 + 200 x 30 x 10 = 540.000 + 60.000
    expect(Number(r[0]?.['a'])).toBe(600_000);
    expect(Number(r[0]?.['b'])).toBe(600_000);
    expect(Number(r[0]?.['c'])).toBe(600_000);
  });

  it('il massimo giornaliero e` il massimo dei massimi orari (I3)', async () => {
    await rollAll();
    const divergenti = await rows(
      `SELECT count(*)::int AS n
         FROM stats.rollup_1d d
         JOIN (SELECT stats.civil_day(bucket) AS day, server_id, max(players_max) AS mx
                 FROM stats.rollup_1h GROUP BY 1, 2) h
           ON h.day = d.day AND h.server_id = d.server_id
        WHERE d.players_max <> h.mx`,
    );
    expect(divergenti[0]?.n).toBe(0);
  });

  it('l`orario ricalcolato dal grezzo coincide con quello memorizzato (I4)', async () => {
    await rollAll();
    const divergenti = await rows(
      `SELECT count(*)::int AS n FROM stats.rollup_1h h
         JOIN (SELECT date_bin('1 hour', s.tick_at, 'epoch'::timestamptz) AS bucket, s.server_id,
                      sum(s.players::bigint * s.delta_s) AS ps
                 FROM stats.sample_server s
                 JOIN stats.poll_cycle c ON c.tick_at = s.tick_at AND c.status = 'ok'
                GROUP BY 1, 2) g
           ON g.bucket = h.bucket AND g.server_id = h.server_id
        WHERE h.player_seconds IS DISTINCT FROM g.ps`,
    );
    expect(divergenti[0]?.n).toBe(0);
  });

  it('rieseguire il giro non cambia un numero', async () => {
    // E' la proprieta' che rende sicuri il lookback e ogni ricalcolo: senza
    // upsert totale, ripassare su un bucket lo conterebbe due volte.
    await rollAll();
    const prima = await rows('SELECT * FROM stats.rollup_1h ORDER BY bucket, server_id');
    await rollAll();
    const dopo = await rows('SELECT * FROM stats.rollup_1h ORDER BY bucket, server_id');
    expect(dopo).toEqual(prima);
  });
});

describe('il recupero e` limitato e il segnalibro avanza', () => {
  it('un arretrato lungo si consuma un pezzo per volta, non in un colpo', async () => {
    // Senza il limite, il primo giro dopo un fermo lungo aggrega tutto in un
    // solo statement, viene ucciso dal timeout, ritentato per sempre, e il
    // watermark non avanza mai: stallo permanente con grafici vuoti.
    await sql.query(`UPDATE stats.rollup_state SET max_buckets = 4 WHERE level = '5m'`);
    await seedHour();
    await rewind(db, '5m', hourStart);

    const dopoUnGiro = await runRollup(db, '5m', hourStart.getTime() + 3_600_000 + 600_000);
    expect(dopoUnGiro.caughtUp).toBe(false);
    expect(dopoUnGiro.behindBuckets).toBeGreaterThan(0);
    // Quattro bucket da cinque minuti: venti minuti, non l'ora intera.
    expect(dopoUnGiro.to.getTime() - hourStart.getTime()).toBe(4 * 300_000);

    // Rilanciando finche' non e' in pari, ci arriva.
    for (let i = 0; i < 20; i += 1) {
      const r = await runRollup(db, '5m', hourStart.getTime() + 3_600_000 + 600_000);
      if (r.caughtUp) break;
    }
    const stato = await rows(`SELECT behind_buckets FROM stats.rollup_state WHERE level = '5m'`);
    expect(Number(stato[0]?.['behind_buckets'])).toBe(0);
  });
});

describe('un giorno dichiarato finale non si riscrive', () => {
  beforeEach(seedHour);

  it('ne` le sue misure ne` i conteggi che il rollup non possiede', async () => {
    await rollAll();
    // La chiusura giornaliera (passo 6) scrive le colonne non additive e
    // alza `final`. Da quel momento il numero e' stato letto e annotato.
    await sql.query(
      `UPDATE stats.rollup_1d SET uniques = 4321, sessions = 99, final = true WHERE server_id = 0`,
    );

    await rollAll();

    const r = await rows(`SELECT uniques, sessions, player_seconds FROM stats.rollup_1d WHERE server_id = 0`);
    expect(Number(r[0]?.['uniques'])).toBe(4321);
    expect(Number(r[0]?.['sessions'])).toBe(99);
  });

  it('sui giorni non finali gli unici sopravvivono comunque al rollup', async () => {
    // Il rollup non possiede quelle colonne: azzerarle a ogni passaggio del
    // lookback le cancellerebbe fra una chiusura e la successiva.
    await rollAll();
    await sql.query(`UPDATE stats.rollup_1d SET uniques = 777 WHERE server_id = 0`);
    await rollAll();
    const r = await rows('SELECT uniques FROM stats.rollup_1d WHERE server_id = 0');
    expect(Number(r[0]?.['uniques'])).toBe(777);
  });
});

describe('il giorno civile non e` il giorno UTC', () => {
  it('expected_s vale 86400, tranne i due giorni in cui non vale', async () => {
    await seedHour();
    await rollAll();
    const r = await rows('SELECT DISTINCT expected_s FROM stats.rollup_1d');
    expect(r).toHaveLength(1);
    expect([82_800, 86_400, 90_000]).toContain(Number(r[0]?.['expected_s']));
  });
});

describe('la diagnostica non deve far sospettare un guasto che non c e', () => {
  beforeEach(seedHour);

  it('un giro a vuoto non azzera il conteggio dell`ultimo giro che ha scritto', async () => {
    // Fra un confine di cinque minuti e l'altro il rollup non ha niente di
    // nuovo da aggregare: e' il caso NORMALE. Azzerando `rows_written` a ogni
    // passaggio a vuoto, chi apre stats.rollup_state per sapere se il rollup
    // funziona legge zero quasi sempre e conclude che sia fermo — ed e'
    // esattamente quello che e' successo in produzione. Una diagnostica che
    // manda a cercare nel posto sbagliato e' peggio di una assente.
    await rollAll();
    const dopoLavoro = await rows(`SELECT rows_written FROM stats.rollup_state WHERE level = '5m'`);
    expect(Number(dopoLavoro[0]?.['rows_written'])).toBeGreaterThan(0);

    // Stesso istante, watermark gia' avanti: il giro non aggrega niente.
    const fermo = await runRollup(db, '5m', hourStart.getTime() + 3_600_000 + 600_000);
    expect(fermo.rowsWritten).toBe(0);

    const dopoVuoto = await rows(`SELECT rows_written FROM stats.rollup_state WHERE level = '5m'`);
    expect(Number(dopoVuoto[0]?.['rows_written'])).toBe(Number(dopoLavoro[0]?.['rows_written']));
  });
});
