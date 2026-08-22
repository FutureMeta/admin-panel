// Le tre funzioni che tutti i grafici a linea del pannello condividono.
//
// STAVANO IN `stats-panels.tsx`, due delle tre private. Le tira fuori il
// modulo Duels, che disegna la stessa figura — una serie nel tempo con dei
// buchi — e riscriverle sarebbe stato il modo sicuro di perdere la regola che
// contengono: `segments` e `gaps` SONO l'implementazione di «non si interpola
// mai sopra un `null`». Una seconda copia scritta a memoria unirebbe i punti,
// il grafico sembrerebbe piu' bello, e il buco sparirebbe per sempre.

/**
 * Una scala LEGGIBILE per l'asse verticale.
 *
 * Prendere il massimo osservato come cima dell'asse produce tacche come 206,
 * 412, 617, 823: numeri esatti e inutilizzabili, perché nessuno legge un
 * grafico per sapere quanto vale un quarto del picco. Si arrotonda il passo a
 * 1, 2, 2,5 o 5 volte una potenza di dieci — gli unici incrementi che l'occhio
 * somma da solo — e la cima al primo multiplo sopra il massimo.
 *
 * Con 823 giocatori l'asse diventa 0, 250, 500, 750, 1.000.
 */
export function niceScale(max: number, ticks = 4): { top: number; values: number[] } {
  if (!Number.isFinite(max) || max <= 0) return { top: 1, values: [0, 1] };
  const raw = max / ticks;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / magnitude;
  // Passo minimo 1: sono CONTEGGI, e mezzo giocatore — o mezza partita — non
  // esiste. Senza questo pavimento, una rete quasi vuota produce tacche
  // «0, 0, 1, 1», cioè un asse che si ripete.
  const step = Math.max(
    1,
    magnitude * (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10),
  );
  const top = Math.ceil(max / step) * step;
  const values: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) values.push(Math.round(v));
  return { top, values };
}

/** I segmenti di una serie, spezzati sui buchi: mai una linea sopra un `null`. */
export function segments(
  values: (number | null)[],
  x: (i: number) => number,
  y: (v: number) => number,
): string[] {
  const out: string[] = [];
  let current: string[] = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (current.length > 1) out.push(current.join(' '));
      current = [];
      return;
    }
    current.push(`${current.length === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  });
  if (current.length > 1) out.push(current.join(' '));
  return out;
}

/** Le fasce non rilevate, come intervalli di indice contigui. */
export function gaps(values: (number | null)[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start: number | null = null;
  values.forEach((v, i) => {
    if (v === null && start === null) start = i;
    if (v !== null && start !== null) {
      out.push([start, i - 1]);
      start = null;
    }
  });
  if (start !== null) out.push([start, values.length - 1]);
  return out;
}

// ---------------------------------------------------------------------------
// La geometria, condivisa da TUTTI i grafici a linea del pannello
// ---------------------------------------------------------------------------

export const CHART = {
  /** Larghezza del sistema di coordinate. La resa e' sempre a piena larghezza. */
  W: 1120,
  /** Margine sinistro: ci stanno le etichette dell'asse verticale. */
  LEFT: 56,
  RIGHT: 1108,
  TOP: 16,
  /**
   * Quanto sta SOTTO il tracciato: venti unita' fino alla linea di base delle
   * etichette, dodici di respiro fino al bordo. Senza questa banda le ore
   * finiscono appiccicate al bordo della scheda — che e' come si e' scoperto
   * che i telai erano tre.
   */
  AXIS_BAND: 32,
  LABEL_DY: 20,
  /** `var()` non si risolve negli attributi SVG: il nome va per esteso. */
  FONT: 'JetBrains Mono',
} as const;

export type XTick = { at: number; label: string };

export type ChartScales = {
  /** Da indice del bucket a coordinata orizzontale. */
  x: (i: number) => number;
  /** Da valore a coordinata verticale. */
  y: (v: number) => number;
  /** Il fondo del tracciato, dove si chiudono le aree. */
  bottom: number;
};

/**
 * Le due scale del grafico.
 *
 * `plot` e' l'altezza del TRACCIATO in unita' del viewBox; l'altezza totale e'
 * `plot + AXIS_BAND`, cosi' la banda delle etichette non puo' essere
 * dimenticata da chi disegna.
 */
export function chartScales(n: number, top: number, plot: number): ChartScales {
  const points = Math.max(1, n);
  return {
    x: (i) => CHART.LEFT + ((CHART.RIGHT - CHART.LEFT) * i) / Math.max(1, points - 1),
    y: (v) => plot - ((plot - CHART.TOP) * v) / Math.max(1, top),
    bottom: plot,
  };
}

/**
 * Le tacche orizzontali da mostrare: una ogni `n / 8`, e sempre l'ultima.
 *
 * Otto e' il numero che sta su mille pixel senza sovrapporsi; l'ultima si
 * aggiunge sempre perche' e' l'unica che dice DOVE FINISCE il periodo, ed e'
 * la domanda che si fa guardando il bordo destro di un grafico.
 */
export function everyNth(points: number, labelOf: (index: number) => string): XTick[] {
  const step = Math.max(1, Math.round(points / 8));
  const out: XTick[] = [];
  for (let i = 0; i < points; i += 1) {
    if (i % step === 0 || i === points - 1) out.push({ at: i, label: labelOf(i) });
  }
  return out;
}
