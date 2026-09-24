// Ban, sessioni, offboarding ed eliminazione di un utente.  §8.10, SEC-08, SEC-36

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '#src/app-context.ts';
import { AUDIT_ACTIONS } from '#src/audit/actions.ts';
import { securityTransaction, writeAudit } from '#src/audit/log.ts';
import { forgetSessions } from '#src/auth/auth.ts';
import { require as requireLevel } from '#src/authz/can.ts';
import { revokeInvitesBy } from '#src/invites/service.ts';
import { BadRequest, NotFound } from '../errors.ts';
import { requireAuth } from '../guards.ts';
import { actorOf, auditActorOf, auditContextOf, requestIps } from '../request-context.ts';
import { keepTwoOwners, requireDominatedTarget } from './users.ts';

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

export async function registerUserLifecycleRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // -------------------------------------------------------------------------
  // POST /api/users/:id/ban — SEC-08 + step-up
  // -------------------------------------------------------------------------
  app.post(
    '/api/users/:id/ban',
    { schema: banSchema, preHandler: [requireAuth(ctx)] },
    async (request, reply) => {
      const actor = actorOf(request);
      requireLevel(actor, 'utenti', 3);
      const { id } = request.params as { id: string };
      const body = request.body as { reason: string; expiresAt?: string };
      const ips = requestIps(request);

      if (id === actor.userId) throw new BadRequest('NON_PUOI_BANNARE_TE_STESSO');
      const target = await requireDominatedTarget(ctx, request, id);

      const tokens = await securityTransaction(ctx.db, async (trx) => {
        await keepTwoOwners(trx, id);
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
        const sessions = await trx
          .deleteFrom('auth.session')
          .where('userId', '=', id)
          .returning('token')
          .execute();

        return {
          result: sessions.map((s) => s.token),
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
      await forgetSessions(ctx.redis, tokens);
      await ctx.store.invalidate(id);
      return reply.send({ ok: true });
    },
  );

  app.post('/api/users/:id/unban', { preHandler: [requireAuth(ctx)] }, async (request, reply) => {
    const actor = actorOf(request);
    requireLevel(actor, 'utenti', 3);
    const { id } = request.params as { id: string };
    const ips = requestIps(request);
    const target = await requireDominatedTarget(ctx, request, id);

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
  });

  // -------------------------------------------------------------------------
  // POST /api/users/:id/revoke-sessions
  // -------------------------------------------------------------------------
  app.post('/api/users/:id/revoke-sessions', { preHandler: [requireAuth(ctx)] }, async (request, reply) => {
    const actor = actorOf(request);
    requireLevel(actor, 'sessioni', 2);
    const { id } = request.params as { id: string };
    const ips = requestIps(request);
    const target = await requireDominatedTarget(ctx, request, id);

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
  });

  // -------------------------------------------------------------------------
  // POST /api/users/:id/offboard — §8.10, operazione unica in UNA transazione
  // -------------------------------------------------------------------------
  app.post(
    '/api/users/:id/offboard',
    { schema: banSchema, preHandler: [requireAuth(ctx)] },
    async (request, reply) => {
      const actor = actorOf(request);
      requireLevel(actor, 'utenti', 3);
      const { id } = request.params as { id: string };
      const body = request.body as { reason: string };
      const ips = requestIps(request);

      if (id === actor.userId) throw new BadRequest('NON_PUOI_OFFBOARDARE_TE_STESSO');
      const target = await requireDominatedTarget(ctx, request, id);

      const { summary, tokens } = await securityTransaction(ctx.db, async (trx) => {
        await keepTwoOwners(trx, id);
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
          .returning('token')
          .execute();

        // 3. il punto che si dimentica sempre quando lo si fa a mano: gli
        //    inviti pendenti EMESSI da quella persona restano validi, e
        //    chiunque li abbia ricevuti entra dopo che lei e' uscita.
        const invites = await revokeInvitesBy(trx, id, actor.userId);

        // 4-5. permessi via, versione alzata
        await trx.deleteFrom('auth.user_roles').where('user_id', '=', id).execute();
        await trx.deleteFrom('auth.user_permissions').where('user_id', '=', id).execute();

        return {
          result: {
            summary: { sessions: sessions.length, invites },
            tokens: sessions.map((s) => s.token),
          },
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

      await forgetSessions(ctx.redis, tokens);
      await ctx.store.invalidate(id);
      return reply.send(summary);
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/users/:id/delete — eliminazione. Step-up, dominanza, §8.10
  //
  // Fa tutto quello che fa l'offboarding, piu' la distruzione delle
  // credenziali: password, secondo fattore, codici di recupero, passkey. Da
  // qui non si torna indietro, ed e' la differenza che giustifica due
  // operazioni invece di una.
  //
  // La riga di auth."user" resta. Non e' un ripiego: `auth.invitation.
  // invited_by` e' NOT NULL verso quella tabella, e un DELETE vero
  // richiederebbe di rendere nullabile «chi ha fatto entrare chi» — che in un
  // pannello ad accesso solo su invito e' la storia da non perdere. La riga
  // sopravvive come identita' per il registro, e sparisce dall'elenco.
  // -------------------------------------------------------------------------
  app.post(
    '/api/users/:id/delete',
    { schema: banSchema, preHandler: [requireAuth(ctx)] },
    async (request, reply) => {
      const actor = actorOf(request);
      requireLevel(actor, 'utenti', 3);
      const { id } = request.params as { id: string };
      const body = request.body as { reason: string };
      const ips = requestIps(request);

      if (id === actor.userId) throw new BadRequest('NON_PUOI_ELIMINARE_TE_STESSO');
      const target = await requireDominatedTarget(ctx, request, id);

      const { summary, tokens } = await securityTransaction(ctx.db, async (trx) => {
        await keepTwoOwners(trx, id);
        const before = await trx
          .selectFrom('auth.user')
          .select(['email', 'name', 'status'])
          .where('id', '=', id)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        // Gia' eliminato: il trigger lo impedirebbe comunque, ma un 404 e'
        // una risposta piu' onesta di un errore del database.
        if (!before) throw new NotFound();

        await trx
          .updateTable('auth.user')
          .set({
            deleted_at: new Date(),
            banned: true,
            status: 'disabled',
            ban_reason: body.reason,
            twoFactorEnabled: false,
            sessions_valid_from: new Date(),
            // L'indirizzo torna libero: senza, quella casella resterebbe
            // bruciata per sempre — la persona non potrebbe rientrare e
            // nessun altro potrebbe usarla. L'email vera resta nel registro,
            // qui sotto in `before`.
            email: `deleted+${id}@invalid.local`,
            emailVerified: false,
          })
          .where('id', '=', id)
          .execute();

        const sessions = await trx
          .deleteFrom('auth.session')
          .where('userId', '=', id)
          .returning('token')
          .execute();
        const invites = await revokeInvitesBy(trx, id, actor.userId);

        await trx.deleteFrom('auth.user_roles').where('user_id', '=', id).execute();
        await trx.deleteFrom('auth.user_permissions').where('user_id', '=', id).execute();

        // Le credenziali. E' questo che rende l'operazione definitiva.
        await trx.deleteFrom('auth.account').where('userId', '=', id).execute();
        await trx.deleteFrom('auth.twoFactor').where('userId', '=', id).execute();
        await trx.deleteFrom('auth.recovery_code').where('user_id', '=', id).execute();
        await trx.deleteFrom('auth.webauthn_credential').where('user_id', '=', id).execute();
        await trx.deleteFrom('auth.verification').where('identifier', '=', `reset:${id}`).execute();

        return {
          result: {
            summary: { sessions: sessions.length, invites },
            tokens: sessions.map((s) => s.token),
          },
          events: {
            action: AUDIT_ACTIONS.userDeleted,
            outcome: 'success' as const,
            actor: auditActorOf(actor),
            request: auditContextOf(request, ips),
            moduleKey: 'utenti',
            targetType: 'user',
            targetId: id,
            targetLabel: target.email,
            // Chi era, scritto nel registro prima di sparire dall'elenco.
            before: { email: before.email, name: before.name, status: before.status },
            after: { reason: body.reason, sessioniRevocate: sessions.length, invitiRevocati: invites },
          },
        };
      });

      await forgetSessions(ctx.redis, tokens);
      await ctx.store.invalidate(id);
      return reply.send(summary);
    },
  );
}
