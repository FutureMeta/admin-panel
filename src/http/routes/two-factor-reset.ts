// §8.8 — reset 2FA assistito, a quattro occhi.
//
// Cosa è VIETATO e resta vietato:
//   - reset 2FA via link email (ASVS 6.3.6)
//   - domande segrete (ASVS 6.4.2)
//   - reset da parte di un singolo admin
//
// L'ordine dei rimedi è: recovery code (nessun intervento umano), poi il
// secondo fattore alternativo (passkey, fase 1.5), poi questa procedura.
//
// I vincoli sono tutti e cinque, e nessuno è negoziabile:
//   1. approvazione di DUE owner distinti, entrambi diversi dal richiedente
//   2. verifica out-of-band su un canale preesistente e noto
//   3. ritardo obbligatorio di 24 ore prima che diventi effettivo
//   4. notifica immediata a tutti gli owner all'apertura
//   5. voce di audit con richiedente, approvatori e canale di verifica
//
// Il reset CANCELLA i fattori e riporta l'account in `pending_onboarding`.
// Non emette mai una sessione e non produce mai un link magico: la persona
// rientra dal login, rifà l'enrollment, e riceve recovery code nuovi.

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '#src/app-context.ts';
import { AUDIT_ACTIONS } from '#src/audit/actions.ts';
import { securityTransaction } from '#src/audit/log.ts';
import { require as requireLevel } from '#src/authz/can.ts';
import { BadRequest, Conflict, NotFound } from '../errors.ts';
import { requireAuth } from '../guards.ts';
import { actorOf, auditActorOf, auditContextOf, requestIps } from '../request-context.ts';

const MANDATORY_DELAY_HOURS = 24;

/** Solo un owner può stare in questa procedura, da qualunque lato. */
async function assertOwner(ctx: AppContext, userId: string): Promise<void> {
  const row = await ctx.db
    .selectFrom('auth.user_roles as ur')
    .innerJoin('auth.roles as r', 'r.id', 'ur.role_id')
    .select('r.id')
    .where('ur.user_id', '=', userId)
    .where('r.is_system', '=', true)
    .executeTakeFirst();
  if (!row) throw new BadRequest('SOLO_OWNER');
}

export async function registerTwoFactorResetRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // -------------------------------------------------------------------------
  // Apertura della richiesta.
  // -------------------------------------------------------------------------
  app.post(
    '/api/two-factor-resets',
    {
      preHandler: [requireAuth(ctx)],
      schema: {
        body: {
          type: 'object',
          required: ['targetUserId', 'reason'],
          additionalProperties: false,
          properties: {
            targetUserId: { type: 'string', maxLength: 64 },
            reason: { type: 'string', minLength: 10, maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      requireLevel(actor, 'utenti', 3);
      await assertOwner(ctx, actor.userId);

      const { targetUserId, reason } = request.body as { targetUserId: string; reason: string };
      const ips = requestIps(request);

      if (targetUserId === actor.userId) {
        // Aprire una richiesta su se stessi svuoterebbe la procedura: chi la
        // apre è anche chi ne beneficia, e restano due approvatori invece di
        // tre persone distinte.
        throw new BadRequest('NON_SU_TE_STESSO');
      }

      const created = await securityTransaction(ctx.db, async (trx) => {
        const target = await trx
          .selectFrom('auth.user')
          .select(['id', 'email', 'name'])
          .where('id', '=', targetUserId)
          .executeTakeFirst();
        if (!target) throw new NotFound();

        const row = await trx
          .insertInto('auth.two_factor_reset')
          .values({ target_user_id: targetUserId, requested_by: actor.userId, reason })
          .returning(['id'])
          .executeTakeFirst();
        if (!row) throw new Conflict('RICHIESTA_GIA_APERTA');

        return {
          result: { id: row.id, target },
          events: {
            action: AUDIT_ACTIONS.twoFactorResetRequested,
            outcome: 'success' as const,
            actor: auditActorOf(actor),
            request: auditContextOf(request, ips),
            moduleKey: 'utenti',
            targetType: 'user',
            targetId: targetUserId,
            targetLabel: target.email,
            meta: { reason, richiestaId: row.id },
          },
        };
      });

      // Vincolo 4 — notifica IMMEDIATA a tutti gli owner. Fuori transazione:
      // §10 vieta I/O di rete dentro la transazione che scrive audit.
      const owners = await ctx.db
        .selectFrom('auth.user as u')
        .innerJoin('auth.user_roles as ur', 'ur.user_id', 'u.id')
        .innerJoin('auth.roles as r', 'r.id', 'ur.role_id')
        .select(['u.email'])
        .where('r.is_system', '=', true)
        .where('u.status', '=', 'active')
        .execute();

      for (const owner of owners) {
        await ctx.mailer.send({
          to: owner.email,
          subject: 'MetaMC Admin — richiesta di reset 2FA aperta',
          text: [
            `${actor.actorDisplayName} ha aperto una richiesta di reset 2FA per ${created.target.email}.`,
            '',
            `Motivo: ${reason}`,
            '',
            'Servono DUE approvazioni di owner distinti, entrambi diversi dal richiedente,',
            `e una verifica out-of-band su un canale che conoscete già. Dopo la seconda`,
            `approvazione passano ${MANDATORY_DELAY_HOURS} ore prima che diventi effettiva.`,
            '',
            'Se non te lo aspettavi, annullala subito dal pannello.',
          ].join('\n'),
          html: '',
          idempotencyKey: `2fa-reset-open:${created.id}:${owner.email}`,
        });
      }

      return reply.code(201).send({ id: created.id, effectiveAfterHours: MANDATORY_DELAY_HOURS });
    },
  );

  // -------------------------------------------------------------------------
  // Approvazione. Serve due volte, da due owner distinti.
  // -------------------------------------------------------------------------
  app.post(
    '/api/two-factor-resets/:id/approve',
    {
      preHandler: [requireAuth(ctx)],
      schema: {
        body: {
          type: 'object',
          required: ['verificationChannel'],
          additionalProperties: false,
          properties: { verificationChannel: { type: 'string', minLength: 5, maxLength: 200 } },
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      requireLevel(actor, 'utenti', 3);
      await assertOwner(ctx, actor.userId);

      const { id } = request.params as { id: string };
      const { verificationChannel } = request.body as { verificationChannel: string };
      const ips = requestIps(request);

      const state = await securityTransaction(ctx.db, async (trx) => {
        const row = await trx
          .selectFrom('auth.two_factor_reset')
          .selectAll()
          .where('id', '=', id)
          .where('executed_at', 'is', null)
          .where('cancelled_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        if (!row) throw new NotFound();

        // Vincolo 1 — due owner DISTINTI, entrambi diversi dal richiedente. I
        // CHECK sulla tabella lo impongono comunque: qui si dà il messaggio.
        if (row.requested_by === actor.userId) throw new BadRequest('IL_RICHIEDENTE_NON_APPROVA');
        if (row.approved_by_1 === actor.userId) throw new BadRequest('HAI_GIA_APPROVATO');

        const now = new Date();
        const isSecond = row.approved_by_1 !== null;
        // Vincolo 3 — il ritardo parte dalla SECONDA approvazione, non dalla
        // richiesta: altrimenti basterebbe aprire la richiesta 24 ore prima e
        // approvarla in fretta al momento buono.
        const effectiveAt = isSecond ? new Date(now.getTime() + MANDATORY_DELAY_HOURS * 3600_000) : null;

        await trx
          .updateTable('auth.two_factor_reset')
          .set(
            isSecond
              ? {
                  approved_by_2: actor.userId,
                  approved_at_2: now,
                  effective_at: effectiveAt,
                  verification_channel: `${row.verification_channel ?? ''} | ${verificationChannel}`.trim(),
                }
              : {
                  approved_by_1: actor.userId,
                  approved_at_1: now,
                  verification_channel: verificationChannel,
                },
          )
          .where('id', '=', id)
          .execute();

        return {
          result: { isSecond, effectiveAt, targetUserId: row.target_user_id },
          events: {
            action: AUDIT_ACTIONS.twoFactorResetApproved,
            outcome: 'success' as const,
            actor: auditActorOf(actor),
            request: auditContextOf(request, ips),
            moduleKey: 'utenti',
            targetType: 'user',
            targetId: row.target_user_id,
            // Vincolo 5 — il canale di verifica finisce nell'audit. Se nessuno
            // sa dire dove ha verificato, non ha verificato.
            meta: { richiestaId: id, approvazione: isSecond ? 2 : 1, canale: verificationChannel },
          },
        };
      });

      return reply.send({
        approvals: state.isSecond ? 2 : 1,
        effectiveAt: state.effectiveAt?.toISOString() ?? null,
      });
    },
  );

  // -------------------------------------------------------------------------
  // Esecuzione. Possibile SOLO dopo le 24 ore.
  // -------------------------------------------------------------------------
  app.post(
    '/api/two-factor-resets/:id/execute',
    { preHandler: [requireAuth(ctx)] },
    async (request, reply) => {
      const actor = actorOf(request);
      requireLevel(actor, 'utenti', 3);
      await assertOwner(ctx, actor.userId);

      const { id } = request.params as { id: string };
      const ips = requestIps(request);

      const done = await securityTransaction(ctx.db, async (trx) => {
        const row = await trx
          .selectFrom('auth.two_factor_reset')
          .selectAll()
          .where('id', '=', id)
          .where('executed_at', 'is', null)
          .where('cancelled_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        if (!row) throw new NotFound();
        if (!row.approved_by_2 || !row.effective_at) throw new BadRequest('APPROVAZIONI_INSUFFICIENTI');
        if (row.effective_at > new Date()) throw new BadRequest('RITARDO_NON_TRASCORSO');

        const target = await trx
          .selectFrom('auth.user')
          .select(['id', 'email', 'name'])
          .where('id', '=', row.target_user_id)
          .executeTakeFirstOrThrow();

        // Il reset CANCELLA i fattori e riporta in pending_onboarding.
        await trx.deleteFrom('auth.twoFactor').where('userId', '=', target.id).execute();
        await trx.deleteFrom('auth.recovery_code').where('user_id', '=', target.id).execute();
        await trx
          .updateTable('auth.user')
          .set({
            twoFactorEnabled: false,
            status: 'pending_onboarding',
            sessions_valid_from: new Date(),
          })
          .where('id', '=', target.id)
          .execute();
        // Nessuna sessione sopravvive, e non se ne emette una nuova.
        await trx.deleteFrom('auth.session').where('userId', '=', target.id).execute();

        await trx
          .updateTable('auth.two_factor_reset')
          .set({ executed_at: new Date() })
          .where('id', '=', id)
          .execute();

        return {
          result: { target },
          events: {
            action: AUDIT_ACTIONS.twoFactorResetExecuted,
            outcome: 'success' as const,
            actor: auditActorOf(actor),
            request: auditContextOf(request, ips),
            moduleKey: 'utenti',
            targetType: 'user',
            targetId: target.id,
            targetLabel: target.email,
            meta: {
              richiestaId: id,
              richiedente: row.requested_by,
              approvatori: [row.approved_by_1, row.approved_by_2],
              canale: row.verification_channel,
            },
          },
        };
      });

      await ctx.store.invalidate(done.target.id);

      return reply.send({
        ok: true,
        // Nessun link magico: la persona rientra dal login e rifà l'enrollment.
        next: 'la persona deve accedere con la password e rifare l`enrollment TOTP',
      });
    },
  );

  // -------------------------------------------------------------------------
  // Annullamento. Sempre possibile, da qualunque owner, in qualunque momento
  // prima dell'esecuzione: è la valvola di sicurezza della procedura.
  // -------------------------------------------------------------------------
  app.post(
    '/api/two-factor-resets/:id/cancel',
    { preHandler: [requireAuth(ctx)] },
    async (request, reply) => {
      const actor = actorOf(request);
      requireLevel(actor, 'utenti', 3);
      await assertOwner(ctx, actor.userId);

      const { id } = request.params as { id: string };
      const ips = requestIps(request);

      await securityTransaction(ctx.db, async (trx) => {
        const row = await trx
          .updateTable('auth.two_factor_reset')
          .set({ cancelled_at: new Date(), cancelled_by: actor.userId })
          .where('id', '=', id)
          .where('executed_at', 'is', null)
          .where('cancelled_at', 'is', null)
          .returning(['target_user_id'])
          .executeTakeFirst();
        if (!row) throw new NotFound();

        return {
          result: undefined,
          events: {
            action: AUDIT_ACTIONS.twoFactorResetCancelled,
            outcome: 'success' as const,
            actor: auditActorOf(actor),
            request: auditContextOf(request, ips),
            moduleKey: 'utenti',
            targetType: 'user',
            targetId: row.target_user_id,
            meta: { richiestaId: id },
          },
        };
      });

      return reply.send({ ok: true });
    },
  );

  // -------------------------------------------------------------------------
  // Elenco delle richieste aperte.
  // -------------------------------------------------------------------------
  app.get('/api/two-factor-resets', { preHandler: [requireAuth(ctx)] }, async (request, reply) => {
    requireLevel(actorOf(request), 'utenti', 3);
    const rows = await ctx.db
      .selectFrom('auth.two_factor_reset as t')
      .innerJoin('auth.user as u', 'u.id', 't.target_user_id')
      .select([
        't.id',
        't.reason',
        't.requested_at',
        't.approved_at_1',
        't.approved_at_2',
        't.effective_at',
        't.verification_channel',
        'u.email as targetEmail',
      ])
      .where('t.executed_at', 'is', null)
      .where('t.cancelled_at', 'is', null)
      .orderBy('t.requested_at', 'desc')
      .execute();
    return reply.send({ requests: rows });
  });
}
