// Rotte utenti: elenco, dettaglio, ruoli, override, ban, sessioni, offboarding.
// §7, §8.10, SEC-07, SEC-08, SEC-31, SEC-36

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '#src/app-context.ts';
import { AUDIT_ACTIONS } from '#src/audit/actions.ts';
import { securityTransaction, writeAudit } from '#src/audit/log.ts';
import { require as requireLevel } from '#src/authz/can.ts';
import {
  canGrantLevel,
  canGrantRole,
  dominates,
  grantableRoles,
  isSystemRole,
} from '#src/authz/dominance.ts';
import { isLevel, isModuleKey } from '#src/authz/modules.ts';
import { revokeInvitesBy } from '#src/invites/service.ts';
import { BadRequest, NotFound } from '../errors.ts';
import { requireAuth, requireStepUp } from '../guards.ts';
import { actorOf, auditActorOf, auditContextOf, requestIps } from '../request-context.ts';

const banSchema = {
  body: {
    type: 'object',
    required: ['reason'],
    additionalProperties: false,
    properties: {
      reason: { type: 'string', minLength: 3, maxLength: 500 },
      expiresAt: { type: 'string', format: 'date-time' },
    },
  },
} as const;

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

export async function registerUserRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  /**
   * SEC-08 — nessuna operazione su un altro utente senza dominanza.
   *
   * SEC-31 — se il bersaglio non esiste OPPURE l'attore non lo domina, la
   * risposta e' la stessa: 404. Un 403 direbbe "questa persona esiste ma non
   * puoi toccarla", che e' informazione che non deve uscire.
   */
  async function requireDominatedTarget(
    request: FastifyRequest,
    targetId: string,
  ): Promise<{ id: string; email: string; name: string }> {
    const actor = actorOf(request);
    const target = await ctx.db
      .selectFrom('auth.user')
      .select(['id', 'email', 'name'])
      .where('id', '=', targetId)
      .executeTakeFirst();
    if (!target) throw new NotFound();
    if (!(await dominates(ctx.db, actor.userId, targetId))) {
      await writeAudit(ctx.db, {
        action: AUDIT_ACTIONS.roleGranted,
        outcome: 'denied',
        actor: auditActorOf(actor),
        request: auditContextOf(request, requestIps(request)),
        moduleKey: 'utenti',
        targetType: 'user',
        targetId,
        targetLabel: target.email,
        meta: { reason: 'dominanza', severita: 'alta' },
      });
      throw new NotFound();
    }
    return target;
  }

  // -------------------------------------------------------------------------
  // GET /api/users
  // -------------------------------------------------------------------------
  app.get('/api/users', { preHandler: [requireAuth(ctx)] }, async (request, reply) => {
    requireLevel(actorOf(request), 'utenti', 1);
    const rows = await ctx.db
      .selectFrom('auth.user as u')
      .select([
        'u.id',
        'u.email',
        'u.name',
        'u.status',
        'u.banned',
        'u.ban_reason',
        'u.ban_expires',
        'u.createdAt',
      ])
      .orderBy('u.createdAt', 'desc')
      .limit(500)
      .execute();

    const roles = await ctx.db
      .selectFrom('auth.user_roles as ur')
      .innerJoin('auth.roles as r', 'r.id', 'ur.role_id')
      .select(['ur.user_id', 'r.key', 'r.name', 'r.is_system'])
      .execute();

    const byUser = new Map<string, Array<{ key: string; name: string; isSystem: boolean }>>();
    for (const r of roles) {
      const list = byUser.get(r.user_id) ?? [];
      list.push({ key: r.key, name: r.name, isSystem: r.is_system });
      byUser.set(r.user_id, list);
    }

    // Quanti moduli vede davvero ciascuno. Non e' la somma dei ruoli: la vista
    // dei permessi effettivi tiene gia' conto degli override individuali e del
    // livello piu' alto quando due ruoli si sovrappongono (§7).
    // Ultimo accesso = la sessione toccata piu' di recente. Non e' un campo
    // sull'utente apposta: se lo fosse, andrebbe aggiornato a ogni richiesta,
    // cioe' una scrittura per pageview su una tabella che si legge sempre.
    const lastSeen = await ctx.db
      .selectFrom('auth.session')
      .select(({ fn }) => ['userId', fn.max('updatedAt').as('lastSeenAt')])
      .groupBy('userId')
      .execute();
    const lastSeenByUser = new Map(lastSeen.map((s) => [s.userId, s.lastSeenAt]));

    const moduleCounts = await ctx.db
      .selectFrom('auth.effective_permissions')
      .select(({ fn }) => ['user_id', fn.countAll<string>().as('modules')])
      .where('level', '>', 0)
      .groupBy('user_id')
      .execute();
    const modulesByUser = new Map(moduleCounts.map((m) => [m.user_id, Number(m.modules)]));

    return reply.send({
      users: rows.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        status: u.status,
        banned: u.banned,
        banReason: u.ban_reason,
        banExpires: u.ban_expires,
        createdAt: u.createdAt,
        roles: byUser.get(u.id) ?? [],
        modules: modulesByUser.get(u.id) ?? 0,
        lastSeenAt: lastSeenByUser.get(u.id) ?? null,
      })),
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/users/:id — matrice dei permessi effettivi
  // -------------------------------------------------------------------------
  app.get('/api/users/:id', { preHandler: [requireAuth(ctx)] }, async (request, reply) => {
    const actor = actorOf(request);
    requireLevel(actor, 'utenti', 1);
    const { id } = request.params as { id: string };

    const user = await ctx.db
      .selectFrom('auth.user')
      .select([
        'id',
        'email',
        'name',
        'status',
        'banned',
        'ban_reason',
        'ban_expires',
        'createdAt',
        'twoFactorEnabled',
      ])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!user) throw new NotFound();

    const [permissions, roles, sessions] = await Promise.all([
      ctx.db
        .selectFrom('auth.effective_permissions')
        .select(['module_key', 'level'])
        .where('user_id', '=', id)
        .execute(),
      ctx.db
        .selectFrom('auth.user_roles as ur')
        .innerJoin('auth.roles as r', 'r.id', 'ur.role_id')
        .select(['r.id', 'r.key', 'r.name', 'r.is_system as isSystem', 'ur.granted_at'])
        .where('ur.user_id', '=', id)
        .execute(),
      ctx.db
        .selectFrom('auth.session')
        .select(['id', 'createdAt', 'updatedAt', 'ipAddress', 'userAgent', 'aal'])
        .where('userId', '=', id)
        .orderBy('createdAt', 'desc')
        .execute(),
    ]);

    return reply.send({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        status: user.status,
        banned: user.banned,
        banReason: user.ban_reason,
        banExpires: user.ban_expires,
        createdAt: user.createdAt,
        twoFactorEnabled: user.twoFactorEnabled,
      },
      permissions: Object.fromEntries(permissions.map((p) => [p.module_key, p.level])),
      roles,
      sessions,
      // Cosa l'attore puo' effettivamente fare su questa persona: la UI non
      // deve indovinarlo, e nemmeno ricalcolarlo.
      canManage: await dominates(ctx.db, actor.userId, id),
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/users/:id/roles — assegnazione. Step-up (§8.5).
  // -------------------------------------------------------------------------
  app.post(
    '/api/users/:id/roles',
    { schema: roleSchema, preHandler: [requireAuth(ctx), requireStepUp(ctx)] },
    async (request, reply) => {
      const actor = actorOf(request);
      requireLevel(actor, 'ruoli', 2);
      const { id } = request.params as { id: string };
      const { roleId } = request.body as { roleId: number };
      const ips = requestIps(request);

      const target = await requireDominatedTarget(request, id);

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
        const role = await trx
          .selectFrom('auth.roles')
          .select(['key', 'name'])
          .where('id', '=', roleId)
          .executeTakeFirst();
        if (!role) throw new NotFound();

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

  app.delete(
    '/api/users/:id/roles/:roleId',
    { preHandler: [requireAuth(ctx), requireStepUp(ctx)] },
    async (request, reply) => {
      const actor = actorOf(request);
      requireLevel(actor, 'ruoli', 2);
      const { id, roleId } = request.params as { id: string; roleId: string };
      const ips = requestIps(request);
      const target = await requireDominatedTarget(request, id);

      await securityTransaction(ctx.db, async (trx) => {
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
    },
  );

  // -------------------------------------------------------------------------
  // PUT /api/users/:id/permissions — override individuale, SOLO in aumento
  // -------------------------------------------------------------------------
  app.put(
    '/api/users/:id/permissions',
    { schema: permissionSchema, preHandler: [requireAuth(ctx), requireStepUp(ctx)] },
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

      const target = await requireDominatedTarget(request, id);
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

  // -------------------------------------------------------------------------
  // POST /api/users/:id/ban — SEC-08 + step-up
  // -------------------------------------------------------------------------
  app.post(
    '/api/users/:id/ban',
    { schema: banSchema, preHandler: [requireAuth(ctx), requireStepUp(ctx)] },
    async (request, reply) => {
      const actor = actorOf(request);
      requireLevel(actor, 'utenti', 3);
      const { id } = request.params as { id: string };
      const body = request.body as { reason: string; expiresAt?: string };
      const ips = requestIps(request);

      if (id === actor.userId) throw new BadRequest('NON_PUOI_BANNARE_TE_STESSO');
      const target = await requireDominatedTarget(request, id);

      await securityTransaction(ctx.db, async (trx) => {
        await trx
          .updateTable('auth.user')
          .set({
            banned: true,
            ban_reason: body.reason,
            ban_expires: body.expiresAt ? new Date(body.expiresAt) : null,
            sessions_valid_from: new Date(),
          })
          .where('id', '=', id)
          .execute();
        await trx.deleteFrom('auth.session').where('userId', '=', id).execute();

        return {
          result: undefined,
          events: {
            action: AUDIT_ACTIONS.userBanned,
            outcome: 'success' as const,
            actor: auditActorOf(actor),
            request: auditContextOf(request, ips),
            moduleKey: 'utenti',
            targetType: 'user',
            targetId: id,
            targetLabel: target.email,
            after: { reason: body.reason, expiresAt: body.expiresAt ?? null },
          },
        };
      });

      // test 3 — il ban ha effetto alla richiesta successiva ENTRO 1 SECONDO
      // perche' lo snapshot viene riscritto qui, subito dopo il COMMIT, e il
      // middleware lo rilegge a ogni richiesta.
      await ctx.store.invalidate(id);
      return reply.send({ ok: true });
    },
  );

  app.post(
    '/api/users/:id/unban',
    { preHandler: [requireAuth(ctx), requireStepUp(ctx)] },
    async (request, reply) => {
      const actor = actorOf(request);
      requireLevel(actor, 'utenti', 3);
      const { id } = request.params as { id: string };
      const ips = requestIps(request);
      const target = await requireDominatedTarget(request, id);

      await securityTransaction(ctx.db, async (trx) => {
        await trx
          .updateTable('auth.user')
          .set({ banned: false, ban_reason: null, ban_expires: null })
          .where('id', '=', id)
          .execute();
        return {
          result: undefined,
          events: {
            action: AUDIT_ACTIONS.userUnbanned,
            outcome: 'success' as const,
            actor: auditActorOf(actor),
            request: auditContextOf(request, ips),
            moduleKey: 'utenti',
            targetType: 'user',
            targetId: id,
            targetLabel: target.email,
          },
        };
      });

      await ctx.store.invalidate(id);
      return reply.send({ ok: true });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/users/:id/revoke-sessions
  // -------------------------------------------------------------------------
  app.post(
    '/api/users/:id/revoke-sessions',
    { preHandler: [requireAuth(ctx), requireStepUp(ctx)] },
    async (request, reply) => {
      const actor = actorOf(request);
      requireLevel(actor, 'sessioni', 2);
      const { id } = request.params as { id: string };
      const ips = requestIps(request);
      const target = await requireDominatedTarget(request, id);

      const revoked = await ctx.authz.revokeAllSessions(id);
      await writeAudit(ctx.db, {
        action: AUDIT_ACTIONS.sessionsRevokedAll,
        outcome: 'success',
        actor: auditActorOf(actor),
        request: auditContextOf(request, ips),
        moduleKey: 'sessioni',
        targetType: 'user',
        targetId: id,
        targetLabel: target.email,
        meta: { revoked },
      });
      return reply.send({ revoked });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/users/:id/offboard — §8.10, operazione unica in UNA transazione
  // -------------------------------------------------------------------------
  app.post(
    '/api/users/:id/offboard',
    { schema: banSchema, preHandler: [requireAuth(ctx), requireStepUp(ctx)] },
    async (request, reply) => {
      const actor = actorOf(request);
      requireLevel(actor, 'utenti', 3);
      const { id } = request.params as { id: string };
      const body = request.body as { reason: string };
      const ips = requestIps(request);

      if (id === actor.userId) throw new BadRequest('NON_PUOI_OFFBOARDARE_TE_STESSO');
      const target = await requireDominatedTarget(request, id);

      const summary = await securityTransaction(ctx.db, async (trx) => {
        // 1-2. ban, disattivazione, logout globale
        await trx
          .updateTable('auth.user')
          .set({
            banned: true,
            status: 'disabled',
            ban_reason: body.reason,
            sessions_valid_from: new Date(),
          })
          .where('id', '=', id)
          .execute();
        const sessions = await trx
          .deleteFrom('auth.session')
          .where('userId', '=', id)
          .returning('id')
          .execute();

        // 3. il punto che si dimentica sempre quando lo si fa a mano: gli
        //    inviti pendenti EMESSI da quella persona restano validi, e
        //    chiunque li abbia ricevuti entra dopo che lei e' uscita.
        const invites = await revokeInvitesBy(trx, id, actor.userId);

        // 4-5. permessi via, versione alzata
        await trx.deleteFrom('auth.user_roles').where('user_id', '=', id).execute();
        await trx.deleteFrom('auth.user_permissions').where('user_id', '=', id).execute();

        return {
          result: { sessions: sessions.length, invites },
          events: {
            action: AUDIT_ACTIONS.userOffboarded,
            outcome: 'success' as const,
            actor: auditActorOf(actor),
            request: auditContextOf(request, ips),
            moduleKey: 'utenti',
            targetType: 'user',
            targetId: id,
            targetLabel: target.email,
            after: { reason: body.reason, sessioniRevocate: sessions.length, invitiRevocati: invites },
          },
        };
      });

      await ctx.store.invalidate(id);
      return reply.send(summary);
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/users/grantable-roles — alimenta la UI dell'invito
  // -------------------------------------------------------------------------
  app.get('/api/users/grantable-roles', { preHandler: [requireAuth(ctx)] }, async (request, reply) => {
    const actor = actorOf(request);
    requireLevel(actor, 'utenti', 1);
    return reply.send({ roles: await grantableRoles(ctx.db, actor.userId) });
  });
}
