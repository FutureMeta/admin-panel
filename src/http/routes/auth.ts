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
import { absoluteCap, forgetSessions } from '#src/auth/auth.ts';
import { withPepperSubject } from '#src/auth/pepper-context.ts';
import { visibleModules } from '#src/authz/can.ts';
import { issueCsrfCookie } from '../csrf.ts';
import { requireAuth } from '../guards.ts';
import { actorOf, auditContextOf, rateLimitIpKey, requestIps, setAuthSubject } from '../request-context.ts';

const LOGIN_PATH = '/sign-in/email';
const TOTP_VERIFY_PATH = '/two-factor/verify-totp';

/**
 * Le SOLE rotte di better-auth raggiungibili da fuori: il login e la verifica
 * del secondo fattore. Tutto il resto lo fa il pannello con rotte proprie
 * (reset password, cambio email, codici di recupero, logout) o con l'API
 * interna (`ctx.auth.api`, come l'enrollment TOTP dell'onboarding).
 *
 * PRIMA IL PONTE INOLTRAVA QUALUNQUE SOTTO-PERCORSO, e le rotte che il
 * pannello non usa restavano aperte a chi aveva una sessione: leggere il
 * segreto TOTP (`/two-factor/get-totp-uri`), sostituirlo e rigenerare i
 * codici di backup (`/two-factor/enable`), cambiare password senza HIBP,
 * senza registro e senza avviso (`/change-password`), rinominarsi
 * (`/update-user`). Ognuna scavalcava un controllo che il pannello fa
 * altrove. Un elenco di cio' che si CHIUDE si dimentica la prossima rotta
 * che better-auth aggiunge; un elenco di cio' che si APRE no.
 */
const BRIDGED_PATHS = new Set([LOGIN_PATH, TOTP_VERIFY_PATH]);

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
 * L'utente e la versione di pepper del suo hash, dall'email del login.
 *
 * Restituisce `undefined` quando l'utente non si trova: il percorso
 * dell'account inesistente deve restare indistinguibile (SEC-30), e senza
 * soggetto `verify` usa il pepper corrente esattamente come prima.
 */
async function pepperSubjectOf(
  ctx: AppContext,
  request: FastifyRequest,
): Promise<{ userId: string; pepperVersion: number } | undefined> {
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

export async function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.route({
    method: 'POST',
    url: '/api/auth/*',
    // SEC-29 — 4 KB sulle rotte di autenticazione. Un body di autenticazione
    // legittimo sta in poche centinaia di byte; tutto il resto e' costo che
    // qualcuno vuole farci pagare.
    bodyLimit: 4_096,
    async handler(request: FastifyRequest, reply: FastifyReply) {
      // IL PERCORSO SI LEGGE UNA VOLTA, NORMALIZZATO, ed e' lo stesso che
      // better-auth ricevera'. Confrontato sull'URL grezzo, `/two-factor/./x`
      // o `%2e` passavano i controlli come una rotta qualsiasi e arrivavano
      // alla libreria gia' risolti nella rotta vera: il blocco dei codici di
      // backup si scavalcava cosi', e allo stesso modo il rate limit del login.
      const url = new URL(request.url, ctx.env.APP_ORIGIN);
      const subPath = url.pathname.replace(/^\/api\/auth/, '');
      if (!BRIDGED_PATHS.has(subPath)) {
        return reply.code(404).send({ error: 'not_found' });
      }
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
      if (subPath === LOGIN_PATH && ctx.semaphore.saturated) {
        reply.header('Retry-After', '1');
        return reply.code(503).send({ error: 'overloaded' });
      }

      if (subPath === LOGIN_PATH) {
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
      const proxied = new Request(url, {
        method: request.method,
        headers: headersFrom(request),
        ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
      });

      // SEC-40 — di chi e' la password che better-auth sta per verificare.
      //
      // Il callback `password.verify` riceve solo `{ hash, password }`:
      // verificato empiricamente, non dedotto dal tipo. Senza questo contesto
      // non c'e' modo di sapere con quale pepper quell'hash e' nato, e ruotare
      // il pepper equivarrebbe a invalidare tutte le password.
      //
      // Solo il login verifica una password ESISTENTE: sulla verifica TOTP
      // sarebbe una query per niente.
      const subject = subPath === LOGIN_PATH ? await pepperSubjectOf(ctx, request) : undefined;

      const res = subject
        ? await withPepperSubject(subject, () => ctx.auth.handler(proxied))
        : await ctx.auth.handler(proxied);

      // Chi ha superato il passo password. SOLO se e' andato bene: su un
      // fallimento l'utente e' comunque noto — lo abbiamo appena cercato per
      // il pepper — ma registrarlo trasformerebbe il registro nell'elenco
      // degli indirizzi provati da chiunque, che e' esattamente cio' che il
      // commento dell'hook vuole evitare.
      if (subPath === LOGIN_PATH && res.status < 400) {
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
              const gone = await ctx.db
                .deleteFrom('auth.session')
                .where('id', '=', newSessionId)
                .returning('token')
                .execute();
              await forgetSessions(
                ctx.redis,
                gone.map((s) => s.token),
              );
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
      if (subPath === LOGIN_PATH && res.status < 400) {
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
        if (session?.session?.id)
          issueCsrfCookie(reply, ctx.keys.csrf, session.session.id, ctx.env.SESSION_ABSOLUTE_SECONDS);
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
    // PERMESSO: basta la sessione — chi sei e cosa puoi, per il guscio.
    { preHandler: requireAuth(ctx) },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = actorOf(request);
      issueCsrfCookie(reply, ctx.keys.csrf, actor.sessionId, ctx.env.SESSION_ABSOLUTE_SECONDS);
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
    // PERMESSO: basta la sessione — si chiudono le proprie sessioni.
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
