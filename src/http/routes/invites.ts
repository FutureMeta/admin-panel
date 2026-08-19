// Rotte degli inviti. §8.1
//
// SEC-20 — nessun parametro di redirect accettato dal client. Le destinazioni
// post-accept e post-enrollment sono costanti server-side: `/accept` e `/`.
// Il precedente e' reale (GHSA-vp58-j275-797x / CVE-2025-71403 su better-auth,
// bypass di trustedOrigins usato per rubare il token di reset).

// L'altra meta' del ciclo — accettazione, enrollment TOTP, recovery code — sta
// in invites-onboarding.ts: li' agisce chi e' invitato, qui chi invita, e le
// due meta' non condividono ne' autorizzazione ne' contesto.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '#src/app-context.ts';
import { AUDIT_ACTIONS } from '#src/audit/actions.ts';
import { securityTransaction, writeAudit } from '#src/audit/log.ts';
import { sanitizeDisplayName } from '#src/audit/sanitize.ts';
import { require as requireLevel } from '#src/authz/can.ts';
import { canGrantRole, isSystemRole } from '#src/authz/dominance.ts';
import { inviteEmail } from '#src/email/templates/invite.ts';
import { assertInvitable, InviteConflict, insertInvite } from '#src/invites/service.ts';
import { BadRequest, Conflict, NotFound } from '../errors.ts';
import { requireAuth } from '../guards.ts';
import { actorOf, auditActorOf, auditContextOf, requestIps } from '../request-context.ts';

const createInviteSchema = {
  body: {
    type: 'object',
    required: ['email', 'name', 'roleId'],
    additionalProperties: false,
    properties: {
      email: { type: 'string', format: 'email', maxLength: 320 },
      /**
       * Il nome con cui la persona comparira' nel registro. Lo decide chi
       * invita, non chi accetta: e' l'etichetta con cui gli altri la
       * riconoscono leggendo chi ha fatto cosa, e lasciarla scegliere a chi
       * arriva vorrebbe dire permettergli di presentarsi come vuole.
       */
      name: { type: 'string', minLength: 1, maxLength: 120 },
      roleId: { type: 'integer', minimum: 1 },
    },
  },
} as const;

/** Le etichette dei livelli, le stesse che mostra il pannello. */
const LEVEL_LABELS: Record<number, string> = {
  1: 'Lettura',
  2: 'Scrittura',
  3: 'Gestione',
};

export async function registerInviteRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // -------------------------------------------------------------------------
  // POST /api/invites — emissione
  // -------------------------------------------------------------------------
  app.post(
    '/api/invites',
    { schema: createInviteSchema, preHandler: [requireAuth(ctx)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = actorOf(request);
      requireLevel(actor, 'inviti', 2);

      const body = request.body as { email: string; name: string; roleId: number };
      const emailLower = body.email.trim().toLowerCase();
      // Stessa ripulitura del registro: niente caratteri di controllo, niente
      // sequenze bidirezionali, lunghezza limitata.
      const displayName = sanitizeDisplayName(body.name);
      const ips = requestIps(request);

      // SEC-38 — la validazione JSON Schema non e' mai l'unico enforcement di
      // un invariante di sicurezza: `roleId` viene rivalidato qui contro la
      // fonte di verita', non solo contro lo schema.
      if (await isSystemRole(ctx.db, body.roleId)) {
        // SEC-09 — il ruolo owner non e' assegnabile via invito.
        throw new BadRequest('RUOLO_NON_ASSEGNABILE');
      }
      // SEC-07 — nessuno concede cio' che non ha.
      if (!(await canGrantRole(ctx.db, actor.userId, body.roleId))) {
        await writeAudit(ctx.db, {
          action: AUDIT_ACTIONS.inviteRejected,
          outcome: 'denied',
          actor: auditActorOf(actor),
          request: auditContextOf(request, ips),
          moduleKey: 'inviti',
          targetType: 'role',
          targetId: String(body.roleId),
          // Severita' alta: un tentativo di concedere piu' di quanto si ha
          // non e' un errore di battitura.
          meta: { reason: 'concedibilita`', severita: 'alta' },
        });
        throw new BadRequest('RUOLO_NON_CONCEDIBILE');
      }

      let created: { id: string; token: string; expiresAt: Date };
      try {
        created = await securityTransaction(ctx.db, async (trx) => {
          await assertInvitable(trx, emailLower, actor.userId);
          const invite = await insertInvite(trx, {
            emailLower,
            displayName,
            roleId: body.roleId,
            invitedBy: actor.userId,
          });
          return {
            result: invite,
            events: {
              action: AUDIT_ACTIONS.inviteCreate,
              outcome: 'success' as const,
              actor: auditActorOf(actor),
              request: auditContextOf(request, ips),
              moduleKey: 'inviti',
              targetType: 'invitation',
              targetId: invite.id,
              targetLabel: emailLower,
              after: { email: emailLower, roleId: body.roleId, expiresAt: invite.expiresAt.toISOString() },
            },
          };
        });
      } catch (err) {
        if (err instanceof InviteConflict) throw new Conflict(err.code.toUpperCase());
        // L'indice parziale `invitation_one_pending_per_email` e' l'invariante
        // vero: una corsa fra due emissioni finisce qui.
        if (err instanceof Error && /invitation_one_pending_per_email/.test(err.message)) {
          throw new Conflict('INVITO_PENDENTE');
        }
        throw err;
      }

      // §10 — l'invio e' FUORI dalla transazione. Dentro, il lock della catena
      // hash si serializzerebbe sulla latenza di Resend e ogni azione di ogni
      // admin si accoderebbe dietro un'email.
      const link = `${ctx.env.APP_ORIGIN}/accept?t=${created.token}`;

      // Ruolo e moduli per il riquadro dell'email. Sono gli stessi che la
      // pagina di accettazione mostrera': dirli qui non anticipa nulla che non
      // sia gia' suo, e rende esplicito il perimetro prima ancora di entrare.
      const role = await ctx.db
        .selectFrom('auth.roles')
        .select('name')
        .where('id', '=', body.roleId)
        .executeTakeFirst();
      const modules = await ctx.db
        .selectFrom('auth.role_permissions as rp')
        .innerJoin('auth.modules as m', 'm.id', 'rp.module_id')
        .select(['m.name as name', 'rp.level as level'])
        .where('rp.role_id', '=', body.roleId)
        .where('rp.level', '>', 0)
        .orderBy('m.sort_order')
        .execute();

      const template = inviteEmail({
        // SEC-44 — nessun valore arriva da chi ricevera' il messaggio. Nome e
        // indirizzo li ha scritti chi invita, ruolo e moduli vengono dal
        // database, e tutto passa comunque dall'escaping del layout.
        inviteeName: displayName,
        inviteeEmail: emailLower,
        inviterName: sanitizeDisplayName(actor.actorDisplayName),
        roleName: role?.name ?? 'ruolo',
        modules: modules.map((m) => ({ name: m.name, level: LEVEL_LABELS[m.level] ?? String(m.level) })),
        link,
        createdAt: new Date(),
        expiresAt: created.expiresAt,
      });

      const sent = await ctx.mailer.send({
        to: emailLower,
        subject: template.subject,
        html: template.html,
        text: template.text,
        // SEC-46 — deterministica, derivata dall'evento di dominio.
        idempotencyKey: `invite:${created.id}:1`,
      });

      if (sent.ok) {
        await ctx.db
          .updateTable('auth.invitation')
          .set({ resend_message_id: sent.messageId })
          .where('id', '=', created.id)
          .execute();
      }

      await writeAudit(ctx.db, {
        action: sent.ok ? AUDIT_ACTIONS.inviteEmailSent : AUDIT_ACTIONS.inviteEmailFailed,
        outcome: sent.ok ? 'success' : 'failure',
        actor: auditActorOf(actor),
        request: auditContextOf(request, ips),
        moduleKey: 'inviti',
        targetType: 'invitation',
        targetId: created.id,
        targetLabel: emailLower,
        meta: sent.ok ? { messageId: sent.messageId } : { reason: sent.reason, retryable: sent.retryable },
      });

      // Il token NON torna nella risposta: esiste solo nell'email.
      return reply.code(201).send({
        id: created.id,
        email: emailLower,
        expiresAt: created.expiresAt.toISOString(),
        emailSent: sent.ok,
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/invites — elenco dei pendenti
  // -------------------------------------------------------------------------
  app.get(
    '/api/invites',
    { preHandler: [requireAuth(ctx)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      requireLevel(actorOf(request), 'inviti', 1);
      const rows = await ctx.db
        .selectFrom('auth.invitation as i')
        .innerJoin('auth.roles as r', 'r.id', 'i.role_id')
        .leftJoin('auth.user as u', 'u.id', 'i.invited_by')
        .select([
          'i.id',
          'i.email_lower as email',
          'i.display_name as name',
          'i.created_at as createdAt',
          'i.expires_at as expiresAt',
          'r.name as roleName',
          'u.name as invitedByName',
        ])
        .where('i.consumed_at', 'is', null)
        .where('i.revoked_at', 'is', null)
        .orderBy('i.created_at', 'desc')
        .limit(200)
        .execute();
      return reply.send({ invites: rows });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/invites/:id/revoke
  // -------------------------------------------------------------------------
  app.post(
    '/api/invites/:id/revoke',
    { preHandler: [requireAuth(ctx)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = actorOf(request);
      requireLevel(actor, 'inviti', 2);
      const { id } = request.params as { id: string };
      const ips = requestIps(request);

      const revoked = await securityTransaction(ctx.db, async (trx) => {
        const row = await trx
          .updateTable('auth.invitation')
          .set({ revoked_at: new Date(), revoked_by: actor.userId })
          .where('id', '=', id)
          .where('consumed_at', 'is', null)
          .where('revoked_at', 'is', null)
          .returning(['id', 'email_lower'])
          .executeTakeFirst();

        if (!row) throw new NotFound();

        return {
          result: row,
          events: {
            action: AUDIT_ACTIONS.inviteRevoked,
            outcome: 'success' as const,
            actor: auditActorOf(actor),
            request: auditContextOf(request, ips),
            moduleKey: 'inviti',
            targetType: 'invitation',
            targetId: row.id,
            targetLabel: row.email_lower,
          },
        };
      });

      return reply.send({ id: revoked.id, revoked: true });
    },
  );
}
