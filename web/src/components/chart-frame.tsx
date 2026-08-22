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
import { useEffect, useRef, useState } from 'react';
import {
  CHART,
  type ChartScales,
  chartScales,
  everyNth,
  slotsFor,
  spacingOf,
  tickSpacing,
} from '../lib/chart.ts';
import { axisLabel, bucketLabel } from '../lib/when.ts';
import { HoverTip, useHoverTip } from './hover-tip.tsx';

export type YTick = { value: number; label: string };

export function ChartFrame({
  plot,
  top,
  t,
  yTicks,
  ariaLabel,
  detailOf,
  children,
}: {
  /** Altezza del tracciato in unita' del viewBox. */
  plot: number;
  /** Il massimo dell'asse verticale: la scala la decide chi disegna. */
  top: number;
  /**
   * L'inizio di ogni bucket, epoch secondi. Da qui il telaio ricava TUTTO
   * l'asse orizzontale: quanti punti ci sono, quali etichettare, come
   * scriverle e cosa mettere in testa al tooltip.
   *
   * PRIMA LO DECIDEVA OGNI GRAFICO, e i tre passavano tre numeri diversi come
   * «distanza fra le etichette»: la panoramica quella giusta, i due dei duels
   * il passo dei BUCKET. Da lì «14:00» senza il giorno sul 7g e «gio 00» sul
   * 30g. Non era deducibile da chi disegna — quante tacche stiano sull'asse lo
   * decide la larghezza misurata, che la sa solo questo componente.
   */
  t: number[];
  yTicks: YTick[];
  ariaLabel: string;
  /**
   * La seconda riga del tooltip: il valore in quel bucket, con la sua unità.
   *
   * La PRIMA riga — quando — la scrive il telaio, perché è la stessa domanda
   * per tutti e tre i grafici e dipende dal passo dei bucket, non dai dati.
   */
  detailOf?: (index: number) => string;
  /**
   * Il disegno vero. Riceve le scale e QUALE BUCKET è sotto il cursore, così
   * ogni grafico può marcare il proprio punto: il telaio conosce la posizione
   * ma non i valori, che sono di chi disegna.
   */
  children: (scales: ChartScales, hovered: number | null) => ReactNode;
}) {
  const hover = useHoverTip();
  // QUALE bucket, non dove sta il mouse: il cursore si muove con continuità e
  // il grafico no. Agganciare la linea al bucket più vicino è ciò che rende
  // leggibile il valore — una riga a metà fra due punti non indica niente.
  const [hovered, setHovered] = useState<number | null>(null);

  // LA LARGHEZZA SI MISURA. Con un viewBox fisso e `preserveAspectRatio="none"`
  // il disegno viene stirato per riempire il contenitore, e con lui il TESTO:
  // a piena pagina è un 6% che non si nota, nel riquadro a metà pagina è il
  // 50% e le etichette dell'asse si accavallano sul grafico. Prendendo la
  // larghezza vera come sistema di coordinate, un'unità è un pixel e non c'è
  // più niente da stirare.
  const box = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState<number>(CHART.W);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(320, Math.round(el.getBoundingClientRect().width)));
    measure();
    // Non basta misurare una volta: la barra laterale si chiude, la finestra
    // cambia, e un grafico misurato al primo render resterebbe della larghezza
    // di allora.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const points = Math.max(1, t.length);
  const scales = chartScales(points, top, plot, width);
  const height = plot + CHART.AXIS_BAND;

  // L'ASSE ORIZZONTALE, TUTTO QUI DENTRO. Le tacche le sceglie la larghezza; la
  // forma dell'etichetta la decide la distanza fra le tacche SCELTE, non quella
  // fra i bucket. Sono due numeri diversi e confonderli si vede: un'etichetta
  // ogni ventun ore vuole il giorno accanto all'ora, una ogni novanta vuole la
  // data.
  const xTicks = everyNth(points, () => '', slotsFor(width));
  const labelStep = tickSpacing(t, xTicks);
  const bucketStep = spacingOf(t);

  const leave = () => {
    hover.clear();
    setHovered(null);
  };

  return (
    <div ref={box} style={{ position: 'relative' }}>
      <div ref={hover.boxRef} onPointerLeave={leave} style={{ position: 'relative' }}>
        <HoverTip tip={hover.tip} boxRef={hover.boxRef} />
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          style={{ width: '100%', height, display: 'block' }}
          role="img"
          aria-label={ariaLabel}
          onPointerLeave={leave}
          onPointerMove={(e: React.PointerEvent<SVGSVGElement>) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const step = (scales.right - CHART.LEFT) / Math.max(1, points - 1);
            const at = Math.round((((e.clientX - rect.left) / rect.width) * width - CHART.LEFT) / step);
            const index = Math.min(points - 1, Math.max(0, at));
            setHovered(index);
            // Il QUANDO lo scrive il telaio: è la stessa domanda per tutti e
            // tre i grafici, e su un bucket giornaliero «20 gennaio alle
            // 00:00» è falso due volte — l'ora non significa niente e
            // suggerisce che il valore appartenga a quel minuto.
            if (detailOf) hover.at(e, bucketLabel(t[index] ?? 0, bucketStep), detailOf(index));
          }}
        >
          <g stroke="var(--grid)" strokeWidth={1}>
            {yTicks.map((yt) => (
              <line
                key={yt.value}
                x1={CHART.LEFT}
                x2={scales.right}
                y1={scales.y(yt.value)}
                y2={scales.y(yt.value)}
              />
            ))}
          </g>
          {yTicks.map((yt) => (
            <text
              key={yt.label}
              x={CHART.LEFT - 10}
              y={scales.y(yt.value)}
              textAnchor="end"
              dominantBaseline="middle"
              fill="var(--tx-muted)"
              fontSize="11"
              fontFamily={CHART.FONT}
            >
              {yt.label}
            </text>
          ))}

          {/* LA LINEA DI RIFERIMENTO, sotto il tracciato e sopra la griglia: dice
              DOVE si sta guardando. Senza, il tooltip mostra un numero e non c'è
              modo di sapere a quale punto del grafico appartiene — su
              centosessantotto ore la differenza fra due colonne vicine è un
              pixel. Sta prima di `children` per finire sotto la linea dei dati. */}
          {hovered !== null ? (
            <line
              x1={scales.x(hovered)}
              x2={scales.x(hovered)}
              y1={CHART.TOP}
              y2={plot}
              stroke="var(--tx-muted)"
              strokeWidth={1}
              strokeDasharray="3 3"
              pointerEvents="none"
            />
          ) : null}

          {children(scales, hovered)}

          {xTicks.map((tick) => (
            <text
              key={tick.at}
              x={scales.x(tick.at)}
              y={plot + CHART.LABEL_DY}
              textAnchor="middle"
              fill="var(--tx-muted)"
              fontSize="11"
              fontFamily={CHART.FONT}
            >
              {axisLabel(t[tick.at] ?? 0, labelStep)}
            </text>
          ))}
        </svg>
      </div>
    </div>
  );
}

export type { ChartScales, XTick } from '../lib/chart.ts';
export { CHART, everyNth } from '../lib/chart.ts';
