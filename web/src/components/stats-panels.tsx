// I riquadri delle statistiche, condivisi fra panoramica e dettaglio.
//
// STAVANO DENTRO `overview.tsx`, e ci sono rimasti finche' c'era una schermata
// sola. Con la seconda la scelta era duplicarli o spostarli: due copie dello
// stesso grafico divergono al primo ritocco, e divergono in silenzio — la
// panoramica corretta e il dettaglio no, o viceversa, senza che niente lo
// dica. E' la stessa classe di difetti che ha tenuto vuoto il range 1y per un
// giorno intero.
//
// Nessun riquadro qui dentro sa da quale schermata sia chiamato. Ricevono il
// payload e cosa disegnare; il titolo e il sottotitolo li decide chi li usa,
// perche' «Media giocatori online» e «Media giocatori online su Towny» sono la
// stessa cosa detta a due livelli diversi.

import type React from 'react';
import { gaps, liveSplit, niceScale, readingsAt, segments } from '../lib/chart.ts';
import type { Slice } from '../lib/distribution.ts';
import { arc } from '../lib/donut.ts';
import { numberFmt, shareLabel } from '../lib/format.ts';
import { CHART, ChartFrame } from './chart-frame.tsx';
import { HeatGrid, HeatLegend } from './heat-grid.tsx';
import { HoverTip, useHoverTip } from './hover-tip.tsx';

export type Series = {
  t: number[];
  total: (number | null)[];
  peak: (number | null)[];
  series: Record<string, (number | null)[]>;
  coverage: number[];
};

export type Kpi = {
  avg: number | null;
  peak: number | null;
  peakAt: number | null;
  peakCoverage: number;
  uniques: number | null;
  coverage: number;
};

export type Overview = {
  v: 3;
  range: '24h' | '7d' | '30d' | '90d' | '1y';
  tz: string;
  bucketSec: number;
  generatedAt: number;
  closedThrough: number;
  liveTail: boolean;
  deltas: number[];
  modes: string[];
  /** TUTTE le modalità conosciute, non solo quelle presenti in `modes`. */
  labels: Record<string, string>;
  /** I colori decisi dall'operatore. Assente = ripiego, su ordine stabile. */
  colors: Record<string, string>;
  /** Serie da non accendere all'apertura. Nessun totale cambia. */
  hidden: string[];
  /** Modalità che non sono una fetta della ripartizione. */
  outOfBreakdown: string[];
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
export const FALLBACK = ['#78c1df', '#62dab6', '#d09439', '#af7ee1', '#d65179', '#85d039'];

const ROME = new Intl.DateTimeFormat('it-IT', {
  timeZone: 'Europe/Rome',
  hour: '2-digit',
  minute: '2-digit',
});

// Il formattatore vive in `lib/format.ts`: ce n'e' uno solo per il pannello.
// Si ri-esporta perche' mezza interfaccia lo chiede a questo modulo.
export { numberFmt } from '../lib/format.ts';

/** Per la data di inizio della raccolta: giorno e mese bastano. */
export const dayFmt = new Intl.DateTimeFormat('it-IT', {
  timeZone: 'Europe/Rome',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

export function hhmm(epochSec: number): string {
  return ROME.format(new Date(epochSec * 1000));
}

// ---------------------------------------------------------------------------
// 2 — i KPI
// ---------------------------------------------------------------------------

export type Card = {
  label: string;
  value: string;
  unit: string;
  delta: string;
  note: string;
  tone: 'ok' | 'err' | 'muted';
  /** `false` quando il dato non è ancora raccolto: la carta lo dice. */
  ready: boolean;
};

export function KpiCard({ card }: { card: Card }) {
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

// IL TELAIO E' CONDIVISO, e ormai non resta nemmeno una misura qui.
//
// Per un po' questo file disegnava il proprio `<svg>` con la propria griglia e
// le proprie etichette, e i grafici dei duels ne avevano altri due: stessa
// figura, tre geometrie, e le tre divergevano — 1120×300 con le ore a venti
// unità dal fondo, 1120×268 con le ore a due, 1120×246 senza ore affatto.
// Adesso c'è un telaio solo (`chart-frame.tsx`) e ogni grafico gli passa
// l'altezza del proprio tracciato e disegna dentro.
/** Il fondo del tracciato. Sotto ci sono le 32 unità della banda dell'asse. */
const BOTTOM = 268;

export function OnlineChart({
  data,
  hidden,
  colorOf,
  parts,
}: {
  data: Overview;
  hidden: Set<string>;
  colorOf: (m: string) => string;
  /**
   * Cosa disegnare SOTTO il totale, quando non sono le modalità.
   *
   * La panoramica scompone la rete per modalità e non passa niente; il
   * dettaglio scompone una modalità per server e passa le sue righe. È la
   * stessa figura a due livelli — un totale e le sue parti — quindi è lo
   * stesso disegno, e il grafico non ha bisogno di sapere di cosa si tratti.
   */
  parts?: { keys: string[]; series: Record<string, (number | null)[]> } | undefined;
}) {
  const lines = parts ?? { keys: data.modes, series: data.online.series };
  const values = data.online.total;
  const points = Math.max(1, values.length);
  const observed = Math.max(
    1,
    ...values.filter((v): v is number => v !== null),
    ...data.online.peak.filter((v): v is number => v !== null),
  );
  const scale = niceScale(observed);

  return (
    // LO STESSO TELAIO DEI GRAFICI DUELS. Prima questo componente disegnava il
    // proprio `<svg>`, la propria griglia e le proprie etichette: tre grafici,
    // tre geometrie, e le tre divergevano. Adesso margini, banda dell'asse,
    // carattere delle etichette, linea sotto il cursore e tooltip stanno in un
    // posto solo, e qui resta cio' che e' davvero di questo grafico — il
    // tratteggio dei buchi, l'area del totale e le righe delle sue parti.
    <ChartFrame
      plot={BOTTOM}
      top={scale.top}
      t={data.online.t}
      yTicks={scale.values.map((v) => ({ value: v, label: numberFmt.format(Math.round(v)) }))}
      ariaLabel="Andamento dei giocatori online nel tempo"
      readingsOf={(i) =>
        readingsAt({
          index: i,
          total: values,
          parts: lines,
          hidden,
          colorOf,
          labels: data.labels,
          format: (v) => numberFmt.format(v),
        })
      }
    >
      {({ x, y, bottom }, hovered) => {
        // L'ultimo bucket e' ancora aperto: si disegna tratteggiato, o la sua
        // media parziale si legge come un crollo. Vedi `liveSplit`.
        const split = liveSplit(values, data.liveTail);
        const totalSegments = segments(split.solid, x, y);
        const liveSegments = segments(split.live, x, y);
        const area =
          totalSegments.length > 0
            ? `${totalSegments[0]} L${x(points - 1).toFixed(1)},${bottom} L${x(0).toFixed(1)},${bottom} Z`
            : '';
        const marked = hovered === null ? null : (values[hovered] ?? null);

        return (
          <>
            <defs>
              <linearGradient id="mmArea" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--ac)" stopOpacity="0.15" />
                <stop offset="100%" stopColor="var(--ac)" stopOpacity="0" />
              </linearGradient>
              <pattern
                id="mmGap"
                width="7"
                height="7"
                patternTransform="rotate(45)"
                patternUnits="userSpaceOnUse"
              >
                <line x1="0" y1="0" x2="0" y2="7" stroke="rgba(255,255,255,.14)" strokeWidth="2" />
              </pattern>
            </defs>

            {/*
              Solo il tratteggio, senza etichetta.

              L'etichetta diceva anche l'orario, e su un intervallo che
              attraversa la mezzanotte usciva «19:40–18:55»: corretto e
              illeggibile, perché senza la data sembra invertito. Il tratteggio
              da solo dice l'unica cosa che conta — qui non è stato rilevato
              niente — e il quando si legge dall'asse, che ce l'ha già.

              IL BUCKET IN CORSO NE RESTA FUORI, e non è un dettaglio: nei
              primi minuti può non avere ancora nessun campione aggregato, e
              tratteggiarlo direbbe «non rilevato» di un'ora che si sta
              rilevando proprio adesso. Sono due cose diverse — «non c'è» e
              «non ancora» — e il tratteggio sa dire solo la prima.
            */}
            {gaps(data.liveTail ? values.slice(0, -1) : values).map(([a, b]) => (
              <rect
                key={`gap-${a}`}
                x={x(a)}
                y={CHART.TOP}
                width={Math.max(2, x(b) - x(a))}
                height={bottom - CHART.TOP}
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

            {liveSegments.map((d) => (
              <path
                key={`live-${d.slice(0, 24)}`}
                d={d}
                fill="none"
                stroke="var(--ac)"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray="5 4"
              />
            ))}

            {lines.keys
              .filter((m) => !hidden.has(m))
              .flatMap((m) =>
                segments(lines.series[m] ?? [], x, y).map((d) => (
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

            {/* Il punto sotto il cursore, solo dove un valore c'è: su un
                bucket non rilevato non si marca niente, o si direbbe che il
                buco vale zero. */}
            {hovered !== null && marked !== null ? (
              <circle cx={x(hovered)} cy={y(marked)} r={3.5} fill="var(--ac)" />
            ) : null}
          </>
        );
      }}
    </ChartFrame>
  );
}

// ---------------------------------------------------------------------------
// 4a — distribuzione per modalità
// ---------------------------------------------------------------------------

/**
 * La ciambella, e non sa di cosa.
 *
 * La panoramica la usa per dividere la rete per modalità, il dettaglio per
 * dividere una modalità per server. È la stessa domanda a due livelli, quindi
 * è lo stesso disegno: riceve le fette già calcolate — da `slicesOf`, che è
 * dove sta la regola su quali chiavi entrano — e non tocca mai il payload.
 *
 * NESSUNO DEI DUE RIQUADRI PASSA DAL SELETTORE IN ALTO. Rispondono a «chi c'è
 * adesso», e il payload porta quella misura a parte proprio per questo:
 * prendendo l'ultimo punto della serie scelta, su un anno sarebbe la media di
 * un giorno intero presentata come popolazione corrente.
 */
export function Donut({
  title,
  note,
  hint,
  at,
  slices,
  excluded,
  excludedNote,
  centre,
  centreLabel,
  labelOf,
  colorOf,
  emptyNote,
}: {
  title: string;
  note: string;
  /** La frase che chiude il sottotitolo: cosa NON è in queste fette. */
  hint: string;
  /** L'istante del bucket da cui viene la misura. `null` = non ancora chiuso. */
  at: number | null;
  slices: Slice[];
  excluded: number;
  excludedNote: string;
  centre: number | null;
  centreLabel: string;
  labelOf: (key: string) => string;
  colorOf: (key: string) => string;
  emptyNote: string;
}) {
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
        {title}
      </h3>
      <div style={{ fontSize: 12, color: 'var(--tx-muted)', marginBottom: 16 }}>
        {note} · {numberFmt.format(Math.round(total))} giocatori
        {at === null ? '' : ` · ${hhmm(at)}`}. {hint}
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
                  labelOf(p.key),
                  `${numberFmt.format(Math.round(p.value))} giocatori · ${
                    total > 0 ? shareLabel((p.value / total) * 100) : '—'
                  }`,
                )
              }
            />
          ))}
          <text x="90" y="86" textAnchor="middle" fill="var(--tx-primary)" fontSize="26" fontWeight="700">
            {centre === null ? '—' : numberFmt.format(Math.round(centre))}
          </text>
          <text x="90" y="104" textAnchor="middle" fill="var(--tx-muted)" fontSize="11">
            {centreLabel}
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
            <span style={{ fontSize: 12.5, color: 'var(--tx-muted)' }}>{emptyNote}</span>
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
                  <span style={{ fontSize: 12.5, fontWeight: 500 }}>{labelOf(s.key)}</span>
                  <span
                    className="mono"
                    style={{ marginLeft: 'auto', fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}
                  >
                    {numberFmt.format(Math.round(s.value))}
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
                  {/* La virgola, come nel tooltip dello stesso riquadro: senza il
                      `replace` la legenda diceva 38.5% e il tooltip 38,5%. */}
                  <span>{total > 0 ? shareLabel((s.value / total) * 100) : '—'}</span>
                </div>
              </div>
            ))
          )}
          {/*
            CHI NON HA UNA FETTA VA DICHIARATO.

            L'operatore può togliere una modalità dalla ripartizione, e le
            percentuali qui sopra si calcolano sul totale di quelle rimaste.
            Senza questa riga, escludere una modalità alzerebbe in silenzio la
            percentuale di tutte le altre: un numero plausibile, diverso dal
            vero, e senza niente su cui dubitare. È la stessa regola della
            mappa con i paesi non attribuiti.
          */}
          {excluded > 0 ? (
            <span style={{ fontSize: 11, color: 'var(--tx-muted)', marginTop: 2 }}>
              {numberFmt.format(Math.round(excluded))} {excludedNote}
            </span>
          ) : null}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 4b — heatmap di affluenza
// ---------------------------------------------------------------------------

export function Heatmap({ data, label }: { data: Overview; label: string }) {
  const { v, w, n } = data.heatmap;
  // TRE array, mai la media già divisa. Nei giorni di cambio ora una cella
  // locale ha zero occorrenze (l'ora saltata di marzo) o due (quella ripetuta
  // di ottobre): con la sola media quella cella mente e nessuno può
  // accorgersene guardandola.
  const detail = v.map((num, i) => {
    const den = w[i] ?? 0;
    return { avg: den > 0 ? num / den : null, occurrences: n[i] ?? 0, coverage: den };
  });
  // Zero occorrenze non e' «zero giocatori»: e' che quella coppia giorno/ora
  // non e' ancora capitata nel periodo, o che allora non si campionava. Va
  // alla griglia come `null`, cioe' tratteggiata.
  const cells = detail.map((c) => (c.occurrences === 0 ? null : c.avg));
  const max = Math.max(1, ...cells.map((c) => c ?? 0));

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
        <HeatLegend top={numberFmt.format(Math.round(max))} />
      </div>
      <HeatGrid
        cells={cells}
        top={max}
        ariaLabel="Media dei giocatori online per giorno della settimana e ora"
        tipOf={(weekday, hour, value) => ({
          title: `${weekday} ${String(hour).padStart(2, '0')}:00`,
          detail: value === null ? 'dati non presenti' : `${numberFmt.format(Math.round(value))} giocatori`,
        })}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// 5 — giocatori unici giornalieri
// ---------------------------------------------------------------------------

const DAY_MONTH = new Intl.DateTimeFormat('it-IT', {
  timeZone: 'Europe/Rome',
  day: '2-digit',
  month: '2-digit',
});

export function DailyUniques({ data, label }: { data: Overview; label: string }) {
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

      {/*
        VUOTO SIGNIFICA NESSUN VALORE, non nessuna casella.

        La condizione era `v.length === 0`, e `v` non è mai vuoto: l'asse dei
        giorni è una griglia costruita dal periodo, quindi ha sempre una
        casella per giorno anche quando sono tutte nulle. Il ramo era morto, e
        un periodo senza dati mostrava assi e nessuna barra — senza una riga
        che lo dicesse. È il caso peggiore fra quelli possibili: sembra un
        grafico caricato a cui manca solo il disegno.
      */}
      {v.every((n) => n === null) ? (
        <div style={{ fontSize: 12.5, color: 'var(--tx-muted)', padding: '24px 0' }}>
          Nessun giorno con dati in questo periodo. Gli unici si chiudono a fine giornata: il primo punto
          compare il giorno dopo il primo giorno raccolto.
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
                  fontFamily={CHART.FONT}
                >
                  {numberFmt.format(tick)}
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
                    DAY_MONTH.format(new Date((t[i] as number) * 1000)),
                    n === null ? 'non rilevato' : `${numberFmt.format(n)} giocatori`,
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

            <text x={L2} y={232} fill="var(--tx-muted)" fontSize="11" fontFamily={CHART.FONT}>
              {t.length > 0 ? DAY_MONTH.format(new Date((t[0] as number) * 1000)) : ''}
            </text>
            <text
              x={W2 - 20}
              y={232}
              textAnchor="end"
              fill="var(--tx-muted)"
              fontSize="11"
              fontFamily={CHART.FONT}
            >
              {t.length > 0 ? DAY_MONTH.format(new Date((t[t.length - 1] as number) * 1000)) : ''}
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

export function NotYet({ title, sub, what }: { title: string; sub: string; what: React.ReactNode }) {
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

// ---------------------------------------------------------------------------
// Il caricamento
// ---------------------------------------------------------------------------

/** Un riquadro vuoto della stessa forma di quello vero. */
function Box({ height }: { height: number }) {
  return (
    <div
      className="skeleton"
      style={{ height, borderRadius: 'var(--r-lg)', border: '1px solid var(--bd-subtle)' }}
      aria-hidden="true"
    />
  );
}

/**
 * La pagina mentre arriva, con le stesse misure della pagina vera.
 *
 * PRIMA QUI NON C'ERA NIENTE: al cambio di modalità o di periodo la chiave
 * della query cambia, react-query torna `undefined`, e la pagina rendeva un
 * div vuoto. Il contenuto spariva tutto insieme e riappariva — con la barra
 * laterale ferma, così sembrava che si fosse rotto qualcosa.
 *
 * Le altezze sono quelle dei riquadri veri (250 il grafico, 240 gli unici,
 * 300 la mappa) e non un valore comodo: se differissero, all'arrivo dei dati
 * la pagina salterebbe, e un salto è più fastidioso dell'attesa che nasconde.
 */
/**
 * I riquadri che caricano, senza intestazione e senza `main`.
 *
 * Si usa quando l'intestazione la sa già chi chiama. Cambiando modalità nome,
 * colore e schede si conoscono subito — stanno nel dizionario, che ogni payload
 * porta intero e che non dipende né dal periodo né dalla modalità — quindi
 * coprirli di grigio farebbe sparire sotto il dito la scheda appena cliccata.
 * Era questo, e non l'animazione, a rendere sgradevole il cambio di modalità
 * mentre quello di periodo andava bene.
 */
export function StatsPanelsSkeleton({ cards = 4 }: { cards?: number }) {
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cards}, 1fr)`, gap: 12 }}>
        {Array.from({ length: cards }, (_, i) => `kpi-${i}`).map((id) => (
          <Box key={id} height={116} />
        ))}
      </div>
      <Box height={330} />
      <div style={{ display: 'grid', gridTemplateColumns: '420px 1fr', gap: 16 }}>
        <Box height={300} />
        <Box height={300} />
      </div>
      <Box height={320} />
      <Box height={340} />
    </>
  );
}

/** La pagina intera che carica: al primo ingresso non si sa ancora nulla. */
export function StatsSkeleton({ cards = 4 }: { cards?: number }) {
  return (
    <main
      style={{ display: 'flex', flexDirection: 'column', gap: 24 }}
      role="status"
      aria-label="caricamento delle statistiche"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="skeleton" style={{ height: 26, width: 220, borderRadius: 'var(--r-xs)' }} />
        <div className="skeleton" style={{ height: 14, width: 340, borderRadius: 'var(--r-xs)' }} />
      </div>
      <StatsPanelsSkeleton cards={cards} />
    </main>
  );
}
