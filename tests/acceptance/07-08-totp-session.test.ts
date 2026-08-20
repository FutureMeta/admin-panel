// §14 test 7 — lo stesso codice TOTP presentato due volte dentro la finestra
//              e' rifiutato la seconda.  SEC-11, SEC-12
// §14 test 8 — il token di sessione CAMBIA dopo il completamento del 2FA e
//              dopo l'enrollment da invito.  SEC-06
// §14 test 14 — POST /api/auth/two-factor/verify-backup-code restituisce 404.
//              SEC-14
//
// NIST SP 800-63B §3.1.4.2 e' uno SHALL: un OTP non deve essere accettato due
// volte. Con window=1 un codice intercettato resterebbe spendibile per 90
// secondi se nessuno lo marcasse.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loginAs, seedUser, waitForNextTotpStep } from '#tests/support/actors.ts';
import { sameOriginHeaders, startTestApp, type TestApp } from '#tests/support/app.ts';
import { currentStep, secretFromOtpauthUri, totpAt, totpNow } from '#tests/support/totp.ts';

let t: TestApp;

beforeAll(async () => {
  t = await startTestApp({ label: 'totp' });
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

function header(map: Record<string, string>): string {
  return Object.entries(map)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/**
 * Sessione di test che PORTA AVANTI i cookie.
 *
 * E' essenziale, non comodo: la verifica TOTP ruota il token (SEC-06), e un
 * second tentativo fatto con il cookie oldToken verrebbe rifiutato perche' la
 * sessione non esiste piu' — non perche' il codice sia stato riusato. Il test
 * passerebbe per il motivo wrong, cioe' non proverebbe nulla.
 */
async function signInAndEnroll(user: { email: string; password: string }) {
  const signIn = await t.app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: sameOriginHeaders(),
    payload: { email: user.email, password: user.password },
  });
  let jar = cookies(signIn.headers['set-cookie']);

  const enable = await t.app.inject({
    method: 'POST',
    url: '/api/auth/two-factor/enable',
    headers: sameOriginHeaders({ cookie: header(jar), 'x-csrf-token': jar['__Host-metamc_csrf'] ?? '' }),
    payload: { password: user.password },
  });
  jar = { ...jar, ...cookies(enable.headers['set-cookie']) };
  const { totpURI } = enable.json() as { totpURI: string };

  const verify = async (code: string) => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/two-factor/verify-totp',
      headers: sameOriginHeaders({ cookie: header(jar), 'x-csrf-token': jar['__Host-metamc_csrf'] ?? '' }),
      payload: { code },
    });
    // I cookie emessi si tengono: e' quel che fa un browser.
    jar = { ...jar, ...cookies(res.headers['set-cookie']) };
    return res;
  };

  return {
    secret: secretFromOtpauthUri(totpURI),
    verify,
    jar: () => jar,
  };
}

describe('SEC-11 / test 7 — anti-replay TOTP', () => {
  it('lo stesso codice presentato due volte: la seconda e` rifiutata', async () => {
    const user = await seedUser(t, { roleKey: 'moderatore' });
    const s = await signInAndEnroll(user);
    const code = totpNow(s.secret);

    expect((await s.verify(code)).statusCode).toBe(200);
    // La sessione e` quella NUOVA, ruotata dalla prima verifica: il rifiuto
    // che segue e` della guardia anti-replay, non di un cookie scaduto.
    expect((await s.verify(code)).statusCode).toBe(401);
  });

  it('la seconda presentazione e` indistinguibile da un codice wrong', async () => {
    const user = await seedUser(t, { roleKey: 'moderatore' });
    const s = await signInAndEnroll(user);
    const code = totpNow(s.secret);

    await s.verify(code);
    const replay = await s.verify(code);
    const wrong = await s.verify('000000');

    // Dire "questo codice era gia' stato usato" confermerebbe che il codice
    // era giusto: e' un oracolo, e va chiuso.
    expect(replay.statusCode).toBe(wrong.statusCode);
    expect(replay.body).toBe(wrong.body);
  });

  it('anche i codici degli step ADIACENTI della finestra sono bruciati', async () => {
    const user = await seedUser(t, { roleKey: 'moderatore' });
    const s = await signInAndEnroll(user);
    const step = currentStep();

    expect((await s.verify(totpAt(s.secret, step))).statusCode).toBe(200);

    // Con window=1 il codice dello step precedente e quello successivo
    // sarebbero accettabili dal verificatore. A rifiutarli e' la regola
    // monotona su Postgres — `last_totp_step >= step corrente` — non la
    // marcatura in Redis, che oggi riguarda il singolo codice speso.
    for (const delta of [-1, 1]) {
      expect((await s.verify(totpAt(s.secret, step + delta))).statusCode).toBe(401);
    }
  });

  it('la guardia sopravvive alla perdita di Redis, grazie a last_totp_step', async () => {
    const user = await seedUser(t, { roleKey: 'moderatore' });
    const s = await signInAndEnroll(user);
    const code = totpNow(s.secret);
    expect((await s.verify(code)).statusCode).toBe(200);

    // Redis svuotato: senza la colonna durevole, tutti i codici della finestra
    // tornerebbero spendibili.
    const client = t.redis.client();
    const keys = await client.keys(`totp:used:${user.id}:*`);
    if (keys.length > 0) await client.del(...keys);
    await client.quit().catch(() => undefined);

    expect((await s.verify(code)).statusCode).toBe(401);
  });

  it('last_totp_step registra lo step consumato', async () => {
    const user = await seedUser(t, { roleKey: 'moderatore' });
    const s = await signInAndEnroll(user);

    // Lo step si racchiude fra due letture, prima e dopo la verifica.
    //
    // markUsed() scrive currentStep() calcolato SUL SERVER nell'istante della
    // verifica, non lo step a cui appartiene il codice. Confrontarlo con un
    // currentStep() riletto piu' tardi era una corsa: se il confine dei trenta
    // secondi cadeva nel mezzo, il test falliva su un codice corretto e su un
    // server corretto. Un test che fallisce a caso è peggio di un test
    // assente, perché insegna a ignorare il rosso.
    //
    // Quando nessun confine viene attraversato — il caso normale — before e
    // after coincidono e l'asserzione resta l'uguaglianza esatta di prima.
    const before = currentStep();
    const res = await s.verify(totpAt(s.secret, before));
    const after = currentStep();
    expect(res.statusCode).toBe(200);

    const row = await t.ctx.db
      .selectFrom('auth.user')
      .select('last_totp_step')
      .where('id', '=', user.id)
      .executeTakeFirstOrThrow();
    const recorded = Number(row.last_totp_step);
    expect(recorded).toBeGreaterThanOrEqual(before);
    expect(recorded).toBeLessThanOrEqual(after);
  });

  it('un codice del PASSATO remoto e` rifiutato per non-monotonia', async () => {
    const user = await seedUser(t, { roleKey: 'moderatore' });
    const s = await signInAndEnroll(user);
    expect((await s.verify(totpNow(s.secret))).statusCode).toBe(200);

    const client = t.redis.client();
    const keys = await client.keys(`totp:used:${user.id}:*`);
    if (keys.length > 0) await client.del(...keys);
    await client.quit().catch(() => undefined);

    expect((await s.verify(totpAt(s.secret, currentStep() - 10))).statusCode).toBe(401);
  });

  it('il tentativo bloccato finisce nell`audit come `denied`', async () => {
    const user = await seedUser(t, { roleKey: 'moderatore' });
    const s = await signInAndEnroll(user);
    const code = totpNow(s.secret);

    await s.verify(code);
    await s.verify(code);

    const rows = await t.ctx.db
      .selectFrom('audit.audit_log')
      .select(['action', 'outcome'])
      .where('action', '=', 'auth.2fa.replay_blocked')
      .where('actor_user_id', '=', user.id)
      .execute();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.outcome).toBe('denied');
  });
});

describe('SEC-06 / test 8 — il token di sessione cambia dopo il 2FA', () => {
  it('il token DOPO la verifica TOTP e` diverso da quello PRIMA', async () => {
    const user = await seedUser(t, { roleKey: 'moderatore' });
    const s = await signInAndEnroll(user);
    const tokenPrima = s.jar()['__Host-metamc_session'];
    expect(tokenPrima).toBeDefined();

    expect((await s.verify(totpNow(s.secret))).statusCode).toBe(200);

    const tokenDopo = s.jar()['__Host-metamc_session'];
    expect(tokenDopo).toBeDefined();
    expect(tokenDopo).not.toBe(tokenPrima);
  });

  it('anche il token CSRF cambia, perche` e` derivato dall`id di sessione', async () => {
    const user = await seedUser(t, { roleKey: 'moderatore' });
    const s = await signInAndEnroll(user);
    const csrfPrima = s.jar()['__Host-metamc_csrf'];

    await s.verify(totpNow(s.secret));

    const csrfDopo = s.jar()['__Host-metamc_csrf'];
    expect(csrfDopo).toBeDefined();
    expect(csrfDopo).not.toBe(csrfPrima);
  });

  it('il token oldToken non vale piu` dopo la rotazione', async () => {
    const user = await seedUser(t, { roleKey: 'moderatore' });
    const s = await signInAndEnroll(user);
    const oldToken = s.jar()['__Host-metamc_session'];
    await s.verify(totpNow(s.secret));

    const res = await t.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: `__Host-metamc_session=${oldToken}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('un second login emette un token diverso dal first', async () => {
    const user = await seedUser(t, { roleKey: 'moderatore' });
    const first = await loginAs(t, user);
    await waitForNextTotpStep(t, user.id);
    const second = await loginAs(t, user);
    expect(second.sessionCookie).not.toBe(first.sessionCookie);
  });
});

describe('SEC-14 / test 14 — le rotte backup-code del plugin sono chiuse', () => {
  it('POST /api/auth/two-factor/verify-backup-code -> 404', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/two-factor/verify-backup-code',
      headers: sameOriginHeaders(),
      payload: { code: 'qualunque' },
    });
    // 404 e non 403: un 403 confermerebbe che l'endpoint esiste.
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/auth/two-factor/generate-backup-codes -> 404', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/two-factor/generate-backup-codes',
      headers: sameOriginHeaders(),
      payload: { password: 'qualunque' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('il 404 vale anche per un utente autenticato: non e` un problema di permessi', async () => {
    const user = await seedUser(t, { roleKey: 'admin' });
    const actor = await loginAs(t, user);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/two-factor/verify-backup-code',
      headers: actor.headers(),
      payload: { code: 'qualunque' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('il 404 vale anche con lo slash finale', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/two-factor/verify-backup-code/',
      headers: sameOriginHeaders(),
      payload: { code: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('SEC-11 — la guardia vieta il CODICE, non la finestra', () => {
  // Questi girano sulla guardia con un istante iniettato: la proprieta' e'
  // sui secondi che passano, e farli passare davvero renderebbe il test lento
  // e a rischio di sfiorare un confine di step per caso.

  it('lo stesso codice non passa due volte, per tutta la sua durata', async () => {
    const user = await seedUser(t, { roleKey: 'moderatore' });
    const at = Date.now();

    await t.ctx.totpGuard.markUsed(user.id, '123456', at);

    // Subito, e a uno e due step di distanza: sempre lo stesso codice.
    for (const delta of [0, 30_000, 60_000]) {
      const v = await t.ctx.totpGuard.check(user.id, '123456', at + delta);
      expect(v.allowed, `riaccettato dopo ${delta / 1000}s`).toBe(false);
    }
  });

  it('un codice DIVERSO passa allo step successivo: niente attesa di 90 secondi', async () => {
    const user = await seedUser(t, { roleKey: 'moderatore' });
    const at = Date.now();

    await t.ctx.totpGuard.markUsed(user.id, '111111', at);

    // Nello stesso step resta bloccato, e non dalla marcatura: e' la regola
    // monotona, che vale mezzo minuto ed e' il prezzo dichiarato.
    const sameStep = await t.ctx.totpGuard.check(user.id, '222222', at);
    expect(sameStep.allowed).toBe(false);
    expect(sameStep.allowed === false && sameStep.reason).toBe('step_not_monotonic');

    // Allo step dopo, un codice nuovo deve passare. Prima marcavamo anche gli
    // step adiacenti, e questa riga falliva per altri sessanta secondi: chi si
    // disconnetteva e rientrava subito si vedeva rifiutare codici corretti con
    // il messaggio di un codice sbagliato.
    const nextStep = await t.ctx.totpGuard.check(user.id, '222222', at + 30_000);
    expect(nextStep.allowed, 'codice nuovo rifiutato allo step successivo').toBe(true);
  });

  it('due utenti non si bruciano il codice a vicenda', async () => {
    const uno = await seedUser(t, { roleKey: 'moderatore' });
    const due = await seedUser(t, { roleKey: 'moderatore' });
    const at = Date.now();

    await t.ctx.totpGuard.markUsed(uno.id, '424242', at);

    // Stesso codice, altra persona: l'impronta e' namespaced sull'utente.
    const v = await t.ctx.totpGuard.check(due.id, '424242', at);
    expect(v.allowed).toBe(true);
  });
});

describe('§10 — il registro dice CHI e entrato', () => {
  // Si legge cio' che il pannello mostra, cioe' il nome denormalizzato, non
  // l'id. La prima versione di questa correzione impostava il solo
  // `actor_user_id` e un controllo scritto sulla stessa colonna passava senza
  // accorgersi che in pagina restava «anonimo»: un test che verifica esattamente
  // cio' che hai appena scritto non puo' fallire.
  it('login e verifica 2FA riportano nome ed email di chi ha effettuato l accesso', async () => {
    const user = await seedUser(t, { roleKey: 'moderatore', name: 'Kryos' });
    await loginAs(t, user);

    const rows = await t.ctx.db
      .selectFrom('audit.audit_log')
      .select(['action', 'actor_user_id', 'actor_display_name', 'actor_email'])
      .where('action', 'in', ['auth.login.success', 'auth.2fa.success'])
      .where('actor_user_id', '=', user.id)
      .execute();

    const perAzione = new Map(rows.map((r) => [r.action, r]));
    for (const azione of ['auth.login.success', 'auth.2fa.success']) {
      const riga = perAzione.get(azione);
      expect(riga, `manca la riga ${azione}`).toBeDefined();
      expect(riga?.actor_display_name, `${azione} senza nome: in pagina sarebbe «anonimo»`).toBe('Kryos');
      expect(riga?.actor_email).toBe(user.email);
    }
  });

  it('un tentativo FALLITO resta anonimo: non e l elenco degli indirizzi provati', async () => {
    const user = await seedUser(t, { roleKey: 'moderatore' });

    await t.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: sameOriginHeaders(),
      payload: { email: user.email, password: 'password-sbagliata-ma-lunga' },
    });

    const rows = await t.ctx.db
      .selectFrom('audit.audit_log')
      .select(['actor_user_id', 'actor_display_name', 'actor_email'])
      .where('action', '=', 'auth.login.failure')
      .execute();

    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.actor_user_id).toBeNull();
      expect(r.actor_display_name).toBeNull();
      expect(r.actor_email).toBeNull();
    }
  });
});
