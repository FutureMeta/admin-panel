// La chiusura di un enrollment TOTP: il primo codice, l'account attivo, i
// codici di recupero. §8.1.11-12
//
// DUE PORTE, UNA CHIUSURA. Ci arriva chi accetta un invito, e ci arriva chi
// rientra dopo un reset del secondo fattore (§8.8): la seconda porta mancava,
// e quella persona restava in `pending_onboarding` per sempre, con la password
// giusta e nessuna schermata da cui rifare il 2FA. Il lavoro e' identico e sta
// qui una volta sola: due copie divergerebbero al primo ritocco, e sarebbe la
// copia meno usata a restare indietro.

import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '#src/app-context.ts';
import { AUDIT_ACTIONS } from '#src/audit/actions.ts';
import { securityTransaction } from '#src/audit/log.ts';
import { absoluteCap } from '#src/auth/auth.ts';
import { issueRecoveryCodes } from '#src/auth/recovery-codes.ts';
import { Unauthorized } from './errors.ts';
import { auditContextOf, requestIps } from './request-context.ts';

const SESSION_COOKIE = '__Host-metamc_session';

/**
 * Verifica il primo codice e attiva l'account. Scrive i cookie della sessione
 * NUOVA sulla risposta e restituisce i codici di recupero, che il chiamante
 * mostra una volta sola.
 */
export async function completeTotpEnrollment(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  code: string,
): Promise<{ codes: string[]; generation: number }> {
  const ips = requestIps(request);
  await ctx.rateLimit.consume('twoFactorAccount', userId);

  // SEC-11 — la guardia anti-replay vale anche qui: l'enrollment non e' un
  // percorso privilegiato in cui rilassare il controllo.
  const replay = await ctx.totpGuard.check(userId, code);
  if (!replay.allowed) throw new Unauthorized();

  const headers = new Headers();
  const cookie = request.headers.cookie;
  if (cookie) headers.set('cookie', cookie);

  let verified: { headers: Headers };
  try {
    verified = await ctx.auth.api.verifyTOTP({ body: { code }, headers, returnHeaders: true });
  } catch {
    await ctx.rateLimit.penalize('twoFactorAccount', userId);
    throw new Unauthorized();
  }

  await ctx.totpGuard.markUsed(userId, code);
  await ctx.rateLimit.reward('twoFactorAccount', userId);

  // SEC-06 — la prima verifica RUOTA il token: la sessione di enrollment
  // viene distrutta e ne nasce una nuova. E' SOLO quella che sale ad aal=2:
  // promuovere ogni sessione dell'utente ancora sotto il 2 alzerebbe anche
  // quella di chiunque altro avesse la password.
  const emitted = verified.headers.getSetCookie();
  const fresh = emitted.find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.split(';')[0] ?? cookie ?? '';
  const session = await ctx.auth.api.getSession({ headers: new Headers({ cookie: fresh }) });
  const sessionId = session?.session?.id;
  if (!sessionId) throw new Unauthorized();

  const result = await securityTransaction(ctx.db, async (trx) => {
    await trx
      .updateTable('auth.user')
      .set({ status: 'active', twoFactorEnabled: true })
      .where('id', '=', userId)
      .execute();

    await trx
      .updateTable('auth.session')
      .set({
        aal: 2,
        authenticated_at: new Date(),
        amr: ['pwd', 'totp'],
        absolute_expires_at: absoluteCap(ctx.env.SESSION_ABSOLUTE_SECONDS),
      })
      .where('id', '=', sessionId)
      // Una volta sola: il tetto assoluto non si proroga (SEC-05).
      .where('aal', '<', 2)
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

  // SEC-14 — la colonna backupCodes del plugin viene SOVRASCRITTA con byte
  // casuali subito dopo l'enrollment. I recovery code veri sono i nostri;
  // lasciare intatti quelli del plugin terrebbe in piedi un percorso di
  // bypass con storage reversibile.
  await ctx.db
    .updateTable('auth.twoFactor')
    .set({ backupCodes: randomBytes(48).toString('base64') })
    .where('userId', '=', userId)
    .execute();

  await ctx.store.invalidate(userId);
  for (const c of emitted) reply.header('set-cookie', c);
  return result;
}
