// Accettazione dell'invito e enrollment. §8.1.8-12
//
// Sta in un file separato da invites.ts perche' e' l'altra meta' del ciclo:
// li' agisce chi invita, qui chi e' invitato, e le due meta' non condividono
// ne' autorizzazione ne' contesto.

import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '#src/app-context.ts';
import { AUDIT_ACTIONS } from '#src/audit/actions.ts';
import { securityTransaction, writeAudit } from '#src/audit/log.ts';
import { sanitizeDisplayName } from '#src/audit/sanitize.ts';
import { HibpUnavailable, PasswordCompromised } from '#src/auth/hibp.ts';
import { PASSWORD_MAX, PASSWORD_MIN } from '#src/auth/password.ts';
import { formatRecoveryCode, issueRecoveryCodes } from '#src/auth/recovery-codes.ts';
import {
  claimInvite,
  consumeInvite,
  createUserFromInvite,
  findSpendableInvite,
  hashInviteToken,
  ONBOARDING_TTL_SECONDS,
} from '#src/invites/service.ts';
import { BadRequest, Conflict, Unauthorized } from '../errors.ts';
import { auditContextOf, rateLimitIpKey, requestIps } from '../request-context.ts';

export const ONBOARDING_COOKIE = '__Host-metamc_onboarding';

export type OnboardingState = {
  inviteId: string;
  emailLower: string;
  roleId: number;
  tokenHash: string;
  userId?: string;
};

const acceptSchema = {
  body: {
    type: 'object',
    required: ['password', 'name'],
    additionalProperties: false,
    properties: {
      password: { type: 'string', minLength: PASSWORD_MIN, maxLength: PASSWORD_MAX },
      name: { type: 'string', minLength: 1, maxLength: 120 },
    },
  },
} as const;

const completeSchema = {
  body: {
    type: 'object',
    required: ['code'],
    additionalProperties: false,
    properties: { code: { type: 'string', minLength: 6, maxLength: 8 } },
  },
} as const;

export async function registerOnboardingRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const onboardingKey = (token: string) => `onb:${token}`;

  async function readOnboarding(request: FastifyRequest): Promise<{ token: string; state: OnboardingState }> {
    const token = request.cookies[ONBOARDING_COOKIE];
    if (!token) throw new Unauthorized();
    const raw = await ctx.redis.get(onboardingKey(token));
    if (!raw) throw new Unauthorized();
    return { token, state: JSON.parse(raw) as OnboardingState };
  }

  // -------------------------------------------------------------------------
  // GET /accept?t=... — §8.1.7
  //
  // Il token viene scambiato SUBITO con una sessione di onboarding e la URL
  // ripulita con un 302. `Referrer-Policy: no-referrer` e `Cache-Control:
  // no-store` (SEC-21): senza, il token finirebbe nel Referer della prima
  // risorsa esterna e nella cronologia del browser.
  // -------------------------------------------------------------------------
  app.get('/accept', async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'no-store');

    const query = request.query as { t?: string };
    const ips = requestIps(request);

    // Nessun token: e' il secondo passaggio, dopo il redirect. Si serve la SPA.
    if (!query.t) {
      reply.header('Content-Type', 'text/html; charset=utf-8');
      return reply.send(ctx.indexHtml.render(request.cspNonce ?? randomBytes(16).toString('base64')));
    }

    await ctx.rateLimit.consume('inviteIp', rateLimitIpKey(ips));
    await ctx.rateLimit.consume('inviteToken', hashInviteToken(query.t).toString('hex').slice(0, 32));

    const invite = await findSpendableInvite(ctx.db, query.t);

    // SEC-32 — comportamento IDENTICO per token inesistente, scaduto,
    // consumato e revocato: stesso redirect, stessa latenza percepita. E' la
    // pagina, poi, a scoprire che non esiste nessuna sessione di onboarding.
    if (invite) {
      const onboardingToken = randomBytes(32).toString('base64url');
      const state: OnboardingState = {
        inviteId: invite.id,
        emailLower: invite.email_lower,
        roleId: invite.role_id,
        tokenHash: hashInviteToken(query.t).toString('base64'),
      };
      await ctx.redis.set(
        onboardingKey(onboardingToken),
        JSON.stringify(state),
        'EX',
        ONBOARDING_TTL_SECONDS,
      );
      reply.setCookie(ONBOARDING_COOKIE, onboardingToken, {
        path: '/',
        secure: ctx.env.APP_ORIGIN.startsWith('https://'),
        httpOnly: true,
        // `lax` e non `strict`: il link arriva da un client di posta, cioe' da
        // una navigazione cross-site, e con `strict` il cookie non partirebbe.
        // La sessione di onboarding non ha permessi, quindi `lax` non apre nulla.
        sameSite: 'lax',
        maxAge: ONBOARDING_TTL_SECONDS,
      });

      await writeAudit(ctx.db, {
        action: AUDIT_ACTIONS.inviteOpened,
        outcome: 'success',
        actor: { userId: null, email: null, displayName: null, sessionId: null },
        request: auditContextOf(request, ips),
        moduleKey: 'inviti',
        targetType: 'invitation',
        targetId: invite.id,
        targetLabel: invite.email_lower,
      });
    }

    // SEC-20 — destinazione COSTANTE. Nessun parametro del client la decide.
    return reply.redirect('/accept', 302);
  });

  // -------------------------------------------------------------------------
  // GET /api/invites/onboarding — cosa mostrare nella pagina di accettazione
  // -------------------------------------------------------------------------
  app.get('/api/invites/onboarding', async (request: FastifyRequest, reply: FastifyReply) => {
    const { state } = await readOnboarding(request);
    const role = await ctx.db
      .selectFrom('auth.roles')
      .select(['name'])
      .where('id', '=', state.roleId)
      .executeTakeFirst();
    return reply.send({ email: state.emailLower, roleName: role?.name ?? null });
  });

  // -------------------------------------------------------------------------
  // POST /api/invites/accept — §8.1.8-10
  //
  // Un solo passaggio, e c'e' un motivo: l'enrollment TOTP di better-auth
  // richiede la password, e spezzare in due richieste vorrebbe dire
  // conservarla in chiaro fra l'una e l'altra. Qui la password entra una
  // volta, produce l'hash, autentica, avvia l'enrollment, e non viene mai
  // scritta da nessuna parte.
  //
  // §8.1.10 — la sessione emessa qui NON e' privilegiata: aal=1 e
  // status='pending_onboarding' la fanno rifiutare dal middleware del §9 su
  // ogni rotta del pannello. E' il veicolo dell'enrollment, nient'altro.
  // -------------------------------------------------------------------------
  app.post(
    '/api/invites/accept',
    { schema: acceptSchema, bodyLimit: 4_096 },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { token: onboardingToken, state } = await readOnboarding(request);
      const body = request.body as { password: string; name: string };
      const ips = requestIps(request);

      await ctx.rateLimit.consume('inviteIp', rateLimitIpKey(ips));

      // §8.6 — HIBP PRIMA di aprire la transazione: e' una chiamata di rete
      // esterna, e il §10 vieta di averne una dentro la transazione che
      // scrive audit. Fail-closed, con voce di audit.
      const verdict = await ctx.hibp.check(body.password);
      if (verdict.status === 'compromised') throw new PasswordCompromised(verdict.occurrences);
      if (verdict.status === 'unavailable') {
        await writeAudit(ctx.db, {
          action: AUDIT_ACTIONS.hibpUnavailable,
          outcome: 'failure',
          actor: { userId: null, email: null, displayName: null, sessionId: null },
          request: auditContextOf(request, ips),
          targetType: 'invitation',
          targetId: state.inviteId,
          meta: { reason: verdict.reason },
        });
        throw new HibpUnavailable(verdict.reason);
      }

      // Anche l'hash sta fuori dalla transazione: occupa un thread del
      // threadpool per decine di millisecondi, e tenerlo dentro allungherebbe
      // di altrettanto la presa del lock della catena hash.
      const passwordHash = await ctx.passwords.hash(body.password);
      const displayName = sanitizeDisplayName(body.name);
      const tokenHash = Buffer.from(state.tokenHash, 'base64');

      const created = await securityTransaction(ctx.db, async (trx) => {
        // test 10 — due accettazioni concorrenti: `FOR UPDATE` serializza, e
        // la seconda rivaluta la WHERE trovando la riga gia' consumata.
        const invite = await claimInvite(trx, tokenHash);
        if (!invite) throw new Conflict('INVITO_NON_SPENDIBILE');

        // §8.1.9 — l'email viene dalla RIGA INVITO, mai dal body.
        const newUserId = await createUserFromInvite(trx, invite, passwordHash, displayName);
        if (!(await consumeInvite(trx, invite.id, newUserId))) {
          throw new Conflict('INVITO_NON_SPENDIBILE');
        }

        const actor = { userId: newUserId, email: invite.email_lower, displayName, sessionId: null };
        return {
          result: { userId: newUserId, email: invite.email_lower },
          events: [
            {
              action: AUDIT_ACTIONS.inviteAccepted,
              outcome: 'success' as const,
              actor,
              request: auditContextOf(request, ips),
              moduleKey: 'inviti',
              targetType: 'invitation',
              targetId: invite.id,
              targetLabel: invite.email_lower,
            },
            {
              action: AUDIT_ACTIONS.userPasswordSet,
              outcome: 'success' as const,
              actor,
              request: auditContextOf(request, ips),
              moduleKey: 'utenti',
              targetType: 'user',
              targetId: newUserId,
              targetLabel: invite.email_lower,
            },
          ],
        };
      });

      // `disableSignUp: true` non tocca il sign-in: la registrazione pubblica
      // resta chiusa, e questo utente esiste gia'.
      const signIn = await ctx.auth.api.signInEmail({
        body: { email: created.email, password: body.password },
        returnHeaders: true,
      });
      const setCookies = signIn.headers.getSetCookie();
      for (const c of setCookies) reply.header('set-cookie', c);

      const enrollHeaders = new Headers();
      enrollHeaders.set('cookie', setCookies.map((c) => c.split(';')[0]).join('; '));

      const enabled = (await ctx.auth.api.enableTwoFactor({
        body: { password: body.password },
        headers: enrollHeaders,
      })) as { totpURI?: string };

      await ctx.redis.set(
        onboardingKey(onboardingToken),
        JSON.stringify({ ...state, userId: created.userId } satisfies OnboardingState),
        'EX',
        ONBOARDING_TTL_SECONDS,
      );

      return reply.code(201).send({
        userId: created.userId,
        email: created.email,
        totpURI: enabled.totpURI ?? null,
        next: 'verifica-totp',
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/invites/complete — §8.1.11-12
  //
  // Verifica il primo codice TOTP. Solo al completamento: status='active',
  // recovery code emessi, e TOKEN DI SESSIONE NUOVO (SEC-06) — la sessione di
  // enrollment viene distrutta, non promossa.
  // -------------------------------------------------------------------------
  app.post(
    '/api/invites/complete',
    { schema: completeSchema, bodyLimit: 4_096 },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { token: onboardingToken, state } = await readOnboarding(request);
      const userId = state.userId;
      if (!userId) throw new BadRequest('ACCETTAZIONE_NON_COMPLETATA');
      const ips = requestIps(request);
      const body = request.body as { code: string };

      await ctx.rateLimit.consume('twoFactorAccount', userId);

      // SEC-11 — la guardia anti-replay vale anche qui: l'enrollment non e'
      // un percorso privilegiato in cui rilassare il controllo.
      const replay = await ctx.totpGuard.check(userId);
      if (!replay.allowed) throw new Unauthorized();

      const headers = new Headers();
      const cookie = request.headers.cookie;
      if (cookie) headers.set('cookie', cookie);

      let verified: { headers: Headers };
      try {
        verified = await ctx.auth.api.verifyTOTP({
          body: { code: body.code },
          headers,
          returnHeaders: true,
        });
      } catch {
        await ctx.rateLimit.penalize('twoFactorAccount', userId);
        throw new Unauthorized();
      }

      await ctx.totpGuard.markUsed(userId);
      await ctx.rateLimit.reward('twoFactorAccount', userId);

      const result = await securityTransaction(ctx.db, async (trx) => {
        await trx
          .updateTable('auth.user')
          .set({ status: 'active', twoFactorEnabled: true })
          .where('id', '=', userId)
          .execute();

        // La sessione appena ruotata sale ad aal=2: e' cio' che il middleware
        // del §9 richiede e cio' che lo step-up misura.
        await trx
          .updateTable('auth.session')
          .set({ aal: 2, authenticated_at: new Date(), amr: ['pwd', 'totp'] })
          .where('userId', '=', userId)
          .execute();

        const { codes, generation } = await issueRecoveryCodes(trx, userId);
        const user = await trx
          .selectFrom('auth.user')
          .select(['email', 'name'])
          .where('id', '=', userId)
          .executeTakeFirstOrThrow();

        const actor = { userId, email: user.email, displayName: user.name, sessionId: null };
        return {
          result: { codes, generation },
          events: [
            {
              action: AUDIT_ACTIONS.userTwoFactorEnabled,
              outcome: 'success' as const,
              actor,
              request: auditContextOf(request, ips),
              moduleKey: 'utenti',
              targetType: 'user',
              targetId: userId,
              targetLabel: user.email,
            },
            {
              action: AUDIT_ACTIONS.userRecoveryCodesGenerated,
              outcome: 'success' as const,
              actor,
              request: auditContextOf(request, ips),
              moduleKey: 'utenti',
              targetType: 'user',
              targetId: userId,
              targetLabel: user.email,
              meta: { generation, count: codes.length },
            },
          ],
        };
      });

      // SEC-14 — la colonna backupCodes del plugin viene SOVRASCRITTA con
      // byte casuali subito dopo l'enrollment. I recovery code veri sono i
      // nostri; lasciare intatti quelli del plugin terrebbe in piedi un
      // percorso di bypass con storage reversibile.
      await ctx.db
        .updateTable('auth.twoFactor')
        .set({ backupCodes: randomBytes(48).toString('base64') })
        .where('userId', '=', userId)
        .execute();

      await ctx.store.invalidate(userId);
      await ctx.redis.del(onboardingKey(onboardingToken));
      reply.clearCookie(ONBOARDING_COOKIE, { path: '/' });

      // SEC-06 — il token nuovo prodotto da verifyTOTP sostituisce quello di
      // enrollment.
      for (const c of verified.headers.getSetCookie()) reply.header('set-cookie', c);

      // I recovery code si mostrano UNA SOLA VOLTA (§8.1.12).
      return reply.send({
        recoveryCodes: result.codes.map(formatRecoveryCode),
        generation: result.generation,
        // SEC-20 — destinazione costante, non un parametro del client.
        next: '/',
      });
    },
  );
}
