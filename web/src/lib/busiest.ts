// Su quale modalità si apre il dettaglio quando nessuno ne ha chiesta una.
//
// «La più popolata adesso» è la scelta giusta perché è l'unica che non
// invecchia: una modalità fissata a mano diventa quella sbagliata il giorno in
// cui la rete cambia, e l'ordine alfabetico non ha mai voluto dire niente. Chi
// apre il dettaglio senza dire quale sta chiedendo «dov'è la gente», e questa
// è la risposta.

/** La popolazione corrente per modalità, dal payload della panoramica. */
export type Population = { byMode: Record<string, number> } | null | undefined;

/**
 * Le modalità su cui si può ENTRARE, nell'ordine del dizionario.
 *
 * Le sentinella (`__network__`, `__transit__`, `__unknown__`) sono serie
 * visibili nei grafici ma non sono destinazioni: `__transit__` è il giocatore
 * osservato senza un campo `server`, non un posto dove andare a guardare.
 */
export function navigableModes(labels: Record<string, string>): string[] {
  return Object.keys(labels).filter((m) => !m.startsWith('__'));
}

/**
 * La modalità con più giocatori in questo momento.
 *
 * L'ORDINE DEL DIZIONARIO DECIDE I PARI, e non è un dettaglio: senza, a
 * deciderlo sarebbe l'ordine di iterazione dell'oggetto, che nessuno promette.
 * Due modalità con lo stesso numero — di notte capita, e a zero capita sempre
 * — farebbero atterrare ogni volta su una diversa, e il pannello sembrerebbe
 * scegliere a caso proprio quando è più facile accorgersene.
 *
 * Senza nessuna misura si ripiega sulla prima del dizionario: è un ordine che
 * l'operatore ha scelto (`sort_order`), quindi è una risposta, non un caso.
 * `null` solo se non esiste nemmeno una modalità.
 */
export function busiestMode(current: Population, labels: Record<string, string>): string | null {
  const candidates = navigableModes(labels);
  if (candidates.length === 0) return null;

  const players = current?.byMode ?? {};
  let best = candidates[0] as string;
  let most = players[best] ?? 0;

  for (const mode of candidates) {
    const count = players[mode] ?? 0;
    // Stretta: il primo del dizionario a pari merito resta il primo.
    if (count > most) {
      best = mode;
      most = count;
    }
  }

  return best;
}
