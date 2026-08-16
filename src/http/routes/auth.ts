// Ponte Fastify → better-auth, piu' le rotte di sessione nostre.
//
// SEC-25 — il rate limit si consuma PRIMA di qualunque chiamata ad Argon2,
// incluso il percorso utente-inesistente. E' l'ordine, non la presenza, a
// contare: consumarlo dopo l'hash significa aver gia' pagato il costo che il
// limite doveva evitare.
//
// SEC-11 — la guardia anti-replay TOTP e' agganciata attorno alla rotta di
// verifica: `before` puo' rifiutare, `after` marca. Lo SPIKE-1 ha verificato
// che gli hook di better-auth permettono entrambe le cose; qui la guardia sta
// nel ponte invece che negli hook della libreria, perche' cosi' il rifiuto
// produce anche la voce di audit e il consumo di rate limit, che dentro un
// hook di better-auth non sarebbero raggiungibili.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '#src/app-context.ts';
import { AUDIT_ACTIONS } from '#src/audit/actions.ts';
import { writeAudit } from '#src/audit/log.ts';
import { visibleModules } from '#src/authz/can.ts';
import { CSRF_COOKIE, CSRF_COOKIE_OPTIONS, csrfToken } from '../csrf.ts';
import { requireAuth } from '../guards.ts';
import { actorOf, auditContextOf, rateLimitIpKey, requestIps } from '../request-context.ts';

/** Rotte better-auth su cui si consuma il rate limit di login (SEC-25). */
const LOGIN_PATHS = new Set(['/sign-in/email', '/forget-password', '/reset-password']);
const TOTP_VERIFY_PATH = '/two-factor/verify-totp';

function headersFrom(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [k, v] of Object.entries(request.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) for (const vv of v) headers.append(k, vv);
  }
  return headers;
}

function accountKeyOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const email = (body as { email?: unknown }).email;
  return typeof email === 'string' ? email.trim().toLowerCase() : undefined;
}

export async function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    // SEC-29 — 4 KB sulle rotte di autenticazione. Un body di autenticazione
    // legittimo sta in poche centinaia di byte; tutto il resto e' costo che
    // qualcuno vuole farci pagare.
    bodyLimit: 4_096,
    async handler(request: FastifyRequest, reply: FastifyReply) {
      const subPath = request.url.replace(/^\/api\/auth/, '').split('?')[0] ?? '';
      const ips = requestIps(request);
      const ipKey = rateLimitIpKey(ips);

      // ---------------------------------------------------------------------
      // SEC-25 / SEC-26 — limiti composti in AND, consumati PRIMA di tutto.
      // Il tetto globale per rotta e' l'unica difesa contro IP falsificati o
      // una botnet distribuita, dove i limiti per-IP non mordono mai.
      // ---------------------------------------------------------------------
      if (LOGIN_PATHS.has(subPath)) {
        const account = accountKeyOf(request.body);
        await ctx.rateLimit.consume('loginGlobal', 'rotta');
        await ctx.rateLimit.consume('loginIp', ipKey);
        // Il limite per account si consuma anche se l'account NON esiste:
        // altrimenti il costo della richiesta rivelerebbe quali email sono
        // registrate, che e' esattamente l'oracolo che SEC-30 elimina.
        if (account) await ctx.rateLimit.consume('loginAccount', account);
      }

      // ---------------------------------------------------------------------
      // SEC-11 — anti-replay TOTP, PRIMA che l'handler valuti il codice.
      // ---------------------------------------------------------------------
      let totpUserId: string | undefined;
      if (subPath === TOTP_VERIFY_PATH) {
        await ctx.rateLimit.consume('twoFactorGlobal', 'rotta');
        await ctx.rateLimit.consume('twoFactorIp', ipKey);

        const session = await ctx.auth.api.getSession({ headers: headersFrom(request) });
        totpUserId = session?.session?.userId;

        if (totpUserId) {
          await ctx.rateLimit.consume('twoFactorAccount', totpUserId);

          const verdict = await ctx.totpGuard.check(totpUserId);
          if (!verdict.allowed) {
            await writeAudit(ctx.db, {
              action: AUDIT_ACTIONS.twoFactorReplayBlocked,
              outcome: 'denied',
              actor: {
                userId: totpUserId,
                email: null,
                displayName: null,
                sessionId: session?.session?.id ?? null,
              },
              request: auditContextOf(request, ips),
              meta: { reason: verdict.reason },
            });
            // Stessa risposta di un codice sbagliato: dire "questo codice era
            // gia' stato usato" confermerebbe che il codice era giusto.
            return reply.code(401).send({ error: 'unauthorized' });
          }
        }
      }

      // ---------------------------------------------------------------------
      // Ponte. `JSON.stringify(request.body)` e' cio' che better-auth si
      // aspetta (verificato dallo SPIKE-5); gli header della Response vanno
      // ricopiati uno a uno, altrimenti il Set-Cookie __Host- si perde.
      // ---------------------------------------------------------------------
      const url = new URL(request.url, ctx.env.APP_ORIGIN);
      const proxied = new Request(url, {
        method: request.method,
        headers: headersFrom(request),
        ...(request.body !== undefined && request.method !== 'GET'
          ? { body: JSON.stringify(request.body) }
          : {}),
      });

      const res = await ctx.auth.handler(proxied);

      // ---------------------------------------------------------------------
      // SEC-11 — seconda meta' della guardia anti-replay.
      //
      // Nel percorso di LOGIN la challenge 2FA precede la sessione: prima
      // dell'handler non esiste ancora nulla da cui ricavare lo userId, e il
      // controllo preventivo non e' possibile. Lo si fa quindi qui, sulla
      // sessione appena emessa, e se il codice risulta gia' speso la sessione
      // viene DISTRUTTA e la risposta diventa 401. Il codice resta rifiutato:
      // cambia solo il momento in cui lo si scopre, non l'esito.
      //
      // Nei percorsi in cui una sessione c'e' gia' (enrollment, step-up) il
      // controllo preventivo sopra ha gia' fatto il suo lavoro e l'handler non
      // e' nemmeno stato chiamato.
      // ---------------------------------------------------------------------
      if (subPath === TOTP_VERIFY_PATH) {
        const emitted = res.headers.getSetCookie();
        let userId = totpUserId;
        let newSessionId: string | undefined;

        if (res.status < 400 && emitted.some((c) => c.startsWith('__Host-metamc_session='))) {
          const fresh = new Headers();
          fresh.set('cookie', emitted.map((c) => c.split(';')[0]).join('; '));
          const created = await ctx.auth.api.getSession({ headers: fresh });
          userId = created?.session?.userId ?? userId;
          newSessionId = created?.session?.id;
        }

        if (res.status >= 400) {
          if (userId) {
            const seconds = await ctx.rateLimit.penalize('twoFactorAccount', userId);
            request.log.warn({ userId, seconds }, 'SEC-26: backoff 2FA');
          }
        } else if (userId) {
          const post = totpUserId ? { allowed: true as const } : await ctx.totpGuard.check(userId);
          if (!post.allowed) {
            if (newSessionId) {
              await ctx.db.deleteFrom('auth.session').where('id', '=', newSessionId).execute();
            }
            await writeAudit(ctx.db, {
              action: AUDIT_ACTIONS.twoFactorReplayBlocked,
              outcome: 'denied',
              actor: { userId, email: null, displayName: null, sessionId: newSessionId ?? null },
              request: auditContextOf(request, ips),
              meta: { reason: post.reason, fase: 'post-verifica' },
            });
            // Stessa risposta di un codice sbagliato: dire "questo codice era
            // gia' stato usato" confermerebbe che il codice era giusto.
            return reply.code(401).send({ error: 'unauthorized' });
          }

          await ctx.totpGuard.markUsed(userId);
          await ctx.rateLimit.reward('twoFactorAccount', userId);
          // Il 2FA completato porta la sessione ad aal=2 e alza
          // authenticated_at: e' cio' che lo step-up misura.
          await ctx.db
            .updateTable('auth.session')
            .set({ aal: 2, authenticated_at: new Date(), amr: ['pwd', 'totp'] })
            .where('userId', '=', userId)
            .where('aal', '<', 2)
            .execute();
        }
      }

      // Login riuscito: la sessione nuova riceve il tetto assoluto (SEC-05).
      if (subPath === '/sign-in/email' && res.status < 400) {
        const account = accountKeyOf(request.body);
        if (account) await ctx.rateLimit.reward('loginAccount', account);
      }

      reply.code(res.status);
      const emitted = res.headers.getSetCookie();
      for (const [k, v] of res.headers.entries()) {
        if (k.toLowerCase() === 'set-cookie') continue;
        reply.header(k, v);
      }
      for (const c of emitted) reply.header('set-cookie', c);

      // -----------------------------------------------------------------
      // SEC-17 — il cookie CSRF va emesso INSIEME alla sessione, non dopo.
      //
      // Se lo emettesse solo `requireAuth`, che pretende aal=2, il client
      // non avrebbe un token da presentare proprio sulla richiesta che porta
      // ad aal=2: la verifica TOTP e' una POST autenticata, verrebbe rifiutata
      // dal controllo CSRF, e il login non si chiuderebbe mai. Qui il token
      // viene calcolato sull'id della sessione appena emessa.
      // -----------------------------------------------------------------
      if (res.status < 400 && emitted.some((c) => c.startsWith('__Host-metamc_session='))) {
        const fresh = new Headers();
        fresh.set('cookie', emitted.map((c) => c.split(';')[0]).join('; '));
        const session = await ctx.auth.api.getSession({ headers: fresh });
        if (session?.session?.id) {
          reply.setCookie(CSRF_COOKIE, csrfToken(ctx.keys.csrf, session.session.id), {
            ...CSRF_COOKIE_OPTIONS,
            secure: ctx.env.APP_ORIGIN.startsWith('https://'),
          });
        }
      }

      const text = await res.text();
      return reply.send(text.length > 0 ? text : null);
    },
  });

  // -------------------------------------------------------------------------
  // Sessione corrente. Alimenta la app shell: identita', permessi effettivi,
  // moduli visibili.
  //
  // La sidebar mostra SOLO i moduli a cui l'utente ha accesso: nessuna voce
  // disabilitata, nessun lucchetto. L'elenco stesso dei moduli e'
  // informazione, e mostrarlo a chi non ci entra e' ricognizione gratuita.
  // -------------------------------------------------------------------------
  app.get(
    '/api/me',
    { preHandler: requireAuth(ctx) },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = actorOf(request);
      reply.setCookie(CSRF_COOKIE, csrfToken(ctx.keys.csrf, actor.sessionId), {
        ...CSRF_COOKIE_OPTIONS,
        secure: ctx.env.APP_ORIGIN.startsWith('https://'),
      });
      return reply.send({
        userId: actor.userId,
        email: actor.actorEmail,
        name: actor.actorDisplayName,
        permissions: actor.permissions,
        modules: visibleModules(actor),
        aal: actor.aal,
        authenticatedAt: actor.authenticatedAt.toISOString(),
        stepUpValidForSeconds: Math.max(
          0,
          ctx.env.STEP_UP_SECONDS - Math.floor((Date.now() - actor.authenticatedAt.getTime()) / 1000),
        ),
      });
    },
  );

  // -------------------------------------------------------------------------
  // Logout globale: revoca TUTTE le sessioni dell'utente (§8.2).
  // -------------------------------------------------------------------------
  app.post(
    '/api/session/logout-all',
    { preHandler: requireAuth(ctx) },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = actorOf(request);
      const ips = requestIps(request);
      const revoked = await ctx.authz.revokeAllSessions(actor.userId);
      await writeAudit(ctx.db, {
        action: AUDIT_ACTIONS.sessionsRevokedAll,
        outcome: 'success',
        actor: {
          userId: actor.userId,
          email: actor.actorEmail,
          displayName: actor.actorDisplayName,
          sessionId: actor.sessionId,
        },
        request: auditContextOf(request, ips),
        moduleKey: 'sessioni',
        targetType: 'user',
        targetId: actor.userId,
        targetLabel: actor.actorEmail,
        meta: { revoked },
      });
      reply.clearCookie(CSRF_COOKIE, { path: '/' });
      return reply.send({ revoked });
    },
  );
}
