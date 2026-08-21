// Quando si tengono sullo schermo i numeri di prima.
//
// IL PROBLEMA CHE RISOLVE. Cambiando periodo o modalità cambia la chiave della
// query, react-query torna `undefined`, e la pagina spariva per un istante —
// con la barra laterale ferma, il che la faceva sembrare rotta invece che
// occupata. Tenere i dati precedenti mentre arrivano i nuovi toglie sia il
// vuoto sia il salto di layout.
//
// MA NON SEMPRE, ed è tutto il punto di questo file. Tenerli quando cambia il
// SOGGETTO significherebbe mostrare le curve di una modalità sotto il nome di
// un'altra: internamente coerente — nome e numeri verrebbero dallo stesso
// payload vecchio — e comunque una risposta alla domanda sbagliata, con la
// voce evidenziata in alto che indica un'altra cosa ancora.
//
// La regola è quindi: stesso soggetto, periodo diverso → si tiene e si smorza.
// Soggetto diverso → si mostra la pagina che carica, perché è ciò che sta
// davvero succedendo.

/**
 * Il dato precedente, ma solo se riguardava lo stesso soggetto.
 *
 * `subjectOf` estrae dal `queryKey` la parte che identifica il soggetto — per
 * il dettaglio è la chiave della modalità, e il periodo sta in un'altra
 * posizione apposta perché possa cambiare senza far scattare la regola.
 */
export function keepIfSameSubject<T>(
  previous: T | undefined,
  previousKey: readonly unknown[] | undefined,
  subject: unknown,
  at = 1,
): T | undefined {
  if (previous === undefined || previousKey === undefined) return undefined;
  return previousKey[at] === subject ? previous : undefined;
}
