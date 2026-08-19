// Cicli di vita dell'account: recovery code al login, reset password,
// cambio email, reset 2FA assistito.  §8.4, §8.5, §8.7, §8.8, §8.9

import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '#src/app-context.ts';
import { AUDIT_ACTIONS } from '#src/audit/actions.ts';
import { securityTransaction, writeAudit } from '#src/audit/log.ts';
import { HibpUnavailable, PasswordCompromised } from '#src/auth/hibp.ts';
import { PASSWORD_MAX, PASSWORD_MIN } from '#src/auth/password.ts';
import {
  consumeRecoveryCode,
  countOpenRecoveryCodes,
  formatRecoveryCode,
  issueRecoveryCodes,
  RECOVERY_CODES_LOW_THRESHOLD,
} from '#src/auth/recovery-codes.ts';
import {
  emailChangeNotice,
  passwordChangedNotice,
  recoveryCodesLowNotice,
} from '#src/email/templates/notices.ts';
import { BadRequest, NotFound, Unauthorized } from '../errors.ts';
import { requireAuth } from '../guards.ts';
import { actorOf, auditActorOf, auditContextOf, rateLimitIpKey, requestIps } from '../request-context.ts';

/** Token opachi da 256 bit: in tabella va solo lo SHA-256. */
function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: createHash('sha256').update(token, 'utf8').digest('hex') };
}
function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

const RESET_TTL_MINUTES = 30;
const EMAIL_CONFIRM_TTL_HOURS = 24;
const EMAIL_CANCEL_TTL_HOURS = 72;

export async function registerAccountRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // -------------------------------------------------------------------------
  // §8.4 — login con recovery code.
  //
  // Primo rimedio della scala del §8.8: nessun intervento umano. Il consumption e'
  // atomico e il rate limit e' quello del TOTP.
  // -------------------------------------------------------------------------
  app.post(
    '/api/auth/recovery-code',
    {
      bodyLimit: 4_096,
      schema: {
        body: {
          type: 'object',
          required: ['code'],
          additionalProperties: false,
          properties: { code: { type: 'string', minLength: 20, maxLength: 40 } },
        },
      },
    },
    async (request, reply) => {
      const ips = requestIps(request);
      await ctx.rateLimit.consume('twoFactorIp', rateLimitIpKey(ips));

      // La challenge 2FA di better-auth identifica l'utente: senza, questa
      // rotta sarebbe un modo di enumerare i codici senza conoscere la password.
      const headers = new Headers();
      const cookie = request.headers.cookie;
      if (cookie) headers.set('cookie', cookie);
      const session = await ctx.auth.api.getSession({ headers });
      const userId = session?.session?.userId;
      if (!userId) throw new Unauthorized();

      await ctx.rateLimit.consume('recoveryAccount', userId);
      const { code } = request.body as { code: string };

      type RecoveryOutcome = { ok: boolean; remaining: number; email?: string; name?: string };

      const outcome = await securityTransaction<RecoveryOutcome>(ctx.db, async (trx) => {
        const consumption = await consumeRecoveryCode(trx, userId, code, ips.socketIp);
        const user = await trx
          .selectFrom('auth.user')
          .select(['email', 'name'])
          .where('id', '=', userId)
          .executeTakeFirstOrThrow();

        if (!consumption.ok) {
          return {
            result: { ok: false, remaining: 0 },
            events: {
              action: AUDIT_ACTIONS.userRecoveryCodeUsed,
              outcome: 'failure' as const,
              actor: { userId, email: user.email, displayName: user.name, sessionId: null },
              request: auditContextOf(request, ips),
              moduleKey: 'utenti',
              targetType: 'user',
              targetId: userId,
              targetLabel: user.email,
            },
          };
        }

        // Il recovery code sostituisce il secondo fattore: la sessione sale ad
        // aal=2 con amr `{pwd,recovery}`, che e' distinguibile da `{pwd,totp}`
        // nell'audit e nello step-up.
        await trx
          .updateTable('auth.session')
          .set({ aal: 2, authenticated_at: new Date(), amr: ['pwd', 'recovery'] })
          .where('userId', '=', userId)
          .where('aal', '<', 2)
          .execute();

        return {
          result: { ok: true, remaining: consumption.remaining, email: user.email, name: user.name },
          events: {
            action: AUDIT_ACTIONS.userRecoveryCodeUsed,
            outcome: 'success' as const,
            actor: { userId, email: user.email, displayName: user.name, sessionId: null },
            request: auditContextOf(request, ips),
            moduleKey: 'utenti',
            targetType: 'user',
            targetId: userId,
            targetLabel: user.email,
            meta: { rimasti: consumption.remaining },
          },
        };
      });

      if (!outcome.ok) {
        await ctx.rateLimit.penalize('recoveryAccount', userId);
        throw new Unauthorized();
      }

      await ctx.rateLimit.reward('recoveryAccount', userId);

      // §8.4 — avviso quando ne restano meno di 3. Fuori transazione.
      if (outcome.remaining < RECOVERY_CODES_LOW_THRESHOLD && outcome.email) {
        const tpl = recoveryCodesLowNotice({ remaining: outcome.remaining });
        await ctx.mailer.send({
          to: outcome.email,
          subject: tpl.subject,
          html: tpl.html,
          text: tpl.text,
          idempotencyKey: `recovery-low:${userId}:${outcome.remaining}`,
        });
      }

      return reply.send({ ok: true, remaining: outcome.remaining });
    },
  );

  // -------------------------------------------------------------------------
  // §8.4 — rigenerazione dei recovery code. Step-up obbligatorio.
  // -------------------------------------------------------------------------
  app.post(
    '/api/account/recovery-codes/regenerate',
    { preHandler: [requireAuth(ctx)] },
    async (request, reply) => {
      const actor = actorOf(request);
      const ips = requestIps(request);

      const result = await securityTransaction(ctx.db, async (trx) => {
        const { codes, generation } = await issueRecoveryCodes(trx, actor.userId);
        return {
          result: { codes, generation },
          events: {
            action: AUDIT_ACTIONS.userRecoveryCodesGenerated,
            outcome: 'success' as const,
            actor: auditActorOf(actor),
            request: auditContextOf(request, ips),
            moduleKey: 'utenti',
            targetType: 'user',
            targetId: actor.userId,
            targetLabel: actor.actorEmail,
            meta: { generation, count: codes.length },
          },
        };
      });

      // Mostrati UNA SOLA VOLTA.
      return reply.send({
        recoveryCodes: result.codes.map(formatRecoveryCode),
        generation: result.generation,
      });
    },
  );

  app.get('/api/account/recovery-codes/count', { preHandler: [requireAuth(ctx)] }, async (request, reply) => {
    const actor = actorOf(request);
    return reply.send({ remaining: await countOpenRecoveryCodes(ctx.db, actor.userId) });
  });

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
        await trx.deleteFrom('auth.session').where('userId', '=', userId).execute();
        await trx.deleteFrom('auth.verification').where('identifier', '=', `reset:${userId}`).execute();

        return {
          result: u,
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

  // -------------------------------------------------------------------------
  // §8.9 — cambio email.
  //
  // Conferma al NUOVO indirizzo (24h) e notifica al VECCHIO con link di
  // annullamento (72h). Nessun cambio previous della confirmToken. Al completamento,
  // revoca di tutte le sessioni.
  // -------------------------------------------------------------------------
  app.post(
    '/api/account/email',
    {
      preHandler: [requireAuth(ctx)],
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
      const actor = actorOf(request);
      const ips = requestIps(request);
      const { email } = request.body as { email: string };
      const newEmail = email.trim().toLowerCase();

      const taken = await ctx.db
        .selectFrom('auth.user')
        .select('id')
        .where((eb) => eb.fn('lower', ['email']), '=', newEmail)
        .executeTakeFirst();
      if (taken) throw new BadRequest('EMAIL_GIA_IN_USO');

      const confirmToken = newToken();
      const cancelToken = newToken();
      const confirmExpiresAt = new Date(Date.now() + EMAIL_CONFIRM_TTL_HOURS * 3600_000);
      const cancelExpiresAt = new Date(Date.now() + EMAIL_CANCEL_TTL_HOURS * 3600_000);

      await securityTransaction(ctx.db, async (trx) => {
        await trx
          .deleteFrom('auth.verification')
          .where('identifier', 'like', `email-change:${actor.userId}%`)
          .execute();
        await trx
          .insertInto('auth.verification')
          .values([
            {
              id: randomBytes(16).toString('hex'),
              identifier: `email-change:${actor.userId}:confirmToken:${newEmail}`,
              value: confirmToken.hash,
              expiresAt: confirmExpiresAt,
            },
            {
              id: randomBytes(16).toString('hex'),
              identifier: `email-change:${actor.userId}:cancelToken`,
              value: cancelToken.hash,
              expiresAt: cancelExpiresAt,
            },
          ])
          .execute();
        return {
          result: undefined,
          events: {
            action: AUDIT_ACTIONS.userEmailChangeRequested,
            outcome: 'success' as const,
            actor: auditActorOf(actor),
            request: auditContextOf(request, ips),
            moduleKey: 'utenti',
            targetType: 'user',
            targetId: actor.userId,
            targetLabel: actor.actorEmail,
            after: { newEmail },
          },
        };
      });

      const toNewAddress = emailChangeNotice({
        kind: 'confirm',
        link: `${ctx.env.APP_ORIGIN}/email-change?t=${confirmToken.token}`,
        expiresAt: confirmExpiresAt,
      });
      const toOldAddress = emailChangeNotice({
        kind: 'cancel',
        link: `${ctx.env.APP_ORIGIN}/email-change-cancel?t=${cancelToken.token}`,
        expiresAt: cancelExpiresAt,
        newEmail,
      });

      await ctx.mailer.send({
        to: newEmail,
        subject: toNewAddress.subject,
        html: toNewAddress.html,
        text: toNewAddress.text,
        idempotencyKey: `email-change:${actor.userId}:${confirmExpiresAt.getTime()}:new`,
      });
      await ctx.mailer.send({
        to: actor.actorEmail,
        subject: toOldAddress.subject,
        html: toOldAddress.html,
        text: toOldAddress.text,
        idempotencyKey: `email-change:${actor.userId}:${confirmExpiresAt.getTime()}:old`,
      });

      return reply.send({ ok: true });
    },
  );

  app.post(
    '/api/account/email/confirm',
    {
      bodyLimit: 4_096,
      schema: {
        body: {
          type: 'object',
          required: ['token'],
          additionalProperties: false,
          properties: { token: { type: 'string', minLength: 20, maxLength: 128 } },
        },
      },
    },
    async (request, reply) => {
      const ips = requestIps(request);
      const { token } = request.body as { token: string };
      await ctx.rateLimit.consume('forgotIp', rateLimitIpKey(ips));

      const row = await ctx.db
        .selectFrom('auth.verification')
        .select(['id', 'identifier'])
        .where('value', '=', hashToken(token))
        .where('expiresAt', '>', new Date())
        .executeTakeFirst();
      if (!row?.identifier.includes(':confirmToken:')) throw new BadRequest('TOKEN_NON_VALIDO');

      const [, userId, , newEmail] = row.identifier.split(':');
      if (!userId || !newEmail) throw new BadRequest('TOKEN_NON_VALIDO');

      const user = await securityTransaction(ctx.db, async (trx) => {
        const spent = await trx
          .deleteFrom('auth.verification')
          .where('id', '=', row.id)
          .returning('id')
          .executeTakeFirst();
        if (!spent) throw new BadRequest('TOKEN_NON_VALIDO');

        const previous = await trx
          .selectFrom('auth.user')
          .select(['id', 'email', 'name'])
          .where('id', '=', userId)
          .executeTakeFirst();
        if (!previous) throw new NotFound();

        await trx
          .updateTable('auth.user')
          .set({ email: newEmail, emailVerified: true, sessions_valid_from: new Date() })
          .where('id', '=', userId)
          .execute();
        // §8.9 — revoca di tutte le sessioni al completamento.
        await trx.deleteFrom('auth.session').where('userId', '=', userId).execute();
        await trx
          .deleteFrom('auth.verification')
          .where('identifier', 'like', `email-change:${userId}%`)
          .execute();

        return {
          result: previous,
          events: {
            action: AUDIT_ACTIONS.userEmailChanged,
            outcome: 'success' as const,
            actor: { userId, email: previous.email, displayName: previous.name, sessionId: null },
            request: auditContextOf(request, ips),
            moduleKey: 'utenti',
            targetType: 'user',
            targetId: userId,
            targetLabel: previous.email,
            before: { email: previous.email },
            after: { email: newEmail },
          },
        };
      });

      await ctx.store.invalidate(userId);
      void user;
      return reply.send({ ok: true, next: '/login' });
    },
  );

  app.post(
    '/api/account/email/cancel',
    {
      bodyLimit: 4_096,
      schema: {
        body: {
          type: 'object',
          required: ['token'],
          additionalProperties: false,
          properties: { token: { type: 'string', minLength: 20, maxLength: 128 } },
        },
      },
    },
    async (request, reply) => {
      const ips = requestIps(request);
      const { token } = request.body as { token: string };
      await ctx.rateLimit.consume('forgotIp', rateLimitIpKey(ips));

      const row = await ctx.db
        .selectFrom('auth.verification')
        .select(['id', 'identifier'])
        .where('value', '=', hashToken(token))
        .where('expiresAt', '>', new Date())
        .executeTakeFirst();
      if (!row?.identifier.endsWith(':cancelToken')) throw new BadRequest('TOKEN_NON_VALIDO');

      const userId = row.identifier.split(':')[1];
      if (!userId) throw new BadRequest('TOKEN_NON_VALIDO');

      await securityTransaction(ctx.db, async (trx) => {
        // Annullare cancella ENTRAMBI i token: il cambio non puo' piu'
        // completarsi nemmeno se qualcuno ha ancora il link di confirmToken.
        await trx
          .deleteFrom('auth.verification')
          .where('identifier', 'like', `email-change:${userId}%`)
          .execute();
        const u = await trx
          .selectFrom('auth.user')
          .select(['email', 'name'])
          .where('id', '=', userId)
          .executeTakeFirst();
        return {
          result: undefined,
          events: {
            action: AUDIT_ACTIONS.userEmailChangeCancelled,
            outcome: 'success' as const,
            actor: { userId, email: u?.email ?? null, displayName: u?.name ?? null, sessionId: null },
            request: auditContextOf(request, ips),
            moduleKey: 'utenti',
            targetType: 'user',
            targetId: userId,
            targetLabel: u?.email ?? null,
          },
        };
      });

      return reply.send({ ok: true });
    },
  );
}
