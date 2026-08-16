// Rotte ruoli e matrice dei permessi. §7, SEC-07, SEC-09

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '#src/app-context.ts';
import { AUDIT_ACTIONS } from '#src/audit/actions.ts';
import { securityTransaction } from '#src/audit/log.ts';
import { require as requireLevel } from '#src/authz/can.ts';
import { canGrantLevel } from '#src/authz/dominance.ts';
import { isLevel } from '#src/authz/modules.ts';
import { BadRequest, NotFound } from '../errors.ts';
import { requireAuth, requireStepUp } from '../guards.ts';
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

    return reply.send({
      modules,
      roles: roles.map((r) => ({
        id: r.id,
        key: r.key,
        name: r.name,
        isSystem: r.is_system,
        members: byRole.get(r.id) ?? 0,
        // SEC-09 — un ruolo di sistema non e' modificabile: la UI non deve
        // dedurlo, glielo diciamo.
        editable: !r.is_system,
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
    { schema: matrixSchema, preHandler: [requireAuth(ctx), requireStepUp(ctx)] },
    async (request, reply) => {
      const actor = actorOf(request);
      requireLevel(actor, 'ruoli', 3);
      const { id } = request.params as { id: string };
      const roleId = Number(id);
      const { entries } = request.body as { entries: Array<{ moduleId: number; level: number }> };
      const ips = requestIps(request);

      const role = await ctx.db
        .selectFrom('auth.roles')
        .select(['id', 'key', 'name', 'is_system'])
        .where('id', '=', roleId)
        .executeTakeFirst();
      if (!role) throw new NotFound();
      // SEC-09 — la matrice di un ruolo di sistema non si tocca. Il trigger la
      // difende comunque a livello di database: questo e' il messaggio utile.
      if (role.is_system) throw new BadRequest('RUOLO_DI_SISTEMA');

      // SEC-07 — nessuno alza un ruolo sopra il proprio livello su alcun
      // modulo. Senza questo controllo, chi ha `ruoli:3` potrebbe darsi
      // qualunque cosa modificando un ruolo che poi si assegna.
      for (const e of entries) {
        if (!isLevel(e.level)) throw new BadRequest('LIVELLO_NON_VALIDO');
        if (!(await canGrantLevel(ctx.db, actor.userId, e.moduleId, e.level))) {
          throw new BadRequest('LIVELLO_NON_CONCEDIBILE');
        }
      }

      const affected = await securityTransaction(ctx.db, async (trx) => {
        const before = await trx
          .selectFrom('auth.role_permissions')
          .select(['module_id', 'level'])
          .where('role_id', '=', roleId)
          .execute();

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
}
