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

/** Una quota in italiano, una cifra decimale. */
export function shareLabel(share: number): string {
  return `${share.toFixed(1).replace('.', ',')}%`;
}

/**
 * La distanza fra due bucket, in secondi, per decidere l'etichetta dell'asse.
 *
 * Si MISURA sulla griglia invece di dedurla dal nome del bucket: un mese non
 * dura sempre lo stesso, e un giorno di cambio ora dura 23 o 25 ore. La
 * differenza fra i primi due punti è il dato vero.
 */
export function spacingOf(t: number[]): number {
  if (t.length < 2) return 3_600;
  return Math.max(1, (t[1] as number) - (t[0] as number));
}
