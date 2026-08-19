// Job operativi. §10, §8.3, §17
//
// Uno script solo, con un sottocomando per lavoro: sono tutti piccoli, girano
// tutti sullo stesso pool, e tenerli insieme evita quattro file che divergono.
//
// Uso (cron sul VPS):
//   node scripts/maintenance.ts anchor          # giornaliero
//   node scripts/maintenance.ts partitions      # a mano: normalmente lo fa l'app
//   node scripts/maintenance.ts cleanup         # giornaliero
//   node scripts/maintenance.ts verify          # ogni ora

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { buildAnchors, markAnchored, verifyRecent } from '#src/audit/integrity.ts';
import { deriveKeys } from '#src/crypto/keys.ts';
import { createKysely, createPool, type Database } from '#src/db/pool.ts';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} non impostata.`);
    process.exit(2);
  }
  return value;
}

/**
 * §10 — ancoraggio esterno.
 *
 * Scrive l'hash di testa di ogni partizione, firmato, in un file destinato a
 * uno storage append-only fuori dal database. Se l'ancoraggio vivesse nello
 * stesso database che deve verificare, chi può riscrivere l'uno può riscrivere
 * l'altro.
 */
async function anchor(db: Database): Promise<void> {
  const keys = deriveKeys(Buffer.from(requireEnv('MASTER_KEY'), 'hex'));
  const anchors = await buildAnchors(db, keys.auditAnchor);
  if (anchors.length === 0) {
    console.log('nessuna partizione da ancorare.');
    return;
  }

  const destination = process.env.AUDIT_ANCHOR_PATH ?? './audit-anchor.jsonl';
  const lines = anchors.map((a) => JSON.stringify(a)).join('\n');
  writeFileSync(destination, `${lines}\n`, { flag: 'a' });

  await markAnchored(
    db,
    anchors.map((a) => a.partitionKey),
  );

  console.log(`${anchors.length} partizioni ancorate in ${destination}.`);
  console.log('Ricorda: il file va copiato su uno storage append-only fuori da questa macchina.');
}

/**
 * §17 — partizioni dell'audit log.
 *
 * Se finiscono, OGNI insert di audit fallisce; e siccome l'audit sta nella
 * stessa transazione delle modifiche di stato, falliscono anche quelle. Il
 * pannello si blocca in scrittura. Questo job tiene sempre 12 mesi di margine.
 */
async function partitions(db: Database): Promise<void> {
  const created: string[] = [];
  for (let m = 0; m <= 12; m += 1) {
    const target = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + m, 1));
    const res = await sql<{ create_month_partition: string }>`
      SELECT audit.create_month_partition(${target.toISOString().slice(0, 10)}::date)
    `.execute(db);
    const name = res.rows[0]?.create_month_partition;
    if (name) created.push(name);
  }
  console.log(`partizioni garantite fino a 12 mesi: ${created.length} verificate/create.`);
}

/**
 * §8.3 — enrollment TOTP mai confermati.
 *
 * Una riga `twoFactor` di un utente rimasto `pending_onboarding` è un segreto
 * TOTP valido che nessuno ha mai usato: dopo 24 ore va via.
 */
async function cleanup(db: Database): Promise<void> {
  const soglia = new Date(Date.now() - 24 * 3600_000);

  const abandoned = await db
    .deleteFrom('auth.twoFactor')
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('auth.user as u')
          .select('u.id')
          .whereRef('u.id', '=', 'auth.twoFactor.userId')
          .where('u.status', '=', 'pending_onboarding')
          .where('u.createdAt', '<', soglia),
      ),
    )
    .returning('id')
    .execute();

  // Token di verifica scaduti: reset password e cambio email. Non sono
  // pericolosi (la scadenza è nella WHERE di ogni consumo), ma non servono.
  const expired = await db
    .deleteFrom('auth.verification')
    .where('expiresAt', '<', new Date())
    .returning('id')
    .execute();

  console.log(`enrollment abbandonati rimossi: ${abandoned.length}; token scaduti: ${expired.length}.`);
}

/**
 * §10 — verifica dell'integrità. Esce con codice 1 se la catena non torna,
 * così un cron che fallisce diventa un allarme senza codice aggiuntivo.
 */
async function verify(db: Database): Promise<void> {
  const verdicts = await verifyRecent(db);
  let broken = false;
  for (const v of verdicts) {
    console.log(
      `${v.partitionKey}: ${v.ok ? 'ok' : 'COMPROMESSA'} (${v.rowsChecked} righe)${v.detail ? ` — ${v.detail}` : ''}`,
    );
    if (!v.ok) broken = true;
  }
  if (broken) process.exit(1);
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
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
