// Le partizioni mensili del registro, garantite dall'applicazione. §10, §17
//
// Se le partizioni finiscono, l'INSERT di audit fallisce e — stando nella
// stessa transazione delle modifiche di stato — porta giu' anche quelle: il
// pannello si blocca in scrittura, tutto insieme.
//
// La cadenza e il perche' non ci sia un cron stanno in `src/jobs/keeper.ts`,
// insieme agli altri tre lavori periodici. Qui c'e' solo il lavoro.
//
// L'applicazione NON ha privilegi DDL: chiama `audit.create_month_partition`,
// che dalla migration 009 e' `SECURITY DEFINER` con un orizzonte sui mesi
// accettati. Continua a non poter cancellare, modificare o staccare niente.

import { sql } from 'kysely';
import type { Database } from '#src/db/pool.ts';

/**
 * Quanti mesi avanti tenere pronti.
 *
 * Dodici sono molto piu' del necessario: basterebbe il mese prossimo. Il
 * margine serve a coprire il caso in cui il pannello resti spento a lungo —
 * un'installazione ferma per mesi e riaccesa non deve trovarsi senza spazio
 * dove scrivere la prima riga.
 */
const MONTHS_AHEAD = 12;

/**
 * Garantisce le partizioni dei prossimi mesi. Idempotente: una partizione che
 * esiste gia' non viene toccata, e la funzione restituisce il suo nome.
 */
export async function ensurePartitions(db: Database): Promise<string[]> {
  const now = new Date();
  const names: string[] = [];

  for (let m = 0; m <= MONTHS_AHEAD; m += 1) {
    const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + m, 1));
    const month = target.toISOString().slice(0, 10);
    const res = await sql<{ create_month_partition: string }>`
      SELECT audit.create_month_partition(${month}::date)
    `.execute(db);
    const name = res.rows[0]?.create_month_partition;
    if (name) names.push(name);
  }

  return names;
}
