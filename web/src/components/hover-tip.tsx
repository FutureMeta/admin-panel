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

export type Tip = { left: number; top: number; title: string; detail: string };

export type HoverTipState = {
  /** Va sul contenitore, che deve avere `position: relative`. */
  boxRef: RefObject<HTMLDivElement | null>;
  tip: Tip | null;
  /** Da chiamare su `onPointerMove` dell'elemento sotto il cursore. */
  at: (e: { clientX: number; clientY: number }, title: string, detail: string) => void;
  clear: () => void;
};

export function useHoverTip(): HoverTipState {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);

  const at = useCallback((e: { clientX: number; clientY: number }, title: string, detail: string) => {
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Coordinate RELATIVE al contenitore: quelle di pagina sbaglierebbero
    // appena qualcosa scorre.
    setTip({ left: e.clientX - rect.left, top: e.clientY - rect.top, title, detail });
  }, []);

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

  return (
    <div
      style={{
        position: 'absolute',
        left,
        top: Math.max(4, tip.top - 48),
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
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11.5,
          color: 'var(--tx-secondary)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {tip.detail}
      </div>
    </div>
  );
}
