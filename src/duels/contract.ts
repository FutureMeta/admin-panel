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

/**
 * Un turno della conversazione post-valutazione, SUL FILO.
 *
 * All'origine — e nel `jsonb` che conserviamo — i campi si chiamano `role` e
 * `content`, com'e' scritto il vocabolario del gioco. Sul filo verso il
 * browser si chiamano `speaker` e `text`, e la ragione non e' estetica: il
 * pannello ha una guardia di build che vieta di leggere un campo `role`,
 * perche' nel suo modello quella parola significa il ruolo di un utente, e la
 * colonna `role` di better-auth non esiste. Un campo che si chiama come una
 * cosa che non c'e' e' un invito a confonderle.
 *
 * La conversione si fa QUI, una volta, al confine.
 */
export type DialogTurn = { speaker: string; text: string };

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

/**
 * Quanti GIORNI copre ogni periodo. In un posto solo.
 *
 * Era una catena di ternari dentro la finestra, e l'anno valeva 364 li' e 365
 * altrove: due definizioni di «un anno» nello stesso pannello, sotto la stessa
 * etichetta. 364 perche' sono 52 settimane esatte, che e' cio' che l'asse
 * disegna.
 */
export const DUELS_DAYS: Record<Range, number> = {
  '24h': 1,
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '1y': 364,
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
 * OGNI PERIODO ARRIVA A ORA. E' cambiato: prima i periodi a giorni finivano
 * alla mezzanotte passata, cioe' un grafico di sette giorni si fermava alle 23
 * di ieri. La ragione era buona — l'ultimo bucket e' parziale e su un'area si
 * legge come un crollo — ma la conclusione era sbagliata: davanti a quel vuoto
 * nessuna spiegazione regge, ed e' la prima cosa che si nota aprendo la
 * schermata.
 *
 * Il parziale si DICHIARA invece di toglierlo, e sono tre cose insieme:
 *   * `liveTail` dice che l'ultimo bucket e' in corso, e la UI lo tratteggia;
 *   * i bucket interamente FUTURI valgono `null`, non zero — un'ora che non e'
 *     ancora arrivata non e' un'ora senza partite;
 *   * la finestra si costruisce sui giorni CIVILI di Roma con le stesse due
 *     funzioni delle statistiche, perche' due implementazioni dei giorni
 *     civili divergono al primo cambio d'ora e divergono solo in quei due
 *     giorni all'anno.
 *
 * `24h` resta a se': e' una finestra SCORREVOLE allineata all'ora, non ai
 * giorni. E' li' che si vede la cadenza da trenta secondi — senza l'ora viva,
 * una partita giocata cinque minuti fa non comparirebbe da nessuna parte fino
 * allo scoccare dell'ora.
 */
export function duelsWindowOf(
  range: Range,
  now: Date,
  bucket: DuelsBucket = DUELS_BUCKET[range],
): DuelsWindow {
  // LA GRANULARITA' E' UN PARAMETRO, e non per generalita' astratta: lo stesso
  // periodo si guarda a grane diverse a seconda di cosa si conta. Sul `7d` le
  // partite stanno bene a ore — sono migliaia al giorno — e le valutazioni no,
  // perche' un centinaio al giorno diviso per ventiquattro sono zero o uno per
  // punto, cioe' rumore disegnato come segnale. E la finestra CAMBIA con la
  // grana: a ore scorre con l'orologio, a giorni si allinea alla mezzanotte.
  const days = DUELS_DAYS[range];

  // I PERIODI A BUCKET ORARIO SCORRONO CON L'OROLOGIO, non con la mezzanotte.
  //
  // «Ultime ventiquattro ore» e «ultimi sette giorni» vogliono dire quello:
  // alle 15:40 il grafico finisce alle 15, non a mezzanotte di stasera. Il 7g
  // era allineato ai giorni civili e le ore che restavano fino a stanotte
  // erano dentro la griglia ma vuote — mezzo grafico bianco, con l'adesso a
  // meta' invece che al bordo destro.
  //
  // I periodi a bucket GIORNALIERO o SETTIMANALE no: li' l'ultimo bucket e'
  // oggi (o questa settimana) e contiene gia' l'adesso, quindi allinearli
  // all'orologio spezzerebbe il primo giorno a meta' senza guadagnare niente.
  if (bucket === 'hour') {
    const hours = days * 24;
    const to = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS + HOUR_MS);
    return { from: new Date(to.getTime() - hours * HOUR_MS), to, bucket, liveTail: true };
  }

  if (bucket === 'week') {
    // La settimana IN CORSO c'e', e finisce al lunedi' prossimo: e' l'ultima
    // colonna, parziale, e la UI la tratteggia.
    const to = shiftDays(mondayOf(now), 7);
    return { from: shiftDays(to, -Math.round(days / 7) * 7), to, bucket, liveTail: true };
  }

  // OGGI E' DENTRO, e prima non lo era. La finestra finisce alla mezzanotte
  // che VERRA', non a quella passata: un grafico di sette giorni che si ferma
  // alle 23 di ieri e' la prima cosa che si nota aprendolo, e nessuna
  // spiegazione sul giorno parziale regge davanti a quel vuoto.
  //
  // Il motivo per cui oggi era escluso resta vero — l'ultimo bucket e'
  // parziale e su un'area si legge come un crollo — ma la risposta giusta e'
  // DICHIARARLO, non toglierlo: `liveTail` lo dice, la UI lo tratteggia, e i
  // bucket interamente futuri valgono `null` invece di zero.
  const to = shiftDays(romeMidnight(now), 1);
  return { from: shiftDays(to, -days), to, bucket, liveTail: true };
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
  /**
   * Le modalita' guardate di recente, UNA CHIAVE PER RANGE.
   *
   * Con un insieme globale una schermata aperta sul 24h occuperebbe
   * stabilmente i primi posti, e i payload per modalita' dei periodi lunghi
   * non verrebbero scaldati mai: il meccanismo che deve evitare l'esplosione
   * combinatoria smetterebbe di funzionare per quattro range su cinque. Il
   * giorno qui non serve — cio' che qualcuno ha guardato non scade a
   * mezzanotte.
   */
  hot: (r: Range) => `duels:v${DUELS_CONTRACT_VERSION}:hot:${r}`,
};

/**
 * I periodi LENTI: cambiano, ma non a ogni ciclo di ingestione.
 *
 * SI CHIAMAVANO «CHIUSI» e non lo sono piu'. Finivano alla mezzanotte passata,
 * quindi una partita giocata adesso ci cadeva fuori e il loro payload era
 * identico per ventiquattro ore — il che rendeva la cache quasi gratuita. Ora
 * arrivano a oggi, quindi si muovono ogni volta che si muove il bucket in
 * corso.
 *
 * COSA RESTA VERO, ed e' cio' che conta per la cache: si muove SOLO l'ultimo
 * bucket. Su trenta giorni un aggiornamento cambia un trentesimo del disegno,
 * e sessanta secondi di ritardo su quel trentesimo non si vedono — mentre
 * ricostruire novanta giorni ogni trenta secondi si vedrebbe eccome. Restano
 * sul giro di warm da un minuto; solo il `24h`, dove l'ultimo bucket e' un
 * ventiquattresimo e la cadenza e' il punto, lo rifa' il ciclo che ingerisce.
 */
export const DUELS_SLOW_RANGES: readonly Range[] = ['7d', '30d', '90d', '1y'] as const;

/** Il periodo vivo: l'unico la cui finestra si sposta fra un ciclo e l'altro. */
export const DUELS_LIVE_RANGE: Range = '24h';

/**
 * Quanto comprimere i byte di un periodo, e lo decide IL PERIODO.
 *
 * La compressione forte costa venti volte tanto e si ripaga solo se quei byte
 * vengono serviti molte volte prima di essere rifatti. La fetta viva si rifa'
 * ogni trenta secondi e viene letta due o tre volte: q11 la' sarebbe pagata e
 * buttata. I periodi chiusi si costruiscono una volta e si servono per ore.
 *
 * STA QUI perche' era deciso in TRE posti che si contraddicevano: la rotta
 * scriveva q11 per ogni chiave, il giro della fetta viva q5, e il giro dei
 * periodi chiusi q11 per le due chiavi globali ma q5 per le modalita' calde —
 * smentendo il proprio stesso commento. La stessa chiave finiva in cache con
 * qualita' diverse a seconda di chi l'aveva scritta per ultimo.
 */
export function duelsQuality(range: Range): 5 | 11 {
  return range === DUELS_LIVE_RANGE ? 5 : 11;
}
