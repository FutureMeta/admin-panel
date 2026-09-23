// I ruoli si creano, si rinominano e si eliminano dal pannello (migration 024).
//
// LE COSE CHE SBAGLIANO IN SILENZIO SONO TRE, e hanno un test ciascuna:
//
//   - un ruolo eliminato che si puo' ancora assegnare. Non ha piu' permessi,
//     quindi «non da' niente» — e proprio per questo passerebbe il controllo
//     di concedibilita', che guarda solo cosa da';
//   - un ruolo eliminato mentre qualcuno ce l'ha, o mentre un invito lo
//     offre: toglierebbe l'accesso a persone che nessuno ha guardato;
//   - l'owner rinominato o eliminato (SEC-09).

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { roleKeyOf } from '#src/http/routes/roles.ts';
import { loginAs, seedUser } from '#tests/support/actors.ts';
import { startTestApp, type TestApp } from '#tests/support/app.ts';
import { roleIdByKey } from '#tests/support/fixtures.ts';

let t: TestApp;
let owner: Awaited<ReturnType<typeof loginAs>>;
let admin: Awaited<ReturnType<typeof loginAs>>;
let member = '';

beforeAll(async () => {
  t = await startTestApp({ label: 'roles-lifecycle' });
  owner = await loginAs(t, await seedUser(t, { email: 'owner-ruoli@metamc.it', roleKey: 'owner' }));
  admin = await loginAs(t, await seedUser(t, { email: 'admin-ruoli@metamc.it', roleKey: 'admin' }));
  member = (await seedUser(t, { email: 'membro-ruoli@metamc.it' })).id;
}, 180_000);

afterAll(async () => {
  await t?.close();
});

type Actor = Awaited<ReturnType<typeof loginAs>>;
const call = (
  actor: Actor,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT',
  url: string,
  payload?: object,
) =>
  t.app.inject({
    method,
    url,
    headers: method === 'GET' ? actor.cookieOnly() : actor.headers(),
    ...(payload === undefined ? {} : { payload }),
  });

async function liveRoles(): Promise<Array<{ id: number; key: string; name: string }>> {
  return (await call(owner, 'GET', '/api/roles')).json().roles;
}

async function lastAudit(action: string) {
  const res = await sql<{ outcome: string; before: unknown; after: unknown; target_label: string }>`
    SELECT outcome, before, after, target_label FROM audit.audit_log WHERE action = ${action} ORDER BY id DESC LIMIT 1
  `.execute(t.ctx.db);
  return res.rows[0];
}

describe('la chiave di un ruolo nuovo', () => {
  it('viene dal nome, senza accenti, e non si ripete', () => {
    expect(roleKeyOf('Staff Eventi', new Set())).toBe('staff_eventi');
    expect(roleKeyOf('Città  del Build!', new Set())).toBe('citta_del_build');
    expect(roleKeyOf('Staff Eventi', new Set(['staff_eventi', 'staff_eventi_2']))).toBe('staff_eventi_3');
    expect(roleKeyOf('★★★', new Set())).toBe('ruolo');
  });
});

describe('creare un ruolo', () => {
  it('nasce vuoto, in fondo, e va a registro', async () => {
    const res = await call(owner, 'POST', '/api/roles', { name: '  Staff   Eventi ' });
    expect(res.statusCode).toBe(201);
    const created = res.json();
    expect(created).toMatchObject({ key: 'staff_eventi', name: 'Staff Eventi' });

    const roles = await liveRoles();
    expect(roles.at(-1)).toMatchObject({ id: created.id, name: 'Staff Eventi' });
    const permissions = (await call(owner, 'GET', '/api/roles')).json().permissions;
    expect(permissions.filter((p: { role_id: number }) => p.role_id === created.id)).toEqual([]);

    expect(await lastAudit('role.create')).toMatchObject({
      outcome: 'success',
      target_label: 'Staff Eventi',
      after: { key: 'staff_eventi', name: 'Staff Eventi' },
    });
  });

  it('un nome gia` usato, maiuscole a parte, e` 409', async () => {
    const res = await call(owner, 'POST', '/api/roles', { name: 'staff eventi' });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('NOME_IN_USO');
  });

  it('un nome di un carattere solo e` 400', async () => {
    const res = await call(owner, 'POST', '/api/roles', { name: ' x ' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('NOME_NON_VALIDO');
  });

  it('serve «Gestione» su Ruoli: l`admin ha «Scrittura» e non crea', async () => {
    const res = await call(admin, 'POST', '/api/roles', { name: 'Tentativo' });
    expect(res.statusCode).toBe(403);
    expect((await liveRoles()).some((r) => r.name === 'Tentativo')).toBe(false);
  });
});

describe('rinominare un ruolo', () => {
  it('cambia il nome, non la chiave, e il registro ha prima e dopo', async () => {
    const id = await roleIdByKey(t.ctx.db, 'staff_eventi');
    expect((await call(owner, 'PATCH', `/api/roles/${id}`, { name: 'Staff Tornei' })).statusCode).toBe(200);
    expect((await liveRoles()).find((r) => r.id === id)).toMatchObject({
      key: 'staff_eventi',
      name: 'Staff Tornei',
    });
    expect(await lastAudit('role.rename')).toMatchObject({
      before: { name: 'Staff Eventi' },
      after: { name: 'Staff Tornei' },
    });
  });

  it('non con il nome di un altro ruolo', async () => {
    const id = await roleIdByKey(t.ctx.db, 'staff_eventi');
    const res = await call(owner, 'PATCH', `/api/roles/${id}`, { name: 'Moderatore' });
    expect(res.statusCode).toBe(409);
  });

  it('l`owner no: SEC-09', async () => {
    const id = await roleIdByKey(t.ctx.db, 'owner');
    const res = await call(owner, 'PATCH', `/api/roles/${id}`, { name: 'Capo' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('RUOLO_DI_SISTEMA');
  });
});

describe('eliminare un ruolo', () => {
  it('non se qualcuno ce l`ha', async () => {
    const id = await roleIdByKey(t.ctx.db, 'staff_eventi');
    expect((await call(owner, 'POST', `/api/users/${member}/roles`, { roleId: id })).statusCode).toBe(200);

    const res = await call(owner, 'DELETE', `/api/roles/${id}`);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('RUOLO_ASSEGNATO');

    expect((await call(owner, 'DELETE', `/api/users/${member}/roles/${id}`)).statusCode).toBe(200);
  });

  it('non se un invito ancora valido lo offre', async () => {
    const id = await roleIdByKey(t.ctx.db, 'staff_eventi');
    const invite = await t.ctx.db
      .insertInto('auth.invitation')
      .values({
        email_lower: 'invitato-ruoli@metamc.it',
        display_name: 'Invitato',
        token_hash: Buffer.alloc(32, 7),
        role_id: id,
        invited_by: owner.userId,
        expires_at: new Date(Date.now() + 3600_000),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const res = await call(owner, 'DELETE', `/api/roles/${id}`);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('RUOLO_IN_INVITI');

    // Un invito revocato resta nella storia, ma non blocca piu' niente.
    await t.ctx.db
      .updateTable('auth.invitation')
      .set({ revoked_at: new Date(), revoked_by: owner.userId })
      .where('id', '=', invite.id)
      .execute();
  });

  it('vuoto: sparisce, perde i permessi, e il registro dice quali aveva', async () => {
    const id = await roleIdByKey(t.ctx.db, 'staff_eventi');
    const statistiche = await t.ctx.db
      .selectFrom('auth.modules')
      .select('id')
      .where('key', '=', 'statistiche')
      .executeTakeFirstOrThrow();
    expect(
      (
        await call(owner, 'PUT', `/api/roles/${id}/permissions`, {
          entries: [{ moduleId: statistiche.id, level: 1 }],
        })
      ).statusCode,
    ).toBe(200);

    expect((await call(owner, 'DELETE', `/api/roles/${id}`)).statusCode).toBe(204);
    expect((await liveRoles()).some((r) => r.id === id)).toBe(false);
    const left = await t.ctx.db
      .selectFrom('auth.role_permissions')
      .select('module_id')
      .where('role_id', '=', id)
      .execute();
    expect(left).toEqual([]);
    expect(await lastAudit('role.delete')).toMatchObject({
      before: { key: 'staff_eventi', permissions: [{ module_id: statistiche.id, level: 1 }] },
    });
  });

  it('eliminato non si assegna piu`: ne` dalla scheda, ne` da un invito, ne` a mano', async () => {
    const id = await roleIdByKey(t.ctx.db, 'staff_eventi');
    const res = await call(owner, 'POST', `/api/users/${member}/roles`, { roleId: id });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('RUOLO_NON_CONCEDIBILE');

    const grantable = (await call(owner, 'GET', '/api/users/grantable-roles')).json();
    expect(JSON.stringify(grantable)).not.toContain('staff_eventi');

    // Il trigger della 024: vale anche per chi scrive senza passare dalle rotte.
    await expect(
      t.ctx.db.insertInto('auth.user_roles').values({ user_id: member, role_id: id }).execute(),
    ).rejects.toThrow(/ruolo eliminato/i);
  });

  it('e non torna; il suo nome si puo` riusare, con una chiave nuova', async () => {
    const id = await roleIdByKey(t.ctx.db, 'staff_eventi');
    await expect(
      t.ctx.db.updateTable('auth.roles').set({ deleted_at: null }).where('id', '=', id).execute(),
    ).rejects.toThrow(/non si ripristina/i);

    const again = await call(owner, 'POST', '/api/roles', { name: 'Staff Tornei' });
    expect(again.statusCode).toBe(201);
    expect(again.json().key).toBe('staff_tornei');
    const third = await call(owner, 'POST', '/api/roles', { name: 'Staff Eventi' });
    expect(third.json().key).toBe('staff_eventi_2');
  });

  it('l`owner no, nemmeno a mano', async () => {
    const id = await roleIdByKey(t.ctx.db, 'owner');
    expect((await call(owner, 'DELETE', `/api/roles/${id}`)).statusCode).toBe(400);
    await expect(
      t.ctx.db.updateTable('auth.roles').set({ deleted_at: new Date() }).where('id', '=', id).execute(),
    ).rejects.toThrow(/non e' cancellabile/i);
  });
});
