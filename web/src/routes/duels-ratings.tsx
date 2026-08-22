// Duels · Ratings. Il sondaggio di gradimento a fine partita.
//
// NON E' UN SISTEMA DI SKILL RATING. Non è Elo, non è Glicko, non è MMR: è un
// voto da una a cinque stelle con un commento facoltativo. In tutta la pagina
// non esiste aritmetica oltre a somme, conteggi e medie.
//
// GLI AGGREGATI SEGUONO IL PERIODO DEL GUSCIO, e nel legacy non era così: KPI,
// distribuzione e lista erano su tutto lo storico e solo l'andamento aveva i
// suoi giorni, quindi il selettore in alto non faceva niente su tre riquadri
// su quattro.
//
// I FILTRI DELLA LISTA VIVONO NELLA URL, insieme al periodo. Nel legacy sono
// stato di React e la vista filtrata non è condivisibile: chi manda il
// collegamento a «le peggiori valutazioni di Sumo» manda la lista di tutto.

import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CHART, ChartFrame, everyNth } from '../components/chart-frame.tsx';
import { HoverTip, useHoverTip } from '../components/hover-tip.tsx';
import {
  FilterSelect,
  PageArrow,
  PageHeader,
  Panel,
  PanelBar,
  PanelFooter,
  SearchBox,
  TableStates,
} from '../components/page.tsx';
import { numberFmt, StatsPanelsSkeleton } from '../components/stats-panels.tsx';
import { Avatar, EmptyState, Notice, Pill, RelativeTime } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { segments } from '../lib/chart.ts';
import {
  avgLabel,
  type CommentFilter,
  type DuelsRatingRow,
  type DuelsRatings,
  type DuelsRecent,
  type DuelsTrends,
  distributionBars,
  filterKey,
  omitEmpty,
  pctLabel,
  type RecentSort,
  spacingOf,
  starsFilled,
} from '../lib/duels.ts';
import { labelOf, useRange } from '../lib/range.ts';
import { axisLabel, dayAndTime } from '../lib/when.ts';

/** L'altezza del tracciato. Il telaio ci aggiunge la banda delle etichette. */
const PLOT = 214;

/** L'asse del voto è FISSO 0..5, come dev'essere una scala 1-5. */
const MAX_STARS = 5;

const COMMENT_LABEL: Record<CommentFilter, string> = {
  all: 'Tutte',
  with: 'Con commento',
  without: 'Senza commento',
};

const SORT_LABEL: Record<RecentSort, string> = {
  recent: 'Più recenti',
  worst: 'Peggiori prima',
  best: 'Migliori prima',
};

export function DuelsRatingsRoute() {
  const { range } = useRange();
  const search = useSearch({ from: '/shell/duels/ratings' });
  const navigate = useNavigate();
  const mode = search.mode ?? null;

  const q = useQuery({
    queryKey: ['duels-ratings', range, mode],
    queryFn: () =>
      api<DuelsRatings>(`/api/duels/ratings?range=${range}${mode === null ? '' : `&mode=${mode}`}`),
    refetchInterval: 60_000,
    placeholderData: (previous) => previous,
  });

  // Il catalogo per la tendina viene dalle TENDENZE, che lo portano già: una
  // rotta in più solo per riempire un menù sarebbe una richiesta in più su
  // ogni apertura, per un dato che è già in cache dall'altra parte.
  const catalog = useQuery({
    queryKey: ['duels-trends', range],
    queryFn: () => api<DuelsTrends>(`/api/duels/trends?range=${range}`),
    staleTime: 60_000,
  });

  const data = q.data;
  const refreshing = q.isPlaceholderData && q.isFetching;
  const modeName = catalog.data?.modes.find((m) => m.id === mode)?.name ?? null;

  if (q.isError) {
    return (
      <>
        <PageHeader title="Duels · Ratings" sub="Feedback dei giocatori a fine partita" />
        <Notice
          tone="err"
          title="Valutazioni non disponibili"
          description="Non è stato possibile caricare i feedback di questo periodo. Riprova fra poco."
        />
      </>
    );
  }

  if (!data) {
    return (
      <>
        <PageHeader title="Duels · Ratings" sub="Feedback dei giocatori a fine partita" />
        <StatsPanelsSkeleton cards={3} />
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
        title="Duels · Ratings"
        sub={`Feedback dei giocatori a fine partita · ${labelOf(range)}${modeName ? ` · ${modeName}` : ''}`}
        action={
          <FilterSelect
            label="Modalità"
            emptyLabel="Tutte le modalità"
            value={mode === null ? '' : String(mode)}
            onChange={(v) =>
              void navigate({
                to: '.',
                // Il cursore non sopravvive a un cambio di scope: la pagina
                // due di un'altra domanda non è la pagina due.
                search: (prev) => omitEmpty(prev, { mode: v === '' ? undefined : Number(v) }),
                replace: true,
              })
            }
            options={(catalog.data?.modes ?? []).map((m) => ({ value: String(m.id), label: m.name }))}
          />
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        <Kpi label="Valutazioni totali" value={numberFmt.format(data.total)} />
        <Kpi label="Media" value={data.total > 0 ? avgLabel(data.average) : '—'} star />
        <Kpi
          label="Con commento"
          value={pctLabel(data.withComment, data.total)}
          // «N di M» invece della sola percentuale: il 38% di dodici
          // valutazioni e il 38% di dodicimila sono due fatti diversi.
          hint={`${numberFmt.format(data.withComment)} di ${numberFmt.format(data.total)}`}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <DistributionPanel data={data} />
        <TrendPanel data={data} range={labelOf(range)} />
      </div>

      <RecentPanel range={range} mode={mode} />
    </main>
  );
}

function Kpi({ label, value, hint, star }: { label: string; value: string; hint?: string; star?: boolean }) {
  return (
    <div
      style={{
        padding: 14,
        border: '1px solid var(--bd-subtle)',
        borderRadius: 'var(--r-md)',
        background: 'var(--s-surface)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div className="t-micro" style={{ color: 'var(--tx-muted)' }}>
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 26,
            fontWeight: 700,
            letterSpacing: '-.02em',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {value}
        </span>
        {star ? <span style={{ fontSize: 13, color: 'var(--warn)' }}>★</span> : null}
      </div>
      {hint ? (
        <div style={{ fontSize: 12, color: 'var(--tx-muted)' }} className="t-sm">
          {hint}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Cinque stelle, riempite fino all'arrotondamento.
 *
 * IL DIFETTO E' NOTO: 3,50 disegna quattro stelle piene. È tollerabile solo
 * perché il numero sta sempre accanto, e l'etichetta per chi legge con lo
 * screen reader porta i due decimali — mai le stelle da sole.
 */
export function Stars({ value }: { value: number }) {
  const filled = starsFilled(value);
  return (
    <span role="img" aria-label={`${avgLabel(value)} su 5`} style={{ letterSpacing: 1, fontSize: 13 }}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} style={{ color: i <= filled ? 'var(--warn)' : 'var(--tx-disabled)' }}>
          ★
        </span>
      ))}
    </span>
  );
}

function DistributionPanel({ data }: { data: DuelsRatings }) {
  const hover = useHoverTip();
  const bars = useMemo(
    () => distributionBars(data.distribution, data.total),
    [data.distribution, data.total],
  );
  const tallest = Math.max(1, ...bars.map((b) => b.share));

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
        Distribuzione voti
      </h3>
      <div style={{ fontSize: 12, color: 'var(--tx-muted)', marginBottom: 16 }}>
        Come i giocatori votano la partita (1–5 stelle)
      </div>
      {data.total === 0 ? (
        <EmptyState
          title="Nessuna valutazione registrata."
          description="Nel periodo scelto nessuno ha lasciato un voto a fine partita."
        />
      ) : (
        <div
          ref={hover.boxRef}
          onPointerLeave={hover.clear}
          style={{
            position: 'relative',
            display: 'flex',
            alignItems: 'flex-end',
            gap: 14,
            height: 190,
            padding: '0 6px',
          }}
        >
          <HoverTip tip={hover.tip} boxRef={hover.boxRef} />
          {bars.map((bar) => (
            <div
              key={bar.stars}
              onPointerMove={(e) =>
                hover.at(
                  e,
                  `${bar.stars}★`,
                  `${numberFmt.format(bar.count)} valutazioni · ${bar.share.toFixed(1).replace('.', ',')}%`,
                )
              }
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 8,
                height: '100%',
                justifyContent: 'flex-end',
              }}
            >
              <span className="mono" style={{ fontSize: 11, color: 'var(--tx-muted)' }}>
                {bar.share.toFixed(1).replace('.', ',')}%
              </span>
              <div
                style={{
                  width: '100%',
                  borderRadius: '4px 4px 0 0',
                  background: bar.color,
                  // L'altezza si normalizza sulla barra PIU' ALTA, non sul
                  // 100%: con una distribuzione che sta tutta fra il 5 e il
                  // 40 per cento, cinque barre basse identiche non
                  // direbbero niente.
                  height: `${Math.max(2, (bar.share / tallest) * 140)}px`,
                }}
              />
              <span style={{ fontSize: 12, color: 'var(--tx-secondary)' }}>{bar.stars}★</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function TrendPanel({ data, range }: { data: DuelsRatings; range: string }) {
  const { t, avg, n } = data.trend;
  const points = Math.max(1, t.length);
  const maxN = Math.max(1, ...n.filter((v): v is number => v !== null));
  const spacing = spacingOf(t);
  const drawn = avg.filter((v) => v !== null).length;
  const singleAt = avg.findIndex((v) => v !== null);

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
        Andamento voto medio
      </h3>
      <div style={{ fontSize: 12, color: 'var(--tx-muted)', marginBottom: 6 }}>
        {range} · le barre di fondo sono quante valutazioni, la linea la loro media
      </div>
      {/* Lo STESSO telaio del grafico delle partite e di quello online: stessi
          margini, stessa banda per le etichette, stesso carattere. Tre telai
          separati erano tre geometrie che divergevano senza che si vedesse. */}
      <ChartFrame
        plot={PLOT}
        top={MAX_STARS}
        points={points}
        yTicks={[0, 1, 2, 3, 4, 5].map((v) => ({ value: v, label: `${v}★` }))}
        xTicks={everyNth(points, (i) => axisLabel(t[i] ?? 0, spacing))}
        ariaLabel="Andamento del voto medio nel tempo"
        tipOf={(i) => {
          const v = avg[i];
          return {
            title: dayAndTime(t[i] ?? 0),
            detail:
              v === null || v === undefined
                ? 'nessuna valutazione'
                : `${avgLabel(v)}★ su ${numberFmt.format(n[i] ?? 0)} valutazioni`,
          };
        }}
      >
        {({ x, y, bottom }, hovered) => {
          const lines = segments(avg, x, y);
          const barWidth = Math.max(1, (CHART.RIGHT - CHART.LEFT) / points - 1);
          return (
            <>
              {/* LA NUMEROSITA' SI DISEGNA. Il legacy la trasporta e non la usa
                  mai: un giorno con UN voto da cinque stelle è indistinguibile
                  da uno con quattrocento voti a 5,00, e la media sembra un
                  fatto quando è rumore. */}
              {n.map((value, i) =>
                value === null || value === 0 ? null : (
                  <rect
                    key={t[i]}
                    x={x(i) - barWidth / 2}
                    y={bottom - ((bottom - CHART.TOP) * value) / maxN}
                    width={barWidth}
                    height={((bottom - CHART.TOP) * value) / maxN}
                    fill="color-mix(in oklab, var(--tx-muted) 20%, transparent)"
                  />
                ),
              )}

              {/* La media del periodo, tratteggiata: l'asse fisso 0-5 è corretto
                  ma schiaccia la differenza fra 4,1 e 4,4, e questa riga la
                  restituisce senza mentire sulla scala. */}
              {data.total > 0 ? (
                <line
                  x1={CHART.LEFT}
                  y1={y(data.average)}
                  x2={CHART.RIGHT}
                  y2={y(data.average)}
                  stroke="var(--tx-muted)"
                  strokeWidth={1}
                  strokeDasharray="4 4"
                />
              ) : null}

              {lines.map((d) => (
                <path
                  key={d}
                  d={d}
                  fill="none"
                  stroke="var(--warn)"
                  strokeWidth={2.2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
              {/* Un punto solo non fa una linea: senza il cerchio la serie
                  sarebbe invisibile e il riquadro sembrerebbe vuoto. */}
              {drawn === 1 && singleAt >= 0 ? (
                <circle cx={x(singleAt)} cy={y(avg[singleAt] as number)} r={3} fill="var(--warn)" />
              ) : null}
              {/* Il punto sotto il cursore, solo dove un voto c'e' davvero. */}
              {hovered !== null && avg[hovered] !== null && avg[hovered] !== undefined ? (
                <circle cx={x(hovered)} cy={y(avg[hovered] as number)} r={3.5} fill="var(--warn)" />
              ) : null}
            </>
          );
        }}
      </ChartFrame>
    </section>
  );
}

/**
 * Le valutazioni recenti: una TABELLA, la stessa del registro attività.
 *
 * Prima era una lista di `<div>` con i bordi disegnati a mano — stessa
 * funzione, stessa forma, markup diverso. Adesso condivide con il registro il
 * contenitore (`Panel`), la barra dei filtri, la macchina a quattro stati
 * (`TableStates`), la classe `.table`, il piede e le frecce: cambiano solo le
 * colonne, che sono l'unica cosa davvero diversa fra le due schermate.
 */
function RecentPanel({ range, mode }: { range: string; mode: number | null }) {
  const search = useSearch({ from: '/shell/duels/ratings' });
  const navigate = useNavigate();
  const comment: CommentFilter = search.comment ?? 'all';
  const sort: RecentSort = search.sort ?? 'recent';
  const term = search.q ?? '';

  // La casella si digita subito e la richiesta parte dopo: senza, ogni
  // carattere sarebbe una query con un indice trigram da interrogare.
  const [typed, setTyped] = useState(term);
  useEffect(() => setTyped(term), [term]);
  useEffect(() => {
    if (typed === term) return;
    const timer = setTimeout(() => {
      void navigate({
        to: '.',
        search: (prev) => omitEmpty(prev, { q: typed.trim() === '' ? undefined : typed }),
        replace: true,
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [typed, term, navigate]);

  // LA PILA DEI CURSORI, come nel registro: il server ne dà uno solo, in
  // avanti. Tenendo quelli già usati si torna indietro senza chiedere al
  // server una cosa che non sa fare — e senza `OFFSET`, che a pagina dieci
  // farebbe scartare centotrentacinque righe a ogni richiesta.
  const [trail, setTrail] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string | undefined>(undefined);
  const cursor = trail.at(-1) ?? null;

  const key = filterKey({ mode, q: term, comment, sort, range });
  // IL CURSORE SI AZZERA DURANTE IL RENDER, non in un effetto: in un effetto
  // partirebbe prima una richiesta con il cursore vecchio, cioè la pagina due
  // di una domanda che non è più quella.
  const previousKey = useRef(key);
  if (previousKey.current !== key) {
    previousKey.current = key;
    if (trail.length > 0) setTrail([]);
    if (expanded !== undefined) setExpanded(undefined);
  }

  const params = new URLSearchParams({ range, comment, sort });
  if (mode !== null) params.set('mode', String(mode));
  if (term !== '') params.set('q', term);
  if (cursor !== null) params.set('cursor', cursor);

  const query = useQuery({
    queryKey: ['duels-recent', key, cursor],
    queryFn: () => api<DuelsRecent>(`/api/duels/ratings/recent?${params.toString()}`),
    placeholderData: (previous) => previous,
  });

  const rows = query.data?.rows ?? [];
  const filtered = term !== '' || comment !== 'all';
  const first = trail.length * (query.data?.pageSize ?? 15) + 1;
  const last = first + rows.length - 1;

  return (
    <Panel>
      <PanelBar>
        <SearchBox
          value={typed}
          onChange={setTyped}
          placeholder="Cerca per nome o commento"
          label="Cerca fra le valutazioni"
          width={220}
        />
        <FilterSelect
          label="Filtra per commento"
          value={comment}
          onChange={(v) =>
            void navigate({
              to: '.',
              search: (prev) => omitEmpty(prev, { comment: v === 'all' ? undefined : v }),
              replace: true,
            })
          }
          options={(['all', 'with', 'without'] as const).map((v) => ({
            value: v,
            label: COMMENT_LABEL[v],
          }))}
        />
        <FilterSelect
          label="Ordina"
          value={sort}
          onChange={(v) =>
            void navigate({
              to: '.',
              search: (prev) => omitEmpty(prev, { sort: v === 'recent' ? undefined : v }),
              replace: true,
            })
          }
          options={(['recent', 'worst', 'best'] as const).map((v) => ({
            value: v,
            label: SORT_LABEL[v],
          }))}
        />
      </PanelBar>

      <TableStates
        pending={query.isPending}
        error={query.isError}
        empty={rows.length === 0}
        errorTitle="Non è stato possibile caricare le valutazioni"
        // Lo stato vuoto DIFFERENZIATO: «non corrisponde ai filtri» e «non ce
        // n'è nessuna» sono due situazioni diverse, e confonderle manda a
        // cercare un guasto dove c'è solo un filtro attivo.
        emptyTitle={filtered ? 'Nessuna valutazione corrisponde ai filtri' : 'Nessuna valutazione'}
        emptyDescription={
          filtered
            ? 'Prova a togliere la ricerca o ad allargare il filtro sui commenti.'
            : 'Nel periodo scelto nessuno ha lasciato un voto a fine partita.'
        }
        onRetry={() => void query.refetch()}
      >
        <table className="table" style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ width: 96 }}>Quando</th>
              <th style={{ width: 200 }}>Giocatore</th>
              <th style={{ width: 150 }}>Modalità</th>
              <th style={{ width: 130 }}>Voto</th>
              <th>Commento</th>
              <th style={{ width: 44 }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <RatingRow
                key={row.id}
                row={row}
                expanded={expanded === row.id}
                onToggle={() => setExpanded(expanded === row.id ? undefined : row.id)}
              />
            ))}
          </tbody>
        </table>
      </TableStates>

      <PanelFooter>
        <span>
          {rows.length === 0
            ? 'Nessuna valutazione'
            : query.data?.total !== null && query.data?.total !== undefined
              ? `${first}–${last} di ${numberFmt.format(query.data.total)}`
              : `${first}–${last}`}
        </span>
        <span style={{ display: 'flex', gap: 6 }}>
          <PageArrow
            glyph="‹"
            label="Pagina precedente"
            disabled={trail.length === 0 || query.isFetching}
            onClick={() => {
              setTrail((t) => t.slice(0, -1));
              setExpanded(undefined);
            }}
          />
          <PageArrow
            glyph="›"
            label="Pagina successiva"
            disabled={!query.data?.cursor || query.isFetching}
            onClick={() => {
              const next = query.data?.cursor;
              if (!next) return;
              setTrail((t) => [...t, next]);
              setExpanded(undefined);
            }}
          />
        </span>
      </PanelFooter>
    </Panel>
  );
}

function RatingRow({
  row,
  expanded,
  onToggle,
}: {
  row: DuelsRatingRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  const turns = row.dialog ?? [];
  const openable = turns.length > 0;

  return (
    <>
      <tr>
        <td style={{ color: 'var(--tx-muted)', fontSize: 11.5 }}>
          <RelativeTime value={new Date(row.at * 1000)} />
        </td>
        <td>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            {/* Il volto passa dal NOSTRO dominio: la CSP dichiara
                `img-src 'self'`, e un CDN esterno vedrebbe l'indirizzo di chi
                guarda e il nome di chi è guardato, riga per riga. Senza nome
                restano le iniziali. */}
            <Avatar name={row.player ?? '?'} size={26} square />
            <span style={{ fontWeight: 500 }}>{row.player ?? 'Sconosciuto'}</span>
          </span>
        </td>
        <td>{row.modeName ? <Pill tone="neutral">{row.modeName}</Pill> : '—'}</td>
        <td>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <Stars value={row.rating} />
            <span className="mono" style={{ fontSize: 11.5, color: 'var(--tx-disabled)' }}>
              {row.rating}/5
            </span>
          </span>
        </td>
        <td style={{ color: row.comment ? 'var(--tx-secondary)' : 'var(--tx-disabled)' }}>
          {row.comment ? (
            <span style={{ fontStyle: 'italic' }}>«{row.comment}»</span>
          ) : openable ? (
            `${turns.length} messaggi`
          ) : (
            '—'
          )}
        </td>
        <td>
          {openable ? (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={expanded}
              aria-label={expanded ? 'Nascondi la conversazione' : 'Mostra la conversazione'}
              className="btn btn-ghost"
              style={{ padding: '2px 6px', fontSize: 12 }}
            >
              {expanded ? '▾' : '▸'}
            </button>
          ) : null}
        </td>
      </tr>
      {/* CHIUSA DI DEFAULT: il legacy tiene la conversazione sempre aperta e
          la lista diventa illeggibile. */}
      {expanded && openable ? (
        <tr>
          <td colSpan={6} style={{ background: 'var(--s-inset)' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 0' }}>
              {turns.map((turn) => (
                <div
                  // Il turno non ha un identificativo all'origine: conta solo
                  // l'ordine. La chiave è il contenuto, non la posizione — la
                  // lista non si riordina e non si filtra, quindi due turni
                  // identici nella stessa conversazione sono lo stesso turno.
                  key={`${row.id}-${turn.speaker}-${turn.text}`}
                  style={{
                    display: 'flex',
                    gap: 8,
                    fontSize: 12.5,
                    color: turn.speaker === 'bot' ? 'var(--tx-muted)' : 'var(--tx-secondary)',
                  }}
                >
                  <span className="t-micro" style={{ width: 52, flex: 'none', color: 'var(--tx-muted)' }}>
                    {turn.speaker}
                  </span>
                  {/* Sempre testo: commenti e nomi sono stringhe controllate da
                      terzi, e una guardia di build vieta senza eccezioni ogni
                      via che li renderebbe come marcatura. */}
                  <span>{turn.text}</span>
                </div>
              ))}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
