// §13 — health, readiness, metriche, integrita' dell'audit.
//
// Nessun dettaglio interno nelle risposte: niente versioni, niente host,
// niente stack. Una sonda che racconta la topologia e' ricognizione gratuita.

import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import type { AppContext } from '#src/app-context.ts';
import { verifyRecent } from '#src/audit/integrity.ts';

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
