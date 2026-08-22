// Un MySQL finto per i duels, e ce n'e' UNO SOLO apposta.
//
// `DuelsMysql` e' una funzione sola — `rows(sql, params)` — quindi sostituirla
// costa niente, e in cambio si esercita per intero l'SQL che conta: quello su
// PostgreSQL. Puntare i test al MySQL di produzione sarebbe vietato e inutile.
//
// Il finto sta qui e non dentro un file di test perche' lo usano
// l'ingestione e il backfill, e due copie divergerebbero: quella del backfill
// imparerebbe a rispondere a `COUNT(*)` e quella dell'ingestione no, e il
// giorno in cui una query cambia forma se ne accorgerebbe un test solo.

import type { DuelsMysql } from '#src/duels/mysql.ts';

type Keyed = { id: number | string; created_at?: string };

export type FakeDuelsSource = {
  modes?: unknown[];
  maps?: unknown[];
  matches?: unknown[];
  ratings?: unknown[];
};

/** La tabella nominata dalla prima FROM della query. */
function tableOf(query: string): string {
  return /FROM\s+([a-z_]+)/i.exec(query)?.[1] ?? '';
}

export function fakeDuelsMysql(source: FakeDuelsSource): DuelsMysql {
  const of = (query: string): Keyed[] => {
    switch (tableOf(query)) {
      case 'duels_mode':
        return (source.modes ?? []) as Keyed[];
      case 'duels_map':
        return (source.maps ?? []) as Keyed[];
      case 'duels_match_ratings':
        return (source.ratings ?? []) as Keyed[];
      default:
        return (source.matches ?? []) as Keyed[];
    }
  };

  return {
    rows: async <T>(query: string, params: unknown[] = []): Promise<T[]> => {
      const all = of(query);

      // L'intervallo di date della sorgente, per la verifica delle partizioni.
      if (query.includes('MIN(created_at)')) {
        const dates = all.map((r) => r.created_at ?? '').filter((d) => d !== '');
        if (dates.length === 0) return [{ first: null, last: null }] as T[];
        return [{ first: dates.slice().sort()[0], last: dates.slice().sort().at(-1) }] as T[];
      }

      // Il conteggio della verifica finale. Torna come STRINGA, come lo
      // restituisce mysql2 con `bigNumberStrings`: un COUNT(*) e' un BIGINT.
      if (query.includes('COUNT(*)')) {
        const upTo = BigInt(String(params[0] ?? '0'));
        const n = all.filter((r) => BigInt(String(r.id)) <= upTo).length;
        return [{ n: String(n) }] as T[];
      }

      // I cataloghi: interi, senza watermark.
      if (query.includes('duels_mode') || query.includes('duels_map')) return all as T[];

      // Le due query a lotti portano `id > ?` e `LIMIT ?`: il finto rispetta
      // entrambi, o il test del budget non proverebbe niente.
      const after = BigInt(String(params[0] ?? '0'));
      const limit = Number(params[1] ?? 10_000);
      return all
        .filter((r) => BigInt(String(r.id)) > after)
        .sort((a, b) => Number(a.id) - Number(b.id))
        .slice(0, limit) as T[];
    },
    close: async () => undefined,
  };
}
