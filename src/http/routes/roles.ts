// Rotte ruoli e matrice dei permessi. §7, SEC-07, SEC-08, SEC-09
//
// I RUOLI SI CREANO DAL PANNELLO (migration 024): nascono senza permessi, e
// la matrice li riempie come ogni altro ruolo. Rinominare e eliminare seguono
// le stesse regole — «Gestione» su Ruoli, mai l'owner — ed eliminare vuole un
// ruolo che nessuno ha e che nessun invito pendente offre: toglierlo a delle
// persone e' un'azione su di loro, e va fatta una per una, dove si vede.
//
// SI TOCCA SOLO UN RUOLO CHE SI POTREBBE CONCEDERE. Svuotare la matrice
// dell'Admin declasserebbe tutti gli admin, e chi ha «Gestione» su Ruoli ma
// meno di un admin altrove non li domina (SEC-08): matrice, nome ed
// eliminazione valgono solo per i ruoli che non danno piu' di quanto ha lui.
//
// E ALZARE UN RUOLO NON ALZA CHI CE L'HA PIU' DI QUANTO POTEVA DARGLIELO CHI
// GLIEL'HA DATO. Senza, un admin si assegna un ruolo appena creato — vuoto,
// quindi concedibile — e aspetta che l'owner lo riempia: ne riceverebbe i
// livelli senza che nessuno glieli abbia mai concessi davvero.

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '#src/app-context.ts';
import { AUDIT_ACTIONS } from '#src/audit/actions.ts';
import { securityTransaction } from '#src/audit/log.ts';
import { cleanName } from '#src/audit/sanitize.ts';
import { require as requireLevel } from '#src/authz/can.ts';
import { canGrantLevel, canGrantRole, grantableRoles } from '#src/authz/dominance.ts';
import { isLevel } from '#src/authz/modules.ts';
import type { Database } from '#src/db/pool.ts';
import { BadRequest, Conflict, NotFound } from '../errors.ts';
import { requireAuth } from '../guards.ts';
import { actorOf, auditActorOf, auditContextOf, requestIps } from '../request-context.ts';

const matrixSchema = {
  body: {
    type: 'object',
    required: ['entries'],
    additionalProperties: false,
    properties: {
      entries: {
        type: 'array',
        maxItems: 64,
        items: {
          type: 'object',
          required: ['moduleId', 'level'],
          additionalProperties: false,
          properties: {
            moduleId: { type: 'integer', minimum: 1 },
            level: { type: 'integer', minimum: 0, maximum: 3 },
          },
        },
      },
    },
  },
} as const;

const nameSchema = {
  body: {
    type: 'object',
    required: ['name'],
    additionalProperties: false,
    properties: { name: { type: 'string', minLength: 1, maxLength: 40 } },
  },
} as const;

/** L'id di un ruolo: `smallint` in Postgres. Fuori scala e' un 400, non un errore del database. */
const idParams = {
  params: {
    type: 'object',
    required: ['id'],
    additionalProperties: false,
    properties: { id: { type: 'integer', minimum: 1, maximum: 32767 } },
  },
} as const;

/**
 * Il nome di un ruolo: lettere, cifre, spazi e `'._-`, almeno due caratteri.
 * Niente caratteri invisibili o di direzione: due nomi che si leggono uguali
 * devono essere uguali anche per l'indice unico.
 */
function roleNameOf(raw: string): string {
  const name = cleanName(raw, 40);
  if (name.length < 2) throw new BadRequest('NOME_NON_VALIDO');
  return name;
}

/**
 * Il ruolo, se l'attore lo puo' toccare: esiste, non e' di sistema, e non da'
 * su alcun modulo piu' di quanto ha l'attore. Si chiama dentro la transazione:
 * FOR UPDATE mette in fila chi lo modifica insieme.
 */
async function manageableRole(db: Database, actorId: string, roleId: number) {
  const role = await db
    .selectFrom('auth.roles')
    .select(['id', 'key', 'name', 'is_system'])
    .where('id', '=', roleId)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (!role) throw new NotFound();
  // SEC-09 — il trigger lo difende comunque: questo e' il messaggio utile.
  if (role.is_system) throw new BadRequest('RUOLO_DI_SISTEMA');
  if (!(await canGrantRole(db, actorId, roleId))) throw new BadRequest('RUOLO_NON_GESTIBILE');
  return role;
}

/**
 * La chiave di un ruolo nuovo, dal nome: «Staff Eventi» → `staff_eventi`.
 * Unica fra TUTTI i ruoli, eliminati compresi: la chiave finisce nel
 * registro, e li' due ruoli diversi non devono chiamarsi allo stesso modo.
 */
export function roleKeyOf(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32) || 'ruolo';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
}

/**
 * Il nome e' gia' preso? Lo dice l'indice unico della 024 — o, per due nomi
 * diversi creati insieme che danno la stessa chiave, il vincolo sulla chiave.
 */
function nameTaken(err: unknown): boolean {
  return err instanceof Error && /roles_name_live_unique|roles_key_key/.test(err.message);
}

export async function registerRoleRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // -------------------------------------------------------------------------
  // GET /api/roles — la matrice completa, che e' quel che la UI disegna
  // -------------------------------------------------------------------------
  app.get('/api/roles', { preHandler: [requireAuth(ctx)] }, async (request, reply) => {
    const actor = actorOf(request);
    requireLevel(actor, 'ruoli', 1);

    const [modules, roles, permissions] = await Promise.all([
      ctx.db
        .selectFrom('auth.modules')
        .select(['id', 'key', 'name', 'sort_order'])
        .orderBy('sort_order')
        .execute(),
      ctx.db
        .selectFrom('auth.roles')
        .select(['id', 'key', 'name', 'is_system', 'sort_order'])
        .where('deleted_at', 'is', null)
        .orderBy('sort_order')
        .execute(),
      ctx.db.selectFrom('auth.role_permissions').select(['role_id', 'module_id', 'level']).execute(),
    ]);

    const counts = await ctx.db
      .selectFrom('auth.user_roles')
      .select((eb) => ['role_id', eb.fn.countAll().as('n')])
      .groupBy('role_id')
      .execute();
    const byRole = new Map(counts.map((c) => [c.role_id, Number(c.n)]));
    const manageable = new Set((await grantableRoles(ctx.db, actor.userId)).map((r) => r.id));

    return reply.send({
      modules,
      roles: roles.map((r) => ({
        id: r.id,
        key: r.key,
        name: r.name,
        isSystem: r.is_system,
        members: byRole.get(r.id) ?? 0,
        // La stessa regola di `manageableRole`: non di sistema (SEC-09), e
        // concedibile da chi guarda. La UI non deve dedurlo, glielo diciamo.
        editable: manageable.has(r.id),
      })),
      permissions,
    });
  });

  // -------------------------------------------------------------------------
  // PUT /api/roles/:id/permissions — modifica della matrice. Step-up.
  //
  // Cambiare la matrice di un ruolo declassa (o promuove) TUTTI quelli che ce
  // l'hanno: e' l'operazione con il raggio piu' ampio del pannello, ed e' per
  // questo che richiede step-up e riallineamento di tutti gli snapshot.
  // -------------------------------------------------------------------------
  app.put(
    '/api/roles/:id/permissions',
    { schema: { ...idParams, ...matrixSchema }, preHandler: [requireAuth(ctx)] },
    async (request, reply) => {
      const actor = actorOf(request);
      requireLevel(actor, 'ruoli', 3);
      const roleId = (request.params as { id: number }).id;
      const { entries } = request.body as { entries: Array<{ moduleId: number; level: number }> };
      const ips = requestIps(request);

      const affected = await securityTransaction(ctx.db, async (trx) => {
        const role = await manageableRole(trx, actor.userId, roleId);

        // SEC-07 — nessuno alza un ruolo sopra il proprio livello su alcun
        // modulo. Senza questo controllo, chi ha `ruoli:3` potrebbe darsi
        // qualunque cosa modificando un ruolo che poi si assegna.
        for (const e of entries) {
          if (!isLevel(e.level)) throw new BadRequest('LIVELLO_NON_VALIDO');
          if (!(await canGrantLevel(trx, actor.userId, e.moduleId, e.level))) {
            throw new BadRequest('LIVELLO_NON_CONCEDIBILE');
          }
        }

        const before = await trx
          .selectFrom('auth.role_permissions')
          .select(['module_id', 'level'])
          .where('role_id', '=', roleId)
          .execute();

        // Chi riceve il ruolo alzato non deve andare oltre cio' che poteva
        // dargli chi gliel'ha dato: chi l'ha assegnato, e chi lo offre in un
        // invito ancora valido. `granted_by` NULL e' il seme delle migration.
        const raises = entries.filter(
          (e) => e.level > (before.find((b) => b.module_id === e.moduleId)?.level ?? 0),
        );
        if (raises.length > 0) {
          const [holders, invites] = await Promise.all([
            trx
              .selectFrom('auth.user_roles')
              .select('granted_by')
              .where('role_id', '=', roleId)
              .where('granted_by', 'is not', null)
              .execute(),
            trx
              .selectFrom('auth.invitation')
              .select('invited_by')
              .where('role_id', '=', roleId)
              .where('consumed_at', 'is', null)
              .where('revoked_at', 'is', null)
              .where('expires_at', '>', new Date())
              .execute(),
          ]);
          const granters = new Set<string>([
            ...holders.map((h) => h.granted_by as string),
            ...invites.map((i) => i.invited_by),
          ]);
          granters.delete(actor.userId);
          for (const granter of granters) {
            for (const e of raises) {
              if (!(await canGrantLevel(trx, granter, e.moduleId, e.level))) {
                throw new Conflict('CONCESSO_DA_CHI_NON_PUO');
              }
            }
          }
        }

        for (const e of entries) {
          if (e.level === 0) {
            await trx
              .deleteFrom('auth.role_permissions')
              .where('role_id', '=', roleId)
              .where('module_id', '=', e.moduleId)
              .execute();
          } else {
            await trx
              .insertInto('auth.role_permissions')
              .values({ role_id: roleId, module_id: e.moduleId, level: e.level })
              .onConflict((oc) => oc.columns(['role_id', 'module_id']).doUpdateSet({ level: e.level }))
              .execute();
          }
        }

        const members = await trx
          .selectFrom('auth.user_roles')
          .select('user_id')
          .where('role_id', '=', roleId)
          .execute();

        return {
          result: members.map((m) => m.user_id),
          events: {
            action: AUDIT_ACTIONS.rolePermissionsChanged,
            outcome: 'success' as const,
            actor: auditActorOf(actor),
            request: auditContextOf(request, ips),
            moduleKey: 'ruoli',
            targetType: 'role',
            targetId: String(roleId),
            targetLabel: role.name,
            before: { permissions: before },
            after: { permissions: entries },
            meta: { membri: members.length },
          },
        };
      });

      // Dopo il COMMIT: uno snapshot per ogni membro. Il trigger ha gia'
      // alzato permissions_version in Postgres; questo riallinea Redis, che e'
      // cio' che il middleware legge davvero.
      await ctx.store.invalidateMany(affected);
      return reply.send({ ok: true, affected: affected.length });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/roles — un ruolo nuovo, senza permessi. La matrice li da' dopo.
  // -------------------------------------------------------------------------
  app.post('/api/roles', { schema: nameSchema, preHandler: [requireAuth(ctx)] }, async (request, reply) => {
    const actor = actorOf(request);
    requireLevel(actor, 'ruoli', 3);
    const name = roleNameOf((request.body as { name: string }).name);

    try {
      const created = await securityTransaction(ctx.db, async (trx) => {
        const all = await trx.selectFrom('auth.roles').select(['key', 'sort_order']).execute();
        const key = roleKeyOf(name, new Set(all.map((r) => r.key)));
        const sortOrder = Math.max(0, ...all.map((r) => r.sort_order)) + 10;
        const row = await trx
          .insertInto('auth.roles')
          .values({ key, name, is_system: false, sort_order: sortOrder })
          .returning(['id', 'key', 'name'])
          .executeTakeFirstOrThrow();
        return {
          result: row,
          events: {
            action: AUDIT_ACTIONS.roleCreated,
            outcome: 'success' as const,
            actor: auditActorOf(actor),
            request: auditContextOf(request, requestIps(request)),
            moduleKey: 'ruoli',
            targetType: 'role',
            targetId: String(row.id),
            targetLabel: row.name,
            after: { key: row.key, name: row.name },
          },
        };
      });
      return reply.code(201).send(created);
    } catch (err) {
      if (nameTaken(err)) throw new Conflict('NOME_IN_USO');
      throw err;
    }
  });

  // -------------------------------------------------------------------------
  // PATCH /api/roles/:id — il nome. La chiave resta: e' quella del registro.
  // -------------------------------------------------------------------------
  app.patch(
    '/api/roles/:id',
    { schema: { ...idParams, ...nameSchema }, preHandler: [requireAuth(ctx)] },
    async (request, reply) => {
      const actor = actorOf(request);
      requireLevel(actor, 'ruoli', 3);
      const roleId = (request.params as { id: number }).id;
      const name = roleNameOf((request.body as { name: string }).name);

      try {
        await securityTransaction(ctx.db, async (trx) => {
          // Anche il nome: chiamare «Moderatore» il ruolo Admin farebbe
          // concedere a qualcun altro il ruolo sbagliato.
          const role = await manageableRole(trx, actor.userId, roleId);
          await trx.updateTable('auth.roles').set({ name }).where('id', '=', roleId).execute();
          return {
            result: undefined,
            events: {
              action: AUDIT_ACTIONS.roleRenamed,
              outcome: 'success' as const,
              actor: auditActorOf(actor),
              request: auditContextOf(request, requestIps(request)),
              moduleKey: 'ruoli',
              targetType: 'role',
              targetId: String(roleId),
              targetLabel: name,
              before: { name: role.name },
              after: { name },
            },
          };
        });
      } catch (err) {
        if (nameTaken(err)) throw new Conflict('NOME_IN_USO');
        throw err;
      }
      return reply.send({ ok: true });
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /api/roles/:id — solo un ruolo che nessuno ha e nessun invito offre.
  //
  // La riga resta (migration 024) e i permessi se ne vanno: un ruolo
  // eliminato non da' niente, non compare e non si assegna piu'.
  // -------------------------------------------------------------------------
  app.delete(
    '/api/roles/:id',
    { schema: idParams, preHandler: [requireAuth(ctx)] },
    async (request, reply) => {
      const actor = actorOf(request);
      requireLevel(actor, 'ruoli', 3);
      const roleId = (request.params as { id: number }).id;

      await securityTransaction(ctx.db, async (trx) => {
        // FOR UPDATE (dentro `manageableRole`): un'assegnazione contemporanea
        // aspetta qui, e dopo trova il ruolo eliminato (il trigger della 024)
        // invece di passare accanto.
        const role = await manageableRole(trx, actor.userId, roleId);

        const members = await trx
          .selectFrom('auth.user_roles')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('role_id', '=', roleId)
          .executeTakeFirstOrThrow();
        if (Number(members.n) > 0) throw new Conflict('RUOLO_ASSEGNATO');

        const invites = await trx
          .selectFrom('auth.invitation')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('role_id', '=', roleId)
          .where('consumed_at', 'is', null)
          .where('revoked_at', 'is', null)
          .where('expires_at', '>', new Date())
          .executeTakeFirstOrThrow();
        if (Number(invites.n) > 0) throw new Conflict('RUOLO_IN_INVITI');

        const before = await trx
          .selectFrom('auth.role_permissions')
          .select(['module_id', 'level'])
          .where('role_id', '=', roleId)
          .execute();
        await trx.deleteFrom('auth.role_permissions').where('role_id', '=', roleId).execute();
        await trx
          .updateTable('auth.roles')
          .set({ deleted_at: new Date() })
          .where('id', '=', roleId)
          .execute();

        return {
          result: undefined,
          events: {
            action: AUDIT_ACTIONS.roleDeleted,
            outcome: 'success' as const,
            actor: auditActorOf(actor),
            request: auditContextOf(request, requestIps(request)),
            moduleKey: 'ruoli',
            targetType: 'role',
            targetId: String(roleId),
            targetLabel: role.name,
            before: { key: role.key, name: role.name, permissions: before },
          },
        };
      });
      return reply.code(204).send();
    },
  );
}
