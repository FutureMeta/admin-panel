// Il periodo selezionato, condiviso fra l'header e la schermata.
//
// STA NELL'HEADER, NON NELLA PAGINA, come nel design: i pulsanti vivono nella
// barra in alto accanto al breadcrumb, e la schermata sotto reagisce. Sono due
// componenti diversi in due punti diversi dell'albero.
//
// STA NELLA URL, e non in uno stato di React. Prima viveva in un contesto:
// funzionava finché nessuno ricaricava la pagina e finché nessuno mandava a
// un collega il collegamento a un grafico. Ricaricando si tornava a sette
// giorni; incollato in chat, un grafico dell'anno arrivava come una settimana,
// senza che niente lo dicesse — chi lo apriva vedeva una figura diversa da
// quella di cui si stava parlando.
//
// Sta sulla rotta del GUSCIO e non su ognuna delle schermate: il selettore
// vive nella barra in alto, che è del guscio, e dichiararlo cinque volte
// significherebbe cinque occasioni di dimenticarlo su una.
//
// COSA GOVERNA. Andamento online, heatmap, giocatori unici e provenienza
// geografica. NON la distribuzione per modalita', che mostra la popolazione
// CORRENTE e non un periodo: e' l'unico riquadro della pagina che risponde a
// «adesso» invece che «in questo intervallo».

import { useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useMemo } from 'react';

export type Range = '24h' | '7d' | '30d' | '90d' | '1y';

/**
 * Chiave del contratto ed etichetta mostrata.
 *
 * Le due cose sono DIVERSE e devono restarlo: il server parla `7d`, il design
 * scrive `7g`. Mescolarle significherebbe o un'interfaccia in inglese o una
 * chiave di cache in italiano, e la seconda e' peggio della prima.
 */
export const RANGES: ReadonlyArray<{ key: Range; label: string }> = [
  { key: '24h', label: '24h' },
  { key: '7d', label: '7g' },
  { key: '30d', label: '30g' },
  { key: '90d', label: '90g' },
  { key: '1y', label: '1y' },
];

/** L'etichetta da mostrare nei sottotitoli dei riquadri. */
export function labelOf(range: Range): string {
  return RANGES.find((r) => r.key === range)?.label ?? range;
}

/**
 * Il periodo con cui si apre la pagina.
 *
 * SETTE GIORNI, non ventiquattro ore. Il 24h e' l'unico range che puo' non
 * avere ancora una forma: alle nove del mattino sono nove punti, e una rete
 * che vive di sera li ha quasi tutti bassi. Sette giorni mostrano subito il
 * ritmo settimanale — che e' la domanda vera che si fa aprendo la panoramica —
 * e non dipendono dall'ora in cui qualcuno guarda.
 */
export const DEFAULT_RANGE: Range = '7d';

export function isRange(v: unknown): v is Range {
  return typeof v === 'string' && RANGES.some((r) => r.key === v);
}

/**
 * Il periodo letto dalla URL, per `validateSearch` della rotta del guscio.
 *
 * UN VALORE IMPOSSIBILE SI TOGLIE, non si tiene. `?range=settimana` non è un
 * periodo, e le due alternative — mostrare un errore, oppure disegnare il
 * predefinito lasciando in barra una parola che non significa niente — sono
 * peggiori: la prima blocca una pagina per un parametro decorativo, la seconda
 * lascia credere che quel testo abbia avuto un effetto. Sparisce, e la pagina
 * si apre sul suo predefinito come se nessuno avesse chiesto niente.
 *
 * NEMMENO IL PREDEFINITO SI SCRIVE. Una URL nuda vale sette giorni; scrivercelo
 * dentro riempirebbe ogni indirizzo di un parametro che non è stato scelto da
 * nessuno, e toglierebbe la differenza fra «non ha scelto» e «ha scelto sette
 * giorni» — che è la differenza per cui il predefinito un giorno si può
 * cambiare senza rompere i collegamenti già in giro.
 */
export function rangeSearch(search: Record<string, unknown>): { range?: Range } {
  const raw = search['range'];
  return isRange(raw) ? { range: raw } : {};
}

type RangeState = { range: Range; setRange: (r: Range) => void };

export function useRange(): RangeState {
  const navigate = useNavigate();
  const range = useSearch({ from: '/shell', select: (s) => s.range ?? DEFAULT_RANGE });

  const setRange = useCallback(
    (r: Range) => {
      // `replace` e non una tappa nuova nella cronologia.
      //
      // Il periodo è una LENTE sulla stessa pagina, non un'altra pagina.
      // Impilandolo, chi prova 24h, 7g e 30g per capire una curva deve poi
      // premere indietro tre volte per uscire dalla schermata — e il tasto
      // indietro smette di voler dire «torna da dove venivo».
      //
      // Non toglie niente allo scopo: l'indirizzo che si copia porta comunque
      // il periodo che si sta guardando, ed era quello il punto.
      //
      // `to: '.'` è la rotta corrente qualunque sia: la barra in alto non sa
      // su quale schermata si trova, e non deve saperlo.
      void navigate({ to: '.', search: (prev: { range?: Range }) => ({ ...prev, range: r }), replace: true });
    },
    [navigate],
  );

  return useMemo(() => ({ range, setRange }), [range, setRange]);
}
