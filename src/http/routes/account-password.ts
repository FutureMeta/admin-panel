// Reset della password.  §8.7

import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '#src/app-context.ts';
import { AUDIT_ACTIONS } from '#src/audit/actions.ts';
import { securityTransaction, writeAudit } from '#src/audit/log.ts';
import { forgetSessions } from '#src/auth/auth.ts';
import { HibpUnavailable, PasswordCompromised } from '#src/auth/hibp.ts';
import { PASSWORD_MAX, PASSWORD_MIN } from '#src/auth/password.ts';
import { passwordChangedNotice } from '#src/email/templates/notices.ts';
import { BadRequest, NotFound } from '../errors.ts';
import { auditContextOf, rateLimitIpKey, requestIps } from '../request-context.ts';

/** Token opachi da 256 bit: in tabella va solo lo SHA-256. */
export function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: createHash('sha256').update(token, 'utf8').digest('hex') };
}
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

const RESET_TTL_MINUTES = 30;

export async function registerPasswordRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // -------------------------------------------------------------------------
  // §8.7 — reset password.
  //
  // La risposta e' IDENTICA per email esistente e inesistente. Il token vale
  // 30 minuti, e' monouso, e al completamento NON viene emessa alcuna
  // sessione: l'utente fa un login normale e supera comunque il TOTP. Il
  // reset password non bypassa mai il secondo fattore.
  // -------------------------------------------------------------------------
  app.post(
    '/api/account/forgot-password',
    {
      bodyLimit: 4_096,
      schema: {
        body: {
          type: 'object',
          required: ['email'],
          additionalProperties: false,
          properties: { email: { type: 'string', format: 'email', maxLength: 320 } },
        },
      },
    },
    async (request, reply) => {
      const ips = requestIps(request);
      const { email } = request.body as { email: string };
      const emailLower = email.trim().toLowerCase();

      // SEC-25 — i limiti si consumano PRIMA di qualunque lavoro, e anche per
      // un'email che non esiste.
      await ctx.rateLimit.consume('forgotIp', rateLimitIpKey(ips));
      await ctx.rateLimit.consume('forgotAccount', emailLower);

      const user = await ctx.db
        .selectFrom('auth.user')
        .select(['id', 'email', 'name', 'status'])
        .where((eb) => eb.fn('lower', ['email']), '=', emailLower)
        .executeTakeFirst();

      if (user && user.status !== 'disabled') {
        const { token, hash } = newToken();
        const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60_000);

        await securityTransaction(ctx.db, async (trx) => {
          // Un solo reset pendente per utente: emetterne un altro invalida
          // il precedente.
          await trx.deleteFrom('auth.verification').where('identifier', '=', `reset:${user.id}`).execute();
          await trx
            .insertInto('auth.verification')
            .values({
              id: randomBytes(16).toString('hex'),
              identifier: `reset:${user.id}`,
              value: hash,
              expiresAt,
            })
            .execute();
          return {
            result: undefined,
            events: {
              action: AUDIT_ACTIONS.userPasswordResetRequested,
              outcome: 'success' as const,
              actor: { userId: user.id, email: user.email, displayName: user.name, sessionId: null },
              request: auditContextOf(request, ips),
              moduleKey: 'utenti',
              targetType: 'user',
              targetId: user.id,
              targetLabel: user.email,
            },
          };
        });

        const link = `${ctx.env.APP_ORIGIN}/reset?t=${token}`;
        const tpl = passwordChangedNotice({
          kind: 'reset-requested',
          link,
          expiresAt,
          requestedAt: new Date(),
          userName: user.name,
          userEmail: user.email,
          // L'IP nel piede dell'email non e' decorazione: e' cio' che permette
          // a chi NON ha chiesto il reset di capire da dove e' partito.
          ip: ips.ip,
        });
        // L'invio NON puo' far fallire la richiesta.
        //
        // Due motivi. Il primo e' SEC-31: se un errore del servizio di posta
        // diventasse un 500, un indirizzo REGISTRATO risponderebbe 500 e uno
        // inesistente 200 — cioe' esattamente l'oracolo che tutto il resto di
        // questa rotta esiste per non dare. Il secondo e' pratico: il token e'
        // gia' scritto e valido, e una schermata d'errore su un reset che in
        // realta' e' partito manda la persona a chiederne un altro.
        //
        // Il fallimento non sparisce: finisce nel registro, dove chi guarda lo
        // vede.
        try {
          await ctx.mailer.send({
            to: user.email,
            subject: tpl.subject,
            html: tpl.html,
            text: tpl.text,
            idempotencyKey: `reset:${user.id}:${expiresAt.getTime()}`,
          });
        } catch (err) {
          request.log.error({ err, userId: user.id }, 'invio del link di reset fallito');
          await writeAudit(ctx.db, {
            action: AUDIT_ACTIONS.userPasswordResetRequested,
            outcome: 'failure',
            actor: { userId: user.id, email: user.email, displayName: user.name, sessionId: null },
            request: auditContextOf(request, ips),
            moduleKey: 'utenti',
            targetType: 'user',
            targetId: user.id,
            targetLabel: user.email,
            meta: { reason: 'invio email fallito' },
          });
        }
      }

      // Risposta identica in ogni caso. Nessun dettaglio, nessun conteggio.
      return reply.send({ ok: true });
    },
  );

  app.post(
    '/api/account/reset-password',
    {
      bodyLimit: 4_096,
      schema: {
        body: {
          type: 'object',
          required: ['token', 'password'],
          additionalProperties: false,
          properties: {
            token: { type: 'string', minLength: 20, maxLength: 128 },
            password: { type: 'string', minLength: PASSWORD_MIN, maxLength: PASSWORD_MAX },
          },
        },
      },
    },
    async (request, reply) => {
      const ips = requestIps(request);
      const { token, password } = request.body as { token: string; password: string };
      await ctx.rateLimit.consume('forgotIp', rateLimitIpKey(ips));

      const row = await ctx.db
        .selectFrom('auth.verification')
        .select(['id', 'identifier', 'expiresAt'])
        .where('value', '=', hashToken(token))
        .where('expiresAt', '>', new Date())
        .executeTakeFirst();

      // SEC-32 — risposta identica per token inesistente, scaduto e gia' spent.
      if (!row) throw new BadRequest('TOKEN_NON_VALIDO');
      const userId = row.identifier.replace(/^reset:/, '');

      // §8.6 — HIBP fuori transazione, fail-closed.
      const verdict = await ctx.hibp.check(password);
      if (verdict.status === 'compromised') throw new PasswordCompromised(verdict.occurrences);
      if (verdict.status === 'unavailable') {
        await writeAudit(ctx.db, {
          action: AUDIT_ACTIONS.hibpUnavailable,
          outcome: 'failure',
          actor: { userId, email: null, displayName: null, sessionId: null },
          request: auditContextOf(request, ips),
          meta: { reason: verdict.reason, contesto: 'reset-password' },
        });
        throw new HibpUnavailable(verdict.reason);
      }
      const hash = await ctx.passwords.hash(password);

      const user = await securityTransaction(ctx.db, async (trx) => {
        // Consumo atomico: la DELETE con l'id nella WHERE e' la mutua
        // esclusione. Zero righe = qualcun altro l'ha gia' spent.
        const spent = await trx
          .deleteFrom('auth.verification')
          .where('id', '=', row.id)
          .returning('id')
          .executeTakeFirst();
        if (!spent) throw new BadRequest('TOKEN_NON_VALIDO');

        const u = await trx
          .selectFrom('auth.user')
          .select(['id', 'email', 'name'])
          .where('id', '=', userId)
          .executeTakeFirst();
        if (!u) throw new NotFound();

        await trx
          .updateTable('auth.account')
          .set({ password: hash, updatedAt: new Date() })
          .where('userId', '=', userId)
          .where('providerId', '=', 'credential')
          .execute();
        await trx
          .updateTable('auth.user')
          .set({ password_updated_at: new Date(), sessions_valid_from: new Date() })
          .where('id', '=', userId)
          .execute();

        // §8.7.5 — revoca di TUTTE le sessioni e di tutti i reset pendenti.
        const sessions = await trx
          .deleteFrom('auth.session')
          .where('userId', '=', userId)
          .returning('token')
          .execute();
        await trx.deleteFrom('auth.verification').where('identifier', '=', `reset:${userId}`).execute();

        return {
          result: { ...u, tokens: sessions.map((s) => s.token) },
          events: {
            action: AUDIT_ACTIONS.userPasswordResetCompleted,
            outcome: 'success' as const,
            actor: { userId: u.id, email: u.email, displayName: u.name, sessionId: null },
            request: auditContextOf(request, ips),
            moduleKey: 'utenti',
            targetType: 'user',
            targetId: u.id,
            targetLabel: u.email,
          },
        };
      });

      await forgetSessions(ctx.redis, user.tokens);
      await ctx.store.invalidate(userId);

      const tpl = passwordChangedNotice({ kind: 'reset-completed', at: new Date() });
      await ctx.mailer.send({
        to: user.email,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
        idempotencyKey: `reset-done:${userId}:${Date.now()}`,
      });

      // §8.7.4 — NESSUNA sessione emessa. Il reset non bypassa il 2FA.
      return reply.send({ ok: true, next: '/login' });
    },
  );
}
