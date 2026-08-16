// Fixture di dominio: utenti, ruoli, override. Costruiscono lo stato con le
// stesse tabelle e gli stessi trigger della produzione — nessuna scorciatoia
// che salti l'invalidazione di permissions_version, altrimenti i test
// verificherebbero un sistema che non esiste.

import { randomBytes } from 'node:crypto';
import type { ModuleKey } from '#src/authz/modules.ts';
import type { Database } from '#src/db/pool.ts';

export async function createUser(
  db: Database,
  opts: { email?: string; name?: string; status?: 'pending_onboarding' | 'active' | 'disabled' } = {},
): Promise<string> {
  const id = `u_${randomBytes(12).toString('hex')}`;
  const email = opts.email ?? `${id}@metamc.it`;
  await db
    .insertInto('auth.user')
    .values({
      id,
      name: opts.name ?? id,
      email,
      emailVerified: true,
      status: opts.status ?? 'active',
    })
    .execute();
  return id;
}

export async function roleIdByKey(db: Database, key: string): Promise<number> {
  const row = await db.selectFrom('auth.roles').select('id').where('key', '=', key).executeTakeFirst();
  if (!row) throw new Error(`ruolo inesistente: ${key}`);
  return row.id;
}

export async function moduleIdByKey(db: Database, key: ModuleKey): Promise<number> {
  const row = await db.selectFrom('auth.modules').select('id').where('key', '=', key).executeTakeFirst();
  if (!row) throw new Error(`modulo inesistente: ${key}`);
  return row.id;
}

export async function grantRole(db: Database, userId: string, roleKey: string): Promise<void> {
  await db
    .insertInto('auth.user_roles')
    .values({ user_id: userId, role_id: await roleIdByKey(db, roleKey) })
    .execute();
}

export async function revokeRole(db: Database, userId: string, roleKey: string): Promise<void> {
  await db
    .deleteFrom('auth.user_roles')
    .where('user_id', '=', userId)
    .where('role_id', '=', await roleIdByKey(db, roleKey))
    .execute();
}

export async function grantOverride(
  db: Database,
  userId: string,
  module: ModuleKey,
  level: number,
): Promise<void> {
  await db
    .insertInto('auth.user_permissions')
    .values({ user_id: userId, module_id: await moduleIdByKey(db, module), level })
    .onConflict((oc) => oc.columns(['user_id', 'module_id']).doUpdateSet({ level }))
    .execute();
}

export async function permissionsVersion(db: Database, userId: string): Promise<number> {
  const row = await db
    .selectFrom('auth.user')
    .select('permissions_version')
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!row) throw new Error(`utente inesistente: ${userId}`);
  return row.permissions_version;
}

/** Utente con un ruolo, pronto all'uso. */
export async function userWithRole(db: Database, roleKey: string, email?: string): Promise<string> {
  const id = await createUser(db, email ? { email } : {});
  await grantRole(db, id, roleKey);
  return id;
}
