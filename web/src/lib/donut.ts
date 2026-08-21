// La geometria della ciambella: un tracciato SVG, nessun componente.
//
// STA IN `lib` E NON ACCANTO AL RIQUADRO che la disegna per la stessa ragione
// di `distribution.ts` e `when.ts`: è una funzione pura, la si prova con dei
// numeri, e un test non deve tirarsi dietro un modulo JSX per farlo.

/** Sotto questo scarto l'angolo È il giro intero: sono errori di virgola. */
const FULL_TURN = Math.PI * 2 - 1e-9;

/**
 * Uno spicchio di ciambella, e il giro intero quando la fetta è una sola.
 *
 * IL GIRO INTERO È UN CASO A PARTE, e non per eleganza. Un arco SVG è definito
 * dai suoi due estremi: a 360° l'estremo di arrivo È quello di partenza, e la
 * specifica dice che un arco con estremi coincidenti si omette — non degenera
 * in un punto, sparisce. Una modalità sola, o una modalità con un server solo
 * nel dettaglio, dava quindi una torta senza cerchio: il riquadro c'era, il
 * numero al centro c'era, e l'anello no.
 *
 * ERA INVISIBILE A CHI SVILUPPA. Il caso capita solo quando le fette sono UNA,
 * cioè sulla configurazione più semplice che esista; in tavola ce ne sono
 * quasi sempre due o tre, e lì il disegno è giusto.
 *
 * Il giro si disegna allora come DUE SEMICERCHI per bordo. Il foro viene dal
 * verso opposto del bordo interno (`sweep` 0 contro 1): con la regola di
 * riempimento predefinita — `nonzero` — i due versi si annullano dentro, e il
 * buco è un buco senza doverlo dichiarare.
 */
export function arc(cx: number, cy: number, r: number, inner: number, from: number, to: number): string {
  const p = (radius: number, a: number) => [cx + radius * Math.cos(a), cy + radius * Math.sin(a)];

  if (to - from >= FULL_TURN) {
    return (
      `M${cx + r},${cy} A${r},${r} 0 1 1 ${cx - r},${cy} A${r},${r} 0 1 1 ${cx + r},${cy} Z ` +
      `M${cx + inner},${cy} A${inner},${inner} 0 1 0 ${cx - inner},${cy} ` +
      `A${inner},${inner} 0 1 0 ${cx + inner},${cy} Z`
    );
  }

  const [x1, y1] = p(r, from);
  const [x2, y2] = p(r, to);
  const [x3, y3] = p(inner, to);
  const [x4, y4] = p(inner, from);
  const large = to - from > Math.PI ? 1 : 0;
  return `M${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} L${x3},${y3} A${inner},${inner} 0 ${large} 0 ${x4},${y4} Z`;
}
