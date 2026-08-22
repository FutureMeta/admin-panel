// Il riquadro che compare sotto il cursore, uno per tutta la panoramica.
//
// SCRITTO UNA VOLTA SOLA di proposito. Quattro grafici che mostrano lo stesso
// tipo di dettaglio con quattro riquadri copiati diventano, nel giro di un
// paio di modifiche, quattro riquadri leggermente diversi: uno con l'ombra,
// uno senza, uno che esce dal bordo destro. La differenza non la nota nessuno
// finche' non la nota, e allora sono quattro correzioni.
//
// NON usa l'attributo `title` del browser: quello compare dopo un secondo
// abbondante, non si puo' impaginare, e su una griglia di 168 celle costringe
// a fermarsi su ognuna per leggerla.

import { type RefObject, useCallback, useRef, useState } from 'react';
import type { TipRow } from '../lib/chart.ts';

// Il tipo di una riga vive in 'lib/chart.ts', dove sta anche chi le costruisce.
// Si ri-esporta perche' i componenti lo chiedono a questo modulo.
export type { TipRow };

export type Tip = { left: number; top: number; title: string; rows: TipRow[] };

export type HoverTipState = {
  /** Va sul contenitore, che deve avere `position: relative`. */
  boxRef: RefObject<HTMLDivElement | null>;
  tip: Tip | null;
  /**
   * Da chiamare su `onPointerMove` dell'elemento sotto il cursore.
   *
   * Il dettaglio e' una stringa quando la lettura e' una — la mappa, la
   * heatmap, la griglia — o un elenco di righe quando sono piu' d'una. Le due
   * forme si incontrano QUI e non oltre: dentro c'e' sempre un elenco, e il
   * riquadro ha un solo modo di disegnarsi.
   */
  at: (e: { clientX: number; clientY: number }, title: string, detail: string | TipRow[]) => void;
  clear: () => void;
};

export function useHoverTip(): HoverTipState {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);

  const at = useCallback(
    (e: { clientX: number; clientY: number }, title: string, detail: string | TipRow[]) => {
      const rect = boxRef.current?.getBoundingClientRect();
      if (!rect) return;
      const rows = typeof detail === 'string' ? [{ value: detail }] : detail;
      // Coordinate RELATIVE al contenitore: quelle di pagina sbaglierebbero
      // appena qualcosa scorre.
      setTip({ left: e.clientX - rect.left, top: e.clientY - rect.top, title, rows });
    },
    [],
  );

  const clear = useCallback(() => setTip(null), []);

  return { boxRef, tip, at, clear };
}

export function HoverTip({
  tip,
  boxRef,
  width = 180,
}: {
  tip: Tip | null;
  boxRef: RefObject<HTMLDivElement | null>;
  width?: number;
}) {
  if (!tip) return null;
  // Si tiene DENTRO il riquadro: vicino al bordo destro, un tooltip che esce
  // viene tagliato proprio mentre lo si sta leggendo. Oltre meta' larghezza
  // passa a sinistra del cursore invece di restare incollato al margine.
  const boxWidth = boxRef.current?.clientWidth ?? 0;
  const left =
    boxWidth > 0 && tip.left + 12 + width > boxWidth
      ? Math.max(4, tip.left - 12 - width)
      : Math.max(4, tip.left + 12);

  // E si tiene dentro anche in ALTEZZA. Con una riga sola lo scarto fisso di
  // 48 andava sempre bene; con il totale piu' le sue parti il riquadro cresce,
  // e vicino al fondo del grafico sparirebbe sotto il bordo della scheda —
  // cioe' proprio dove i valori bassi rendono utile guardarlo.
  const boxHeight = boxRef.current?.clientHeight ?? 0;
  const height = 22 + tip.rows.length * 16;
  const wanted = tip.top - height / 2;
  const top =
    boxHeight > 0 ? Math.min(Math.max(4, wanted), Math.max(4, boxHeight - height - 4)) : Math.max(4, wanted);

  return (
    <div
      style={{
        position: 'absolute',
        left,
        top,
        maxWidth: width,
        pointerEvents: 'none',
        background: 'var(--s-overlay)',
        border: '1px solid var(--bd-strong)',
        borderRadius: 'var(--r-xs)',
        padding: '6px 9px',
        boxShadow: '0 4px 14px rgba(0,0,0,.35)',
        whiteSpace: 'nowrap',
        zIndex: 5,
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--tx-primary)' }}>{tip.title}</div>
      {tip.rows.map((row) => (
        <div
          key={`${row.label ?? ''}|${row.value}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            // I due lati della riga si separano: le etichette a sinistra, i
            // numeri a destra incolonnati. Con `tabular-nums` le cifre stanno
            // sotto le cifre, ed e' quello che rende confrontabile un elenco
            // di valori invece di un elenco di stringhe.
            justifyContent: row.label ? 'space-between' : 'flex-start',
            gap: 12,
            fontFamily: 'var(--font-mono)',
            fontSize: 11.5,
            color: 'var(--tx-secondary)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {row.label ? (
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                // `minWidth: 0` o l'ellissi non compare mai: un figlio flex
                // non scende sotto la larghezza del proprio contenuto finche'
                // non glielo si concede, e un nome di server lungo uscirebbe
                // dal riquadro invece di accorciarsi.
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {row.color ? (
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 2,
                    background: row.color,
                    flex: 'none',
                  }}
                />
              ) : null}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.label}</span>
            </span>
          ) : null}
          <span style={{ flex: 'none', color: 'var(--tx-primary)' }}>{row.value}</span>
        </div>
      ))}
    </div>
  );
}
