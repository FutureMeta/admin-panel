// Le partizioni mensili del registro, garantite dall'applicazione. §10, §17
//
// PERCHE' NON UN CRON. Le partizioni vanno create in anticipo; se finiscono,
// l'INSERT di audit fallisce e — stando nella stessa transazione delle
// modifiche di stato — porta giu' anche quelle. Il pannello si blocca in
// scrittura, tutto insieme.
//
// Un cron esterno regge finche' qualcuno lo configura e finche' nessuno
// ricostruisce la macchina dimenticandosene. E' una dipendenza che vive fuori
// dal repository, che non si vede dal codice e che si scopre rotta il giorno
// del guasto — cioe' la forma peggiore di dipendenza. Qui il lavoro vive
// accanto alla cosa che protegge: se gira il pannello, girano le partizioni.
//
// Il prezzo di questa scelta va detto: se il processo e' fermo, il lavoro non
// gira. Non e' un problema, perche' se il processo e' fermo non ci sono
// nemmeno scritture da registrare, e al riavvio la prima cosa che fa e'
// recuperare.
//
// L'applicazione NON ha privilegi DDL: chiama `audit.create_month_partition`,
// che dalla migration 009 e' `SECURITY DEFINER` con un orizzonte sui mesi
// accettati. Continua a non poter cancellare, modificare o staccare niente.

import { sql } from 'kysely';
import type { Logger } from 'pino';
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

/** Ogni quanto ricontrollare, a regime. */
const INTERVAL_MS = 24 * 60 * 60 * 1_000;

/** Quanto aspettare dopo un fallimento: molto meno, perche' e' una cosa che va risolta. */
const RETRY_MS = 60 * 60 * 1_000;

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

export type PartitionKeeper = { stop: () => void };

/**
 * Avvia il controllo periodico. Restituisce come fermarlo, perche' un timer
 * che sopravvive alla chiusura tiene vivo il processo e fa fallire lo
 * spegnimento pulito del §13.
 *
 * NON lancia e non blocca l'avvio: un guasto qui non deve impedire al
 * pannello di rispondere alle sonde e servire le letture. Viene registrato a
 * livello `error` e riprovato prima del solito.
 */
export function startPartitionKeeper(db: Database, logger: Logger): PartitionKeeper {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const run = async (): Promise<void> => {
    if (stopped) return;
    let delay = INTERVAL_MS;
    try {
      const names = await ensurePartitions(db);
      logger.info({ partizioni: names.length }, 'partizioni audit verificate');
    } catch (err) {
      delay = RETRY_MS;
      logger.error(
        { err },
        'partizioni audit NON verificate: se scadono, ogni scrittura del pannello fallisce',
      );
    }
    if (stopped) return;
    // `unref` perche' questo timer non e' un motivo per tenere in piedi il
    // processo: se non resta altro da fare, Node deve poter uscire.
    timer = setTimeout(() => void run(), delay);
    timer.unref();
  };

  void run();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
