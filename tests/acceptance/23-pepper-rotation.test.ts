// SEC-40 — rotazione del pepper senza reset password globale.
//
// COSA PROMETTEVA IL RUNBOOK E COSA SUCCEDEVA. «Si alza `PEPPER_VERSION`; ogni
// utente viene ri-hashato al login successivo grazie a `pepper_version` sulla
// sua riga.» In realta' `PEPPER_VERSION` era validata e mai letta, e
// `needsRehash()` non aveva chiamanti: alzare quel numero non ri-hashava
// nessuno — e siccome il pepper entra in Argon2 come `secret`, cambiarlo
// davvero avrebbe invalidato ogni hash esistente in un colpo solo.
//
// LA PROPRIETA' CHE CONTA PIU' DI TUTTE, e il motivo per cui questo file
// esiste: dopo l'intervento, un utente che esisteva prima deve continuare a
// entrare. Il pepper della versione 1 deve restare ESATTAMENTE
// `HKDF(MASTER_KEY, info='argon2-pepper-v1')`. Se cambia, non c'e' rimedio:
// un hash non si ricalcola senza la password in chiaro.
//
// I test girano su un'app con `PEPPER_VERSION` alzata a 2, mentre le righe
// nate prima restano alla 1: e' esattamente lo stato in cui si trova una
// installazione il giorno dopo una rotazione.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import argon2 from '@node-rs/argon2';
import { ARGON2_PARAMS, normalizePassword } from '#src/auth/password.ts';
import { pepperFor, pepperRing } from '#src/crypto/keys.ts';
import { loginAs, seedUser } from '#tests/support/actors.ts';
import { startTestApp, type TestApp } from '#tests/support/app.ts';

let t: TestApp;

const PASSWORD = 'password-di-prova-lunghissima';

/** Un hash prodotto con il pepper di una versione precisa, come lo avrebbe
 *  scritto il codice di allora. */
async function hashWith(password: string, version: number): Promise<string> {
  return argon2.hash(normalizePassword(password), {
    ...ARGON2_PARAMS,
    secret: pepperFor(t.ctx.env.MASTER_KEY, version),
  });
}

async function verifyWith(phc: string, password: string, version: number): Promise<boolean> {
  return argon2.verify(phc, normalizePassword(password), {
    secret: pepperFor(t.ctx.env.MASTER_KEY, version),
  });
}

/** La riga dell'utente: versione dichiarata e hash memorizzato. */
async function stored(userId: string): Promise<{ version: number; phc: string }> {
  const user = await t.ctx.db
    .selectFrom('auth.user')
    .select('pepper_version')
    .where('id', '=', userId)
    .executeTakeFirstOrThrow();
  const account = await t.ctx.db
    .selectFrom('auth.account')
    .select('password')
    .where('userId', '=', userId)
    .where('providerId', '=', 'credential')
    .executeTakeFirstOrThrow();
  return { version: user.pepper_version, phc: account.password ?? '' };
}

beforeAll(async () => {
  t = await startTestApp({ label: 'pepper', pepperVersion: 2 });
}, 240_000);

afterAll(async () => {
  await t?.close();
});

describe('la derivazione della versione 1 non si tocca', () => {
  it('pepperFor(master, 1) e` la stessa `info` di sempre', () => {
    const master = Buffer.alloc(32, 7);
    const ring = pepperRing(master, 3);
    // La 1 deve coincidere con la derivazione storica, non con una nuova.
    expect(ring.get(1)?.equals(pepperFor(master, 1))).toBe(true);
    expect(ring.get(2)?.equals(pepperFor(master, 1))).toBe(false);
    expect(ring.size).toBe(3);
  });
});

describe('SEC-40 — un utente nato prima della rotazione', () => {
  it('entra ancora, con la password di sempre', async () => {
    // `seedUser` scrive l'hash con il pepper corrente dell'app (la 2) ma
    // lascia `pepper_version` al default della colonna, che e' 1: la riga
    // dichiara una versione diversa da quella con cui e' nata. Si riallinea
    // esplicitamente per riprodurre lo stato reale post-rotazione.
    const user = await seedUser(t, { password: PASSWORD });
    await t.ctx.db
      .updateTable('auth.account')
      .set({ password: await hashWith(PASSWORD, 1) })
      .where('userId', '=', user.id)
      .where('providerId', '=', 'credential')
      .execute();
    await t.ctx.db
      .updateTable('auth.user')
      .set({ pepper_version: 1 })
      .where('id', '=', user.id)
      .execute();

    const before = await stored(user.id);
    expect(before.version).toBe(1);

    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: {
        origin: 'http://admin.metamc.test',
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      payload: { email: user.email, password: PASSWORD },
    });

    expect(res.statusCode).toBe(200);
  });

  it('e al login il suo hash viene rigenerato con il pepper corrente', async () => {
    const user = await seedUser(t, { password: PASSWORD });
    await t.ctx.db
      .updateTable('auth.account')
      .set({ password: await hashWith(PASSWORD, 1) })
      .where('userId', '=', user.id)
      .where('providerId', '=', 'credential')
      .execute();
    await t.ctx.db
      .updateTable('auth.user')
      .set({ pepper_version: 1 })
      .where('id', '=', user.id)
      .execute();

    const before = await stored(user.id);

    await t.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: {
        origin: 'http://admin.metamc.test',
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      payload: { email: user.email, password: PASSWORD },
    });

    const after = await stored(user.id);
    expect(after.version, 'la colonna non e` stata aggiornata').toBe(2);
    expect(after.phc, "l'hash non e` stato rigenerato").not.toBe(before.phc);

    // E il nuovo hash deve essere verificabile con il pepper CORRENTE: se
    // fosse stato rifatto con quello vecchio, la riga direbbe 2 e sarebbe 1,
    // e al prossimo accesso quella persona resterebbe fuori.
    expect(await verifyWith(after.phc, PASSWORD, 2)).toBe(true);
  });

  it('una volta migrato non viene rigenerato a ogni accesso', async () => {
    const user = await seedUser(t, { password: PASSWORD });
    const actor = await loginAs(t, user);
    expect(actor.userId).toBe(user.id);

    const before = await stored(user.id);
    expect(before.version).toBe(2);

    await t.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: {
        origin: 'http://admin.metamc.test',
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      payload: { email: user.email, password: PASSWORD },
    });

    const after = await stored(user.id);
    expect(after.phc, 'un hash gia` alla versione corrente e` stato rifatto per niente').toBe(
      before.phc,
    );
  });

  it('una password sbagliata non migra niente', async () => {
    const user = await seedUser(t, { password: PASSWORD });
    await t.ctx.db
      .updateTable('auth.account')
      .set({ password: await hashWith(PASSWORD, 1) })
      .where('userId', '=', user.id)
      .where('providerId', '=', 'credential')
      .execute();
    await t.ctx.db
      .updateTable('auth.user')
      .set({ pepper_version: 1 })
      .where('id', '=', user.id)
      .execute();

    const before = await stored(user.id);

    await t.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: {
        origin: 'http://admin.metamc.test',
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      payload: { email: user.email, password: 'questa-non-e-la-password' },
    });

    const after = await stored(user.id);
    expect(after.version).toBe(1);
    expect(after.phc).toBe(before.phc);
  });
});
