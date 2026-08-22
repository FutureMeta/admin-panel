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
