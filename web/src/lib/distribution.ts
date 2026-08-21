// Le fette della distribuzione per modalità.
//
// QUATTRO RIGHE IN UN MODULO A PARTE, e la ragione è che erano quattro righe
// dentro un componente e sono state sbagliate. La distribuzione è l'unico
// riquadro della panoramica che il selettore in alto NON governa: risponde a
// «chi c'è adesso», e il payload porta quella misura in `current`, presa
// dall'ultimo bucket da cinque minuti indipendentemente dal range.
//
// La versione rotta prendeva i VALORI da `current` e le CHIAVI da `modes`, che
// è invece la lista delle modalità presenti nella serie del range scelto. Le
// due liste coincidono quasi sempre, e quando non coincidono il riquadro non
// sbaglia un numero: sparisce. Su un range il cui storico non esiste ancora —
// l'1y finché non c'è un rollup giornaliero — la ciambella diventava vuota e
// scriveva «nessuna misura ancora» tenendo in mano la misura.
//
// È il difetto peggiore di questa classe: non produce un numero falso, produce
// un'assenza, e un'assenza sembra sempre un problema di dati e mai di codice.

export type Slice = { key: string; value: number };

export type Distribution = {
  /** Le fette da disegnare, dalla più popolata alla meno. */
  slices: Slice[];
  /**
   * I giocatori che ci sono ma non hanno una fetta.
   *
   * VA DICHIARATO, non taciuto. La torta è letta come un intero: togliere una
   * modalità senza dirlo sposta ogni percentuale delle altre verso l'alto, in
   * modo plausibile e invisibile. Chi guarda concluderebbe che duels pesa il
   * 40% quando pesa il 32%, e non avrebbe niente su cui dubitare.
   */
  excluded: number;
};

/**
 * Le modalità presenti ADESSO, meno quelle che l'operatore ha escluso.
 *
 * `current` nullo significa che il campionamento non ha ancora chiuso un
 * bucket: lista vuota, che è diverso da «zero giocatori» e il riquadro lo
 * scrive. Le modalità a zero non entrano — una fetta di ampiezza nulla è una
 * voce di legenda senza disegno.
 *
 * `outOfBreakdown` viene dal dizionario (`stats.mode.in_breakdown`), quindi
 * non dipende dal periodo scelto: è una decisione sull'identità di una
 * modalità, non sul periodo in cui la si guarda.
 */
export function slicesOf(
  current: { byMode: Record<string, number> } | null | undefined,
  outOfBreakdown: readonly string[] = [],
): Distribution {
  const excludedKeys = new Set(outOfBreakdown);
  const slices: Slice[] = [];
  let excluded = 0;

  for (const [key, value] of Object.entries(current?.byMode ?? {})) {
    if (value <= 0) continue;
    if (excludedKeys.has(key)) excluded += value;
    else slices.push({ key, value });
  }

  slices.sort((a, b) => b.value - a.value);
  return { slices, excluded };
}
