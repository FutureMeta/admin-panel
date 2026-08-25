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
 * Il colore della rampa alla posizione `t`, con 0 al fondo e 1 all'accento.
 *
 * `color-mix` in oklab, non in sRGB: oklab è lo spazio percettivamente
 * uniforme, quello in cui una miscela al cinquanta per cento SEMBRA a metà
 * strada. In sRGB la stessa miscela produce una banda scura in mezzo a ogni
 * transizione, ed è il motivo per cui i gradienti fatti a mano sembrano
 * sporchi.
 *
 * STA QUI PERCHÉ LA MAPPA AVEVA LA SUA. Il mappamondo interpolava a mano, in
 * sRGB, sopra una copia della rampa allungata a sette fermate: due
 * implementazioni della stessa idea, e quella della mappa era la peggiore —
 * il tratto centrale, dal verdazzurro all'oliva, cambia tinta senza cambiare
 * chiarezza, quindi mezza scala si appiattiva in una banda unica. È metà del
 * motivo per cui due paesi diversi finivano dello stesso colore.
 */
export function rampColour(t: number): string {
  const clamped = Math.min(1, Math.max(0, t));
  const segments = HEAT_STOPS.length - 1;
  const at = clamped * segments;
  const index = Math.min(segments - 1, Math.floor(at));
  const from = HEAT_STOPS[index] as string;
  const to = HEAT_STOPS[index + 1] as string;
  // La percentuale è quella del colore di ARRIVO: 0% = tutto `from`.
  const mix = Math.round((at - index) * 100);
  return `color-mix(in oklab, ${to} ${mix}%, ${from})`;
}

/** Il colore di una cella della heatmap: posizione lineare sulla rampa. */
export function heatColour(value: number | null, top: number): string {
  if (value === null) return 'transparent';
  if (value <= 0 || top <= 0) return HEAT_STOPS[0];
  return rampColour(heatPosition(value, top));
}

/**
 * Il paese meno popolato resta COLORATO, non spento.
 *
 * Sotto questa soglia la rampa incontra il proprio fondo, che è quasi il
 * colore dei paesi senza dati: «un giocatore» e «nessun dato» diventerebbero
 * la stessa cosa da guardare, e sono due cose diverse.
 */
export const MAP_FLOOR = 0.12;

/**
 * Dove sta un paese sulla rampa della mappa. DAL VALORE, non dalla classifica.
 *
 * IL DIFETTO DI PARTENZA. Il colore veniva dalla POSIZIONE IN CLASSIFICA:
 * `indice / (paesi - 1)`. Sembra ragionevole — «il colore dice chi è primo» —
 * e produce due bugie opposte, tutte e due viste a schermo:
 *
 *   1. paesi con numeri MOLTO diversi, colorati uguale. Con quaranta paesi,
 *      due posizioni vicine distano il 2,5% della rampa: 900 e 1.200
 *      giocatori sono lo stesso colore perché sono secondo e primo, non
 *      perché si somiglino;
 *   2. paesi con numeri UGUALI, colorati diverso. La coda è piena di pari
 *      merito — quindici paesi con due giocatori a testa — e la classifica li
 *      mette comunque in fila, spalmandoli su un terzo della rampa. Colori
 *      diversi per lo stesso identico numero.
 *
 * La seconda è la peggiore delle due, perché inventa una differenza che nei
 * dati non c'è. Da qui in avanti non può più succedere: il colore è una
 * funzione del valore, quindi valori uguali danno colori uguali, sempre.
 *
 * PERCHÉ LA RADICE QUADRATA e non lineare né logaritmica. Lineare schiaccia
 * la coda: con l'Italia in testa, tutto il resto del pianeta finisce nel
 * primo 2% della rampa, cioè dello stesso grigio-blu. Logaritmica fa
 * l'opposto — apre la coda e appiattisce la testa, lasciando 900 e 1.200
 * indistinguibili come prima. La radice sta in mezzo: alla testa lascia una
 * differenza vera (fra 900 e 1.200 su 1.200 corrono tredici punti di rampa,
 * cinque volte quello che dava la classifica) e alla coda lascia un terzo
 * della scala in cui distendersi.
 *
 * Resta vero — e non c'è scala che lo eviti — che su un pianeta dominato da
 * un paese solo il resto si comprime. Per quello ci sono la legenda, il
 * riquadro al passaggio del mouse e l'elenco a destra: la mappa serve a
 * vedere il disegno, il numero esatto si legge.
 */
export function mapPosition(value: number, top: number): number {
  if (top <= 0 || value <= 0) return 0;
  return MAP_FLOOR + (1 - MAP_FLOOR) * Math.sqrt(Math.min(1, value / top));
}

/**
 * La legenda della mappa: SOLO il tratto che la mappa usa davvero.
 *
 * Parte da `MAP_FLOOR` e non da zero. Una legenda che mostrasse anche il
 * fondo prometterebbe colori che sulla carta non compaiono mai, ed è il modo
 * più educato di far sbagliare una lettura.
 *
 * Nove campioni: il gradiente CSS interpola in sRGB fra le fermate che gli si
 * danno, quindi campionare la rampa fitto è ciò che tiene la legenda uguale
 * alla carta, dove ogni paese passa da `rampColour` e quindi da oklab.
 */
export const MAP_GRADIENT = `linear-gradient(90deg,${Array.from({ length: 9 }, (_, i) =>
  rampColour(MAP_FLOOR + (1 - MAP_FLOOR) * (i / 8)),
).join(',')})`;
