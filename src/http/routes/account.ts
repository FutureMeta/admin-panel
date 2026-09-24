// Il secondo fattore dell'account: login con recovery code, attivazione
// del TOTP, codici di recupero.  §8.4, §8.5

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '#src/app-context.ts';
import { AUDIT_ACTIONS } from '#src/audit/actions.ts';
import { securityTransaction } from '#src/audit/log.ts';
import { absoluteCap } from '#src/auth/auth.ts';
import { PASSWORD_MAX } from '#src/auth/password.ts';
import { withPepperSubject } from '#src/auth/pepper-context.ts';
import {
  consumeRecoveryCode,
  countOpenRecoveryCodes,
  formatRecoveryCode,
  issueRecoveryCodes,
  RECOVERY_CODES_LOW_THRESHOLD,
} from '#src/auth/recovery-codes.ts';
import { recoveryCodesLowNotice } from '#src/email/templates/notices.ts';
import { issueCsrfCookie } from '../csrf.ts';
import { BadRequest, NotFound, Unauthorized } from '../errors.ts';
import { requireAuth } from '../guards.ts';
import { actorOf, auditActorOf, auditContextOf, rateLimitIpKey, requestIps } from '../request-context.ts';
import { completeTotpEnrollment } from '../totp-enrollment.ts';

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
      //
      // E' la CHALLENGE, non una sessione: con il secondo fattore attivo,
      // dopo la password better-auth lascia solo il cookie `two_factor`. Qui
      // si cercava una sessione, che a questo punto non esiste, e la rotta
      // rispondeva 401 a chiunque.
      const headers = new Headers();
      const cookie = request.headers.cookie;
      if (cookie) headers.set('cookie', cookie);
      const { userId } = await ctx.auth.api.twoFactorChallengeUser({ headers });
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

      // Il codice e' speso: ora la challenge diventa una sessione, e SOLO
      // quella sale ad aal=2. Con amr `{pwd,recovery}`, che resta distinguibile
      // da `{pwd,totp}` nel registro. Promuovere ogni sessione dell'utente
      // ancora sotto il 2 alzerebbe anche quella di chiunque altro avesse la
      // password e si fosse fermato alla challenge.
      const opened = await ctx.auth.api.completeTwoFactorChallenge({ headers, returnHeaders: true });
      await ctx.db
        .updateTable('auth.session')
        .set({
          aal: 2,
          authenticated_at: new Date(),
          amr: ['pwd', 'recovery'],
          absolute_expires_at: absoluteCap(ctx.env.SESSION_ABSOLUTE_SECONDS),
        })
        .where('id', '=', opened.response.sessionId)
        .execute();
      for (const c of opened.headers.getSetCookie()) reply.header('set-cookie', c);
      // SEC-17 — il cookie CSRF nasce con la sessione, come nel ponte.
      issueCsrfCookie(reply, ctx.keys.csrf, opened.response.sessionId, ctx.env.SESSION_ABSOLUTE_SECONDS);

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
  // §8.8 — il rientro dopo un reset del secondo fattore.
  //
  // Il reset cancella i fattori e riporta l'account in `pending_onboarding`:
  // «la persona rientra dal login e rifa' l'enrollment». Il login la faceva
  // entrare — senza 2FA better-auth emette subito una sessione — ma da li' non
  // c'era niente: il middleware la rifiutava perche' non attiva, e nessuna
  // schermata permetteva di rifare il secondo fattore. Restava fuori per
  // sempre, con la password giusta in mano.
  //
  // Queste due rotte sono la porta che mancava: la stessa chiusura
  // dell'invito, per chi ha gia' un account. Rispondono SOLO a una sessione di
  // un account in attesa di enrollment: per tutti gli altri non esistono.
  // -------------------------------------------------------------------------
  const pendingUserOf = async (
    request: FastifyRequest,
  ): Promise<{ userId: string; pepperVersion: number }> => {
    const headers = new Headers();
    const cookie = request.headers.cookie;
    if (cookie) headers.set('cookie', cookie);
    const session = await ctx.auth.api.getSession({ headers });
    const userId = session?.session?.userId;
    if (!userId) throw new Unauthorized();
    const row = await ctx.db
      .selectFrom('auth.user')
      .select(['status', 'banned', 'twoFactorEnabled', 'pepper_version'])
      .where('id', '=', userId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (row?.status !== 'pending_onboarding' || row.banned || row.twoFactorEnabled) throw new NotFound();
    return { userId, pepperVersion: row.pepper_version };
  };

  app.post(
    '/api/account/two-factor/enroll',
    {
      bodyLimit: 4_096,
      schema: {
        body: {
          type: 'object',
          required: ['password'],
          additionalProperties: false,
          properties: { password: { type: 'string', minLength: 1, maxLength: PASSWORD_MAX } },
        },
      },
    },
    async (request, reply) => {
      const { userId, pepperVersion } = await pendingUserOf(request);
      const { password } = request.body as { password: string };
      await ctx.rateLimit.consume('twoFactorAccount', userId);

      // better-auth conia il segreto solo con la password: e' la stessa
      // richiesta dell'invito, con il pepper con cui e' nato l'hash (SEC-40).
      const headers = new Headers();
      if (request.headers.cookie) headers.set('cookie', request.headers.cookie);
      let enabled: { totpURI?: string };
      try {
        enabled = (await withPepperSubject({ userId, pepperVersion }, () =>
          ctx.auth.api.enableTwoFactor({ body: { password }, headers }),
        )) as { totpURI?: string };
      } catch {
        await ctx.rateLimit.penalize('twoFactorAccount', userId);
        throw new BadRequest('VERIFICA_NON_RIUSCITA');
      }
      return reply.send({ totpURI: enabled.totpURI ?? null });
    },
  );

  app.post(
    '/api/account/two-factor/complete',
    {
      bodyLimit: 4_096,
      schema: {
        body: {
          type: 'object',
          required: ['code'],
          additionalProperties: false,
          properties: { code: { type: 'string', pattern: '^[0-9]{6}$' } },
        },
      },
    },
    async (request, reply) => {
      const { userId } = await pendingUserOf(request);
      const { code } = request.body as { code: string };
      const result = await completeTotpEnrollment(ctx, request, reply, userId, code);
      // I recovery code si mostrano UNA SOLA VOLTA (§8.1.12).
      return reply.send({
        recoveryCodes: result.codes.map(formatRecoveryCode),
        generation: result.generation,
        next: '/',
      });
    },
  );

  // -------------------------------------------------------------------------
  // §8.4 — rigenerazione dei recovery code. Step-up obbligatorio.
  // -------------------------------------------------------------------------
  app.post(
    '/api/account/recovery-codes/regenerate',
    { preHandler: [requireAuth(ctx)] },
    async (request, reply) => {
      // PERMESSO: basta la sessione — sono i codici di chi chiama, e di nessun altro.
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
    // PERMESSO: basta la sessione — quanti codici restano a chi chiama.
    const actor = actorOf(request);
    return reply.send({ remaining: await countOpenRecoveryCodes(ctx.db, actor.userId) });
  });
}
