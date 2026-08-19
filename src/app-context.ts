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
import { MinecraftSkins } from '#src/minecraft/skins.ts';
import { PasswordService } from '#src/auth/password.ts';
import { HashSemaphore } from '#src/auth/semaphore.ts';
import { TotpReplayGuard } from '#src/auth/totp.ts';
import { AuthzStore } from '#src/authz/store.ts';
import { type CacheService, PassthroughCache } from '#src/cache/service.ts';
import type { Env } from '#src/config/env.ts';
import { type DerivedKeys, deriveKeys } from '#src/crypto/keys.ts';
import { createKysely, createPool, type Database } from '#src/db/pool.ts';
import type { Mailer } from '#src/email/mailer.ts';
import { AuthzMiddleware } from '#src/http/authz-middleware.ts';
import type { IndexHtml } from '#src/http/index-html.ts';
import { createLogger } from '#src/http/logger.ts';
import { RateLimitService } from '#src/ratelimit/limiter.ts';
import { createRedis } from '#src/redis/client.ts';

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
  const passwords = new PasswordService({ pepper: keys.argon2Pepper, semaphore });
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
  const totpGuard = new TotpReplayGuard(redis, db);

  const shuttingDown = { value: false };

  return {
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
    totpGuard,
    mailer: opts.mailer,
    cache: new PassthroughCache(),
    indexHtml: opts.indexHtml,
    startedAt: new Date(),
    shuttingDown,
    close: async () => {
      await db.destroy().catch(() => undefined);
      await redis.quit().catch(() => undefined);
    },
  };
}
