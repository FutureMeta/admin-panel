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
  /**
   * La larghezza di RIPIEGO, usata solo finché il riquadro non è stato
   * misurato.
   *
   * IL VIEWBOX SEGUE I PIXEL, e non è un dettaglio di implementazione: con
   * `preserveAspectRatio="none"` un sistema di coordinate fisso viene STIRATO
   * per riempire il contenitore, e con lui il testo. A piena pagina 1120 unità
   * su ~1050 pixel sono un 6% di compressione che non si nota; nel riquadro a
   * metà pagina dell'andamento del voto diventa il 50%, e allora sì che si
   * nota: le etichette dell'asse si schiacciano e il «5★» finisce sopra la
   * prima colonna.
   *
   * Misurando il riquadro e usando la sua larghezza come viewBox, un'unità è
   * un pixel su entrambi gli assi e non c'è più niente da stirare.
   */
  W: 1120,
  /** Margine sinistro: ci stanno le etichette dell'asse verticale. */
  LEFT: 56,
  /** Margine destro, in pixel: il bordo destro è `larghezza - questo`. */
  PAD_RIGHT: 12,
  /** Il bordo destro alla larghezza di ripiego. Le scale lo ricalcolano. */
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
  /** Il bordo destro EFFETTIVO: dipende da quanto è largo il riquadro. */
  right: number;
};

/**
 * Le due scale del grafico.
 *
 * `plot` e' l'altezza del TRACCIATO in unita' del viewBox; l'altezza totale e'
 * `plot + AXIS_BAND`, cosi' la banda delle etichette non puo' essere
 * dimenticata da chi disegna.
 */
export function chartScales(n: number, top: number, plot: number, width: number = CHART.W): ChartScales {
  const points = Math.max(1, n);
  const right = Math.max(CHART.LEFT + 1, width - CHART.PAD_RIGHT);
  return {
    x: (i) => CHART.LEFT + ((right - CHART.LEFT) * i) / Math.max(1, points - 1),
    y: (v) => plot - ((plot - CHART.TOP) * v) / Math.max(1, top),
    bottom: plot,
    right,
  };
}

/**
 * La barra di un bucket: dove comincia e quanto è larga, SENZA sbordare.
 *
 * Una linea vive sui PUNTI, una barra su una FASCIA, e le due cose non
 * coincidono: centrando la barra sul punto, la prima e l'ultima sporgono di
 * mezza larghezza oltre i bordi del tracciato. Con centosessantotto punti sono
 * due pixel e non si vedono; con sette — l'andamento del voto a sette giorni —
 * sono trenta, e la prima barra finisce sopra le etichette dell'asse verticale.
 *
 * Quindi si tagliano ai bordi: la prima e l'ultima diventano mezze barre, che è
 * la resa giusta perché mezza fascia è davvero fuori dal periodo.
 *
 * Il 70% dello spazio lascia il respiro fra una barra e l'altra: attaccate
 * diventerebbero un'area piena, cioè un'altra figura.
 */
export function bandAt(scales: ChartScales, points: number, index: number): { x: number; width: number } {
  const slot = (scales.right - CHART.LEFT) / Math.max(1, points - 1);
  const wanted = Math.max(1, slot * 0.7);
  const from = Math.max(CHART.LEFT, scales.x(index) - wanted / 2);
  const to = Math.min(scales.right, scales.x(index) + wanted / 2);
  return { x: from, width: Math.max(1, to - from) };
}

/** Quanti pixel serve riservare a un'etichetta perché non tocchi la vicina. */
const LABEL_ROOM = 130;

/**
 * Quante tacche stanno su una certa larghezza.
 *
 * NON UN NUMERO FISSO. Otto etichette stanno su mille pixel e si accavallano
 * su cinquecento — che è la larghezza del riquadro dell'andamento del voto,
 * metà pagina. Il numero lo detta lo spazio, non il grafico.
 */
export function slotsFor(width: number): number {
  return Math.max(2, Math.floor(width / LABEL_ROOM));
}

/**
 * Le tacche orizzontali da mostrare, e SEMPRE l'ultima.
 *
 * L'ultima si aggiunge sempre perché è l'unica che dice DOVE FINISCE il
 * periodo, ed è la domanda che si fa guardando il bordo destro di un grafico.
 * Se cade troppo vicino alla penultima, è la penultima a cedere il posto: un
 * bordo senza etichetta è peggio di una tacca in meno in mezzo.
 */
export function everyNth(points: number, labelOf: (index: number) => string, slots = 8): XTick[] {
  const step = Math.max(1, Math.round(points / Math.max(1, slots)));
  const out: XTick[] = [];
  for (let i = 0; i < points; i += 1) {
    if (i % step === 0) out.push({ at: i, label: labelOf(i) });
  }
  const last = points - 1;
  if (out.at(-1)?.at !== last) {
    if (last - (out.at(-1)?.at ?? 0) < step / 2) out.pop();
    out.push({ at: last, label: labelOf(last) });
  }
  return out;
}
