// Panoramica network. Segue `frontend/4-panoramica-network.dc.html`.
//
// L'ORDINE E LE POSIZIONI SONO QUELLI DEL MOCKUP, e non è pignoleria: la
// pagina è una sequenza di risposte a domande che si fanno in quell'ordine —
// quanti ce ne sono adesso, come è andata la giornata, dove stanno, quando
// vengono, chi sono, da dove.
//
//   1. intestazione: titolo e periodo
//   2. cinque KPI in riga
//   3. andamento online nel tempo, con la legenda delle modalità
//   4. distribuzione per modalità (420px) accanto alla heatmap
//   5. giocatori unici giornalieri
//   6. provenienza geografica
//
// COSA NON HA ANCORA DATI, e perché non lo si finge. «Nuovi giocatori» e
// «Record storico» richiedono l anagrafica dei giocatori; la geografia arriva
// col passo 7. Quei riquadri ci sono e dicono che il dato non è ancora
// raccolto, invece di mostrare uno zero: uno zero al posto di un dato mancante
// è la stessa bugia che il resto di questo lavoro esiste per impedire.

import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { HoverTip, useHoverTip } from '../components/hover-tip.tsx';
import { WorldMap } from '../components/world-map.tsx';
import { apiWithHeaders } from '../lib/api.ts';
import { labelOf, useRange } from '../lib/range.tsx';

type Series = {
  t: number[];
  total: (number | null)[];
  peak: (number | null)[];
  series: Record<string, (number | null)[]>;
  coverage: number[];
};

type Kpi = {
  avg: number | null;
  peak: number | null;
  peakAt: number | null;
  peakCoverage: number;
  uniques: number | null;
  coverage: number;
};

type Overview = {
  v: 2;
  range: '24h' | '7d' | '30d' | '90d' | '1y';
  tz: string;
  bucketSec: number;
  generatedAt: number;
  closedThrough: number;
  liveTail: boolean;
  deltas: number[];
  modes: string[];
  labels: Record<string, string>;
  online: Series;
  kpi: Kpi;
  heatmap: { v: number[]; w: number[]; n: number[] };
  uniques: { t: number[]; v: (number | null)[]; final: boolean[] };
  geo: { cc: string[]; v: number[]; asOf: number; exact: boolean } | null;
  current: { at: number; byMode: Record<string, number> } | null;
  geoEnabled: boolean;
  record: { players: number; at: number | null; since: number } | null;
};

/** I colori delle serie li decide l'operatore; questi sono i ripieghi. */
const FALLBACK = ['#78c1df', '#62dab6', '#d09439', '#af7ee1', '#d65179', '#85d039'];

const ROME = new Intl.DateTimeFormat('it-IT', {
  timeZone: 'Europe/Rome',
  hour: '2-digit',
  minute: '2-digit',
});

const numero = new Intl.NumberFormat('it-IT');

/** Per la data di inizio della raccolta: giorno e mese bastano. */
const giorno = new Intl.DateTimeFormat('it-IT', {
  timeZone: 'Europe/Rome',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

/**
 * Una scala LEGGIBILE per l'asse verticale.
 *
 * Prendere il massimo osservato come cima dell'asse produce tacche come 206,
 * 412, 617, 823: numeri esatti e inutilizzabili, perché nessuno legge un
 * grafico per sapere quanto vale un quarto del picco. Si arrotonda il passo a
 * 1, 2, 2,5 o 5 volte una potenza di dieci — gli unici incrementi che l'occhio
 * somma da solo — e la cima al primo multiplo sopra il massimo.
 *
 * Con 823 giocatori l'asse diventa 0, 250, 500, 750, 1.000.
 */
function niceScale(max: number, ticks = 4): { top: number; values: number[] } {
  if (!Number.isFinite(max) || max <= 0) return { top: 1, values: [0, 1] };
  const raw = max / ticks;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / magnitude;
  // Passo minimo 1: sono conteggi di PERSONE, e mezzo giocatore non esiste.
  // Senza questo pavimento, una rete quasi vuota produce tacche «0, 0, 1, 1»
  // — cioè un asse che si ripete.
  const step = Math.max(
    1,
    magnitude * (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10),
  );
  const top = Math.ceil(max / step) * step;
  const values: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) values.push(Math.round(v));
  return { top, values };
}

function hhmm(epochSec: number): string {
  return ROME.format(new Date(epochSec * 1000));
}

// ---------------------------------------------------------------------------
// 2 — i cinque KPI
// ---------------------------------------------------------------------------

type Card = {
  label: string;
  value: string;
  unit: string;
  delta: string;
  note: string;
  tone: 'ok' | 'err' | 'muted';
  /** `false` quando il dato non è ancora raccolto: la carta lo dice. */
  ready: boolean;
};

function KpiCard({ card }: { card: Card }) {
  const color = card.tone === 'ok' ? 'var(--ok)' : card.tone === 'err' ? 'var(--err)' : 'var(--tx-muted)';
  const soft =
    card.tone === 'ok' ? 'var(--ok-soft)' : card.tone === 'err' ? 'var(--err-soft)' : 'var(--s-inset)';
  return (
    <div
      style={{
        padding: 14,
        border: '1px solid var(--bd-subtle)',
        borderRadius: 'var(--r-md)',
        background: 'var(--s-surface)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: '.07em',
          textTransform: 'uppercase',
          color: 'var(--tx-muted)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {card.label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
        <span
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 26,
            fontWeight: 700,
            letterSpacing: '-.02em',
            fontVariantNumeric: 'tabular-nums',
            color: card.ready ? 'var(--tx-primary)' : 'var(--tx-disabled)',
          }}
        >
          {card.value}
        </span>
        <span style={{ fontSize: 11, color: 'var(--tx-muted)' }}>{card.unit}</span>
      </div>
      <div style={{ height: 30 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        {card.delta ? (
          <span
            style={{
              fontSize: 11.5,
              fontWeight: 600,
              padding: '2px 6px',
              borderRadius: 'var(--r-xs)',
              background: soft,
              color,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {card.delta}
          </span>
        ) : null}
        <span
          style={{
            fontSize: 11,
            color: 'var(--tx-muted)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {card.note}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3 — andamento online nel tempo
// ---------------------------------------------------------------------------

const W = 1120;
const H = 300;
const LEFT = 56;
const RIGHT = 1108;
const TOP = 16;
const BOTTOM = 268;

/** I segmenti di una serie, spezzati sui buchi: mai una linea sopra un `null`. */
function segments(values: (number | null)[], x: (i: number) => number, y: (v: number) => number): string[] {
  const out: string[] = [];
  let current: string[] = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (current.length > 1) out.push(current.join(' '));
      current = [];
      return;
    }
    current.push(`${current.length === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  });
  if (current.length > 1) out.push(current.join(' '));
  return out;
}

/** Le fasce non rilevate, come intervalli di indice contigui. */
function gaps(values: (number | null)[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start: number | null = null;
  values.forEach((v, i) => {
    if (v === null && start === null) start = i;
    if (v !== null && start !== null) {
      out.push([start, i - 1]);
      start = null;
    }
  });
  if (start !== null) out.push([start, values.length - 1]);
  return out;
}

function OnlineChart({
  data,
  hidden,
  colorOf,
}: {
  data: Overview;
  hidden: Set<string>;
  colorOf: (m: string) => string;
}) {
  const values = data.online.total;
  const n = Math.max(1, values.length);
  const observed = Math.max(
    1,
    ...values.filter((v): v is number => v !== null),
    ...data.online.peak.filter((v): v is number => v !== null),
  );
  const scale = niceScale(observed);
  const max = scale.top;
  const x = (i: number) => LEFT + ((RIGHT - LEFT) * i) / Math.max(1, n - 1);
  const y = (v: number) => BOTTOM - ((BOTTOM - TOP) * v) / max;

  const ticks = scale.values.map((v) => ({ v, y: y(v) }));
  const totalSegments = segments(values, x, y);
  const area =
    totalSegments.length > 0
      ? `${totalSegments[0]} L${x(values.length - 1).toFixed(1)},${BOTTOM} L${x(0).toFixed(1)},${BOTTOM} Z`
      : '';

  const xTickEvery = Math.max(1, Math.round(n / 8));

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ width: '100%', height: 320, display: 'block' }}
      role="img"
      aria-label="Andamento dei giocatori online nel tempo"
    >
      <defs>
        <linearGradient id="mmArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--ac)" stopOpacity="0.15" />
          <stop offset="100%" stopColor="var(--ac)" stopOpacity="0" />
        </linearGradient>
        <pattern id="mmGap" width="7" height="7" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
          <line x1="0" y1="0" x2="0" y2="7" stroke="rgba(255,255,255,.14)" strokeWidth="2" />
        </pattern>
      </defs>

      {ticks.map((t) => (
        <g key={t.y}>
          <line x1={LEFT} x2={RIGHT} y1={t.y} y2={t.y} stroke="var(--grid)" strokeWidth="1" />
          <text
            x={46}
            y={t.y}
            textAnchor="end"
            dominantBaseline="middle"
            fill="var(--tx-muted)"
            fontSize="11"
            fontFamily="JetBrains Mono"
          >
            {numero.format(Math.round(t.v))}
          </text>
        </g>
      ))}

      {/* Il buco è tratteggiato e ha un'etichetta: non si interpola, e non
          diventa uno zero. È l'unica operazione irreversibile della catena. */}
      {/*
        Solo il tratteggio, senza etichetta.

        L'etichetta diceva anche l'orario, e su un intervallo che attraversa la
        mezzanotte usciva «19:40–18:55»: corretto e illeggibile, perché senza
        la data sembra invertito. Il tratteggio da solo dice l'unica cosa che
        conta — qui non è stato rilevato niente — e il quando si legge
        dall'asse, che ce l'ha già.
      */}
      {gaps(values).map(([a, b]) => (
        <rect
          key={`gap-${a}`}
          x={x(a)}
          y={TOP}
          width={Math.max(2, x(b) - x(a))}
          height={BOTTOM - TOP}
          fill="url(#mmGap)"
        />
      ))}

      {area ? <path d={area} fill="url(#mmArea)" /> : null}
      {totalSegments.map((d) => (
        <path
          key={d.slice(0, 24)}
          d={d}
          fill="none"
          stroke="var(--ac)"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}

      {data.modes
        .filter((m) => !hidden.has(m))
        .flatMap((m) =>
          segments(data.online.series[m] ?? [], x, y).map((d) => (
            <path
              key={`${m}-${d.slice(0, 20)}`}
              d={d}
              fill="none"
              stroke={colorOf(m)}
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )),
        )}

      {data.online.t
        .map((t, i) => ({ t, i }))
        .filter(({ i }) => i % xTickEvery === 0)
        .map(({ t, i }) => (
          <text
            key={t}
            x={x(i)}
            y={288}
            textAnchor="middle"
            fill="var(--tx-muted)"
            fontSize="11"
            fontFamily="JetBrains Mono"
          >
            {hhmm(t)}
          </text>
        ))}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// 4a — distribuzione per modalità
// ---------------------------------------------------------------------------

function arc(cx: number, cy: number, r: number, inner: number, from: number, to: number): string {
  const p = (radius: number, a: number) => [cx + radius * Math.cos(a), cy + radius * Math.sin(a)];
  const [x1, y1] = p(r, from);
  const [x2, y2] = p(r, to);
  const [x3, y3] = p(inner, to);
  const [x4, y4] = p(inner, from);
  const large = to - from > Math.PI ? 1 : 0;
  return `M${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} L${x3},${y3} A${inner},${inner} 0 ${large} 0 ${x4},${y4} Z`;
}

function Distribution({
  data,
  onlineNow,
  colorOf,
}: {
  data: Overview;
  onlineNow: number | null;
  colorOf: (m: string) => string;
}) {
  // DAL DATO SUO, non dalla serie del range.
  //
  // Questo riquadro è l'unico che il selettore in alto non governa: risponde a
  // «chi c'è adesso». Prendendo l'ultimo punto della serie selezionata cambiava
  // scegliendo un altro periodo — e su un anno quell'ultimo punto è la media di
  // un giorno intero, presentata come popolazione corrente.
  const slices = data.modes
    .map((m) => ({ key: m, value: data.current?.byMode[m] ?? 0 }))
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value);
  const total = slices.reduce((a, s) => a + s.value, 0);

  let angle = -Math.PI / 2;
  const paths = slices.map((s) => {
    const span = total > 0 ? (s.value / total) * Math.PI * 2 : 0;
    const d = arc(90, 90, 84, 58, angle, angle + span);
    angle += span;
    return { key: s.key, d, value: s.value };
  });

  const hover = useHoverTip();

  return (
    <section
      style={{
        border: '1px solid var(--bd-subtle)',
        borderRadius: 'var(--r-lg)',
        background: 'var(--s-surface)',
        padding: '18px 20px',
      }}
    >
      <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 600, margin: '0 0 4px' }}>
        Distribuzione per modalità
      </h3>
      <div style={{ fontSize: 12, color: 'var(--tx-muted)', marginBottom: 16 }}>
        Popolazione corrente · {numero.format(Math.round(total))} giocatori
        {data.current ? ` · ${hhmm(data.current.at)}` : ''}. «Non classificata» raccoglie i server non ancora
        tracciati.
      </div>
      <div
        ref={hover.boxRef}
        onPointerLeave={hover.clear}
        style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 20 }}
      >
        <HoverTip tip={hover.tip} boxRef={hover.boxRef} />
        <svg viewBox="0 0 180 180" style={{ width: 180, height: 180, flex: 'none' }} aria-hidden="true">
          {paths.map((p) => (
            <path
              key={p.key}
              d={p.d}
              fill={colorOf(p.key)}
              onPointerMove={(e) =>
                hover.at(
                  e,
                  data.labels[p.key] ?? p.key,
                  `${numero.format(Math.round(p.value))} giocatori · ${
                    total > 0 ? ((p.value / total) * 100).toFixed(1).replace('.', ',') : '—'
                  }%`,
                )
              }
            />
          ))}
          <text x="90" y="86" textAnchor="middle" fill="var(--tx-primary)" fontSize="26" fontWeight="700">
            {onlineNow === null ? '—' : numero.format(onlineNow)}
          </text>
          <text x="90" y="104" textAnchor="middle" fill="var(--tx-muted)" fontSize="11">
            online adesso
          </text>
        </svg>
        {/*
          Si ferma all'altezza della ciambella e poi scorre.

          Con sette modalità la lista sfonderebbe il riquadro e spingerebbe giù
          la heatmap che ha accanto, disallineando le due colonne. 180px sono
          esattamente l'altezza della ciambella: le due metà restano allineate
          qualunque sia il numero di modalità, che è ignoto e cresce.
        */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            maxHeight: 180,
            overflowY: 'auto',
            paddingRight: 4,
          }}
        >
          {slices.length === 0 ? (
            <span style={{ fontSize: 12.5, color: 'var(--tx-muted)' }}>
              Nessuna misura ancora: il campionamento non ha prodotto bucket chiusi.
            </span>
          ) : (
            slices.map((s) => (
              <div key={s.key}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      width: 9,
                      height: 9,
                      borderRadius: 2,
                      background: colorOf(s.key),
                      flex: 'none',
                    }}
                  />
                  <span style={{ fontSize: 12.5, fontWeight: 500 }}>{data.labels[s.key] ?? s.key}</span>
                  <span
                    className="mono"
                    style={{ marginLeft: 'auto', fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}
                  >
                    {numero.format(Math.round(s.value))}
                  </span>
                </div>
                <div
                  style={{
                    display: 'flex',
                    gap: 8,
                    marginLeft: 17,
                    marginTop: 2,
                    fontSize: 11,
                    color: 'var(--tx-muted)',
                  }}
                >
                  <span>{total > 0 ? `${((s.value / total) * 100).toFixed(1)}%` : '—'}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 4b — heatmap di affluenza
// ---------------------------------------------------------------------------

const GIORNI = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'];
/** Le ventiquattro ore come VALORI: la cella è identificata dall'ora, non dalla posizione. */
const HOURS = Array.from({ length: 24 }, (_, h) => h);

function Heatmap({ data, label }: { data: Overview; label: string }) {
  const hover = useHoverTip();
  const { v, w, n } = data.heatmap;
  // TRE array, mai la media già divisa. Nei giorni di cambio ora una cella
  // locale ha zero occorrenze (l'ora saltata di marzo) o due (quella ripetuta
  // di ottobre): con la sola media quella cella mente e nessuno può
  // accorgersene guardandola.
  const cells = v.map((num, i) => {
    const den = w[i] ?? 0;
    return { avg: den > 0 ? num / den : null, occurrences: n[i] ?? 0, coverage: den };
  });
  const max = Math.max(1, ...cells.map((c) => c.avg ?? 0));

  const colour = (c: (typeof cells)[number]): string => {
    if (c.occurrences === 0) return 'var(--s-inset)';
    if (c.avg === null) return 'var(--s-inset)';
    const f = Math.min(1, c.avg / max);
    // La stessa scala del design: dal fondo scuro all'accento.
    const stops = ['#0F212A', '#1E5670', '#8A7147', '#F0A63F'];
    const i = Math.min(stops.length - 2, Math.floor(f * (stops.length - 1)));
    return f <= 0 ? (stops[0] as string) : ((f >= 1 ? stops[3] : stops[i + 1]) as string);
  };

  return (
    <section
      style={{
        border: '1px solid var(--bd-subtle)',
        borderRadius: 'var(--r-lg)',
        background: 'var(--s-surface)',
        padding: '18px 20px',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          marginBottom: 16,
        }}
      >
        <div>
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 600, margin: '0 0 4px' }}>
            Heatmap di affluenza
          </h3>
          <div style={{ fontSize: 12, color: 'var(--tx-muted)' }}>
            Media giocatori online · {label} su griglia 7×24 · Europe/Rome
          </div>
        </div>
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--tx-muted)' }}
        >
          <span>0</span>
          <span
            style={{
              width: 96,
              height: 8,
              borderRadius: 4,
              background: 'linear-gradient(90deg,#0F212A,#1E5670,#8A7147,#F0A63F)',
            }}
          />
          <span>{numero.format(Math.round(max))}</span>
        </div>
      </div>
      <div
        ref={hover.boxRef}
        onPointerLeave={hover.clear}
        style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 3 }}
      >
        <HoverTip tip={hover.tip} boxRef={hover.boxRef} />
        {GIORNI.map((giorno, row) => (
          <div key={giorno} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 28, fontSize: 11, color: 'var(--tx-muted)', flex: 'none' }}>{giorno}</span>
            <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(24, 1fr)', gap: 3 }}>
              {HOURS.map((hour) => {
                const c = cells[row * 24 + hour] as (typeof cells)[number];
                return (
                  <div
                    key={`${giorno}-${hour}`}
                    onPointerMove={(e) =>
                      hover.at(
                        e,
                        `${giorno} ${String(hour).padStart(2, '0')}:00`,
                        c.occurrences === 0
                          ? "ora inesistente per il cambio d'ora"
                          : c.avg === null
                            ? 'non rilevato'
                            : `${numero.format(Math.round(c.avg))} giocatori`,
                      )
                    }
                    style={{ height: 20, borderRadius: 3, background: colour(c) }}
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
    </section>
  );
}

// ---------------------------------------------------------------------------
// 5 — giocatori unici giornalieri
// ---------------------------------------------------------------------------

const GIORNO_MESE = new Intl.DateTimeFormat('it-IT', {
  timeZone: 'Europe/Rome',
  day: '2-digit',
  month: '2-digit',
});

function DailyUniques({ data, label }: { data: Overview; label: string }) {
  const hover = useHoverTip();
  const { t, v, final } = data.uniques;
  const scale = niceScale(Math.max(1, ...v.filter((x): x is number => x !== null)), 2);
  const max = scale.top;

  const W2 = 1000;
  const H2 = 240;
  const L2 = 44;
  const B2 = 210;
  const T2 = 20;
  const x = (i: number) => L2 + ((W2 - L2 - 10) * (i + 0.5)) / Math.max(1, v.length);
  const y = (n: number) => B2 - ((B2 - T2) * n) / max;
  const barW = Math.max(3, ((W2 - L2 - 10) / Math.max(1, v.length)) * 0.7);

  return (
    <section
      style={{
        border: '1px solid var(--bd-subtle)',
        borderRadius: 'var(--r-lg)',
        background: 'var(--s-surface)',
        padding: '18px 20px',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          marginBottom: 14,
        }}
      >
        <div>
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 600, margin: '0 0 4px' }}>
            Giocatori unici
          </h3>
          <div style={{ fontSize: 12, color: 'var(--tx-muted)' }}>{label} · Europe/Rome</div>
        </div>
        <div style={{ display: 'flex', gap: 14, fontSize: 11.5, color: 'var(--tx-secondary)' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--ac)' }} />
            Unici del giorno
          </span>
        </div>
      </div>

      {v.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--tx-muted)', padding: '24px 0' }}>
          Nessun giorno chiuso ancora: il primo punto compare domani.
        </div>
      ) : (
        <div ref={hover.boxRef} onPointerLeave={hover.clear} style={{ position: 'relative' }}>
          <HoverTip tip={hover.tip} boxRef={hover.boxRef} />
          <svg
            viewBox={`0 0 ${W2} ${H2}`}
            preserveAspectRatio="none"
            style={{ width: '100%', height: 240, display: 'block' }}
            role="img"
            aria-label="Giocatori unici per giorno"
          >
            {scale.values.map((tick) => (
              <g key={tick}>
                <line x1={L2} x2={W2} y1={y(tick)} y2={y(tick)} stroke="var(--grid)" />
                <text
                  x={36}
                  y={y(tick) + 4}
                  textAnchor="end"
                  fill="var(--tx-muted)"
                  fontSize="11"
                  fontFamily="JetBrains Mono"
                >
                  {numero.format(tick)}
                </text>
              </g>
            ))}

            {v.map((n, i) => (
              /* Una fascia INVISIBILE a tutta altezza per ogni giorno: puntare
               una barra alta dieci pixel e' un esercizio di mira, e i giorni
               senza dato non avrebbero nulla da puntare. */
              <rect
                key={`hit-${t[i]}`}
                x={x(i) - barW / 2 - 1}
                y={T2}
                width={barW + 2}
                height={B2 - T2}
                fill="transparent"
                onPointerMove={(e) =>
                  hover.at(
                    e,
                    GIORNO_MESE.format(new Date((t[i] as number) * 1000)),
                    n === null ? 'non rilevato' : `${numero.format(n)} giocatori`,
                  )
                }
              />
            ))}

            {v.map((n, i) =>
              n === null ? null : (
                <rect
                  key={t[i]}
                  x={x(i) - barW / 2}
                  y={y(n)}
                  width={barW}
                  height={Math.max(0, B2 - y(n))}
                  rx="2"
                  fill="var(--ac)"
                  pointerEvents="none"
                  /* Il giorno ancora aperto è più chiaro: il suo numero deve
                   ancora salire, e mostrarlo pieno accanto ai definitivi
                   suggerisce un calo che non c'è. */
                  opacity={final[i] ? 1 : 0.45}
                />
              ),
            )}

            <text x={L2} y={232} fill="var(--tx-muted)" fontSize="11" fontFamily="JetBrains Mono">
              {t.length > 0 ? GIORNO_MESE.format(new Date((t[0] as number) * 1000)) : ''}
            </text>
            <text
              x={W2 - 20}
              y={232}
              textAnchor="end"
              fill="var(--tx-muted)"
              fontSize="11"
              fontFamily="JetBrains Mono"
            >
              {t.length > 0 ? GIORNO_MESE.format(new Date((t[t.length - 1] as number) * 1000)) : ''}
            </text>
          </svg>
        </div>
      )}

      {/* Cio' che manca si dichiara, invece di dividere il totale a caso. */}
      <div style={{ fontSize: 11.5, color: 'var(--tx-muted)', marginTop: 10 }}>
        La divisione fra nuovi e di ritorno richiede l’anagrafica dei giocatori, che non è ancora raccolta.
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 6 — quel che il passo 7 deve ancora portare
// ---------------------------------------------------------------------------

function NotYet({ title, sub, what }: { title: string; sub: string; what: React.ReactNode }) {
  return (
    <section
      style={{
        border: '1px solid var(--bd-subtle)',
        borderRadius: 'var(--r-lg)',
        background: 'var(--s-surface)',
        padding: '18px 20px',
      }}
    >
      <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 600, margin: '0 0 4px' }}>
        {title}
      </h3>
      <div style={{ fontSize: 12, color: 'var(--tx-muted)', marginBottom: 16 }}>{sub}</div>
      <div
        style={{
          border: '1px dashed var(--bd-strong)',
          borderRadius: 'var(--r-md)',
          background: 'repeating-linear-gradient(135deg,var(--s-inset) 0 8px,var(--s-elevated) 8px 16px)',
          minHeight: 200,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          padding: 20,
        }}
      >
        <div className="mono" style={{ fontSize: 11.5, lineHeight: '19px', color: 'var(--tx-muted)' }}>
          {what}
          <br />
          <span style={{ color: 'var(--tx-disabled)' }}>
            il riquadro resta vuoto finché il dato non è raccolto: uno zero al posto di un dato mancante
            sarebbe una bugia
          </span>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------

export function OverviewPage() {
  const { range } = useRange();
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const q = useQuery({
    // La chiave PORTA il periodo: senza, cambiando selettore react-query
    // servirebbe la risposta gia' in cache per un altro intervallo, e la
    // pagina mostrerebbe i numeri di prima sotto l'etichetta nuova.
    queryKey: ['stats-overview', range],
    queryFn: () => apiWithHeaders<Overview>(`/api/stats/overview?range=${range}`),
    refetchInterval: 60_000,
  });

  const data = q.data?.data;
  const onlineNow = q.data?.headers.get('X-Online-Now');
  const onlineAt = q.data?.headers.get('X-Online-Now-At');

  const colorOf = useMemo(() => {
    const assigned = new Map<string, string>();
    (data?.modes ?? []).forEach((m, i) => {
      assigned.set(m, FALLBACK[i % FALLBACK.length] as string);
    });
    return (m: string) => assigned.get(m) ?? 'var(--tx-muted)';
  }, [data?.modes]);

  if (q.isError) {
    return (
      <div style={{ padding: 24, fontSize: 13, color: 'var(--tx-secondary)' }}>
        Le statistiche non sono disponibili. Se il pannello è appena stato aggiornato, manca
        <span className="mono"> DATABASE_STATS_URL</span>: le rotte rispondono 503 finché non c’è il ruolo di
        sola lettura.
      </div>
    );
  }
  if (!data) return <div style={{ padding: 24 }} />;

  // LE CINQUE DEL DESIGN, nello stesso ordine e con le stesse etichette.
  //
  // Tre non hanno ancora un dato: unici e nuovi arrivano dalle sessioni
  // (passo 6), il record storico da una query su tutto lo storico che non
  // esiste ancora. Mostrano «—» e dicono cosa manca. Sostituirle con carte
  // che ho a disposizione — media, copertura — sarebbe stato comodo e
  // sbagliato: la pagina va confrontata col design, e due carte diverse
  // rendono il confronto impossibile a chiunque non le abbia scritte.
  const oggi = data.uniques.v.length > 0 ? (data.uniques.v[data.uniques.v.length - 1] ?? null) : null;

  const cards: Card[] = [
    {
      label: 'Giocatori online ora',
      value: onlineNow ? numero.format(Number(onlineNow)) : '—',
      unit: 'gioc.',
      delta: '',
      note: onlineAt ? `rilevato alle ${hhmm(Number(onlineAt))}` : 'nessun ciclo recente',
      tone: 'muted',
      ready: Boolean(onlineNow),
    },
    {
      label: 'Picco del periodo',
      value: data.kpi.peak === null ? '—' : numero.format(data.kpi.peak),
      unit: 'gioc.',
      // Il massimo non viaggia mai da solo: senza il suo istante e la
      // copertura del bucket in cui e' avvenuto non e' verificabile.
      delta: '',
      note: data.kpi.peakAt ? `alle ${hhmm(data.kpi.peakAt)}` : 'nessun bucket chiuso',
      tone: 'muted',
      ready: data.kpi.peak !== null,
    },
    {
      label: 'Giocatori unici',
      value: oggi === null ? '—' : numero.format(oggi),
      unit: 'gioc.',
      delta: '',
      // Il giorno in corso non e' definitivo: dirlo evita che qualcuno lo
      // annoti come il totale della giornata a meta' pomeriggio.
      note: oggi === null ? 'nessun giorno con dati' : 'giorno in corso',
      tone: 'muted',
      ready: oggi !== null,
    },
    {
      label: 'Nuovi giocatori oggi',
      value: '—',
      unit: 'gioc.',
      delta: '',
      note: 'anagrafica non ancora raccolta',
      tone: 'muted',
      ready: false,
    },
    {
      label: 'Record storico',
      value: data.record ? numero.format(data.record.players) : '—',
      unit: 'gioc.',
      delta: '',
      // DA QUANDO, sempre. Un «record di sempre» calcolato su tre giorni di
      // raccolta e` un record di tre giorni, e chi lo legge non ha modo di
      // saperlo dal numero. Il giorno in cui lo storico sara` lungo, questa
      // nota smettera` di essere una precisazione e diventera` un vanto.
      note: data.record
        ? `dal ${giorno.format(new Date(data.record.since * 1000))}`
        : 'nessun giorno con dati',
      tone: 'muted',
      ready: data.record !== null,
    },
  ];

  return (
    <main style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 20 }}>
        <div>
          <h2
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 22,
              lineHeight: '30px',
              fontWeight: 700,
              letterSpacing: '-.01em',
              margin: '0 0 5px',
            }}
          >
            Panoramica network
          </h2>
          <div style={{ fontSize: 12.5, color: 'var(--tx-muted)' }}>
            Ultime 24 ore · fuso Europe/Rome · aggiornato{' '}
            <span className="mono">{hhmm(data.generatedAt)}</span>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12 }}>
        {cards.map((c) => (
          <KpiCard key={c.label} card={c} />
        ))}
      </div>

      <section
        style={{
          border: '1px solid var(--bd-subtle)',
          borderRadius: 'var(--r-lg)',
          background: 'var(--s-surface)',
          overflow: 'hidden',
        }}
      >
        <div style={{ padding: '18px 20px 14px' }}>
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 600, margin: '0 0 4px' }}>
            Andamento online nel tempo
          </h3>
          <div style={{ fontSize: 12, color: 'var(--tx-muted)' }}>
            Giocatori connessi · {labelOf(range)} (
            {data.online.t.length > 0 ? hhmm(data.online.t[0] as number) : '—'}–
            {data.online.t.length > 0 ? hhmm(data.online.t[data.online.t.length - 1] as number) : '—'},
            Europe/Rome) · copertura {Math.round(data.kpi.coverage * 100)}%
          </div>
        </div>
        <div
          style={{ display: 'flex', gap: 16, padding: '0 20px 6px', flexWrap: 'wrap', alignItems: 'center' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, fontWeight: 600 }}>
            <span style={{ width: 18, height: 3, borderRadius: 2, background: 'var(--ac)' }} />
            Totale network
          </div>
          {data.modes.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() =>
                setHidden((prev) => {
                  const next = new Set(prev);
                  if (next.has(m)) next.delete(m);
                  else next.add(m);
                  return next;
                })
              }
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                border: 'none',
                background: 'none',
                padding: 0,
                cursor: 'pointer',
                fontSize: 12,
                color: 'var(--tx-secondary)',
                opacity: hidden.has(m) ? 0.35 : 1,
              }}
            >
              <span style={{ width: 18, height: 3, borderRadius: 2, background: colorOf(m) }} />
              {data.labels[m] ?? m}
            </button>
          ))}
        </div>
        <OnlineChart data={data} hidden={hidden} colorOf={colorOf} />
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: '420px 1fr', gap: 16 }}>
        <Distribution data={data} onlineNow={onlineNow ? Number(onlineNow) : null} colorOf={colorOf} />
        <Heatmap data={data} label={labelOf(range)} />
      </div>

      <DailyUniques data={data} label={labelOf(range)} />

      {/*
        La mappa compare SOLO quando c'e' qualcosa da mostrare.

        `geo: null` significa geolocalizzazione non attiva, ed e' diverso da
        una mappa tutta `XX`: la prima e' una funzione spenta, la seconda una
        funzione accesa che non risolve — cioe' un guasto, e va visto.
      */}
      {data.geo ? (
        <WorldMap geo={data.geo} label={labelOf(range)} />
      ) : (
        <NotYet
          title="Provenienza geografica"
          sub={`Giocatori unici · ${labelOf(range)} · scala per quantili, non lineare`}
          what={
            data.geoEnabled
              ? 'nessun giocatore ancora registrato con un paese, oggi'
              : 'geolocalizzazione non attiva'
          }
        />
      )}
    </main>
  );
}
