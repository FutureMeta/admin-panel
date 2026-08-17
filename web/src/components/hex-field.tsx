// Campo di esagoni del brand.
//
// La geometria è quella del prototipo, non una approssimazione: raggio 46,
// passo orizzontale r*1.5 e verticale r*√3, colonne dispari sfalsate di mezzo
// passo, angoli a 60° partendo da 0 (esagoni "a punta orizzontale").
//
// L'intensità cala con la distanza da (300, 420): il motivo è più fitto
// vicino al lockup e svanisce ai bordi, invece di riempire la superficie in
// modo uniforme — che è la differenza fra uno sfondo e una texture.
//
// Il pattern è deterministico: due render danno lo stesso disegno, e nessuna
// cella "balla" quando React ridisegna.

import { useMemo } from 'react';

export type HexFieldProps = {
  /** viewBox su cui il campo viene calcolato. */
  width?: number;
  height?: number;
  opacity?: number;
};

export function HexField({ width = 720, height = 840, opacity = 1 }: HexFieldProps) {
  const polygons = useMemo(() => {
    const out: Array<{ points: string; fill: string; stroke: string }> = [];
    const r = 46;
    const dx = r * 1.5;
    const dy = r * Math.sqrt(3);
    const cols = Math.ceil(width / dx) + 2;
    const rows = Math.ceil(height / dy) + 2;

    for (let c = -1; c < cols; c += 1) {
      for (let row = -1; row < rows; row += 1) {
        const cx = c * dx;
        const cy = row * dy + (c % 2 ? dy / 2 : 0);
        const pts: string[] = [];
        for (let i = 0; i < 6; i += 1) {
          const a = (Math.PI / 180) * (60 * i);
          pts.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`);
        }
        const d = Math.hypot(cx - 300, cy - 420) / 620;
        const t = Math.max(0, 1 - d);
        const seed = (c * 7 + row * 13) % 11;
        const accent = seed === 0 || seed === 6;
        out.push({
          points: pts.join(' '),
          fill: accent
            ? `rgba(219,110,25,${(0.05 * t).toFixed(3)})`
            : `rgba(36,120,161,${(0.045 * t).toFixed(3)})`,
          stroke: accent
            ? `rgba(219,110,25,${(0.16 * t).toFixed(3)})`
            : `rgba(255,255,255,${(0.05 * t).toFixed(3)})`,
        });
      }
    }
    return out;
  }, [width, height]);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid slice"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity }}
      aria-hidden="true"
    >
      {polygons.map((p) => (
        <polygon key={p.points} points={p.points} fill={p.fill} stroke={p.stroke} strokeWidth="1" />
      ))}
    </svg>
  );
}
