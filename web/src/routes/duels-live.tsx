// «Duels · Live». Le misure vengono da `frontend/13-duels-live.dc.html`.
//
// TRE RIQUADRI E UNA FINESTRA, nell'ordine del disegno: le partite attive con
// il filtro per server, le partite per modalita' con le due barre, la salute
// dei server divisa per tipo, e il roster che si apre cliccando una partita.
//
// SI AGGIORNA DA SOLA, e la domanda e' «adesso»: senza un ritmo, la schermata
// mostrerebbe com'era quando e' stata aperta e continuerebbe a chiamarsi Live.
// E' un `refetchInterval` e non un flusso SSE perche' non serve altro — cinque
// secondi sono piu' fitti di quanto un occhio distingua su una griglia di
// partite, e non chiedono niente a nginx.
//
// IL ROSTER SI CHIEDE A PARTE, e solo quando qualcuno apre una partita: sul
// Redis di gioco costa una scansione, e farla per tutte le partite a ogni
// aggiornamento sarebbe pagare a ripetizione un dato che quasi nessuno guarda.

import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { PageHeader, Panel } from '../components/page.tsx';
import { api } from '../lib/api.ts';
import { numberFmt } from '../lib/format.ts';

type LiveServer = {
  id: string;
  type: string;
  players: number;
  active: boolean;
  matches: number;
  tps: number | null;
  mspt: number | null;
  cpu: number | null;
};

type LiveMatch = {
  id: string;
  context: string;
  server: string | null;
  modeId: number;
  mode: string | null;
  mapId: number;
  map: string | null;
  createdAt: number;
  players: number;
};

type LiveMode = {
  modeId: number;
  name: string;
  active: number;
  queued: number;
  context: string;
};

type LiveSnapshot = {
  at: number;
  servers: LiveServer[];
  matches: LiveMatch[];
  modes: LiveMode[];
  truncated: boolean;
};

type RosterPlayer = { name: string; server: string | null; ping: number | null };
type Roster = { matchId: string; players: RosterPlayer[]; truncated: boolean };

/** Ogni quanto si rilegge. Cinque secondi: e' una schermata di operativita'. */
const TICK_MS = 5_000;

/**
 * Le soglie del disegno, in un posto solo.
 *
 * VENGONO DAL MOCKUP e non sono opinioni sul tuning di un server: 19,5 TPS e'
 * la riga sotto la quale il colore passa da verde ad ambra, 18 quella sotto
 * cui diventa rosso. Scriverle qui una volta evita che il pallino della riga e
 * la pastiglia del TPS finiscano a dire due cose diverse sullo stesso server.
 */
function tpsColour(tps: number | null): string {
  if (tps === null) return 'var(--tx-muted)';
  if (tps >= 19.5) return 'var(--ok)';
  return tps >= 18 ? 'var(--warn)' : 'var(--err)';
}
function tpsSoft(tps: number | null): string {
  if (tps === null) return 'var(--s-inset)';
  if (tps >= 19.5) return 'var(--ok-soft)';
  return tps >= 18 ? 'var(--warn-soft)' : 'var(--err-soft)';
}
function pingColour(ping: number | null): string {
  if (ping === null) return 'var(--tx-muted)';
  if (ping <= 60) return 'var(--ok)';
  return ping <= 120 ? 'var(--warn)' : 'var(--err)';
}

/**
 * Da quanto va una partita, in mm:ss.
 *
 * L'orologio del pannello e quello del server di gioco non sono lo stesso
 * orologio, e una partita appena creata puo' risultare nata nel futuro. In quel
 * caso si mostra `00:00` invece di un numero negativo: un tempo negativo
 * accanto a una partita in corso fa dubitare di tutta la schermata.
 */
function ageOf(createdAt: number, at: number): string {
  if (createdAt <= 0) return '—';
  const seconds = Math.max(0, Math.floor((at - createdAt) / 1000));
  const mm = Math.floor(seconds / 60);
  const ss = seconds % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

/**
 * Un decimale, o un trattino quando il campione non c'e'.
 *
 * PUNTO E NON VIRGOLA, ed e' quello che fa il mockup: nella pastiglia il TPS
 * e' `19.8`. Sembra un'incoerenza con il resto del pannello — e in parte lo
 * e', visto che due righe piu' in la' la media del gruppo e' `19,80` — ma e'
 * il disegno, e sono numeri da macchina, letti accanto a `6.4 ms` e `41%`.
 */
function dec(value: number | null, digits = 1): string {
  return value === null ? '—' : value.toFixed(digits);
}

/**
 * Da quello che spark pubblica a una percentuale leggibile.
 *
 * DIECI, misurato e non dedotto: sullo stesso server Redis porta `0.34` e
 * `spark cpu` in console scrive `3%`. Il mockup moltiplica per cento — i suoi
 * dati finti stavano su un'altra scala — e il vecchio pannello non
 * moltiplicava affatto, e infatti mostrava zero su ogni server senza che
 * nessuno lo notasse. Vedi `LiveServer.cpu` in `src/duels/live.ts`.
 */
const CPU_TO_PERCENT = 10;

/** La media del gruppo, con la virgola: e' la sola cifra che il disegno scrive cosi'. */
function avgTpsLabel(value: number | null): string {
  return value === null ? '—' : value.toFixed(2).replace('.', ',');
}

export function DuelsLiveRoute() {
  const [server, setServer] = useState<string>('Tutti');
  const [serverMenu, setServerMenu] = useState(false);
  const [openMatch, setOpenMatch] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({
    key: 'players',
    dir: 'desc',
  });

  const live = useQuery({
    queryKey: ['duels-live'],
    queryFn: () => api<LiveSnapshot>('/api/duels/live'),
    refetchInterval: TICK_MS,
  });

  // Il roster parte solo con una partita aperta, e si aggiorna con lo stesso
  // ritmo del resto: chi guarda un roster vuole vedere chi entra e chi esce.
  const roster = useQuery({
    queryKey: ['duels-live-roster', openMatch],
    queryFn: () => api<Roster>(`/api/duels/live/match/${encodeURIComponent(openMatch ?? '')}`),
    enabled: openMatch !== null,
    refetchInterval: TICK_MS,
  });

  const data = live.data;
  const at = data?.at ?? Date.now();
  const matches = data?.matches ?? [];
  const servers = data?.servers ?? [];

  // Il totale e' la somma di quante partite dichiara ogni server, non la
  // lunghezza dell'elenco filtrato: e' cio' che il numerone in alto significa.
  const total = servers.reduce((acc, s) => acc + s.matches, 0);
  const shown = server === 'Tutti' ? matches : matches.filter((m) => m.server === server);
  // TUTTI i server, non solo quelli che in questo momento ospitano una
  // partita: il menu e' l'universo dei server, e uno che sparisce quando si
  // svuota costringe a chiedersi se sia caduto.
  const serverOptions = ['Tutti', ...servers.map((s) => s.id)];

  const detail = openMatch === null ? null : (matches.find((m) => m.id === openMatch) ?? null);

  return (
    <>
      <PageHeader title="Duels · Live" sub="Cosa sta girando adesso sui server Duels · Europe/Rome" />

      <Panel>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 16,
            padding: '18px 20px 14px',
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <span
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 26,
                  lineHeight: 1,
                  fontWeight: 700,
                  fontVariantNumeric: 'tabular-nums',
                  color: 'var(--ac-text)',
                }}
              >
                {numberFmt.format(total)}
              </span>
              <h3
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontFamily: 'var(--font-display)',
                  fontSize: 16,
                  fontWeight: 600,
                  margin: 0,
                }}
              >
                Partite attive
              </h3>
            </div>
            <div style={{ marginTop: 5, fontSize: 12, color: 'var(--tx-muted)' }}>
              {shown.length} di {numberFmt.format(total)} partite · clic su una partita per il roster
            </div>
          </div>
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              onClick={() => setServerMenu((v) => !v)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                height: 30,
                padding: '0 10px',
                border: '1px solid var(--bd-subtle)',
                borderRadius: 'var(--r-sm)',
                background: 'var(--s-inset)',
                color: 'var(--tx-primary)',
                fontFamily: 'var(--font-mono)',
                fontSize: 11.5,
                cursor: 'pointer',
              }}
            >
              {server}
              <svg
                viewBox="0 0 24 24"
                width="12"
                height="12"
                fill="none"
                stroke="var(--tx-muted)"
                strokeWidth="1.5"
                style={{ transform: 'rotate(90deg)' }}
                aria-hidden="true"
              >
                <path d="m9 18 6-6-6-6" />
              </svg>
            </button>
            {serverMenu ? (
              <div
                style={{
                  position: 'absolute',
                  top: 34,
                  right: 0,
                  zIndex: 30,
                  width: 190,
                  padding: 5,
                  border: '1px solid var(--bd-strong)',
                  borderRadius: 'var(--r-md)',
                  background: 'var(--s-overlay)',
                  boxShadow: 'var(--e3)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 1,
                }}
              >
                {serverOptions.map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      setServer(id);
                      setServerMenu(false);
                    }}
                    style={{
                      textAlign: 'left',
                      padding: '7px 9px',
                      border: 'none',
                      borderRadius: 'var(--r-sm)',
                      background: 'transparent',
                      color: id === server ? 'var(--ac-text)' : 'var(--tx-secondary)',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 11.5,
                      cursor: 'pointer',
                    }}
                  >
                    {id}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        <div
          style={{
            maxHeight: 420,
            overflowY: 'auto',
            padding: '0 12px 14px',
            display: 'grid',
            gridTemplateColumns: 'repeat(3,minmax(0,1fr))',
            gap: 8,
          }}
        >
          {shown.map((m) => (
            <MatchCard key={m.id} match={m} at={at} onOpen={() => setOpenMatch(m.id)} />
          ))}
        </div>
      </Panel>

      <ByMode modes={data?.modes ?? []} />

      <ServerHealth servers={servers} sort={sort} onSort={setSort} />

      {detail ? (
        <MatchDialog
          match={detail}
          at={at}
          players={roster.data?.players ?? []}
          onClose={() => setOpenMatch(null)}
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------

/** Il riquadro di una partita. Il tratto SVG è quello del mockup. */
function MatchCard({ match, at, onOpen }: { match: LiveMatch; at: number; onOpen: () => void }) {
  const isEvent = match.context === 'EVENT';
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 11,
        padding: '10px 11px',
        border: '1px solid var(--bd-subtle)',
        borderRadius: 'var(--r-md)',
        background: 'var(--s-inset)',
        textAlign: 'left',
        cursor: 'pointer',
      }}
    >
      <span
        style={{
          width: 32,
          height: 32,
          flex: 'none',
          borderRadius: 'var(--r-sm)',
          background: isEvent ? 'var(--blu-soft)' : 'var(--ac-soft)',
          color: isEvent ? 'var(--blu-viz)' : 'var(--ac-text)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M6.5 17.5 17.5 6.5M14 6h4v4M6 14v4h4M17.5 17.5 6.5 6.5M10 6H6v4M18 14v4h-4" />
        </svg>
      </span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--tx-primary)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {/* Senza catalogo il nome non c'e' e si mostra l'id: meno leggibile
                e vero, che è meglio di una casella vuota. */}
            {match.mode ?? `#${match.modeId}`}
          </span>
          {isEvent ? (
            <span
              style={{
                flex: 'none',
                padding: '1px 5px',
                borderRadius: 'var(--r-xs)',
                background: 'var(--blu-soft)',
                color: 'var(--blu-viz)',
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: '.08em',
                textTransform: 'uppercase',
              }}
            >
              Event
            </span>
          ) : null}
        </span>
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginTop: 2,
            fontSize: 11,
            color: 'var(--tx-muted)',
          }}
        >
          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {match.map ?? `#${match.mapId}`}
          </span>
          <span>·</span>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {match.server ?? '—'}
          </span>
        </span>
      </span>
      <span style={{ flex: 'none', textAlign: 'right' }}>
        <span
          style={{
            display: 'block',
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            fontVariantNumeric: 'tabular-nums',
            color: 'var(--tx-primary)',
          }}
        >
          {ageOf(match.createdAt, at)}
        </span>
        <span style={{ display: 'block', fontSize: 10.5, color: 'var(--tx-muted)', marginTop: 2 }}>
          {match.players} giocatori
        </span>
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------

/**
 * Partite per modalità: due barre sovrapposte, in corso e in coda.
 *
 * LE DUE BARRE CONDIVIDONO LA SCALA, e devono: sono lo stesso genere di cosa —
 * giocatori — e normalizzarle ognuna sul proprio massimo farebbe sembrare una
 * coda di tre lunga quanto ventiquattro partite.
 */
function ByMode({ modes }: { modes: readonly LiveMode[] }) {
  const top = Math.max(1, ...modes.map((m) => m.active));
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
          gap: 16,
          marginBottom: 16,
        }}
      >
        <div>
          <h3
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 16,
              fontWeight: 600,
              margin: '0 0 4px',
            }}
          >
            Partite per modalità
          </h3>
          <div style={{ fontSize: 12, color: 'var(--tx-muted)' }}>
            Partite in corso e giocatori in coda · adesso
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            fontSize: 11,
            color: 'var(--tx-muted)',
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 9, height: 9, borderRadius: 2, background: 'var(--ac)' }} />
            In corso
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span
              style={{ width: 9, height: 9, borderRadius: 2, background: 'var(--blu-viz)', opacity: 0.55 }}
            />
            In coda
          </span>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {modes.map((m) => (
          <div key={m.modeId} style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <span
              style={{
                width: 150,
                flex: 'none',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 13,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  flex: 'none',
                  borderRadius: 2,
                  background: m.context === 'EVENT' ? 'var(--blu-viz)' : 'var(--ac)',
                }}
              />
              {m.name}
            </span>
            <span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
              <span
                style={{
                  display: 'block',
                  height: 8,
                  borderRadius: 3,
                  background: 'var(--ac)',
                  width: `${((m.active / top) * 100).toFixed(1)}%`,
                }}
              />
              <span
                style={{
                  display: 'block',
                  height: 4,
                  borderRadius: 3,
                  background: 'var(--blu-viz)',
                  opacity: 0.55,
                  width: `${((m.queued / top) * 100).toFixed(1)}%`,
                }}
              />
            </span>
            <span
              style={{
                width: 52,
                flex: 'none',
                textAlign: 'right',
                fontFamily: 'var(--font-mono)',
                fontSize: 12.5,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {m.active}
            </span>
            <span
              style={{
                width: 74,
                flex: 'none',
                textAlign: 'right',
                fontFamily: 'var(--font-mono)',
                fontSize: 11.5,
                fontVariantNumeric: 'tabular-nums',
                color: 'var(--tx-muted)',
              }}
            >
              {m.queued} in coda
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------

type SortKey = 'id' | 'players' | 'matches' | 'tps' | 'mspt' | 'cpu';

/**
 * Salute dei server, un riquadro per tipo.
 *
 * QUALI TIPI ARRIVINO LO DECIDE IL SERVER, in `LIVE_SERVER_TYPES`: DUEL ed
 * EVENT, come dice il titolo del riquadro. Il filtro sta li' e non qui perche'
 * un FFA scartato solo a schermo continuerebbe a contare nel totale delle
 * partite attive, e la somma in alto non tornerebbe con quella dei riquadri.
 *
 * Qui resta solo l'ORDINE: DUEL prima di EVENT. Un tipo che il server dovesse
 * aggiungere domani finirebbe in coda, in ordine alfabetico, invece di
 * scomparire.
 */
function ServerHealth({
  servers,
  sort,
  onSort,
}: {
  servers: readonly LiveServer[];
  sort: { key: SortKey; dir: 'asc' | 'desc' };
  onSort: (next: { key: SortKey; dir: 'asc' | 'desc' }) => void;
}) {
  const byType = new Map<string, LiveServer[]>();
  for (const s of servers) {
    const list = byType.get(s.type) ?? [];
    list.push(s);
    byType.set(s.type, list);
  }
  const order = ['DUEL', 'EVENT'];
  const types = [...byType.keys()].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    if (ia !== ib) return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib);
    return a.localeCompare(b);
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 600, margin: '0 0 4px' }}>
          Salute server
        </h3>
        <div style={{ fontSize: 12, color: 'var(--tx-muted)' }}>
          Server DUEL ed EVENT · TPS su 20, MSPT medio per tick
        </div>
      </div>
      {types.map((type) => (
        <ServerGroup key={type} type={type} servers={byType.get(type) ?? []} sort={sort} onSort={onSort} />
      ))}
    </div>
  );
}

function ServerGroup({
  type,
  servers,
  sort,
  onSort,
}: {
  type: string;
  servers: readonly LiveServer[];
  sort: { key: SortKey; dir: 'asc' | 'desc' };
  onSort: (next: { key: SortKey; dir: 'asc' | 'desc' }) => void;
}) {
  const hasMatches = servers.some((s) => s.matches > 0);
  const cols = hasMatches
    ? 'minmax(0,1.5fr) minmax(0,.8fr) minmax(0,.8fr) minmax(0,.7fr) minmax(0,.8fr) minmax(0,.7fr)'
    : 'minmax(0,1.5fr) minmax(0,.8fr) minmax(0,.7fr) minmax(0,.8fr) minmax(0,.7fr)';

  const players = servers.reduce((acc, s) => acc + s.players, 0);
  const matches = servers.reduce((acc, s) => acc + s.matches, 0);
  const sampled = servers.map((s) => s.tps).filter((t): t is number => t !== null);
  const avgTps = sampled.length > 0 ? sampled.reduce((a, b) => a + b, 0) / sampled.length : null;

  const headers: Array<{ key: SortKey; label: string; right: boolean }> = [
    { key: 'id', label: 'ID server', right: false },
    { key: 'players', label: 'Giocatori', right: true },
    ...(hasMatches ? [{ key: 'matches' as SortKey, label: 'Partite', right: true }] : []),
    { key: 'tps', label: 'TPS', right: true },
    { key: 'mspt', label: 'MSPT', right: true },
    { key: 'cpu', label: 'CPU', right: true },
  ];

  const factor = sort.dir === 'asc' ? 1 : -1;
  const rows = [...servers].sort((a, b) => {
    if (sort.key === 'id') return a.id.localeCompare(b.id) * factor;
    // I campi campionati possono essere `null` — un server che non ha ancora
    // pubblicato niente. Vanno in fondo comunque si ordini: in testa
    // sembrerebbero i migliori o i peggiori, e non sono né l'uno né l'altro.
    const av = a[sort.key];
    const bv = b[sort.key];
    if (av === null) return 1;
    if (bv === null) return -1;
    return (Number(av) - Number(bv)) * factor;
  });

  return (
    <Panel>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '14px 20px',
          borderBottom: '1px solid var(--bd-subtle)',
          flexWrap: 'wrap',
        }}
      >
        <span
          style={{
            padding: '3px 9px',
            borderRadius: 'var(--r-xs)',
            background: type === 'EVENT' ? 'var(--blu-soft)' : 'var(--ac-soft)',
            color: type === 'EVENT' ? 'var(--blu-viz)' : 'var(--ac-text)',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            fontWeight: 500,
            letterSpacing: '.06em',
          }}
        >
          {type}
        </span>
        <span style={{ fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 600 }}>
          Server {type}
        </span>
        <span
          style={{
            marginLeft: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            fontSize: 11.5,
            color: 'var(--tx-muted)',
          }}
        >
          <span style={{ fontFamily: 'var(--font-mono)' }}>{servers.length} server</span>
          <span style={{ fontFamily: 'var(--font-mono)' }}>{numberFmt.format(players)} giocatori</span>
          <span style={{ fontFamily: 'var(--font-mono)' }}>
            {hasMatches ? `${numberFmt.format(matches)} partite` : 'nessuna partita'}
          </span>
          <span style={{ fontFamily: 'var(--font-mono)', color: tpsColour(avgTps) }}>
            TPS medio {avgTpsLabel(avgTps)}
          </span>
        </span>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: cols,
          padding: '10px 20px 8px',
          borderBottom: '1px solid var(--bd-subtle)',
        }}
      >
        {headers.map((h) => (
          <button
            key={h.key}
            type="button"
            onClick={() =>
              onSort({ key: h.key, dir: sort.key === h.key && sort.dir === 'desc' ? 'asc' : 'desc' })
            }
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              justifyContent: h.right ? 'flex-end' : 'flex-start',
              border: 'none',
              background: 'transparent',
              padding: 0,
              color: sort.key === h.key ? 'var(--tx-primary)' : 'var(--tx-muted)',
              fontFamily: 'var(--font-ui)',
              fontSize: 10.5,
              fontWeight: 600,
              letterSpacing: '.1em',
              textTransform: 'uppercase',
              cursor: 'pointer',
            }}
          >
            {h.label}
            <span style={{ fontSize: 10 }}>{sort.key === h.key ? (sort.dir === 'asc' ? '↑' : '↓') : ''}</span>
          </button>
        ))}
      </div>
      {rows.map((s) => (
        <div
          key={s.id}
          style={{
            display: 'grid',
            gridTemplateColumns: cols,
            alignItems: 'center',
            padding: '11px 20px',
            borderBottom: '1px solid var(--bd-subtle)',
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
            <span
              style={{
                width: 7,
                height: 7,
                flex: 'none',
                borderRadius: 'var(--r-full)',
                background: tpsColour(s.tps),
              }}
            />
            <span style={{ minWidth: 0 }}>
              <span
                style={{
                  display: 'block',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                  whiteSpace: 'nowrap',
                }}
              >
                {s.id}
              </span>
              <span
                style={{
                  display: 'block',
                  marginTop: 2,
                  fontSize: 10.5,
                  color: 'var(--tx-muted)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {/* Un server spento resta in elenco e lo dice: sparire e
                    andare bene si assomigliano troppo. */}
                {s.active ? '' : 'non attivo'}
              </span>
            </span>
          </span>
          <span
            style={{
              textAlign: 'right',
              fontFamily: 'var(--font-mono)',
              fontSize: 12.5,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {numberFmt.format(s.players)}
          </span>
          {hasMatches ? (
            <span
              style={{
                textAlign: 'right',
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                fontVariantNumeric: 'tabular-nums',
                color: 'var(--tx-secondary)',
              }}
            >
              {s.matches > 0 ? numberFmt.format(s.matches) : '—'}
            </span>
          ) : null}
          <span style={{ textAlign: 'right' }}>
            <span
              style={{
                display: 'inline-block',
                padding: '2px 7px',
                borderRadius: 'var(--r-xs)',
                background: tpsSoft(s.tps),
                color: tpsColour(s.tps),
                fontFamily: 'var(--font-mono)',
                fontSize: 11.5,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {dec(s.tps)}
            </span>
          </span>
          <span
            style={{
              textAlign: 'right',
              fontFamily: 'var(--font-mono)',
              fontSize: 11.5,
              fontVariantNumeric: 'tabular-nums',
              color: 'var(--tx-muted)',
            }}
          >
            {s.mspt === null ? '—' : `${dec(s.mspt)} ms`}
          </span>
          <span
            style={{
              textAlign: 'right',
              fontFamily: 'var(--font-mono)',
              fontSize: 11.5,
              fontVariantNumeric: 'tabular-nums',
              color: 'var(--tx-muted)',
            }}
          >
            {s.cpu === null ? '—' : `${Math.round(s.cpu * CPU_TO_PERCENT)}%`}
          </span>
        </div>
      ))}
    </Panel>
  );
}

// ---------------------------------------------------------------------------

/**
 * Il roster di una partita.
 *
 * `position: fixed` e non `absolute`: nel mockup la finestra sta dentro un
 * involucro alto quanto lo schermo, qui `main` scorre — e una finestra
 * ancorata al documento scivolerebbe via insieme alla pagina sotto.
 *
 * LE FACCE PASSANO DAL NOSTRO DOMINIO. Il mockup punta a un CDN pubblico;
 * farlo davvero manderebbe il nome di ogni giocatore a un terzo a ogni
 * apertura, e il pannello ha gia' la sua rotta per le skin.
 */
function MatchDialog({
  match,
  at,
  players,
  onClose,
}: {
  match: LiveMatch;
  at: number;
  players: readonly RosterPlayer[];
  onClose: () => void;
}) {
  const isEvent = match.context === 'EVENT';

  // Esc chiude, come ovunque nel pannello.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 45,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 120,
      }}
    >
      {/* Lo sfondo è un PULSANTE, come negli altri dialoghi del pannello:
          «clicca fuori per chiudere» su un div funziona solo col mouse. Il
          colore è quello del mockup, e sta qui invece che sul contenitore
          perché un pulsante trasparente sopra un fondo colorato sarebbe due
          strati per una cosa sola. */}
      <button
        type="button"
        aria-label="Chiudi il roster"
        onClick={onClose}
        style={{
          position: 'absolute',
          inset: 0,
          border: 'none',
          background: 'rgba(4,10,14,.62)',
          cursor: 'default',
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Roster di ${match.mode ?? `#${match.modeId}`}`}
        style={{
          position: 'relative',
          width: 520,
          border: '1px solid var(--bd-strong)',
          borderRadius: 'var(--r-lg)',
          background: 'var(--s-overlay)',
          boxShadow: 'var(--e3)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
            padding: '16px 18px',
            borderBottom: '1px solid var(--bd-subtle)',
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 700 }}>
                {match.mode ?? `#${match.modeId}`}
              </span>
              <span style={{ color: 'var(--tx-muted)', fontSize: 13 }}>
                · {match.map ?? `#${match.mapId}`}
              </span>
              {isEvent ? (
                <span
                  style={{
                    padding: '1px 6px',
                    borderRadius: 'var(--r-xs)',
                    background: 'var(--blu-soft)',
                    color: 'var(--blu-viz)',
                    fontSize: 9.5,
                    fontWeight: 700,
                    letterSpacing: '.08em',
                    textTransform: 'uppercase',
                  }}
                >
                  Event
                </span>
              ) : null}
            </div>
            <div
              style={{
                marginTop: 4,
                fontFamily: 'var(--font-mono)',
                fontSize: 11.5,
                color: 'var(--tx-muted)',
              }}
            >
              {match.id} · {match.server ?? '—'} · in corso da {ageOf(match.createdAt, at)}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Chiudi"
            style={{
              width: 28,
              height: 28,
              flex: 'none',
              border: '1px solid var(--bd-subtle)',
              borderRadius: 'var(--r-sm)',
              background: 'var(--s-inset)',
              color: 'var(--tx-muted)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
            }}
          >
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M18 6 6 18" />
              <path d="M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div style={{ padding: '14px 18px 18px' }}>
          <div
            style={{
              fontSize: 10.5,
              fontWeight: 600,
              letterSpacing: '.12em',
              textTransform: 'uppercase',
              color: 'var(--tx-muted)',
              marginBottom: 10,
            }}
          >
            Giocatori in partita
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {players.map((p) => (
              <div
                key={p.name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 11,
                  padding: '8px 10px',
                  border: '1px solid var(--bd-subtle)',
                  borderRadius: 'var(--r-sm)',
                  background: 'var(--s-inset)',
                }}
              >
                <img
                  src={`/api/avatars/${encodeURIComponent(p.name)}.png`}
                  alt=""
                  style={{
                    width: 26,
                    height: 26,
                    flex: 'none',
                    borderRadius: 'var(--r-xs)',
                    imageRendering: 'pixelated',
                  }}
                />
                <span style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>{p.name}</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--tx-muted)' }}>
                  {p.server ?? '—'}
                </span>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11.5,
                    fontVariantNumeric: 'tabular-nums',
                    color: pingColour(p.ping),
                  }}
                >
                  {p.ping === null ? '—' : `${p.ping} ms`}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
