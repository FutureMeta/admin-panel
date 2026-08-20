// L'avvio del campionamento, accanto agli altri lavori periodici. Fase 2.
//
// Sta nel processo del pannello per la stessa ragione degli altri quattro
// (src/jobs/keeper.ts): un cron esterno regge finche' qualcuno lo configura, e
// si scopre rotto il giorno del guasto. Il prezzo e' lo stesso e va detto: a
// processo fermo non si campiona, e quegli slot restano MANCANTI nel registro
// — che e' esattamente cio' che devono essere, perche' nessuno stava
// guardando.
//
// RISORSE PROPRIE, e non e' simmetria estetica:
//
//   * pool Postgres separato con `metamc_ingest`, `statement_timeout` 5s. Se
//     il campionamento pescasse dal pool del pannello, un ciclo lento
//     terrebbe una delle sei connessioni che servono ai login;
//   * client Redis dedicato, senza autopipelining. In questa installazione e'
//     la stessa istanza delle sessioni: la connessione separata evita che una
//     pipeline da 250 comandi finisca davanti al round trip di autorizzazione
//     di un login. Non rende gratis la lettura — la contesa sul server resta —
//     ma toglie l'unica parte che possiamo togliere da qui.

import type { Logger } from 'pino';
import { createKysely, createPool } from '#src/db/pool.ts';
import type { JobRegistry, RunningJob } from '#src/jobs/scheduler.ts';
import { startJob } from '#src/jobs/scheduler.ts';
import { createGameRedis } from './game-redis.ts';
import { StatsPoller } from './poller.ts';

export type StatsIngestOptions = {
  /** URL del ruolo che scrive: `metamc_ingest`. Mai quello del pannello. */
  databaseUrl: string;
  /** Il Redis di gioco. Puo' essere lo stesso del pannello: il client no. */
  redisUrl: string;
  pattern: string;
  logger: Logger;
  registry: JobRegistry;
  /**
   * Falso nei test che vogliono il poller senza timer: si costruisce tutto e
   * si chiama `runOnce` a mano, cosi' ogni ciclo e' deterministico.
   */
  schedule?: boolean;
};

export type StatsIngest = {
  poller: StatsPoller;
  stop: () => Promise<void>;
};

export async function startStatsIngest(opts: StatsIngestOptions): Promise<StatsIngest> {
  const pool = createPool({
    connectionString: opts.databaseUrl,
    // Due: una che lavora e una di riserva. Di piu' non servirebbe — il ciclo
    // e' sequenziale — e sarebbero connessioni tolte al resto.
    max: 2,
    applicationName: 'metamc-stats-ingest',
    statementTimeout: '5s',
    searchPath: 'stats, public',
  });
  const db = createKysely(pool);
  const redis = createGameRedis(opts.redisUrl, 'ingest');
  const poller = new StatsPoller({ db, redis, logger: opts.logger, pattern: opts.pattern });

  await poller.start();
  opts.logger.info(
    { job: 'stats-ingest', runId: poller.runId, intervalMs: poller.intervalMs },
    'campionamento avviato',
  );

  let job: RunningJob | undefined;
  if (opts.schedule !== false) {
    job = startJob(
      {
        name: 'stats-ingest',
        intervalMs: poller.intervalMs,
        retryMs: poller.intervalMs,
        // La griglia e' il punto: i tick devono cadere sui multipli, non
        // scivolare di quanto e' durato il giro precedente.
        alignMs: poller.intervalMs,
        run: () => poller.runOnce(),
        successMessage: 'ciclo di campionamento',
        failureMessage: 'ciclo non registrato: quello slot restera` un buco, non uno zero',
      },
      opts.logger,
      opts.registry,
    );
  }

  return {
    poller,
    stop: async () => {
      job?.stop();
      redis.disconnect();
      await pool.end().catch(() => undefined);
    },
  };
}
