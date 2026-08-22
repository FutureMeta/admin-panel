// Il contratto dei payload duels, e la finestra che ogni riquadro legge.
//
// LE REGOLE SONO QUELLE DEL PANNELLO, non nuove (`src/stats/contract.ts`):
//
//  1. IL BUCO E' UN VALORE. `null` significa «prima di `since`, il dato non
//     esiste», `0` significa «coperto e vuoto». Non si interpola mai sopra un
//     `null`: interpolare cancella per sempre l'informazione che il dato non
//     c'era, ed e' l'unica operazione irreversibile della catena.
//  2. ENUM DI RANGE CHIUSO, quello del guscio. Niente `?from=&to=`: lo spazio
//     delle chiavi di cache deve restare finito ed enumerabile. Il selettore
//     e' quello in alto e governa OGNI riquadro della pagina.
//  3. Il totale si calcola UNA VOLTA qui, non con un `reduce` nel componente.
//
// E una regola in piu' che nasce da questo modulo: **il periodo non lo decide
// il client**. `bucket` per range e' una tabella del server — 24h ora, 7g ora,
// 30g giorno, 90g giorno, 1a settimana — ed e' esatta a ogni livello perche' i
// conteggi sono additivi. Un client che potesse chiedere «90 giorni a
// granularita' oraria» chiederebbe 2160 punti su un grafico largo mille pixel.

import { RANGES, type Range } from '#src/stats/contract.ts';
import { romeMidnight, shiftDays } from '#src/stats/read.ts';
import { civilDay } from '#src/stats/warm.ts';

export { RANGES, type Range };

/** Nella CHIAVE di cache, non solo nel corpo: una cache non si migra. */
export const DUELS_CONTRACT_VERSION = 1;

export type DuelsBucket = 'hour' | 'day' | 'week';

/** Quante righe di classifica escono per intero prima di «Altre (N)». */
export const TOP_LIMIT = 25;

/** La soglia di significativita' di «modalita' meglio votata». §3.2 */
export const BEST_RATED_MIN_SAMPLE = 5;

/** Quante valutazioni per pagina nella lista. Lo decide il server. */
export const RECENT_PAGE_SIZE = 15;

export type DuelsCombo = {
  type: string;
  context: string;
  v: (number | null)[];
};

export type DuelsModeRow = {
  id: number;
  name: string;
  ranking: string | null;
  type: string | null;
  color: string | null;
  matches: number;
};

export type DuelsMapRow = {
  id: number;
  name: string | null;
  type: string | null;
  matches: number;
};

/** Cio' che resta fuori dal taglio a 25, aggregato. */
export type DuelsOthers = { n: number; matches: number };

export type DuelsTrends = {
  v: typeof DUELS_CONTRACT_VERSION;
  range: Range;
  bucket: DuelsBucket;
  /** Inizio di ogni bucket, epoch secondi, crescente e senza salti. */
  t: number[];
  /**
   * Un elemento per combinazione (tipo, contesto) PRESENTE nel periodo.
   *
   * Le tab della schermata filtrano in memoria: nessuna richiesta nuova,
   * nessuna chiave di cache in piu'. La serie disegnata e' la somma dei
   * `combos` che soddisfano entrambe le tab.
   */
  combos: DuelsCombo[];
  heatmap: {
    /** SEMPRE 168 celle, indice = dow * 24 + hour, dow 0 = LUNEDI'. */
    cells: (number | null)[];
    /**
     * Il tetto dell'intensita': 95esimo percentile dei valori non nulli.
     *
     * Non il massimo assoluto, che con un picco anomalo schiaccia tutto il
     * resto a invisibile. Si calcola qui e non nel browser perche' la
     * legenda lo DICHIARA («≥ N»), e un numero dichiarato dev'essere lo
     * stesso che ha prodotto i colori.
     */
    p95: number;
  };
  /**
   * Partite senza orario, escluse dalla heatmap.
   *
   * E' SEMPRE ZERO su questa installazione e resta nel contratto per non
   * doverlo aggiungere il giorno in cui non lo fosse: `created_at` non e' mai
   * NULL all'origine — verificato il 22 agosto 2026 su 2.491.686 righe, zero
   * nulle. Nessun riquadro deve dichiarare qualcosa quando vale zero.
   */
  untimed: number;
  /** Le prime `TOP_LIMIT` per partite, gli zeri compresi. */
  modes: DuelsModeRow[];
  modesOthers: DuelsOthers;
  maps: DuelsMapRow[];
  mapsOthers: DuelsOthers;
  /** Somma di TUTTO il periodo, non solo delle righe spedite. */
  totals: { matches: number };
  /** 'YYYY-MM-DD': il primo giorno che esiste davvero. */
  since: string | null;
  /** L'ultimo bucket e' in corso: la UI lo tratteggia. Solo sul 24h. */
  liveTail: boolean;
  builtAt: number;
};

export type DuelsModeScore = {
  id: number;
  name: string;
  count: number;
  average: number;
};

export type DuelsRatings = {
  v: typeof DUELS_CONTRACT_VERSION;
  range: Range;
  mode: number | null;
  total: number;
  /** Media grezza, senza soglia di campione: con un voto solo dice 5. */
  average: number;
  /** QUANTE, non la percentuale: il denominatore e' `total` ed e' li' sopra. */
  withComment: number;
  /** r1..r5, SEMPRE cinque elementi anche a zero voti. */
  distribution: [number, number, number, number, number];
  /** Per giorno civile. I giorni senza voti sono `null`, non saltati. */
  trend: { t: number[]; avg: (number | null)[]; n: (number | null)[] };
  /** Solo nello scope globale: a modalita' singola non significherebbe nulla. */
  mostRated: DuelsModeScore | null;
  bestRated: DuelsModeScore | null;
  /** DICHIARATO, non nascosto: e' l'unica regola di significativita' della pagina. */
  bestRatedMinSample: number;
  since: string | null;
  builtAt: number;
};

export type DialogTurn = { role: string; content: string };

export type DuelsRatingRow = {
  /** `bigint` all'origine: viaggia come stringa o perde cifre in JavaScript. */
  id: string;
  at: number;
  player: string | null;
  playerUuid: string | null;
  mode: number | null;
  modeName: string | null;
  rating: number;
  comment: string | null;
  /** Gia' parsato dal server: nel browser non si fa `JSON.parse` di questo. */
  dialog: DialogTurn[] | null;
};

export type DuelsRecentSort = 'recent' | 'worst' | 'best';
export type DuelsCommentFilter = 'all' | 'with' | 'without';

export type DuelsRecent = {
  v: typeof DUELS_CONTRACT_VERSION;
  rows: DuelsRatingRow[];
  /** Opaco. `null` quando non c'e' altro da leggere. */
  cursor: string | null;
  /**
   * Solo alla PRIMA pagina di una combinazione di filtri.
   *
   * Il legacy rifa` una `COUNT(*)` sugli stessi join pesanti a ogni cambio
   * pagina. Qui si conta una volta e la barra dice «15 di 1.284»; sfogliando,
   * `total` e' `null` e la barra dice «altre».
   */
  total: number | null;
  pageSize: number;
};

export function isSort(v: unknown): v is DuelsRecentSort {
  return v === 'recent' || v === 'worst' || v === 'best';
}

export function isCommentFilter(v: unknown): v is DuelsCommentFilter {
  return v === 'all' || v === 'with' || v === 'without';
}

/** La granularita' di ogni range. Decisa dal server, non negoziabile. */
export const DUELS_BUCKET: Record<Range, DuelsBucket> = {
  '24h': 'hour',
  '7d': 'hour',
  '30d': 'day',
  '90d': 'day',
  '1y': 'week',
};

export type DuelsWindow = {
  from: Date;
  to: Date;
  bucket: DuelsBucket;
  /** L'ultimo bucket e' in corso. */
  liveTail: boolean;
};

const HOUR_MS = 3_600_000;

/**
 * La finestra del periodo, in bucket interi.
 *
 * TRE REGIMI, e ognuno ha una ragione.
 *
 * `24h` e' una finestra SCORREVOLE allineata all'ora e INCLUDE l'ora in
 * corso. E' l'unico posto in cui si vede la cadenza da trenta secondi: senza
 * l'ora viva, una partita giocata cinque minuti fa non comparirebbe da nessuna
 * parte fino allo scoccare dell'ora. L'ultimo punto e' parziale per
 * costruzione e il payload lo dichiara con `liveTail`, cosi' la UI lo
 * tratteggia invece di farlo leggere come un crollo.
 *
 * `7d`, `30d` e `90d` sono GIORNI CIVILI INTERI e oggi si esclude, perche'
 * oggi e' un giorno parziale e sull'asse si leggerebbe come un crollo. E' la
 * stessa scelta di `windowOf` per le statistiche (`src/stats/read.ts`), e
 * usare la stessa funzione non e' pigrizia: due implementazioni dei giorni
 * civili di Roma divergono al primo cambio d'ora, e divergerebbero solo in
 * quei due giorni all'anno.
 *
 * `1y` sono 52 SETTIMANE INTERE che partono di lunedi', e la settimana in
 * corso si esclude per la stessa ragione per cui si esclude oggi. Il prezzo e'
 * che la vista annuale e' vecchia fino a sei giorni; il prezzo dell'altra
 * scelta sarebbe un'ultima colonna sempre bassa, che si legge come un calo.
 */
export function duelsWindowOf(range: Range, now: Date): DuelsWindow {
  const bucket = DUELS_BUCKET[range];

  if (range === '24h') {
    const to = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS + HOUR_MS);
    return { from: new Date(to.getTime() - 24 * HOUR_MS), to, bucket, liveTail: true };
  }

  if (range === '1y') {
    const monday = mondayOf(now);
    return { from: shiftDays(monday, -52 * 7), to: monday, bucket, liveTail: false };
  }

  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  const to = romeMidnight(now);
  return { from: shiftDays(to, -days), to, bucket, liveTail: false };
}

/**
 * La mezzanotte del lunedi' della settimana che contiene `at`.
 *
 * `getUTCDay()` sull'istante di mezzanotte di Roma da' il giorno giusto: la
 * mezzanotte locale e' un istante, e quell'istante cade nello stesso giorno
 * civile a Roma per costruzione. 0 e' domenica, quindi il lunedi' precedente
 * dista `(dow + 6) % 7` giorni.
 */
function mondayOf(at: Date): Date {
  const midnight = romeMidnight(at);
  const dow = new Date(midnight.getTime() + 12 * HOUR_MS).getUTCDay();
  return shiftDays(midnight, -((dow + 6) % 7));
}

/**
 * Gli inizi dei bucket, epoch secondi, dal primo all'ultimo.
 *
 * I GIORNI SI CONTANO IN GIORNI CIVILI, non a 86400 secondi: due volte
 * l'anno un giorno dura 23 o 25 ore, e sommare secondi farebbe scivolare
 * l'asse di un'ora per tutto il resto del periodo.
 */
export function duelsGrid(w: DuelsWindow): number[] {
  const out: number[] = [];
  if (w.bucket === 'hour') {
    for (let t = w.from.getTime(); t < w.to.getTime(); t += HOUR_MS) out.push(Math.floor(t / 1_000));
    return out;
  }
  const step = w.bucket === 'day' ? 1 : 7;
  for (let d = w.from; d.getTime() < w.to.getTime(); d = shiftDays(d, step)) {
    out.push(Math.floor(d.getTime() / 1_000));
  }
  return out;
}

/**
 * Il 95esimo percentile dei valori non nulli, per interpolazione lineare.
 *
 * Con meno di due valori il percentile non significa niente e si ripiega sul
 * massimo: un tetto pari a zero renderebbe ogni cella satura.
 */
export function p95Of(values: Array<number | null>): number {
  const xs = values.filter((v): v is number => v !== null && v > 0).sort((a, b) => a - b);
  if (xs.length === 0) return 0;
  if (xs.length === 1) return xs[0] as number;
  const pos = 0.95 * (xs.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const value = (xs[lo] as number) + ((xs[hi] as number) - (xs[lo] as number)) * (pos - lo);
  return Math.round(value);
}

/**
 * Le chiavi di cache, con la versione DENTRO la chiave.
 *
 * Un cambio di contratto e' un namespace nuovo e le chiavi vecchie scadono da
 * sole: una cache non si migra. Il giorno civile sta nella chiave per la
 * stessa ragione delle statistiche — a mezzanotte tutti i range mancano e si
 * ricostruiscono, invece di servire un periodo che si e' spostato sotto.
 *
 * La lista delle valutazioni non ha una chiave: ha ricerca libera e cursore,
 * quindi il suo spazio non e' enumerabile e non e' scaldabile.
 */
export const DK = {
  tr: (r: Range, day: string = civilDay()) => `duels:v${DUELS_CONTRACT_VERSION}:tr:${day}:${r}`,
  rt: (mode: number | null, r: Range, day: string = civilDay()) =>
    `duels:v${DUELS_CONTRACT_VERSION}:rt:${day}:${mode ?? '_all'}:${r}`,
};
