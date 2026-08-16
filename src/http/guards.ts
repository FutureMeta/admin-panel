// preHandler riutilizzabili: autenticazione, autorizzazione, step-up.
//
// Sono l'unico modo in cui una rotta ottiene un AuthzContext. Una rotta che
// dimentica `requireAuth` non riceve un attore parziale: riceve un'eccezione
// alla prima chiamata di `actorOf()`.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '#src/app-context.ts';
import { require as requireLevel } from '#src/authz/can.ts';
import type { ModuleKey, RequiredLevel } from '#src/authz/modules.ts';
import { issueCsrfCookie } from './csrf.ts';
import { StepUpRequired, Unauthorized } from './errors.ts';
import { actorOf, setAuthz } from './request-context.ts';

export type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * Esegue l'algoritmo del §9 e mette l'AuthzContext sulla richiesta.
 * Rifiuta con 401 GENERICO: il motivo preciso resta nei log.
 */
export function requireAuth(ctx: AppContext): PreHandler {
  return async (request, reply) => {
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
    issueCsrfCookie(reply, ctx.keys.csrf, outcome.context.sessionId);
  };
}

/** `can(actor, module, level)`, applicato prima dell'handler. */
export function requirePermission(module: ModuleKey, level: RequiredLevel): PreHandler {
  return async (request) => {
    requireLevel(actorOf(request), module, level);
  };
}

/**
 * §8.5 — step-up.
 *
 * L'operazione richiede un'asserzione TOTP negli ultimi 10 minuti. Non e'
 * "sei loggato": e' "hai dimostrato di essere tu di recente". SEC-36: un XSS
 * che ruba una sessione non puo' promuoversi in silenzio, perche' non ha modo
 * di produrre un codice TOTP.
 *
 * L'elenco delle operazioni che lo richiedono e' CHIUSO ed e' in
 * STEP_UP_OPERATIONS.
 */
export function requireStepUp(ctx: AppContext): PreHandler {
  return async (request) => {
    const actor = actorOf(request);
    const ageMs = Date.now() - actor.authenticatedAt.getTime();
    if (ageMs > ctx.env.STEP_UP_SECONDS * 1000) {
      throw new StepUpRequired();
    }
  };
}

/**
 * Elenco CHIUSO delle operazioni che richiedono step-up (§8.5). Sta qui e non
 * sparso nelle rotte, perche' un elenco sparso non e' un elenco.
 */
export const STEP_UP_OPERATIONS = [
  'invito che concede livello 3 su almeno un modulo',
  'revoca invito',
  'modifica ruoli o permessi di chiunque',
  'ban / unban',
  'revoca sessioni altrui',
  'disattivazione 2FA',
  'rigenerazione recovery code',
  'cambio email',
  'cambio password',
  'qualunque scrittura sul modulo impostazioni',
  'offboarding',
] as const;

/** Sessione di onboarding (aal=0): solo per il percorso invito → enrollment. */
export function requireOnboarding(ctx: AppContext): PreHandler {
  return async (request) => {
    const headers = new Headers();
    for (const [k, v] of Object.entries(request.headers)) {
      if (typeof v === 'string') headers.set(k, v);
    }
    const raw = await ctx.auth.api.getSession({ headers });
    if (!raw?.session) throw new Unauthorized();
    // La sessione di onboarding NON diventa un AuthzContext: non ha permessi,
    // e non deve poterne acquisire per errore di plumbing.
  };
}

export function registerGuards(_app: FastifyInstance): void {
  // Nessuna decorazione globale: le guardie si applicano per rotta, cosi' una
  // rotta non protetta e' visibile leggendo la rotta e non un file lontano.
}
