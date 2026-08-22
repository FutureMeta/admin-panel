// Le rotte del modulo Duels.
//
// UNA RICHIESTA PER SCHERMATA, non una per riquadro. Il legacy ne fa quattro
// che scandiscono la stessa finestra per disegnare la stessa pagina; qui
// `trends` costruisce tutto in un giro e finisce in UN involucro di cache. Il
// precedente e' `buildAll` delle statistiche, e la ragione e' la stessa: sei
// query lanciate insieme costano meno di quattro richieste HTTP, ognuna con il
// suo ETag da confrontare e la sua chiave da scaldare.
//
// DUE MODULI DI PERMESSO, NON UNO. `duels` apre l'andamento delle partite —
// conteggi aggregati, nessun dato personale. `duels_feedback` apre le
// valutazioni, che portano nome del giocatore e testo scritto da lui. Sono due
// domande diverse su chi puo' vederle, e un modulo solo avrebbe costretto a
// rispondere una volta sola.
//
// LA LISTA NON VA IN CACHE, ed e' l'unica delle tre. Ha ricerca libera e
// cursore: lo spazio delle chiavi non e' enumerabile, quindi non e' scaldabile
// e non ha senso conservarla. `no-store`, e la protezione del carico e'
// l'indice, non la cache.

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppContext } from '#src/app-context.ts';
import { require as requireLevel } from '#src/authz/can.ts';
import { DK, isCommentFilter, isSort, RANGES, type Range } from '#src/duels/contract.ts';
import { BadCursor } from '#src/duels/provider.ts';
import { isRange } from '#src/stats/contract.ts';
import { ttlOf } from '#src/stats/warm.ts';
import { sendEnvelope } from '../envelope.ts';
import { requireAuth } from '../guards.ts';
import { actorOf } from '../request-context.ts';

const trendsSchema = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: { range: { type: 'string', enum: [...RANGES] } },
  },
} as const;

const ratingsSchema = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      range: { type: 'string', enum: [...RANGES] },
      // Il tetto e' parte del contratto: `mode_id` e' uno `smallint`, e un
      // numero fuori scala non deve arrivare a costruire una chiave di cache.
      mode: { type: 'integer', minimum: 0, maximum: 32_767 },
    },
  },
} as const;

const recentSchema = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      range: { type: 'string', enum: [...RANGES] },
      mode: { type: 'integer', minimum: 0, maximum: 32_767 },
      // 120 caratteri: una ricerca piu' lunga di cosi' non e' una ricerca.
      q: { type: 'string', maxLength: 120 },
      comment: { type: 'string', enum: ['all', 'with', 'without'] },
      sort: { type: 'string', enum: ['recent', 'worst', 'best'] },
      cursor: { type: 'string', maxLength: 256 },
    },
  },
} as const;

export async function registerDuelsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  /**
   * Gli id di modalita' che esistono, rinfrescati su miss.
   *
   * Come `isKnownMode` per le statistiche: una modalita' appena creata
   * funziona subito invece di aspettare un TTL, e un id inventato non
   * costruisce mai una chiave di cache.
   */
  let allowlist = new Set<number>();
  let allowlistAt = 0;

  const isKnownMode = async (mode: number): Promise<boolean> => {
    if (allowlist.has(mode)) return true;
    if (Date.now() - allowlistAt < 10_000) return false;
    const provider = ctx.duels;
    if (!provider) return false;
    allowlist = await provider.modeIds();
    allowlistAt = Date.now();
    return allowlist.has(mode);
  };

  const notConfigured = (reply: FastifyReply) =>
    // 503 e non 404: la rotta esiste, e' l'installazione che non ha ancora il
    // ruolo di lettura. Un 404 manderebbe a cercare un errore di
    // instradamento che non c'e'.
    reply.code(503).send({
      error: 'duels non configurati',
      detail: 'manca DATABASE_STATS_URL (ruolo metamc_stats, sola lettura)',
    });

  app.get(
    '/api/duels/trends',
    { schema: trendsSchema, preHandler: [requireAuth(ctx)] },
    async (request, reply) => {
      requireLevel(actorOf(request), 'duels', 1);
      const provider = ctx.duels;
      if (!provider) return notConfigured(reply);

      const q = request.query as { range?: string };
      const range: Range = isRange(q.range) ? q.range : '24h';

      const env = await ctx.statsCache.envelope(
        DK.tr(range),
        async () => Buffer.from(JSON.stringify(await provider.trends(range, new Date())), 'utf8'),
        ttlOf(),
        11,
      );
      return sendEnvelope(reply, env, request.headers['if-none-match'], request.headers['accept-encoding']);
    },
  );

  app.get(
    '/api/duels/ratings',
    { schema: ratingsSchema, preHandler: [requireAuth(ctx)] },
    async (request, reply) => {
      requireLevel(actorOf(request), 'duels_feedback', 1);
      const provider = ctx.duels;
      if (!provider) return notConfigured(reply);

      const q = request.query as { range?: string; mode?: number };
      const range: Range = isRange(q.range) ? q.range : '24h';
      const mode = q.mode ?? null;

      if (mode !== null && !(await isKnownMode(mode))) {
        // 404, MAI un payload vuoto. Un payload vuoto l'interfaccia lo
        // disegna come «zero valutazioni»: una bugia al posto di un errore.
        return reply.code(404).send({
          error: 'modalita` sconosciuta',
          detail: 'nessuna modalita` con questo identificativo nel catalogo dei duels',
        });
      }

      const env = await ctx.statsCache.envelope(
        DK.rt(mode, range),
        async () => Buffer.from(JSON.stringify(await provider.ratings(range, mode, new Date())), 'utf8'),
        ttlOf(),
        11,
      );
      return sendEnvelope(reply, env, request.headers['if-none-match'], request.headers['accept-encoding']);
    },
  );

  app.get(
    '/api/duels/ratings/recent',
    { schema: recentSchema, preHandler: [requireAuth(ctx)] },
    async (request, reply) => {
      requireLevel(actorOf(request), 'duels_feedback', 1);
      const provider = ctx.duels;
      if (!provider) return notConfigured(reply);

      const q = request.query as {
        range?: string;
        mode?: number;
        q?: string;
        comment?: string;
        sort?: string;
        cursor?: string;
      };
      const range: Range = isRange(q.range) ? q.range : '24h';
      const mode = q.mode ?? null;

      if (mode !== null && !(await isKnownMode(mode))) {
        return reply.code(404).send({
          error: 'modalita` sconosciuta',
          detail: 'nessuna modalita` con questo identificativo nel catalogo dei duels',
        });
      }

      // Niente involucro e niente ETag: con la ricerca libera lo spazio delle
      // chiavi non e' enumerabile, quindi non e' scaldabile.
      reply.header('Cache-Control', 'private, no-store');

      try {
        const page = await provider.recent({
          range,
          mode,
          q: q.q ?? null,
          comment: isCommentFilter(q.comment) ? q.comment : 'all',
          sort: isSort(q.sort) ? q.sort : 'recent',
          cursor: q.cursor ?? null,
          // Il totale si conta SOLO alla prima pagina di una combinazione di
          // filtri: sfogliando, la barra dice «altre» invece di far ripetere
          // una COUNT(*) a ogni cursore.
          withTotal: q.cursor === undefined,
          now: new Date(),
        });
        return reply.send(page);
      } catch (err) {
        if (err instanceof BadCursor) {
          // 400 e non «prima pagina»: un cursore corrotto che ricomincia da
          // capo in silenzio fa sfogliare in tondo senza che nessuno capisca
          // perche' la lista non finisce mai.
          return reply.code(400).send({
            error: 'cursore non valido',
            detail: 'il cursore non viene da questa lista o e` stato alterato',
          });
        }
        throw err;
      }
    },
  );
}
