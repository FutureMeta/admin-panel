// Cambio email: conferma al nuovo indirizzo, annullamento dal vecchio.  §8.9

import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '#src/app-context.ts';
import { AUDIT_ACTIONS } from '#src/audit/actions.ts';
import { securityTransaction, writeAudit } from '#src/audit/log.ts';
import { forgetSessions } from '#src/auth/auth.ts';
import { PASSWORD_MAX } from '#src/auth/password.ts';
import { withPepperSubject } from '#src/auth/pepper-context.ts';
import { emailChangeNotice } from '#src/email/templates/notices.ts';
import { BadRequest, NotFound } from '../errors.ts';
import { requireAuth } from '../guards.ts';
import { actorOf, auditActorOf, auditContextOf, rateLimitIpKey, requestIps } from '../request-context.ts';
import { hashToken, newToken } from './account-password.ts';

const EMAIL_CONFIRM_TTL_HOURS = 24;
const EMAIL_CANCEL_TTL_HOURS = 72;

export async function registerEmailRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  /**
   * La password attuale e un codice TOTP nuovo, della persona collegata.
   *
   * La password passa dallo stesso `PasswordService` del login, con il pepper
   * con cui e' nato l'hash (SEC-40). Il codice passa dalla guardia anti-replay
   * (SEC-11) e poi da better-auth: con una sessione il cui secondo fattore e'
   * gia' verificato, `verifyTOTP` controlla il codice e non tocca altro.
   */
  const passwordAndCodeHold = async (
    userId: string,
    password: string,
    code: string,
    cookie: string | undefined,
  ): Promise<boolean> => {
    const row = await ctx.db
      .selectFrom('auth.account as a')
      .innerJoin('auth.user as u', 'u.id', 'a.userId')
      .select(['a.password', 'u.pepper_version'])
      .where('a.userId', '=', userId)
      .where('a.providerId', '=', 'credential')
      .executeTakeFirst();
    const hash = row?.password;
    if (!row || !hash) return ctx.passwords.verifyDecoy(password);
    const passwordOk = await withPepperSubject({ userId, pepperVersion: row.pepper_version }, () =>
      ctx.passwords.verify(hash, password),
    );
    if (!passwordOk) return false;

    if (!(await ctx.totpGuard.check(userId, code)).allowed) return false;
    const headers = new Headers();
    if (cookie) headers.set('cookie', cookie);
    try {
      await ctx.auth.api.verifyTOTP({ body: { code }, headers });
      return true;
    } catch {
      return false;
    }
  };

  // -------------------------------------------------------------------------
  // §8.9 — cambio email.
  //
  // Conferma al NUOVO indirizzo (24h) e notifica al VECCHIO con link di
  // annullamento (72h). Nessun cambio previous della confirmToken. Al completamento,
  // revoca di tutte le sessioni.
  //
  // LA RICHIESTA VUOLE PASSWORD E CODICE, non solo la sessione. Con la sola
  // sessione, un cookie rubato bastava a portare l'account su un indirizzo
  // dell'attaccante, e da li' al reset della password: il controllo
  // permanente dell'account a partire da un furto che il logout avrebbe
  // dovuto chiudere. Chi ha la sessione ma non la password e il telefono si
  // ferma qui.
  // -------------------------------------------------------------------------
  app.post(
    '/api/account/email',
    {
      // PERMESSO: basta la sessione — l'indirizzo di chi chiama, con password e codice.
      preHandler: [requireAuth(ctx)],
      bodyLimit: 4_096,
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password', 'code'],
          additionalProperties: false,
          properties: {
            email: { type: 'string', format: 'email', maxLength: 320 },
            password: { type: 'string', minLength: 1, maxLength: PASSWORD_MAX },
            code: { type: 'string', pattern: '^[0-9]{6}$' },
          },
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const ips = requestIps(request);
      const { email, password, code } = request.body as { email: string; password: string; code: string };
      const newEmail = email.trim().toLowerCase();

      // Il secchio del secondo fattore: cinque tentativi in un quarto d'ora
      // per persona, gli stessi del login.
      await ctx.rateLimit.consume('twoFactorAccount', actor.userId);
      if (!(await passwordAndCodeHold(actor.userId, password, code, request.headers.cookie))) {
        await ctx.rateLimit.penalize('twoFactorAccount', actor.userId);
        await writeAudit(ctx.db, {
          action: AUDIT_ACTIONS.userEmailChangeRequested,
          outcome: 'denied',
          actor: auditActorOf(actor),
          request: auditContextOf(request, ips),
          moduleKey: 'utenti',
          targetType: 'user',
          targetId: actor.userId,
          targetLabel: actor.actorEmail,
          meta: { reason: 'verifica_non_riuscita' },
        });
        // Uno solo per password e codice: dire quale dei due era giusto
        // aiuterebbe chi sta provando.
        throw new BadRequest('VERIFICA_NON_RIUSCITA');
      }
      await ctx.totpGuard.markUsed(actor.userId, code);
      await ctx.rateLimit.reward('twoFactorAccount', actor.userId);

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

      const tokens = await securityTransaction(ctx.db, async (trx) => {
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
        const sessions = await trx
          .deleteFrom('auth.session')
          .where('userId', '=', userId)
          .returning('token')
          .execute();
        await trx
          .deleteFrom('auth.verification')
          .where('identifier', 'like', `email-change:${userId}%`)
          .execute();

        return {
          result: sessions.map((s) => s.token),
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

      await forgetSessions(ctx.redis, tokens);
      await ctx.store.invalidate(userId);
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
