// I percorsi di sicurezza che nessun test percorreva. Audit di manutenibilita`,
// settembre 2026: reset della password, cambio email confermato e annullato,
// reset del 2FA a quattro occhi, sblocco, registro attivita`, pubblicazione
// delle configurazioni duels. Ognuno qui fa la strada intera — richiesta,
// email, token, effetto — e prova il rifiuto che conta.

import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createConfigPath } from '#src/duels/config-store.ts';
import { KEYS } from '#src/redis/client.ts';
import {
  type Actor,
  loginAs,
  type SeededUser,
  seedUser,
  waitForNextTotpStep,
} from '#tests/support/actors.ts';
import { sameOriginHeaders, startTestApp, type TestApp } from '#tests/support/app.ts';
import { totpNow } from '#tests/support/totp.ts';

let t: TestApp;
let ownerUser: SeededUser;
let owner: Actor;

beforeAll(async () => {
  t = await startTestApp({ label: 'security-routes' });
  ownerUser = await seedUser(t, { email: 'owner-sicurezza@metamc.it', roleKey: 'owner' });
  owner = await loginAs(t, ownerUser);
}, 300_000);

afterAll(async () => {
  await t?.close();
});

// Tanti login da un indirizzo solo — in `inject` e' sempre lo stesso — e il
// limite per IP (venti in cinque minuti) non e' cio' che questo file misura.
beforeEach(async () => {
  await t.ctx.rateLimit.reward('loginIp', '127.0.0.1');
});

/** Il token dentro l'ultimo link mandato a quell'indirizzo. */
function tokenIn(to: string, path: string): string {
  const mail = t.mailer.lastTo(to);
  const found = new RegExp(`${path}\\?t=([A-Za-z0-9_-]+)`).exec(`${mail?.text ?? ''} ${mail?.html ?? ''}`);
  if (!found?.[1]) throw new Error(`nessun link ${path} per ${to}`);
  return found[1];
}

const post = (url: string, payload: object, headers: Record<string, string> = sameOriginHeaders()) =>
  t.app.inject({ method: 'POST', url, headers, payload });
const signIn = (email: string, password: string) => post('/api/auth/sign-in/email', { email, password });
const me = (a: Actor) => t.app.inject({ method: 'GET', url: '/api/me', headers: a.cookieOnly() });
const tokenOf = (a: Actor) => decodeURIComponent(a.sessionCookie).split('.')[0] ?? '';

describe('password dimenticata', () => {
  it('il link cambia la password, chiude le sessioni, e vale una volta sola', async () => {
    const user = await seedUser(t, { roleKey: 'moderatore' });
    const actor = await loginAs(t, user);

    expect((await post('/api/account/forgot-password', { email: user.email })).statusCode).toBe(200);
    const token = tokenIn(user.email, '/reset');
    const newPassword = 'una-password-nuova-lunga-abbastanza';
    expect((await post('/api/account/reset-password', { token, password: newPassword })).statusCode).toBe(
      200,
    );

    // Le sessioni se ne vanno: su Postgres e nella copia di better-auth.
    expect((await me(actor)).statusCode).toBe(401);
    expect(await t.ctx.redis.exists(KEYS.authSession(tokenOf(actor)))).toBe(0);
    expect((await signIn(user.email, user.password)).statusCode).toBe(401);
    expect((await signIn(user.email, newPassword)).statusCode).toBe(200);

    const again = await post('/api/account/reset-password', {
      token,
      password: 'ancora-unaltra-password-lunga',
    });
    expect(again.statusCode).toBe(400);
  });

  it('un indirizzo che non esiste risponde uguale, e nessuna email parte', async () => {
    const before = t.mailer.sent.length;
    expect((await post('/api/account/forgot-password', { email: 'nessuno@metamc.it' })).statusCode).toBe(200);
    expect(t.mailer.sent.length).toBe(before);
  });

  it('una password compromessa non passa', async () => {
    const user = await seedUser(t, { roleKey: 'moderatore' });
    await post('/api/account/forgot-password', { email: user.email });
    t.hibp.mode = 'compromised';
    t.hibp.leaked.push('password-trapelata-ma-lunga');
    try {
      const res = await post('/api/account/reset-password', {
        token: tokenIn(user.email, '/reset'),
        password: 'password-trapelata-ma-lunga',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('PASSWORD_COMPROMISED');
    } finally {
      t.hibp.mode = 'clean';
      t.hibp.leaked.length = 0;
    }
  });
});

describe('cambio email: conferma e annullamento', () => {
  let user: SeededUser;
  let actor: Actor;
  const ask = async (email: string) => {
    await t.ctx.rateLimit.reward('twoFactorAccount', user.id);
    await waitForNextTotpStep(t, user.id);
    return post(
      '/api/account/email',
      { email, password: user.password, code: totpNow(actor.totpSecret) },
      actor.headers(),
    );
  };

  beforeAll(async () => {
    user = await seedUser(t, { roleKey: 'moderatore' });
    actor = await loginAs(t, user);
  });

  it('annullato dal vecchio indirizzo, il link di conferma non vale piu`', async () => {
    expect((await ask('annullato@metamc.it')).statusCode).toBe(200);
    const confirm = tokenIn('annullato@metamc.it', '/email-change');
    const cancel = tokenIn(user.email, '/email-change-cancel');

    expect((await post('/api/account/email/cancel', { token: cancel })).statusCode).toBe(200);
    expect((await post('/api/account/email/confirm', { token: confirm })).statusCode).toBe(400);
  });

  it('confermato dal nuovo, l`indirizzo cambia e le sessioni si chiudono', async () => {
    expect((await ask('confermato@metamc.it')).statusCode).toBe(200);
    const confirm = tokenIn('confermato@metamc.it', '/email-change');
    expect((await post('/api/account/email/confirm', { token: confirm })).statusCode).toBe(200);

    const row = await t.ctx.db
      .selectFrom('auth.user')
      .select('email')
      .where('id', '=', user.id)
      .executeTakeFirstOrThrow();
    expect(row.email).toBe('confermato@metamc.it');
    expect((await me(actor)).statusCode).toBe(401);
  });
});

describe('reset del 2FA a quattro occhi', () => {
  let secondo: Actor;
  let terzo: Actor;
  let target: SeededUser;

  beforeAll(async () => {
    secondo = await loginAs(t, await seedUser(t, { email: 'owner-due-sic@metamc.it', roleKey: 'owner' }));
    terzo = await loginAs(t, await seedUser(t, { email: 'owner-tre-sic@metamc.it', roleKey: 'owner' }));
    target = await seedUser(t, { roleKey: 'moderatore' });
    await loginAs(t, target);
  });

  const open = (by: Actor, id: string) =>
    post(
      '/api/two-factor-resets',
      { targetUserId: id, reason: 'telefono perso, verificato in call' },
      by.headers(),
    );
  const approve = (by: Actor, id: string) =>
    post(`/api/two-factor-resets/${id}/approve`, { verificationChannel: 'telefonata' }, by.headers());
  const execute = (by: Actor, id: string) => post(`/api/two-factor-resets/${id}/execute`, {}, by.headers());

  it('un admin non la apre: la procedura e` degli owner', async () => {
    const admin = await loginAs(t, await seedUser(t, { roleKey: 'admin' }));
    const res = await open(admin, target.id);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('SOLO_OWNER');
  });

  it('due owner diversi dal richiedente, poi il ritardo, poi l`esecuzione', async () => {
    const opened = await open(owner, target.id);
    expect(opened.statusCode).toBe(201);
    const id = opened.json().id as string;

    expect((await approve(owner, id)).json().code).toBe('IL_RICHIEDENTE_NON_APPROVA');
    expect((await approve(secondo, id)).statusCode).toBe(200);
    expect((await approve(secondo, id)).json().code).toBe('HAI_GIA_APPROVATO');
    expect((await execute(owner, id)).json().code).toBe('APPROVAZIONI_INSUFFICIENTI');
    expect((await approve(terzo, id)).statusCode).toBe(200);
    // Ventiquattro ore: si spostano, non si aspettano.
    expect((await execute(owner, id)).json().code).toBe('RITARDO_NON_TRASCORSO');
    await t.ctx.db
      .updateTable('auth.two_factor_reset')
      .set({ effective_at: new Date(Date.now() - 1_000) })
      .where('id', '=', id)
      .execute();

    expect((await execute(owner, id)).statusCode).toBe(200);
    const row = await t.ctx.db
      .selectFrom('auth.user')
      .select(['status', 'twoFactorEnabled'])
      .where('id', '=', target.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: 'pending_onboarding', twoFactorEnabled: false });
    const factors = await t.ctx.db
      .selectFrom('auth.twoFactor')
      .select('id')
      .where('userId', '=', target.id)
      .execute();
    expect(factors).toEqual([]);
  });

  it('annullata da un owner, non si approva piu`', async () => {
    const other = await seedUser(t, { roleKey: 'moderatore' });
    const id = (await open(owner, other.id)).json().id as string;
    expect((await post(`/api/two-factor-resets/${id}/cancel`, {}, secondo.headers())).statusCode).toBe(200);
    expect((await approve(terzo, id)).statusCode).toBe(404);
  });
});

describe('sblocco', () => {
  it('toglie il ban e si rientra; sopra di se` non si sblocca nessuno', async () => {
    const user = await seedUser(t, { roleKey: 'moderatore' });
    const banned = await loginAs(t, user);
    expect(
      (await post(`/api/users/${user.id}/ban`, { reason: 'prova di sblocco' }, owner.headers())).statusCode,
    ).toBe(200);
    // Il ban lo applica il pannello sulla sessione: la password risponde
    // ancora con la challenge del 2FA, ma dentro non si entra.
    expect((await me(banned)).statusCode).toBe(401);

    expect((await post(`/api/users/${user.id}/unban`, {}, owner.headers())).statusCode).toBe(200);
    const row = await t.ctx.db
      .selectFrom('auth.user')
      .select('banned')
      .where('id', '=', user.id)
      .executeTakeFirstOrThrow();
    expect(row.banned).toBe(false);
    await loginAs(t, user);

    // Un admin non domina un owner: la risposta e` un «non c'e`» (SEC-31).
    const admin = await loginAs(t, await seedUser(t, { roleKey: 'admin' }));
    expect((await post(`/api/users/${ownerUser.id}/unban`, {}, admin.headers())).statusCode).toBe(404);
  });
});

describe('registro attivita`', () => {
  it('senza il modulo niente, e i filtri filtrano', async () => {
    const nessuno = await loginAs(t, await seedUser(t, {}));
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/audit', headers: nessuno.cookieOnly() })).statusCode,
    ).toBe(403);

    const res = await t.app.inject({
      method: 'GET',
      url: '/api/audit?action=user.unbanned',
      headers: owner.cookieOnly(),
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().entries as Array<{ action: string }>;
    expect(items.length).toBeGreaterThan(0);
    expect(new Set(items.map((i) => i.action))).toEqual(new Set(['user.unbanned']));
  });

  it('l`integrita` della catena la guarda solo chi gestisce il registro', async () => {
    const admin = await loginAs(t, await seedUser(t, { roleKey: 'admin' }));
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/audit/integrity', headers: admin.cookieOnly() }))
        .statusCode,
    ).toBe(403);
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/audit/integrity',
      headers: owner.cookieOnly(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });
});

describe('pubblicazione delle configurazioni duels', () => {
  it('serve il livello 3; pubblicare sposta la bozza e va a registro', async () => {
    await createConfigPath(t.ctx.db, {
      path: 'arenas/sicurezza.yml',
      modules: ['lobby'],
      author: 'test@metamc.it',
    });
    const version = await sql<{ id: number }>`
      SELECT v.id FROM stats.duels_config_version v
        JOIN stats.duels_config_path p ON p.id = v.path_id WHERE p.path = 'arenas/sicurezza.yml'
    `.execute(t.ctx.db);
    const versionId = version.rows[0]?.id as number;

    const dev = await loginAs(t, await seedUser(t, { roleKey: 'dev' }));
    const draft = await t.app.inject({
      method: 'PUT',
      url: '/api/duels/config/draft',
      headers: dev.headers(),
      payload: { versionId, content: 'arena: sicurezza\n' },
    });
    expect(draft.statusCode).toBe(200);
    // Il dev scrive bozze, ma in produzione non manda niente.
    expect((await post('/api/duels/config/publish', {}, dev.headers())).statusCode).toBe(403);

    const res = await post('/api/duels/config/publish', {}, owner.headers());
    expect(res.statusCode).toBe(200);
    expect(res.json().files).toBe(1);
    const row = await sql<{ published: string | null; draft: string | null }>`
      SELECT published, draft FROM stats.duels_config_version WHERE id = ${versionId}
    `.execute(t.ctx.db);
    expect(row.rows[0]).toEqual({ published: 'arena: sicurezza\n', draft: null });
    const audit = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM audit.audit_log WHERE action = 'duels.config.publish'
    `.execute(t.ctx.db);
    expect(audit.rows[0]?.n).toBe(1);
  });
});
