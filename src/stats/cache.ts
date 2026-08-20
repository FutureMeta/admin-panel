// La cache dei payload statistici. Fase 2, §7 — passo 5.
//
// TRE COSE CHE QUESTO MODULO ESISTE PER GARANTIRE, e che si romperebbero in
// silenzio se fossero lasciate a una convenzione:
//
//  1. `getBuffer`, MAI `get`. `get` decodifica in UTF-8 e distrugge i byte
//     Brotli senza sollevare niente: il payload arriva, il client riceve
//     spazzatura, e nessuno strato intermedio se ne accorge. Vale anche in
//     scrittura — passare una stringa a `set` la ricodifica. E' IL difetto di
//     questa architettura, ed e' per questo che il corpo qui dentro e' sempre
//     e solo un Buffer.
//
//  2. UNA compressione alla volta, garantita da una catena interna e non da
//     una regola scritta. `brotliCompress` gira sul threadpool libuv, lo
//     stesso da cui `HashSemaphore` prende `UV_THREADPOOL_SIZE - 2` slot: due
//     compressioni concorrenti sono due thread tolti ad Argon2, cioe' due
//     login piu' lenti perche' qualcuno stava guardando un grafico. La catena
//     rende il vincolo strutturale: un chiamante futuro che scrivesse
//     `Promise.all` otterrebbe comunque una coda.
//
//  3. FRESCO e OBSOLETO stanno nell'INTESTAZIONE, non nel TTL di Redis. Un TTL
//     da solo non sa dire «scaduto ma ancora servibile»: una chiave scaduta e'
//     sparita, e sparita significa bloccare una richiesta che si poteva
//     servire subito. Il TTL vale `fresh + stale + margine` e serve solo a far
//     sparire le chiavi che nessuno guarda piu'.
//
// COSA NON E' `#lastGood`. Non e' una cache di primo livello e non deve
// diventarlo: e' UNA voce per chiave, ed e' il comportamento in degrado se
// Redis cade. Il nome lo dice apposta.

import { createHash } from 'node:crypto';
import { brotliCompress, brotliDecompress, constants as Z } from 'node:zlib';
import type { Redis } from 'ioredis';
import type { CacheService, CacheStats, GetOrSetOptions } from '#src/cache/service.ts';

/** Versione dell'involucro BINARIO, indipendente da quella del contratto. */
const ENVELOPE_VERSION = 1;

export const ENC_RAW = 0;
export const ENC_BROTLI = 1;

/**
 * 1 ver | 1 enc | 8 builtAt | 8 freshUntil | 8 staleUntil | 4 rawLen | 12 etag
 *
 * Gli istanti sono millisecondi epoch in BigUInt64: qui si confrontano ISTANTI,
 * non durate, e un double perderebbe il millisecondo.
 */
const HEADER = 42;
const ETAG_BYTES = 12;

export type Ttl = {
  /** Millisecondi di validita' piena. */
  fresh: number;
  /** Millisecondi ULTERIORI in cui il payload si serve mentre si rifa'. */
  stale: number;
};

export type Envelope = {
  builtAt: number;
  freshUntil: number;
  staleUntil: number;
  /** Byte del JSON prima della compressione: serve alla metrica, non al client. */
  rawLen: number;
  enc: typeof ENC_RAW | typeof ENC_BROTLI;
  /** Esadecimale, 24 caratteri. Va in `ETag` cosi' com'e'. */
  etag: string;
  body: Buffer;
};

export function encode(env: Envelope): Buffer {
  const head = Buffer.allocUnsafe(HEADER);
  head.writeUInt8(ENVELOPE_VERSION, 0);
  head.writeUInt8(env.enc, 1);
  head.writeBigUInt64LE(BigInt(env.builtAt), 2);
  head.writeBigUInt64LE(BigInt(env.freshUntil), 10);
  head.writeBigUInt64LE(BigInt(env.staleUntil), 18);
  head.writeUInt32LE(env.rawLen, 26);
  head.write(env.etag, 30, ETAG_BYTES, 'hex');
  return Buffer.concat([head, env.body]);
}

/**
 * `null` su qualunque cosa non sia un involucro nostro.
 *
 * Un byte storto qui non deve propagarsi: si tratta come chiave assente, si
 * ricostruisce, e cio' che viene scritto sopra e' di nuovo valido. Sollevare
 * significherebbe trasformare una cache sporca in un 500.
 */
export function decode(buf: Buffer | null | undefined): Envelope | null {
  if (!buf || buf.length < HEADER) return null;
  if (buf.readUInt8(0) !== ENVELOPE_VERSION) return null;
  const enc = buf.readUInt8(1);
  if (enc !== ENC_RAW && enc !== ENC_BROTLI) return null;
  return {
    enc,
    builtAt: Number(buf.readBigUInt64LE(2)),
    freshUntil: Number(buf.readBigUInt64LE(10)),
    staleUntil: Number(buf.readBigUInt64LE(18)),
    rawLen: buf.readUInt32LE(26),
    etag: buf.subarray(30, 30 + ETAG_BYTES).toString('hex'),
    body: buf.subarray(HEADER),
  };
}

/**
 * L'etag e' un digest del contenuto NON COMPRESSO.
 *
 * Sul compresso cambierebbe al cambiare della qualita': un payload per
 * modalita' promosso da q5 a q11 sembrerebbe un contenuto diverso pur essendo
 * lo stesso, e ogni client in polling riscaricherebbe tutto per niente.
 */
function etagOf(raw: Buffer): string {
  return createHash('sha256').update(raw).digest().subarray(0, ETAG_BYTES).toString('hex');
}

export type CacheMetrics = {
  hits: number;
  stale: number;
  misses: number;
  singleflightJoined: number;
  redisUnavailable: number;
  buildFailures: number;
  /**
   * Massimo di compressioni CONCORRENTI osservato. Deve valere 1 per sempre.
   *
   * Senza questo contatore la sequenzialita' del §7.5 sarebbe una regola
   * scritta in un commento: vera finche' qualcuno non la rompe, e rotta senza
   * sintomi visibili — perche' il sintomo e' un login piu' lento, non un
   * errore. Con il contatore e' un fatto misurabile, esposto accanto a
   * `metamc_argon2_peak` che risponde alla stessa domanda per gli hash.
   */
  compressPeak: number;
};

export type BuildStages = { query: number; serialize: number; compress: number };

export type StatsCacheOptions = {
  redis: Redis;
  /**
   * Vero quando conviene rimandare. Il giro di warm lo consulta prima di ogni
   * compressione: un grafico non puo' far rallentare un login.
   */
  pressure?: () => boolean;
};

export class StatsCache implements CacheService {
  readonly #redis: Redis;
  readonly #pressure: () => boolean;

  /** Una costruzione in volo per chiave: chi arriva dopo si attacca. */
  readonly #flights = new Map<string, Promise<Envelope>>();

  /**
   * UNA voce per chiave. NON e' un L1 di latenza: e' il degrado se Redis cade.
   * Il nome lo dice apposta, cosi' nessuno lo «ottimizza» facendolo crescere.
   */
  readonly #lastGood = new Map<string, Envelope>();

  /** La coda delle compressioni: al piu' un thread Brotli in ogni istante. */
  #compressChain: Promise<unknown> = Promise.resolve();

  readonly #m: CacheMetrics = {
    hits: 0,
    stale: 0,
    misses: 0,
    singleflightJoined: 0,
    redisUnavailable: 0,
    buildFailures: 0,
    compressPeak: 0,
  };

  /** Compressioni in corso in questo istante. Non esce: alimenta il picco. */
  #compressing = 0;

  /** Ultimo `build_ms` per chiave e stadio, §7.9. */
  readonly #buildMs = new Map<string, BuildStages>();

  constructor(opts: StatsCacheOptions) {
    this.#redis = opts.redis;
    this.#pressure = opts.pressure ?? (() => false);
  }

  get metrics(): Readonly<CacheMetrics> {
    return this.#m;
  }

  /** Vero quando conviene rimandare: lo consulta il giro di warm. */
  get underPressure(): boolean {
    return this.#pressure();
  }

  /**
   * Eta' in secondi del payload servibile, per chiave.
   *
   * E' LA metrica (§7.9). Con il warm anticipato l'hit rate e' ~100% per
   * costruzione e resta al 100% anche se il worker e' morto e Redis serve lo
   * stesso payload da tre ore: chi allarma sull'hit rate non allarmera' mai.
   */
  ages(now = Date.now()): Array<[string, number]> {
    return [...this.#lastGood.entries()]
      .map(([k, e]) => [k, Math.max(0, Math.round((now - e.builtAt) / 1_000))] as [string, number])
      .sort(([a], [b]) => a.localeCompare(b));
  }

  /** Byte per chiave, grezzi e compressi. Oltre 120 kB grezzi va indagato. */
  sizes(): Array<[string, { raw: number; br: number }]> {
    return [...this.#lastGood.entries()]
      .map(([k, e]) => [k, { raw: e.rawLen, br: e.body.length }] as [string, { raw: number; br: number }])
      .sort(([a], [b]) => a.localeCompare(b));
  }

  buildTimes(): Array<[string, BuildStages]> {
    return [...this.#buildMs.entries()].sort(([a], [b]) => a.localeCompare(b));
  }

  /** Il tempo di query lo conosce solo il costruttore del payload. */
  recordBuild(key: string, stages: Partial<BuildStages>): void {
    const e = this.#buildMs.get(key) ?? { query: 0, serialize: 0, compress: 0 };
    this.#buildMs.set(key, { ...e, ...stages });
  }

  /**
   * Comprime, in coda dietro qualunque altra compressione in corso.
   *
   * `SIZE_HINT` e `LGWIN 24` non sono dettagli: migliorano rapporto E
   * velocita' e costano una riga.
   */
  #compress(raw: Buffer, quality: 5 | 11): Promise<Buffer> {
    const next = this.#compressChain.then(() => {
      this.#compressing += 1;
      this.#m.compressPeak = Math.max(this.#m.compressPeak, this.#compressing);
      return new Promise<Buffer>((resolve, reject) => {
        brotliCompress(
          raw,
          {
            params: {
              [Z.BROTLI_PARAM_QUALITY]: quality,
              [Z.BROTLI_PARAM_LGWIN]: 24,
              [Z.BROTLI_PARAM_SIZE_HINT]: raw.length,
            },
          },
          (err, out) => {
            this.#compressing -= 1;
            if (err) reject(err);
            else resolve(out);
          },
        );
      });
    });
    // La catena non deve mai restare rifiutata: erediterebbero il rifiuto
    // tutte le compressioni successive, e la cache smetterebbe di funzionare
    // per sempre a causa di un singolo errore.
    this.#compressChain = next.catch(() => undefined);
    return next;
  }

  async #seal(key: string, raw: Buffer, ttl: Ttl, quality: 5 | 11): Promise<Envelope> {
    const t0 = Date.now();
    const body = await this.#compress(raw, quality);
    this.recordBuild(key, { compress: Date.now() - t0 });

    const now = Date.now();
    const env: Envelope = {
      enc: ENC_BROTLI,
      builtAt: now,
      freshUntil: now + ttl.fresh,
      staleUntil: now + ttl.fresh + ttl.stale,
      rawLen: raw.length,
      etag: etagOf(raw),
      body,
    };
    this.#lastGood.set(key, env);
    try {
      // Buffer, non stringa: `set` con una stringa la ricodifica in UTF-8 e
      // distrugge i byte Brotli senza dire niente.
      await this.#redis.set(key, encode(env), 'PX', ttl.fresh + ttl.stale + 60_000);
    } catch {
      // Il payload vale comunque: sta in `#lastGood` e si serve da li'.
      this.#m.redisUnavailable += 1;
    }
    return env;
  }

  /**
   * Costruisce e scrive. ATTESA e SEQUENZIALE. La chiama solo il worker.
   *
   * PERCHE' NON `getOrSet` NEL GIRO DI WARM. `getOrSet` nel ramo obsoleto fa
   * partire la rivalidazione SENZA attenderla e ritorna subito: un giro che la
   * chiamasse in un ciclo sparerebbe N+1 compressioni concorrenti — esattamente
   * il `Promise.all` che ci si e' vietati — e l'`await` davanti non
   * proteggerebbe nulla.
   */
  async warmEnvelope(
    key: string,
    factory: () => Promise<Buffer>,
    ttl: Ttl,
    quality: 5 | 11,
  ): Promise<Envelope> {
    return this.#seal(key, await factory(), ttl, quality);
  }

  /**
   * Il percorso di LETTURA: singleflight piu' stale-while-revalidate.
   *
   * Il ramo obsoleto ritorna subito i byte vecchi e rifa' in sottofondo. E'
   * l'unico `void` di questo modulo, ed e' voluto: chi legge non deve
   * aspettare una ricostruzione che non ha chiesto.
   */
  async envelope(key: string, factory: () => Promise<Buffer>, ttl: Ttl, quality: 5 | 11): Promise<Envelope> {
    const now = Date.now();
    let env: Envelope | null = null;
    try {
      env = decode(await this.#redis.getBuffer(key));
      // Cio' che Redis ha restituito e' l'ultimo buono che conosciamo: se fra
      // un istante Redis cade, e' questo che continueremo a servire.
      if (env) this.#lastGood.set(key, env);
    } catch {
      this.#m.redisUnavailable += 1;
      env = this.#lastGood.get(key) ?? null;
    }

    if (env && now < env.freshUntil) {
      this.#m.hits += 1;
      return env;
    }
    if (env && now < env.staleUntil) {
      this.#m.stale += 1;
      void this.#fly(key, factory, ttl, quality).catch(() => undefined);
      return env;
    }
    this.#m.misses += 1;
    return this.#fly(key, factory, ttl, quality);
  }

  #fly(key: string, factory: () => Promise<Buffer>, ttl: Ttl, quality: 5 | 11): Promise<Envelope> {
    const running = this.#flights.get(key);
    if (running) {
      // E' anche il punto in cui prendere un lock distribuito, se un giorno le
      // istanze diventassero due. Non prima: un lock che nessuno esercita e'
      // codice che nessuno verifica.
      this.#m.singleflightJoined += 1;
      return running;
    }
    const flight = (async () => {
      try {
        return await this.#seal(key, await factory(), ttl, quality);
      } catch (err) {
        this.#m.buildFailures += 1;
        // Un build fallito lascia in piedi la chiave vecchia: servire un
        // payload vecchio e' meno grave che servirne uno rotto.
        const fallback = this.#lastGood.get(key);
        if (fallback) return fallback;
        throw err;
      } finally {
        this.#flights.delete(key);
      }
    })();
    this.#flights.set(key, flight);
    return flight;
  }

  // -------------------------------------------------------------------------
  // `CacheService` del §16.4. Il percorso generico passa dallo stesso
  // involucro: e' l'interfaccia che la fase 1 aveva scritto per questo.
  // -------------------------------------------------------------------------

  async getOrSet<T>(key: string, factory: () => Promise<T>, options?: GetOrSetOptions): Promise<T> {
    const env = await this.envelope(
      key,
      async () => Buffer.from(JSON.stringify(await factory())),
      ttlOf(options),
      5,
    );
    return JSON.parse(await inflate(env)) as T;
  }

  async warm(key: string, factory: () => Promise<unknown>, options?: GetOrSetOptions): Promise<void> {
    await this.warmEnvelope(key, async () => Buffer.from(JSON.stringify(await factory())), ttlOf(options), 5);
  }

  async invalidate(key: string): Promise<void> {
    this.#lastGood.delete(key);
    this.#buildMs.delete(key);
    try {
      await this.#redis.del(key);
    } catch {
      this.#m.redisUnavailable += 1;
    }
  }

  /**
   * Per PREFISSO, con SCAN.
   *
   * L'istanza di cache contiene un centinaio di chiavi: uno SCAN completo e'
   * un costo che si puo' pagare, e `KEYS` su un'istanza condivisa con le
   * sessioni no.
   */
  async invalidateTag(tag: string): Promise<void> {
    for (const k of [...this.#lastGood.keys()]) {
      if (k.startsWith(tag)) {
        this.#lastGood.delete(k);
        this.#buildMs.delete(k);
      }
    }
    try {
      let cursor = '0';
      do {
        const [next, keys] = await this.#redis.scan(cursor, 'MATCH', `${tag}*`, 'COUNT', 200);
        cursor = next;
        if (keys.length > 0) await this.#redis.del(...keys);
      } while (cursor !== '0');
    } catch {
      this.#m.redisUnavailable += 1;
    }
  }

  async stats(): Promise<CacheStats> {
    return { hits: this.#m.hits, misses: this.#m.misses, entries: this.#lastGood.size };
  }
}

function ttlOf(options?: GetOrSetOptions): Ttl {
  const fresh = (options?.ttl ?? 60) * 1_000;
  return { fresh, stale: fresh };
}

/** Ridata' il JSON da un involucro, per chi vuole l'oggetto e non i byte. */
export function inflate(env: Envelope): Promise<string> {
  if (env.enc === ENC_RAW) return Promise.resolve(env.body.toString('utf8'));
  return new Promise((resolve, reject) => {
    brotliDecompress(env.body, (err, out) => (err ? reject(err) : resolve(out.toString('utf8'))));
  });
}
