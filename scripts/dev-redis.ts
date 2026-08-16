// Server Redis minimale per lo SVILUPPO LOCALE.
//
// Non è un componente del prodotto. Esiste perché su una macchina senza Redis
// né container runtime il pannello non parte affatto: better-auth ci tiene le
// sessioni, il middleware ci legge `authz:{userId}`, la guardia anti-replay ci
// scrive i marcatori TOTP.
//
// È lo stesso server RESP2 usato dai test (tests/support/mini-redis.ts): non è
// un mock, ioredis ci si collega davvero e parla il protocollo vero. Non
// implementa EVAL, quindi in sviluppo il rate limiter va messo in memoria con
// `RATE_LIMIT_IN_MEMORY=1` — la politica è la stessa, cambia dove sta il
// contatore.
//
// In produzione si usa Redis vero. Questo file non viene copiato
// nell'immagine: il Dockerfile porta dentro solo `src/`, `scripts/` e
// `migrations/`, e nessun percorso applicativo lo importa.

import { MiniRedis } from '#tests/support/mini-redis.ts';

const port = Number(process.env.DEV_REDIS_PORT ?? 6399);

const server = new MiniRedis();
await server.start(port);

console.log(`mini-redis in ascolto su ${server.url}`);
console.log('NON è Redis: è il server RESP2 minimale dei test. Solo per sviluppo locale.');
console.log('Comandi non implementati: EVAL/EVALSHA. Usa RATE_LIMIT_IN_MEMORY=1.');

const stop = async () => {
  await server.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
