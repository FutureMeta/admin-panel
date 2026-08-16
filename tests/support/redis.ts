// Redis per i test.
//
// Se `TEST_REDIS_URL` e' presente si usa quello — e' il percorso della CI, ed
// e' quello che il §14 prescrive. Altrimenti si avvia il server RESP2
// minimale di tests/support/mini-redis.ts, che permette di eseguire i test
// dipendenti da Redis anche su una macchina senza container runtime.
//
// La differenza va dichiarata, non nascosta: `describeRedisBackend()` dice
// quale dei due si sta usando, e le suite lo stampano.

import { Redis } from 'ioredis';
import { MiniRedis } from './mini-redis.ts';

export type RedisHarness = {
  url: string;
  /** true se dietro c'e' un Redis vero. */
  real: boolean;
  client: () => Redis;
  stop: () => Promise<void>;
};

export function describeRedisBackend(): string {
  return process.env.TEST_REDIS_URL
    ? `Redis reale (${process.env.TEST_REDIS_URL.replace(/\/\/.*@/, '//***@')})`
    : 'mini-redis in-process (nessun container runtime disponibile)';
}

export async function startRedis(): Promise<RedisHarness> {
  const external = process.env.TEST_REDIS_URL;
  const clients: Redis[] = [];

  const makeClient = (url: string) => () => {
    const c = new Redis(url, {
      enableAutoPipelining: true,
      autoPipeliningIgnoredCommands: ['scan', 'subscribe', 'psubscribe', 'info'],
      maxRetriesPerRequest: 2,
      lazyConnect: false,
    });
    c.on('error', () => undefined);
    clients.push(c);
    return c;
  };

  if (external) {
    return {
      url: external,
      real: true,
      client: makeClient(external),
      stop: async () => {
        await Promise.all(clients.map((c) => c.quit().catch(() => undefined)));
      },
    };
  }

  const mini = new MiniRedis();
  await mini.start();
  return {
    url: mini.url,
    real: false,
    client: makeClient(mini.url),
    stop: async () => {
      await Promise.all(clients.map((c) => c.quit().catch(() => undefined)));
      await mini.stop();
    },
  };
}
