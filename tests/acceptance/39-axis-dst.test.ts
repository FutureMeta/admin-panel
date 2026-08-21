// L'asse dei tempi attraverso un cambio ora. §6.8.
//
// IL DIFETTO. La griglia dei punti si costruisce a passi FISSI di `bucketSec`
// secondi a partire dall'inizio della finestra, mentre le chiavi che tornano
// da SQL sono ancorate alla mezzanotte CIVILE di Roma. Le due cose coincidono
// finche' i giorni durano tutti 86400 secondi. Nella notte dell'ultima
// domenica di ottobre il giorno civile ne dura 90000, e da li' in poi la
// griglia e' sfasata di un'ora rispetto ai dati: `byT.get(t)` non trova piu'
// niente e ogni serie diventa `null`.
//
// NON E' UN BUCO NEI DATI, ed e' questo che lo rende cattivo: le righe ci
// sono tutte, la query le restituisce, e vengono buttate via nell'ultimo
// passaggio in JS. In produzione si vede come un range lungo vuoto mentre i
// range corti funzionano — cioe' come un problema di raccolta, che manda a
// guardare dalla parte sbagliata.
//
// Il 7g si salva perche' il suo passo e' di un'ora e ogni ora reale cade
// comunque sulla griglia. Il 30g e' il peggiore: sfasamento di un'ora su
// bucket da due, quindi NESSUN punto combacia dopo la transizione.

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKysely, createPool, type Database } from '#src/db/pool.ts';
import { buildOverview } from '#src/stats/read.ts';
import { connect, createTestDatabase, type TestDatabase } from '#tests/support/postgres.ts';

let testDb: TestDatabase;
let pool: pg.Pool;
let db: Database;
let sql: pg.Client;

const ARENA = 'duels_1';

/** Il 26 ottobre 2025 l'ora torna indietro: quel giorno civile dura 25 ore. */
const AFTER_FALL_BACK = new Date('2025-11-10T12:00:00Z');

/** L'ultima domenica di marzo 2026: quel giorno ne dura 23. */
const AFTER_SPRING_FORWARD = new Date('2026-04-10T12:00:00Z');

beforeAll(async () => {
  testDb = await createTestDatabase('asse');
  pool = createPool({
    connectionString: testDb.statsUrl,
    max: 4,
    applicationName: 'metamc-test-asse',
    connectionTimeoutMillis: 20_000,
    statementTimeout: '30s',
    searchPath: 'stats, public',
  });
  db = createKysely(pool);
  sql = await connect(testDb.migrateUrl, 'metamc-test-asse-sql');

  await sql.query('INSERT INTO stats.server (server_key) VALUES ($1)', [ARENA]);
  await sql.query("INSERT INTO stats.mode (mode_key, display_name) VALUES ('arena', 'Arena')");
  await sql.query(
    `INSERT INTO stats.mode_alias (match_kind, match_value, mode_id)
     SELECT 'server', $1, mode_id FROM stats.mode WHERE mode_key = 'arena'`,
    [ARENA],
  );

  // COPERTURA PIENA E COSTANTE su tutto il periodo interessante: cosi' un
  // punto nullo non puo' essere che un difetto di allineamento.
  await sql.query(
    `INSERT INTO stats.rollup_1h (bucket, server_id, samples, covered_s, player_seconds, players_max, players_max_at)
     SELECT g, v.server_id, 120, 3600, 150 * 3600, 150, g
       FROM generate_series(timestamptz '2025-03-01 00:00Z', timestamptz '2026-05-01 00:00Z', interval '1 hour') g
       CROSS JOIN stats.server v
      WHERE v.server_id = 0 OR v.server_key = $1`,
    [ARENA],
  );
  await sql.query(
    `INSERT INTO stats.rollup_1d (day, server_id, samples, covered_s, expected_s, player_seconds, players_max, players_max_at)
     SELECT stats.civil_day(bucket), server_id, sum(samples)::int, sum(covered_s)::int,
            stats.day_seconds(stats.civil_day(bucket)), sum(player_seconds),
            max(players_max), max(players_max_at)
       FROM stats.rollup_1h GROUP BY 1, 2 ON CONFLICT DO NOTHING`,
  );
}, 300_000);

afterAll(async () => {
  await sql?.end().catch(() => undefined);
  await db?.destroy().catch(() => undefined);
  await testDb?.drop();
});

/** Quanti punti dell'asse hanno trovato il loro dato. */
function filled(total: (number | null)[]): number {
  return total.filter((v) => v !== null).length;
}

describe("l'asse non scivola quando l'ora cambia", () => {
  it('30g attraverso il ritorno all`ora solare: nessun punto perso', async () => {
    const { payload } = await buildOverview(db, '30d', AFTER_FALL_BACK);
    // Copertura piena e continua per tutto il periodo: ogni punto dell'asse
    // deve avere il suo dato. Con la griglia a passi fissi ne combaciavano
    // meno di un quarto.
    expect(filled(payload.online.total)).toBe(payload.online.t.length);
  });

  it('30g attraverso il salto in avanti: nessun punto perso', async () => {
    const { payload } = await buildOverview(db, '30d', AFTER_SPRING_FORWARD);
    expect(filled(payload.online.total)).toBe(payload.online.t.length);
  });

  it('90g, bucket da sei ore, attraverso il cambio', async () => {
    const { payload } = await buildOverview(db, '90d', AFTER_FALL_BACK);
    expect(filled(payload.online.total)).toBe(payload.online.t.length);
  });

  it('7g resta sano anche col passo di un`ora', async () => {
    // Il caso di controllo: qui il difetto non si vedeva, perche' un passo di
    // un'ora ricade sulla griglia comunque. Se questo test fallisce, la
    // correzione ha rotto il caso che gia' funzionava.
    const { payload } = await buildOverview(db, '7d', AFTER_FALL_BACK);
    expect(filled(payload.online.total)).toBe(payload.online.t.length);
  });

  it("l'asse dei giorni e` fatto di mezzanotti civili, non di multipli di 86400", async () => {
    const { payload } = await buildOverview(db, '1y', new Date('2026-04-25T12:00:00Z'));
    // La finestra di un anno attraversa DUE transizioni. A passi fissi ne
    // sopravvivevano 88 su 365: tutti i giorni fra l'una e l'altra erano
    // nulli, con i dati presenti e la copertura piena.
    expect(payload.online.t).toHaveLength(365);
    expect(filled(payload.online.total)).toBe(365);
  });
});
