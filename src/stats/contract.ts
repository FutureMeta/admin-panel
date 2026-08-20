// Il contratto del payload delle statistiche. Fase 2, §6.
//
// REGOLE CHE NON SI NEGOZIANO, perche' ognuna corrisponde a un modo preciso in
// cui il pannello mentirebbe:
//
//  1. UNA SOLA statistica per la linea: la MEDIA, coerente a ogni livello di
//     zoom. Il massimo viaggia come seconda serie e si disegna come banda, mai
//     come la linea. Se la linea fosse il massimo del bucket, lo stesso
//     istante varrebbe 1240 nel range 24h, 1310 nel 30g e 1480 nell'1y, e
//     l'utente lo scoprirebbe da solo.
//  2. IL BUCO E' UN VALORE. `null` significa «non rilevato», `0` significa
//     «rete davvero vuota». Non si interpola mai fra due punti separati da un
//     `null`: interpolare cancella per sempre l'informazione che il dato non
//     c'era, ed e' l'unica operazione irreversibile di tutta la catena.
//  3. `coverage` e' UNO SOLO per bucket, non uno per modalita': la copertura
//     e' una proprieta' del ciclo di raccolta, non di chi c'era dentro.
//  4. Il totale di rete e' MEMORIZZATO, non derivato: `max` e
//     `count(distinct)` non si decompongono.
//  5. Il breakdown chiude a 100% perche' `__transit__` e `__unknown__` sono
//     serie esplicite e visibili. Senza, la torta non somma mai al totale e il
//     primo che se ne accorge «aggiusta» normalizzando le percentuali — cioe'
//     spalma i giocatori non classificati sulle modalita' vere.
//  6. Nessun massimo viaggia da solo: sempre con l'istante e con la copertura
//     del bucket in cui e' avvenuto.

/** Nella CHIAVE di cache, non solo nel corpo: una cache non si migra. */
export const CONTRACT_VERSION = 2;

export type Range = '24h' | '7d' | '30d' | '90d' | '1y';

/**
 * Enum CHIUSO, e non per pigrizia.
 *
 * Niente `?days=N` e niente `?from=&to=`: lo spazio delle chiavi di cache deve
 * restare finito ed enumerabile a priori. Aggiungere un range e' una modifica
 * server, cioe' una decisione di costo presa da qualcuno.
 */
export const RANGES: readonly Range[] = ['24h', '7d', '30d', '90d', '1y'] as const;

export function isRange(v: unknown): v is Range {
  return typeof v === 'string' && (RANGES as readonly string[]).includes(v);
}

export type Kpi = {
  /** Media normalizzata sul profilo orario. `null` se la copertura e' zero. */
  avg: number | null;
  /** Massimo osservato nei soli bucket CHIUSI del periodo. */
  peak: number | null;
  /** Epoch in secondi. Un massimo senza il suo istante non e' verificabile. */
  peakAt: number | null;
  /** 0..1, copertura del bucket in cui il massimo e' avvenuto. */
  peakCoverage: number;
  /** Giocatori DISTINTI nel periodo. Non la somma degli unici giornalieri. */
  uniques: number | null;
  /** Secondi osservati / secondi nominali del periodo. */
  coverage: number;
};

export type Series = {
  /** Epoch in secondi, crescente e SENZA buchi: il buco e' un null nei valori. */
  t: number[];
  /** La riga di rete, memorizzata. */
  total: (number | null)[];
  /** Massimo del bucket sulla riga di rete. Si disegna come banda. */
  peak: (number | null)[];
  /** Include sempre `__transit__` e `__unknown__`. */
  series: Record<string, (number | null)[]>;
  /** 0..1, uno per bucket. */
  coverage: number[];
};

export type OverviewPayload = {
  v: typeof CONTRACT_VERSION;
  range: Range;
  tz: 'Europe/Rome';
  bucketSec: number;
  /** Quando il server ha prodotto QUESTI byte. */
  generatedAt: number;
  /** Ultimo istante definitivo: fine dell'ultimo bucket chiuso. */
  closedThrough: number;
  /** L'ultimo punto e' un bucket in corso: la UI lo tratteggia. */
  liveTail: boolean;
  /** Cadenze di campionamento distinte presenti nel range. */
  deltas: number[];
  /** Ordine di disegno. NON fidarsi dell'ordine delle chiavi di `series`. */
  modes: string[];
  labels: Record<string, string>;

  online: Series;
  /** Linea fantasma: SOLO il totale, con il suo asse dei tempi. */
  prev: { t: number[]; total: (number | null)[]; coverage: number[] };

  kpi: Kpi;
  kpiPrev: Kpi;
  /** `false` => la UI deve RIFIUTARSI di mostrare il delta percentuale. */
  comparable: boolean;

  /** 7x24, cella = (isodow-1)*24 + hour. TRE array, mai la media gia' divisa. */
  heatmap: { v: number[]; w: number[]; n: number[] };

  /** Unici giornalieri esatti. `t` e' la mezzanotte LOCALE di ogni giorno. */
  uniques: { t: number[]; v: (number | null)[]; prev: (number | null)[]; final: boolean[] };

  /** `null` quando la geolocalizzazione non e' attiva: la UI nasconde il widget. */
  geo: { cc: string[]; v: number[]; asOf: number; exact: boolean } | null;
};

/**
 * Il payload di UNA modalita'. Stessa forma, una serie sola.
 *
 * IL PICCO QUI E' SEMPRE `null`, ed e' una conseguenza aritmetica, non una
 * funzione mancante. `players_max` e' memorizzato per SERVER (la modalita' si
 * risolve in lettura, emendamento E2, cosi' che riclassificare un server
 * riscriva anche il passato). Il picco di una modalita' con tre server e' il
 * massimo nel tempo della SOMMA dei tre, e da tre massimi presi
 * separatamente quella somma non si ricostruisce: il massimo dei tre e' un
 * limite inferiore, la loro somma un limite superiore, e nessuno dei due e' il
 * numero. Il massimo di rete resta esatto perche' quello e' memorizzato come
 * riga propria (`server_id = 0`), che e' esattamente la regola 4.
 *
 * Mostrare `max(players_max)` etichettato «picco» sarebbe la stessa bugia che
 * la regola 4 esiste per impedire, con l'aggravante di essere plausibile.
 */
export type ModePayload = Omit<OverviewPayload, 'modes'> & {
  mode: string;
  modes: [string];
};

export class PayloadInvalid extends Error {
  constructor(problems: string) {
    super(`payload delle statistiche non valido: ${problems}`);
    this.name = 'PayloadInvalid';
  }
}

/**
 * Le invarianti si verificano alla COSTRUZIONE, non alla lettura.
 *
 * Il fallimento tipico di un contratto colonnare e' il disallineamento di
 * lunghezza fra due array paralleli: il grafico disegna, non lancia, e mostra
 * numeri corretti sotto l'etichetta sbagliata. E' il difetto peggiore di
 * tutti, perche' non ha sintomi.
 *
 * Un build che fallisce lascia in cache la chiave vecchia: servire un payload
 * vecchio e' meno grave che servirne uno rotto.
 */
export function assertPayload(p: OverviewPayload | ModePayload): void {
  const n = p.online.t.length;
  const bad: string[] = [];

  for (const [k, a] of [
    ['total', p.online.total],
    ['peak', p.online.peak],
    ['coverage', p.online.coverage],
  ] as const) {
    if (a.length !== n) bad.push(`${k} ha ${a.length} valori invece di ${n}`);
  }
  for (const [k, a] of Object.entries(p.online.series)) {
    if (a.length !== n) bad.push(`series.${k} ha ${a.length} valori invece di ${n}`);
  }
  if (p.prev.total.length !== p.prev.t.length) bad.push('prev disallineata');
  if (p.prev.coverage.length !== p.prev.t.length) bad.push('prev.coverage disallineata');
  if (p.heatmap.v.length !== 168 || p.heatmap.w.length !== 168 || p.heatmap.n.length !== 168) {
    bad.push('la heatmap non e` 7x24');
  }
  if (p.uniques.v.length !== p.uniques.t.length) bad.push('uniques disallineata');
  if (p.geo && p.geo.cc.length !== p.geo.v.length) bad.push('geo disallineata');
  for (const m of p.modes) {
    if (!(m in p.online.series)) bad.push(`la modalita\` ${m} e\` nell'ordine ma non nei dati`);
  }

  // I1 — il breakdown chiude sul totale. La tolleranza copre gli
  // arrotondamenti a un decimale di ogni serie, non un errore vero.
  for (let i = 0; i < n; i += 1) {
    const total = p.online.total[i];
    if (total === null || total === undefined) continue;
    let sum = 0;
    for (const m of p.modes) {
      if (m === '__network__') continue;
      sum += p.online.series[m]?.[i] ?? 0;
    }
    if (Math.abs(sum - total) > 0.05 * p.modes.length + 0.5) {
      bad.push(`la somma delle modalita\` non fa il totale al punto ${i}: ${sum} contro ${total}`);
      break;
    }
  }

  // I5 — la mappa somma agli unici del periodo. Vale per costruzione perche'
  // nascono dalla stessa CTE: se qui si rompe, sono state divise.
  if (p.geo && p.kpi.uniques !== null) {
    const somma = p.geo.v.reduce((a, b) => a + b, 0);
    if (somma !== p.kpi.uniques) bad.push(`la mappa somma ${somma}, gli unici sono ${p.kpi.uniques}`);
  }

  if (bad.length > 0) throw new PayloadInvalid(bad.join('; '));
}

/** Conteggi di persone: il decimale in piu' sono solo byte sul filo. */
export function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
