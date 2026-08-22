// Radice di composizione. Tutto ciò che ha stato viene costruito qui e
// INIETTATO: nessun singleton importato da un modulo (§5.3, §16.2).
//
// Il motivo non e' estetico. In fase 2 si aggiunge `statsPool` con un ruolo
// Postgres di sola lettura e `statement_timeout 10s`: con un pool importato
// come modulo globale, quell'aggiunta imporrebbe di toccare ogni file che fa
// una query. Cosi' e' una riga qui dentro.

import type { Redis } from 'ioredis';
import type pg from 'pg';
import type { Logger } from 'pino';
import { type AssistantRuntime, createAssistant } from '#src/assistant/runtime.ts';
import { type Auth, createAuth } from '#src/auth/auth.ts';
import { HibpClient } from '#src/auth/hibp.ts';
import { PasswordService } from '#src/auth/password.ts';
import { HashSemaphore } from '#src/auth/semaphore.ts';
import { TotpReplayGuard } from '#src/auth/totp.ts';
import { AuthzStore } from '#src/authz/store.ts';
import type { CacheService } from '#src/cache/service.ts';
import type { Env } from '#src/config/env.ts';
import { type DerivedKeys, deriveKeys, pepperRing } from '#src/crypto/keys.ts';
import { createKysely, createPool, type Database } from '#src/db/pool.ts';
import { canWriteConfig } from '#src/duels/config.ts';
import { type DuelsIngest, startDuelsIngest } from '#src/duels/keeper.ts';
import { createDuelsMysql, type DuelsMysql } from '#src/duels/mysql.ts';
import { PgDuelsProvider } from '#src/duels/pg.ts';
import type { DuelsProvider } from '#src/duels/provider.ts';
import { type DuelsWarmDeps, warmDuelsAllClosed } from '#src/duels/warm.ts';
import type { Mailer } from '#src/email/mailer.ts';
import { AuthzMiddleware } from '#src/http/authz-middleware.ts';
import type { IndexHtml } from '#src/http/index-html.ts';
import { createLogger } from '#src/http/logger.ts';
import { type MaintenanceKeeper, startMaintenance } from '#src/jobs/keeper.ts';
import { MinecraftSkins } from '#src/minecraft/skins.ts';
import { eventLoopDelayP99 } from '#src/observability/event-loop.ts';
import { RateLimitService } from '#src/ratelimit/limiter.ts';
import { createCacheRedis, createRedis } from '#src/redis/client.ts';
import { StatsCache } from '#src/stats/cache.ts';
import { type StatsIngest, startStatsIngest } from '#src/stats/keeper.ts';
import { type StatsWorker, startStatsWorker, warmOnBoot } from '#src/stats/warm.ts';

export type AppContext = {
  env: Env;
  keys: DerivedKeys;
  logger: Logger;
  pool: pg.Pool;
  db: Database;
  redis: Redis;
  auth: Auth;
  passwords: PasswordService;
  semaphore: HashSemaphore;
  store: AuthzStore;
  authz: AuthzMiddleware;
  rateLimit: RateLimitService;
  hibp: HibpClient;
  /** Skin Minecraft: le facce passano dal nostro dominio, non dal CDN. */
  skins: MinecraftSkins;
  /** I lavori periodici. Nei test e' inerte: nessun timer parte. */
  maintenance: MaintenanceKeeper;
  /**
   * Il campionamento della fase 2. `null` finche' non lo si accende con
   * STATS_INGEST_ENABLED: senza, il pannello gira esattamente come prima e
   * nessuna connessione in piu' viene aperta.
   */
  statsIngest: StatsIngest | null;
  /**
   * La porta verso i dati dei duels, sul ruolo di sola lettura.
   *
   * `null` senza `DATABASE_STATS_URL`, esattamente come `statsDb`: le rotte
   * rispondono 503 e il resto del pannello non cambia.
   */
  duels: DuelsProvider | null;
  /**
   * Il database del gioco, per le schermate di configurazione.
   *
   * `null` senza `DUELS_MYSQL_URL`. E' l'unico oggetto del pannello che puo'
   * SCRIVERE fuori dai nostri database, e chi lo usa lo fa dentro `tx`.
   */
  duelsMysql: DuelsMysql | null;
  /**
   * L'ingestione dei duels. `null` finche' non la si accende con
   * DUELS_INGEST_ENABLED: senza, nessuna connessione al MySQL del gioco viene
   * aperta e le schermate leggono lo storico gia' importato.
   */
  duelsIngest: DuelsIngest | null;
  /**
   * Il pool di sola lettura delle statistiche. `null` finche' non e'
   * configurato: le rotte rispondono 503 e il resto del pannello non cambia.
   */
  statsDb: Database | null;
  /**
   * La cache dei payload. Esiste SEMPRE, anche senza DATABASE_STATS_URL: le
   * rotte rispondono 503 prima di arrivarci, e un campo annullabile
   * costringerebbe ogni chiamante a un ramo che non serve a niente.
   */
  statsCache: StatsCache;
  /** Il client Redis dei payload. Ci vivono anche gli hot-set del §7.4. */
  cacheRedis: Redis;
  /**
   * Il giro di warm. `null` senza `startJobs` o senza il pool di lettura:
   * scaldare una cache che nessuno legge sarebbe lavoro sprecato, e nei test
   * il contesto si costruisce mille volte.
   */
  statsWarm: StatsWorker | null;
  /**
   * L'assistente conversazionale. `null` senza `ANTHROPIC_API_KEY`: la rotta
   * risponde 503, non si apre nessuna connessione e il resto del pannello
   * gira esattamente come prima.
   */
  assistant: AssistantRuntime | null;
  totpGuard: TotpReplayGuard;
  mailer: Mailer;
  /** Fase 2: la cache vera si scrive dietro questa interfaccia (§16.4). */
  cache: CacheService;
  indexHtml: IndexHtml;
  startedAt: Date;
  /** Diventa true su SIGTERM: /health/ready risponde 503 immediatamente. */
  shuttingDown: { value: boolean };
  close: () => Promise<void>;
};

export type BuildOptions = {
  env: Env;
  mailer: Mailer;
  indexHtml: IndexHtml;
  logger?: Logger;
  /** Iniettabili nei test: nessuna chiamata reale esce durante la suite. */
  hibpFetch?: typeof fetch;
  minecraftFetch?: typeof fetch;
  /**
   * Avvia i lavori periodici. Solo il processo server lo chiede: nei test
   * partirebbero contro il database effimero a ogni suite, senza aggiungere
   * niente a cio' che i test verificano.
   */
  startJobs?: boolean;
  /**
   * Nei test il rate limiter gira in memoria: mini-redis non implementa EVAL,
   * e rate-limiter-flexible su Redis usa uno script Lua. La POLITICA e' la
   * stessa, cambia solo dove sta il contatore.
   */
  rateLimitInMemory?: boolean;
};

export async function buildContext(opts: BuildOptions): Promise<AppContext> {
  const { env } = opts;
  const keys = deriveKeys(env.MASTER_KEY);
  const logger = opts.logger ?? createLogger(env.LOG_LEVEL, env.NODE_ENV !== 'production');

  const pool = createPool({
    connectionString: env.DATABASE_URL,
    max: env.PG_POOL_MAX,
    applicationName: 'metamc-admin',
    statementTimeout: '2s',
  });
  const db = createKysely(pool);
  const redis = createRedis({ url: env.REDIS_URL, label: 'main' });

  const semaphore = new HashSemaphore(env.UV_THREADPOOL_SIZE);
  const passwords = new PasswordService({
    // SEC-40 — tutti i pepper fino al corrente: un hash non ancora rigenerato
    // va verificato con quello con cui e' nato, altrimenti ruotare il pepper
    // equivarrebbe a un reset password globale.
    peppers: pepperRing(env.MASTER_KEY, env.PEPPER_VERSION),
    currentPepperVersion: env.PEPPER_VERSION,
    semaphore,
    /**
     * Dove finisce un hash rigenerato.
     *
     * L'hash nuovo e la versione si scrivono nella STESSA transazione: separate,
     * un'interruzione fra le due lascerebbe una riga che dichiara una versione
     * con cui il suo hash non e' stato prodotto — e da li' in poi quella
     * persona non entrerebbe piu'.
     *
     * Gli errori restano qui dentro: un ri-hash fallito non deve far fallire un
     * login, e al prossimo accesso si riprova.
     */
    onRehash: async ({ userId, phc, pepperVersion }) => {
      try {
        await db.transaction().execute(async (trx) => {
          if (phc !== undefined) {
            await trx
              .updateTable('auth.account')
              .set({ password: phc })
              .where('userId', '=', userId)
              .where('providerId', '=', 'credential')
              .execute();
          }
          await trx
            .updateTable('auth.user')
            .set({ pepper_version: pepperVersion })
            .where('id', '=', userId)
            .execute();
        });
        logger.info(
          { userId, pepperVersion, rehashed: phc !== undefined },
          phc !== undefined
            ? 'hash password rigenerato con il pepper corrente'
            : "pepper_version riallineata: l'hash era gia' quello corrente",
        );
      } catch (err) {
        logger.error({ err, userId }, 'ri-hash del pepper non riuscito: si riprova al prossimo accesso');
      }
    },
  });
  // L'hash-esca si precalcola ADESSO: farlo alla prima richiesta renderebbe
  // quella richiesta distinguibile da tutte le altre (SEC-30).
  await passwords.warmUp();

  const auth = createAuth({
    pool,
    redis,
    passwords,
    secret: keys.betterAuthSecret,
    baseURL: env.APP_ORIGIN,
    sessionAbsoluteSeconds: env.SESSION_ABSOLUTE_SECONDS,
  });

  const store = new AuthzStore(redis, db);
  const authz = new AuthzMiddleware({
    auth,
    db,
    redis,
    store,
    idleSeconds: env.SESSION_IDLE_SECONDS,
  });

  const rateLimit = new RateLimitService(opts.rateLimitInMemory ? {} : { redis });
  const hibp = new HibpClient(opts.hibpFetch ? { fetchImpl: opts.hibpFetch } : {});
  const skins = new MinecraftSkins({
    redis,
    ...(opts.minecraftFetch ? { fetchImpl: opts.minecraftFetch } : {}),
  });
  const maintenance = startMaintenance({
    db,
    anchorKey: keys.auditAnchor,
    anchorPath: env.AUDIT_ANCHOR_PATH,
    logger,
    enabled: opts.startJobs === true,
  });
  const totpGuard = new TotpReplayGuard(redis, db);

  // Il campionamento parte SOLO se acceso e solo con i job attivi: nei test il
  // contesto si costruisce mille volte e nessuno di quei mille deve aprire una
  // connessione al Redis di gioco.
  let statsIngest: StatsIngest | null = null;
  if (env.STATS_INGEST_ENABLED && env.DATABASE_INGEST_URL && opts.startJobs === true) {
    try {
      statsIngest = await startStatsIngest({
        databaseUrl: env.DATABASE_INGEST_URL,
        ...(env.DATABASE_ROLLUP_URL ? { rollupDatabaseUrl: env.DATABASE_ROLLUP_URL } : {}),
        redisUrl: env.GAME_REDIS_URL ?? env.REDIS_URL,
        ...(env.GEO_MMDB_PATH ? { geoPath: env.GEO_MMDB_PATH } : {}),
        pattern: env.GAME_REDIS_PATTERN,
        logger,
        registry: maintenance.registry,
      });
    } catch (err) {
      // Un campionamento che non parte NON deve tenere giu' il pannello: le
      // statistiche sono una funzione in piu', i login sono il mestiere.
      // Rumoroso pero': un grafico vuoto senza una riga di log e' il modo in
      // cui ci si accorge dopo settimane.
      logger.error({ err }, 'campionamento non avviato: il pannello parte, le statistiche restano ferme');
    }
  }

  const statsPool = env.DATABASE_STATS_URL
    ? createPool({
        connectionString: env.DATABASE_STATS_URL,
        // OTTO, come prescrive il §7.8, e la ragione e' aritmetica: un payload
        // si costruisce con NOVE query lanciate insieme. Con quattro
        // connessioni cinque restano in coda, e la coda conta nel timeout di
        // acquisizione: sotto carico scade, e a scadere non e' una query — e'
        // la costruzione INTERA del payload.
        max: 8,
        // Un grafico puo' aspettare; fallire no. Il default di cinque
        // secondi e' del percorso di login, dove fallire in fretta e' la
        // cosa giusta: qui significherebbe buttare via un payload gia'
        // meta' costruito perche' l'ottava connessione ha tardato.
        connectionTimeoutMillis: 20_000,
        applicationName: 'metamc-stats-read',
        statementTimeout: '10s',
        searchPath: 'stats, public',
      })
    : null;
  const statsDb = statsPool ? createKysely(statsPool) : null;

  // La porta dei duels vive sullo STESSO pool di sola lettura delle
  // statistiche: legge le stesse viste con lo stesso ruolo, e un secondo pool
  // sarebbe otto connessioni in piu' per rispondere alle stesse domande.
  const duels: DuelsProvider | null = statsDb ? new PgDuelsProvider(statsDb) : null;

  // CLIENT DEDICATO, anche quando l'istanza e' la stessa del pannello.
  //
  // Il documento vuole un'istanza Valkey a parte (`allkeys-lru`, senza
  // persistenza); qui il Redis e' uno solo, e cio' che si puo' comunque
  // togliere si toglie: senza autopipelining, un payload da 10 kB non finisce
  // nella stessa pipeline del round trip di autorizzazione di un login. Le
  // chiavi vivono tutte sotto `stats:v<n>:`, quindi il giorno in cui l'istanza
  // si separa non cambia una riga di codice.
  const cacheRedis = createCacheRedis({
    url: env.CACHE_REDIS_URL ?? env.REDIS_URL,
    label: 'cache',
  });

  const statsCache = new StatsCache({
    redis: cacheRedis,
    // Sotto pressione il giro di warm si ferma e riprende al tick dopo: un
    // grafico non puo' far rallentare un login.
    pressure: () => eventLoopDelayP99() > 100 || semaphore.stats.inFlight >= 5,
  });

  /**
   * Cosa serve per riscaldare i payload duels. `null` senza il ruolo di
   * lettura: senza provider non c'e' niente da costruire.
   */
  const duelsWarm: DuelsWarmDeps | null = duels
    ? { provider: duels, cache: statsCache, redis: cacheRedis, logger }
    : null;

  // L'ingestione dei duels, alle stesse condizioni del campionamento: accesa a
  // mano, con i job attivi, e con un guasto che non tiene giu' il pannello.
  // Rumoroso pero': una schermata ferma senza una riga di log e' il modo in
  // cui ce ne si accorge settimane dopo.
  //
  // Sta QUI e non accanto al campionamento perche' ha bisogno della cache e
  // del provider: e' lo stesso ciclo che ingerisce a ricostruire la fetta
  // viva, e senza quei due non avrebbe dove scriverla.
  // IL POOL MYSQL NASCE QUI, non piu' dentro il job.
  //
  // Apparteneva all'ingestione, ed era giusto finche' l'ingestione era l'unica
  // cosa che parlasse con il database del gioco. Le schermate Modes e Maps
  // leggono e scrivono quelle stesse tabelle, e devono poterlo fare anche a
  // ingestione spenta: configurare le modalita' non ha niente a che vedere con
  // l'importazione dello storico, e legare le due cose vorrebbe dire che
  // fermare un job spegne una schermata.
  //
  // Uno solo, passato al job: sono connessioni verso una macchina che non e'
  // nostra, e due serie per lo stesso database sarebbero il doppio del peso
  // per la stessa cosa.
  const duelsMysql = env.DUELS_MYSQL_URL ? createDuelsMysql(env.DUELS_MYSQL_URL) : null;

  // I PRIVILEGI DI SCRITTURA SI GUARDANO ALL'AVVIO, non al primo salvataggio.
  //
  // La prima volta in produzione è andata così: deploy pulito, schermate che
  // caricano, e il difetto scoperto premendo Salva — cioè da qualcuno che
  // stava già modificando una modalità, convinto di aver fatto una cosa che
  // non era successa. Una riga di log all'avvio costa una query e sposta la
  // scoperta dove non fa danno.
  //
  // NON blocca la partenza: leggere la configurazione funziona anche senza
  // poterla scrivere, e un pannello che non parte è peggio di un pannello che
  // dice cosa gli manca.
  if (duelsMysql && opts.startJobs) {
    void canWriteConfig(duelsMysql)
      .then((ok) => {
        if (ok) return;
        logger.warn(
          {
            tables:
              'duels_mode, duels_mode_setting, duels_map, duels_map_setting, duels_map_mode, duels_map_event_type',
          },
          'nessun privilegio di scrittura sul database del gioco: Modes e Maps si leggono ma non si salvano',
        );
      })
      .catch((err) => logger.warn({ err }, 'privilegi del database del gioco non verificabili'));
  }

  let duelsIngest: DuelsIngest | null = null;
  if (env.DUELS_INGEST_ENABLED && env.DUELS_MYSQL_URL && env.DATABASE_INGEST_URL && opts.startJobs) {
    try {
      duelsIngest = await startDuelsIngest({
        databaseUrl: env.DATABASE_INGEST_URL,
        mysqlUrl: env.DUELS_MYSQL_URL,
        ...(duelsMysql ? { mysql: duelsMysql } : {}),
        tz: env.DUELS_SOURCE_TZ,
        logger,
        registry: maintenance.registry,
        ...(duelsWarm ? { warm: duelsWarm } : {}),
      });
    } catch (err) {
      logger.error({ err }, 'ingestione duels non avviata: il pannello parte, i duels restano fermi');
    }
  }

  // Si costruisce DOPO la cache e il provider dei duels, perche' li usa: i
  // numeri che l'assistente dice sono gli stessi che le schermate disegnano,
  // e lo sono perche' passano dagli stessi oggetti.
  const assistant = createAssistant({ env, redis, statsDb, duels, cache: statsCache });

  const shuttingDown = { value: false };

  const context: AppContext = {
    env,
    keys,
    logger,
    pool,
    db,
    redis,
    auth,
    passwords,
    semaphore,
    store,
    authz,
    rateLimit,
    hibp,
    skins,
    maintenance,
    statsIngest,
    duelsIngest,
    statsDb,
    duels,
    duelsMysql,
    statsCache,
    cacheRedis,
    // Si accende DOPO `listen()`, in `startStatsWarming`.
    statsWarm: null,
    assistant,
    totpGuard,
    mailer: opts.mailer,
    // La cache generica del §16.4 e quella delle statistiche sono lo STESSO
    // oggetto: l'interfaccia era stata scritta in fase 1 esattamente perche'
    // la fase 2 potesse infilarcisi dentro senza toccare i chiamanti.
    cache: statsCache,
    indexHtml: opts.indexHtml,
    startedAt: new Date(),
    shuttingDown,
    close: async () => {
      // Prima i timer, poi le connessioni: un job che partisse mentre il pool
      // si chiude fallirebbe con un errore che non significa niente, e la
      // riga error nel log farebbe cercare un guasto che e' solo uno
      // spegnimento.
      maintenance.stop();
      await statsIngest?.stop().catch(() => undefined);
      await duelsIngest?.stop().catch(() => undefined);
      // Chi crea chiude: il job lo ha ricevuto, quindi non lo chiude lui.
      await duelsMysql?.close().catch(() => undefined);
      context.statsWarm?.stop();
      await assistant?.close().catch(() => undefined);
      await statsDb?.destroy().catch(() => undefined);
      await cacheRedis.quit().catch(() => undefined);
      await db.destroy().catch(() => undefined);
      await redis.quit().catch(() => undefined);
    },
  };

  return context;
}

/**
 * Accende il riempimento della cache. Da chiamare DOPO `listen()`.
 *
 * MAI PRIMA, e non e' pignoleria: `/health/ready` non deve mai dipendere dalle
 * statistiche, o un rollup lento terrebbe il pannello fuori dal bilanciatore
 * per colpa di una schermata secondaria.
 *
 * Il primo riempimento e' sequenziale e non atteso: `statsPool` ha quattro
 * connessioni, e lanciare cinque aggregazioni insieme su una page cache fredda
 * trasforma un warm da due secondi in uno da venti rubando CPU al percorso di
 * login. Il worker periodico parte quando il primo giro e' finito, cosi' i
 * cinque range non si accavallano nemmeno al primo tick.
 */
export function startStatsWarming(ctx: AppContext): void {
  if (!ctx.statsDb) return;
  // I periodi CHIUSI dei duels salgono su questo giro invece di avere il
  // proprio timer. La fetta viva non e' qui: quella la ricostruisce il ciclo
  // che ingerisce, subito dopo aver scritto le partite nuove.
  const duelsWarm: DuelsWarmDeps | null = ctx.duels
    ? { provider: ctx.duels, cache: ctx.statsCache, redis: ctx.cacheRedis, logger: ctx.logger }
    : null;

  const deps = {
    statsDb: ctx.statsDb,
    cache: ctx.statsCache,
    redis: ctx.cacheRedis,
    logger: ctx.logger,
    ...(duelsWarm ? { extra: { name: 'duels', run: () => warmDuelsAllClosed(duelsWarm) } } : {}),
  };
  void (async () => {
    try {
      await warmOnBoot(deps);
    } finally {
      // Anche se il primo giro e' andato male: un guasto momentaneo non deve
      // lasciare il pannello senza worker fino al prossimo riavvio.
      if (!ctx.shuttingDown.value) {
        ctx.statsWarm = startStatsWorker(deps, ctx.maintenance.registry);
      }
    }
  })();
}
