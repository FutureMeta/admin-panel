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
import { createKysely, createPool, type Database } from '#src/db/pool.ts';
import { GeoReader } from '#src/geo/reader.ts';
import { MAX_AGE_DAYS, updateGeoDb } from '#src/geo/updater.ts';
import type { JobRegistry, RunningJob } from '#src/jobs/scheduler.ts';
import { startJob } from '#src/jobs/scheduler.ts';
import { createGameRedis } from './game-redis.ts';
import { StatsPoller } from './poller.ts';
import { dailyClose, type RollupLevel, type RollupResult, runRollup } from './rollup.ts';

/**
 * Cadenze e attese, dal documento normativo.
 *
 * Il rollup non condivide il pool del campionamento: `max: 2` con un giro
 * lungo in corso significa che il ciclo aspetta la sua connessione, ed e'
 * esattamente il tipo di contesa che i pool separati esistono per togliere.
 */
const ROLLUP_JOBS: Array<{ level: RollupLevel; intervalMs: number; retryMs: number }> = [
  { level: '5m', intervalMs: 60_000, retryMs: 15_000 },
  { level: '1h', intervalMs: 300_000, retryMs: 60_000 },
  { level: '1d', intervalMs: 900_000, retryMs: 120_000 },
];

/** Quanto puo' durare un giro che sta recuperando arretrato. */
const CATCHUP_BUDGET_MS = 20_000;
/** Tetto di sicurezza sui passaggi, per non restare in un ciclo stretto. */
const CATCHUP_MAX_PASSES = 30;

/**
 * Un giro, che continua finche' e' indietro.
 *
 * Il catch-up e' limitato per statement — un arretrato di trenta giorni non
 * deve mai diventare una sola query — ma se si aspettasse l'intervallo fra un
 * pezzo e l'altro, recuperare un giorno di fermo richiederebbe ore. Quindi
 * dentro un giro si ripassa finche' non e' in pari o finche' il budget non
 * finisce, e il giro dopo riprende da dove eravamo.
 */
async function rollupPass(db: Database, level: RollupLevel): Promise<Record<string, unknown>> {
  const started = Date.now();
  let passes = 0;
  let rows = 0;
  let last: RollupResult | undefined;
  do {
    last = await runRollup(db, level);
    rows += last.rowsWritten;
    passes += 1;
  } while (!last.caughtUp && passes < CATCHUP_MAX_PASSES && Date.now() - started < CATCHUP_BUDGET_MS);
  return {
    livello: level,
    righe: rows,
    passaggi: passes,
    indietro: last?.behindBuckets ?? 0,
    ms: Date.now() - started,
  };
}

export type StatsIngestOptions = {
  /** URL del ruolo che scrive: `metamc_ingest`. Mai quello del pannello. */
  databaseUrl: string;
  /**
   * URL per i giri di rollup. In assenza usa quello del campionamento: i due
   * ruoli sono entrambi membri di `metamc_stats_rw`, quindi cambia solo quale
   * timeout eredita chi si collega a mano per indagare. Il POOL resta separato
   * comunque, ed e' quello che conta.
   */
  rollupDatabaseUrl?: string;
  /** Il Redis di gioco. Puo' essere lo stesso del pannello: il client no. */
  redisUrl: string;
  pattern: string;
  /**
   * Il file .mmdb della geolocalizzazione. Assente = funzione spenta, e il
   * paese resta null invece di diventare XX.
   */
  geoPath?: string;
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
  /** Il lettore geografico, se configurato. Le metriche ne leggono l'eta'. */
  geo: GeoReader | null;
  /** Il pool del rollup, esposto per i comandi di manutenzione e per i test. */
  rollupDb: Database;
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
  const rollupPool = createPool({
    connectionString: opts.rollupDatabaseUrl ?? opts.databaseUrl,
    max: 2,
    applicationName: 'metamc-stats-rollup',
    // Il rollup puo' durare: aggrega, e non c'e' nessuna richiesta in attesa.
    // Il campionamento no, ed e' per questo che i due pool sono distinti: con
    // uno solo da due connessioni, un giro lungo lascerebbe il ciclo ad
    // aspettare la propria.
    statementTimeout: '60s',
    searchPath: 'stats, public',
  });
  const rollupDb = createKysely(rollupPool);

  const db = createKysely(pool);
  const redis = createGameRedis(opts.redisUrl, 'ingest');

  // La geolocalizzazione si accende PRIMA del primo ciclo, o quel ciclo
  // scriverebbe `country = NULL` — che significa «funzione spenta» — su
  // giocatori per cui invece era accesa. Un file mancante al primo avvio e'
  // normale: lo scarica il giro giornaliero, e fino ad allora il paese resta
  // NULL, che e' esattamente cio' che era.
  const geo = opts.geoPath ? new GeoReader() : null;
  if (geo && opts.geoPath) {
    try {
      const status = await geo.load(opts.geoPath);
      opts.logger.info(
        { job: 'geo', tipo: status.databaseType, giorni: status.ageDays },
        status.ageDays !== null && status.ageDays > MAX_AGE_DAYS
          ? 'database geografico caricato ma VECCHIO: i blocchi riassegnati finiranno sul paese sbagliato'
          : 'database geografico caricato',
      );
    } catch (err) {
      opts.logger.warn(
        { job: 'geo', err },
        'database geografico non caricato: il paese restera` nullo finche` il giro giornaliero non lo scarica',
      );
    }
  }

  const poller = new StatsPoller({
    db,
    redis,
    logger: opts.logger,
    pattern: opts.pattern,
    ...(geo ? { countryOf: (value: string | undefined) => geo.countryOf(value) } : {}),
  });

  await poller.start();
  opts.logger.info(
    { job: 'stats-ingest', runId: poller.runId, intervalMs: poller.intervalMs },
    'campionamento avviato',
  );

  const jobs: RunningJob[] = [];
  if (opts.schedule !== false) {
    jobs.push(
      startJob(
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
      ),
    );

    jobs.push(
      startJob(
        {
          name: 'stats-session-reaper',
          intervalMs: 60_000,
          retryMs: 15_000,
          run: () => poller.reapSessions(),
          successMessage: 'sessioni scadute chiuse',
          failureMessage: 'reaper fermo: le sessioni interrotte resteranno aperte e le durate salteranno',
        },
        opts.logger,
        opts.registry,
      ),
    );

    jobs.push(
      startJob(
        {
          name: 'stats-daily-close',
          // Ogni quarto d'ora: il giorno vivo si riscrive, quelli chiusi si
          // marcano definitivi una volta sola e non si toccano piu'.
          intervalMs: 900_000,
          retryMs: 300_000,
          run: () => dailyClose(rollupDb),
          successMessage: 'chiusura giornaliera',
          failureMessage: 'chiusura giornaliera ferma: unici e sessioni resteranno a zero',
        },
        opts.logger,
        opts.registry,
      ),
    );

    if (geo && opts.geoPath) {
      const geoPath = opts.geoPath;
      jobs.push(
        startJob(
          {
            name: 'geo-db-update',
            intervalMs: 24 * 60 * 60 * 1_000,
            // Un'ora, non il giorno dopo: il file nuovo esce una volta al mese
            // e ritentare fra ventiquattro ore significa restare un giorno
            // indietro per una rete che ha singhiozzato un secondo.
            retryMs: 60 * 60 * 1_000,
            run: async () => ({
              ...(await updateGeoDb({ path: geoPath, reader: geo, logger: opts.logger })),
            }),
            successMessage: 'database geografico aggiornato',
            failureMessage:
              'database geografico non aggiornato: continua a girare quello vecchio, e invecchiando attribuira` blocchi al paese sbagliato',
          },
          opts.logger,
          opts.registry,
        ),
      );
    }

    for (const r of ROLLUP_JOBS) {
      jobs.push(
        startJob(
          {
            name: `stats-rollup-${r.level}`,
            intervalMs: r.intervalMs,
            retryMs: r.retryMs,
            run: () => rollupPass(rollupDb, r.level),
            successMessage: `rollup ${r.level}`,
            failureMessage: `rollup ${r.level} fermo: i grafici serviranno numeri vecchi`,
          },
          opts.logger,
          opts.registry,
        ),
      );
    }
  }

  return {
    poller,
    geo,
    rollupDb,
    stop: async () => {
      // Prima i timer, poi le connessioni: un giro che partisse mentre il pool
      // si chiude fallirebbe con un errore che non significa niente.
      for (const j of jobs) j.stop();
      redis.disconnect();
      await pool.end().catch(() => undefined);
      await rollupPool.end().catch(() => undefined);
    },
  };
}
