// Duels · Trends. Quattro riquadri, UNA richiesta.
//
// Le tab «tipo» e «contesto» filtrano IN MEMORIA. Il payload porta una serie
// per combinazione presente nel periodo, e la linea disegnata è la somma di
// quelle che passano i due filtri: cambiare tab non fa partire niente. Il
// legacy faceva quattro richieste per disegnare questa pagina, una per
// riquadro, e ognuna riscandiva la stessa finestra.
//
// IL SELETTORE E' QUELLO DEL GUSCIO, in alto, e governa tutti e quattro i
// riquadri. Non ce n'è un secondo dentro la pagina: due controlli temporali
// sulla stessa schermata sono il modo in cui due riquadri finiscono per
// rispondere a domande diverse senza che si veda.

import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { ChartFrame } from '../components/chart-frame.tsx';
import { HeatGrid, HeatLegend } from '../components/heat-grid.tsx';
import { PageHeader, Panel, PanelBar } from '../components/page.tsx';
import { numberFmt, StatsPanelsSkeleton } from '../components/stats-panels.tsx';
import { EmptyState, Notice } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { niceScale, segments } from '../lib/chart.ts';
import {
  ALL,
  combineCombos,
  comboFilters,
  type DuelsBucket,
  type DuelsTrends,
  ranked,
  shareLabel,
} from '../lib/duels.ts';
import { useRange } from '../lib/range.ts';

/** L'altezza del tracciato. Il telaio ci aggiunge la banda delle etichette. */
const PLOT = 236;

const GRANULARITY: Record<DuelsBucket, string> = {
  hour: 'Volume orario',
  day: 'Volume giornaliero',
  week: 'Volume settimanale',
};

const TYPE_LABEL: Record<string, string> = { DUEL: 'Duel', FFA: 'FFA' };
const CONTEXT_LABEL: Record<string, string> = { NORMAL: 'Normali', EVENT: 'Evento' };

export function DuelsTrendsRoute() {
  const { range } = useRange();
  const [type, setType] = useState<string>(ALL);
  const [context, setContext] = useState<string>(ALL);

  const q = useQuery({
    // La chiave PORTA il periodo: senza, cambiando selettore react-query
    // servirebbe la risposta di un altro intervallo sotto l'etichetta nuova.
    queryKey: ['duels-trends', range],
    queryFn: () => api<DuelsTrends>(`/api/duels/trends?range=${range}`),
    // Un minuto come la panoramica, non trenta secondi: con l'ETag il costo
    // di un giro a vuoto è una richiesta condizionale, ma raddoppiarne il
    // numero non renderebbe il dato più fresco di quanto lo faccia il ciclo
    // che lo produce.
    refetchInterval: 60_000,
    placeholderData: (previous) => previous,
  });

  const data = q.data;
  /** Sta arrivando un periodo nuovo mentre si guardano i numeri di prima. */
  const refreshing = q.isPlaceholderData && q.isFetching;

  if (q.isError) {
    return (
      <>
        <PageHeader title="Duels · Trends" sub="Traffico partite sul network" />
        {/* Il messaggio è d'interfaccia: `ApiError` porta solo stato e codice,
            e non c'è nulla da stampare. Il legacy stampava in pagina il testo
            dell'eccezione di MySQL. */}
        <Notice
          tone="err"
          title="Andamento non disponibile"
          description="Non è stato possibile caricare le partite di questo periodo. Riprova fra poco."
        />
      </>
    );
  }

  if (!data) {
    return (
      <>
        <PageHeader title="Duels · Trends" sub="Traffico partite sul network" />
        <StatsPanelsSkeleton />
      </>
    );
  }

  return (
    <main
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 24,
        // LE STESSE MISURE DELLA PANORAMICA, e non e' pedanteria: due
        // schermate sotto lo stesso selettore devono reagire allo stesso modo,
        // o cambiare periodo sembra funzionare diversamente a seconda di dove
        // ci si trova. Qui mancava la transizione, quindi lo smorzamento
        // scattava di colpo invece di sfumare.
        opacity: refreshing ? 0.5 : 1,
        transition: 'opacity var(--dur) var(--ease)',
      }}
      aria-busy={refreshing}
    >
      <PageHeader
        title="Duels · Trends"
        sub={`Traffico partite sul network · ${numberFmt.format(data.totals.matches)} partite nel periodo`}
      />
      <SinceBand since={data.since} first={data.t[0] ?? null} />
      <MatchesPanel data={data} type={type} context={context} onType={setType} onContext={setContext} />
      <HeatPanel data={data} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <TopPanel
          title="Modalità più giocate"
          rows={data.modes.map((m) => ({ key: m.id, name: m.name, matches: m.matches }))}
          others={data.modesOthers}
          colour="var(--blu-viz)"
          unit="modalità"
        />
        <TopPanel
          title="Mappe più giocate"
          rows={data.maps.map((m) => ({ key: m.id, name: m.name ?? `#${m.id}`, matches: m.matches }))}
          others={data.mapsOthers}
          colour="var(--vio-viz)"
          unit="mappe"
        />
      </div>
    </main>
  );
}

/**
 * «La raccolta è cominciata il …», quando il periodo chiesto la precede.
 *
 * Sostituisce il preset «All time» del legacy e dice la verità che quel preset
 * nascondeva: un anno di grafico su centosessantasei giorni di dati non è un
 * anno, e senza questa riga la parte vuota si legge come un anno di calma.
 */
function SinceBand({ since, first }: { since: string | null; first: number | null }) {
  if (!since || first === null) return null;
  const startsAt = Date.parse(`${since}T00:00:00+01:00`) / 1000;
  if (startsAt <= first) return null;
  const [y, m, d] = since.split('-');
  return (
    <Notice
      tone="info"
      title={`Raccolta iniziata il ${d}/${m}/${y}`}
      description="Prima di quella data il dato non esiste: il grafico lascia il tratto vuoto invece di disegnare uno zero."
    />
  );
}

function MatchesPanel({
  data,
  type,
  context,
  onType,
  onContext,
}: {
  data: DuelsTrends;
  type: string;
  context: string;
  onType: (v: string) => void;
  onContext: (v: string) => void;
}) {
  const filters = useMemo(() => comboFilters(data.combos), [data.combos]);
  const values = useMemo(() => combineCombos(data.combos, type, context), [data.combos, type, context]);

  const points = Math.max(1, values.length);
  const observed = Math.max(1, ...values.filter((v): v is number => v !== null));
  const scale = niceScale(observed);
  const shown = values.reduce((a: number, v) => a + (v ?? 0), 0);

  return (
    <Panel>
      <PanelBar>
        <div>
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 600, margin: '0 0 4px' }}>
            Partite nel tempo
          </h3>
          <div style={{ fontSize: 12, color: 'var(--tx-muted)' }}>
            {GRANULARITY[data.bucket]} · Europe/Rome · {numberFmt.format(shown)} partite
          </div>
        </div>
        {/* A DESTRA, come nel mockup: `PanelBar` allinea a sinistra e spinge
            l'ultimo blocco con il margine automatico — e' la stessa forma di
            «N risultati» nelle altre schermate. */}
        <div
          style={{
            marginLeft: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          <Tabs
            value={type}
            onChange={onType}
            all="Tutte"
            options={filters.types.map((v) => ({ value: v, label: TYPE_LABEL[v] ?? v }))}
            label="Tipo di partita"
          />
          <Tabs
            value={context}
            onChange={onContext}
            all="Tutti"
            options={filters.contexts.map((v) => ({ value: v, label: CONTEXT_LABEL[v] ?? v }))}
            label="Contesto"
          />
        </div>
      </PanelBar>
      <ChartFrame
        plot={PLOT}
        top={scale.top}
        t={data.t}
        yTicks={scale.values.map((v) => ({ value: v, label: numberFmt.format(v) }))}
        ariaLabel="Partite avviate nel tempo"
        readingsOf={(i) => {
          // Una linea sola: le tab filtrano la serie, non ne aggiungono.
          const v = values[i];
          return [
            {
              value:
                v === null || v === undefined ? 'dato non ancora raccolto' : `${numberFmt.format(v)} partite`,
            },
          ];
        }}
      >
        {({ x, y, bottom }, hovered) => {
          const lines = segments(values, x, y);
          const marked = hovered === null ? null : (values[hovered] ?? null);
          const area =
            lines.length > 0
              ? `${lines[0]} L${x(points - 1).toFixed(1)},${bottom} L${x(0).toFixed(1)},${bottom} Z`
              : '';
          return (
            <>
              <defs>
                <linearGradient id="duelsArea" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--blu-viz)" stopOpacity="0.16" />
                  <stop offset="100%" stopColor="var(--blu-viz)" stopOpacity="0" />
                </linearGradient>
              </defs>
              {area ? <path d={area} fill="url(#duelsArea)" /> : null}
              {lines.map((d) => (
                <path
                  key={d}
                  d={d}
                  fill="none"
                  stroke="var(--blu-viz)"
                  strokeWidth={2.2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
              {/* Il punto sotto il cursore. Solo se un valore c'è: su un
                  bucket nullo non si marca niente, o si direbbe che un dato
                  che non esiste vale zero. */}
              {hovered !== null && marked !== null ? (
                <circle cx={x(hovered)} cy={y(marked)} r={3.5} fill="var(--blu-viz)" />
              ) : null}
            </>
          );
        }}
      </ChartFrame>
    </Panel>
  );
}

/** Le due barre di tab del riquadro. Filtrano in memoria, non richiedono. */
function Tabs({
  value,
  onChange,
  all,
  options,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  all: string;
  options: Array<{ value: string; label: string }>;
  label: string;
}) {
  const items = [{ value: ALL, label: all }, ...options];
  return (
    <fieldset
      aria-label={label}
      style={{
        margin: 0,
        display: 'flex',
        gap: 2,
        padding: 3,
        background: 'var(--s-inset)',
        border: '1px solid var(--bd-subtle)',
        borderRadius: 'var(--r-sm)',
      }}
    >
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          onClick={() => onChange(item.value)}
          aria-pressed={item.value === value}
          style={{
            border: 'none',
            borderRadius: 'var(--r-xs)',
            background: item.value === value ? 'var(--s-overlay)' : 'transparent',
            color: item.value === value ? 'var(--tx-primary)' : 'var(--tx-muted)',
            fontFamily: 'var(--font-ui)',
            fontSize: 12,
            fontWeight: 600,
            padding: '5px 10px',
            cursor: 'pointer',
            transition: 'all var(--dur) var(--ease)',
          }}
        >
          {item.label}
        </button>
      ))}
    </fieldset>
  );
}

function HeatPanel({ data }: { data: DuelsTrends }) {
  const cells = data.heatmap.cells;
  const vuota = cells.every((c) => c === null || c === 0);

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
            Partite avviate · 7 giorni × 24 ore · tutti i tipi · Europe/Rome
          </div>
        </div>
        {/* Il tetto è il 95° percentile, non il massimo: con il massimo un
            picco anomalo schiaccia tutto il resto a invisibile. La legenda lo
            dichiara con il «≥», o il numero sembrerebbe il massimo. */}
        <HeatLegend top={`≥ ${numberFmt.format(data.heatmap.p95)}`} />
      </div>
      {vuota ? (
        <EmptyState
          title="Nessuna partita registrata in questo periodo."
          description="Cambia periodo dal selettore in alto per allargare la finestra."
        />
      ) : (
        <HeatGrid
          cells={cells}
          top={data.heatmap.p95}
          ariaLabel="Partite avviate per giorno della settimana e ora"
          tipOf={(weekday, hour, value) => ({
            title: `${weekday} ${String(hour).padStart(2, '0')}:00`,
            detail: value === null ? 'fuori dal periodo scelto' : `${numberFmt.format(value)} partite`,
          })}
        />
      )}
    </section>
  );
}

type TopRow = { key: number; name: string; matches: number };

function TopPanel({
  title,
  rows,
  others,
  colour,
  unit,
}: {
  title: string;
  rows: TopRow[];
  others: { n: number; matches: number };
  colour: string;
  unit: string;
}) {
  const list = useMemo(() => ranked(rows, others), [rows, others]);

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
            {title}
          </h3>
          {/* Le due scale si DICHIARANO: la barra confronta le righe fra loro,
              la percentuale dice quanto pesa la riga sul periodo. Lasciarlo da
              indovinare fa leggere la barra come una percentuale. */}
          <div style={{ fontSize: 12, color: 'var(--tx-muted)' }}>
            Partite nel periodo · barra sul massimo, quota sul totale
          </div>
        </div>
        <span className="t-micro" style={{ color: 'var(--tx-muted)' }}>
          {rows.length + others.n} {unit}
        </span>
      </div>
      {rows.length === 0 ? (
        <EmptyState
          title="Nessun dato per questo periodo."
          description="Il catalogo è vuoto, oppure nessuna partita è stata registrata in questo periodo."
        />
      ) : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 9,
            maxHeight: 420,
            overflowY: 'auto',
            overscrollBehavior: 'contain',
          }}
        >
          {list.rows.map(({ row, width, share, rank }) => (
            <div key={row.key} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span
                className="mono"
                style={{ fontSize: 11, color: 'var(--tx-muted)', width: 26, flex: 'none' }}
              >
                #{rank}
              </span>
              <span
                style={{
                  fontSize: 13,
                  flex: 1,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  // Una riga a zero resta in lista, attenuata: toglierla
                  // direbbe che quella modalità non esiste.
                  color: row.matches === 0 ? 'var(--tx-disabled)' : undefined,
                }}
              >
                {row.name}
              </span>
              <span
                style={{
                  flex: 1,
                  height: 5,
                  borderRadius: 3,
                  background: 'var(--s-inset)',
                  overflow: 'hidden',
                  maxWidth: 180,
                }}
              >
                <span
                  style={{
                    display: 'block',
                    height: 5,
                    width: `${width}%`,
                    background: colour,
                    borderRadius: 3,
                  }}
                />
              </span>
              <span
                className="mono"
                style={{
                  fontSize: 12,
                  fontVariantNumeric: 'tabular-nums',
                  width: 56,
                  textAlign: 'right',
                }}
              >
                {numberFmt.format(row.matches)}
              </span>
              <span style={{ fontSize: 11, color: 'var(--tx-muted)', width: 52, textAlign: 'right' }}>
                {shareLabel(share)}
              </span>
            </div>
          ))}
          {others.n > 0 ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                paddingTop: 6,
                borderTop: '1px solid var(--bd-subtle)',
                color: 'var(--tx-muted)',
              }}
            >
              <span style={{ width: 26, flex: 'none' }} />
              <span style={{ fontSize: 13, flex: 1 }}>Altre ({others.n})</span>
              <span style={{ flex: 1, maxWidth: 180 }} />
              <span
                className="mono"
                style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', width: 56, textAlign: 'right' }}
              >
                {numberFmt.format(others.matches)}
              </span>
              <span style={{ fontSize: 11, width: 52, textAlign: 'right' }}>
                {shareLabel(list.total > 0 ? (others.matches / list.total) * 100 : 0)}
              </span>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
