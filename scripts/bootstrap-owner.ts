// §17.2 — bootstrap del primo owner.
//
// NON e' un endpoint e NON e' un seed committato con credenziali: e' un
// comando che gira una volta sola, fallisce se esiste gia' un utente, e
// stampa il link su stdout. Un endpoint di bootstrap e' una porta che resta
// aperta anche dopo essere servita; un seed committato mette una credenziale
// nella storia di git per sempre.
//
// TTL 1 ora, non 72: il link nasce sul terminale di chi sta installando il
// sistema, e viene usato nei minuti successivi.
//
// Uso:
//   DATABASE_URL=... node scripts/bootstrap-owner.ts owner@metamc.it "Nome Cognome"

import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { AUDIT_ACTIONS } from '#src/audit/actions.ts';
import { writeAudit } from '#src/audit/log.ts';
import { createKysely, createPool } from '#src/db/pool.ts';
import { insertInvite } from '#src/invites/service.ts';

const BOOTSTRAP_TTL_HOURS = 1;

async function main(): Promise<void> {
  const email = process.argv[2];
  const displayName = process.argv[3] ?? 'Owner';
  // Serve il ruolo che POSSIEDE le tabelle: disabilitare un trigger richiede
  // la proprieta', e metamc_app non ce l'ha ne' deve averla.
  const url = process.env.DATABASE_MIGRATE_URL ?? process.env.DATABASE_URL;

  if (!email?.includes('@')) {
    console.error('uso: node scripts/bootstrap-owner.ts <email> ["Nome Cognome"]');
    process.exit(2);
  }
  if (!url) {
    console.error('DATABASE_MIGRATE_URL non impostata (serve il ruolo metamc_migrate).');
    process.exit(2);
  }

  const appOrigin = process.env.APP_ORIGIN ?? 'https://admin.metamc.it';
  const pool = createPool({ connectionString: url, max: 2, applicationName: 'metamc-bootstrap' });
  const db = createKysely(pool);

  try {
    // Il comando gira UNA volta sola. Se esiste gia' un utente, il sistema e'
    // stato inizializzato e questo comando diventerebbe una backdoor.
    const existing = await db.selectFrom('auth.user').select('id').limit(1).executeTakeFirst();
    if (existing) {
      console.error(
        'esiste gia` almeno un utente: il bootstrap non si esegue due volte.\n' +
          'Per aggiungere un owner si usa la procedura a quattro occhi del §8.8.',
      );
      process.exit(1);
    }

    const ownerRole = await db
      .selectFrom('auth.roles')
      .select(['id', 'key'])
      .where('key', '=', 'owner')
      .executeTakeFirst();
    if (!ownerRole) {
      console.error('il ruolo owner non esiste: eseguire prima le migration.');
      process.exit(1);
    }

    // L'invite owner e' l'UNICO che puo' puntare a un ruolo di sistema, e
    // passa dal ruolo metamc_migrate perche' il trigger
    // t_invitation_no_system_role vieta la cosa a runtime — SEC-09 vale per
    // l'applicazione, non per l'installazione.
    const result = await db.transaction().execute(async (trx) => {
      await sql`ALTER TABLE auth.invitation DISABLE TRIGGER t_invitation_no_system_role`.execute(trx);

      // Serve un `invited_by` reale per la FK: il primo owner invita se
      // stesso, e la riga utente nasce qui con lo stato piu' chiuso possibile.
      const bootstrapId = 'bootstrap0000000000000000000000';
      await trx
        .insertInto('auth.user')
        .values({
          id: bootstrapId,
          name: 'Bootstrap',
          email: `bootstrap+${Date.now()}@invalid.local`,
          emailVerified: false,
          status: 'disabled',
          banned: true,
          ban_reason: 'utente tecnico di bootstrap: non e` una persona',
        })
        .execute();

      const invite = await insertInvite(trx, {
        emailLower: email.trim().toLowerCase(),
        // Il nome era gia' un argomento del comando: prima finiva solo nel
        // registro, ora e' anche il nome con cui l'owner comparira'.
        displayName,
        roleId: ownerRole.id,
        invitedBy: bootstrapId,
        now: new Date(),
      });

      await trx
        .updateTable('auth.invitation')
        .set({ expires_at: new Date(Date.now() + BOOTSTRAP_TTL_HOURS * 3600_000) })
        .where('id', '=', invite.id)
        .execute();

      await sql`ALTER TABLE auth.invitation ENABLE TRIGGER t_invitation_no_system_role`.execute(trx);

      return invite;
    });

    await writeAudit(db, {
      action: AUDIT_ACTIONS.bootstrapOwner,
      outcome: 'success',
      actor: { userId: null, email: null, displayName: 'bootstrap', sessionId: null },
      request: { requestId: null, ip: null, socketIp: null, userAgent: 'scripts/bootstrap-owner.ts' },
      targetType: 'invitation',
      targetId: result.id,
      targetLabel: email,
      meta: { displayName, ttlOre: BOOTSTRAP_TTL_HOURS },
    });

    console.log('');
    console.log('  Invito owner creato. Il link vale UN`ORA e funziona una volta sola.');
    console.log('');
    console.log(`  ${appOrigin}/accept?t=${result.token}`);
    console.log('');
    console.log('  Il token non e` salvato da nessuna parte: in tabella c`e` solo il suo SHA-256.');
    console.log('  Se lo perdi, cancella la riga di invito ed esegui di nuovo il comando.');
    console.log('');
    console.log('  Ricorda: la policy vuole DUE owner (§1.3). Il secondo va invitato subito,');
    console.log('  altrimenti la procedura di reset 2FA a quattro occhi non esiste.');
    console.log('');
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
