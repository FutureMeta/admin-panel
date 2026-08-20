// Le statistiche del network. Fase 2, §6 — passo 5: servite dalla cache.
//
// SUPERFICIE MINIMA E RANGE CHIUSO. Niente `?days=N`, niente `?from=&to=`: lo
// spazio delle chiavi di cache deve restare finito ed enumerabile a priori
// (5 + 5·N), altrimenti non c'e' niente da scaldare. Aggiungere un range e'
// una modifica server, cioe' una decisione di costo presa da qualcuno.
//
// `onlineNow` NON sta nel corpo, e non e' un capriccio. Dentro un payload
// costruito ogni pochi minuti, un numero etichettato «online adesso» sarebbe
// vecchio di minuti — ed e' proprio il numero che il committente confronta con
// quello che vede sul server. Viaggia come intestazione, letto a ogni
// richiesta con una lettura per chiave primaria: cosi' sopravvive anche al
// 304, che e' esattamente il caso del polling.
//
// I BYTE ESCONO COMPRESSI COSI' COME SONO IN CACHE. Decomprimere per poi far
// ricomprimere a valle sarebbe pagare due volte per lo stesso risultato, e la
// seconda volta su un thread che serve i login. Chi non dichiara `br` — cioe'
// praticamente solo curl — se li fa decomprimere qui.
//
// LA DEROGA DEL §9: questi payload NON variano per ruolo. Chi ha
// `statistiche >= 1` riceve gli stessi byte di chiunque altro ce l'abbia,
// perche' altrimenti una chiave di cache per ruolo moltiplicherebbe lo spazio
// delle chiavi per il numero dei ruoli. L'invariante I13 lo verifica: se un
// giorno il payload dovesse variare per ruolo, il test fallisce prima della
// fuga.

import type { FastifyInstance, FastifyReply } from 'fastify';
import { sql } from 'kysely';
import type { AppContext } from '#src/app-context.ts';
import { require as requireLevel } from '#src/authz/can.ts';
import type { Envelope } from '#src/stats/cache.ts';
import { inflate } from '#src/stats/cache.ts';
import { assertPayload, isRange, RANGES, type Range } from '#src/stats/contract.ts';
import { buildAll } from '#src/stats/read.ts';
import { K, markHot, ttlOf } from '#src/stats/warm.ts';
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

const modeSchema = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    required: ['mode'],
    properties: {
      range: { type: 'string', enum: [...RANGES] },
      // Il pattern e' parte del contratto, non una cortesia: una chiave fuori
      // da questo alfabeto non puo' esistere in `stats.mode`, e fermarla qui
      // significa che non arriva mai a costruire una chiave di cache.
      mode: { type: 'string', pattern: '^[a-z0-9_]{1,32}$' },
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

/**
 * Spedisce un involucro, rispettando `If-None-Match` e `Accept-Encoding`.
 *
 * Il 304 e' il caso normale, non l'eccezione: una dashboard aperta ripete la
 * stessa richiesta ogni minuto e il payload cambia molto piu' di rado.
 */
async function sendEnvelope(
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

export async function registerStatsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  /**
   * L'elenco delle modalita' che possono avere dati.
   *
   * Viene da `v_server_mode`, cioe' dalle modalita' con almeno un server
   * assegnato: una modalita' nel dizionario senza server non ha e non puo'
   * avere osservazioni, e va distinta da una inventata. Si rinfresca su miss,
   * cosi' una modalita' appena creata funziona subito invece di aspettare un
   * TTL.
   */
  let allowlist = new Set<string>();
  let allowlistAt = 0;

  const refreshAllowlist = async (): Promise<Set<string>> => {
    if (!ctx.statsDb) return new Set();
    const res = await sql<{ mode_key: string }>`
      SELECT DISTINCT mode_key FROM stats.v_server_mode
    `.execute(ctx.statsDb);
    allowlist = new Set(res.rows.map((r) => r.mode_key));
    allowlistAt = Date.now();
    return allowlist;
  };

  const isKnownMode = async (mode: string): Promise<boolean> => {
    if (allowlist.has(mode)) return true;
    if (Date.now() - allowlistAt < 10_000) return false;
    return (await refreshAllowlist()).has(mode);
  };

  const notConfigured = (reply: FastifyReply) =>
    // 503 e non 404: la rotta esiste, e' l'installazione che non ha ancora il
    // ruolo di lettura. Un 404 manderebbe a cercare un errore di
    // instradamento che non c'e'.
    reply.code(503).send({
      error: 'statistiche non configurate',
      detail: 'manca DATABASE_STATS_URL (ruolo metamc_stats, sola lettura)',
    });

  app.get(
    '/api/stats/overview',
    { schema: overviewSchema, preHandler: [requireAuth(ctx)] },
    async (request, reply) => {
      requireLevel(actorOf(request), 'statistiche', 1);
      const db = ctx.statsDb;
      if (!db) return notConfigured(reply);

      const q = request.query as { range?: string };
      const range: Range = isRange(q.range) ? q.range : '24h';

      const env = await ctx.statsCache.envelope(
        K.ov(range),
        async () => {
          const built = await buildAll(db, range);
          // Le invarianti si verificano PRIMA di mettere i byte in cache: un
          // payload rotto messo in cache resta rotto per tutta la sua
          // validita', e il difetto tipico non ha sintomi.
          assertPayload(built.overview);
          ctx.statsCache.recordBuild(K.ov(range), { query: built.queryMs });
          return Buffer.from(JSON.stringify(built.overview), 'utf8');
        },
        ttlOf(range),
        11,
      );

      const live = await onlineNow(ctx).catch(() => null);
      if (live) {
        reply.header('X-Online-Now', String(live.players));
        reply.header('X-Online-Now-At', String(live.at));
      }
      return sendEnvelope(reply, env, request.headers['if-none-match'], request.headers['accept-encoding']);
    },
  );

  app.get(
    '/api/stats/mode',
    { schema: modeSchema, preHandler: [requireAuth(ctx)] },
    async (request, reply) => {
      requireLevel(actorOf(request), 'statistiche', 1);
      const db = ctx.statsDb;
      if (!db) return notConfigured(reply);

      const q = request.query as { range?: string; mode: string };
      const range: Range = isRange(q.range) ? q.range : '24h';
      const mode = q.mode;

      if (!(await isKnownMode(mode))) {
        // 404, MAI un payload vuoto. Un payload vuoto l'interfaccia lo disegna
        // come «zero giocatori»: una bugia al posto di un errore.
        const known = await sql<{ n: string }>`
          SELECT count(*)::text AS n FROM stats.mode WHERE mode_key = ${mode}
        `.execute(db);
        const inDictionary = Number(known.rows[0]?.n ?? 0) > 0;
        return reply.code(404).send({
          error: 'modalita` senza dati',
          detail: inDictionary
            ? 'la modalita` esiste ma non ha nessun server assegnato, quindi non ha osservazioni'
            : 'nessuna modalita` con questa chiave',
        });
      }

      const env = await ctx.statsCache.envelope(
        K.md(mode, range),
        async () => {
          const built = await buildAll(db, range);
          const payload = built.perMode.get(mode);
          if (!payload) {
            throw new Error(`nessun payload per la modalita\` ${mode} nel range ${range}`);
          }
          assertPayload(payload);
          ctx.statsCache.recordBuild(K.md(mode, range), { query: built.queryMs });
          return Buffer.from(JSON.stringify(payload), 'utf8');
        },
        ttlOf(range),
        5,
      );

      // Si scalda cio' che qualcuno ha GUARDATO, non «le tre modalita` con
      // piu` giocatori»: quella e` una supposizione, e sbaglia esattamente
      // quando l'admin sta indagando su una modalita` marginale.
      markHot(ctx.cacheRedis, range, mode);

      const live = await onlineNow(ctx).catch(() => null);
      if (live) {
        reply.header('X-Online-Now', String(live.players));
        reply.header('X-Online-Now-At', String(live.at));
      }
      return sendEnvelope(reply, env, request.headers['if-none-match'], request.headers['accept-encoding']);
    },
  );
}
