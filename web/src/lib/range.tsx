// Il periodo selezionato, condiviso fra l'header e la schermata.
//
// STA NELL'HEADER, NON NELLA PAGINA, come nel design: i pulsanti vivono nella
// barra in alto accanto al breadcrumb, e la schermata sotto reagisce. Sono due
// componenti diversi in due punti diversi dell'albero, quindi lo stato deve
// stare sopra entrambi.
//
// COSA GOVERNA. Andamento online, heatmap, giocatori unici e provenienza
// geografica. NON la distribuzione per modalita', che mostra la popolazione
// CORRENTE e non un periodo: e' l'unico riquadro della pagina che risponde a
// «adesso» invece che «in questo intervallo».

import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';

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

type RangeState = { range: Range; setRange: (r: Range) => void };

const RangeContext = createContext<RangeState>({ range: '24h', setRange: () => undefined });

export function RangeProvider({ children }: { children: ReactNode }) {
  const [range, setRange] = useState<Range>('24h');
  const value = useMemo(() => ({ range, setRange }), [range]);
  return <RangeContext.Provider value={value}>{children}</RangeContext.Provider>;
}

export function useRange(): RangeState {
  return useContext(RangeContext);
}
