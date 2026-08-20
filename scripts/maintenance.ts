// Lancio a mano dei lavori periodici. §8.3, §10, §17
//
// A REGIME NON SERVE: i quattro lavori li tiene l'applicazione, in
// `src/jobs/keeper.ts`, e partono con il server. Questo script resta come modo
// di forzarne uno subito — quando si sta indagando e non si vuole aspettare il
// giro successivo, o quando si vuole vedere l'esito su un terminale invece che
// nei log.
//
// I corpi stanno in `src/jobs/maintenance-jobs.ts`, condivisi con lo
// scheduler: due copie della stessa logica avrebbero significato che quella
// eseguita a mano e quella eseguita da sola divergono, e la divergenza si
// scopre nel momento peggiore.
//
// Uso:
//   node scripts/maintenance.ts anchor
//   node scripts/maintenance.ts partitions
//   node scripts/maintenance.ts cleanup
//   node scripts/maintenance.ts verify

import { fileURLToPath } from 'node:url';
import { ensurePartitions } from '#src/audit/partitions.ts';
import { deriveKeys } from '#src/crypto/keys.ts';
import { createKysely, createPool, type Database } from '#src/db/pool.ts';
import { anchorHeads, cleanupAbandoned, verifyChain } from '#src/jobs/maintenance-jobs.ts';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} non impostata.`);
    process.exit(2);
  }
  return value;
}

async function anchor(db: Database): Promise<void> {
  const keys = deriveKeys(Buffer.from(requireEnv('MASTER_KEY'), 'hex'));
  const destination = process.env.AUDIT_ANCHOR_PATH ?? './audit-anchor.jsonl';
  const { anchored } = await anchorHeads(db, keys.auditAnchor, destination);

  if (anchored === 0) {
    console.log('nessuna partizione da ancorare.');
    return;
  }
  console.log(`${anchored} partizioni ancorate in ${destination}.`);
  console.log('Ricorda: il file va copiato su uno storage append-only fuori da questa macchina.');
}

async function partitions(db: Database): Promise<void> {
  const names = await ensurePartitions(db);
  console.log(`partizioni garantite fino a 12 mesi: ${names.length} verificate/create.`);
}

async function cleanup(db: Database): Promise<void> {
  const { enrollments, verifications } = await cleanupAbandoned(db);
  console.log(`enrollment abbandonati rimossi: ${enrollments}; token scaduti: ${verifications}.`);
}

/**
 * Esce con codice 1 se la catena non torna, cosi' anche lanciato a mano
 * l'esito e' leggibile da uno script chiamante senza interpretare il testo.
 */
async function verify(db: Database): Promise<void> {
  const report = await verifyChain(db);
  console.log(`partizioni verificate: ${report.checked}.`);
  for (const b of report.broken) {
    console.log(`${b.partitionKey}: COMPROMESSA${b.detail ? ` — ${b.detail}` : ''}`);
  }
  if (!report.ok) process.exit(1);
  console.log('catena integra.');
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL non impostata.');
    process.exit(2);
  }

  const pool = createPool({
    connectionString: url,
    max: 2,
    applicationName: 'metamc-maintenance',
    // I job non hanno il vincolo dei 2s del percorso di richiesta: creare
    // dodici partizioni o verificare tre mesi di catena richiede di più.
    statementTimeout: '60s',
  });
  const db = createKysely(pool);

  try {
    switch (command) {
      case 'anchor':
        await anchor(db);
        break;
      case 'partitions':
        await partitions(db);
        break;
      case 'cleanup':
        await cleanup(db);
        break;
      case 'verify':
        await verify(db);
        break;
      default:
        console.error('comandi: anchor | partitions | cleanup | verify');
        process.exit(2);
    }
  } finally {
    await db.destroy();
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
