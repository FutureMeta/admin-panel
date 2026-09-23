// Revoca vera, owner che restano due, nessuno che si concede qualcosa da solo.
//
// LE TRE COSE CHE SBAGLIAVANO IN SILENZIO:
//
//   - una sessione revocata restava nel secondary storage di better-auth, e
//     le rotte che better-auth serve da se' la trovavano ancora li';
//   - la regola dei due owner stava solo sull'eliminazione, e fuori dalla
//     transazione: due eliminazioni insieme la aggiravano, e ban, offboarding
//     e rimozione del ruolo non la guardavano affatto;
//   - un admin poteva copiarsi in override individuali i livelli del suo
//     ruolo, e tenerli dopo averlo perso.
//
// E il cambio email, che bastava la sessione a chiedere: da un cookie rubato
// all'account intero, passando per il reset della password.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KEYS } from '#src/redis/client.ts';
import {
  type Actor,
  loginAs,
  type SeededUser,
  seedUser,
  waitForNextTotpStep,
} from '#tests/support/actors.ts';
import { startTestApp, type TestApp } from '#tests/support/app.ts';
import { revokeRole, roleIdByKey } from '#tests/support/fixtures.ts';
import { totpNow } from '#tests/support/totp.ts';

let t: TestApp;
let primo: Actor;
let primoUser: SeededUser;

beforeAll(async () => {
  t = await startTestApp({ label: 'revocation-owners' });
  primoUser = await seedUser(t, { email: 'owner-uno@metamc.it', roleKey: 'owner' });
  primo = await loginAs(t, primoUser);
}, 300_000);

afterAll(async () => {
  await t?.close();
});

const call = (method: 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
  t.app.inject({ method, url, headers: primo.headers(), ...(payload ? { payload } : {}) });

/** Il token della sessione dietro il cookie: e' la chiave con cui better-auth la tiene su Redis. */
const tokenOf = (a: Actor) => decodeURIComponent(a.sessionCookie).split('.')[0] ?? '';

describe('una sessione revocata sparisce anche da Redis', () => {
  it.each([
    ['ban', (id: string) => call('POST', `/api/users/${id}/ban`, { reason: 'prova di revoca' })],
    ['logout forzato', (id: string) => call('POST', `/api/users/${id}/revoke-sessions`)],
    ['offboarding', (id: string) => call('POST', `/api/users/${id}/offboard`, { reason: 'prova di revoca' })],
  ] as const)('%s', async (_label, revoke) => {
    const user = await seedUser(t, { roleKey: 'moderatore' });
    const victim = await loginAs(t, user);
    expect(await t.ctx.redis.exists(KEYS.authSession(tokenOf(victim)))).toBe(1);

    expect((await revoke(user.id)).statusCode).toBe(200);

    expect(await t.ctx.redis.exists(KEYS.authSession(tokenOf(victim)))).toBe(0);
    // Il punto: better-auth non la trova piu', nemmeno dal suo lato.
    const session = await t.ctx.auth.api.getSession({ headers: new Headers(victim.cookieOnly()) });
    expect(session).toBeNull();
  });
});

describe('nessuno tocca i propri permessi', () => {
  it('un override su se stessi e` rifiutato', async () => {
    const res = await call('PUT', `/api/users/${primo.userId}/permissions`, {
      moduleKey: 'statistiche',
      level: 3,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('AUTOASSEGNAZIONE');
  });
});

describe('restano sempre due owner', () => {
  it('con due owner, l`altro non si banna, non si offboarda e non perde il ruolo', async () => {
    const secondo = await seedUser(t, { email: 'owner-due@metamc.it', roleKey: 'owner' });
    const owner = await roleIdByKey(t.ctx.db, 'owner');
    for (const res of [
      await call('POST', `/api/users/${secondo.id}/ban`, { reason: 'prova' }),
      await call('POST', `/api/users/${secondo.id}/offboard`, { reason: 'prova' }),
      await call('DELETE', `/api/users/${secondo.id}/roles/${owner}`),
      await call('POST', `/api/users/${secondo.id}/delete`, { reason: 'prova' }),
    ]) {
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('SERVONO_DUE_OWNER');
    }
  });

  it('un owner bannato non conta: con un terzo bannato, gli altri due restano intoccabili', async () => {
    const terzo = await seedUser(t, { email: 'owner-tre@metamc.it', roleKey: 'owner' });
    expect((await call('POST', `/api/users/${terzo.id}/ban`, { reason: 'prova' })).statusCode).toBe(200);
    const secondo = await t.ctx.db
      .selectFrom('auth.user')
      .select('id')
      .where('email', '=', 'owner-due@metamc.it')
      .executeTakeFirstOrThrow();
    const res = await call('POST', `/api/users/${secondo.id}/ban`, { reason: 'prova' });
    expect(res.json().code).toBe('SERVONO_DUE_OWNER');
    // Il bannato invece si puo' togliere: non e' fra quelli che contano.
    await revokeRole(t.ctx.db, terzo.id, 'owner');
  });

  it('due eliminazioni insieme non lasciano un owner solo', async () => {
    // Tre owner vivi: uno, due, e un quarto. Due eliminazioni contemporanee
    // contavano tre owner ciascuna e passavano tutte e due.
    const quarto = await seedUser(t, { email: 'owner-quattro@metamc.it', roleKey: 'owner' });
    const secondo = await t.ctx.db
      .selectFrom('auth.user')
      .select('id')
      .where('email', '=', 'owner-due@metamc.it')
      .executeTakeFirstOrThrow();

    const results = await Promise.all([
      call('POST', `/api/users/${secondo.id}/delete`, { reason: 'prova concorrente' }),
      call('POST', `/api/users/${quarto.id}/delete`, { reason: 'prova concorrente' }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400]);

    const owners = await t.ctx.db
      .selectFrom('auth.user_roles as ur')
      .innerJoin('auth.roles as r', 'r.id', 'ur.role_id')
      .innerJoin('auth.user as u', 'u.id', 'ur.user_id')
      .select('ur.user_id')
      .where('r.key', '=', 'owner')
      .where('u.deleted_at', 'is', null)
      .where('u.banned', '=', false)
      .execute();
    expect(owners).toHaveLength(2);
  });
});

describe('il cambio email vuole password e codice', () => {
  // Ogni rifiuto blocca il secchio del 2FA per almeno un minuto, ed e' giusto;
  // qui ogni tentativo deve arrivare alla verifica, non al 429.
  const change = async (payload: object) => {
    await t.ctx.rateLimit.reward('twoFactorAccount', primo.userId);
    return call('POST', '/api/account/email', payload);
  };
  const fresh = async () => {
    await waitForNextTotpStep(t, primo.userId);
    return totpNow(primo.totpSecret);
  };

  it('con la sola sessione non parte', async () => {
    expect((await change({ email: 'nuovo@metamc.it' })).statusCode).toBe(400);
  });

  it('password sbagliata o codice sbagliato: lo stesso rifiuto', async () => {
    const wrongPassword = await change({
      email: 'nuovo@metamc.it',
      password: 'non-e-questa',
      code: await fresh(),
    });
    expect(wrongPassword.json().code).toBe('VERIFICA_NON_RIUSCITA');
    const wrongCode = await change({
      email: 'nuovo@metamc.it',
      password: primoUser.password,
      code: '000000',
    });
    expect(wrongCode.json().code).toBe('VERIFICA_NON_RIUSCITA');
  });

  it('con tutte e due parte, e lo stesso codice non vale due volte', async () => {
    const code = await fresh();
    const ok = await change({ email: 'nuovo@metamc.it', password: primoUser.password, code });
    expect(ok.statusCode).toBe(200);
    const again = await change({ email: 'altro@metamc.it', password: primoUser.password, code });
    expect(again.json().code).toBe('VERIFICA_NON_RIUSCITA');
  });
});
