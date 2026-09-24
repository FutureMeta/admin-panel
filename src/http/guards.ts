// preHandler riutilizzabili: autenticazione e autorizzazione.
//
// Sono l'unico modo in cui una rotta ottiene un AuthzContext. Una rotta che
// dimentica `requireAuth` non riceve un attore parziale: riceve un'eccezione
// alla prima chiamata di `actorOf()`.
//
// Nessuna decorazione globale: le guardie si applicano per rotta, cosi' una
// rotta non protetta si vede leggendo la rotta e non un file lontano. Il
// livello richiesto lo controlla l'handler, e `check-guards` fallisce se una
// rotta autenticata non lo fa.

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '#src/app-context.ts';
import { issueCsrfCookie } from './csrf.ts';
import { rateLimitIpKey, requestIps, setAuthz } from './request-context.ts';

export type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * Esegue l'algoritmo del §9 e mette l'AuthzContext sulla richiesta.
 * Rifiuta con 401 GENERICO: il motivo preciso resta nei log.
 */
export function requireAuth(ctx: AppContext): PreHandler {
  return async (request, reply) => {
    // SEC-26 — il fondo scala per indirizzo, consumato PRIMA di risolvere la
    // sessione: e' un tetto, e un tetto che si paga solo dopo aver fatto il
    // lavoro non e' un tetto. 600 al minuto non tocca la navigazione normale
    // — una pagina di registro con cinquanta avatar ne usa una frazione — e
    // morde solo chi insiste. E' l'unica difesa quando gli indirizzi sono
    // falsificati o distribuiti, dove i limiti per-IP piu' stretti non
    // arrivano mai a scattare.
    await ctx.rateLimit.consume('apiIp', rateLimitIpKey(requestIps(request)));

    const headers = new Headers();
    for (const [k, v] of Object.entries(request.headers)) {
      if (typeof v === 'string') headers.set(k, v);
      else if (Array.isArray(v)) headers.set(k, v.join(', '));
    }

    const outcome = await ctx.authz.resolve(headers);
    if (!outcome.ok) {
      request.log.info(
        { reason: outcome.reason, userId: outcome.userId, sessionId: outcome.sessionId },
        'accesso rifiutato',
      );
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }

    setAuthz(request, outcome.context);

    // SEC-17 — il cookie CSRF viene (ri)emesso a ogni richiesta autenticata:
    // e' derivato dall'id di sessione, quindi cambia quando la sessione
    // ruota, e il client non deve preoccuparsi di aggiornarlo.
    issueCsrfCookie(reply, ctx.keys.csrf, outcome.context.sessionId, ctx.env.SESSION_ABSOLUTE_SECONDS);
  };
}

/*
 * LO STEP-UP NON C'E' PIU'. §8.5, rimosso su richiesta del committente.
 *
 * Cosa proteggeva, perche' resti scritto: chiedeva un codice TOTP fresco
 * prima delle operazioni privilegiate. Non «sei loggato», ma «hai dimostrato
 * di essere tu adesso». Era la difesa del SEC-36 — una sessione rubata (XSS,
 * portatile lasciato aperto) non poteva promuoversi a owner, perche' il
 * codice dall'app non ce l'aveva.
 *
 * Cosa resta al suo posto: la 2FA obbligatoria al login, il dominio del §8.8
 * (nessuno tocca chi lo domina), la regola dei due owner, e il registro
 * append-only — che non impedisce l'abuso ma lo rende impossibile da
 * nascondere.
 *
 * Se un giorno lo si rimette, il posto e' questo e l'elenco delle operazioni
 * va tenuto qui dentro: sparso nelle rotte non sarebbe un elenco.
 */
