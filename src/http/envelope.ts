// La spedizione di un involucro di cache, in un posto solo.
//
// Nasce nelle rotte delle statistiche e ora la usano anche i duels. Duplicarla
// avrebbe significato due politiche di cache HTTP sullo stesso pannello, che
// divergono al primo aggiustamento: una manda `must-revalidate` e l'altra no,
// e la seconda smette di ricevere 304 senza che niente fallisca.

import type { FastifyReply } from 'fastify';
import { type Envelope, inflate } from '#src/stats/cache.ts';

/**
 * Spedisce un involucro, rispettando `If-None-Match` e `Accept-Encoding`.
 *
 * Il 304 e' il caso normale, non l'eccezione: una dashboard aperta ripete la
 * stessa richiesta ogni minuto e il payload cambia molto piu' di rado.
 */
export async function sendEnvelope(
  reply: FastifyReply,
  env: Envelope,
  ifNoneMatch: string | undefined,
  acceptEncoding: string | undefined,
) {
  reply.header('ETag', `"${env.etag}"`);
  // `must-revalidate` e non `no-store`: con `no-store` il browser non
  // conserva nulla, quindi non puo' mai presentare un `If-None-Match`, quindi
  // il 304 non avviene mai e ogni polling riscarica il payload intero.
  // `private` tiene comunque questi byte fuori da qualunque cache condivisa.
  reply.header('Cache-Control', 'private, max-age=0, must-revalidate');
  reply.header('Vary', 'Cookie, Accept-Encoding');
  reply.header('X-Payload-Built-At', String(Math.floor(env.builtAt / 1_000)));

  if (ifNoneMatch && ifNoneMatch.replace(/^W\//, '') === `"${env.etag}"`) {
    return reply.code(304).send();
  }

  reply.header('Content-Type', 'application/json; charset=utf-8');

  // I byte escono come stanno in cache. Decomprimere qui per farli
  // ricomprimere da un altro strato sarebbe pagare due volte lo stesso
  // risultato, e la seconda volta su un thread che serve i login.
  if (/\bbr\b/.test(acceptEncoding ?? '')) {
    reply.header('Content-Encoding', 'br');
    reply.header('Content-Length', String(env.body.length));
    return reply.send(env.body);
  }
  return reply.send(await inflate(env));
}
