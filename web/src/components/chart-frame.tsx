// Il telaio dei grafici a linea. UNO SOLO, per tutti.
//
// PERCHE' ESISTE. Per un po' il pannello ne ha avuti tre: l'andamento online,
// le partite dei duels e il voto medio, ognuno con il suo viewBox, il suo
// margine e le sue etichette. Non era un problema estetico — era che le tre
// geometrie DIVERGEVANO: 1120×300 con le ore a venti unita' dal fondo, 1120×268
// con le ore a due, 1120×246 senza ore affatto. Il primo si legge, il secondo
// ha le etichette incollate al bordo della scheda, il terzo non dice a che
// giorno si riferisce un punto.
//
// E la deriva non si vede finche' non si mettono due schermate una accanto
// all'altra, che e' esattamente cio' che nessuno fa mentre le costruisce.
//
// COSA TIENE FISSO:
//   * la larghezza e i margini, quindi due grafici hanno gli assi allineati;
//   * la BANDA sotto il tracciato — 32 unita' — dove vivono le etichette
//     dell'asse orizzontale, con dodici unita' di respiro sotto;
//   * il carattere delle etichette. E qui c'e' una trappola vera: dentro un
//     attributo di presentazione SVG `var(--font-mono)` NON SI RISOLVE. Non
//     fallisce, non avvisa: ripiega sul font di sistema, e l'unico modo di
//     accorgersene e' guardare due assi vicini e notare che uno e' diverso.
//     Il nome del carattere si scrive per esteso, come in tutto il resto del
//     pannello.

import type React from 'react';
import type { ReactNode } from 'react';
import { CHART, type ChartScales, chartScales, type XTick } from '../lib/chart.ts';
import { HoverTip, useHoverTip } from './hover-tip.tsx';

export type YTick = { value: number; label: string };

export function ChartFrame({
  plot,
  top,
  points,
  yTicks,
  xTicks,
  ariaLabel,
  tipOf,
  children,
}: {
  /** Altezza del tracciato in unita' del viewBox. */
  plot: number;
  /** Il massimo dell'asse verticale: la scala la decide chi disegna. */
  top: number;
  points: number;
  yTicks: YTick[];
  xTicks: XTick[];
  ariaLabel: string;
  /** Il contenuto del tooltip per un indice. `null` per non mostrarlo. */
  tipOf?: (index: number) => { title: string; detail: string } | null;
  children: (scales: ChartScales) => ReactNode;
}) {
  const hover = useHoverTip();
  const scales = chartScales(points, top, plot);
  const height = plot + CHART.AXIS_BAND;

  return (
    <div ref={hover.boxRef} onPointerLeave={hover.clear} style={{ position: 'relative' }}>
      <HoverTip tip={hover.tip} boxRef={hover.boxRef} />
      <svg
        viewBox={`0 0 ${CHART.W} ${height}`}
        preserveAspectRatio="none"
        style={{ width: '100%', height, display: 'block' }}
        role="img"
        aria-label={ariaLabel}
        {...(tipOf
          ? {
              onPointerMove: (e: React.PointerEvent<SVGSVGElement>) => {
                const box = e.currentTarget.getBoundingClientRect();
                const step = (CHART.RIGHT - CHART.LEFT) / Math.max(1, points - 1);
                const at = Math.round((((e.clientX - box.left) / box.width) * CHART.W - CHART.LEFT) / step);
                const index = Math.min(points - 1, Math.max(0, at));
                const tip = tipOf(index);
                if (tip) hover.at(e, tip.title, tip.detail);
              },
            }
          : {})}
      >
        <g stroke="var(--grid)" strokeWidth={1}>
          {yTicks.map((t) => (
            <line
              key={t.value}
              x1={CHART.LEFT}
              x2={CHART.RIGHT}
              y1={scales.y(t.value)}
              y2={scales.y(t.value)}
            />
          ))}
        </g>
        {yTicks.map((t) => (
          <text
            key={t.label}
            x={CHART.LEFT - 10}
            y={scales.y(t.value)}
            textAnchor="end"
            dominantBaseline="middle"
            fill="var(--tx-muted)"
            fontSize="11"
            fontFamily={CHART.FONT}
          >
            {t.label}
          </text>
        ))}

        {children(scales)}

        {xTicks.map((t) => (
          <text
            key={`${t.at}-${t.label}`}
            x={scales.x(t.at)}
            y={plot + CHART.LABEL_DY}
            textAnchor="middle"
            fill="var(--tx-muted)"
            fontSize="11"
            fontFamily={CHART.FONT}
          >
            {t.label}
          </text>
        ))}
      </svg>
    </div>
  );
}

export type { ChartScales, XTick } from '../lib/chart.ts';
export { CHART, everyNth } from '../lib/chart.ts';
