// Le due strade per rientrare quando il telefono non c'e' piu'. §8.4, §8.8
//
// ERANO CHIUSE TUTTE E DUE, e nessun test lo diceva perche' nessun test le
// percorreva.
//
//   - Il codice di recupero cercava una SESSIONE, ma con il 2FA attivo dopo
//     la password better-auth lascia solo il cookie della challenge: la rotta
//     rispondeva 401 a chiunque.
//   - Dopo un reset del secondo fattore l'account torna in
//     `pending_onboarding`, e «si rientra dal login e si rifa' l'enrollment»:
//     il login faceva entrare, ma nessuna rotta permetteva di rifare il 2FA,
//     e il middleware rifiutava l'account non attivo. Fuori per sempre.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatRecoveryCode, issueRecoveryCodes } from '#src/auth/recovery-codes.ts';
import { loginAs, type SeededUser, seedUser, waitForNextTotpStep } from '#tests/support/actors.ts';
import { sameOriginHeaders, startTestApp, type TestApp } from '#tests/support/app.ts';
import { secretFromOtpauthUri, totpNow } from '#tests/support/totp.ts';

let t: TestApp;

beforeAll(async () => {
  t = await startTestApp({ label: 'account-recovery' });
}, 300_000);

afterAll(async () => {
  await t?.close();
});

/** I cookie di una risposta, da ripresentare come fa un browser. */
function jarOf(setCookie: string | string[] | undefined, into: Record<string, string> = {}) {
  for (const c of Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []) {
    const [pair] = c.split(';');
    const eq = pair?.indexOf('=') ?? -1;
    if (!pair || eq < 0) continue;
    const value = pair.slice(eq + 1);
    if (value) into[pair.slice(0, eq)] = value;
    else delete into[pair.slice(0, eq)];
  }
  return into;
}
const headerOf = (jar: Record<string, string>) =>
  sameOriginHeaders({
    cookie: Object.entries(jar)
      .map(([k, v]) => `${k}=${v}`)
      .join('; '),
    'x-csrf-token': jar['__Host-metamc_csrf'] ?? '',
  });

async function signIn(user: SeededUser) {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: sameOriginHeaders(),
    payload: { email: user.email, password: user.password },
  });
  expect(res.statusCode).toBe(200);
  return {
    body: res.json() as { token?: string; twoFactorRedirect?: boolean },
    jar: jarOf(res.headers['set-cookie']),
  };
}

describe('il codice di recupero apre la sessione dalla challenge', () => {
  let user: SeededUser;
  let codes: string[];

  beforeAll(async () => {
    user = await seedUser(t, { roleKey: 'moderatore' });
    await loginAs(t, user);
    const issued = await t.ctx.db.transaction().execute((trx) => issueRecoveryCodes(trx, user.id));
    codes = issued.codes.map(formatRecoveryCode);
  });

  it('dopo la password, un codice giusto entra ad aal=2', async () => {
    const { body, jar } = await signIn(user);
    expect(body.twoFactorRedirect).toBe(true);

    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/recovery-code',
      headers: headerOf(jar),
      payload: { code: codes[0] },
    });
    expect(res.statusCode).toBe(200);
    jarOf(res.headers['set-cookie'], jar);
    expect(jar['__Host-metamc_session']).toBeDefined();

    const me = await t.app.inject({ method: 'GET', url: '/api/me', headers: headerOf(jar) });
    expect(me.statusCode).toBe(200);
    expect(me.json().aal).toBe(2);
    const amr = await t.ctx.db
      .selectFrom('auth.session')
      .select('amr')
      .where('userId', '=', user.id)
      .where('aal', '=', 2)
      .orderBy('createdAt', 'desc')
      .executeTakeFirstOrThrow();
    expect(amr.amr).toEqual(['pwd', 'recovery']);
  });

  it('lo stesso codice non vale due volte', async () => {
    const { jar } = await signIn(user);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/recovery-code',
      headers: headerOf(jar),
      payload: { code: codes[0] },
    });
    expect(res.statusCode).toBe(401);
  });

  it('senza la password prima, niente: il codice da solo non identifica nessuno', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/recovery-code',
      headers: sameOriginHeaders(),
      payload: { code: codes[1] },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('dopo un reset del 2FA si rientra dal login', () => {
  let user: SeededUser;

  beforeAll(async () => {
    user = await seedUser(t, { roleKey: 'moderatore' });
    await loginAs(t, user);
    // Cio' che fa l'esecuzione del reset: fattori via, account da riattivare.
    await t.ctx.db.deleteFrom('auth.twoFactor').where('userId', '=', user.id).execute();
    await t.ctx.db.deleteFrom('auth.session').where('userId', '=', user.id).execute();
    await t.ctx.db
      .updateTable('auth.user')
      .set({ twoFactorEnabled: false, status: 'pending_onboarding', sessions_valid_from: new Date() })
      .where('id', '=', user.id)
      .execute();
    await t.ctx.store.invalidate(user.id);
    await waitForNextTotpStep(t, user.id);
  });

  it('password sbagliata: niente segreto', async () => {
    const { jar } = await signIn(user);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/account/two-factor/enroll',
      headers: headerOf(jar),
      payload: { password: 'non-e-questa-password' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VERIFICA_NON_RIUSCITA');
    await t.ctx.rateLimit.reward('twoFactorAccount', user.id);
  });

  it('password, QR, primo codice: account attivo, codici di recupero, e dentro', async () => {
    const { body, jar } = await signIn(user);
    // Senza 2FA better-auth emette subito una sessione: e' da li' che si parte.
    expect(body.token).toBeDefined();
    const me = await t.app.inject({ method: 'GET', url: '/api/me', headers: headerOf(jar) });
    expect(me.statusCode).toBe(401);

    const enroll = await t.app.inject({
      method: 'POST',
      url: '/api/account/two-factor/enroll',
      headers: headerOf(jar),
      payload: { password: user.password },
    });
    expect(enroll.statusCode).toBe(200);
    const secret = secretFromOtpauthUri(enroll.json().totpURI);

    const complete = await t.app.inject({
      method: 'POST',
      url: '/api/account/two-factor/complete',
      headers: headerOf(jar),
      payload: { code: totpNow(secret) },
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json().recoveryCodes.length).toBeGreaterThan(0);
    jarOf(complete.headers['set-cookie'], jar);

    const inside = await t.app.inject({ method: 'GET', url: '/api/me', headers: headerOf(jar) });
    expect(inside.statusCode).toBe(200);
    const row = await t.ctx.db
      .selectFrom('auth.user')
      .select(['status', 'twoFactorEnabled'])
      .where('id', '=', user.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: 'active', twoFactorEnabled: true });
  });

  it('per un account attivo quelle rotte non esistono', async () => {
    const other = await seedUser(t, { roleKey: 'moderatore' });
    const actor = await loginAs(t, other);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/account/two-factor/enroll',
      headers: actor.headers(),
      payload: { password: other.password },
    });
    expect(res.statusCode).toBe(404);
  });
});
