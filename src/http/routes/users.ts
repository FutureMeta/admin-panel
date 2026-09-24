// Rotte utenti: elenco, dettaglio, ruoli concedibili. Il resto sta in
// `users-access.ts` (ruoli, override) e `users-lifecycle.ts` (ban,
// sessioni, offboarding, eliminazione).
// §7, SEC-08, SEC-31

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Transaction } from 'kysely';
import type { AppContext } from '#src/app-context.ts';
import { AUDIT_ACTIONS } from '#src/audit/actions.ts';
import { writeAudit } from '#src/audit/log.ts';
import { require as requireLevel } from '#src/authz/can.ts';
import { dominates, grantableRoles, leavesFewerThanTwoOwners } from '#src/authz/dominance.ts';
import type { DB } from '#src/db/types.ts';
import { BadRequest, NotFound } from '../errors.ts';
import { requireAuth } from '../guards.ts';
import { actorOf, auditActorOf, auditContextOf, requestIps } from '../request-context.ts';

/** §1.3 — vedi `leavesFewerThanTwoOwners`: dentro la transazione, sempre. */
export async function keepTwoOwners(trx: Transaction<DB>, leaving: string, roleId?: number): Promise<void> {
  if (await leavesFewerThanTwoOwners(trx, leaving, roleId)) throw new BadRequest('SERVONO_DUE_OWNER');
}

/**
 * SEC-08 — nessuna operazione su un altro utente senza dominanza.
 *
 * SEC-31 — se il bersaglio non esiste OPPURE l'attore non lo domina, la
 * risposta e' la stessa: 404. Un 403 direbbe "questa persona esiste ma non
 * puoi toccarla", che e' informazione che non deve uscire.
 */
export async function requireDominatedTarget(
  ctx: AppContext,
  request: FastifyRequest,
  targetId: string,
): Promise<{ id: string; email: string; name: string }> {
  const actor = actorOf(request);
  const target = await ctx.db
    .selectFrom('auth.user')
    .select(['id', 'email', 'name'])
    .where('id', '=', targetId)
    // Un utente eliminato non e' piu' un bersaglio: risponde 404 come uno
    // che non e' mai esistito (SEC-31).
    .where('deleted_at', 'is', null)
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

export async function registerUserRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
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
      // Gli eliminati non compaiono: la riga esiste solo per il registro e
      // per la storia degli inviti.
      .where('u.deleted_at', 'is', null)
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
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!user) throw new NotFound();

    const [permissions, roles, sessions, overrides] = await Promise.all([
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
      // §7 — l'override INDIVIDUALE, distinto dal permesso effettivo.
      //
      // Serve alla schermata che lo modifica: l'effettivo e' GREATEST(ruolo,
      // override), quindi da solo non dice quale dei due lo sta producendo.
      // Senza questo, l'interfaccia modificherebbe un valore che non e' in
      // grado di mostrare, e chi la usa non saprebbe mai se un override c'e'
      // gia' o se sta guardando il livello che arriva dal ruolo.
      ctx.db
        .selectFrom('auth.user_permissions as up')
        .innerJoin('auth.modules as m', 'm.id', 'up.module_id')
        .select(['m.key as moduleKey', 'up.level'])
        .where('up.user_id', '=', id)
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
      overrides: Object.fromEntries(overrides.map((o) => [o.moduleKey, o.level])),
      roles,
      sessions,
      // Cosa l'attore puo' effettivamente fare su questa persona: la UI non
      // deve indovinarlo, e nemmeno ricalcolarlo.
      canManage: await dominates(ctx.db, actor.userId, id),
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/users/grantable-roles — alimenta la UI dell'invito
  // -------------------------------------------------------------------------
  app.get('/api/users/grantable-roles', { preHandler: [requireAuth(ctx)] }, async (request, reply) => {
    const actor = actorOf(request);
    requireLevel(actor, 'utenti', 1);
    return reply.send({ roles: await grantableRoles(ctx.db, actor.userId) });
  });
}
