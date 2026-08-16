// Attori pronti all'uso per le suite di accettazione.
//
// L'enrollment TOTP passa dal percorso REALE — sign-in, enableTwoFactor,
// verifyTOTP — invece di scrivere un segreto a mano nella tabella. Il segreto
// del plugin e' cifrato con il secret di better-auth, e fabbricarne uno
// significherebbe reimplementare quella cifratura: il test verificherebbe la
// nostra copia, non il sistema.
//
// La creazione dell'utente, invece, NON passa dal flusso di invito: quello ha
// i suoi test, e ricostruirlo in ogni suite le renderebbe lente e fragili per
// motivi che non c'entrano con cio' che stanno verificando.

import { randomUUID } from 'node:crypto';
import { cookieFrom, cookieHeader, sameOriginHeaders, type TestApp } from './app.ts';
import { secretFromOtpauthUri, totpNow } from './totp.ts';

export type SeededUser = {
  id: string;
  email: string;
  password: string;
  /** Segreto TOTP in base32, disponibile dopo il primo enrollment. */
  totpSecret?: string;
};

export async function seedUser(
  t: TestApp,
  opts: { email?: string; name?: string; password?: string; roleKey?: string } = {},
): Promise<SeededUser> {
  const id = randomUUID().replace(/-/g, '');
  const email = opts.email ?? `${id.slice(0, 10)}@metamc.it`;
  const password = opts.password ?? 'password-di-test-lunghissima';
  const hash = await t.ctx.passwords.hash(password);

  await t.ctx.db
    .insertInto('auth.user')
    .values({
      id,
      name: opts.name ?? `Utente ${id.slice(0, 6)}`,
      email,
      emailVerified: true,
      status: 'active',
      twoFactorEnabled: false,
    })
    .execute();

  await t.ctx.db
    .insertInto('auth.account')
    .values({
      id: randomUUID().replace(/-/g, ''),
      accountId: id,
      providerId: 'credential',
      userId: id,
      password: hash,
    })
    .execute();

  if (opts.roleKey) {
    const role = await t.ctx.db
      .selectFrom('auth.roles')
      .select('id')
      .where('key', '=', opts.roleKey)
      .executeTakeFirstOrThrow();
    await t.ctx.db.insertInto('auth.user_roles').values({ user_id: id, role_id: role.id }).execute();
  }

  await t.ctx.store.invalidate(id);
  return { id, email, password };
}

export type Actor = {
  userId: string;
  email: string;
  sessionCookie: string;
  csrf: string;
  totpSecret: string;
  /** Solo il cookie di sessione: per le richieste GET. */
  cookieOnly: () => Record<string, string>;
  /** Header completi per una richiesta che cambia stato. */
  headers: (extra?: Record<string, string>) => Record<string, string>;
};

const SESSION_COOKIE = '__Host-metamc_session';
const CSRF_COOKIE = '__Host-metamc_csrf';

/** Tutti i cookie emessi da una risposta, come stringa `k=v; k=v`. */
function collectCookies(setCookie: string | string[] | undefined): Record<string, string> {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const out: Record<string, string> = {};
  for (const c of list) {
    const [pair] = c.split(';');
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (value.length > 0) out[name] = value;
  }
  return out;
}

/**
 * Primo accesso: sign-in, enrollment TOTP, prima verifica. Restituisce il
 * segreto, che le suite riusano per i login successivi.
 */
export async function enrollTotp(t: TestApp, user: SeededUser): Promise<string> {
  const signIn = await t.app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: sameOriginHeaders(),
    payload: { email: user.email, password: user.password },
  });
  if (signIn.statusCode !== 200) {
    throw new Error(`sign-in fallito: ${signIn.statusCode} ${signIn.body.slice(0, 200)}`);
  }
  const cookies = collectCookies(signIn.headers['set-cookie']);
  const cookie = cookieHeader(cookies);

  const enable = await t.app.inject({
    method: 'POST',
    url: '/api/auth/two-factor/enable',
    headers: sameOriginHeaders({ cookie, 'x-csrf-token': cookies['__Host-metamc_csrf'] ?? '' }),
    payload: { password: user.password },
  });
  if (enable.statusCode !== 200) {
    throw new Error(`enableTwoFactor fallito: ${enable.statusCode} ${enable.body.slice(0, 300)}`);
  }
  const { totpURI } = enable.json() as { totpURI: string };
  const secret = secretFromOtpauthUri(totpURI);

  const verify = await t.app.inject({
    method: 'POST',
    url: '/api/auth/two-factor/verify-totp',
    headers: sameOriginHeaders({ cookie, 'x-csrf-token': cookies['__Host-metamc_csrf'] ?? '' }),
    payload: { code: totpNow(secret) },
  });
  if (verify.statusCode !== 200) {
    throw new Error(`prima verifica TOTP fallita: ${verify.statusCode} ${verify.body.slice(0, 300)}`);
  }

  user.totpSecret = secret;
  return secret;
}

/**
 * Autentica un utente fino ad aal=2, passando dal TOTP vero.
 *
 * Al primo giro fa anche l'enrollment. Il codice si consuma sempre da uno step
 * fresco: la guardia anti-replay (SEC-11) e' attiva anche qui, e riusare lo
 * stesso codice fra due login farebbe fallire il secondo — che e' il
 * comportamento corretto, e infatti e' il test 7.
 */
export async function loginAs(t: TestApp, user: SeededUser): Promise<Actor> {
  if (!user.totpSecret) {
    await enrollTotp(t, user);
    // L'enrollment lascia gia' una sessione ad aal=2: si prosegue con un login
    // pulito, cosi' ogni attore parte dallo stesso stato.
    await waitForNextTotpStep(t, user.id);
  }
  const secret = user.totpSecret;
  if (!secret) throw new Error('enrollment TOTP non riuscito');

  // La guardia anti-replay viene azzerata PRIMA di ogni login di comodo.
  //
  // In produzione fra due accessi della stessa persona passa piu' di mezzo
  // minuto e lo step cambia da solo; qui passano millisecondi, e senza questo
  // il secondo `loginAs` verrebbe rifiutato — correttamente, ma per un motivo
  // che quelle suite non stanno verificando. Il test 7 esercita il replay per
  // conto suo, senza passare di qui.
  await waitForNextTotpStep(t, user.id);

  const signIn = await t.app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: sameOriginHeaders(),
    payload: { email: user.email, password: user.password },
  });
  if (signIn.statusCode !== 200) {
    throw new Error(`sign-in fallito: ${signIn.statusCode} ${signIn.body.slice(0, 200)}`);
  }

  let cookies = collectCookies(signIn.headers['set-cookie']);
  // Con il 2FA attivo il sign-in NON emette una sessione: emette una challenge.
  // E' il comportamento voluto — la password da sola non apre nulla.
  if (!cookies[SESSION_COOKIE]) {
    const verify = await t.app.inject({
      method: 'POST',
      url: '/api/auth/two-factor/verify-totp',
      headers: sameOriginHeaders({
        cookie: cookieHeader(cookies),
        'x-csrf-token': cookies['__Host-metamc_csrf'] ?? '',
      }),
      payload: { code: totpNow(secret) },
    });
    if (verify.statusCode !== 200) {
      throw new Error(`verifica TOTP fallita: ${verify.statusCode} ${verify.body.slice(0, 300)}`);
    }
    cookies = { ...cookies, ...collectCookies(verify.headers['set-cookie']) };
  }

  const sessionCookie = cookies[SESSION_COOKIE];
  if (!sessionCookie) throw new Error('nessun cookie di sessione dopo il 2FA');

  const me = await t.app.inject({
    method: 'GET',
    url: '/api/me',
    headers: { cookie: cookieHeader({ [SESSION_COOKIE]: sessionCookie }) },
  });
  if (me.statusCode !== 200) {
    throw new Error(`/api/me ha risposto ${me.statusCode}: ${me.body.slice(0, 300)}`);
  }
  const csrf = cookieFrom(me.headers['set-cookie'], CSRF_COOKIE);
  if (!csrf) throw new Error('nessun cookie CSRF emesso');

  return {
    userId: user.id,
    email: user.email,
    sessionCookie,
    csrf,
    totpSecret: secret,
    cookieOnly: () => ({ cookie: cookieHeader({ [SESSION_COOKIE]: sessionCookie }) }),
    headers: (extra = {}) =>
      sameOriginHeaders({
        cookie: cookieHeader({ [SESSION_COOKIE]: sessionCookie, [CSRF_COOKIE]: csrf }),
        'x-csrf-token': csrf,
        ...extra,
      }),
  };
}

/**
 * Risolve la riga `auth.session` che corrisponde al cookie di un attore.
 *
 * Serve perche' un utente ha spesso piu' sessioni aperte — l'enrollment ne
 * lascia una — e prendere "la prima per createdAt" e' un modo affidabile di
 * revocare quella sbagliata.
 */
export async function sessionOfActor(t: TestApp, actor: Actor): Promise<{ id: string; expiresAt: Date }> {
  // Il cookie e' `token.firma`: al database interessa solo il token.
  const token = decodeURIComponent(actor.sessionCookie).split('.')[0];
  if (!token) throw new Error('cookie di sessione non interpretabile');
  const row = await t.ctx.db
    .selectFrom('auth.session')
    .select(['id', 'expiresAt'])
    .where('token', '=', token)
    .executeTakeFirst();
  if (!row) throw new Error(`nessuna sessione per il token ${token.slice(0, 8)}…`);
  return row;
}

/**
 * Aspetta il passaggio allo step TOTP successivo e ripulisce la guardia.
 *
 * Serve solo nei test: in produzione fra due login passa piu' di mezzo minuto,
 * qui passano millisecondi, e senza questo ogni secondo login della stessa
 * persona sbatterebbe contro l'anti-replay — che e' corretto, ma non e' cio'
 * che quelle suite stanno verificando.
 */
export async function waitForNextTotpStep(t: TestApp, userId: string): Promise<void> {
  const client = t.redis.client();
  const keys = await client.keys(`totp:used:${userId}:*`);
  if (keys.length > 0) await client.del(...keys);
  await client.quit().catch(() => undefined);
  await t.ctx.db.updateTable('auth.user').set({ last_totp_step: '0' }).where('id', '=', userId).execute();
}
