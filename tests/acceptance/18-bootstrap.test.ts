// Bootstrap del primo owner, end to end. §17.2
//
// Non è nella lista dei 17 del §14, e questo è esattamente il motivo per cui è
// sfuggito: il §14 verifica le proprietà di sicurezza, non che il sistema si
// riesca a installare. La prima volta che il pannello è stato avviato davvero,
// il primo owner non riusciva ad accettare il proprio invito — il trigger di
// SEC-09 scattava anche sull'UPDATE che consuma.
//
// Questo test percorre bootstrap → apertura del link → accettazione →
// enrollment TOTP → primo accesso da owner. È l'unico percorso in cui una riga
// `invitation` con un `role_id` di sistema esiste legittimamente.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MODULES } from '#src/authz/modules.ts';
import { insertInvite } from '#src/invites/service.ts';
import { sameOriginHeaders, startTestApp, type TestApp } from '#tests/support/app.ts';
import { connect } from '#tests/support/postgres.ts';
import { secretFromOtpauthUri, totpNow } from '#tests/support/totp.ts';

let t: TestApp;

beforeAll(async () => {
  t = await startTestApp({ label: 'bootstrap' });
}, 180_000);

afterAll(async () => {
  await t?.close();
});

function cookies(setCookie: string | string[] | undefined): Record<string, string> {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const out: Record<string, string> = {};
  for (const c of list) {
    const pair = c.split(';')[0];
    if (!pair) continue;
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return out;
}
const header = (m: Record<string, string>) =>
  Object.entries(m)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

/**
 * Riproduce cio' che fa scripts/bootstrap-owner.ts: un invito verso il ruolo
 * `owner`, emesso disattivando il trigger — l'unico punto del sistema in cui
 * questo e' lecito, perche' e' installazione e non runtime.
 */
async function bootstrapOwnerInvite(email: string): Promise<string> {
  const ownerRole = await t.ctx.db
    .selectFrom('auth.roles')
    .select(['id'])
    .where('key', '=', 'owner')
    .executeTakeFirstOrThrow();

  const bootstrapId = 'bootstrap0000000000000000000000';
  await t.ctx.db
    .insertInto('auth.user')
    .values({
      id: bootstrapId,
      name: 'Bootstrap',
      email: `bootstrap+${Date.now()}@invalid.local`,
      emailVerified: false,
      status: 'disabled',
      banned: true,
      ban_reason: 'utente tecnico di bootstrap',
    })
    .execute();

  // Il trigger va disattivato, e serve il ruolo che POSSIEDE la tabella: come
  // fa lo script vero. `metamc_app` non puo' e non deve poterlo fare — SEC-09
  // vale per il runtime, non per l'installazione.
  const owner = await connect(t.db.migrateUrl, 'metamc-bootstrap-test');
  try {
    await owner.query('ALTER TABLE auth.invitation DISABLE TRIGGER t_invitation_no_system_role');
    return await t.ctx.db.transaction().execute(async (trx) => {
      const invite = await insertInvite(trx, {
        emailLower: email,
        displayName: 'Owner',
        roleId: ownerRole.id,
        invitedBy: bootstrapId,
      });
      return invite.token;
    });
  } finally {
    await owner
      .query('ALTER TABLE auth.invitation ENABLE TRIGGER t_invitation_no_system_role')
      .catch(() => undefined);
    await owner.end().catch(() => undefined);
  }
}

describe('§17.2 — il primo owner riesce a installare il sistema', () => {
  it("l'invito owner NON è emettibile dal percorso applicativo (SEC-09)", async () => {
    const ownerRole = await t.ctx.db
      .selectFrom('auth.roles')
      .select(['id'])
      .where('key', '=', 'owner')
      .executeTakeFirstOrThrow();

    // La difesa resta intera: e' il trigger, non solo l'handler.
    await expect(
      t.ctx.db
        .insertInto('auth.invitation')
        .values({
          email_lower: 'tentativo@metamc.it',
          display_name: 'Tentativo',
          token_hash: Buffer.alloc(32, 3),
          role_id: ownerRole.id,
          invited_by: 'bootstrap0000000000000000000001',
          expires_at: new Date(Date.now() + 3600_000),
        })
        .execute(),
    ).rejects.toThrow(/ruolo di sistema/i);
  });

  it('un invito pendente non si può PROMUOVERE a owner cambiandogli il ruolo', async () => {
    const inviter = 'bootstrap0000000000000000000002';
    await t.ctx.db
      .insertInto('auth.user')
      .values({ id: inviter, name: 'x', email: `x${Date.now()}@metamc.it`, emailVerified: true })
      .execute();
    const moderator = await t.ctx.db
      .selectFrom('auth.roles')
      .select('id')
      .where('key', '=', 'moderatore')
      .executeTakeFirstOrThrow();
    const owner = await t.ctx.db
      .selectFrom('auth.roles')
      .select('id')
      .where('key', '=', 'owner')
      .executeTakeFirstOrThrow();

    const row = await t.ctx.db
      .insertInto('auth.invitation')
      .values({
        email_lower: 'promozione@metamc.it',
        display_name: 'Promozione',
        token_hash: Buffer.alloc(32, 4),
        role_id: moderator.id,
        invited_by: inviter,
        expires_at: new Date(Date.now() + 3600_000),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    // È il caso che `UPDATE OF role_id` continua a coprire: senza, si
    // aggirerebbe SEC-09 in due mosse invece che in una.
    await expect(
      t.ctx.db.updateTable('auth.invitation').set({ role_id: owner.id }).where('id', '=', row.id).execute(),
    ).rejects.toThrow(/ruolo di sistema/i);
  });

  it('il primo owner accetta il proprio invito e arriva dentro con tutti i moduli', async () => {
    const email = 'primo.owner@metamc.it';
    const token = await bootstrapOwnerInvite(email);

    // 1. apertura del link
    const opened = await t.app.inject({ method: 'GET', url: `/accept?t=${token}` });
    expect(opened.statusCode).toBe(302);
    expect(opened.headers.location).toBe('/accept');
    const onboarding = cookies(opened.headers['set-cookie'])['__Host-metamc_onboarding'];
    expect(onboarding).toBeDefined();

    // Il cookie __Host- DEVE avere Secure: senza, il browser lo scarta in
    // silenzio e il flusso si rompe senza un errore da nessuna parte.
    const raw = opened.headers['set-cookie'];
    const list = Array.isArray(raw) ? raw : [raw ?? ''];
    const cookieLine = list.find((c) => c.startsWith('__Host-metamc_onboarding='));
    expect(cookieLine).toContain('Secure');

    // 2. la pagina sa chi è e con che ruolo
    const info = await t.app.inject({
      method: 'GET',
      url: '/api/invites/onboarding',
      headers: { cookie: `__Host-metamc_onboarding=${onboarding}` },
    });
    expect(info.statusCode).toBe(200);
    expect(info.json()).toMatchObject({ email, roleName: 'Owner' });

    // 3. accettazione: è il passo che falliva
    const accepted = await t.app.inject({
      method: 'POST',
      url: '/api/invites/accept',
      headers: sameOriginHeaders({ cookie: `__Host-metamc_onboarding=${onboarding}` }),
      payload: { password: 'password-del-primo-owner' },
    });
    expect(accepted.statusCode).toBe(201);

    const body = accepted.json() as { userId: string; totpURI: string };
    expect(body.totpURI).toBeTruthy();
    const secret = secretFromOtpauthUri(body.totpURI);

    let jar = cookies(accepted.headers['set-cookie']);
    if (onboarding) jar['__Host-metamc_onboarding'] = onboarding;

    // 4. enrollment TOTP completato
    const completed = await t.app.inject({
      method: 'POST',
      url: '/api/invites/complete',
      headers: sameOriginHeaders({
        cookie: header(jar),
        'x-csrf-token': jar['__Host-metamc_csrf'] ?? '',
      }),
      payload: { code: totpNow(secret) },
    });
    expect(completed.statusCode).toBe(200);

    const result = completed.json() as { recoveryCodes: string[] };
    expect(result.recoveryCodes).toHaveLength(10);

    jar = { ...jar, ...cookies(completed.headers['set-cookie']) };

    // 5. dentro, con il ruolo owner e tutti e otto i moduli
    const me = await t.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: header(jar) },
    });
    expect(me.statusCode).toBe(200);
    const identity = me.json() as { modules: string[]; permissions: Record<string, number> };
    expect(identity.modules).toHaveLength(MODULES.length);
    expect(Object.values(identity.permissions).every((l) => l === 3)).toBe(true);

    // 6. l'invito è consumato e legato alla persona giusta
    const invite = await t.ctx.db
      .selectFrom('auth.invitation')
      .select(['consumed_at', 'consumed_user_id'])
      .where('email_lower', '=', email)
      .executeTakeFirstOrThrow();
    expect(invite.consumed_at).not.toBeNull();
    expect(invite.consumed_user_id).toBe(body.userId);

    // 7. SEC-14 — i backup code del plugin sono stati sovrascritti
    const twoFactor = await t.ctx.db
      .selectFrom('auth.twoFactor')
      .select('backupCodes')
      .where('userId', '=', body.userId)
      .executeTakeFirstOrThrow();
    for (const code of result.recoveryCodes) {
      expect(twoFactor.backupCodes).not.toContain(code.replace(/-/g, ''));
    }
  });
});
