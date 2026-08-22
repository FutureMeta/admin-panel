// Server Fastify. §2, §5.1, SEC-14, SEC-19, SEC-22, SEC-29, SEC-33

import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from 'fastify';
import type { AppContext } from '#src/app-context.ts';
import { AUDIT_ACTIONS } from '#src/audit/actions.ts';
import { writeAudit } from '#src/audit/log.ts';
import { installErrorHandler } from './errors.ts';
import { assertNoStateChangingGet, registerSecurityHooks } from './hooks.ts';
import { contentSecurityPolicy, newNonce } from './index-html.ts';
import { auditContextOf, authSubjectOf, requestIps } from './request-context.ts';
import { registerAccountRoutes } from './routes/account.ts';
import { registerAssistantRoutes } from './routes/assistant.ts';
import { registerAuditRoutes } from './routes/audit.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerAvatarRoutes } from './routes/avatars.ts';
import { registerDuelsRoutes } from './routes/duels.ts';
import { registerDuelsConfigRoutes } from './routes/duels-config.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerInviteRoutes } from './routes/invites.ts';
import { registerOnboardingRoutes } from './routes/invites-onboarding.ts';
import { registerRoleRoutes } from './routes/roles.ts';
import { registerStatsRoutes } from './routes/stats.ts';
import { registerStatsModeRoutes } from './routes/stats-modes.ts';
import { registerTwoFactorResetRoutes } from './routes/two-factor-reset.ts';
import { registerUserRoutes } from './routes/users.ts';
import { registerWebhookRoutes } from './routes/webhooks.ts';
import { registerStaticAssets } from './static-assets.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** Buffer grezzo del body, popolato solo sulle rotte /webhooks/* (SEC-19). */
    rawBody?: Buffer;
    /** Nonce CSP della richiesta. */
    cspNonce?: string;
  }
  interface FastifyInstance {
    /**
     * Inventario delle rotte registrate, con il path COMPLETO.
     *
     * Serve al test 9, che e' parametrico su tutte le rotte con `:id`:
     * enumerarle a mano significherebbe dimenticarne una il giorno in cui se
     * ne aggiunge un'altra, ed e' esattamente il giorno in cui l'oracolo
     * 403-vs-404 rientrerebbe. `printRoutes()` non serve allo scopo: disegna
     * un albero in cui i prefissi stanno su righe separate.
     */
    registeredRoutes: Array<{ method: string; url: string }>;
  }
}

/**
 * SEC-14 — rotte del plugin twoFactor bloccate a 404.
 *
 * I backup code del plugin usano storage reversibile: un dump del database
 * piu' il segreto sarebbe il bypass del 2FA di tutto lo staff. I recovery
 * code veri sono in auth.recovery_code, 128 bit e SHA-256 one-way.
 *
 * 404 e non 403: 403 confermerebbe che l'endpoint esiste.
 */
const BLOCKED_AUTH_PATHS = [
  '/api/auth/two-factor/verify-backup-code',
  '/api/auth/two-factor/generate-backup-codes',
  // Il plugin espone anche le varianti senza prefisso a seconda del mount.
  '/api/auth/2fa/verify-backup-code',
  '/api/auth/2fa/generate-backup-codes',
];

export async function buildServer(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    // SEC-29 — 64 KB globale. Le rotte /api/auth/* scendono a 4 KB.
    bodyLimit: 65_536,
    // SEC-22 — CIDR ESATTO del proxy, mai `true`. Con `true` chiunque puo'
    // dichiarare il proprio IP con un header e falsificare rate limit e audit.
    trustProxy: ctx.env.TRUST_PROXY_CIDR,
    loggerInstance: ctx.logger as unknown as FastifyBaseLogger,
    genReqId: () => crypto.randomUUID(),
    disableRequestLogging: false,
    // Rifiuto a monte di URL non canonici: nginx li blocca gia' (§2), ma la
    // difesa non deve dipendere da un file di configurazione altrui.
    onProtoPoisoning: 'remove',
    onConstructorPoisoning: 'remove',
  });

  // ---------------------------------------------------------------------------
  // Content type parser
  //
  // SEC-19 — il webhook Resend riceve il BUFFER GREZZO: la firma Svix si
  // verifica sui byte esatti, e riparsare il JSON la rompe (lo SPIKE-5 lo ha
  // misurato: e' il test 17).
  // ---------------------------------------------------------------------------
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    const buf = body as Buffer;
    if (request.url.startsWith('/webhooks/')) {
      request.rawBody = buf;
      done(null, buf);
      return;
    }
    if (buf.length === 0) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(buf.toString('utf8')));
    } catch {
      const err = new Error('json non valido') as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  const registeredRoutes: Array<{ method: string; url: string }> = [];
  app.decorate('registeredRoutes', registeredRoutes);
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) registeredRoutes.push({ method, url: route.url });
  });

  await app.register(fastifyCookie);

  // ---------------------------------------------------------------------------
  // SEC-33 / SEC-34 — la CSP di default di helmet va SOVRASCRITTA.
  // ---------------------------------------------------------------------------
  await app.register(fastifyHelmet, {
    // La gestiamo a mano per richiesta: serve il nonce.
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    strictTransportSecurity: { maxAge: 63_072_000, includeSubDomains: true, preload: true },
    frameguard: { action: 'deny' },
    noSniff: true,
    xssFilter: false,
  });

  app.addHook('onRequest', async (request, reply) => {
    const nonce = newNonce();
    request.cspNonce = nonce;
    reply.header('Content-Security-Policy', contentSecurityPolicy(nonce));
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  });

  // ---------------------------------------------------------------------------
  // SEC-14 — blocco delle rotte backup-code, registrato PRIMA dell'handler
  // better-auth. Un hook onRequest globale garantisce che nessun ordine di
  // registrazione delle rotte possa scavalcarlo.
  // ---------------------------------------------------------------------------
  app.addHook('onRequest', async (request, reply) => {
    const path = (request.url.split('?')[0] ?? '').replace(/\/+$/, '');
    if (BLOCKED_AUTH_PATHS.includes(path)) {
      request.log.warn({ path }, 'SEC-14: rotta backup-code bloccata');
      return reply.code(404).send({ error: 'not_found' });
    }
  });

  registerSecurityHooks(app, {
    appOrigin: ctx.env.APP_ORIGIN,
    csrfKey: ctx.keys.csrf,
    sessionIdOf: async (request: FastifyRequest) => {
      const cookie = request.headers.cookie;
      if (!cookie?.includes('__Host-metamc_session')) return undefined;
      const headers = new Headers();
      headers.set('cookie', cookie);
      const session = await ctx.auth.api.getSession({ headers });
      return session?.session?.id;
    },
  });

  assertNoStateChangingGet(app);
  installErrorHandler(app);

  // ---------------------------------------------------------------------------
  // §16.3 — AbortSignal propagato a ogni handler.
  //
  // In fase 1 non lo consuma nessuno. In fase 2 lo si passa a Kysely con
  // strategia `cancel query` e le aggregazioni orfane smettono di bruciare
  // CPU quando il client chiude la connessione.
  // ---------------------------------------------------------------------------
  app.decorateRequest('abortSignal', null);
  app.addHook('onRequest', async (request) => {
    const controller = new AbortController();
    request.raw.on('close', () => controller.abort());
    (request as FastifyRequest & { abortSignal: AbortSignal }).abortSignal = controller.signal;
  });

  // Sempre, non solo in sviluppo: se davanti non c'e' nginx, senza questa
  // rotta il pannello serve index.html e poi 404 sul suo stesso JavaScript.
  // Dove nginx c'e', intercetta `/assets/` e `/fonts/` prima di arrivare qui.
  registerStaticAssets(app, ctx.env.NODE_ENV === 'production');

  await registerHealthRoutes(app, ctx);
  await registerAuthRoutes(app, ctx);
  await registerAccountRoutes(app, ctx);
  await registerInviteRoutes(app, ctx);
  await registerOnboardingRoutes(app, ctx);
  await registerUserRoutes(app, ctx);
  await registerRoleRoutes(app, ctx);
  await registerStatsRoutes(app, ctx);
  await registerDuelsRoutes(app, ctx);
  registerDuelsConfigRoutes(app, ctx);
  registerAssistantRoutes(app, ctx);
  await registerStatsModeRoutes(app, ctx);
  await registerTwoFactorResetRoutes(app, ctx);
  await registerAuditRoutes(app, ctx);
  registerAvatarRoutes(app, ctx);
  await registerWebhookRoutes(app, ctx);

  // ---------------------------------------------------------------------------
  // index.html con il nonce. §2, §5.1
  //
  // nginx serve /assets/* con hash nel nome; tutto il resto arriva qui e
  // riceve la SPA. Nessun @fastify/static: gli asset non passano da Node.
  // ---------------------------------------------------------------------------
  app.get('/*', async (request, reply) => {
    const path = request.url.split('?')[0] ?? '/';
    if (path.startsWith('/api/') || path.startsWith('/internal/') || path.startsWith('/assets/')) {
      return reply.code(404).send({ error: 'not_found' });
    }
    reply.header('Content-Type', 'text/html; charset=utf-8');
    // §8.1.7, SEC-21 — la pagina che riceve un token in URL non deve finire
    // ne' in cache ne' nel Referer.
    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'no-referrer');
    return reply.send(ctx.indexHtml.render(request.cspNonce ?? newNonce()));
  });

  // ---------------------------------------------------------------------------
  // Eventi osservativi (§10): login riuscito/fallito, challenge 2FA fallita.
  // Questi SI' possono passare da un hook dopo la risposta — non sono eventi
  // di sicurezza con una modifica di stato da mantenere atomica.
  // ---------------------------------------------------------------------------
  app.addHook('onResponse', async (request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    if (!path.startsWith('/api/auth/')) return;

    const isLogin = path.endsWith('/sign-in/email');
    const isTotp = path.includes('/two-factor/verify-totp');
    if (!isLogin && !isTotp) return;

    const ok = reply.statusCode < 400;
    const action = isLogin
      ? ok
        ? AUDIT_ACTIONS.loginSucceeded
        : AUDIT_ACTIONS.loginFailed
      : ok
        ? // Era `stepUpSucceeded`: ogni login con 2FA finiva nel registro come
          // `auth.step_up.success`, un'operazione che il pannello non ha piu' e
          // che comunque non era questa. Le righe gia' scritte restano com'erano
          // — la catena hash le rende immutabili per costruzione — e il filtro
          // continua a offrire il valore storico.
          AUDIT_ACTIONS.twoFactorChallengeSucceeded
        : AUDIT_ACTIONS.twoFactorChallengeFailed;

    const ips = requestIps(request);
    const subject = authSubjectOf(request);

    // Un accesso riuscito che finisce nel registro senza attore e' un buco
    // nella risposta a «chi e' entrato e quando». Non e' fatale, ma va detto
    // ad alta voce invece di restare una riga muta fra migliaia.
    if (ok && subject === null) {
      request.log.warn({ path }, 'registro: accesso riuscito senza attore');
    }

    try {
      await writeAudit(ctx.db, {
        action,
        outcome: ok ? 'success' : 'failure',
        // Sui SUCCESSI l'attore c'e': lo deposita la rotta, che lo conosce —
        // sul login perche' ha appena verificato quella password, sul 2FA
        // perche' ha appena emesso la sessione. Prima era `null` in ogni caso,
        // e il registro non sapeva rispondere a «chi e' entrato e quando», che
        // e' una delle poche domande per cui esiste.
        //
        // Sui FALLIMENTI resta null, e li' e' giusto: l'utente sarebbe pure
        // noto, ma registrarlo farebbe del registro l'elenco degli indirizzi
        // provati da chiunque passi di qui.
        actor: {
          userId: subject?.userId ?? null,
          email: subject?.email ?? null,
          displayName: subject?.displayName ?? null,
          sessionId: null,
        },
        request: auditContextOf(request, ips),
        moduleKey: null,
        meta: { status: reply.statusCode },
      });
    } catch (err) {
      request.log.error({ err }, 'audit osservativo non scritto');
    }
  });

  return app;
}
