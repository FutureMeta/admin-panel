// Passo 8, il cancello — i due giorni di cambio ora. §9.2, test di proprieta' 2.
//
// SONO GLI UNICI DUE GIORNI DELL'ANNO IN CUI L'ARITMETICA DEL TEMPO MENTE, e
// mentono in due modi opposti:
//
//   * l'ultima domenica di OTTOBRE l'ora locale 02 accade DUE VOLTE (02:00
//     CEST e 02:00 CET). La cella (dom, 02) della heatmap raccoglie due
//     bucket. Con la sola media memorizzata, quella cella riporterebbe la
//     media di due ore diverse come se fosse una, e nessuno potrebbe
//     accorgersene guardandola — ed e' esattamente la cella che qualcuno
//     controllera' a mano;
//   * l'ultima domenica di MARZO l'ora locale 02 non accade MAI. Quella cella
//     ha zero occorrenze, e deve uscire GRIGIA. Se uscisse zero, direbbe «alle
//     due di notte non c'era nessuno» — che e' una risposta a una domanda che
//     non e' stata posta, su un'ora che non e' esistita.
//
// E il giorno civile non dura 86400 secondi: dura 90000 a ottobre e 82800 a
// marzo. Una copertura calcolata su 86400 uscirebbe sopra il 100% un giorno
// all'anno e sotto il 96% un altro, e in entrambi i casi sembrerebbe un
// guasto del campionamento.

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKysely, createPool, type Database } from '#src/db/pool.ts';
import { assertPayload } from '#src/stats/contract.ts';
import { buildAll } from '#src/stats/read.ts';
import { connect, createTestDatabase, type TestDatabase } from '#tests/support/postgres.ts';

let testDb: TestDatabase;
let pool: pg.Pool;
let db: Database;
let sql: pg.Client;

const ARENA = 'duels_1';

/** Ultima domenica di ottobre 2025: le lancette tornano indietro, 25 ore. */
const FALL_BACK_DAY = '2025-10-26';
/** Ultima domenica di marzo 2026: le lancette vanno avanti, 23 ore. */
const SPRING_FORWARD_DAY = '2026-03-29';

/** (isodow - 1) * 24 + ora, con la domenica a isodow 7. */
const SUNDAY_02 = (7 - 1) * 24 + 2;

beforeAll(async () => {
  testDb = await createTestDatabase('dst');
  pool = createPool({
    connectionString: testDb.statsUrl,
    // QUATTRO, non otto come in produzione. Su questa macchina Postgres
    // accetta le connessioni UNA ALLA VOLTA, ~750 ms ciascuna (misurato):
    // otto pool aperti insieme da piu` suite parallele sforano qualunque
    // timeout di acquisizione. Le nove query del payload si accodano su
    // quattro connessioni e le riusano, che qui costa meno che aprirne altre.
    max: 4,
    applicationName: 'metamc-test-dst-read',
    connectionTimeoutMillis: 20_000,
    statementTimeout: '10s',
    searchPath: 'stats, public',
  });
  db = createKysely(pool);
  sql = await connect(testDb.migrateUrl, 'metamc-test-dst-sql');

  await sql.query('INSERT INTO stats.server (server_key) VALUES ($1)', [ARENA]);
  await sql.query(`INSERT INTO stats.mode (mode_key, display_name) VALUES ('arena', 'Arena')`);
  await sql.query(
    `INSERT INTO stats.mode_alias (match_kind, match_value, mode_id)
     SELECT 'server', $1, mode_id FROM stats.mode WHERE mode_key = 'arena'`,
    [ARENA],
  );

  // Due settimane, una attorno a ogni cambio ora. Ogni ORA REALE ha il suo
  // bucket: e` cosi` che il grezzo vede il mondo, e il cambio ora si
  // manifesta solo quando si passa all'ora LOCALE.
  for (const [from, to] of [
    ['2025-10-20', '2025-10-29'],
    ['2026-03-23', '2026-04-01'],
  ] as const) {
    await sql.query(
      `WITH h AS (
         SELECT g AS bucket
           FROM generate_series($1::timestamptz, $2::timestamptz - interval '1 hour', interval '1 hour') g
       )
       INSERT INTO stats.rollup_1h
         (bucket, server_id, samples, covered_s, player_seconds, players_max, players_max_at)
       SELECT h.bucket, v.server_id, 120, 3600, 100 * 3600, 100, h.bucket
         FROM h CROSS JOIN stats.server v
        WHERE v.server_id = 0 OR v.server_key = $3`,
      [from, to, ARENA],
    );
  }
}, 180_000);

afterAll(async () => {
  await sql?.end().catch(() => undefined);
  await db?.destroy().catch(() => undefined);
  await testDb?.drop();
});

describe('il giorno civile non dura sempre 86400 secondi', () => {
  it('ottobre 90.000, marzo 82.800', async () => {
    const res = await sql.query<{ ottobre: string; marzo: string }>(
      `SELECT stats.day_seconds($1::date) AS ottobre, stats.day_seconds($2::date) AS marzo`,
      [FALL_BACK_DAY, SPRING_FORWARD_DAY],
    );
    // 25 ore e 23 ore. Un denominatore fisso a 86400 darebbe 104% e 96%.
    expect(Number(res.rows[0]?.ottobre)).toBe(90_000);
    expect(Number(res.rows[0]?.marzo)).toBe(82_800);
  });
});

describe("l'ora ripetuta di ottobre", () => {
  it('la cella (domenica, 02) raccoglie DUE occorrenze', async () => {
    const { overview } = await buildAll(db, '7d', new Date('2025-10-28T12:00:00Z'));
    expect(() => assertPayload(overview)).not.toThrow();

    // Due bucket reali cadono nella stessa ora locale. Con la sola media, la
    // cella mentirebbe e nessuno potrebbe accorgersene guardandola.
    expect(overview.heatmap.n[SUNDAY_02]).toBe(2);
    expect(overview.heatmap.v[SUNDAY_02]).toBeGreaterThan(0);
    // I tre array esistono proprio per questo: numeratore, denominatore e
    // occorrenze separati, e la divisione si fa al disegno.
    expect(overview.heatmap.w[SUNDAY_02]).toBe(2 * 3600);
  });

  it('le altre ore della stessa domenica ne hanno una sola', async () => {
    const { overview } = await buildAll(db, '7d', new Date('2025-10-28T12:00:00Z'));
    expect(overview.heatmap.n[(7 - 1) * 24 + 5]).toBe(1);
    expect(overview.heatmap.n[(7 - 1) * 24 + 14]).toBe(1);
  });
});

describe("l'ora che non e` mai esistita, a marzo", () => {
  it('la cella (domenica, 02) ha ZERO occorrenze e resta vuota', async () => {
    const { overview } = await buildAll(db, '7d', new Date('2026-03-31T12:00:00Z'));
    expect(() => assertPayload(overview)).not.toThrow();

    // Zero occorrenze, non zero giocatori: l'interfaccia la disegna grigia
    // (Heatmap tratta `occurrences === 0` come «non rilevato»), e dire «alle
    // due di notte non c'era nessuno» su un'ora che non e` esistita sarebbe
    // una risposta a una domanda mai posta.
    expect(overview.heatmap.n[SUNDAY_02]).toBe(0);
    expect(overview.heatmap.w[SUNDAY_02]).toBe(0);
    expect(overview.heatmap.v[SUNDAY_02]).toBe(0);
  });

  it('le ore attorno ci sono tutte', async () => {
    const { overview } = await buildAll(db, '7d', new Date('2026-03-31T12:00:00Z'));
    expect(overview.heatmap.n[(7 - 1) * 24 + 1]).toBe(1);
    expect(overview.heatmap.n[(7 - 1) * 24 + 3]).toBe(1);
  });
});

describe('la serie non salta ne` ripete un bucket, nei due giorni in cui sarebbe facile', () => {
  for (const [label, at] of [
    ['ottobre', '2025-10-28T12:00:00Z'],
    ['marzo', '2026-03-31T12:00:00Z'],
  ] as const) {
    it(`asse regolare e copertura entro il 100% — ${label}`, async () => {
      const { overview } = await buildAll(db, '7d', new Date(at));
      const t = overview.online.t;

      // L'asse e` una griglia: il buco e` un valore, non un punto mancante.
      // Quindi CRESCENTE E SENZA RIPETIZIONI — ma non a passo costante.
      //
      // L'asserzione era `differenza === bucketSec`, e quella e` proprio
      // l'assunzione che questi due giorni smentiscono: l'asse segue
      // l'OROLOGIO LOCALE, e il 26 ottobre le 02:00 esistono due volte, quindi
      // due ore vere finiscono nello stesso bucket e il punto successivo dista
      // due ore invece di una. Preteso il passo fisso, l'unico modo di
      // soddisfarlo era costruire l'asse ignorando il fuso — cioe` un asse che
      // non combacia piu` con i dati, che e` il difetto da cui si e` partiti.
      for (let i = 1; i < t.length; i += 1) {
        expect((t[i] as number) - (t[i - 1] as number)).toBeGreaterThan(0);
      }
      expect(new Set(t).size).toBe(t.length);

      // E i punti restano quelli attesi per un periodo di sette giorni: se
      // l'asse perdesse o inventasse ore, il conto non tornerebbe.
      expect(t.length).toBeGreaterThanOrEqual(7 * 24 - 1);
      expect(t.length).toBeLessThanOrEqual(7 * 24);

      // Nessuna copertura sopra il 100%: e` il sintomo di uno slot ripetuto o
      // di un denominatore nominale sbagliato.
      for (const c of overview.online.coverage) {
        expect(c).toBeLessThanOrEqual(1);
        expect(c).toBeGreaterThanOrEqual(0);
      }
      expect(overview.kpi.coverage).toBeLessThanOrEqual(1);
    });
  }
});
