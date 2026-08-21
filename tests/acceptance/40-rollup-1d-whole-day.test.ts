// Il rollup giornaliero deve aggregare un GIORNO, non la finestra che lo tocca.
//
// IL DIFETTO. Il livello '1d' consuma bucket ORARI: il suo watermark si muove
// di un'ora per volta e la finestra di lavoro e' `[watermark - 2h, ora
// chiusa)`. Dentro quella finestra si raggruppa per giorno civile e si scrive
// con un upsert che ASSEGNA. Quindi la riga del giorno finisce per contenere
// solo le ore dell'ULTIMA finestra che lo ha sfiorato — per un giorno passato,
// le ultime due o tre — e ogni giro successivo la riscrive piu' corta.
//
// PERCHE' NON SI VEDE. `players_avg` e' `player_seconds / covered_s`, e la
// finestra stringe numeratore e denominatore INSIEME: la media giornaliera
// diventa la media serale. Un numero plausibile, piu' alto del vero, che a
// occhio non si distingue. Poi la chiusura giornaliera alza `final` e quel
// valore resta per sempre.
//
// Il livello '1h' non ha il problema, e il '5m' nemmeno: la loro unita' di
// aggregazione sta dentro la finestra. Solo il '1d' ha un'unita' (il giorno)
// piu' grande del passo del suo watermark (l'ora).

import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createKysely, createPool, type Database } from '#src/db/pool.ts';
import { dailyClose, rollupWatermarks, runRollup } from '#src/stats/rollup.ts';
import { connect, createTestDatabase, type TestDatabase } from '#tests/support/postgres.ts';

let testDb: TestDatabase;
let pool: pg.Pool;
let db: Database;
let sql: pg.Client;

const ARENA = 'duels_1';

/** Un giorno intero, chiuso, lontano da mezzanotte e dai cambi ora. */
const GIORNO = '2026-02-10';
/** Le 23:00 di quel giorno, ora italiana: l'ultima ora da consumare. */
const ULTIMA_ORA = new Date('2026-02-10T22:00:00Z');

beforeAll(async () => {
  testDb = await createTestDatabase('giorno');
  pool = createPool({
    connectionString: testDb.ingestUrl,
    max: 4,
    applicationName: 'metamc-test-giorno',
    connectionTimeoutMillis: 20_000,
    statementTimeout: '30s',
    searchPath: 'stats, public',
  });
  db = createKysely(pool);
  sql = await connect(testDb.migrateUrl, 'metamc-test-giorno-sql');
  await sql.query('INSERT INTO stats.server (server_key) VALUES ($1)', [ARENA]);
}, 300_000);

afterAll(async () => {
  await sql?.end().catch(() => undefined);
  await db?.destroy().catch(() => undefined);
  await testDb?.drop();
});

beforeEach(async () => {
  await sql.query('DELETE FROM stats.rollup_1d');
  await sql.query('DELETE FROM stats.rollup_1h');
  // VENTIQUATTRO ORE PIENE, tutte uguali: cosi' un totale corto non puo'
  // essere che una finestra che ha tagliato il giorno.
  await sql.query(
    `INSERT INTO stats.rollup_1h (bucket, server_id, samples, covered_s, player_seconds, players_max, players_max_at)
     SELECT g, v.server_id, 120, 3600, 100 * 3600, 100, g
       FROM generate_series(timestamptz '2026-02-09 23:00Z', timestamptz '2026-02-10 22:00Z', interval '1 hour') g
       CROSS JOIN stats.server v
      WHERE v.server_id = 0 OR v.server_key = $1`,
    [ARENA],
  );
  // Il watermark all'inizio del giorno: da li' il job cammina di un'ora.
  await sql.query(
    `UPDATE stats.rollup_state SET watermark = timestamptz '2026-02-09 23:00Z' WHERE level = '1d'`,
  );
});

/** Copertura e secondi-giocatore della riga di RETE per quel giorno. */
async function rigaDiRete(): Promise<{ covered_s: number; player_seconds: number } | null> {
  const r = await sql.query(
    `SELECT covered_s, player_seconds FROM stats.rollup_1d
      WHERE server_id = 0 AND day = $1::date`,
    [GIORNO],
  );
  const row = r.rows[0] as { covered_s: number; player_seconds: string } | undefined;
  return row ? { covered_s: row.covered_s, player_seconds: Number(row.player_seconds) } : null;
}

describe('il giorno vale ventiquattro ore, non le ultime della finestra', () => {
  it('un giro solo che copre tutto il giorno lo scrive intero', async () => {
    // Il caso facile, ed e' l'unico che i test esistenti esercitano: una
    // finestra sola abbastanza larga da contenere il giorno.
    await runRollup(db, '1d', ULTIMA_ORA.getTime() + 3_600_000);
    expect(await rigaDiRete()).toEqual({ covered_s: 24 * 3600, player_seconds: 24 * 100 * 3600 });
  });

  it('e ventiquattro giri da un`ora lo scrivono uguale', async () => {
    // COME GIRA DAVVERO IL JOB: ogni quindici minuti, con l'orologio che
    // avanza. Ogni passata riscrive la riga del giorno con le sole ore della
    // sua finestra, e l'ultima parola resta all'ultima passata.
    for (let h = 0; h <= 24; h += 1) {
      await runRollup(db, '1d', new Date('2026-02-09T23:00:00Z').getTime() + h * 3_600_000);
    }
    expect(await rigaDiRete()).toEqual({ covered_s: 24 * 3600, player_seconds: 24 * 100 * 3600 });
  });

  it('e rieseguirlo dopo non lo accorcia', async () => {
    // Idempotenza vera: un giro in piu' quando il giorno e' gia' scritto non
    // deve sostituirlo con la sola coda della finestra.
    await runRollup(db, '1d', ULTIMA_ORA.getTime() + 3_600_000);
    await runRollup(db, '1d', ULTIMA_ORA.getTime() + 7_200_000);
    expect(await rigaDiRete()).toEqual({ covered_s: 24 * 3600, player_seconds: 24 * 100 * 3600 });
  });
});

describe('«definitivo» si dice quando il rollup ha finito, non a mezzanotte', () => {
  /** `final` della riga di rete per il giorno seminato. */
  async function definitivo(): Promise<boolean | null> {
    const r = await sql.query(`SELECT final FROM stats.rollup_1d WHERE server_id = 0 AND day = $1::date`, [
      GIORNO,
    ]);
    return (r.rows[0] as { final: boolean } | undefined)?.final ?? null;
  }

  it('un giorno che il rollup non ha ancora superato resta riscrivibile', async () => {
    // Mezzogiorno: il rollup ha aggregato meta` giornata e basta.
    await runRollup(db, '1d', new Date('2026-02-10T11:00:00Z').getTime());
    await sql.query(
      `UPDATE stats.rollup_state SET watermark = timestamptz '2026-02-09 00:00Z' WHERE level = 'daily_close'`,
    );

    // La chiusura gira col giorno gia` passato per il calendario.
    await dailyClose(db, new Date('2026-02-11T00:01:00Z'));

    // IL DIFETTO: qui usciva `true`, e da quel momento il rollup non poteva
    // piu` toccare la riga. Le ore mancanti erano perse per sempre, con la
    // media serale congelata al posto della giornaliera.
    expect(await definitivo()).toBe(false);
  });

  it('e diventa definitivo appena il rollup lo ha superato', async () => {
    await runRollup(db, '1d', new Date('2026-02-11T00:00:00Z').getTime());
    await sql.query(
      `UPDATE stats.rollup_state SET watermark = timestamptz '2026-02-09 00:00Z' WHERE level = 'daily_close'`,
    );

    await dailyClose(db, new Date('2026-02-11T00:01:00Z'));

    expect(await definitivo()).toBe(true);
    // E il giorno che si congela e` quello INTERO, non la sua coda.
    expect(await rigaDiRete()).toEqual({ covered_s: 24 * 3600, player_seconds: 24 * 100 * 3600 });
  });
});

describe('un livello fermo si vede dal watermark, non dal fatto che dice «in pari»', () => {
  it('il watermark nel futuro produce un giro che si dichiara in pari e non scrive', async () => {
    await sql.query(
      `UPDATE stats.rollup_state SET watermark = timestamptz '2026-03-01 00:00Z' WHERE level = '1d'`,
    );

    const r = await runRollup(db, '1d', new Date('2026-02-11T00:00:00Z').getTime());

    // ECCO LA FORMA DELLO STALLO: nessuna riga scritta, zero bucket di
    // ritardo, e un giro che si annuncia riuscito. Ogni segnale disponibile
    // dice che il livello sta bene, e intanto e` fermo per sempre.
    expect(r.rowsWritten).toBe(0);
    expect(r.caughtUp).toBe(true);

    // L'unico segnale che non mente: il watermark e` AVANTI rispetto ad
    // adesso, cosa che un livello sano non puo` essere.
    const marks = new Map(rollupWatermarks());
    expect(marks.get('1d')).toBeGreaterThan(new Date('2026-02-11T00:00:00Z').getTime());
  });
});
