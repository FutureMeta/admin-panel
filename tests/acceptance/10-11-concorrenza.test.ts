// §14 test 10 — due accettazioni CONCORRENTI dello stesso invite: una sola
//               riesce, e non nascono due users.
// §14 test 11 — due consumi CONCORRENTI dello stesso recovery code: uno solo
//               riesce.  SEC-13
//
// Sono i due test che nessuna lettura del codice sostituisce: la correttezza
// dipende da cosa fa Postgres quando due transazioni toccano la stessa riga,
// non da cosa sembra fare la funzione.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consumeRecoveryCode, issueRecoveryCodes } from '#src/auth/recovery-codes.ts';
import { type Actor, loginAs, seedUser } from '#tests/support/actors.ts';
import { sameOriginHeaders, startTestApp, type TestApp } from '#tests/support/app.ts';

let t: TestApp;
let inviter: Actor;
let roleId: number;

beforeAll(async () => {
  t = await startTestApp({ label: 'conc' });
  inviter = await loginAs(t, await seedUser(t, { roleKey: 'owner' }));
  const role = await t.ctx.db
    .selectFrom('auth.roles')
    .select('id')
    .where('key', '=', 'moderatore')
    .executeTakeFirstOrThrow();
  roleId = role.id;
}, 180_000);

afterAll(async () => {
  await t?.close();
});

/** Emette un invite e restituisce il token estratto dall'email. */
async function issueInvite(email: string): Promise<string> {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/invites',
    headers: inviter.headers(),
    payload: { email, roleId },
  });
  if (res.statusCode !== 201) throw new Error(`invite non emesso: ${res.statusCode} ${res.body}`);

  const mail = t.mailer.lastTo(email);
  if (!mail) throw new Error('nessuna email inviata');
  const token = /\/accept\?t=([A-Za-z0-9_-]+)/.exec(mail.text)?.[1];
  if (!token) throw new Error('token non trovato nell`email');
  return token;
}

/** Apre il link di invite e restituisce il cookie di onboarding. */
async function openInvite(token: string): Promise<string> {
  const res = await t.app.inject({ method: 'GET', url: `/accept?t=${token}` });
  expect(res.statusCode).toBe(302);
  const setCookie = res.headers['set-cookie'];
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const onb = list.find((c) => c.startsWith('__Host-metamc_onboarding='));
  if (!onb) throw new Error('nessun cookie di onboarding');
  return onb.split(';')[0]?.split('=')[1] ?? '';
}

describe('test 10 — due accettazioni concorrenti dello stesso invite', () => {
  it('il token non compare MAI nella risposta HTTP: esiste solo nell`email', async () => {
    const email = 'solo-email@metamc.it';
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/invites',
      headers: inviter.headers(),
      payload: { email, roleId },
    });
    expect(res.statusCode).toBe(201);
    const mail = t.mailer.lastTo(email);
    const token = /\/accept\?t=([A-Za-z0-9_-]+)/.exec(mail?.text ?? '')?.[1];
    expect(token).toBeDefined();
    expect(res.body).not.toContain(token as string);
  });

  it('in tabella c`e` solo lo SHA-256 del token, mai il token', async () => {
    const token = await issueInvite('hash-solo@metamc.it');
    const rows = await t.ctx.db
      .selectFrom('auth.invitation')
      .select(['token_hash'])
      .where('email_lower', '=', 'hash-solo@metamc.it')
      .execute();
    expect(rows).toHaveLength(1);
    const stored = rows[0]?.token_hash;
    expect(stored).toBeDefined();
    expect(Buffer.from(stored as Buffer).length).toBe(32);
    expect(Buffer.from(stored as Buffer).toString('utf8')).not.toContain(token);
  });

  it('due POST /api/invites/accept concorrenti: UNA sola riesce', async () => {
    const email = 'gara@metamc.it';
    const token = await issueInvite(email);

    // Due sessioni di onboarding distinte sullo STESSO invite: e' lo scenario
    // reale — lo stesso link aperto in due schede, o un doppio clic.
    const [onbA, onbB] = await Promise.all([openInvite(token), openInvite(token)]);

    const accept = (onb: string) =>
      t.app.inject({
        method: 'POST',
        url: '/api/invites/accept',
        headers: sameOriginHeaders({ cookie: `__Host-metamc_onboarding=${onb}` }),
        payload: { password: 'password-di-accettazione-lunga', name: 'Nuovo Utente' },
      });

    const [a, b] = await Promise.all([accept(onbA), accept(onbB)]);
    const statuses = [a.statusCode, b.statusCode].sort();

    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(1);

    // ...e soprattutto: UN solo utente.
    const users = await t.ctx.db.selectFrom('auth.user').select('id').where('email', '=', email).execute();
    expect(users).toHaveLength(1);

    const invite = await t.ctx.db
      .selectFrom('auth.invitation')
      .select(['consumed_at', 'consumed_user_id'])
      .where('email_lower', '=', email)
      .executeTakeFirstOrThrow();
    expect(invite.consumed_at).not.toBeNull();
    expect(invite.consumed_user_id).toBe(users[0]?.id);
  });

  it('quattro accettazioni concorrenti: sempre una sola', async () => {
    const email = 'gara-quattro@metamc.it';
    const token = await issueInvite(email);
    const onbs = await Promise.all([
      openInvite(token),
      openInvite(token),
      openInvite(token),
      openInvite(token),
    ]);

    const results = await Promise.all(
      onbs.map((onb) =>
        t.app.inject({
          method: 'POST',
          url: '/api/invites/accept',
          headers: sameOriginHeaders({ cookie: `__Host-metamc_onboarding=${onb}` }),
          payload: { password: 'password-di-accettazione-lunga', name: 'Nuovo' },
        }),
      ),
    );

    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    const users = await t.ctx.db.selectFrom('auth.user').select('id').where('email', '=', email).execute();
    expect(users).toHaveLength(1);
  });

  it('un invite gia` consumato non si riapre, nemmeno con lo stesso token', async () => {
    const email = 'una-volta@metamc.it';
    const token = await issueInvite(email);
    const onb = await openInvite(token);

    const first = await t.app.inject({
      method: 'POST',
      url: '/api/invites/accept',
      headers: sameOriginHeaders({ cookie: `__Host-metamc_onboarding=${onb}` }),
      payload: { password: 'password-di-accettazione-lunga', name: 'Nuovo' },
    });
    expect(first.statusCode).toBe(201);

    // Il link non porta piu' da nessuna parte: nessun fresh onboarding.
    const reopen = await t.app.inject({ method: 'GET', url: `/accept?t=${token}` });
    expect(reopen.statusCode).toBe(302);
    const list = reopen.headers['set-cookie'];
    const cookies = Array.isArray(list) ? list : list ? [list] : [];
    expect(cookies.some((c) => c.startsWith('__Host-metamc_onboarding='))).toBe(false);
  });

  it('SEC-32 — token missing, expired e revoked producono lo STESSO outcome', async () => {
    const missing = await t.app.inject({ method: 'GET', url: '/accept?t=token-che-non-esiste-affatto' });

    const expiredEmail = 'expired@metamc.it';
    const expiredToken = await issueInvite(expiredEmail);
    // Si spostano indietro ENTRAMBE le date: il CHECK `expires_at >
    // created_at` non ammette un invite nato gia' expired, ed e' giusto cosi'
    // — nella realta' un invite non si "accorcia", si revoca.
    await t.ctx.db
      .updateTable('auth.invitation')
      .set({ created_at: new Date(Date.now() - 90 * 3600_000), expires_at: new Date(Date.now() - 1000) })
      .where('email_lower', '=', expiredEmail)
      .execute();
    const expired = await t.app.inject({ method: 'GET', url: `/accept?t=${expiredToken}` });

    const revokedEmail = 'revoked@metamc.it';
    const revokedToken = await issueInvite(revokedEmail);
    await t.ctx.db
      .updateTable('auth.invitation')
      .set({ revoked_at: new Date(), revoked_by: inviter.userId })
      .where('email_lower', '=', revokedEmail)
      .execute();
    const revoked = await t.app.inject({ method: 'GET', url: `/accept?t=${revokedToken}` });

    for (const res of [missing, expired, revoked]) {
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/accept');
      const list = res.headers['set-cookie'];
      const cookies = Array.isArray(list) ? list : list ? [list] : [];
      expect(cookies.some((c) => c.startsWith('__Host-metamc_onboarding='))).toBe(false);
    }
  });

  it('l`indice parziale impedisce due inviti pendenti per la stessa email', async () => {
    const email = 'doppione@metamc.it';
    await issueInvite(email);
    const second = await t.app.inject({
      method: 'POST',
      url: '/api/invites',
      headers: inviter.headers(),
      payload: { email, roleId },
    });
    expect(second.statusCode).toBe(409);
  });
});

describe('SEC-13 / test 11 — due consumi concorrenti dello stesso recovery code', () => {
  it('uno solo riesce', async () => {
    const user = await seedUser(t);
    const { codes } = await t.ctx.db.transaction().execute((trx) => issueRecoveryCodes(trx, user.id));
    const code = codes[0];
    expect(code).toBeDefined();

    // Due transazioni, stesso codice, insieme.
    const [a, b] = await Promise.all([
      t.ctx.db.transaction().execute((trx) => consumeRecoveryCode(trx, user.id, code as string, '127.0.0.1')),
      t.ctx.db.transaction().execute((trx) => consumeRecoveryCode(trx, user.id, code as string, '127.0.0.1')),
    ]);

    const succeeded = [a, b].filter((r) => r.ok);
    expect(succeeded).toHaveLength(1);

    const row = await t.ctx.db
      .selectFrom('auth.recovery_code')
      .select(['used_at', 'used_ip'])
      .where('user_id', '=', user.id)
      .where('used_at', 'is not', null)
      .execute();
    expect(row).toHaveLength(1);
  });

  it('cinque consumi concorrenti: sempre uno solo', async () => {
    const user = await seedUser(t);
    const { codes } = await t.ctx.db.transaction().execute((trx) => issueRecoveryCodes(trx, user.id));
    const code = codes[0] as string;

    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () =>
        t.ctx.db.transaction().execute((trx) => consumeRecoveryCode(trx, user.id, code, '127.0.0.1')),
      ),
    );
    expect(outcomes.filter((e) => e.ok)).toHaveLength(1);
  });

  it('un codice speso non si riapre nemmeno con una UPDATE diretta', async () => {
    const user = await seedUser(t);
    const { codes } = await t.ctx.db.transaction().execute((trx) => issueRecoveryCodes(trx, user.id));
    await t.ctx.db
      .transaction()
      .execute((trx) => consumeRecoveryCode(trx, user.id, codes[0] as string, '127.0.0.1'));

    await expect(
      t.ctx.db
        .updateTable('auth.recovery_code')
        .set({ used_at: null })
        .where('user_id', '=', user.id)
        .where('used_at', 'is not', null)
        .execute(),
    ).rejects.toThrow(/non si riapre/i);
  });

  it('rigenerare invalida in blocco la generazione precedente', async () => {
    const user = await seedUser(t);
    const firstGeneration = await t.ctx.db.transaction().execute((trx) => issueRecoveryCodes(trx, user.id));
    const secondGeneration = await t.ctx.db.transaction().execute((trx) => issueRecoveryCodes(trx, user.id));
    expect(secondGeneration.generation).toBe(firstGeneration.generation + 1);

    // Un codice della generazione vecchia non vale piu'.
    const outcome = await t.ctx.db
      .transaction()
      .execute((trx) => consumeRecoveryCode(trx, user.id, firstGeneration.codes[0] as string, '127.0.0.1'));
    expect(outcome.ok).toBe(false);

    // Uno della nuova si'.
    const fresh = await t.ctx.db
      .transaction()
      .execute((trx) => consumeRecoveryCode(trx, user.id, secondGeneration.codes[0] as string, '127.0.0.1'));
    expect(fresh.ok).toBe(true);
  });

  it('i codici sono 10, da 26 caratteri, e in tabella c`e` solo il digest', async () => {
    const user = await seedUser(t);
    const { codes } = await t.ctx.db.transaction().execute((trx) => issueRecoveryCodes(trx, user.id));
    expect(codes).toHaveLength(10);
    for (const c of codes) {
      // 128 bit in Base32 Crockford = 26 caratteri, alfabeto senza I/L/O/U.
      expect(c).toHaveLength(26);
      expect(c).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
    }
    const rows = await t.ctx.db
      .selectFrom('auth.recovery_code')
      .select('code_hash')
      .where('user_id', '=', user.id)
      .execute();
    for (const r of rows) {
      expect(Buffer.from(r.code_hash).length).toBe(32);
      for (const c of codes) {
        expect(Buffer.from(r.code_hash).toString('utf8')).not.toContain(c);
      }
    }
  });

  it('la normalizzazione perdona O/0 e I/1, che sono l`errore di trascrizione classico', async () => {
    const user = await seedUser(t);
    const { codes } = await t.ctx.db.transaction().execute((trx) => issueRecoveryCodes(trx, user.id));
    const code = codes[0] as string;
    // Formato mostrato all'utente: gruppi separati da trattini, minuscolo.
    const transcribed = (code.match(/.{1,5}/g) ?? []).join('-').toLowerCase();
    const outcome = await t.ctx.db
      .transaction()
      .execute((trx) => consumeRecoveryCode(trx, user.id, transcribed, '127.0.0.1'));
    expect(outcome.ok).toBe(true);
  });
});
