// Ruoli e override dei permessi di un utente.  §7, SEC-07, SEC-08

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '#src/app-context.ts';
import { AUDIT_ACTIONS } from '#src/audit/actions.ts';
import { securityTransaction, writeAudit } from '#src/audit/log.ts';
import { require as requireLevel } from '#src/authz/can.ts';
import { canGrantLevel, canGrantRole, isSystemRole } from '#src/authz/dominance.ts';
import { isLevel, isModuleKey } from '#src/authz/modules.ts';
import { BadRequest, NotFound } from '../errors.ts';
import { requireAuth } from '../guards.ts';
import { actorOf, auditActorOf, auditContextOf, requestIps } from '../request-context.ts';
import { keepTwoOwners, requireDominatedTarget } from './users.ts';

const roleSchema = {
  body: {
    type: 'object',
    required: ['roleId'],
    additionalProperties: false,
    properties: { roleId: { type: 'integer', minimum: 1 } },
  },
} as const;

const permissionSchema = {
  body: {
    type: 'object',
    required: ['moduleKey', 'level'],
    additionalProperties: false,
    properties: {
      moduleKey: { type: 'string', maxLength: 32 },
      level: { type: 'integer', minimum: 0, maximum: 3 },
    },
  },
} as const;

export async function registerUserAccessRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // -------------------------------------------------------------------------
  // POST /api/users/:id/roles — assegnazione di un ruolo.
  //
  // SEC-07 (nessuno concede cio' che non ha) e SEC-08 (nessuno tocca chi lo
  // domina) sono i due rifiuti possibili, e rispondono in modo diverso di
  // proposito: il primo e' un 400 con codice, il secondo un 404 identico a
  // quello di un utente inesistente — distinguerli direbbe a un admin quali
  // account esistono sopra di lui (§14 test 9).
  // -------------------------------------------------------------------------
  app.post(
    '/api/users/:id/roles',
    { schema: roleSchema, preHandler: [requireAuth(ctx)] },
    async (request, reply) => {
      const actor = actorOf(request);
      requireLevel(actor, 'ruoli', 2);
      const { id } = request.params as { id: string };
      const { roleId } = request.body as { roleId: number };
      const ips = requestIps(request);

      // Nessuno si assegna un ruolo da solo. Un ruolo che oggi non da' niente
      // — uno appena creato — e' concedibile da chiunque, e prenderselo
      // vorrebbe dire ricevere in silenzio tutto cio' che gli verra' dato poi.
      if (id === actor.userId) throw new BadRequest('AUTOASSEGNAZIONE');

      const target = await requireDominatedTarget(ctx, request, id);

      // SEC-09 — il ruolo di sistema non e' assegnabile via UI.
      if (await isSystemRole(ctx.db, roleId)) throw new BadRequest('RUOLO_NON_ASSEGNABILE');
      // SEC-07 — nessuno concede cio' che non ha.
      if (!(await canGrantRole(ctx.db, actor.userId, roleId))) {
        await writeAudit(ctx.db, {
          action: AUDIT_ACTIONS.roleGranted,
          outcome: 'denied',
          actor: auditActorOf(actor),
          request: auditContextOf(request, ips),
          moduleKey: 'ruoli',
          targetType: 'user',
          targetId: id,
          targetLabel: target.email,
          meta: { roleId, reason: 'concedibilita`', severita: 'alta' },
        });
        throw new BadRequest('RUOLO_NON_CONCEDIBILE');
      }

      await securityTransaction(ctx.db, async (trx) => {
        // FOR SHARE, e poi di nuovo la concedibilita': una matrice alzata
        // mentre si assegna finisce prima o dopo, mai in mezzo al controllo.
        const role = await trx
          .selectFrom('auth.roles')
          .select(['key', 'name'])
          .where('id', '=', roleId)
          .forShare()
          .executeTakeFirst();
        if (!role) throw new NotFound();
        if (!(await canGrantRole(trx, actor.userId, roleId))) throw new BadRequest('RUOLO_NON_CONCEDIBILE');

        await trx
          .insertInto('auth.user_roles')
          .values({ user_id: id, role_id: roleId, granted_by: actor.userId })
          .onConflict((oc) => oc.columns(['user_id', 'role_id']).doNothing())
          .execute();

        return {
          result: undefined,
          events: {
            action: AUDIT_ACTIONS.roleGranted,
            outcome: 'success' as const,
            actor: auditActorOf(actor),
            request: auditContextOf(request, ips),
            moduleKey: 'ruoli',
            targetType: 'user',
            targetId: id,
            targetLabel: target.email,
            after: { role: role.key },
          },
        };
      });

      // Dopo il COMMIT: lo snapshot va riallineato, altrimenti il middleware
      // continuerebbe a decidere sui permessi vecchi fino al prossimo miss.
      await ctx.store.invalidate(id);
      return reply.send({ ok: true });
    },
  );

  app.delete('/api/users/:id/roles/:roleId', { preHandler: [requireAuth(ctx)] }, async (request, reply) => {
    const actor = actorOf(request);
    requireLevel(actor, 'ruoli', 2);
    const { id, roleId } = request.params as { id: string; roleId: string };
    const ips = requestIps(request);
    const target = await requireDominatedTarget(ctx, request, id);

    await securityTransaction(ctx.db, async (trx) => {
      await keepTwoOwners(trx, id, Number(roleId));
      const removed = await trx
        .deleteFrom('auth.user_roles')
        .where('user_id', '=', id)
        .where('role_id', '=', Number(roleId))
        .returning('role_id')
        .executeTakeFirst();
      if (!removed) throw new NotFound();

      return {
        result: undefined,
        events: {
          action: AUDIT_ACTIONS.roleRevoked,
          outcome: 'success' as const,
          actor: auditActorOf(actor),
          request: auditContextOf(request, ips),
          moduleKey: 'ruoli',
          targetType: 'user',
          targetId: id,
          targetLabel: target.email,
          before: { roleId: Number(roleId) },
        },
      };
    });

    await ctx.store.invalidate(id);
    return reply.send({ ok: true });
  });

  // -------------------------------------------------------------------------
  // PUT /api/users/:id/permissions — override individuale, SOLO in aumento
  // -------------------------------------------------------------------------
  app.put(
    '/api/users/:id/permissions',
    { schema: permissionSchema, preHandler: [requireAuth(ctx)] },
    async (request, reply) => {
      const actor = actorOf(request);
      requireLevel(actor, 'ruoli', 2);
      const { id } = request.params as { id: string };
      const { moduleKey, level } = request.body as { moduleKey: string; level: number };
      const ips = requestIps(request);

      // SEC-38 — lo schema ha gia' validato tipo e intervallo; qui si
      // rivalida contro la fonte di verita', perche' lo schema non sa quali
      // moduli esistono davvero.
      if (!isModuleKey(moduleKey) || !isLevel(level)) throw new BadRequest('MODULO_O_LIVELLO_NON_VALIDO');
      // Nessuno tocca i propri override, come nessuno si assegna un ruolo. Qui
      // non si puo' salire — non si concede piu' di quanto si ha — ma si puo'
      // COPIARE: trasformare in override individuali i livelli che oggi arrivano
      // dal ruolo, e tenerli quando il ruolo viene tolto o la matrice abbassata.
      if (id === actor.userId) throw new BadRequest('AUTOASSEGNAZIONE');

      const target = await requireDominatedTarget(ctx, request, id);
      const moduleRow = await ctx.db
        .selectFrom('auth.modules')
        .select('id')
        .where('key', '=', moduleKey)
        .executeTakeFirst();
      if (!moduleRow) throw new NotFound();

      // SEC-07 — nessuno concede un livello superiore al proprio.
      if (!(await canGrantLevel(ctx.db, actor.userId, moduleRow.id, level))) {
        throw new BadRequest('LIVELLO_NON_CONCEDIBILE');
      }

      await securityTransaction(ctx.db, async (trx) => {
        const before = await trx
          .selectFrom('auth.user_permissions')
          .select('level')
          .where('user_id', '=', id)
          .where('module_id', '=', moduleRow.id)
          .executeTakeFirst();

        if (level === 0) {
          await trx
            .deleteFrom('auth.user_permissions')
            .where('user_id', '=', id)
            .where('module_id', '=', moduleRow.id)
            .execute();
        } else {
          await trx
            .insertInto('auth.user_permissions')
            .values({ user_id: id, module_id: moduleRow.id, level, granted_by: actor.userId })
            .onConflict((oc) =>
              oc.columns(['user_id', 'module_id']).doUpdateSet({ level, granted_by: actor.userId }),
            )
            .execute();
        }

        return {
          result: undefined,
          events: {
            action: level === 0 ? AUDIT_ACTIONS.permissionRevoked : AUDIT_ACTIONS.permissionGranted,
            outcome: 'success' as const,
            actor: auditActorOf(actor),
            request: auditContextOf(request, ips),
            moduleKey,
            targetType: 'user',
            targetId: id,
            targetLabel: target.email,
            before: before ? { level: before.level } : null,
            after: { level },
          },
        };
      });

      await ctx.store.invalidate(id);
      return reply.send({ ok: true });
    },
  );
}
