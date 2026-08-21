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

/**
 * Le modalità presenti ADESSO, dalla più popolata alla meno.
 *
 * `current` nullo significa che il campionamento non ha ancora chiuso un
 * bucket: lista vuota, che è diverso da «zero giocatori» e il riquadro lo
 * scrive. Le modalità a zero non entrano — una fetta di ampiezza nulla è una
 * voce di legenda senza disegno.
 */
export function slicesOf(current: { byMode: Record<string, number> } | null | undefined): Slice[] {
  return Object.entries(current?.byMode ?? {})
    .map(([key, value]) => ({ key, value }))
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value);
}
