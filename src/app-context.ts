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
        max: 4,
        applicationName: 'metamc-stats-read',
        statementTimeout: '10s',
        searchPath: 'stats, public',
      })
    : null;
  const statsDb = statsPool ? createKysely(statsPool) : null;

  // CLIENT DEDICATO, anche quando l'istanza e' la stessa del pannello.
  //
  // Il documento vuole un'istanza Valkey a parte (`allkeys-lru`, senza
  // persistenza); qui il Redis e' uno solo, e cio' che si puo' comunque
  // togliere si toglie: senza autopipelining, un payload da 10 kB non finisce
  // nella stessa pipeline del round trip di autorizzazione di un login. Le
  // chiavi vivono tutte sotto `stats:v2:`, quindi il giorno in cui l'istanza
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
    statsDb,
    statsCache,
    cacheRedis,
    // Si accende DOPO `listen()`, in `startStatsWarming`.
    statsWarm: null,
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
      context.statsWarm?.stop();
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
  const deps = {
    statsDb: ctx.statsDb,
    cache: ctx.statsCache,
    redis: ctx.cacheRedis,
    logger: ctx.logger,
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
