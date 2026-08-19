// Mappatura degli errori in risposte HTTP.
//
// SEC-31 — per ogni rotta con `:id`, un utente non autorizzato riceve LO
// STESSO codice di stato che riceverebbe per un id inesistente. Un 403 dove
// un estraneo vedrebbe 404 e' un oracolo di esistenza: dice "questa risorsa
// c'e', ma non e' tua", che e' esattamente l'informazione che non deve
// uscire.
//
// La regola e' implementata rendendo `Forbidden` su una risorsa indirizzata
// da id indistinguibile da `NotFound`. Il motivo vero resta nell'audit.

import type { FastifyReply, FastifyRequest } from 'fastify';
import { HibpUnavailable, PasswordCompromised } from '#src/auth/hibp.ts';
import { Overloaded } from '#src/auth/semaphore.ts';
import { Forbidden } from '#src/authz/can.ts';
import { RateLimited } from '#src/ratelimit/limiter.ts';

export class NotFound extends Error {
  constructor(message = 'risorsa inesistente') {
    super(message);
    this.name = 'NotFound';
  }
}

export class Unauthorized extends Error {
  constructor(message = 'non autenticato') {
    super(message);
    this.name = 'Unauthorized';
  }
}

export class BadRequest extends Error {
  readonly code: string;
  constructor(code: string, message = 'richiesta non valida') {
    super(message);
    this.name = 'BadRequest';
    this.code = code;
  }
}

export class Conflict extends Error {
  readonly code: string;
  constructor(code: string, message = 'conflitto') {
    super(message);
    this.name = 'Conflict';
    this.code = code;
  }
}

/**
 * Rotte che indirizzano una risorsa con un id. Su queste, `Forbidden`
 * diventa 404 (SEC-31). Sulle rotte di collezione un 403 e' corretto e non
 * rivela nulla: l'esistenza del modulo non e' un segreto per chi e' gia'
 * dentro il pannello.
 */
function addressesResourceById(request: FastifyRequest): boolean {
  const params = request.params;
  return typeof params === 'object' && params !== null && Object.keys(params).length > 0;
}

export type ErrorBody = { error: string; code?: string };

export function installErrorHandler(app: {
  setErrorHandler: (fn: (error: Error, request: FastifyRequest, reply: FastifyReply) => unknown) => unknown;
}): void {
  app.setErrorHandler((error: Error, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof Unauthorized) {
      return reply.code(401).send({ error: 'unauthorized' } satisfies ErrorBody);
    }

    if (error instanceof Forbidden) {
      // SEC-31 — su una risorsa indirizzata da id, stesso status di un id
      // inesistente. Il motivo reale finisce nel log, non nella risposta.
      request.log.warn(
        { module: error.module, required: error.required, had: error.had, url: request.url },
        'autorizzazione negata',
      );
      const status = addressesResourceById(request) ? 404 : 403;
      return reply.code(status).send({ error: status === 404 ? 'not_found' : 'forbidden' });
    }

    if (error instanceof NotFound) {
      return reply.code(404).send({ error: 'not_found' } satisfies ErrorBody);
    }

    if (error instanceof RateLimited) {
      reply.header('Retry-After', String(error.retryAfterSeconds));
      return reply.code(429).send({ error: 'rate_limited' } satisfies ErrorBody);
    }

    if (error instanceof Overloaded) {
      // SEC-28 — il semaforo Argon2 ha rifiutato. 503 e non 429: non e' il
      // client ad aver esagerato, e' il server a non avere thread liberi.
      reply.header('Retry-After', String(error.retryAfterSeconds));
      return reply.code(503).send({ error: 'overloaded' } satisfies ErrorBody);
    }

    if (error instanceof PasswordCompromised) {
      return reply.code(400).send({ error: 'password_compromised', code: 'PASSWORD_COMPROMISED' });
    }

    if (error instanceof HibpUnavailable) {
      // §8.6 — fail-closed con messaggio esplicito. Non si accetta una
      // password non verificata perche' un servizio terzo e' giu'.
      return reply.code(503).send({ error: 'password_check_unavailable', code: 'HIBP_UNAVAILABLE' });
    }

    if (error instanceof Conflict) {
      return reply.code(409).send({ error: 'conflict', code: error.code } satisfies ErrorBody);
    }

    if (error instanceof BadRequest) {
      return reply.code(400).send({ error: 'bad_request', code: error.code } satisfies ErrorBody);
    }

    // Validazione AJV di Fastify.
    const withValidation = error as Error & { validation?: unknown; statusCode?: number };
    if (withValidation.validation) {
      return reply.code(400).send({ error: 'bad_request', code: 'VALIDATION' } satisfies ErrorBody);
    }
    if (typeof withValidation.statusCode === 'number' && withValidation.statusCode < 500) {
      return reply.code(withValidation.statusCode).send({ error: 'bad_request' } satisfies ErrorBody);
    }

    // Nessun dettaglio interno esce mai: niente stack, niente messaggio,
    // niente nome di tabella.
    request.log.error({ err: error, url: request.url }, 'errore non gestito');
    return reply.code(500).send({ error: 'internal_error' } satisfies ErrorBody);
  });
}
