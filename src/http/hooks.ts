// Hook globali di sicurezza. SEC-15, SEC-16, SEC-17, SEC-18, SEC-19
//
// Sono tre difese indipendenti contro il CSRF, e servono tutte e tre:
//   - Origin (SEC-15) e' il controllo forte, ma alcuni client legittimi non
//     lo mandano su richieste same-origin non-CORS.
//   - Sec-Fetch-Site (SEC-16) copre quel caso, ed e' l'unico che distingue un
//     sottodominio fratello.
//   - Il token firmato (SEC-17) e' cio' che resta se un browser vecchio non
//     manda nessuno dei due.
//
// Tutte e tre falliscono CHIUSE.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CSRF_HEADER, csrfValid } from './csrf.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Rotte esenti da SEC-15/16/17. L'unica e' il webhook Resend, che e'
 * server-to-server e non ha ne' Origin ne' Sec-Fetch-Site ne' una sessione da
 * cui derivare un token (SEC-19). E' protetto invece dalla verifica della
 * firma Svix sul raw body piu' il dedupe su svix-id.
 */
const CSRF_EXEMPT_PREFIXES = ['/webhooks/'];

function isExempt(url: string): boolean {
  const path = url.split('?')[0] ?? url;
  return CSRF_EXEMPT_PREFIXES.some((p) => path.startsWith(p));
}

export type SecurityHookOptions = {
  /** Origine ESATTA attesa. Nessun wildcard, nessuna lista. */
  appOrigin: string;
  csrfKey: Buffer;
  /** Restituisce l'id di sessione della richiesta, se ce n'e' una. */
  sessionIdOf: (request: FastifyRequest) => Promise<string | undefined> | string | undefined;
};

export function registerSecurityHooks(app: FastifyInstance, opts: SecurityHookOptions): void {
  // -------------------------------------------------------------------------
  // SEC-15 — Origin
  //
  // Fail-closed anche quando l'header e' ASSENTE. Un `Origin` mancante su una
  // richiesta che cambia stato non e' "un client vecchio": e' il caso che il
  // controllo esiste per intercettare, ed e' anche esattamente cio' che un
  // form cross-site classico produce.
  // -------------------------------------------------------------------------
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (SAFE_METHODS.has(request.method)) return;
    if (isExempt(request.url)) return;

    const origin = request.headers.origin;
    if (typeof origin !== 'string' || origin !== opts.appOrigin) {
      request.log.warn({ origin: origin ?? null, url: request.url }, 'SEC-15: origine rifiutata');
      return reply.code(403).send({ error: 'forbidden' });
    }
  });

  // -------------------------------------------------------------------------
  // SEC-16 — Resource Isolation Policy
  //
  // Si rifiuta anche `same-site`, non solo `cross-site`. Il punto e' proprio
  // escludere i sottodomini fratelli di metamc.it: `same-site` li include, e
  // un sottodominio compromesso e' il modello di minaccia da cui SameSite da
  // solo non protegge.
  // -------------------------------------------------------------------------
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (SAFE_METHODS.has(request.method)) return;
    if (isExempt(request.url)) return;

    const site = request.headers['sec-fetch-site'];
    if (typeof site !== 'string' || site !== 'same-origin') {
      request.log.warn({ site: site ?? null, url: request.url }, 'SEC-16: Sec-Fetch-Site rifiutato');
      return reply.code(403).send({ error: 'forbidden' });
    }
  });

  // -------------------------------------------------------------------------
  // SEC-17 — signed double-submit
  // -------------------------------------------------------------------------
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (SAFE_METHODS.has(request.method)) return;
    if (isExempt(request.url)) return;

    const sessionId = await opts.sessionIdOf(request);
    // Senza sessione non c'e' nulla da proteggere con il double-submit: le
    // rotte pubbliche che cambiano stato (login, accept invito) sono coperte
    // da SEC-15, SEC-16 e dal rate limiting.
    if (!sessionId) return;

    const presented = request.headers[CSRF_HEADER];
    const token = Array.isArray(presented) ? presented[0] : presented;
    if (!csrfValid(opts.csrfKey, sessionId, token)) {
      request.log.warn({ url: request.url }, 'SEC-17: token CSRF non valido');
      return reply.code(403).send({ error: 'forbidden' });
    }
  });

  // -------------------------------------------------------------------------
  // §9 — nessuna risposta autenticata viene mai cachata.
  //
  // Il contenuto dipende dai permessi del chiamante: una cache condivisa che
  // servisse la risposta di un owner a un moderatore sarebbe una fuga di dati
  // che nessun controllo applicativo puo' intercettare, perche' avviene
  // prima di arrivare all'applicazione.
  // -------------------------------------------------------------------------
  app.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/internal/')) {
      reply.header('Cache-Control', 'private, no-store');
      reply.header('Vary', 'Cookie');
    }
    return payload;
  });
}

/**
 * SEC-18 — nessun endpoint che cambia stato e' raggiungibile in GET.
 *
 * Verificato alla registrazione invece che a runtime: una rotta di scrittura
 * dichiarata per sbaglio come GET fa fallire l'avvio, non passa inosservata.
 */
export function assertNoStateChangingGet(app: FastifyInstance): void {
  const offenders: string[] = [];

  /**
   * `GET /accept` e' l'unica eccezione, ed e' prescritta dal §8.1.7: il link
   * dell'invito arriva da un'email, e un'email non puo' fare un POST.
   *
   * L'eccezione regge perche' quel GET non cambia stato di dominio: non
   * consuma l'invito, non crea l'utente, non concede permessi. Scambia il
   * token con una sessione di onboarding effimera (15 minuti, aal=0, nessun
   * permesso) e scrive una voce di audit osservativa. Il consumo vero e'
   * POST /api/invites/accept, ed e' li' che la UPDATE atomica decide.
   *
   * Il /api/auth/* di better-auth e' escluso perche' e' una rotta wildcard:
   * i suoi metodi li governa la libreria, e il blocco SEC-14 lavora prima.
   */
  const ALLOWED_GET = new Set(['/accept', '/api/auth/*', '/*']);

  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    if (!methods.includes('GET')) return;
    const url = route.url;
    if (ALLOWED_GET.has(url)) return;
    if (/\/(create|update|delete|revoke|ban|unban|offboard|accept|reset|enable|disable|grant)\b/.test(url)) {
      offenders.push(`${methods.join(',')} ${url}`);
    }
  });
  app.addHook('onReady', async () => {
    if (offenders.length > 0) {
      throw new Error(`SEC-18: rotte di scrittura raggiungibili in GET: ${offenders.join(', ')}`);
    }
  });
}
