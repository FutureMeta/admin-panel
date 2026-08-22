// La griglia 7×24, condivisa fra le statistiche e i duels.
//
// NASCE DA `Heatmap` delle statistiche e la sostituisce dentro di essa: due
// griglie identiche disegnate da due file diversi vuol dire che fra un mese
// una ha il tratteggio sulle celle non coperte e l'altra no, e nessuno se ne
// accorge finché qualcuno non le mette una accanto all'altra.
//
// COSA NON SA: che cosa conta. Le statistiche ci mettono una media di
// giocatori, i duels un conteggio di partite; la griglia riceve 168 celle già
// decise e un tetto per l'intensità, e disegna.
//
// TRE STATI PER UNA CELLA, e vanno distinti a vista:
//   * `null` = FUORI PERIODO o prima dell'inizio della raccolta. Tratteggiata.
//   * `0` = coperta e vuota. Fondo pieno, il primo gradino della rampa.
//   * `n` = coperta e piena.
// Disegnare `null` e `0` allo stesso modo direbbe che di domenica alle tre non
// gioca nessuno, quando domenica non è nemmeno nell'intervallo scelto.

import { HEAT_GRADIENT, heatColour } from '../lib/heat.ts';
import { HoverTip, useHoverTip } from './hover-tip.tsx';

export const WEEKDAYS = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'] as const;
/** Le ventiquattro ore come VALORI: la cella è identificata dall'ora, non dalla posizione. */
const HOURS = Array.from({ length: 24 }, (_, h) => h);

export type HeatCell = number | null;

export function HeatGrid({
  cells,
  top,
  tipOf,
  ariaLabel,
}: {
  /** 168 celle, indice = giorno × 24 + ora, giorno 0 = LUNEDÌ. */
  cells: HeatCell[];
  /** Il tetto dell'intensità. Oltre, la cella resta al massimo. */
  top: number;
  tipOf: (weekday: string, hour: number, value: HeatCell) => { title: string; detail: string };
  ariaLabel: string;
}) {
  const hover = useHoverTip();

  return (
    <div
      ref={hover.boxRef}
      onPointerLeave={hover.clear}
      role="img"
      aria-label={ariaLabel}
      style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 3 }}
    >
      <HoverTip tip={hover.tip} boxRef={hover.boxRef} />
      {WEEKDAYS.map((weekday, row) => (
        <div key={weekday} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 28, fontSize: 11, color: 'var(--tx-muted)', flex: 'none' }}>{weekday}</span>
          <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(24, 1fr)', gap: 3 }}>
            {HOURS.map((hour) => {
              const value = cells[row * 24 + hour] ?? null;
              return (
                <div
                  key={`${weekday}-${hour}`}
                  onPointerMove={(e) => {
                    const t = tipOf(weekday, hour, value);
                    hover.at(e, t.title, t.detail);
                  }}
                  style={{
                    height: 20,
                    borderRadius: 3,
                    background: heatColour(value, top),
                    // Il tratteggio è ciò che distingue «non c'è dato» da
                    // «zero»: senza, le due celle sono lo stesso rettangolo
                    // scuro e la differenza vive solo nel tooltip.
                    ...(value === null
                      ? {
                          backgroundImage:
                            'repeating-linear-gradient(45deg, transparent 0 3px, var(--bd-subtle) 3px 4px)',
                          backgroundColor: 'var(--s-inset)',
                        }
                      : {}),
                  }}
                />
              );
            })}
          </div>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <span style={{ width: 28, flex: 'none' }} />
        <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)' }}>
          {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => (
            <span key={h} className="mono" style={{ fontSize: 10.5, color: 'var(--tx-muted)' }}>
              {String(h).padStart(2, '0')}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** La legenda: due estremi e la rampa in mezzo. */
export function HeatLegend({ top }: { top: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--tx-muted)' }}>
      <span>0</span>
      <span style={{ width: 96, height: 8, borderRadius: 4, background: HEAT_GRADIENT }} />
      <span>{top}</span>
    </div>
  );
}
