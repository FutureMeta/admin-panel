// Il job da trenta secondi: che sia REGISTRATO, e che spegnerlo sia una
// decisione e non una dimenticanza.
//
// UN JOB SCRITTO MA MAI AVVIATO si legge nel codice e si da' per fatto. E'
// gia' la ragione per cui esiste `JobRegistry`, ed e' la stessa ragione per
// cui qui non basta chiamare `runDuelsIngest` a mano: quello lo prova la 56.
// Qui si prova che il keeper lo metta davvero in un timer e che il registro se
// ne accorga.
//
// E CHE MEZZA CONFIGURAZIONE NON PASSI. `DUELS_INGEST_ENABLED=1` senza
// `DUELS_MYSQL_URL` sarebbe un giro acceso che non legge niente: il pannello
// partirebbe, le schermate resterebbero all'ora dell'ultimo backfill, e la
// causa sarebbe una riga assente in un file di ambiente. Si fallisce
// all'avvio.

import type pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseEnv } from '#src/config/env.ts';
import { createKysely, createPool, type Database } from '#src/db/pool.ts';
import { DUELS_INTERVAL_MS, startDuelsIngest } from '#src/duels/keeper.ts';
import { JobRegistry } from '#src/jobs/scheduler.ts';
import { fakeDuelsMysql } from '#tests/support/duels-mysql.ts';
import { connect, createTestDatabase, type TestDatabase } from '#tests/support/postgres.ts';

let testDb: TestDatabase;
let sql: pg.Client;
let db: Database;
let pool: pg.Pool;

beforeAll(async () => {
  testDb = await createTestDatabase('duelsjob');
  sql = await connect(testDb.migrateUrl, 'metamc-test-duelsjob');
  pool = createPool({
    connectionString: testDb.ingestUrl,
    max: 2,
    applicationName: 'metamc-test-duelsjob-pool',
    statementTimeout: '20s',
    searchPath: 'stats, public',
  });
  db = createKysely(pool);
}, 180_000);

afterAll(async () => {
  await db?.destroy().catch(() => undefined);
  await sql?.end().catch(() => undefined);
  await testDb?.drop();
});

beforeEach(async () => {
  await sql.query(`
    DELETE FROM stats.duels_match_hour; DELETE FROM stats.duels_mode; DELETE FROM stats.duels_map;
    UPDATE stats.duels_ingest_state SET last_id = 0, since_day = NULL, degraded = 0;`);
});

/** Non un finto con quattro funzioni vuote: pino ha un livello `silent`. */
const silent = pino({ level: 'silent' });

const MODES = [
  { id: 1, name: 'classic', display_name: 'Classic', ranking: 'RANKED', type: 'DUEL', color: '#d34545' },
];
const MATCHES = [
  { id: 1, created_at: '2026-08-20 10:05:00', type: 'DUEL', context: 'NORMAL', mode_id: 1, map_id: 10 },
];

/** L'ambiente minimo che `parseEnv` accetta, piu' cio' che il caso aggiunge. */
function envWith(extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    APP_ORIGIN: 'http://localhost:3000',
    TRUST_PROXY_CIDR: '127.0.0.1/32',
    DATABASE_URL: 'postgres://u:p@localhost:5432/d',
    DATABASE_MIGRATE_URL: 'postgres://m:p@localhost:5432/d',
    REDIS_URL: 'redis://localhost:6379',
    MASTER_KEY: 'a'.repeat(64),
    MAIL_FROM: 'MetaMC Admin <no-reply@metamc.it>',
    RESEND_WEBHOOK_SECRET: `whsec_${Buffer.from('segreto-webhook-di-test-0123456789').toString('base64')}`,
    ...extra,
  };
}

describe('mezza configurazione non passa', () => {
  it('acceso senza il MySQL non parte affatto', async () => {
    expect(() => parseEnv(envWith({ DUELS_INGEST_ENABLED: '1' }))).toThrow(/DUELS_MYSQL_URL/);
  });

  it('acceso senza il ruolo di scrittura non parte affatto', async () => {
    expect(() =>
      parseEnv(envWith({ DUELS_INGEST_ENABLED: '1', DUELS_MYSQL_URL: 'mysql://u:p@h/d' })),
    ).toThrow(/DATABASE_INGEST_URL/);
  });

  it('con tutte e due parte, e spento resta spento', async () => {
    const acceso = parseEnv(
      envWith({
        DUELS_INGEST_ENABLED: '1',
        DUELS_MYSQL_URL: 'mysql://u:p@h/d',
        DATABASE_INGEST_URL: 'postgres://i:p@localhost:5432/d',
      }),
    );
    expect(acceso.DUELS_INGEST_ENABLED).toBe(true);
    // Il difetto opposto: un interruttore che non spegne. Senza la variabile
    // il pannello non deve aprire nessuna connessione al database del gioco.
    expect(parseEnv(envWith({})).DUELS_INGEST_ENABLED).toBe(false);
  });
});

describe('il giro e` davvero in un timer', () => {
  it('il registro conosce `duels-ingest` e conta il primo giro', async () => {
    const registry = new JobRegistry();
    const ingest = await startDuelsIngest({
      databaseUrl: testDb.ingestUrl,
      mysqlUrl: 'mysql://non-usato',
      mysql: fakeDuelsMysql({ modes: MODES, matches: MATCHES }),
      logger: silent,
      registry,
    });

    try {
      // `startJob` parte SUBITO e poi si ripianifica: si aspetta che il primo
      // giro sia arrivato in fondo, non trenta secondi.
      await expect
        .poll(() => registry.state('duels-ingest').successes, { timeout: 10_000 })
        .toBeGreaterThan(0);
      expect(registry.state('duels-ingest').failures).toBe(0);

      // E il giro ha SCRITTO: se il pool avesse il search_path sbagliato o il
      // ruolo senza permessi, il job risulterebbe registrato e il database
      // vuoto — cioe' verde e inutile.
      const rows = await sql.query<{ n: string }>(
        `SELECT COALESCE(sum(matches), 0)::text AS n FROM stats.duels_match_hour`,
      );
      expect(rows.rows[0]?.n).toBe('1');
    } finally {
      await ingest.stop();
    }
  });

  it('senza `schedule` non parte nessun timer, ma `runOnce` funziona', async () => {
    const registry = new JobRegistry();
    const ingest = await startDuelsIngest({
      databaseUrl: testDb.ingestUrl,
      mysqlUrl: 'mysql://non-usato',
      mysql: fakeDuelsMysql({ modes: MODES, matches: MATCHES }),
      logger: silent,
      registry,
      schedule: false,
    });

    try {
      expect(registry.state('duels-ingest').successes).toBe(0);
      const outcome = await ingest.runOnce();
      expect(outcome).toMatchObject({ partite: 1, conteso: false, indietro: false });
    } finally {
      await ingest.stop();
    }
  });

  it('la cadenza e` trenta secondi, non i cinque minuti della specifica', async () => {
    // Il §1.4 proponeva cinque minuti. La decisione del 22 agosto 2026 li
    // porta a trenta secondi, e il browser interroga sullo stesso ritmo: se
    // qualcuno riportasse la costante a 300_000 senza toccare il resto, le
    // schermate continuerebbero a chiedere ogni trenta secondi un dato che si
    // muove ogni cinque minuti — e sembrerebbe che il gioco sia fermo.
    expect(DUELS_INTERVAL_MS).toBe(30_000);
  });
});
