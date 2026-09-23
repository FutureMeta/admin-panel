// Il ponte `/api/auth/*` apre due rotte di better-auth, e nient'altro.
//
// IL DIFETTO CHE QUESTI TEST FISSANO. Il ponte inoltrava qualunque
// sotto-percorso, e con una sessione si raggiungevano rotte che il pannello
// non usa e che scavalcano i suoi controlli: leggere il segreto TOTP,
// sostituirlo rigenerando i codici di backup, cambiare password senza HIBP ne'
// registro, rinominarsi. E i controlli del ponte guardavano l'URL GREZZO,
// mentre better-auth riceveva quello normalizzato: `/two-factor/./x`
// scavalcava il blocco dei codici di backup (SEC-14).
//
// Qui si prova che quelle rotte non esistono piu' — nemmeno con una sessione
// valida, nemmeno travestite — e che non lasciano tracce: il nome resta
// quello, la password pure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, loginAs, type SeededUser, seedUser } from '#tests/support/actors.ts';
import { sameOriginHeaders, startTestApp, type TestApp } from '#tests/support/app.ts';

let t: TestApp;
let owner: SeededUser;
let actor: Actor;

beforeAll(async () => {
  t = await startTestApp({ label: 'auth-bridge' });
  owner = await seedUser(t, { roleKey: 'owner' });
  actor = await loginAs(t, owner);
}, 300_000);

afterAll(async () => {
  await t?.close();
});

const post = (url: string, payload: object = {}) =>
  t.app.inject({ method: 'POST', url, headers: actor.headers(), payload });

describe('solo login e verifica del secondo fattore', () => {
  it.each([
    '/change-password',
    '/two-factor/enable',
    '/two-factor/disable',
    '/two-factor/get-totp-uri',
    '/two-factor/verify-backup-code',
    '/two-factor/generate-backup-codes',
    '/update-user',
    '/get-session',
    '/list-sessions',
    '/revoke-sessions',
    '/sign-out',
    '/forget-password',
    '/reset-password',
  ])('%s risponde 404, anche con una sessione valida', async (path) => {
    const res = await post(`/api/auth${path}`, {
      password: owner.password,
      currentPassword: owner.password,
      newPassword: 'una-password-nuova-e-lunga',
      name: 'Rinominato da fuori',
      code: '123456',
    });
    expect(res.statusCode).toBe(404);
  });

  it('e non lasciano tracce: nome e password restano quelli', async () => {
    const row = await t.ctx.db
      .selectFrom('auth.user')
      .select('name')
      .where('id', '=', owner.id)
      .executeTakeFirstOrThrow();
    expect(row.name).not.toBe('Rinominato da fuori');
    // La password vecchia apre ancora: il login si ferma alla challenge 2FA.
    const signIn = await t.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: sameOriginHeaders(),
      payload: { email: owner.email, password: owner.password },
    });
    expect(signIn.statusCode).toBe(200);
  });

  it.each([
    '/api/auth/two-factor/./verify-backup-code',
    '/api/auth/two-factor/%2e/verify-backup-code',
    '/api/auth/two-factor/verify-backup-code/',
    '/api/auth/two-factor/x/../get-totp-uri',
    '/api/auth//change-password',
  ])('travestita non passa: %s', async (url) => {
    const res = await post(url, { password: owner.password, code: '12345678' });
    expect(res.statusCode).toBe(404);
  });

  it('in GET non c`e` niente', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/auth/get-session',
      headers: actor.cookieOnly(),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('SEC-26 — il fondo scala per IP sulle rotte autenticate', () => {
  // Ultimo di proposito: esaurisce `apiIp` per l'indirizzo del socket, che in
  // `inject` e' condiviso da tutto il file.
  it('apiIp e` collegato: superarlo chiude anche una GET innocua', async () => {
    // 600 al minuto: si esaurisce solo insistendo, ed e' voluto — e' un tetto
    // contro indirizzi falsificati o distribuiti, non un freno alla
    // navigazione normale.
    let limited = false;
    for (let n = 0; n < 700 && !limited; n += 1) {
      const res = await t.app.inject({ method: 'GET', url: '/api/me', headers: actor.cookieOnly() });
      if (res.statusCode === 429) limited = true;
    }

    expect(limited).toBe(true);
  });
});
