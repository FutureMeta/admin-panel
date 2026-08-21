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
import { type JobRegistry, startJob } from '#src/jobs/scheduler.ts';
import type { StatsCache, Ttl } from './cache.ts';
import { assertPayload, type ModePayload, type OverviewPayload, RANGES, type Range } from './contract.ts';
import { buildAll } from './read.ts';

const S = 1_000;
const M = 60 * S;

const ROME_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Rome',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Il giorno civile di Roma, come `2026-08-21`.
 *
 * ENTRA NELLA CHIAVE DI CACHE, e non e' un vezzo. La freschezza di un payload
 * e' «quanto tempo e' passato da quando l'ho costruito», e non sa niente del
 * fatto che a mezzanotte il giorno civile cambia: l'asse dei giorni del
 * grafico degli unici finisce a IERI, e resta servito da una chiave
 * perfettamente valida finche' il giro di warm non ripassa — fino a un'ora
 * intera sul range 1y. Il grafico sembra fermo, e non c'e' niente che dica
 * perche'.
 *
 * Con il giorno nella chiave, a mezzanotte tutti i range mancano e si
 * ricostruiscono. Le chiavi vecchie scadono da sole.
 */
export function civilDay(now: Date = new Date()): string {
  return ROME_DAY.format(now);
}

/**
 * `v2` sta NELLA CHIAVE, non solo nel corpo.
 *
 * Un cambio di contratto e' un namespace nuovo, e le chiavi vecchie scadono da
 * sole. Una cache non si migra: migrare significherebbe scrivere codice che
 * legge un formato che nessuno produce piu', e tenerlo per sempre.
 *
 * Anche il GIORNO CIVILE sta nella chiave, per la ragione scritta sopra
 * `civilDay`.
 */
export const K = {
  ov: (r: Range, day: string = civilDay()) => `stats:v2:ov:${day}:${r}`,
  md: (m: string, r: Range, day: string = civilDay()) => `stats:v2:md:${day}:${m}:${r}`,
  /** UNO PER RANGE, non globale: vedi `hotModes`. Il giorno qui non serve:
   *  cio' che qualcuno ha guardato non scade a mezzanotte. */
  hot: (r: Range) => `stats:v2:hot:${r}`,
};

/**
 * UNA CADENZA SOLA, per tutti e cinque i range.
 *
 * Il §7.3 ne prevedeva cinque diverse — sessanta secondi per il 24h,
 * un'ora per l'1y — e la ragione scritta era che «nel payload 1y solo
 * l'ultimo punto si muove». Era vero finche' i range lunghi erano viste di
 * solo storico. Non lo e' piu': il selettore in alto governa OGNI riquadro
 * della panoramica, quindi sull1y si muovono anche la heatmap, il picco del
 * periodo, gli unici e la provenienza, e tutti includono il giorno in corso.
 *
 * Cadenze diverse producevano una domanda a cui il pannello non sapeva
 * rispondere: lo stesso dato appariva fresco sul 24h e fermo a un quarto
 * d'ora prima sul 90g, e per accorgersi che non erano in disaccordo
 * bisognava sapere a memoria questa tabella. Un selettore di intervallo
 * cambia COSA si guarda, non quanto e' vecchio.
 *
 * Il costo che giustificava lo scaglionamento non c'e' piu': saltando i
 * payload per modalita` quando nessuno li ha chiesti (vedi `buildAll` e il
 * cancello dentro `geoRows`), il giro completo dei cinque range misura
 * **754 ms IN PRODUZIONE**, con diciannove server — 24h 360, 7g 69, 30g 84,
 * 90g 107, 1y 133.
 *
 * IL NUMERO E' MISURATO LI', e la storia vale piu' del numero. Prima diceva
 * «~1,1 s, sotto il 2%», misurato su una macchina di sviluppo con tre server:
 * in produzione erano 7,9 s, cioe' il 12% del tempo, e i giri distavano 68
 * secondi invece di 60 perche' il timer riparte alla fine del giro. Un numero
 * piccolo affermato senza dire dove era stato preso e' peggio di nessun
 * numero: dice a chi legge che la cosa era stata verificata.
 *
 * Gli 8 secondi erano UNA query: la meta' «per modalita'» di `geoRows`,
 * calcolata a ogni giro e buttata via perche' nessuno aveva aperto il
 * dettaglio di una modalita'. Chiuso quel cancello, i tre range lunghi sono
 * passati da ~2500 ms a meno di 140.
 *
 * `fresh` e' 90 s e il periodo vero e' 61: il margine e' tornato ampio. La
 * riga di log porta `ms` per range e il nome della query piu' cara del range
 * peggiore — e' li' che si vedra' il prossimo che cresce, prima che diventi
 * un'indagine.
 */
export const WARM_MS = 60 * S;

/**
 * `fresh = 1,5 x warm`, e la mezza volta non e' arbitraria: se fossero
 * uguali ogni giro arriverebbe un capello in ritardo, ogni richiesta
 * troverebbe una chiave tecnicamente obsoleta, e la rivalidazione partirebbe
 * all'infinito. `stale` e' la finestra ULTERIORE in cui il payload si serve
 * mentre si rifa': quanto a lungo si accetta di mostrare numeri vecchi
 * piuttosto che una schermata vuota.
 */
export const TTL: Ttl = { fresh: 90 * S, stale: 10 * M };

export function ttlOf(): Ttl {
  return TTL;
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
  /** Le tre query piu' care di questo giro. Servono quando `ms` sale. */
  slowest: Record<string, number>;
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
  // L'HOT-SET SI LEGGE PRIMA DI COSTRUIRE, non dopo. Chiederlo dopo voleva
  // dire costruire il payload di ogni modalita' per poi scoprire quali
  // servivano, e le query per modalita' sono la parte cara del giro: a
  // hot-set vuoto — cioe' sempre, finche' nessuno apre il dettaglio di una
  // modalita' — erano lavoro interamente buttato.
  const hot = await hotModes(deps.redis, range);
  const built = await buildAll(deps.statsDb, range, undefined, hot);
  deps.cache.recordBuild(K.ov(range), { query: built.queryMs });

  // Le invarianti si verificano PRIMA che i byte entrino in cache. Un payload
  // rotto messo in cache resta rotto per tutta la finestra di validita', e il
  // difetto tipico — una serie disallineata di un elemento — non ha sintomi:
  // il grafico disegna numeri corretti sotto l'etichetta sbagliata.
  assertPayload(built.overview);

  const ttl = ttlOf();
  // q11 sulle panoramiche: si costruiscono una volta e si servono molte
  // (~60 letture per build), quindi i 34 ms di compressione si ammortizzano.
  await deps.cache.warmEnvelope(K.ov(range), async () => serialize(built.overview), ttl, 11);

  let payloads = 1;
  let deferred = 0;
  for (const mode of hot) {
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

  return {
    payloads,
    deferred,
    rows: built.overview.online.t.length,
    ms: Date.now() - t0,
    slowest: built.slowest,
  };
}

export type StatsWorker = { stop: () => void };

/**
 * UN job, cinque range in sequenza — non cinque job.
 *
 * Con la stessa cadenza cinque timer indipendenti scoccherebbero insieme e
 * lancerebbero cinque costruzioni concorrenti: sessantacinque query in volo
 * su un pool da otto, che e` esattamente il `Promise.all` da cui questo
 * disegno si tiene alla larga. In sequenza il picco resta uno.
 */
export function startStatsWorker(deps: WarmDeps, registry: JobRegistry): StatsWorker {
  const job = startJob(
    {
      name: 'stats-warm',
      intervalMs: WARM_MS,
      retryMs: 30 * S,
      // `warmOnBoot` ha appena riempito tutti e cinque i range, in sequenza.
      // Partire subito rifarebbe lo stesso identico lavoro.
      runImmediately: false,
      run: async () => {
        const t0 = Date.now();
        const pronti: Range[] = [];
        const falliti: Range[] = [];
        // IL COSTO PER RANGE, ogni giro. Consolidando i cinque job in uno
        // avevo perso il `ms` che ciascuno stampava, e con esso l'unico modo
        // di sapere quale range sta costando: il giro dura quanto la somma,
        // e una somma non dice mai dove sta il peso. Cinque numeri per riga
        // costano nulla e tolgono un'indagine ogni volta che serviranno.
        const ms: Partial<Record<Range, number>> = {};
        // LA RIPARTIZIONE DEL SOLO RANGE PIU' LENTO. Tredici numeri per
        // cinque range sarebbero sessantacinque per riga, ogni minuto, e una
        // riga che nessuno legge non e' osservabilita': e' rumore che nasconde
        // le righe che contano. Il peggiore basta a sapere dove guardare.
        let worst: { range: Range; ms: number; slowest: Record<string, number> } | null = null;
        let payloads = 0;
        let deferred = 0;
        for (const range of RANGES) {
          try {
            const r = await warmRange(deps, range);
            payloads += r.payloads;
            deferred += r.deferred;
            ms[range] = r.ms;
            if (!worst || r.ms > worst.ms) worst = { range, ms: r.ms, slowest: r.slowest };
            pronti.push(range);
          } catch {
            // UN range rotto non ne ferma altri quattro: il 90g che va in
            // timeout non deve far invecchiare il 24h.
            falliti.push(range);
          }
        }
        // Caduti tutti non e` un giro parziale: e` il database che non
        // risponde, e deve contare come fallimento e riprovare prima.
        if (pronti.length === 0) {
          throw new Error(`nessun range ricostruito: ${falliti.join(', ')}`);
        }
        return {
          pronti,
          falliti,
          payloads,
          deferred,
          ms,
          totaleMs: Date.now() - t0,
          piuLento: worst ? { range: worst.range, query: worst.slowest } : null,
        };
      },
      successMessage: 'payload statistiche ricostruiti',
      failureMessage: 'il pannello statistiche servira` numeri vecchi',
    },
    deps.logger,
    registry,
  );
  return { stop: () => job.stop() };
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
  const t0 = Date.now();
  const done: Range[] = [];
  const failed: Range[] = [];
  // Il costo per range anche qui: l'avvio e' il momento in cui la macchina e'
  // piu' fredda, quindi e' anche la misura piu' pessimista che si abbia.
  const ms: Partial<Record<Range, number>> = {};

  for (const range of RANGES) {
    try {
      const r = await warmRange(deps, range);
      ms[range] = r.ms;
      done.push(range);
    } catch (err) {
      failed.push(range);
      deps.logger.warn(
        { range, err },
        'warm iniziale fallito: la prima richiesta di questo range paghera` l`aggregazione',
      );
    }
  }

  // UNA riga, e non e' rumore: senza, un riempimento riuscito e uno mai
  // partito sono indistinguibili nel log, e il secondo si scopre solo quando
  // qualcuno apre la schermata e aspetta.
  deps.logger.info(
    { job: 'stats-warm-boot', pronti: done, falliti: failed, ms, totaleMs: Date.now() - t0 },
    failed.length === 0
      ? 'cache statistiche riempita: le schermate partono calde'
      : 'cache statistiche riempita solo in parte',
  );
}
