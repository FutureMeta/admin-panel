// Le due rotte di «Duels · Live».
//
// NIENTE CACHE, E NON E' UNA DIMENTICANZA. Tutte le altre rotte dei duels
// passano da un involucro con ETag perche' rispondono a domande su un periodo
// chiuso, che non cambiano. Qui la domanda e' «adesso»: una risposta conservata
// anche solo cinque secondi e' una risposta sbagliata, e sarebbe sbagliata in
// silenzio — la schermata continuerebbe a disegnare partite finite.
//
// DUE ROTTE E NON UNA, e la seconda costa piu' della prima. La panoramica
// legge insiemi e hash: pipeline, nessuna scansione. Il roster invece va
// cercato girando l'indice inverso dei giocatori, che e' una `SCAN` sul Redis
// di gioco. Metterlo dentro la panoramica vorrebbe dire una scansione per ogni
// partita in corso a ogni aggiornamento; cosi' invece si paga una volta, quando
// qualcuno apre una partita.
//
// IL MODULO E' `duels_live`, non `duels`. E' l'unica schermata dei duels che
// dice CHI sta giocando adesso, per nome, con server e ping — vedi la
// migration 020.

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppContext } from '#src/app-context.ts';
import { require as requireLevel } from '#src/authz/can.ts';
import { readLiveRoster, readLiveSnapshot } from '#src/duels/live.ts';
import { requireAuth } from '../guards.ts';
import { actorOf } from '../request-context.ts';

const rosterSchema = {
  params: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    // L'identificativo di una partita e' una stringa breve scritta dal plugin.
    // Il tetto non e' cortesia: quella stringa finisce dentro un confronto su
    // migliaia di valori, e una lunga un megabyte sarebbe lavoro regalato.
    properties: { id: { type: 'string', minLength: 1, maxLength: 128 } },
  },
} as const;

function notConfigured(reply: FastifyReply): FastifyReply {
  // 503 e non 500: non e' un guasto, e' una funzione che questa installazione
  // non ha acceso. La differenza conta per chi legge i log.
  return reply.code(503).send({
    error: 'non disponibile',
    detail: 'il collegamento al Redis di gioco non e` configurato su questa installazione',
  });
}

export async function registerDuelsLiveRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/duels/live', { preHandler: [requireAuth(ctx)] }, async (request, reply) => {
    requireLevel(actorOf(request), 'duels_live', 1);
    const redis = ctx.gameRedis;
    if (!redis) return notConfigured(reply);

    reply.header('Cache-Control', 'private, no-store');
    return readLiveSnapshot(redis, ctx.duelsMysql, new Date());
  });

  app.get(
    '/api/duels/live/match/:id',
    { schema: rosterSchema, preHandler: [requireAuth(ctx)] },
    async (request, reply) => {
      requireLevel(actorOf(request), 'duels_live', 1);
      const redis = ctx.gameRedis;
      if (!redis) return notConfigured(reply);

      const { id } = request.params as { id: string };
      reply.header('Cache-Control', 'private, no-store');
      const roster = await readLiveRoster(redis, id);
      return { matchId: id, ...roster };
    },
  );
}
