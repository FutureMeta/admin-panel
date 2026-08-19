// Harness applicativo: un server Fastify vero, con Postgres vero, Redis (vero
// o mini-redis) e mailer in memoria.
//
// Non si stubba niente del percorso sotto test. L'unica cosa iniettata e' il
// `fetch` verso HIBP, perche' una suite non deve chiamare un servizio terzo, e
// il mailer, perche' non deve spedire email.

import { createHash, randomBytes } from 'node:crypto';
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
  /** Il finto Mojang: `calls` sono le URL uscite, in ordine. */
  minecraft: MinecraftStub;
  close: () => Promise<void>;
};

export type TestAppOptions = {
  label?: string;
  /** Secondi di validita' dello step-up. Abbassarlo permette di verificarne la scadenza. */
  idleSeconds?: number;
};

/**
 * Il finto Mojang.
 *
 * Registra ogni URL richiesta perche' meta' delle proprieta' da verificare
 * riguardano le chiamate che NON devono partire: un nome non valido non deve
 * uscire in rete, e la seconda richiesta dello stesso nome nemmeno.
 */
export type MinecraftStub = {
  calls: string[];
  /** false: Mojang risponde 404, il giocatore non esiste. */
  known: boolean;
  /** true: ogni chiamata fallisce, come con la rete giu'. */
  down: boolean;
  /** true: la texture torna piu' grande del limite accettato. */
  oversized: boolean;
  reset: () => void;
};

/** Un PNG minimo valido: firma piu' IHDR. */
const TEST_SKIN = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000400000004008060000008fb6ba60',
  'hex',
);

/**
 * UUID e hash della texture DERIVATI dal nome, non costanti.
 *
 * La cache delle skin vive in Redis e sopravvive fra un test e l'altro nello
 * stesso file. Con un solo UUID per tutti, il secondo test troverebbe in
 * cache i byte del primo e non chiamerebbe niente — e la verifica «ha
 * interrogato i tre host» passerebbe o fallirebbe a seconda dell'ordine.
 * Derivandoli, ogni nome ha la sua voce e i test restano indipendenti.
 */
const uuidFor = (name: string) => createHash('sha256').update(name).digest('hex').slice(0, 32);
const textureFor = (uuid: string) => createHash('sha256').update(uuid).digest('hex');

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

  const minecraft: MinecraftStub = {
    calls: [],
    known: true,
    down: false,
    oversized: false,
    reset: () => {
      minecraft.calls.length = 0;
      minecraft.known = true;
      minecraft.down = false;
      minecraft.oversized = false;
    },
  };

  const minecraftFetch: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    minecraft.calls.push(url);
    if (minecraft.down) throw new Error('Mojang non raggiungibile (simulato)');

    if (url.startsWith('https://api.mojang.com/users/profiles/minecraft/')) {
      if (!minecraft.known) return new Response('', { status: 404 });
      const name = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
      return new Response(JSON.stringify({ id: uuidFor(name), name }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.startsWith('https://sessionserver.mojang.com/session/minecraft/profile/')) {
      // Mojang restituisce davvero la URL della texture in `http`, non in
      // `https`: il client deve promuoverla, e il test lo verifica.
      const uuid = url.slice(url.lastIndexOf('/') + 1);
      const textures = Buffer.from(
        JSON.stringify({
          textures: {
            SKIN: { url: `http://textures.minecraft.net/texture/${textureFor(uuid)}` },
          },
        }),
      ).toString('base64');
      return new Response(
        JSON.stringify({
          id: uuid,
          name: 'giocatore',
          properties: [{ name: 'textures', value: textures }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    if (url.startsWith('https://textures.minecraft.net/texture/')) {
      const body = minecraft.oversized ? Buffer.alloc(300_000) : TEST_SKIN;
      return new Response(body, { status: 200, headers: { 'content-type': 'image/png' } });
    }

    throw new Error(`fetch non atteso nei test: ${url}`);
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
    LOG_LEVEL: 'fatal',
  });

  const ctx = await buildContext({
    env,
    mailer,
    indexHtml: prepareIndexHtml(TEST_INDEX_HTML),
    hibpFetch,
    minecraftFetch,
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
    minecraft,
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
