// Il giro di warm e le sue cadenze. Fase 2, §7.3 e §7.4 — passo 5.
//
// PERCHE' SI SCALDA INVECE DI ASPETTARE LA PRIMA RICHIESTA. Un payload da 90
// giorni costa una scansione su `rollup_1h`: pagarla sulla richiesta di
// qualcuno significa che la prima persona ad aprire quella schermata ogni
// mattina aspetta mezzo secondo, sempre lei. Costruirlo prima costa lo stesso
// lavoro fatto quando non c'e' nessuno in attesa.
//
// COSA NON SI SCALDA. Le modalita' scaldate sono quelle che QUALCUNO HA
// GUARDATO nell'ultima ora, non «le tre con piu' giocatori»: quella e' una
// supposizione, e sbaglia esattamente quando l'admin sta indagando su una
// modalita' marginale — cioe' nell'unico momento in cui la schermata serve
// davvero. Cio' che non entra nel budget del giro viene servito pigramente al
// primo accesso e contato in `warm_deferred`.
//
// IL TETTO DEL GIRO E' TEMPORALE, non un numero di chiavi. N e' ignoto (oggi
// ventidue server, domani quanti?), e un tetto per conteggio e' un tetto
// tarato su un'ipotesi.

import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { Database } from '#src/db/pool.ts';
import { type JobRegistry, type RunningJob, startJob } from '#src/jobs/scheduler.ts';
import type { StatsCache, Ttl } from './cache.ts';
import { assertPayload, type ModePayload, type OverviewPayload, RANGES, type Range } from './contract.ts';
import { buildAll } from './read.ts';

const S = 1_000;
const M = 60 * S;

/**
 * `v2` sta NELLA CHIAVE, non solo nel corpo.
 *
 * Un cambio di contratto e' un namespace nuovo, e le chiavi vecchie scadono da
 * sole. Una cache non si migra: migrare significherebbe scrivere codice che
 * legge un formato che nessuno produce piu', e tenerlo per sempre.
 */
export const K = {
  ov: (r: Range) => `stats:v2:ov:${r}`,
  md: (m: string, r: Range) => `stats:v2:md:${m}:${r}`,
  /** UNO PER RANGE, non globale: vedi `hotModes`. */
  hot: (r: Range) => `stats:v2:hot:${r}`,
};

export type Cadence = {
  /** Ogni quanto il worker ricostruisce. */
  warm: number;
  /** Validita' piena. Sempre 1,5 volte `warm`, vedi sotto. */
  fresh: number;
  /** Finestra ULTERIORE in cui il payload si serve mentre si rifa'. */
  stale: number;
};

/**
 * `fresh = 1,5 x warm`, e la mezza volta non e' arbitraria: se fossero uguali
 * ogni giro arriverebbe un capello in ritardo, ogni richiesta troverebbe una
 * chiave tecnicamente obsoleta, e la rivalidazione partirebbe all'infinito.
 *
 * Il 24h sta a sessanta secondi e non a trenta perche' il numero istantaneo
 * non passa piu' dal payload (viaggia come intestazione): al corpo basta
 * seguire il bucket da cinque minuti. Nell'1y si muove solo l'ultimo punto:
 * ricostruirlo ogni mezzo minuto vorrebbe dire ricalcolare 364 numeri identici
 * per aggiornarne uno.
 */
export const CADENCE: Record<Range, Cadence> = {
  '24h': { warm: 60 * S, fresh: 90 * S, stale: 10 * M },
  '7d': { warm: 5 * M, fresh: 7.5 * M, stale: 30 * M },
  '30d': { warm: 15 * M, fresh: 22.5 * M, stale: 120 * M },
  '90d': { warm: 15 * M, fresh: 22.5 * M, stale: 120 * M },
  '1y': { warm: 60 * M, fresh: 90 * M, stale: 360 * M },
};

export function ttlOf(range: Range): Ttl {
  const c = CADENCE[range];
  return { fresh: c.fresh, stale: c.stale };
}

/** Quanto puo' durare la parte «modalita'» di un giro prima di rimandare. */
export const WARM_BUDGET_MS = 250;

/** Quante modalita' al massimo entrano in un giro. */
const HOT_LIMIT = 20;

/** Da quanto tempo una modalita' guardata resta «calda». */
const HOT_WINDOW_MS = 3_600_000;

/**
 * Le modalita' guardate di recente, per questo range.
 *
 * L'HOT-SET E' UNO PER RANGE, e non e' un dettaglio. Con un solo ZSET globale
 * e punteggio `Date.now()`, una dashboard aperta che rinfresca il 24h ogni
 * minuto occuperebbe stabilmente i primi venti posti, e i payload per
 * modalita' dei range lunghi non verrebbero scaldati mai: il meccanismo che
 * deve evitare l'esplosione combinatoria smetterebbe di funzionare per quattro
 * range su cinque.
 */
export async function hotModes(redis: Redis, range: Range): Promise<string[]> {
  try {
    await redis.zremrangebyscore(K.hot(range), '-inf', Date.now() - HOT_WINDOW_MS);
    return await redis.zrevrange(K.hot(range), 0, HOT_LIMIT - 1);
  } catch {
    // Un hot-set irraggiungibile significa scaldare solo le panoramiche. E'
    // un degrado, non un guasto: i payload per modalita' si costruiscono al
    // primo accesso.
    return [];
  }
}

/** Segna che qualcuno ha guardato questa modalita'. Lo chiama l'handler. */
export function markHot(redis: Redis, range: Range, mode: string): void {
  void redis.zadd(K.hot(range), Date.now(), mode).catch(() => undefined);
}

function serialize(payload: OverviewPayload | ModePayload): Buffer {
  return Buffer.from(JSON.stringify(payload), 'utf8');
}

export type WarmDeps = {
  statsDb: Database;
  cache: StatsCache;
  /** Il Redis della cache: ci vivono anche gli hot-set. */
  redis: Redis;
  logger: Logger;
};

export type WarmResult = {
  payloads: number;
  deferred: number;
  rows: number;
  ms: number;
};

/**
 * Un giro per un range: una scansione, N+1 payload, tutti in sequenza.
 *
 * `warmEnvelope` e non `getOrSet`: quest'ultimo, nel ramo obsoleto, fa partire
 * la ricostruzione senza attenderla: un ciclo che lo chiamasse sparerebbe N+1
 * compressioni concorrenti, che e' esattamente il `Promise.all` da cui questo
 * disegno si tiene alla larga.
 */
export async function warmRange(deps: WarmDeps, range: Range): Promise<WarmResult> {
  const t0 = Date.now();
  const built = await buildAll(deps.statsDb, range);
  deps.cache.recordBuild(K.ov(range), { query: built.queryMs });

  // Le invarianti si verificano PRIMA che i byte entrino in cache. Un payload
  // rotto messo in cache resta rotto per tutta la finestra di validita', e il
  // difetto tipico — una serie disallineata di un elemento — non ha sintomi:
  // il grafico disegna numeri corretti sotto l'etichetta sbagliata.
  assertPayload(built.overview);

  const ttl = ttlOf(range);
  // q11 sulle panoramiche: si costruiscono una volta e si servono molte
  // (~60 letture per build), quindi i 34 ms di compressione si ammortizzano.
  await deps.cache.warmEnvelope(K.ov(range), async () => serialize(built.overview), ttl, 11);

  let payloads = 1;
  let deferred = 0;
  for (const mode of await hotModes(deps.redis, range)) {
    const payload = built.perMode.get(mode);
    if (!payload) continue;
    if (Date.now() - t0 > WARM_BUDGET_MS || deps.cache.underPressure) {
      deferred += 1;
      continue;
    }
    assertPayload(payload);
    // q5 sui payload per modalita': due o tre letture prima del rebuild, e q11
    // costerebbe 26 volte tanto per zero byte in meno rispetto a q9.
    await deps.cache.warmEnvelope(K.md(mode, range), async () => serialize(payload), ttl, 5);
    payloads += 1;
  }

  return { payloads, deferred, rows: built.overview.online.t.length, ms: Date.now() - t0 };
}

export type StatsWorker = { stop: () => void };

export function startStatsWorker(deps: WarmDeps, registry: JobRegistry): StatsWorker {
  const jobs: RunningJob[] = [];
  for (const range of RANGES) {
    const cadence = CADENCE[range];
    jobs.push(
      startJob(
        {
          name: `stats-warm-${range}`,
          intervalMs: cadence.warm,
          retryMs: Math.min(cadence.warm, 30 * S),
          run: async () => ({ ...(await warmRange(deps, range)) }),
          successMessage: `payload ${range} ricostruito`,
          failureMessage: `il pannello statistiche servira\` numeri vecchi per il range ${range}`,
        },
        deps.logger,
        registry,
      ),
    );
  }
  return {
    stop: () => {
      for (const j of jobs) j.stop();
    },
  };
}

/**
 * Il primo riempimento, DOPO `listen()` e mai prima.
 *
 * `/health/ready` non deve mai dipendere dalle statistiche, o un rollup lento
 * terrebbe il pannello fuori dal bilanciatore per una schermata secondaria.
 *
 * SEQUENZIALE, e in quest'ordine, con l'1y per ultimo. `statsPool` ha otto
 * connessioni: lanciarne cinque insieme su una page cache fredda trasforma un
 * warm da due secondi in uno da venti e ruba CPU al percorso di login. Piu'
 * lento in totale, piu' veloce per la schermata che qualcuno aprira' davvero
 * per prima.
 */
export async function warmOnBoot(deps: WarmDeps): Promise<void> {
  for (const range of RANGES) {
    try {
      await warmRange(deps, range);
    } catch (err) {
      deps.logger.warn(
        { range, err },
        'warm iniziale fallito: la prima richiesta di questo range paghera` l`aggregazione',
      );
    }
  }
}
