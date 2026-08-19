// Break-glass: emette un invito owner dalla riga di comando. §17.2, runbook §9
//
// PERCHE' ESISTE, dato che `bootstrap-owner` si rifiuta apposta di girare due
// volte. Quel rifiuto protegge da una cosa precisa: un comando che chiunque
// abbia una shell sull'applicazione possa usare per farsi owner. Questo
// comando non e' quello. Pretende `DATABASE_MIGRATE_URL`, cioe' il ruolo che
// POSSIEDE lo schema — e chi ha quelle credenziali puo' gia' inserire a mano
// una riga in `auth.invitation`, spegnere il trigger e concedersi qualunque
// cosa. Non aggiunge un potere: rende quel potere ripetibile senza sbagliare
// una query, e soprattutto lo lascia scritto nel registro, che una INSERT
// scritta a mano non farebbe.
//
// QUANDO SERVE DAVVERO. Il modo normale di invitare un owner e' il pannello.
// Questo comando serve quando nel pannello non entra piu' nessuno: unico
// owner con il secondo fattore perduto, oppure la policy dei due owner del
// §1.3 mai rispettata e la persona sola che se ne e' andata.
//
// COSA NON RISOLVE. Un owner in piu' non sblocca un 2FA perduto: il reset a
// quattro occhi del §8.8 vuole un richiedente e DUE approvatori distinti da
// lui, quindi per recuperare l'account A servono tre altri owner. Per quello
// restano i recovery code o l'intervento diretto sul database.
//
// Uso:
//   DATABASE_MIGRATE_URL=... APP_ORIGIN=https://admin.metamc.it \
//     node scripts/invite-owner.ts --break-glass owner2@metamc.it "Nome Cognome"

import { sql } from 'kysely';
import { AUDIT_ACTIONS } from '#src/audit/actions.ts';
import { writeAudit } from '#src/audit/log.ts';
import { createKysely, createPool } from '#src/db/pool.ts';
import { insertInvite } from '#src/invites/service.ts';

/** Come il bootstrap: il link nasce su un terminale e si usa nei minuti dopo. */
const TTL_HOURS = 1;

/**
 * L'identita' tecnica a cui e' attribuito l'invito.
 *
 * NON e' l'owner esistente, e non e' l'utente di bootstrap. `invited_by` e'
 * NOT NULL e finisce nel registro accanto a «chi ha fatto entrare chi»:
 * attribuire questo invito a una persona direbbe che l'ha emesso lei dal
 * pannello, che e' falso. Una riga a se' dice la verita' — e' stato emesso da
 * fuori, da chi ha le chiavi del database.
 */
const BREAK_GLASS_ID = 'breakglass00000000000000000000';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const confirmed = args.includes('--break-glass');
  const rest = args.filter((a) => a !== '--break-glass');
  const email = rest[0];
  const displayName = rest[1] ?? 'Owner';

  if (!confirmed) {
    console.error(
      'Questo comando emette un invito OWNER fuori dal pannello.\n' +
        'Se e` davvero cio` che vuoi, ripetilo con --break-glass:\n' +
        '  node scripts/invite-owner.ts --break-glass <email> ["Nome Cognome"]',
    );
    process.exit(2);
  }
  if (!email?.includes('@')) {
    console.error('uso: node scripts/invite-owner.ts --break-glass <email> ["Nome Cognome"]');
    process.exit(2);
  }

  // Solo il ruolo proprietario: disabilitare un trigger richiede la
  // proprieta' della tabella, e metamc_app non ce l'ha ne' deve averla.
  const url = process.env.DATABASE_MIGRATE_URL;
  if (!url) {
    console.error(
      'DATABASE_MIGRATE_URL non impostata.\n' +
        'Serve il ruolo metamc_migrate: e` il confine che rende questo comando\n' +
        'non piu` potente di chi possiede gia` il database.',
    );
    process.exit(2);
  }

  const appOrigin = process.env.APP_ORIGIN ?? 'https://admin.metamc.it';
  const pool = createPool({ connectionString: url, max: 2, applicationName: 'metamc-invite-owner' });
  const db = createKysely(pool);

  try {
    const ownerRole = await db
      .selectFrom('auth.roles')
      .select(['id'])
      .where('key', '=', 'owner')
      .executeTakeFirst();
    if (!ownerRole) {
      console.error('il ruolo owner non esiste: eseguire prima le migration.');
      process.exit(1);
    }

    const existing = await db
      .selectFrom('auth.user as u')
      .innerJoin('auth.user_roles as ur', 'ur.user_id', 'u.id')
      .select('u.email')
      .where('ur.role_id', '=', ownerRole.id)
      .where('u.deleted_at', 'is', null)
      .execute();

    // Il vincolo `invitation_one_pending_per_email` e la riga utente esistente
    // fermerebbero comunque l'inserimento, ma con uno stack di Kysely. Chi
    // esegue questo comando lo sta facendo perche' e' chiuso fuori: merita di
    // sapere che cosa fare, non da dove e' saltata l'eccezione.
    const target = email.trim().toLowerCase();

    const alreadyUser = await db
      .selectFrom('auth.user')
      .select(['id', 'status'])
      // L'indirizzo resta un PARAMETRO: `sql.lit` lo cucirebbe dentro la
      // query, e questo comando prende argomenti da una riga di shell.
      .where(sql<boolean>`lower(email) = ${target}`)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (alreadyUser) {
      console.error(
        `esiste gia\` un account per ${target} (stato: ${alreadyUser.status}).\n` +
          "Un invito non servirebbe: l'accettazione lo rifiuterebbe. Se quell'account\n" +
          'e` la persona che deve diventare owner, concedile il ruolo dal pannello.',
      );
      process.exit(1);
    }

    const alreadyPending = await db
      .selectFrom('auth.invitation')
      .select(['id', 'expires_at'])
      .where('email_lower', '=', target)
      .where('consumed_at', 'is', null)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (alreadyPending) {
      console.error(
        `esiste gia\` un invito in attesa per ${target}, valido fino al ` +
          `${alreadyPending.expires_at.toISOString()}.\n` +
          'Il token di quell`invito non e` recuperabile: in tabella c`e` solo il suo hash.\n' +
          'Per emetterne uno nuovo, revoca prima quello vecchio:\n' +
          `  UPDATE auth.invitation SET revoked_at = now() WHERE id = '${alreadyPending.id}';`,
      );
      process.exit(1);
    }

    const invite = await db.transaction().execute(async (trx) => {
      // SEC-09 vieta a runtime gli inviti verso un ruolo di sistema, ed e'
      // giusto: nel pannello nessuno deve poter fabbricare un owner. Qui il
      // trigger si spegne per il tempo di una riga, come nel bootstrap.
      await sql`ALTER TABLE auth.invitation DISABLE TRIGGER t_invitation_no_system_role`.execute(trx);

      await trx
        .insertInto('auth.user')
        .values({
          id: BREAK_GLASS_ID,
          name: 'Break-glass',
          email: `breakglass+${Date.now()}@invalid.local`,
          emailVerified: false,
          status: 'disabled',
          banned: true,
          ban_reason: 'identita` tecnica per gli inviti fuori dal pannello: non e` una persona',
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();

      const created = await insertInvite(trx, {
        emailLower: email.trim().toLowerCase(),
        displayName,
        roleId: ownerRole.id,
        invitedBy: BREAK_GLASS_ID,
        now: new Date(),
      });

      await trx
        .updateTable('auth.invitation')
        .set({ expires_at: new Date(Date.now() + TTL_HOURS * 3600_000) })
        .where('id', '=', created.id)
        .execute();

      await sql`ALTER TABLE auth.invitation ENABLE TRIGGER t_invitation_no_system_role`.execute(trx);

      return created;
    });

    // Fuori dal pannello ma DENTRO il registro: e' la differenza fra questo
    // comando e la stessa INSERT scritta a mano in psql.
    await writeAudit(db, {
      action: AUDIT_ACTIONS.breakGlassOwnerInvite,
      outcome: 'success',
      actor: { userId: null, email: null, displayName: 'break-glass', sessionId: null },
      request: { requestId: null, ip: null, socketIp: null, userAgent: 'scripts/invite-owner.ts' },
      targetType: 'invitation',
      targetId: invite.id,
      targetLabel: email,
      meta: { displayName, ttlOre: TTL_HOURS, ownerGiaEsistenti: existing.length },
    });

    console.log('');
    console.log('  Invito owner creato FUORI dal pannello. Il link vale UN`ORA, una volta sola.');
    console.log('');
    console.log(`  ${appOrigin}/accept?t=${invite.token}`);
    console.log('');
    console.log('  Il token non e` salvato: in tabella c`e` solo il suo SHA-256. Se lo perdi,');
    console.log('  cancella la riga di invito ed esegui di nuovo il comando.');
    console.log('');
    console.log(`  Owner attivi prima di questo invito: ${existing.length}.`);
    console.log('  La riga nel registro dice che e` stato emesso da fuori: e` voluto, non');
    console.log('  cancellarla. Chi legge fra sei mesi deve poterlo distinguere da un');
    console.log('  invito normale.');
    console.log('');
  } finally {
    await db.destroy();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
