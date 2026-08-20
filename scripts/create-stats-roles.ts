// Crea i quattro ruoli Postgres della fase 2. UNA volta sola, da un superuser.
//
// PERCHE' NON STA NELLA MIGRATION 011. `metamc_migrate` possiede lo schema ma
// non ha CREATEROLE: CREATE ROLE, GRANT di appartenenza e `ALTER ROLE ... SET`
// sono operazioni di CLUSTER, non di schema. Metterle nella migration
// significa che il rilascio fallisce con «permission denied to create role» a
// meta' file — cioe' nel momento peggiore. La 011 quindi li PRETENDE e si
// ferma con un messaggio esplicito se mancano.
//
// E' la stessa divisione che la fase 1 fa con le password (nota in
// migrations/001): quello che riguarda il cluster non entra in un file
// committato e non passa dal ruolo delle migration.
//
// I ruoli nascono SENZA password. Con scram-sha-256 un ruolo senza password
// non puo' autenticarsi: il default e' chiuso, e le credenziali si assegnano
// dopo, fuori dal repository.
//
// Uso:
//   node scripts/create-stats-roles.ts --print
//       stampa l'SQL e non tocca niente: da incollare in una sessione psql
//       gia' aperta come superuser.
//
//   DATABASE_SUPERUSER_URL=postgres://postgres:...@host:5432/metamc \
//     node scripts/create-stats-roles.ts
//       lo esegue.

import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * I timeout stanno sul RUOLO e non sul pool.
 *
 * Un pool li imposta per le sue connessioni; il ruolo li impone anche a chi
 * entra con psql per indagare. E' li' che servono davvero: la query di
 * diagnostica scritta di corsa alle 23 su una tabella partizionata e' lo
 * scenario in cui qualcuno tiene un lock per dieci minuti.
 */
export const STATS_ROLES_SQL = `
-- Gruppo: porta i privilegi, non fa login.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metamc_stats_rw') THEN
    CREATE ROLE metamc_stats_rw NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metamc_ingest') THEN
    CREATE ROLE metamc_ingest LOGIN INHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metamc_rollup') THEN
    CREATE ROLE metamc_rollup LOGIN INHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metamc_stats') THEN
    CREATE ROLE metamc_stats LOGIN INHERIT;
  END IF;
END $$;

GRANT metamc_stats_rw TO metamc_ingest, metamc_rollup;

-- L'ingest deve stare sotto il budget del ciclo: se una sua query dura piu'
-- del ciclo stesso, il campionamento successivo aspetta la connessione.
ALTER ROLE metamc_ingest SET statement_timeout = '5s';
ALTER ROLE metamc_ingest SET lock_timeout      = '1s';
ALTER ROLE metamc_ingest SET search_path       = stats, pg_catalog;

-- Il rollup puo' durare: aggrega, non serve nessuna richiesta.
ALTER ROLE metamc_rollup SET statement_timeout = '60s';
ALTER ROLE metamc_rollup SET lock_timeout      = '3s';
ALTER ROLE metamc_rollup SET search_path       = stats, pg_catalog;

-- Sola lettura imposta dal DATABASE, non dalla disciplina: un bug nel
-- percorso di lettura non puo' scrivere nemmeno volendo.
-- RUNBOOK: default_transaction_read_only blocca anche la manutenzione fatta
-- con queste credenziali. E' voluto. Il primo che ci sbatte perde mezz'ora.
ALTER ROLE metamc_stats SET statement_timeout            = '10s';
ALTER ROLE metamc_stats SET default_transaction_read_only = on;
ALTER ROLE metamc_stats SET enable_partitionwise_aggregate = on;
ALTER ROLE metamc_stats SET enable_partitionwise_join      = on;
ALTER ROLE metamc_stats SET search_path                    = stats, pg_catalog;
`;

export const STATS_ROLES = ['metamc_stats_rw', 'metamc_ingest', 'metamc_rollup', 'metamc_stats'] as const;

async function main(): Promise<void> {
  if (process.argv.includes('--print')) {
    console.log(STATS_ROLES_SQL.trim());
    return;
  }

  const url = process.env['DATABASE_SUPERUSER_URL'];
  if (!url) {
    console.error(
      'serve DATABASE_SUPERUSER_URL (un ruolo con CREATEROLE o superuser).\n' +
        "Per vedere l'SQL senza eseguirlo: node scripts/create-stats-roles.ts --print",
    );
    process.exitCode = 1;
    return;
  }

  const client = new pg.Client({ connectionString: url, application_name: 'metamc-stats-roles' });
  await client.connect();
  try {
    await client.query(STATS_ROLES_SQL);
    const res = await client.query<{ rolname: string; rolcanlogin: boolean }>(
      'SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname',
      [[...STATS_ROLES]],
    );
    for (const r of res.rows) {
      console.log(`  ${r.rolname}${r.rolcanlogin ? ' (login, senza password)' : ' (gruppo)'}`);
    }
    const mancanti = STATS_ROLES.filter((r) => !res.rows.some((row) => row.rolname === r));
    if (mancanti.length > 0) throw new Error(`ruoli non creati: ${mancanti.join(', ')}`);
    console.log('ruoli della fase 2 pronti. Ora: pnpm run migrate');
  } finally {
    await client.end();
  }
}

const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
