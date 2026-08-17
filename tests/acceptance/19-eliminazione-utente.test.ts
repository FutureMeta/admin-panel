// Eliminazione di un utente. §8.10
//
// Le tre proprieta' che rendono l'operazione diversa da un offboarding, e che
// una schermata non puo' garantire da sola:
//
//   1. le credenziali spariscono davvero — password, secondo fattore, codici
//      di recupero. E' cio' che rende l'account non recuperabile.
//   2. non si torna indietro: il trigger rifiuta di azzerare `deleted_at`.
//      La monotonia sta nel database, non nella buona volonta' di chi scrive
//      la query, come per gli inviti consumati.
//   3. la riga sopravvive, e con lei la storia degli inviti: `invited_by` e'
//      NOT NULL, e un DELETE vero costringerebbe a perdere «chi ha fatto
//      entrare chi».

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKysely, createPool, type Database } from '#src/db/pool.ts';
import { createUser, roleIdByKey, userWithRole } from '#tests/support/fixtures.ts';
import { createTestDatabase, type TestDatabase } from '#tests/support/postgres.ts';

let testDb: TestDatabase;
let pool: pg.Pool;
let db: Database;

beforeAll(async () => {
  testDb = await createTestDatabase('eliminazione');
  pool = createPool({ connectionString: testDb.appUrl, applicationName: 'metamc-test' });
  db = createKysely(pool);
}, 180_000);

afterAll(async () => {
  await db?.destroy().catch(() => undefined);
  await testDb?.drop();
});

/**
 * Segna una riga come eliminata, come fa la rotta.
 *
 * `ban_reason` non e' decorazione: il vincolo `user_ban_coerente` rifiuta un
 * ban senza motivo, ed e' giusto — un ban anonimo nel registro non dice
 * niente a chi lo legge sei mesi dopo.
 */
async function markDeleted(userId: string, reason = 'test'): Promise<void> {
  await db
    .updateTable('auth.user')
    .set({ deleted_at: new Date(), banned: true, status: 'disabled', ban_reason: reason })
    .where('id', '=', userId)
    .execute();
}

describe('eliminazione utente', () => {
  it('un utente eliminato non si ripristina: lo impedisce il trigger', async () => {
    const id = await createUser(db, { email: `eliminato${Date.now()}@metamc.it` });
    await markDeleted(id);

    await expect(
      db.updateTable('auth.user').set({ deleted_at: null }).where('id', '=', id).execute(),
    ).rejects.toThrow(/non si ripristina/i);

    // Nemmeno spostandola in avanti: qualunque valore diverso e' rifiutato.
    await expect(
      db
        .updateTable('auth.user')
        .set({ deleted_at: new Date(Date.now() + 60_000) })
        .where('id', '=', id)
        .execute(),
    ).rejects.toThrow(/non si ripristina/i);
  });

  it('le altre colonne restano modificabili dopo l`eliminazione', async () => {
    // Il trigger scatta su UPDATE OF deleted_at: se scattasse su ogni UPDATE,
    // la riga diventerebbe intoccabile e non si potrebbe piu' nemmeno
    // annotare nulla. E' lo stesso errore della migration 005.
    const id = await createUser(db, { email: `annotabile${Date.now()}@metamc.it` });
    await markDeleted(id);
    await expect(
      db.updateTable('auth.user').set({ ban_reason: 'nota' }).where('id', '=', id).execute(),
    ).resolves.toBeDefined();
  });

  it('la riga sopravvive e con lei la storia degli inviti', async () => {
    const inviter = await createUser(db, { email: `invitante${Date.now()}@metamc.it` });
    const roleId = await roleIdByKey(db, 'moderatore');
    await db
      .insertInto('auth.invitation')
      .values({
        email_lower: `invitato${Date.now()}@metamc.it`,
        display_name: 'Invitato',
        token_hash: Buffer.alloc(32, 7),
        role_id: roleId,
        invited_by: inviter,
        expires_at: new Date(Date.now() + 3600_000),
      })
      .execute();

    await markDeleted(inviter);

    const invite = await db
      .selectFrom('auth.invitation')
      .select('invited_by')
      .where('invited_by', '=', inviter)
      .executeTakeFirst();
    expect(invite?.invited_by).toBe(inviter);

    // Ed e' anche il motivo per cui un DELETE vero non e' un'opzione.
    await expect(db.deleteFrom('auth.user').where('id', '=', inviter).execute()).rejects.toThrow(
      /violates foreign key|invitation/i,
    );
  });

  it('un eliminato sparisce dagli elenchi ma resta interrogabile per id', async () => {
    const id = await createUser(db, { email: `sparito${Date.now()}@metamc.it` });
    await markDeleted(id);

    const listed = await db
      .selectFrom('auth.user')
      .select('id')
      .where('deleted_at', 'is', null)
      .where('id', '=', id)
      .executeTakeFirst();
    expect(listed).toBeUndefined();

    const byId = await db.selectFrom('auth.user').select('id').where('id', '=', id).executeTakeFirst();
    expect(byId?.id).toBe(id);
  });

  it('owner: ne devono restare due, e il conteggio ignora gli eliminati', async () => {
    const a = await userWithRole(db, 'owner', `owner-a${Date.now()}@metamc.it`);
    const b = await userWithRole(db, 'owner', `owner-b${Date.now()}@metamc.it`);

    const activeOwners = async () =>
      (
        await db
          .selectFrom('auth.user_roles as ur')
          .innerJoin('auth.roles as r', 'r.id', 'ur.role_id')
          .innerJoin('auth.user as u', 'u.id', 'ur.user_id')
          .select('ur.user_id')
          .where('r.key', '=', 'owner')
          .where('u.deleted_at', 'is', null)
          .execute()
      ).length;

    const before = await activeOwners();
    expect(before).toBeGreaterThanOrEqual(2);

    await markDeleted(a);
    expect(await activeOwners()).toBe(before - 1);
    expect(b).not.toBe(a);
  });
});
