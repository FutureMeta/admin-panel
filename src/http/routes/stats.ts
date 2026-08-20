// Le statistiche del network. Fase 2, §6 — passo 4: senza cache.
//
// SUPERFICIE MINIMA E RANGE CHIUSO. Niente `?days=N`, niente `?from=&to=`: lo
// spazio delle chiavi di cache deve restare finito ed enumerabile a priori,
// altrimenti al passo 5 non c'e' niente da scaldare. Aggiungere un range e'
// una modifica server, cioe' una decisione presa da qualcuno.
//
// `onlineNow` NON sta nel corpo, e non e' un capriccio. Dentro un payload
// costruito ogni pochi minuti, un numero etichettato «online adesso» sarebbe
// vecchio di minuti — ed e' proprio il numero che il committente confronta con
// quello che vede sul server. Viaggia come intestazione, letto a ogni
// richiesta con una lettura per chiave primaria: cosi' sopravvive anche al
// 304, che e' esattamente il caso del polling.

import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import type { AppContext } from '#src/app-context.ts';
import { require as requireLevel } from '#src/authz/can.ts';
import { assertPayload, isRange, RANGES } from '#src/stats/contract.ts';
import { buildOverview } from '#src/stats/read.ts';
import { requireAuth } from '../guards.ts';
import { actorOf } from '../request-context.ts';

const overviewSchema = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      range: { type: 'string', enum: [...RANGES] },
    },
  },
} as const;

/**
 * Il numero vivo, dall'ultimo ciclo riuscito.
 *
 * Va detto accanto a dove si mostra: questo conteggio e' l'insieme delle
 * chiavi vive nel Redis di gioco, il cui TTL misurato e' circa 104 secondi.
 * Chi esce resta quindi visibile per un paio di minuti, e il numero e'
 * STRUTTURALMENTE piu' alto di quello che il proxy dichiara. E' una
 * definizione, non un errore, e va scritta accanto al KPI invece che
 * aggiustata.
 */
async function onlineNow(ctx: AppContext): Promise<{ players: number; at: number } | null> {
  if (!ctx.statsDb) return null;
  const res = await sql<{ players: number; tick_at: Date }>`
    SELECT players, tick_at FROM stats.v_online_now
     WHERE tick_at > now() - interval '10 minutes'
  `.execute(ctx.statsDb);
  const row = res.rows[0];
  return row ? { players: Number(row.players), at: Math.floor(row.tick_at.getTime() / 1_000) } : null;
}

export async function registerStatsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get(
    '/api/stats/overview',
    { schema: overviewSchema, preHandler: [requireAuth(ctx)] },
    async (request, reply) => {
      requireLevel(actorOf(request), 'statistiche', 1);

      if (!ctx.statsDb) {
        // 503 e non 404: la rotta esiste, e' l'installazione che non ha ancora
        // il ruolo di lettura. Un 404 manderebbe a cercare un errore di
        // instradamento che non c'e'.
        return reply.code(503).send({
          error: 'statistiche non configurate',
          detail: 'manca DATABASE_STATS_URL (ruolo metamc_stats, sola lettura)',
        });
      }

      const q = request.query as { range?: string };
      const range = isRange(q.range) ? q.range : '24h';

      const { payload, queryMs } = await buildOverview(ctx.statsDb, range);
      // Le invarianti si verificano PRIMA di spedire. Una serie disallineata
      // di un elemento non solleva niente: il grafico disegna, e mostra numeri
      // corretti sotto l'etichetta sbagliata.
      assertPayload(payload);

      const live = await onlineNow(ctx).catch(() => null);
      if (live) {
        reply.header('X-Online-Now', String(live.players));
        reply.header('X-Online-Now-At', String(live.at));
      }
      // Senza cache, per ora: la deroga del §9 e il suo test di invarianza
      // byte-per-byte arrivano insieme alla cache vera.
      reply.header('Cache-Control', 'private, no-store');
      reply.header('Vary', 'Cookie');
      reply.header('Server-Timing', `query;dur=${queryMs}`);
      return reply.send(payload);
    },
  );
}
