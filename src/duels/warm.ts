// Il riscaldamento dei payload duels, e la linea fra il giorno vivo e quelli
// chiusi.
//
// TRE LIVELLI DI CACHE, e questo file e' il secondo e il terzo.
//
//   1. La PRE-AGGREGAZIONE: le schermate non toccano mai una riga di partita.
//      Sta nell'ETL e nello schema, non qui.
//   2. Il CONFINE fra i giorni chiusi e il giorno vivo. Le finestre di 7g,
//      30g, 90g e 1a finiscono a mezzanotte di oggi: una partita giocata
//      adesso cade fuori da tutte e quattro, quindi quei payload sono identici
//      per ventiquattro ore. Solo il 24h si muove.
//   3. Il payload GIA' PRONTO su Valkey, che e' cio' che questo file scrive.
//
// LE DUE SVEGLIE NON SI SOMMANO, ed e' la regola che governa il disegno. Non
// esiste un timer «duels-warm»: la fetta viva la ricostruisce LO STESSO CICLO
// che ingerisce, subito dopo aver scritto le partite nuove, e i quattro
// periodi chiusi salgono sul giro di warm che esisteva gia' per le
// statistiche. Un terzo timer avrebbe voluto dire tre cadenze che si
// incrociano e un payload che a volte e' piu' vecchio dell'ultima ingestione
// senza che nessuno sappia dire di quanto.
//
// SI RICOSTRUISCE SOLO SE QUALCOSA E' CAMBIATO, e non e' avarizia: `builtAt`
// entra nel payload, quindi rifare un payload identico ne cambia l'ETag, e un
// ETag nuovo significa che ogni schermata aperta riscarica tutto invece di
// ricevere un 304. Ricostruire per niente costa piu' banda che CPU.

import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { StatsCache } from '#src/stats/cache.ts';
import { hotOf, markHotAt, ttlOf } from '#src/stats/warm.ts';
import { DK, DUELS_LIVE_RANGE, DUELS_SLOW_RANGES, duelsQuality, type Range } from './contract.ts';
import type { DuelsProvider } from './provider.ts';

/** Quanto puo' durare la parte «modalita' calde» di un giro. */
export const DUELS_WARM_BUDGET_MS = 250;

export type DuelsWarmDeps = {
  provider: DuelsProvider;
  cache: StatsCache;
  /** Il Redis della cache: ci vivono anche gli hot-set. */
  redis: Redis;
  logger: Logger;
  /** Il tetto della parte «modalita' calde», se diverso dal predefinito. */
  budgetMs?: number;
};

export type DuelsWarmResult = { payloads: number; deferred: number; ms: number };

/** Le modalita' guardate di recente su questo periodo, come identificativi. */
export async function hotDuelsModes(redis: Redis, range: Range): Promise<number[]> {
  const raw = await hotOf(redis, DK.hot(range));
  return raw.map((v) => Number(v)).filter((v) => Number.isInteger(v));
}

/** Segna che qualcuno ha guardato le valutazioni di questa modalita'. */
export function markDuelsHot(redis: Redis, range: Range, mode: number): void {
  markHotAt(redis, DK.hot(range), String(mode));
}

function bytes(payload: unknown): Buffer {
  return Buffer.from(JSON.stringify(payload), 'utf8');
}

/**
 * Un periodo, con la sua qualita' di compressione e le sue modalita' calde.
 *
 * ERANO DUE FUNZIONI GEMELLE — `warmDuelsLive` e `warmDuelsClosed` — quaranta
 * righe identiche l'una all'altra, e differivano solo per la qualita' di
 * compressione. Differivano male: quella dei periodi chiusi prometteva q11 nel
 * commento e poi scriveva le modalita' calde a q5, cioe' contraddiceva se
 * stessa. Adesso la qualita' la decide il periodo, in un posto solo.
 */
export async function warmDuelsRange(deps: DuelsWarmDeps, range: Range): Promise<DuelsWarmResult> {
  const t0 = Date.now();
  const ttl = ttlOf();
  const quality = duelsQuality(range);
  const now = new Date();

  await deps.cache.warmEnvelope(
    DK.tr(range),
    async () => bytes(await deps.provider.trends(range, now)),
    ttl,
    quality,
  );
  await deps.cache.warmEnvelope(
    DK.rt(null, range),
    async () => bytes(await deps.provider.ratings(range, null, now)),
    ttl,
    quality,
  );

  // L'HOT-SET SI LEGGE PRIMA di costruire: chiederlo dopo vorrebbe dire
  // costruire il payload di ogni modalita' per poi scoprire quali servivano.
  const hot = await hotDuelsModes(deps.redis, range);
  const budget = deps.budgetMs ?? DUELS_WARM_BUDGET_MS;
  const modesFrom = Date.now();

  let payloads = 2;
  let deferred = 0;
  for (const mode of hot) {
    if (Date.now() - modesFrom >= budget || deps.cache.underPressure) {
      // Rimandare significa che la prossima richiesta di quella modalita'
      // paghera' l'aggregazione. E' un costo su una richiesta, contro il
      // rischio di far scivolare l'intero ciclo da trenta secondi.
      deferred += 1;
      continue;
    }
    await deps.cache.warmEnvelope(
      DK.rt(mode, range),
      async () => bytes(await deps.provider.ratings(range, mode, now)),
      ttl,
      quality,
    );
    payloads += 1;
  }

  return { payloads, deferred, ms: Date.now() - t0 };
}

/**
 * La fetta viva: il 24h, che e' l'unico periodo la cui finestra si sposta.
 *
 * La chiama il ciclo di ingestione, subito dopo aver scritto. E' li' che si
 * vede la cadenza da trenta secondi: se questa ricostruzione stesse su un
 * timer suo, il payload sarebbe pronto in un momento qualunque fra
 * l'ingestione e mezzo minuto dopo, e nessuno saprebbe dire quale.
 */
export function warmDuelsLive(deps: DuelsWarmDeps): Promise<DuelsWarmResult> {
  return warmDuelsRange(deps, DUELS_LIVE_RANGE);
}

/**
 * Tutti i periodi chiusi, in sequenza. Lo chiama il giro di warm esistente.
 *
 * Un periodo che non si ricostruisce non ne ferma altri tre: il 90g che va in
 * timeout non deve far invecchiare il 7g.
 */
export async function warmDuelsAllClosed(deps: DuelsWarmDeps): Promise<number> {
  let payloads = 0;
  for (const range of DUELS_SLOW_RANGES) {
    try {
      payloads += (await warmDuelsRange(deps, range)).payloads;
    } catch (err) {
      deps.logger.warn(
        { err, range },
        'periodo duels non ricostruito: la prima richiesta paghera` l`aggregazione',
      );
    }
  }
  return payloads;
}
