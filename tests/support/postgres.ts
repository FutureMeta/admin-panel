// Infrastruttura di test — PostgreSQL reale con le migration reali.
//
// §14: "non pglite: servono ruoli, GRANT/REVOKE, partizionamento e trigger".
// Ogni suite ottiene un DATABASE effimero sullo stesso cluster, creato dalle
// migration vere e distrutto alla fine. I ruoli (metamc_migrate, metamc_app)
// sono oggetti di cluster: si creano una volta e si riusano.
//
// Il cluster arriva da TEST_PG_ADMIN_URL. In CI e' un container PostgreSQL
// 18.6; in locale, in assenza di un container runtime, va bene un cluster
// effimero creato con `initdb -A trust` su una porta dedicata.

import pg from 'pg';
import { ASSISTANT_ROLE, ASSISTANT_ROLE_SQL } from '#scripts/create-assistant-role.ts';
import { STATS_ROLES, STATS_ROLES_SQL } from '#scripts/create-stats-roles.ts';
import { runMigrations } from '#scripts/migrate.ts';

export const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? 'postgres://postgres@127.0.0.1:55432/postgres';

/**
 * Password dei ruoli di test.
 *
 * DEVE essere identica in tutti i worker di vitest: i ruoli sono oggetti di
 * CLUSTER, non di database, e una password diversa per processo significa che
 * l'ultimo `ALTER ROLE` rompe le connessioni di tutti gli altri. Con una
 * randomizzazione per processo il sintomo era `tuple concurrently updated` su
 * pg_authid, che e' il modo in cui Postgres dice "vi state pestando i piedi".
 *
 * Non e' un segreto: vale su un cluster effimero, creato e distrutto dalla
 * suite. In CI la si sovrascrive con TEST_PG_ROLE_PASSWORD.
 */
const ROLE_PASSWORD = process.env.TEST_PG_ROLE_PASSWORD ?? 'metamc-test-role-password';

export type TestDatabase = {
  name: string;
  /** URL del ruolo che possiede il DDL. */
  migrateUrl: string;
  /** URL del ruolo applicativo: niente DDL, solo INSERT/SELECT sull'audit. */
  appUrl: string;
  /** URL del superuser: serve SOLO ai test che devono manomettere l'audit. */
  adminUrl: string;
  /** Sola lettura sulle statistiche: `default_transaction_read_only` viene dal RUOLO. */
  statsUrl: string;
  /** Scrittura sulle statistiche, con i timeout stretti del ciclo di campionamento. */
  ingestUrl: string;
  /**
   * Sola lettura per l'assistente: le viste delle statistiche (per
   * appartenenza a metamc_stats) piu' il minimo su `auth` e `audit`.
   *
   * Gira qui la stessa definizione che il runbook esegue in produzione,
   * importata e non ricopiata: una copia diverge, e i test proverebbero uno
   * schema di privilegi che non esiste da nessuna parte.
   */
  assistantUrl: string;
  drop: () => Promise<void>;
};

function withDatabase(url: string, dbName: string, user?: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  if (user) {
    u.username = user;
    u.password = ROLE_PASSWORD;
  }
  return u.toString();
}

async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>, url = ADMIN_URL): Promise<T> {
  const c = new pg.Client({ connectionString: url, application_name: 'metamc-test-admin' });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

let rolesReady: Promise<void> | undefined;

/**
 * I ruoli sono oggetti di cluster, non di database: crearli una volta sola
 * evita una corsa fra suite parallele. La password e' impostata qui perche'
 * i test devono potersi autenticare davvero come metamc_app — e' l'unico modo
 * di verificare i GRANT (test 1).
 */
function ensureRoles(): Promise<void> {
  rolesReady ??= withAdmin(async (c) => {
    // Lock advisory a livello di cluster: i worker di vitest sono processi
    // distinti e arrivano qui insieme. Senza, due CREATE/ALTER ROLE
    // simultanei collidono sulla stessa tupla di pg_authid.
    await c.query('SELECT pg_advisory_lock(812026082)');
    try {
      for (const role of ['metamc_migrate', 'metamc_app']) {
        await c.query(`
          DO $$
          BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
              CREATE ROLE ${role} LOGIN;
            END IF;
          END $$;`);
        await c.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD '${ROLE_PASSWORD}'`);
      }

      // I quattro ruoli della fase 2. La migration 011 li PRETENDE e non li
      // crea: sono oggetti di CLUSTER e metamc_migrate non ha CREATEROLE.
      // Qui gira la stessa identica definizione che il runbook esegue in
      // produzione, importata e non ricopiata: una copia diverge, e i test
      // proverebbero uno schema di privilegi che non esiste da nessuna parte.
      await c.query(STATS_ROLES_SQL);
      // Il ruolo dell'assistente e' membro di metamc_stats, quindi si crea
      // DOPO. La 019 lo pretende e non lo crea: e' un oggetto di CLUSTER.
      await c.query(ASSISTANT_ROLE_SQL);
      for (const role of [...STATS_ROLES, ASSISTANT_ROLE]) {
        // La password serve ai test che devono CONNETTERSI come questi ruoli:
        // `default_transaction_read_only` e i timeout sono impostazioni di
        // ruolo, si applicano al login e non le eredita un SET ROLE.
        await c.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD '${ROLE_PASSWORD}'`);
      }
    } finally {
      await c.query('SELECT pg_advisory_unlock(812026082)').catch(() => undefined);
    }
  });
  return rolesReady;
}

/**
 * UNA COSA DA SAPERE PRIMA DI SCRIVERE UN TEST SUL CAMPIONAMENTO.
 *
 * `stats.sample_server` e' l'unica tabella partizionata per GIORNO
 * (011_stats.sql:866); tutte le altre sono mensili. Le migration chiudono con
 * `SELECT stats.ensure_partitions()`, che crea le partizioni giornaliere da
 * `current_date - 1` a `current_date + 4`.
 *
 * Quindi una data SCRITTA A MANO in un test che scrive campioni ha una
 * scadenza: due giorni. Passa, passa, e poi un mattino il file diventa rosso
 * con «nessuna partizione trovata per la riga» — un errore che non nomina il
 * calendario e manda a cercare un guasto dello schema.
 *
 * E' successo due volte in tre giorni, su `24-stats-schema` e su
 * `51-selfcheck-findings`. La seconda volta due asserzioni si aspettavano un
 * RIFIUTO dal database e lo ottenevano per la ragione sbagliata: passavano
 * dichiarando di aver verificato un vincolo che non era stato nemmeno
 * raggiunto.
 *
 * Gli istanti si ancorano quindi ad ADESSO — `current_date` in SQL,
 * `romeMidnight(new Date())` in TypeScript — e non a un giorno del calendario.
 * Allargare la finestra delle partizioni qui dentro sarebbe la scorciatoia
 * sbagliata: farebbe girare i test su uno schema che in produzione non esiste,
 * e sposterebbe la scadenza invece di toglierla.
 */
let counter = 0;

/** Crea un database effimero, ci applica TUTTE le migration, restituisce gli URL. */
export async function createTestDatabase(label = 'test'): Promise<TestDatabase> {
  await ensureRoles();
  counter += 1;
  const name = `metamc_${label.replace(/[^a-z0-9]/gi, '').toLowerCase()}_${process.pid}_${counter}`;

  await withAdmin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${name} OWNER metamc_migrate`);
  });

  const adminUrl = withDatabase(ADMIN_URL, name);
  const migrateUrl = withDatabase(ADMIN_URL, name, 'metamc_migrate');
  const appUrl = withDatabase(ADMIN_URL, name, 'metamc_app');
  const statsUrl = withDatabase(ADMIN_URL, name, 'metamc_stats');
  const ingestUrl = withDatabase(ADMIN_URL, name, 'metamc_ingest');
  const assistantUrl = withDatabase(ADMIN_URL, name, ASSISTANT_ROLE);

  // Il ruolo applicativo deve potersi collegare al database.
  await withAdmin(async (c) => {
    await c.query(
      `GRANT CONNECT ON DATABASE ${name} TO metamc_app, metamc_migrate, metamc_stats, metamc_ingest, ${ASSISTANT_ROLE}`,
    );
    await c.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
  }, adminUrl);

  await runMigrations(migrateUrl, { log: () => undefined });

  return {
    name,
    migrateUrl,
    appUrl,
    adminUrl,
    statsUrl,
    ingestUrl,
    assistantUrl,
    drop: async () => {
      await withAdmin(async (c) => {
        await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      });
    },
  };
}

/** Client `pg` grezzo su uno degli URL, per i test che devono controllare i privilegi. */
export async function connect(url: string, applicationName = 'metamc-test'): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url, application_name: applicationName });
  await c.connect();
  return c;
}
