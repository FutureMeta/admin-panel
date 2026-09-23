// Il login con un codice di recupero, a partire dalla challenge del 2FA.
//
// PERCHE' SERVE. Con il secondo fattore attivo, dopo la password better-auth
// non emette una sessione: lascia un cookie firmato `two_factor` che punta a
// una riga di `auth.verification`, e la sessione nasce solo quando quel
// cookie viene consumato. Il codice TOTP lo consuma dentro better-auth. I
// nostri codici di recupero no — quelli del plugin sono spenti (SEC-14) — e
// la rotta del pannello cercava una sessione che a quel punto non c'e':
// rispondeva 401 a chiunque, e il primo rimedio della scala del §8.8 non
// funzionava per nessuno.
//
// DUE ENDPOINT INTERNI, perche' fra i due c'e' il lavoro del pannello
// (limite per account, consumo atomico del codice, registro) e deve stare
// fuori da better-auth. Non passano dal ponte `/api/auth/*`, che apre due sole
// rotte: li chiama soltanto il pannello, con `ctx.auth.api`.

import { APIError, createAuthEndpoint } from 'better-auth/api';
import { expireCookie, setSessionCookie } from 'better-auth/cookies';

/** Il nome del cookie della challenge nel plugin two-factor. */
const TWO_FACTOR_COOKIE = 'two_factor';

type ChallengeContext = {
  context: {
    secret: string;
    internalAdapter: {
      findVerificationValue(identifier: string): Promise<{ value: string; expiresAt: Date } | null>;
    };
  };
  getSignedCookie(name: string, secret: string): Promise<string | null | false>;
};

/** Il valore firmato della challenge e l'utente a cui appartiene, se e' ancora valida. */
async function challengeOf(
  ctx: ChallengeContext,
  cookieName: string,
): Promise<{ signed: string; userId: string } | null> {
  const signed = await ctx.getSignedCookie(cookieName, ctx.context.secret);
  if (!signed) return null;
  const verification = await ctx.context.internalAdapter.findVerificationValue(signed);
  if (!verification || verification.expiresAt < new Date()) return null;
  return { signed, userId: verification.value };
}

export const recoveryChallenge = {
  id: 'metamc-recovery-challenge',
  endpoints: {
    /** Di chi e' la challenge in corso. Non la consuma. */
    twoFactorChallengeUser: createAuthEndpoint(
      '/metamc/two-factor-challenge',
      { method: 'POST' },
      async (ctx) => {
        const challenge = await challengeOf(ctx, ctx.context.createAuthCookie(TWO_FACTOR_COOKIE).name);
        return ctx.json({ userId: challenge?.userId ?? null });
      },
    ),
    /**
     * Consuma la challenge e apre la sessione: cio' che better-auth fa dopo un
     * codice TOTP giusto, qui dopo un codice di recupero che il pannello ha
     * gia' verificato e speso.
     */
    completeTwoFactorChallenge: createAuthEndpoint(
      '/metamc/two-factor-challenge/complete',
      { method: 'POST' },
      async (ctx) => {
        const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE);
        const challenge = await challengeOf(ctx, cookie.name);
        if (!challenge) throw new APIError('UNAUTHORIZED');
        const consumed = await ctx.context.internalAdapter.consumeVerificationValue(challenge.signed);
        if (!consumed || consumed.value !== challenge.userId) throw new APIError('UNAUTHORIZED');
        const user = await ctx.context.internalAdapter.findUserById(challenge.userId);
        const session = await ctx.context.internalAdapter.createSession(challenge.userId, false);
        if (!user || !session) throw new APIError('UNAUTHORIZED');
        await setSessionCookie(ctx, { session, user });
        expireCookie(ctx, cookie);
        return ctx.json({ sessionId: session.id });
      },
    ),
  },
};
