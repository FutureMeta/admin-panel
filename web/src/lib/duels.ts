// Il contratto dei duels visto dal browser, e i conti che la schermata fa.
//
// I CONTI STANNO QUI, non nei componenti. Sono le tre cose che un grafico può
// sbagliare senza smettere di disegnare — sommare due serie sopra un buco,
// normalizzare la barra sul numero sbagliato, dare due ranghi diversi a due
// pari merito — e in un componente sarebbero verificabili solo aprendo la
// pagina e guardandola.

/** Deve restare uguale a `DUELS_CONTRACT_VERSION` del server. */
export const DUELS_V = 1;

export type DuelsBucket = 'hour' | 'day' | 'week';

export type DuelsCombo = { type: string; context: string; v: (number | null)[] };

export type DuelsModeRow = {
  id: number;
  name: string;
  ranking: string | null;
  type: string | null;
  color: string | null;
  matches: number;
};

export type DuelsMapRow = { id: number; name: string | null; type: string | null; matches: number };

export type DuelsOthers = { n: number; matches: number };

export type DuelsTrends = {
  v: number;
  range: string;
  bucket: DuelsBucket;
  t: number[];
  combos: DuelsCombo[];
  heatmap: { cells: (number | null)[]; p95: number };
  untimed: number;
  modes: DuelsModeRow[];
  modesOthers: DuelsOthers;
  maps: DuelsMapRow[];
  mapsOthers: DuelsOthers;
  totals: { matches: number };
  since: string | null;
  liveTail: boolean;
  builtAt: number;
};

/** Il valore che le due barre dei filtri usano per «nessun filtro». */
export const ALL = '__all__';

/**
 * I valori di tipo e contesto PRESENTI nel periodo.
 *
 * Non un elenco fisso: `match_type` e `context` sono testo libero all'origine,
 * e una scheda per un valore che quel periodo non contiene sarebbe una scheda
 * che mostra sempre un grafico vuoto.
 */
export function comboFilters(combos: DuelsCombo[]): { types: string[]; contexts: string[] } {
  const types = new Set<string>();
  const contexts = new Set<string>();
  for (const c of combos) {
    types.add(c.type);
    contexts.add(c.context);
  }
  return { types: [...types].sort(), contexts: [...contexts].sort() };
}

/**
 * La serie da disegnare: la somma delle combinazioni che passano i due filtri.
 *
 * IL BUCO SOPRAVVIVE ALLA SOMMA. Se in un bucket ogni combinazione vale
 * `null` — cioè quel bucket è prima dell'inizio della raccolta — il risultato
 * è `null`, non zero. Sommare trattando i `null` come zeri trasformerebbe «non
 * lo sappiamo» in «non è successo niente», che è la sola operazione
 * irreversibile di tutta la catena: il grafico disegnerebbe una linea a fondo
 * scala su un periodo di cui non esiste il dato.
 *
 * Nella pratica i `null` sono allineati fra le combinazioni, perché vengono
 * tutti dallo stesso `since`; il caso misto è trattato come dato presente,
 * perché almeno una combinazione ha davvero un numero.
 */
export function combineCombos(combos: DuelsCombo[], type: string, context: string): (number | null)[] {
  const picked = combos.filter(
    (c) => (type === ALL || c.type === type) && (context === ALL || c.context === context),
  );
  const length = picked[0]?.v.length ?? 0;
  const out: (number | null)[] = new Array(length).fill(null);
  for (let i = 0; i < length; i += 1) {
    let sum: number | null = null;
    for (const c of picked) {
      const value = c.v[i];
      if (value === null || value === undefined) continue;
      sum = (sum ?? 0) + value;
    }
    out[i] = sum;
  }
  return out;
}

export type RankedRow<T> = {
  row: T;
  /** Larghezza della barra, 0..100: normalizzata sul MASSIMO. */
  width: number;
  /** Quota sul periodo, 0..100: normalizzata sul TOTALE. */
  share: number;
  /** Rango DENSO: due pari merito hanno lo stesso numero. */
  rank: number;
};

/**
 * Le righe di una classifica, con le loro DUE normalizzazioni.
 *
 * La barra si misura sul massimo e la percentuale sul totale: sono due scale
 * diverse nella stessa riga, ed è una scelta deliberata — la barra serve a
 * confrontare le righe fra loro, la percentuale a dire quanto pesa quella riga
 * sul periodo. Va dichiarata nell'intestazione, non lasciata da indovinare.
 *
 * IL TOTALE COMPRENDE CIÒ CHE NON SI VEDE. Il server taglia a venticinque
 * righe e manda il resto aggregato: se la quota si calcolasse sulle righe
 * spedite, sommerebbe al 100% di un insieme diverso da quello che la pagina
 * dice di mostrare.
 *
 * Il rango è DENSO: tre modalità a 400 partite sono tutte e tre #1, e la
 * quarta è #2. Numerare per posizione nell'array direbbe #1, #2, #3 su tre
 * numeri identici.
 */
export function ranked<T extends { matches: number }>(
  rows: T[],
  others: DuelsOthers,
): { rows: RankedRow<T>[]; total: number; max: number } {
  const shown = rows.reduce((a, r) => a + r.matches, 0);
  const total = shown + others.matches;
  const max = Math.max(1, ...rows.map((r) => r.matches));

  let rank = 0;
  let previous: number | null = null;
  const out = rows.map((row) => {
    if (previous === null || row.matches !== previous) rank += 1;
    previous = row.matches;
    return {
      row,
      width: (row.matches / max) * 100,
      share: total > 0 ? (row.matches / total) * 100 : 0,
      rank,
    };
  });
  return { rows: out, total, max };
}

// ---------------------------------------------------------------------------
// Ratings
// ---------------------------------------------------------------------------

export type DuelsModeScore = { id: number; name: string; count: number; average: number };

export type DuelsRatings = {
  v: number;
  range: string;
  mode: number | null;
  total: number;
  average: number;
  withComment: number;
  distribution: [number, number, number, number, number];
  trend: { t: number[]; avg: (number | null)[]; n: (number | null)[] };
  mostRated: DuelsModeScore | null;
  bestRated: DuelsModeScore | null;
  bestRatedMinSample: number;
  since: string | null;
  builtAt: number;
};

/** Come arriva sul filo: il pannello non parla di «role». */
export type DialogTurn = { speaker: string; text: string };

export type DuelsRatingRow = {
  id: string;
  at: number;
  player: string | null;
  playerUuid: string | null;
  mode: number | null;
  modeName: string | null;
  rating: number;
  comment: string | null;
  dialog: DialogTurn[] | null;
};

export type DuelsRecent = {
  v: number;
  rows: DuelsRatingRow[];
  cursor: string | null;
  total: number | null;
  pageSize: number;
};

export type CommentFilter = 'all' | 'with' | 'without';
export type RecentSort = 'recent' | 'worst' | 'best';

/**
 * La scala semaforica dei voti, DAI TOKEN.
 *
 * Il mockup assegna i colori nell'ordine sbagliato — cinque stelle finiscono
 * rosse — e il legacy improvvisa `rgb(251 146 60)` e `rgb(132 204 22)`, che
 * non esistono nemmeno fra le sue variabili. Qui uno e cinque stelle sono
 * l'errore e l'ok del pannello, e i due gradini in mezzo si ricavano da quelli:
 * il colore di una serie non e' decorazione.
 */
export const RATING_COLORS = ['var(--r1)', 'var(--r2)', 'var(--r3)', 'var(--r4)', 'var(--r5)'] as const;

export type RatingBar = { stars: number; count: number; share: number; color: string };

/**
 * Le cinque barre, SEMPRE cinque anche a zero voti.
 *
 * Non esistono barre mancanti: una distribuzione con quattro colonne
 * suggerirebbe che quel voto non si possa dare.
 */
export function distributionBars(distribution: readonly number[], total: number): RatingBar[] {
  return [0, 1, 2, 3, 4].map((i) => {
    const count = distribution[i] ?? 0;
    return {
      stars: i + 1,
      count,
      share: total > 0 ? (count / total) * 100 : 0,
      color: RATING_COLORS[i] as string,
    };
  });
}

/**
 * Quante stelle si disegnano piene per un valore medio.
 *
 * ARROTONDA, e il difetto e' noto: 3,50 disegna quattro stelle piene sopra la
 * scritta «3,50». E' tollerabile SOLO perche' il numero sta sempre accanto, e
 * l'etichetta per lo screen reader porta i due decimali — mai le stelle da
 * sole.
 */
export function starsFilled(value: number): number {
  return Math.max(0, Math.min(5, Math.round(value)));
}

/** Una media con due decimali, in italiano. */
export function avgLabel(value: number): string {
  return value.toFixed(2).replace('.', ',');
}

/**
 * La chiave dei filtri della lista.
 *
 * Quando cambia, il cursore si azzera DURANTE IL RENDER confrontandola con la
 * precedente. In un `useEffect` si emetterebbe prima una richiesta con il
 * cursore vecchio — cioe' la pagina due di una ricerca che non e' piu' quella.
 */
export function filterKey(f: {
  mode: number | null;
  q: string;
  comment: CommentFilter;
  sort: RecentSort;
  range: string;
}): string {
  return `${f.range}|${f.mode ?? '_all'}|${f.q}|${f.comment}|${f.sort}`;
}

export function isCommentFilter(v: unknown): v is CommentFilter {
  return v === 'all' || v === 'with' || v === 'without';
}

export function isRecentSort(v: unknown): v is RecentSort {
  return v === 'recent' || v === 'worst' || v === 'best';
}

export type RatingsSearch = {
  mode?: number;
  q?: string;
  comment?: CommentFilter;
  sort?: RecentSort;
};

/**
 * I filtri letti dalla URL, per `validateSearch` della rotta.
 *
 * NELLA URL e non in `useState`, come il periodo: nel legacy il filtro
 * modalita' e' uno stato di React e la vista filtrata non e' condivisibile —
 * chi incolla il collegamento a «le peggiori valutazioni di Sumo» manda la
 * lista di tutto.
 *
 * Un valore impossibile SI TOGLIE invece di tenerlo: lasciare in barra un
 * `?sort=migliori` che non ha effetto fa credere che l'abbia avuto.
 */
export function ratingsSearch(search: Record<string, unknown>): RatingsSearch {
  const out: RatingsSearch = {};
  const mode = Number(search['mode']);
  if (Number.isInteger(mode) && mode >= 0 && mode <= 32_767) out.mode = mode;
  const q = search['q'];
  if (typeof q === 'string' && q.trim() !== '') out.q = q.slice(0, 120);
  if (isCommentFilter(search['comment']) && search['comment'] !== 'all') out.comment = search['comment'];
  if (isRecentSort(search['sort']) && search['sort'] !== 'recent') out.sort = search['sort'];
  return out;
}

/**
 * Il prossimo stato della URL, con i parametri vuoti TOLTI invece che nulli.
 *
 * `?sort=` o `?q=` senza valore sono chiavi che non significano niente e
 * riempiono gli indirizzi che si incollano in chat. E toglierli non e' solo
 * estetica: la differenza fra «non ha scelto» e «ha scelto il predefinito» e'
 * quella per cui un predefinito si puo' cambiare senza rompere i collegamenti
 * gia' in giro.
 */
export function omitEmpty<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  const next: Record<string, unknown> = { ...base, ...patch };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === '') delete next[key];
  }
  return next as T;
}

// `spacingOf` vive in `lib/chart.ts`, accanto alle altre misure della griglia:
// e' geometria del grafico, non contratto dei duels. Si ri-esporta perche' i
// test la chiedevano a questo modulo.
export { spacingOf } from './chart.ts';
// I formattatori dei numeri stanno in `lib/format.ts`: ce n'e' una copia sola
// per tutto il pannello. Si ri-esportano qui perche' le schermate duels li
// chiedevano a questo modulo prima che esistesse quell'altro.
export { numberFmt, pctLabel, shareLabel } from './format.ts';
