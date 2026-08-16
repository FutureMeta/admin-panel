// Contesto di richiesta: identita' di rete, contesto di audit, AuthzContext.
//
// SEC-22 / SEC-23 — si registrano DUE indirizzi:
//   - `actor_socket_ip` da socket.remoteAddress: NON falsificabile, ma con un
//     proxy davanti e' sempre l'IP del proxy.
//   - `actor_ip` derivato da X-Forwarded-For, che nginx SOVRASCRIVE (non
//     appende). Falsificabile se quella regola nginx manca.
//
// Registrarli entrambi rende visibile la divergenza. Se `actor_ip` non e'
// l'IP del proxy quando dovrebbe esserlo, o non e' plausibile, l'audit lo
// annota (`ip_mismatch`) e qualcuno se ne accorge.

import type { FastifyRequest } from 'fastify';
import type { AuditRequestContext } from '#src/audit/log.ts';
import type { AuthzContext } from '#src/authz/context.ts';
import { Unauthorized } from './errors.ts';

export type RequestIps = { ip: string | null; socketIp: string | null };

export function requestIps(request: FastifyRequest): RequestIps {
  // `request.ip` di Fastify applica gia' trustProxy, che e' configurato con
  // il CIDR esatto: se la richiesta non arriva dal proxy, l'header viene
  // ignorato ed `ip` resta l'indirizzo del socket.
  const ip = typeof request.ip === 'string' ? request.ip : null;
  const socketIp = request.socket.remoteAddress ?? null;
  return { ip, socketIp };
}

export function auditContextOf(request: FastifyRequest, ips: RequestIps): AuditRequestContext {
  const ua = request.headers['user-agent'];
  return {
    requestId: typeof request.id === 'string' ? request.id : null,
    ip: ips.ip,
    socketIp: ips.socketIp,
    userAgent: Array.isArray(ua) ? (ua[0] ?? null) : (ua ?? null),
  };
}

/**
 * Chiave per il rate limit per-IP. Il socket e' preferito quando i due
 * divergono in modo sospetto: e' l'unico dei due che l'attaccante non
 * controlla, e limitare sulla base di un valore falsificabile equivale a non
 * limitare (SEC-26).
 */
export function rateLimitIpKey(ips: RequestIps): string {
  return ips.socketIp ?? ips.ip ?? 'sconosciuto';
}

const AUTHZ_KEY = Symbol('authz');

type WithAuthz = FastifyRequest & { [AUTHZ_KEY]?: AuthzContext };

export function setAuthz(request: FastifyRequest, context: AuthzContext): void {
  (request as WithAuthz)[AUTHZ_KEY] = context;
}

/** Restituisce l'AuthzContext, o lancia. Un handler protetto non prosegue senza. */
export function actorOf(request: FastifyRequest): AuthzContext {
  const context = (request as WithAuthz)[AUTHZ_KEY];
  if (!context) throw new Unauthorized();
  return context;
}

export function maybeActorOf(request: FastifyRequest): AuthzContext | undefined {
  return (request as WithAuthz)[AUTHZ_KEY];
}

/** Attore per l'audit, derivato dal contesto. Denormalizzato al momento del fatto. */
export function auditActorOf(context: AuthzContext): {
  userId: string;
  email: string;
  displayName: string;
  sessionId: string;
} {
  return {
    userId: context.userId,
    email: context.actorEmail,
    displayName: context.actorDisplayName,
    sessionId: context.sessionId,
  };
}
