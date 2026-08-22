// La rampa di colore della heatmap.
//
// STA IN UN MODULO PURO perché era il pezzo sbagliato e nessun test poteva
// prenderlo: dentro il componente, l'unico modo di accorgersi che
// centosessantotto celle erano dipinte con quattro colori era guardarle.
//
// PERCHE' ERA SBAGLIATO. La rampa ha quattro fermate e la scelta era un
// `Math.floor`: si prendeva la fermata più vicina invece di percorrere il
// tratto fra due. Il risultato non è una scala di intensità, è una mappa a
// quattro categorie — e la differenza fra un'ora da dieci partite e una da
// settanta finiva dentro lo stesso rettangolo.

/** Le quattro fermate del design: dal fondo scuro all'accento. */
export const HEAT_STOPS = ['#0F212A', '#1E5670', '#8A7147', '#F0A63F'] as const;

export const HEAT_GRADIENT = `linear-gradient(90deg,${HEAT_STOPS.join(',')})`;

/** Dove cade un valore sulla rampa, 0..1. Oltre il tetto resta a 1. */
export function heatPosition(value: number, top: number): number {
  if (top <= 0) return 0;
  return Math.min(1, Math.max(0, value / top));
}

/**
 * Il colore di una cella, INTERPOLATO fra le due fermate che la contengono.
 *
 * `color-mix` in oklab, non in sRGB: oklab è lo spazio percettivamente
 * uniforme, quello in cui una miscela al cinquanta per cento SEMBRA a metà
 * strada. In sRGB la stessa miscela produce una banda scura in mezzo a ogni
 * transizione, ed è il motivo per cui i gradienti fatti a mano sembrano
 * sporchi.
 */
export function heatColour(value: number | null, top: number): string {
  if (value === null) return 'transparent';
  if (value <= 0 || top <= 0) return HEAT_STOPS[0];

  const segments = HEAT_STOPS.length - 1;
  const at = heatPosition(value, top) * segments;
  const index = Math.min(segments - 1, Math.floor(at));
  const from = HEAT_STOPS[index] as string;
  const to = HEAT_STOPS[index + 1] as string;
  // La percentuale è quella del colore di ARRIVO: 0% = tutto `from`.
  const mix = Math.round((at - index) * 100);
  return `color-mix(in oklab, ${to} ${mix}%, ${from})`;
}
