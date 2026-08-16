// Client Redis. §5.4
//
// Il documento diceva Valkey; il committente usa Redis. Stesso protocollo,
// stesso client, stesse chiavi: cambia solo il nome del servizio e la riga di
// configurazione del server. ioredis resta pinnato alla 5.11.1 e NON alla
// 6.0.0, che e' fuori dal peer `^5.0.0` di @better-auth/redis-storage.

import { Redis } from 'ioredis';

export type RedisOptions = {
  url: string;
  keyPrefix?: string;
  /** Etichetta per i log: nessun segreto. */
  label?: string;
};

export function createRedis(opts: RedisOptions): Redis {
  const client = new Redis(opts.url, {
    // Fonde nella stessa pipeline tutti i comandi emessi nello stesso tick
    // dell'event loop. Il middleware del §9 emette sessione + authz + rate
    // limit insieme: diventano UN round trip invece di tre.
    enableAutoPipelining: true,
    // `scan` non va in autopipelining: e' iterativo per definizione e il
    // batching gli toglie il senso.
    autoPipeliningIgnoredCommands: ['scan', 'subscribe', 'psubscribe', 'info'],
    maxRetriesPerRequest: 2,
    // Fallire in fretta e' preferibile a una richiesta appesa: il limiter ha
    // il suo insuranceLimiter (SEC-27) e il middleware ricostruisce authz da
    // Postgres su miss.
    connectTimeout: 2_000,
    commandTimeout: 1_000,
    lazyConnect: false,
    ...(opts.keyPrefix ? { keyPrefix: opts.keyPrefix } : {}),
  });

  client.on('error', (err: Error) => {
    console.error(`[redis${opts.label ? `:${opts.label}` : ''}] ${err.message}`);
  });

  return client;
}

/**
 * Connessione separata e SENZA autopipelining per l'eventuale pub/sub di
 * fase 2: una connessione in modalita' subscribe non puo' servire comandi
 * normali, e mescolarle e' il modo classico di scoprirlo in produzione.
 */
export function createRedisSubscriber(opts: RedisOptions): Redis {
  return new Redis(opts.url, {
    enableAutoPipelining: false,
    maxRetriesPerRequest: null,
    connectTimeout: 2_000,
  });
}

/** Chiavi Redis del §9. Enumerate qui e in nessun altro posto. */
export const KEYS = {
  /** Snapshot di autorizzazione, FUORI dal blob di sessione (SEC-02). */
  authz: (userId: string) => `authz:${userId}`,
  /** Revoca puntuale di una sessione. */
  sessionRevoked: (sessionId: string) => `sessrev:${sessionId}`,
  /** SEC-11 — guardia anti-replay TOTP. */
  totpUsed: (userId: string, step: number) => `totp:used:${userId}:${step}`,
  /** Dedupe dei webhook Resend. */
  webhookSeen: (svixId: string) => `swh:${svixId}`,
  /** Rate limit: il prefisso lo gestisce rate-limiter-flexible. */
  rateLimit: (scope: string, key: string) => `rl:${scope}:${key}`,
} as const;
