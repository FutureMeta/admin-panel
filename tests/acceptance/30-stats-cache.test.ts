// Passo 5 — la cache dei payload statistici. §7.
//
// COSA VERIFICA DAVVERO QUESTA SUITE. Non «la cache restituisce il valore»:
// quello lo farebbe anche una Map. Verifica i quattro modi precisi in cui una
// cache davanti a payload compressi mente senza sollevare eccezioni:
//
//   * i byte cambiano nel giro di andata e ritorno (`get` invece di
//     `getBuffer`), e il client riceve spazzatura senza che nessuno lo sappia;
//   * due compressioni partono insieme e rubano thread ad Argon2, cioe' un
//     grafico rallenta un login;
//   * N richieste su una chiave fredda costruiscono N volte lo stesso payload;
//   * un build fallito cancella il payload buono invece di lasciarlo.

import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decode, type Envelope, encode, inflate, StatsCache, type Ttl } from '#src/stats/cache.ts';
import { describeRedisBackend, type RedisHarness, startRedis } from '#tests/support/redis.ts';

const LONG: Ttl = { fresh: 60_000, stale: 60_000 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Attende che una condizione diventi vera, senza dormire a caso. */
async function until(cond: () => boolean | Promise<boolean>, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error('condizione mai verificata entro il tempo');
    await sleep(5);
  }
}

/**
 * Un payload con byte alti, perche' e' quello che rompe.
 *
 * Testare il giro con solo ASCII lo farebbe passare anche su un percorso che
 * decodifica in UTF-8: il difetto vive esattamente nei byte che l'ASCII non
 * contiene.
 */
function payloadWithHighBytes(seed: number): Buffer {
  const obj = {
    seed,
    testo: 'modalità · sopravvivenza · «unicità» — 100% coperto',
    numeri: Array.from({ length: 400 }, (_, i) => (i * seed) % 997),
  };
  return Buffer.from(JSON.stringify(obj), 'utf8');
}

describe(`passo 5 — cache dei payload (${describeRedisBackend()})`, () => {
  let redis: RedisHarness;
  let client: Redis;
  let cache: StatsCache;

  beforeAll(async () => {
    redis = await startRedis();
    client = redis.client();
  });

  afterAll(async () => {
    await redis.stop();
  });

  beforeEach(async () => {
    await client.flushall().catch(() => undefined);
    cache = new StatsCache({ redis: client });
  });

  // -------------------------------------------------------------------------
  // L'involucro
  // -------------------------------------------------------------------------

  it("l'involucro fa un giro esatto, byte per byte", () => {
    const env: Envelope = {
      enc: 1,
      builtAt: 1_760_000_000_123,
      freshUntil: 1_760_000_060_123,
      staleUntil: 1_760_000_660_123,
      rawLen: 37_412,
      etag: 'a1b2c3d4e5f60718293a4b5c',
      body: Buffer.from([0x1b, 0x00, 0x00, 0xff, 0xfe, 0x80, 0x7f]),
    };
    const back = decode(encode(env));
    expect(back).not.toBeNull();
    expect(back).toEqual(env);
    // Gli istanti sono in millisecondi: se fossero passati per un double
    // perderebbero proprio le tre cifre finali.
    expect(back?.builtAt).toBe(1_760_000_000_123);
  });

  it('un buffer che non e` un involucro nostro si legge come chiave assente, non come errore', () => {
    expect(decode(null)).toBeNull();
    expect(decode(Buffer.alloc(0))).toBeNull();
    expect(decode(Buffer.from('non sono un involucro'))).toBeNull();
    // Versione futura: si ignora, si ricostruisce, si riscrive.
    const good = encode({
      enc: 1,
      builtAt: 1,
      freshUntil: 2,
      staleUntil: 3,
      rawLen: 4,
      etag: '0'.repeat(24),
      body: Buffer.from([1]),
    });
    good.writeUInt8(99, 0);
    expect(decode(good)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Il difetto centrale: i byte
  // -------------------------------------------------------------------------

  it('i byte compressi sopravvivono al giro attraverso Redis', async () => {
    const raw = payloadWithHighBytes(7);
    const env = await cache.warmEnvelope('stats:v2:ov:24h', async () => raw, LONG, 11);

    // Riletto da Redis, NON dalla copia in memoria: e' il percorso che conta.
    const fresh = new StatsCache({ redis: client });
    const got = await fresh.envelope('stats:v2:ov:24h', async () => Buffer.from('mai'), LONG, 11);

    expect(got.etag).toBe(env.etag);
    expect(got.body.equals(env.body)).toBe(true);
    // E soprattutto: quello che ne esce e' il JSON di partenza, non un JSON
    // con dei punti interrogativi al posto delle accentate.
    expect(await inflate(got)).toBe(raw.toString('utf8'));
  });

  it("l'etag e` il digest del contenuto, non della compressione", async () => {
    const raw = payloadWithHighBytes(11);
    const a = await cache.warmEnvelope('k:a', async () => raw, LONG, 11);
    const b = await cache.warmEnvelope('k:b', async () => raw, LONG, 5);
    // Qualita' diverse, byte compressi diversi, STESSO contenuto: chi e' in
    // polling non deve riscaricare per un cambio di qualita'.
    expect(b.body.equals(a.body)).toBe(false);
    expect(b.etag).toBe(a.etag);

    const c = await cache.warmEnvelope('k:c', async () => payloadWithHighBytes(12), LONG, 11);
    expect(c.etag).not.toBe(a.etag);
  });

  // -------------------------------------------------------------------------
  // Fresco, obsoleto, mancante
  // -------------------------------------------------------------------------

  it('finche` e` fresco non ricostruisce', async () => {
    let builds = 0;
    const factory = async () => {
      builds += 1;
      return payloadWithHighBytes(builds);
    };
    await cache.envelope('k', factory, LONG, 5);
    await cache.envelope('k', factory, LONG, 5);
    await cache.envelope('k', factory, LONG, 5);

    expect(builds).toBe(1);
    expect(cache.metrics.misses).toBe(1);
    expect(cache.metrics.hits).toBe(2);
  });

  it('obsoleto: serve subito i byte vecchi e rifa` in sottofondo', async () => {
    let builds = 0;
    const factory = async () => {
      builds += 1;
      return Buffer.from(JSON.stringify({ builds }));
    };
    const ttl: Ttl = { fresh: 40, stale: 5_000 };

    const first = await cache.envelope('k', factory, ttl, 5);
    await sleep(60);

    const second = await cache.envelope('k', factory, ttl, 5);
    // I byte tornati sono ancora i VECCHI: chi legge non aspetta una
    // ricostruzione che non ha chiesto.
    expect(second.etag).toBe(first.etag);
    expect(cache.metrics.stale).toBe(1);

    // E la ricostruzione e` avvenuta davvero.
    //
    // Si attende il PAYLOAD CAMBIATO, non il contatore: `builds` cresce quando
    // la factory ENTRA, mentre la scrittura atterra dopo la compressione. Chi
    // aspetta il contatore rilegge la chiave vecchia e vede un test che
    // fallisce a caso.
    let latest = first;
    await until(async () => {
      latest = await cache.envelope('k', factory, ttl, 5);
      return latest.etag !== first.etag;
    });
    expect(latest.etag).not.toBe(first.etag);
    expect(builds).toBeGreaterThanOrEqual(2);
  });

  it('oltre la finestra obsoleta la richiesta aspetta il payload nuovo', async () => {
    let builds = 0;
    const factory = async () => {
      builds += 1;
      return Buffer.from(JSON.stringify({ builds }));
    };
    const ttl: Ttl = { fresh: 20, stale: 20 };

    const first = await cache.envelope('k', factory, ttl, 5);
    await sleep(70);
    const second = await cache.envelope('k', factory, ttl, 5);

    expect(builds).toBe(2);
    expect(second.etag).not.toBe(first.etag);
    expect(cache.metrics.misses).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Il cancello del passo 5
  // -------------------------------------------------------------------------

  it('singleflight: venti richieste su una chiave fredda costruiscono UNA volta', async () => {
    let builds = 0;
    const factory = async () => {
      builds += 1;
      await sleep(50); // il tempo in cui arrivano le altre diciannove
      return payloadWithHighBytes(1);
    };

    const all = await Promise.all(
      Array.from({ length: 20 }, () => cache.envelope('stats:v2:ov:90d', factory, LONG, 11)),
    );

    expect(builds).toBe(1);
    // `singleflight_joined` sempre a zero significherebbe che il percorso
    // pigro non e' mai stato esercitato, cioe' che non e' verificato.
    expect(cache.metrics.singleflightJoined).toBe(19);
    for (const env of all) expect(env.etag).toBe(all[0]?.etag);
  });

  it('mai due compressioni insieme, nemmeno con venti chiavi fredde in parallelo', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        cache.envelope(`k:${i}`, async () => payloadWithHighBytes(i + 1), LONG, 11),
      ),
    );
    // Due thread Brotli sono due thread tolti ad Argon2. Il picco deve valere
    // uno, sempre: e` il vincolo del §7.5 reso misurabile.
    expect(cache.metrics.compressPeak).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Quando qualcosa cade
  // -------------------------------------------------------------------------

  it('Redis irraggiungibile: si continua a servire l`ultimo payload buono', async () => {
    const raw = payloadWithHighBytes(3);
    await cache.warmEnvelope('k', async () => raw, LONG, 11);

    const broken = new Proxy(client, {
      get(target, prop, receiver) {
        if (prop === 'getBuffer' || prop === 'set') {
          return () => Promise.reject(new Error('Redis giu`'));
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Redis;

    const degraded = new StatsCache({ redis: broken });
    // Prima gli si fa conoscere un payload buono, poi cade tutto.
    await degraded.warmEnvelope('k', async () => raw, LONG, 11);
    const got = await degraded.envelope('k', async () => Buffer.from('mai'), LONG, 11);

    expect(await inflate(got)).toBe(raw.toString('utf8'));
    expect(degraded.metrics.redisUnavailable).toBeGreaterThan(0);
  });

  it('un build fallito lascia in piedi il payload vecchio invece di cancellarlo', async () => {
    const buono = payloadWithHighBytes(5);
    const ttl: Ttl = { fresh: 20, stale: 20 };
    await cache.envelope('k', async () => buono, ttl, 5);
    await sleep(70);

    const got = await cache.envelope(
      'k',
      async () => {
        throw new Error('la query e` andata in timeout');
      },
      ttl,
      5,
    );

    // Servire un payload vecchio e` meno grave che servirne uno rotto, e
    // molto meno grave che non servire niente.
    expect(await inflate(got)).toBe(buono.toString('utf8'));
    expect(cache.metrics.buildFailures).toBe(1);
  });

  it('un build fallito senza niente in mano solleva, invece di inventare un payload vuoto', async () => {
    await expect(
      cache.envelope(
        'k',
        async () => {
          throw new Error('la query e` andata in timeout');
        },
        LONG,
        5,
      ),
    ).rejects.toThrow('timeout');
    expect(cache.metrics.buildFailures).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Invalidazione e metriche
  // -------------------------------------------------------------------------

  it('invalidateTag cancella per prefisso e non tocca il resto', async () => {
    await cache.warmEnvelope('stats:v2:md:duels:24h', async () => Buffer.from('a'), LONG, 5);
    await cache.warmEnvelope('stats:v2:md:duels:7d', async () => Buffer.from('b'), LONG, 5);
    await cache.warmEnvelope('stats:v2:ov:24h', async () => Buffer.from('c'), LONG, 5);

    await cache.invalidateTag('stats:v2:md:duels:');

    expect(await client.exists('stats:v2:md:duels:24h')).toBe(0);
    expect(await client.exists('stats:v2:md:duels:7d')).toBe(0);
    expect(await client.exists('stats:v2:ov:24h')).toBe(1);

    // Anche la copia di degrado se ne va: se restasse, dopo un cambio di
    // classificazione il pannello continuerebbe a servire i numeri vecchi
    // proprio dalla copia che esiste per i guasti.
    expect(cache.ages().map(([k]) => k)).toEqual(['stats:v2:ov:24h']);
  });

  it("l'eta` della chiave e` la metrica che dice se il worker e` morto", async () => {
    const t0 = Date.now();
    await cache.warmEnvelope('stats:v2:ov:1y', async () => Buffer.from('x'), LONG, 11);

    const [entry] = cache.ages(t0 + 3 * 3_600_000);
    expect(entry?.[0]).toBe('stats:v2:ov:1y');
    // Tre ore: con l'hit rate al 100% per costruzione, e` l'unico numero che
    // distingue «cache che funziona» da «cache che ha smesso di aggiornarsi».
    expect(entry?.[1]).toBeGreaterThanOrEqual(3 * 3_600 - 5);
  });

  it('i byte, grezzi e compressi, sono esposti per chiave', async () => {
    const raw = payloadWithHighBytes(9);
    await cache.warmEnvelope('stats:v2:ov:30d', async () => raw, LONG, 11);
    const [[key, size]] = cache.sizes();
    expect(key).toBe('stats:v2:ov:30d');
    expect(size?.raw).toBe(raw.length);
    expect(size?.br).toBeLessThan(raw.length);
  });
});
