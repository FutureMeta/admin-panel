// §14 test 3 — un utente bannato riceve 401 alla richiesta successiva ENTRO 1
// SECONDO.  SEC-02
//
// E' il test che giustifica l'intera chiave `authz:{userId}`. Con lo snapshot
// dentro il blob di sessione (il default di secondaryStorage) questo test
// fallirebbe per otto ore, cioe' per la durata del cookie.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, loginAs, seedUser, sessionOfActor } from '#tests/support/actors.ts';
import { startTestApp, type TestApp } from '#tests/support/app.ts';
import { describeRedisBackend } from '#tests/support/redis.ts';

let t: TestApp;

beforeAll(async () => {
  t = await startTestApp({ label: 'ban' });
  console.log(`  backend Redis: ${describeRedisBackend()}`);
}, 180_000);

afterAll(async () => {
  await t?.close();
});

async function meStatus(actor: Actor): Promise<number> {
  const res = await t.app.inject({
    method: 'GET',
    url: '/api/me',
    headers: { cookie: `__Host-metamc_session=${actor.sessionCookie}` },
  });
  return res.statusCode;
}

describe('SEC-02 — il ban cade entro un second', () => {
  it('una sessione valida accede', async () => {
    const user = await seedUser(t, { roleKey: 'moderatore' });
    const actor = await loginAs(t, user);
    expect(await meStatus(actor)).toBe(200);
  });

  it('bannare in Postgres + riscrivere authz -> 401 alla richiesta successiva, sotto 1 second', async () => {
    const user = await seedUser(t, { roleKey: 'moderatore' });
    const actor = await loginAs(t, user);
    expect(await meStatus(actor)).toBe(200);

    const t0 = Date.now();
    await t.ctx.db
      .updateTable('auth.user')
      .set({ banned: true, ban_reason: 'test di accettazione' })
      .where('id', '=', user.id)
      .execute();
    await t.ctx.store.invalidate(user.id);

    const status = await meStatus(actor);
    const elapsed = Date.now() - t0;

    expect(status).toBe(401);
    expect(elapsed).toBeLessThan(1000);
  });

  it('un ban SCADUTO non blocca piu`', async () => {
    const user = await seedUser(t, { roleKey: 'moderatore' });
    const actor = await loginAs(t, user);

    await t.ctx.db
      .updateTable('auth.user')
      .set({
        banned: true,
        ban_reason: 'temporaneo',
        ban_expires: new Date(Date.now() - 60_000),
      })
      .where('id', '=', user.id)
      .execute();
    await t.ctx.store.invalidate(user.id);

    // banned=true ma scaduto: l'accesso torna a funzionare senza che nessuno
    // debba ricordarsi di rimettere il flag a false.
    expect(await meStatus(actor)).toBe(200);
  });

  it('un ban FUTURO blocca', async () => {
    const user = await seedUser(t, { roleKey: 'moderatore' });
    const actor = await loginAs(t, user);
    await t.ctx.db
      .updateTable('auth.user')
      .set({ banned: true, ban_reason: 'x', ban_expires: new Date(Date.now() + 3_600_000) })
      .where('id', '=', user.id)
      .execute();
    await t.ctx.store.invalidate(user.id);
    expect(await meStatus(actor)).toBe(401);
  });

  it('status != active blocca anche senza ban', async () => {
    const user = await seedUser(t, { roleKey: 'moderatore' });
    const actor = await loginAs(t, user);
    await t.ctx.db.updateTable('auth.user').set({ status: 'disabled' }).where('id', '=', user.id).execute();
    await t.ctx.store.invalidate(user.id);
    expect(await meStatus(actor)).toBe(401);
  });

  it('il logout globale (sessions_valid_from) invalida le sessioni gia` aperte', async () => {
    const user = await seedUser(t, { roleKey: 'moderatore' });
    const actor = await loginAs(t, user);
    expect(await meStatus(actor)).toBe(200);

    await t.ctx.authz.revokeAllSessions(user.id);
    expect(await meStatus(actor)).toBe(401);
  });

  it('la revoca PUNTUALE di una sessione non tocca le altre', async () => {
    const user = await seedUser(t, { roleKey: 'moderatore' });
    const first = await loginAs(t, user);
    const second = await loginAs(t, user);
    expect(first.sessionCookie).not.toBe(second.sessionCookie);

    // La sessione da revocare si risolve dal COOKIE, non prendendo "la prima
    // per createdAt": l'enrollment ne ha lasciata un'altra, e revocare quella
    // farebbe passare il test per il motivo sbagliato.
    const target = await sessionOfActor(t, first);
    await t.ctx.authz.revokeSession(target.id, target.expiresAt);

    expect(await meStatus(first)).toBe(401);
    expect(await meStatus(second)).toBe(200);
  });

  it('se authz:{userId} sparisce da Redis viene ricostruita da Postgres, e il ban resta', async () => {
    const user = await seedUser(t, { roleKey: 'moderatore' });
    const actor = await loginAs(t, user);

    await t.ctx.db
      .updateTable('auth.user')
      .set({ banned: true, ban_reason: 'x' })
      .where('id', '=', user.id)
      .execute();
    await t.ctx.store.invalidate(user.id);

    // Cancellare la chiave e' il caso "Redis riavviato": la ricostruzione
    // avviene da Postgres, che e' la fonte di verita'.
    const client = t.redis.client();
    await client.del(`authz:${user.id}`);
    expect(await t.ctx.store.peek(user.id)).toBeUndefined();

    expect(await meStatus(actor)).toBe(401);
    // ...e la chiave e' tornata al suo posto.
    expect(await t.ctx.store.peek(user.id)).toBeDefined();
    await client.quit().catch(() => undefined);
  });

  it('una sessione con aal < 2 non accede al pannello', async () => {
    const user = await seedUser(t, { roleKey: 'moderatore' });
    const actor = await loginAs(t, user);
    await t.ctx.db.updateTable('auth.session').set({ aal: 1 }).where('userId', '=', user.id).execute();
    expect(await meStatus(actor)).toBe(401);
  });
});
