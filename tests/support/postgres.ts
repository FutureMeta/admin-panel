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

import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { runMigrations } from '#scripts/migrate.ts';

export const ADMIN_URL =
  process.env.TEST_PG_ADMIN_URL ?? 'postgres://postgres@127.0.0.1:55432/postgres';

/** Password dei ruoli di test: casuale per run, mai committata, mai riusata. */
const ROLE_PASSWORD = randomBytes(18).toString('base64url');

export type TestDatabase = {
  name: string;
  /** URL del ruolo che possiede il DDL. */
  migrateUrl: string;
  /** URL del ruolo applicativo: niente DDL, solo INSERT/SELECT sull'audit. */
  appUrl: string;
  /** URL del superuser: serve SOLO ai test che devono manomettere l'audit. */
  adminUrl: string;
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
  });
  return rolesReady;
}

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

  // Il ruolo applicativo deve potersi collegare al database.
  await withAdmin(async (c) => {
    await c.query(`GRANT CONNECT ON DATABASE ${name} TO metamc_app, metamc_migrate`);
    await c.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
  }, adminUrl);

  await runMigrations(migrateUrl, { log: () => undefined });

  return {
    name,
    migrateUrl,
    appUrl,
    adminUrl,
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
