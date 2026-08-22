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
import { absoluteCap } from '#src/auth/auth.ts';
import { withPepperSubject } from '#src/auth/pepper-context.ts';
import { visibleModules } from '#src/authz/can.ts';
import { issueCsrfCookie } from '../csrf.ts';
import { requireAuth } from '../guards.ts';
import { actorOf, auditContextOf, rateLimitIpKey, requestIps, setAuthSubject } from '../request-context.ts';

/** Rotte better-auth su cui si consuma il rate limit di login (SEC-25). */
const LOGIN_PATHS = new Set(['/sign-in/email', '/forget-password', '/reset-password']);
/** Rotte che finiscono in un hash o in una verifica Argon2 (SEC-28). */
const HASHING_PATHS = new Set([
  '/sign-in/email',
  '/reset-password',
  '/change-password',
  '/two-factor/enable',
  '/two-factor/disable',
]);
const TOTP_VERIFY_PATH = '/two-factor/verify-totp';

/**
 * SEC-40 — le rotte che verificano una password GIA' MEMORIZZATA.
 *
 * Non tutte quelle che finiscono in Argon2: `/reset-password` ne calcola una
 * nuova a partire da un token e non confronta niente, quindi non ha bisogno di
 * sapere con quale pepper e' nato il vecchio hash.
 */
const VERIFIES_STORED_PASSWORD = new Set([
  '/sign-in/email',
  '/change-password',
  '/two-factor/enable',
  '/two-factor/disable',
]);

function headersFrom(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [k, v] of Object.entries(request.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) for (const vv of v) headers.append(k, vv);
  }
  return headers;
}

/** Il codice a sei cifre dal corpo della richiesta, se c'e'. */
function totpCodeOf(body: unknown): string {
  if (typeof body !== 'object' || body === null) return '';
  const code = (body as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}

function accountKeyOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const email = (body as { email?: unknown }).email;
  return typeof email === 'string' ? email.trim().toLowerCase() : undefined;
}

/**
 * L'identita' da scrivere nel registro: id, email e nome com'erano adesso.
 *
 * Il pannello mostra il NOME, non l'id (§10, denormalizzazione al momento del
 * fatto). Depositare il solo id lasciava le righe a nome di «anonimo» pur
 * avendo l'utente in colonna.
 */
async function auditSubjectOf(
  ctx: AppContext,
  userId: string,
): Promise<{ userId: string; email: string | null; displayName: string | null }> {
  const row = await ctx.db
    .selectFrom('auth.user')
    .select(['email', 'name'])
    .where('id', '=', userId)
    .executeTakeFirst();
  return { userId, email: row?.email ?? null, displayName: row?.name ?? null };
}

/**
 * L'utente e la versione di pepper del suo hash.
 *
 * Sul login l'identita' arriva dal corpo, sulle altre dalla sessione — che
 * sulle rotte autenticate e' gia' stata risolta per il rate limit, quindi
 * questo non aggiunge un giro.
 *
 * Restituisce `undefined` quando l'utente non si trova: il percorso
 * dell'account inesistente deve restare indistinguibile (SEC-30), e senza
 * soggetto `verify` usa il pepper corrente esattamente come prima.
 */
async function pepperSubjectOf(
  ctx: AppContext,
  request: FastifyRequest,
  subPath: string,
  knownUserId: string | undefined,
): Promise<{ userId: string; pepperVersion: number } | undefined> {
  let userId = knownUserId;

  if (!userId && subPath === '/sign-in/email') {
    const email = accountKeyOf(request.body);
    if (!email) return undefined;
    const row = await ctx.db
      .selectFrom('auth.user')
      .select(['id', 'pepper_version'])
      .where('email', '=', email)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row ? { userId: row.id, pepperVersion: row.pepper_version } : undefined;
  }

  if (!userId) {
    const session = await ctx.auth.api.getSession({ headers: headersFrom(request) });
    userId = session?.session?.userId;
  }
  if (!userId) return undefined;

  const row = await ctx.db
    .selectFrom('auth.user')
    .select('pepper_version')
    .where('id', '=', userId)
    .executeTakeFirst();
  return row ? { userId, pepperVersion: row.pepper_version } : undefined;
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
      // ---------------------------------------------------------------------
      // SEC-28 — porta del semaforo Argon2.
      //
      // Il controllo sta QUI e non solo dentro PasswordService perche'
      // un'eccezione lanciata dentro l'handler di better-auth viene catturata
      // dalla libreria e diventa un 500: il 503 con Retry-After che SEC-28
      // prescrive non arriverebbe mai al client, e nessun proxy saprebbe
      // rallentare. Alla porta invece la risposta e' esatta.
      // ---------------------------------------------------------------------
      if (HASHING_PATHS.has(subPath) && ctx.semaphore.saturated) {
        reply.header('Retry-After', '1');
        return reply.code(503).send({ error: 'overloaded' });
      }

      // SEC-25 — le rotte di hashing AUTENTICATE. Il consumo sta qui, prima
      // che better-auth veda la richiesta e quindi prima di qualunque Argon2.
      //
      // `HASHING_PATHS` meno `LOGIN_PATHS`: le tre che restavano scoperte
      // perche' il consumo viveva dentro il ramo del login. Sono autenticate,
      // quindi il soggetto da limitare e' l'utente della sessione — chi ha
      // rubato una sessione cambia indirizzo a piacere — e l'IP resta come
      // secondo vincolo per chi prova molte sessioni da un posto solo.
      if (HASHING_PATHS.has(subPath) && !LOGIN_PATHS.has(subPath)) {
        await ctx.rateLimit.consume('hashingIp', ipKey);
        const session = await ctx.auth.api.getSession({ headers: headersFrom(request) });
        const userId = session?.session?.userId;
        if (userId) await ctx.rateLimit.consume('hashingAccount', userId);
      }

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
      // Il codice presentato: serve alla guardia, che ora vieta il singolo
      // codice invece dell'intera finestra.
      const totpCode = totpCodeOf(request.body);

      let totpUserId: string | undefined;
      if (subPath === TOTP_VERIFY_PATH) {
        await ctx.rateLimit.consume('twoFactorGlobal', 'rotta');
        await ctx.rateLimit.consume('twoFactorIp', ipKey);

        const session = await ctx.auth.api.getSession({ headers: headersFrom(request) });
        totpUserId = session?.session?.userId;

        if (totpUserId) {
          await ctx.rateLimit.consume('twoFactorAccount', totpUserId);

          const verdict = await ctx.totpGuard.check(totpUserId, totpCode);
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

      // SEC-40 — di chi e' la password che better-auth sta per verificare.
      //
      // Il callback `password.verify` riceve solo `{ hash, password }`:
      // verificato empiricamente, non dedotto dal tipo. Senza questo contesto
      // non c'e' modo di sapere con quale pepper quell'hash e' nato, e ruotare
      // il pepper equivarrebbe a invalidare tutte le password.
      //
      // Si risolve solo sulle rotte che verificano una password ESISTENTE: sul
      // resto sarebbe una query per niente.
      const subject = VERIFIES_STORED_PASSWORD.has(subPath)
        ? await pepperSubjectOf(ctx, request, subPath, totpUserId)
        : undefined;

      const res = subject
        ? await withPepperSubject(subject, () => ctx.auth.handler(proxied))
        : await ctx.auth.handler(proxied);

      // Chi ha superato il passo password. SOLO se e' andato bene: su un
      // fallimento l'utente e' comunque noto — lo abbiamo appena cercato per
      // il pepper — ma registrarlo trasformerebbe il registro nell'elenco
      // degli indirizzi provati da chiunque, che e' esattamente cio' che il
      // commento dell'hook vuole evitare.
      if (subPath === '/sign-in/email' && res.status < 400) {
        if (subject) {
          setAuthSubject(request, await auditSubjectOf(ctx, subject.userId));
        } else {
          // Il login e' riuscito ma non sappiamo di chi: l'utente non e' stato
          // trovato per email. Succede se l'indirizzo memorizzato differisce
          // per maiuscole da quello digitato, perche' la ricerca confronta la
          // colonna cosi' com'e'.
          request.log.warn('accesso riuscito senza attore: utente non trovato per email');
        }
      }

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
          const post = totpUserId ? { allowed: true as const } : await ctx.totpGuard.check(userId, totpCode);
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

          // Chi e' entrato: l'hook di audit non puo' risolverlo da solo.
          setAuthSubject(request, await auditSubjectOf(ctx, userId));
          await ctx.totpGuard.markUsed(userId, totpCode);
          await ctx.rateLimit.reward('twoFactorAccount', userId);
          // Il 2FA completato porta la sessione ad aal=2 e alza
          // authenticated_at: e' cio' che lo step-up misura.
          await ctx.db
            .updateTable('auth.session')
            .set({
              aal: 2,
              authenticated_at: new Date(),
              amr: ['pwd', 'totp'],
              absolute_expires_at: absoluteCap(ctx.env.SESSION_ABSOLUTE_SECONDS),
            })
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
        if (session?.session?.id) issueCsrfCookie(reply, ctx.keys.csrf, session.session.id);
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
      issueCsrfCookie(reply, ctx.keys.csrf, actor.sessionId);
      return reply.send({
        userId: actor.userId,
        email: actor.actorEmail,
        name: actor.actorDisplayName,
        permissions: actor.permissions,
        modules: visibleModules(actor),
        aal: actor.aal,
        authenticatedAt: actor.authenticatedAt.toISOString(),
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
      reply.clearCookie('__Host-metamc_csrf', { path: '/' });
      return reply.send({ revoked });
    },
  );
}
