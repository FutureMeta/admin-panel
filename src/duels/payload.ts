// I payload duels COME VIAGGIANO: i tipi e le costanti che li definiscono.
//
// UN MODULO SENZA DIPENDENZE, e non e' un dettaglio. Li importa anche il
// frontend (`import type`, che sparisce dal bundle): prima ne teneva una
// copia a mano in `web/src/lib/duels.ts`, e la copia si era gia' allargata
// — `range: string`, `v: number` — cioe' un campo rinominato qui sarebbe
// diventato `undefined` nel browser senza che il compilatore dicesse niente.
// Qui dentro non entra niente che tiri codice del server: `contract.ts`, che
// ne ha bisogno, li riesporta.

import type { Range } from '#src/stats/contract.ts';

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

// ---------------------------------------------------------------------------
// Le partite dal vivo (`src/duels/live.ts`).
// ---------------------------------------------------------------------------

export type LiveServer = {
  id: string;
  type: string;
  players: number;
  active: boolean;
  matches: number;
  /** Media dei campioni. `null` quando il server non ne ha pubblicato nessuno. */
  tps: number | null;
  mspt: number | null;
  /**
   * Il valore che spark pubblica. VA MOLTIPLICATO PER DIECI per leggerlo in
   * percentuale — non per cento, e nemmeno lasciato com'e'.
   *
   * NON E' UNA DEDUZIONE, E' UNA MISURA. Sullo stesso server, nello stesso
   * momento: Redis porta `0.34, 0.42435, 0.3525` e `spark cpu` in console
   * scrive `3% 4% 3%`. Tre campioni, due fonti, la stessa risposta —
   * `0,34 × 10 = 3,4%`. Il plugin campiona `spark.cpuSystem()` sulle finestre
   * a 10 secondi, 1 minuto e 15 minuti, e questa e' la scala con cui arriva
   * qui.
   *
   * DUE MODI DI SBAGLIARLA, e ci sono cascato in tutti e due:
   *
   *   * per cento — il mockup lo fa, perche' i suoi dati finti erano `0.41` su
   *     una convenzione diversa. Un server al 3% diventa al 34%;
   *   * per uno — e' quello che faceva il VECCHIO pannello, con
   *     `formatPercent(s.cpu)`. Su `0.34` scriveva `0%`, cioe' mostrava zero
   *     su ogni server di ogni giorno, e nessuno se n'e' mai accorto perche'
   *     uno zero non stona. Il suo `deriveScore` divideva per cento per la
   *     stessa ragione, e quindi non misurava niente.
   *
   * La seconda e' la lezione: quel codice sembrava una prova ed era un
   * difetto. Il numero giusto e' venuto dal confronto con la console, non da
   * un'altra riga di codice.
   *
   * COME RIVERIFICARLO, se un giorno i numeri sembrano strani: `spark cpu` sul
   * server, e `HGET duels:servers:<id> cpu` su Redis, nello stesso minuto.
   */
  cpu: number | null;
};

export type LiveMatch = {
  id: string;
  context: string;
  server: string | null;
  modeId: number;
  /** Il nome leggibile, o `null` se il catalogo non conosce quell'id. */
  mode: string | null;
  mapId: number;
  map: string | null;
  /** Millisecondi dall'epoca, come li scrive il plugin. */
  createdAt: number;
  players: number;
};

export type LiveMode = {
  modeId: number;
  name: string;
  active: number;
  queued: number;
  /** `EVENT` oppure `NORMAL`: decide il colore del pallino nel grafico. */
  context: string;
};

export type LiveSnapshot = {
  /** Quando e' stato letto, in millisecondi. Serve a dire «di quando e'». */
  at: number;
  servers: LiveServer[];
  matches: LiveMatch[];
  modes: LiveMode[];
  /** `true` se una scansione ha incontrato il fusibile: i numeri sono parziali. */
  truncated: boolean;
};

export type LiveRosterPlayer = {
  name: string;
  /** Il server su cui il profilo dice che si trova. */
  server: string | null;
  ping: number | null;
};

/** Cio' che `GET /api/duels/live/roster` restituisce: il roster di una partita. */
export type LiveRoster = { matchId: string; players: LiveRosterPlayer[]; truncated: boolean };
