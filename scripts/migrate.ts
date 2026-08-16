// Runner delle migration. Forward-only, una transazione per migration,
// lock advisory contro esecuzioni concorrenti, checksum su ogni file gia'
// applicato. §17.3
//
// Perche' non il Migrator di Kysely: il Migrator passa sempre un array di
// parametri a node-postgres, che quindi usa il protocollo esteso, e il
// protocollo esteso NON accetta piu' istruzioni in una sola query. I nostri
// file .sql contengono DDL multiplo e blocchi DO. Il runner usa quindi il
// client `pg` diretto, che con `query(text)` senza valori parla il protocollo
// semplice. Le convenzioni (tabella di stato, ordinamento, lock) restano
// quelle del Migrator.
//
// Uso:
//   node scripts/migrate.ts up        applica le migration mancanti
//   node scripts/migrate.ts status    elenca stato e checksum
//
// Connessione: DATABASE_MIGRATE_URL (ruolo metamc_migrate), MAI metamc_app.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
// Arbitrario ma stabile: identifica QUESTA migrazione fra tutti gli advisory
// lock del cluster. Costante letterale, mai derivata da input.
const LOCK_ID = 812_026_081;

const STATE_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS public.schema_migration (
    version    text PRIMARY KEY,
    name       text NOT NULL,
    checksum   bytea NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now(),
    applied_by text NOT NULL DEFAULT current_user,
    duration_ms integer
  )`;

export type MigrationFile = {
  version: string;
  name: string;
  file: string;
  sql: string;
  checksum: Buffer;
  inTransaction: boolean;
};

export function loadMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const seen = new Set<string>();
  return files.map((f) => {
    const m = /^(\d+)_(.+)\.sql$/.exec(f);
    if (!m || m[1] === undefined || m[2] === undefined) {
      throw new Error(`nome di migration non valido: ${f} (atteso NNN_nome.sql)`);
    }
    const version = m[1];
    if (seen.has(version)) throw new Error(`versione di migration duplicata: ${version}`);
    seen.add(version);
    const sql = readFileSync(join(dir, f), 'utf8');
    return {
      version,
      name: m[2],
      file: f,
      sql,
      checksum: createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest(),
      // `CREATE INDEX CONCURRENTLY` non puo' stare in una transazione: il file
      // lo dichiara e il runner lo esegue fuori.
      inTransaction: !/^--\s*migrate:no-transaction\b/m.test(sql),
    };
  });
}

type Applied = { version: string; name: string; checksum: Buffer };

async function readApplied(client: pg.ClientBase): Promise<Map<string, Applied>> {
  const res = await client.query<Applied>(
    'SELECT version, name, checksum FROM public.schema_migration ORDER BY version',
  );
  return new Map(res.rows.map((r) => [r.version, r]));
}

function assertChecksums(files: MigrationFile[], applied: Map<string, Applied>): void {
  for (const f of files) {
    const a = applied.get(f.version);
    if (!a) continue;
    if (!Buffer.from(a.checksum).equals(f.checksum)) {
      throw new Error(
        `la migration ${f.file} e' stata modificata dopo essere stata applicata.\n` +
          `  atteso   ${Buffer.from(a.checksum).toString('hex').slice(0, 32)}\n` +
          `  trovato  ${f.checksum.toString('hex').slice(0, 32)}\n` +
          'Le migration sono forward-only: si corregge con una migration nuova.',
      );
    }
  }
  for (const [version, a] of applied) {
    if (!files.some((f) => f.version === version)) {
      throw new Error(`la migration ${version}_${a.name} risulta applicata ma il file non esiste piu'.`);
    }
  }
}

export async function runMigrations(
  connectionString: string,
  opts: { dir?: string; log?: (msg: string) => void } = {},
): Promise<{ applied: string[]; alreadyApplied: string[] }> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const files = loadMigrations(opts.dir);
  const client = new pg.Client({ connectionString, application_name: 'metamc-migrate' });
  await client.connect();

  const result = { applied: [] as string[], alreadyApplied: [] as string[] };
  try {
    await client.query(`SELECT pg_advisory_lock(${LOCK_ID})`);
    await client.query(STATE_TABLE_DDL);
    const applied = await readApplied(client);
    assertChecksums(files, applied);

    for (const f of files) {
      if (applied.has(f.version)) {
        result.alreadyApplied.push(f.file);
        continue;
      }
      const t0 = Date.now();
      log(`  applico ${f.file}${f.inTransaction ? '' : ' (fuori transazione)'}`);
      if (f.inTransaction) await client.query('BEGIN');
      try {
        // Protocollo semplice: `query(text)` senza valori accetta piu'
        // istruzioni, che e' il motivo per cui questo runner non usa Kysely.
        await client.query(f.sql);
        await client.query({
          text: 'INSERT INTO public.schema_migration (version, name, checksum, duration_ms) VALUES ($1,$2,$3,$4)',
          values: [f.version, f.name, f.checksum, Date.now() - t0],
        });
        if (f.inTransaction) await client.query('COMMIT');
      } catch (err) {
        if (f.inTransaction) await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`migration ${f.file} fallita: ${err instanceof Error ? err.message : String(err)}`, {
          cause: err,
        });
      }
      result.applied.push(f.file);
      log(`  ok ${f.file} (${Date.now() - t0} ms)`);
    }
  } finally {
    await client.query(`SELECT pg_advisory_unlock(${LOCK_ID})`).catch(() => undefined);
    await client.end();
  }
  return result;
}

async function status(connectionString: string): Promise<void> {
  const files = loadMigrations();
  const client = new pg.Client({ connectionString, application_name: 'metamc-migrate' });
  await client.connect();
  try {
    await client.query(STATE_TABLE_DDL);
    const applied = await readApplied(client);
    for (const f of files) {
      const a = applied.get(f.version);
      const state = !a
        ? 'DA APPLICARE'
        : Buffer.from(a.checksum).equals(f.checksum)
          ? 'applicata'
          : 'APPLICATA MA MODIFICATA';
      console.log(`  ${f.version}  ${state.padEnd(24)} ${f.name}`);
    }
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'up';
  const url = process.env.DATABASE_MIGRATE_URL;
  if (!url) {
    console.error('DATABASE_MIGRATE_URL non impostata (ruolo metamc_migrate).');
    process.exit(2);
  }
  if (cmd === 'status') {
    await status(url);
    return;
  }
  if (cmd !== 'up') {
    console.error(`comando sconosciuto: ${cmd} (attesi: up, status)`);
    process.exit(2);
  }
  const res = await runMigrations(url);
  console.log(
    res.applied.length === 0
      ? `nessuna migration da applicare (${res.alreadyApplied.length} gia' presenti).`
      : `${res.applied.length} migration applicate.`,
  );
}

const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
