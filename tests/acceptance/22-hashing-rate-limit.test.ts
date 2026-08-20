// SEC-25 / SEC-26 — le rotte autenticate che finiscono in Argon2.
//
// IL DIFETTO CHE QUESTI TEST FISSANO. `HASHING_PATHS` elencava cinque rotte
// che arrivano a un hash, ma il consumo dei limitatori stava dentro
// `if (LOGIN_PATHS.has(subPath))`, e quell'insieme ne contiene tre. Tre
// restavano scoperte — `/change-password`, `/two-factor/enable`,
// `/two-factor/disable` — raggiungibili e capaci di far girare Argon2 senza
// consumare niente. Su un threadpool condiviso e' il modo piu' economico di
// mettere in ginocchio il pannello (§14 test 16).
//
// PERCHE' NON SI PUO' PROVARE CAMBIANDO INDIRIZZO. `rateLimitIpKey` usa il
// SOCKET, non `x-forwarded-for`: e' l'unico dei due che chi attacca non
// controlla, e limitare su un valore falsificabile equivale a non limitare
// (SEC-26). Quindi da `app.inject` l'indirizzo e' sempre lo stesso e la
// dimensione per-IP non si puo' variare. Cio' che questi test isolano e' la
// dimensione per UTENTE: e' quella che ferma chi ha rubato una sessione, ed
// e' quella che il difetto lasciava scoperta.
//
// Gli attori nascono tutti in `beforeAll`, prima di qualunque ciclo: ogni
// enrollment TOTP passa da `/two-factor/enable`, che ora e' limitata, e
// crearli dopo aver esaurito un secchio significherebbe far fallire la
// preparazione invece della prova.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, loginAs, seedUser } from '#tests/support/actors.ts';
import { startTestApp, type TestApp } from '#tests/support/app.ts';

let t: TestApp;
/** Un attore per prova: il limite per utente blocca l'utente, non la rotta. */
let actors: Actor[];

/** Le tre che erano scoperte. */
const UNCOVERED = [
  '/api/auth/change-password',
  '/api/auth/two-factor/enable',
  '/api/auth/two-factor/disable',
] as const;

/** Un corpo che arriva all'hash e fallisce: l'esito non conta, il costo si'. */
const PAYLOAD = {
  currentPassword: 'sbagliata-ma-lunga',
  newPassword: 'nuova-password-lunghissima',
  password: 'sbagliata-ma-lunga',
};

function post(actor: Actor, url: string) {
  return t.app.inject({ method: 'POST', url, headers: actor.headers(), payload: PAYLOAD });
}

beforeAll(async () => {
  t = await startTestApp({ label: 'hashing-limit' });
  actors = [];
  for (let i = 0; i < 5; i += 1) {
    actors.push(await loginAs(t, await seedUser(t, { roleKey: 'owner' })));
  }
}, 300_000);

afterAll(async () => {
  await t?.close();
});

describe('SEC-25 — le rotte di hashing autenticate consumano un limite', () => {
  it.each(UNCOVERED.map((url, i) => ({ url, i })))(
    '$url finisce per rispondere 429, non all`infinito',
    async ({ url, i }) => {
      const actor = actors[i];
      if (!actor) throw new Error('attore mancante');

      let limited = false;
      // Il tetto per utente e' basso di proposito: cambiare password o toccare
      // il secondo fattore si fa una volta ogni tanto, non venti al minuto.
      for (let n = 0; n < 8 && !limited; n += 1) {
        const res = await post(actor, url);
        if (res.statusCode === 429) limited = true;
      }

      expect(limited, `${url} non ha mai risposto 429`).toBe(true);
    },
  );

  it('il limite e` PER UTENTE: chi lo esaurisce non chiude la porta agli altri', async () => {
    const esaurito = actors[3];
    const altro = actors[4];
    if (!esaurito || !altro) throw new Error('attori mancanti');

    let limited = false;
    for (let n = 0; n < 8 && !limited; n += 1) {
      const res = await post(esaurito, '/api/auth/change-password');
      if (res.statusCode === 429) limited = true;
    }
    expect(limited, 'il primo attore non e` stato fermato').toBe(true);

    // Stesso indirizzo, utente diverso: se il 429 fosse solo per IP, anche
    // questo lo prenderebbe. Se passa, la dimensione per utente esiste.
    const res = await post(altro, '/api/auth/change-password');
    expect(res.statusCode).not.toBe(429);
  });
});

describe('SEC-26 — il fondo scala per IP sulle rotte autenticate', () => {
  // Ultimo di proposito: esaurisce `apiIp` per l'indirizzo del socket, che in
  // `inject` e' condiviso da tutto il file.
  it('apiIp e` collegato: superarlo chiude anche una GET innocua', async () => {
    const actor = actors[0];
    if (!actor) throw new Error('attore mancante');

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
