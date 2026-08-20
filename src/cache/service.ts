// §16.4 — l'interfaccia `CacheService`.
//
// SCRITTA IN FASE 1, IMPLEMENTATA IN FASE 2. In fase 1 non c'era nulla da
// cachare — un solo processo, e gli unici dati caldi (sessione e authz) gia'
// in Redis con una semantica loro — ma l'interfaccia costava cinque minuti e
// prometteva che la cache vera si sarebbe scritta dietro di essa senza
// toccare i chiamanti. `StatsCache` (src/stats/cache.ts) la implementa, e la
// promessa e' stata mantenuta: nessun chiamante e' cambiato.
//
// L'implementazione passthrough che stava qui e' stata tolta quando quella
// vera e' arrivata: nessuno la costruiva piu', e in questo repository il
// codice che nessuno esercita e' codice che nessuno verifica.

export type CacheStats = {
  hits: number;
  misses: number;
  entries: number;
};

export type GetOrSetOptions = {
  /** Secondi. `StatsCache` lo usa come finestra fresca E come finestra obsoleta. */
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
