// §14 test 5 — un invito non puo' concedere, su nessun modulo, un livello
//              superiore a quello dell'invitante.  SEC-07
// §14 test 6 — un admin non puo' modificare i permessi ne' bannare un utente
//              che lo domina su almeno un modulo.  SEC-08
// §14 test 4 — un declassamento ha effetto alla richiesta successiva
//              (permissions_version).
//
// Qui le proprieta' sono verificate al livello in cui vivono: le due query del
// §7 e i trigger di invalidazione. Il livello HTTP le riverifica sulle rotte.

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canGrantLevel, canGrantRole, dominates, grantableRoles } from '#src/authz/dominance.ts';
import { readPermissions } from '#src/authz/store.ts';
import { createKysely, createPool, type Database } from '#src/db/pool.ts';
import {
  createUser,
  grantOverride,
  grantRole,
  moduleIdByKey,
  permissionsVersion,
  revokeRole,
  roleIdByKey,
  userWithRole,
} from '#tests/support/fixtures.ts';
import { createTestDatabase, type TestDatabase } from '#tests/support/postgres.ts';

let testDb: TestDatabase;
let pool: pg.Pool;
let db: Database;

let owner = '';
let admin = '';
let dev = '';
let moderator = '';

beforeAll(async () => {
  testDb = await createTestDatabase('escalation');
  pool = createPool({ connectionString: testDb.appUrl, applicationName: 'metamc-test' });
  db = createKysely(pool);

  owner = await userWithRole(db, 'owner', 'owner@metamc.it');
  admin = await userWithRole(db, 'admin', 'admin@metamc.it');
  dev = await userWithRole(db, 'dev', 'dev@metamc.it');
  moderator = await userWithRole(db, 'moderatore', 'mod@metamc.it');
}, 180_000);

afterAll(async () => {
  await db?.destroy().catch(() => undefined);
  await testDb?.drop();
});

describe('il seed della matrice regge le proprieta` che i test misurano', () => {
  it('owner ha 3 su tutti e otto i moduli', async () => {
    const p = await readPermissions(db, owner);
    expect(Object.values(p)).toHaveLength(8);
    expect(Object.values(p).every((l) => l === 3)).toBe(true);
  });

  it('admin NON ha 3 ovunque: altrimenti la dominanza sarebbe simmetrica', async () => {
    const p = await readPermissions(db, admin);
    expect(Object.values(p).some((l) => l < 3)).toBe(true);
  });

  it('l`override individuale e` solo in aumento: GREATEST(ruolo, override)', async () => {
    const before = await readPermissions(db, moderator);
    expect(before.statistiche).toBe(1);

    await grantOverride(db, moderator, 'statistiche', 3);
    expect((await readPermissions(db, moderator)).statistiche).toBe(3);

    // Un override PIU` BASSO del ruolo non declassa: non esiste semantica di deny.
    await grantOverride(db, moderator, 'statistiche', 0);
    expect((await readPermissions(db, moderator)).statistiche).toBe(1);

    await db.deleteFrom('auth.user_permissions').where('user_id', '=', moderator).execute();
  });

  it('un utente senza ruoli ha 0 ovunque, e i moduli ci sono comunque tutti', async () => {
    const roleless = await createUser(db, {});
    const p = await readPermissions(db, roleless);
    expect(Object.keys(p)).toHaveLength(8);
    expect(Object.values(p).every((l) => l === 0)).toBe(true);
  });
});

describe('SEC-08 / test 6 — dominanza attore->bersaglio', () => {
  it('owner domina tutti', async () => {
    for (const target of [admin, dev, moderator]) {
      expect(await dominates(db, owner, target)).toBe(true);
    }
  });

  it('un admin NON domina un owner: non puo` ne` declassarlo ne` bannarlo', async () => {
    expect(await dominates(db, admin, owner)).toBe(false);
  });

  it('admin domina dev e moderator', async () => {
    expect(await dominates(db, admin, dev)).toBe(true);
    expect(await dominates(db, admin, moderator)).toBe(true);
  });

  it('un moderator non domina un admin', async () => {
    expect(await dominates(db, moderator, admin)).toBe(false);
  });

  it('basta UN modulo in cui il bersaglio e` piu` alto per perdere la dominanza', async () => {
    const target = await createUser(db, {});
    await grantRole(db, target, 'moderatore');
    expect(await dominates(db, admin, target)).toBe(true);

    // Un solo override, su un solo modulo, sopra il livello dell'admin.
    await grantOverride(db, target, 'ruoli', 3); // admin ha 2 su `ruoli`
    expect(await dominates(db, admin, target)).toBe(false);

    // ...e l'owner continua a dominarlo, perche' ha 3 ovunque.
    expect(await dominates(db, owner, target)).toBe(true);
  });

  it('un utente domina se stesso (la dominanza e` riflessiva)', async () => {
    expect(await dominates(db, admin, admin)).toBe(true);
  });

  it('un attore inesistente non domina nessuno che abbia permessi', async () => {
    expect(await dominates(db, 'u_non_esiste', admin)).toBe(false);
  });

  it('chiunque "domina" un utente senza permessi: e` corretto, non c`e` nulla da superare', async () => {
    const roleless = await createUser(db, {});
    expect(await dominates(db, moderator, roleless)).toBe(true);
  });
});

describe('SEC-07 / test 5 — nessuno concede cio` che non ha', () => {
  it('owner puo` concedere ogni ruolo non di sistema', async () => {
    for (const key of ['admin', 'dev', 'moderatore']) {
      expect(await canGrantRole(db, owner, await roleIdByKey(db, key))).toBe(true);
    }
  });

  it('admin puo` concedere dev e moderator', async () => {
    expect(await canGrantRole(db, admin, await roleIdByKey(db, 'dev'))).toBe(true);
    expect(await canGrantRole(db, admin, await roleIdByKey(db, 'moderatore'))).toBe(true);
  });

  it('admin NON puo` concedere owner', async () => {
    expect(await canGrantRole(db, admin, await roleIdByKey(db, 'owner'))).toBe(false);
  });

  it('un moderator non puo` concedere admin ne` dev', async () => {
    expect(await canGrantRole(db, moderator, await roleIdByKey(db, 'admin'))).toBe(false);
    expect(await canGrantRole(db, moderator, await roleIdByKey(db, 'dev'))).toBe(false);
  });

  it('un dev non puo` concedere admin: basta un modulo in cui admin e` piu` alto', async () => {
    expect(await canGrantRole(db, dev, await roleIdByKey(db, 'admin'))).toBe(false);
  });

  it('grantableRoles non elenca MAI un ruolo di sistema, nemmeno per un owner', async () => {
    const roles = await grantableRoles(db, owner);
    expect(roles.length).toBeGreaterThan(0);
    expect(roles.map((r) => r.key)).not.toContain('owner');
  });

  it('grantableRoles per un admin non contiene ruoli che l`admin non domina', async () => {
    const roles = await grantableRoles(db, admin);
    for (const r of roles) {
      expect(await canGrantRole(db, admin, r.id)).toBe(true);
    }
  });

  it('grantableRoles per un moderator e` vuoto o solo di ruoli a livello suo', async () => {
    const roles = await grantableRoles(db, moderator);
    for (const r of roles) {
      expect(await canGrantRole(db, moderator, r.id)).toBe(true);
    }
    expect(roles.map((r) => r.key)).not.toContain('admin');
  });

  it('l`override individuale segue la stessa regola: nessuno concede oltre il proprio livello', async () => {
    const rolesModule = await moduleIdByKey(db, 'ruoli');
    // admin ha 2 su `ruoli`
    expect(await canGrantLevel(db, admin, rolesModule, 2)).toBe(true);
    expect(await canGrantLevel(db, admin, rolesModule, 3)).toBe(false);
    expect(await canGrantLevel(db, owner, rolesModule, 3)).toBe(true);
  });

  it('un attore che guadagna un livello guadagna anche la concedibilita`', async () => {
    const rolesModule = await moduleIdByKey(db, 'ruoli');
    expect(await canGrantLevel(db, dev, rolesModule, 1)).toBe(false); // dev ha 0 su ruoli
    await grantOverride(db, dev, 'ruoli', 2);
    expect(await canGrantLevel(db, dev, rolesModule, 2)).toBe(true);
    expect(await canGrantLevel(db, dev, rolesModule, 3)).toBe(false);
    await db.deleteFrom('auth.user_permissions').where('user_id', '=', dev).execute();
  });
});

describe('test 4 — permissions_version cambia a ogni modifica che tocca l`autorizzazione', () => {
  it('assegnare un ruolo alza la versione', async () => {
    const u = await createUser(db, {});
    const before = await permissionsVersion(db, u);
    await grantRole(db, u, 'moderatore');
    expect(await permissionsVersion(db, u)).toBeGreaterThan(before);
  });

  it('togliere un ruolo (declassamento) alza la versione', async () => {
    const u = await userWithRole(db, 'admin');
    const before = await permissionsVersion(db, u);
    await revokeRole(db, u, 'admin');
    expect(await permissionsVersion(db, u)).toBeGreaterThan(before);
    expect(Object.values(await readPermissions(db, u)).every((l) => l === 0)).toBe(true);
  });

  it('un override individuale alza la versione', async () => {
    const u = await createUser(db, {});
    const before = await permissionsVersion(db, u);
    await grantOverride(db, u, 'audit', 2);
    expect(await permissionsVersion(db, u)).toBeGreaterThan(before);
  });

  it('cambiare la matrice di un RUOLO alza la versione a TUTTI quelli che ce l`hanno', async () => {
    const a = await userWithRole(db, 'moderatore');
    const b = await userWithRole(db, 'moderatore');
    const unrelated = await userWithRole(db, 'dev');
    const [va, vb, ve] = [
      await permissionsVersion(db, a),
      await permissionsVersion(db, b),
      await permissionsVersion(db, unrelated),
    ];

    const modRole = await roleIdByKey(db, 'moderatore');
    const audit = await moduleIdByKey(db, 'audit');
    await db
      .updateTable('auth.role_permissions')
      .set({ level: 2 })
      .where('role_id', '=', modRole)
      .where('module_id', '=', audit)
      .execute();

    expect(await permissionsVersion(db, a)).toBeGreaterThan(va);
    expect(await permissionsVersion(db, b)).toBeGreaterThan(vb);
    // ...e a nessun altro.
    expect(await permissionsVersion(db, unrelated)).toBe(ve);
  });

  it('bannare alza la versione (il ban passa dallo stesso contatore)', async () => {
    const u = await userWithRole(db, 'moderatore');
    const before = await permissionsVersion(db, u);
    await db.updateTable('auth.user').set({ banned: true, ban_reason: 'test' }).where('id', '=', u).execute();
    expect(await permissionsVersion(db, u)).toBeGreaterThan(before);
  });

  it('il logout globale (sessions_valid_from) alza la versione', async () => {
    const u = await userWithRole(db, 'moderatore');
    const before = await permissionsVersion(db, u);
    await db.updateTable('auth.user').set({ sessions_valid_from: new Date() }).where('id', '=', u).execute();
    expect(await permissionsVersion(db, u)).toBeGreaterThan(before);
  });

  it('un UPDATE che non tocca l`autorizzazione NON alza la versione', async () => {
    const u = await userWithRole(db, 'moderatore');
    const before = await permissionsVersion(db, u);
    await db.updateTable('auth.user').set({ name: 'nome nuovo' }).where('id', '=', u).execute();
    expect(await permissionsVersion(db, u)).toBe(before);
  });
});

describe('SEC-09 — il ruolo di sistema e` protetto dal database, non solo dal codice', () => {
  it('la matrice di owner non e` modificabile', async () => {
    const ownerRole = await roleIdByKey(db, 'owner');
    const audit = await moduleIdByKey(db, 'audit');
    await expect(
      db
        .updateTable('auth.role_permissions')
        .set({ level: 0 })
        .where('role_id', '=', ownerRole)
        .where('module_id', '=', audit)
        .execute(),
    ).rejects.toThrow(/ruolo di sistema/i);
  });

  it('il ruolo owner non e` cancellabile', async () => {
    await expect(db.deleteFrom('auth.roles').where('key', '=', 'owner').execute()).rejects.toThrow(
      /ruolo di sistema/i,
    );
  });

  it('un invito non puo` puntare a un ruolo di sistema', async () => {
    await expect(
      db
        .insertInto('auth.invitation')
        .values({
          email_lower: 'tentativo@metamc.it',
          token_hash: Buffer.alloc(32, 1),
          role_id: await roleIdByKey(db, 'owner'),
          invited_by: owner,
          expires_at: new Date(Date.now() + 3600_000),
        })
        .execute(),
    ).rejects.toThrow(/ruolo di sistema/i);
  });
});
