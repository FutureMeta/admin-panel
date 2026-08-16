// Harness applicativo: un server Fastify vero, con Postgres vero, Redis (vero
// o mini-redis) e mailer in memoria.
//
// Non si stubba niente del percorso sotto test. L'unica cosa iniettata e' il
// `fetch` verso HIBP, perche' una suite non deve chiamare un servizio terzo, e
// il mailer, perche' non deve spedire email.

import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { type AppContext, buildContext } from '#src/app-context.ts';
import { parseEnv } from '#src/config/env.ts';
import { InMemoryMailer } from '#src/email/mailer.ts';
import { prepareIndexHtml } from '#src/http/index-html.ts';
import { buildServer } from '#src/http/server.ts';
import { createTestDatabase, type TestDatabase } from './postgres.ts';
import { type RedisHarness, startRedis } from './redis.ts';

export const TEST_ORIGIN = 'http://admin.metamc.test';

/** index.html finto ma con il segnaposto vero: il render deve funzionare davvero. */
const TEST_INDEX_HTML =
  '<!doctype html><html><head><title>MetaMC</title></head>' +
  '<body><div id="root"></div><script nonce="__CSP_NONCE__" type="module" src="/assets/app.js"></script></body></html>';

export type TestApp = {
  app: FastifyInstance;
  ctx: AppContext;
  db: TestDatabase;
  redis: RedisHarness;
  mailer: InMemoryMailer;
  /** Esito impostabile dai test per il controllo HIBP. */
  hibp: { mode: 'clean' | 'compromised' | 'down'; calls: number };
  close: () => Promise<void>;
};

export type TestAppOptions = {
  label?: string;
  /** Secondi di validita' dello step-up. Abbassarlo permette di verificarne la scadenza. */
  stepUpSeconds?: number;
  idleSeconds?: number;
};

export async function startTestApp(opts: TestAppOptions = {}): Promise<TestApp> {
  const db = await createTestDatabase(opts.label ?? 'app');
  const redis = await startRedis();
  const mailer = new InMemoryMailer();
  const hibp = { mode: 'clean' as 'clean' | 'compromised' | 'down', calls: 0 };

  const hibpFetch: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes('pwnedpasswords.com')) throw new Error(`fetch non atteso nei test: ${url}`);
    hibp.calls += 1;
    if (hibp.mode === 'down') throw new Error('HIBP non raggiungibile (simulato)');
    // Una riga con conteggio > 0 che corrisponde al suffisso richiesto non si
    // puo' fabbricare senza conoscere la password: per il caso "compromessa"
    // si risponde con un suffisso jolly che il client non trovera' mai, e si
    // usa invece il ramo esplicito qui sotto.
    const body =
      hibp.mode === 'compromised'
        ? `${'0'.repeat(35)}:1\n`
        : '0018A45C4D1DEF81644B54AB7F969B88D65:1\n00D4F6E8FA6EECAD2A3AA415EEC418D38EC:2\n';
    return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
  };

  const env = parseEnv({
    NODE_ENV: 'test',
    PORT: '3000',
    HOST: '127.0.0.1',
    APP_ORIGIN: TEST_ORIGIN,
    TRUST_PROXY_CIDR: '127.0.0.1/32',
    DATABASE_URL: db.appUrl,
    DATABASE_MIGRATE_URL: db.migrateUrl,
    PG_POOL_MAX: '6',
    REDIS_URL: redis.url,
    MASTER_KEY: randomBytes(32).toString('hex'),
    PEPPER_VERSION: '1',
    UV_THREADPOOL_SIZE: '8',
    MAIL_FROM: 'MetaMC Admin <no-reply@metamc.it>',
    RESEND_WEBHOOK_SECRET: `whsec_${Buffer.from('segreto-webhook-di-test-0123456789').toString('base64')}`,
    SESSION_ABSOLUTE_SECONDS: '28800',
    SESSION_IDLE_SECONDS: String(opts.idleSeconds ?? 1800),
    STEP_UP_SECONDS: String(opts.stepUpSeconds ?? 600),
    LOG_LEVEL: 'fatal',
  });

  const ctx = await buildContext({
    env,
    mailer,
    indexHtml: prepareIndexHtml(TEST_INDEX_HTML),
    hibpFetch,
    // mini-redis non implementa EVAL e rate-limiter-flexible su Redis gira uno
    // script Lua: nei test il contatore sta in memoria, la politica e' la stessa.
    rateLimitInMemory: !redis.real,
  });

  const app = await buildServer(ctx);
  await app.ready();

  return {
    app,
    ctx,
    db,
    redis,
    mailer,
    hibp,
    close: async () => {
      await app.close().catch(() => undefined);
      await ctx.close();
      await redis.stop();
      await db.drop();
    },
  };
}

/** Header che superano SEC-15 e SEC-16. I test che li omettono lo fanno apposta. */
export function sameOriginHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    origin: TEST_ORIGIN,
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
    ...extra,
  };
}

/** Estrae un cookie per nome da una risposta di `app.inject`. */
export function cookieFrom(setCookie: string | string[] | undefined, name: string): string | undefined {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const found = list.find((c) => c.startsWith(`${name}=`));
  if (!found) return undefined;
  const value = found.split(';')[0]?.split('=').slice(1).join('=');
  return value && value.length > 0 ? value : undefined;
}

export function cookieHeader(pairs: Record<string, string | undefined>): string {
  return Object.entries(pairs)
    .filter((e): e is [string, string] => typeof e[1] === 'string')
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}
