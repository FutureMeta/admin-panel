// §16.4 — interfaccia `CacheService`, con la SOLA implementazione passthrough.
//
// In fase 1 non c'e' nulla da cachare: un solo processo, e gli unici dati
// caldi (sessione e authz) stanno gia' in Redis con una semantica loro. Il §4
// e' esplicito: nessuna libreria di cache, e quando servira' saranno ~120
// righe su lru-cache + ioredis, non una dipendenza dormiente.
//
// L'interfaccia esiste ora perche' costa cinque minuti e perche' la cache di
// fase 2 (singleflight + SWR davanti ai payload statistici) si scrive dietro
// di essa senza toccare i chiamanti.

export type CacheStats = {
  hits: number;
  misses: number;
  entries: number;
};

export type GetOrSetOptions = {
  /** Secondi. Ignorato dall'implementazione passthrough. */
  ttl?: number;
  /** Etichette per l'invalidazione di gruppo. */
  tags?: readonly string[];
};

export type CacheService = {
  getOrSet<T>(key: string, factory: () => Promise<T>, options?: GetOrSetOptions): Promise<T>;
  invalidate(key: string): Promise<void>;
  invalidateTag(tag: string): Promise<void>;
  warm(key: string, factory: () => Promise<unknown>, options?: GetOrSetOptions): Promise<void>;
  stats(): Promise<CacheStats>;
};

/**
 * Non memorizza nulla: esegue sempre la factory.
 *
 * Non e' un segnaposto vuoto — e' la semantica corretta per la fase 1. Un
 * chiamante scritto contro questa implementazione e' automaticamente corretto
 * anche quando dietro ci sara' una cache vera, perche' non puo' aver assunto
 * che un valore resti fresco.
 */
export class PassthroughCache implements CacheService {
  #calls = 0;

  async getOrSet<T>(_key: string, factory: () => Promise<T>): Promise<T> {
    this.#calls += 1;
    return factory();
  }

  async invalidate(_key: string): Promise<void> {
    // Niente da invalidare: e' corretto, non incompleto.
  }

  async invalidateTag(_tag: string): Promise<void> {
    // Idem.
  }

  async warm(_key: string, _factory: () => Promise<unknown>): Promise<void> {
    // Scaldare una cache che non esiste sarebbe solo lavoro sprecato.
  }

  async stats(): Promise<CacheStats> {
    return { hits: 0, misses: this.#calls, entries: 0 };
  }
}
