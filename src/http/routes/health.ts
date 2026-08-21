// §13 — health, readiness, metriche, integrita' dell'audit.
//
// Nessun dettaglio interno nelle risposte: niente versioni, niente host,
// niente stack. Una sonda che racconta la topologia e' ricognizione gratuita.

import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import type { AppContext } from '#src/app-context.ts';
import { verifyRecent } from '#src/audit/integrity.ts';
import { eventLoopDelayP99 } from '#src/observability/event-loop.ts';
import { rollupWatermarks } from '#src/stats/rollup.ts';

const PROBE_TIMEOUT_MS = 1_000;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return Promise.race([p, new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ms))]);
}

export async function registerHealthRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // -------------------------------------------------------------------------
  // Liveness: 200 finche' il processo vive, ANCHE durante lo shutdown.
  //
  // Se rispondesse 503 in drenaggio, l'orchestratore ucciderebbe il processo
  // mentre sta ancora servendo le richieste in corso.
  // -------------------------------------------------------------------------
  app.get('/health/live', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return reply.send({ status: 'live' });
  });

  // -------------------------------------------------------------------------
  // Readiness: 503 IMMEDIATO su SIGTERM, cosi' il load balancer smette di
  // mandare traffico prima che il drenaggio inizi davvero.
  // -------------------------------------------------------------------------
  app.get('/health/ready', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');

    if (ctx.shuttingDown.value) {
      return reply.code(503).send({ status: 'shutting_down' });
    }

    const [pgProbe, redisProbe] = await Promise.all([
      withTimeout(
        sql`SELECT 1`
          .execute(ctx.db)
          .then(() => 'ok' as const)
          .catch(() => 'error' as const),
        PROBE_TIMEOUT_MS,
      ),
      withTimeout(
        ctx.redis
          .ping()
          .then(() => 'ok' as const)
          .catch(() => 'error' as const),
        PROBE_TIMEOUT_MS,
      ),
    ]);

    // SEC-28 — la saturazione del threadpool e' una condizione di readiness.
    // @fastify/under-pressure e' strutturalmente cieco su questa metrica,
    // perche' guarda event loop e memoria: un processo con tutti i thread
    // occupati da Argon2 ha un event loop perfettamente reattivo.
    const hashSaturated = ctx.semaphore.saturated;

    const pgOk = pgProbe === 'ok';
    const redisOk = redisProbe === 'ok';

    if (!pgOk) {
      // Senza Postgres non si autentica nessuno: non e' degradato, e' fermo.
      return reply.code(503).send({ status: 'not_ready' });
    }
    if (!redisOk || hashSaturated) {
      // Degradato: si distingue da "non pronto" perche' il servizio risponde
      // ancora, ma non deve ricevere traffico nuovo.
      return reply.code(503).send({ status: 'degraded' });
    }
    return reply.send({ status: 'ready' });
  });

  // -------------------------------------------------------------------------
  // §13 — metriche scritte a mano. Nessun prom-client (fermo alla 15.1.3 del
  // giugno 2024), nessun OpenTelemetry in fase 1.
  // -------------------------------------------------------------------------
  app.get('/internal/metrics', async (_request, reply) => {
    const s = ctx.semaphore.stats;
    const lines = [
      '# HELP metamc_argon2_in_flight hash Argon2 attualmente in volo',
      '# TYPE metamc_argon2_in_flight gauge',
      `metamc_argon2_in_flight ${s.inFlight}`,
      '# HELP metamc_argon2_limit tetto di hash concorrenti (UV_THREADPOOL_SIZE - 2)',
      '# TYPE metamc_argon2_limit gauge',
      `metamc_argon2_limit ${s.limit}`,
      '# HELP metamc_argon2_total hash Argon2 eseguiti dall`avvio',
      '# TYPE metamc_argon2_total counter',
      `metamc_argon2_total ${s.total}`,
      '# HELP metamc_argon2_rejected richieste rifiutate dal semaforo',
      '# TYPE metamc_argon2_rejected counter',
      `metamc_argon2_rejected ${s.rejected}`,
      '# HELP metamc_argon2_peak massimo di hash concorrenti osservato',
      '# TYPE metamc_argon2_peak gauge',
      `metamc_argon2_peak ${s.peak}`,
      '# HELP metamc_pg_pool_total connessioni nel pool',
      '# TYPE metamc_pg_pool_total gauge',
      `metamc_pg_pool_total ${ctx.pool.totalCount}`,
      '# HELP metamc_pg_pool_idle connessioni idle',
      '# TYPE metamc_pg_pool_idle gauge',
      `metamc_pg_pool_idle ${ctx.pool.idleCount}`,
      '# HELP metamc_pg_pool_waiting richieste in attesa di una connessione',
      '# TYPE metamc_pg_pool_waiting gauge',
      `metamc_pg_pool_waiting ${ctx.pool.waitingCount}`,
      '# HELP metamc_uptime_seconds secondi dall`avvio',
      '# TYPE metamc_uptime_seconds counter',
      `metamc_uptime_seconds ${Math.floor((Date.now() - ctx.startedAt.getTime()) / 1000)}`,
    ];

    // §10 — la condizione piu' grave che il sistema sappia rilevare. Vale 0
    // quando la verifica ha trovato una partizione che non torna, e NON torna
    // a 1 da sola: una catena rotta e' un fatto storico. E' la metrica da
    // agganciare all'alerting per prima.
    lines.push(
      '# HELP metamc_audit_chain_ok 1 se la catena audit torna, 0 se e` stata trovata compromessa',
      '# TYPE metamc_audit_chain_ok gauge',
      `metamc_audit_chain_ok ${ctx.maintenance.chainOk() ? 1 : 0}`,
    );

    // Un job che non gira e' invisibile finche' non serve. `last_success` a 0,
    // o vecchio di giorni, dice che non sta girando piu' — che per
    // l'ancoraggio significa nessuna prova esterna, e per la verifica
    // significa che una manomissione passerebbe inosservata.
    const jobs = ctx.maintenance.registry.entries();
    if (jobs.length > 0) {
      lines.push(
        '# HELP metamc_job_last_success_timestamp epoch dell`ultimo giro riuscito, 0 se mai',
        '# TYPE metamc_job_last_success_timestamp gauge',
        ...jobs.map(([name, s]) => `metamc_job_last_success_timestamp{job="${name}"} ${s.lastSuccessAt}`),
        '# HELP metamc_job_last_failure_timestamp epoch dell`ultimo giro fallito, 0 se mai',
        '# TYPE metamc_job_last_failure_timestamp gauge',
        ...jobs.map(([name, s]) => `metamc_job_last_failure_timestamp{job="${name}"} ${s.lastFailureAt}`),
        '# HELP metamc_job_failures_total giri falliti dall`avvio',
        '# TYPE metamc_job_failures_total counter',
        ...jobs.map(([name, s]) => `metamc_job_failures_total{job="${name}"} ${s.failures}`),
        '# HELP metamc_job_successes_total giri riusciti dall`avvio',
        '# TYPE metamc_job_successes_total counter',
        ...jobs.map(([name, s]) => `metamc_job_successes_total{job="${name}"} ${s.successes}`),
      );
    }

    // IL WATERMARK NUDO, perche' «in pari» non e' una prova.
    //
    // Un livello di rollup il cui watermark finisce nel futuro chiude la
    // finestra su se' stessa: dichiara `caughtUp`, conserva `rows_written`,
    // rinfresca `updated_at` e non scrive mai piu' una riga. Tutti i segnali
    // sopra continuano a dire che sta bene, e intanto i range lunghi si
    // svuotano. Il watermark invece si vede fermo, o avanti rispetto a
    // adesso, che sono le due sole forme dello stallo.
    //
    // Un livello che manca da qui e' un livello che questo processo non ha
    // mai eseguito, ed e' l'altra cosa che si vuole sapere.
    const marks = rollupWatermarks();
    if (marks.length > 0) {
      lines.push(
        '# HELP metamc_rollup_watermark_timestamp epoch del watermark, per livello',
        '# TYPE metamc_rollup_watermark_timestamp gauge',
        ...marks.map(([level, at]) => `metamc_rollup_watermark_timestamp{level="${level}"} ${at / 1000}`),
      );
    }
    // -----------------------------------------------------------------------
    // §7.9 — la cache delle statistiche.
    //
    // `cache_age_seconds` E' LA METRICA. Con il warm anticipato l'hit rate e'
    // ~100% per costruzione, e resta al 100% anche se il worker e' morto e
    // Redis serve lo stesso payload da tre ore: chi allarma sull'hit rate non
    // allarmera' mai. L'eta' della chiave servita e' l'unica cosa che
    // distingue «cache che funziona» da «cache che ha smesso di aggiornarsi
    // ma continua a rispondere». Soglia: 3x la cadenza di warm del suo range.
    // -----------------------------------------------------------------------
    const cm = ctx.statsCache.metrics;
    lines.push(
      '# HELP metamc_event_loop_delay_ms ritardo dell`event loop, 99esimo percentile',
      '# TYPE metamc_event_loop_delay_ms gauge',
      `metamc_event_loop_delay_ms{quantile="0.99"} ${eventLoopDelayP99().toFixed(2)}`,
      '# HELP metamc_stats_cache_hits_total letture servite da una chiave fresca',
      '# TYPE metamc_stats_cache_hits_total counter',
      `metamc_stats_cache_hits_total ${cm.hits}`,
      '# HELP metamc_stats_cache_stale_total letture servite da una chiave obsoleta ma valida',
      '# TYPE metamc_stats_cache_stale_total counter',
      `metamc_stats_cache_stale_total ${cm.stale}`,
      '# HELP metamc_stats_cache_misses_total letture che hanno dovuto costruire',
      '# TYPE metamc_stats_cache_misses_total counter',
      `metamc_stats_cache_misses_total ${cm.misses}`,
      '# HELP metamc_stats_singleflight_joined_total richieste attaccate a una costruzione gia` in corso',
      '# TYPE metamc_stats_singleflight_joined_total counter',
      // Sempre 0 significa che il percorso pigro non e' mai stato esercitato,
      // cioe' che non e' verificato da niente.
      `metamc_stats_singleflight_joined_total ${cm.singleflightJoined}`,
      '# HELP metamc_stats_redis_unavailable_total operazioni di cache fallite per Redis',
      '# TYPE metamc_stats_redis_unavailable_total counter',
      `metamc_stats_redis_unavailable_total ${cm.redisUnavailable}`,
      '# HELP metamc_stats_build_failures_total costruzioni di payload fallite',
      '# TYPE metamc_stats_build_failures_total counter',
      `metamc_stats_build_failures_total ${cm.buildFailures}`,
      '# HELP metamc_stats_compress_peak massimo di compressioni concorrenti osservato: deve valere 1',
      '# TYPE metamc_stats_compress_peak gauge',
      // Due compressioni insieme sono due thread tolti ad Argon2. Se questo
      // numero diventa 2, un grafico ha rallentato un login.
      `metamc_stats_compress_peak ${cm.compressPeak}`,
    );

    const ages = ctx.statsCache.ages();
    if (ages.length > 0) {
      lines.push(
        '# HELP metamc_stats_cache_age_seconds eta` del payload servibile. Allarme oltre 3x la cadenza di warm',
        '# TYPE metamc_stats_cache_age_seconds gauge',
        ...ages.map(([key, age]) => `metamc_stats_cache_age_seconds{key="${key}"} ${age}`),
        '# HELP metamc_stats_payload_bytes byte del payload. Oltre 120 kB grezzi va indagato',
        '# TYPE metamc_stats_payload_bytes gauge',
        ...ctx.statsCache
          .sizes()
          .flatMap(([key, s]) => [
            `metamc_stats_payload_bytes{key="${key}",enc="raw"} ${s.raw}`,
            `metamc_stats_payload_bytes{key="${key}",enc="br"} ${s.br}`,
          ]),
      );
    }

    // §8.3 — un database geografico che invecchia riassegna interi blocchi al
    // paese sbagliato, e lo fa in silenzio: la mappa continua a disegnarsi.
    // ALLARME A 45 GIORNI.
    const geo = ctx.statsIngest?.geo?.status();
    if (geo) {
      // `ready` SEPARATA dall'eta', e non e' ridondanza.
      //
      // L'eta' vale `null` esattamente quando nessun database e' caricato,
      // cioe' nel caso peggiore: volume nuovo, giro giornaliero che fallisce
      // da settimane. Emettendo la sola eta', quella serie sparirebbe e la
      // regola «allarme oltre 45 giorni» non scatterebbe mai — l'allarme si
      // spegnerebbe proprio mentre il guasto peggiora.
      lines.push(
        '# HELP metamc_geo_db_ready 1 se un database geografico e` caricato, 0 altrimenti',
        '# TYPE metamc_geo_db_ready gauge',
        `metamc_geo_db_ready ${geo.ready ? 1 : 0}`,
      );
      if (geo.ageDays !== null) {
        lines.push(
          '# HELP metamc_geo_db_age_days giorni dalla compilazione del database geografico. Allarme a 45',
          '# TYPE metamc_geo_db_age_days gauge',
          `metamc_geo_db_age_days ${geo.ageDays}`,
        );
      }
    }

    const builds = ctx.statsCache.buildTimes();
    if (builds.length > 0) {
      lines.push(
        '# HELP metamc_stats_build_ms tempo per stadio dell`ultima costruzione. Soglia 2000 su query',
        '# TYPE metamc_stats_build_ms gauge',
        ...builds.flatMap(([key, b]) => [
          `metamc_stats_build_ms{key="${key}",stage="query"} ${b.query}`,
          `metamc_stats_build_ms{key="${key}",stage="compress"} ${b.compress}`,
        ]),
      );
    }

    reply.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    reply.header('Cache-Control', 'no-store');
    return reply.send(`${lines.join('\n')}\n`);
  });

  // -------------------------------------------------------------------------
  // §10 — verifica di integrita' della catena.
  //
  // Restituisce 500 se non torna, ed e' agganciata allo stesso alerting che
  // monitora il servizio: un controllo che dipende dall'attenzione umana non
  // e' un controllo.
  // -------------------------------------------------------------------------
  app.get('/internal/audit-integrity', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const verdicts = await verifyRecent(ctx.db);
    const broken = verdicts.filter((v) => !v.ok);

    if (broken.length > 0) {
      ctx.logger.error({ broken }, 'INTEGRITA` AUDIT COMPROMESSA');
      return reply.code(500).send({
        status: 'compromised',
        partitions: verdicts.map((v) => ({
          partition: v.partitionKey,
          ok: v.ok,
          rows: v.rowsChecked,
          detail: v.detail,
        })),
      });
    }

    return reply.send({
      status: 'ok',
      partitions: verdicts.map((v) => ({ partition: v.partitionKey, ok: true, rows: v.rowsChecked })),
    });
  });
}
