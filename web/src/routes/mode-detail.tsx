// Dettaglio di una modalità. Segue `frontend/5-dettaglio-modalita.dc.html`.
//
// STESSA SEQUENZA DELLA PANORAMICA, un gradino più giù: intestazione con il
// nome e il colore della modalità, i KPI, l'andamento, la ripartizione accanto
// alla heatmap, gli unici, la provenienza. I riquadri sono gli stessi oggetti
// di `stats-panels.tsx` — se divergessero, la stessa domanda avrebbe due
// risposte a seconda di dove la si fa.
//
// DUE COSE DEL MOCKUP NON CI SONO, e non è una dimenticanza.
//
// Il KPI «Picco». `ModePayload.kpi.peak` è nullo per disegno: il massimo
// contemporaneo non si decompone. Il picco della rete non è la somma dei
// picchi delle modalità — sono istanti diversi — e ripartirlo produrrebbe un
// limite inferiore etichettato «picco», cioè un numero più piccolo del vero
// con l'aria di essere esatto. Al suo posto c'è la copertura, che dice quanto
// del periodo è stato davvero osservato.
//
// «Nuovi vs di ritorno» nel grafico degli unici. Richiede di sapere quando un
// giocatore è stato visto la prima volta, e il poller non raccoglie
// l'anagrafica: è la stessa ragione per cui «Nuovi giocatori oggi» è stato
// tolto dalla panoramica. Una barra sola, non due di cui una inventata.
//
// UN RIQUADRO IN PIÙ, chiesto e giusto: la ripartizione per SERVER. La
// panoramica divide la rete per modalità; qui si divide la modalità per
// server, perché quasi tutte ne hanno più di uno e «duels ha 286 giocatori»
// non dice se sono su una macchina o su sei. Resta anche con un server solo:
// «tutta su duels_1» è un fatto, e un riquadro che appare e scompare a seconda
// dei dati fa dubitare ogni volta che manchi qualcosa.

import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import {
  type Card,
  DailyUniques,
  Donut,
  FALLBACK,
  Heatmap,
  hhmm,
  KpiCard,
  NotYet,
  numberFmt,
  OnlineChart,
  type Overview,
  StatsPanelsSkeleton,
  StatsSkeleton,
} from '../components/stats-panels.tsx';
import { WorldMap } from '../components/world-map.tsx';
import { apiWithHeaders } from '../lib/api.ts';
import { slicesOf } from '../lib/distribution.ts';
import { labelOf, type Range, useRange } from '../lib/range.tsx';
import { axisLabel } from '../lib/when.ts';

type ModeStats = Overview & {
  mode: string;
  serverMix: { at: number; byServer: Record<string, number> } | null;
};

/**
 * Un colore stabile per un SERVER.
 *
 * I server non stanno nel dizionario e non hanno un colore scelto
 * dall'operatore: quello è una decisione sulla modalità, non sulla macchina su
 * cui gira. Qui il colore serve solo a distinguere le fette fra loro, quindi
 * si assegna per posizione in un elenco ORDINATO — non nell'ordine in cui il
 * database le ha restituite, che non è promesso e cambierebbe i colori a ogni
 * aggiornamento.
 */
function serverPalette(keys: string[]): (key: string) => string {
  const sorted = [...keys].sort();
  return (key: string) => {
    const i = sorted.indexOf(key);
    return i < 0 ? 'var(--tx-muted)' : (FALLBACK[i % FALLBACK.length] as string);
  };
}

/**
 * Nome, colore e schede: la parte che si sa SEMPRE.
 *
 * Sta in un componente a parte perché la disegnano due rami — la pagina piena e
 * quella che sta caricando una modalità nuova — e devono essere identici, senza
 * uno scarto di un pixel al momento del cambio. Tutto quello che le serve viene
 * da `key` e dal dizionario, che ogni payload porta intero e che non dipende né
 * dal periodo né dalla modalità: quindi è corretto anche mentre l'unico payload
 * in mano parla ancora della modalità di prima.
 */
function ModeHeader({
  mode,
  labels,
  colorOf,
  range,
  when,
}: {
  mode: string;
  labels: Record<string, string>;
  colorOf: (m: string) => string;
  range: Range;
  when: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 20 }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <span style={{ width: 11, height: 11, borderRadius: 3, background: colorOf(mode), flex: 'none' }} />
          <h2
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 22,
              lineHeight: '30px',
              fontWeight: 700,
              letterSpacing: '-.01em',
              margin: 0,
            }}
          >
            {labels[mode] ?? mode}
          </h2>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--tx-muted)' }}>
          {labelOf(range)} · fuso Europe/Rome · {when}
        </div>
      </div>

      {/*
        Le altre modalità, dal DIZIONARIO del payload — non da una seconda
        chiamata. Ogni payload porta l'elenco completo da quando nomi e colori
        hanno smesso di dipendere dal range, quindi la barra è identica su ogni
        modalità e non cambia mentre si naviga.
      */}
      <div
        style={{
          display: 'flex',
          gap: 2,
          padding: 3,
          background: 'var(--s-inset)',
          border: '1px solid var(--bd-subtle)',
          borderRadius: 'var(--r-sm)',
          flexWrap: 'wrap',
        }}
      >
        {Object.keys(labels)
          .filter((m) => !m.startsWith('__'))
          .map((m) => (
            <Link
              key={m}
              to="/modalita/$key"
              params={{ key: m }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                borderRadius: 'var(--r-xs)',
                background: m === mode ? 'var(--s-elevated)' : 'transparent',
                color: m === mode ? 'var(--tx-primary)' : 'var(--tx-secondary)',
                fontSize: 12.5,
                fontWeight: 600,
                padding: '6px 11px',
                textDecoration: 'none',
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: 2, background: colorOf(m), flex: 'none' }} />
              {labels[m] ?? m}
            </Link>
          ))}
      </div>
    </div>
  );
}

export function ModeDetailPage() {
  const { range } = useRange();
  const { key } = useParams({ from: '/shell/modalita/$key' });

  const q = useQuery({
    // La chiave porta modalità E periodo: senza, passando da una modalità
    // all'altra react-query servirebbe i numeri di quella di prima sotto il
    // nome nuovo.
    queryKey: ['stats-mode', key, range],
    queryFn: () =>
      apiWithHeaders<ModeStats>(`/api/stats/mode?mode=${encodeURIComponent(key)}&range=${range}`),
    refetchInterval: 60_000,
    // IL PAYLOAD DI PRIMA SI TIENE SEMPRE, anche di un'altra modalità: porta
    // il dizionario, che è completo e non dipende né dal periodo né dalla
    // modalità, e quindi sa già come si chiama e di che colore è quella
    // appena chiesta. Senza, l'intestazione non avrebbe niente da disegnare e
    // la barra delle modalità sparirebbe sotto il dito che l'ha appena
    // toccata. Cosa si può disegnare oltre all'intestazione lo decide
    // `stale`, non questa riga: i NUMERI di prima non si mostrano mai sotto
    // il nome di un'altra modalità.
    placeholderData: (previous) => previous,
  });

  const data = q.data?.data;
  /** Il payload in mano parla di un'altra modalità: intestazione sì, numeri no. */
  const stale = data !== undefined && data.mode !== key;
  /** Stessa modalità, periodo nuovo in arrivo: si smorza invece di sparire. */
  const refreshing = q.isPlaceholderData && q.isFetching && !stale;

  /** Gli estremi del periodo disegnato, per l'etichetta dell'asse. */
  const span = useMemo(() => {
    const t = data?.online.t ?? [];
    if (t.length === 0) return null;
    const from = t[0] as number;
    const to = t[t.length - 1] as number;
    return { from, to, sec: to - from };
  }, [data?.online.t]);

  /** Le fette per server, di adesso. Il selettore in alto non le governa. */
  const mix = useMemo(() => slicesOf(data?.serverMix?.byServer), [data?.serverMix]);
  const colorOfServer = useMemo(
    () => serverPalette(Object.keys(data?.serverMix?.byServer ?? {})),
    [data?.serverMix],
  );

  /** Il colore della modalità: dal dizionario, come sulla panoramica. */
  const colorOfMode = useMemo(() => {
    const dictionary = Object.keys(data?.labels ?? {});
    const chosen = data?.colors ?? {};
    return (m: string) => {
      const own = chosen[m];
      if (own) return own;
      const i = dictionary.indexOf(m);
      return i < 0 ? 'var(--tx-muted)' : (FALLBACK[i % FALLBACK.length] as string);
    };
  }, [data?.labels, data?.colors]);

  if (q.isError) {
    return (
      <div style={{ padding: 24, fontSize: 13, color: 'var(--tx-secondary)' }}>
        Questa modalità non ha dati da mostrare. Può essere una chiave che non esiste, oppure una modalità
        senza nessun server assegnato: in quel caso non ha osservazioni, e il pannello preferisce dirlo invece
        di disegnare degli zeri.{' '}
        <Link to="/panoramica" style={{ color: 'var(--ac-text)' }}>
          Torna alla panoramica
        </Link>
        .
      </div>
    );
  }
  // Primo ingresso: non si sa ancora niente, nemmeno il dizionario.
  if (!data) return <StatsSkeleton cards={4} />;

  // Modalità appena cambiata. L'intestazione è già quella giusta — nome,
  // colore e scheda evidenziata vengono da `key` e dal dizionario, non dai
  // numeri — e sotto caricano i riquadri. Restare sui numeri di prima sarebbe
  // la solita risposta giusta alla domanda sbagliata.
  if (stale) {
    return (
      <main style={{ display: 'flex', flexDirection: 'column', gap: 24 }} aria-busy>
        <ModeHeader
          mode={key}
          labels={data.labels}
          colorOf={colorOfMode}
          range={range}
          when={<span style={{ color: 'var(--tx-muted)' }}>caricamento…</span>}
        />
        <StatsPanelsSkeleton cards={4} />
      </main>
    );
  }

  const label = data.labels[key] ?? key;
  const online = mix.slices.reduce((a, s) => a + s.value, 0);
  const today = data.uniques.v.length > 0 ? (data.uniques.v[data.uniques.v.length - 1] ?? null) : null;

  const cards: Card[] = [
    {
      label: 'Giocatori online ora',
      value: data.serverMix ? numberFmt.format(Math.round(online)) : '—',
      unit: 'gioc.',
      delta: '',
      note: data.serverMix ? `rilevato alle ${hhmm(data.serverMix.at)}` : 'nessun bucket chiuso',
      tone: 'muted',
      ready: data.serverMix !== null,
    },
    {
      label: 'Media del periodo',
      value: data.kpi.avg === null ? '—' : numberFmt.format(Math.round(data.kpi.avg)),
      unit: 'gioc.',
      delta: '',
      // LA MEDIA E' PESATA SULLA COPERTURA, non sui punti del grafico: una
      // modalità aperta cinque minuti al giorno con 200 giocatori ha media
      // giornaliera 0,7, non 200.
      note: `su ${Math.round(data.kpi.coverage * 100)}% del periodo osservato`,
      tone: 'muted',
      ready: data.kpi.avg !== null,
    },
    {
      label: 'Giocatori unici',
      value: today === null ? '—' : numberFmt.format(today),
      unit: 'gioc.',
      delta: '',
      note: today === null ? 'nessun giorno con dati' : 'giorno in corso',
      tone: 'muted',
      ready: today !== null,
    },
    {
      label: 'Server attivi',
      value: data.serverMix ? String(Object.keys(data.serverMix.byServer).length) : '—',
      unit: Object.keys(data.serverMix?.byServer ?? {}).length === 1 ? 'server' : 'server',
      delta: '',
      note: 'nell`ultimo campione',
      tone: 'muted',
      ready: data.serverMix !== null,
    },
  ];

  return (
    <main
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 24,
        opacity: refreshing ? 0.5 : 1,
        transition: 'opacity var(--dur) var(--ease)',
      }}
      aria-busy={refreshing}
    >
      <ModeHeader
        mode={key}
        labels={data.labels}
        colorOf={colorOfMode}
        range={range}
        when={<span className="mono">aggiornato {hhmm(data.generatedAt)}</span>}
      />

      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cards.length}, 1fr)`, gap: 12 }}>
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
            Giocatori su {label} · {labelOf(range)} ({span === null ? '—' : axisLabel(span.from, span.sec)}–
            {span === null ? '—' : axisLabel(span.to, span.sec)}, Europe/Rome) · copertura{' '}
            {Math.round(data.kpi.coverage * 100)}%
          </div>
        </div>
        {/*
          Nessuna legenda: la serie è una sola, e una legenda con una voce
          sola è una riga che occupa spazio per non dire niente. `hidden`
          vuoto perché non c'è niente da spegnere.
        */}
        <OnlineChart data={data} hidden={new Set()} colorOf={colorOfMode} />
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: '420px 1fr', gap: 16 }}>
        <Donut
          title="Distribuzione per server"
          note="Popolazione corrente"
          hint={`Su quali macchine gira ${label} in questo momento.`}
          at={data.serverMix?.at ?? null}
          slices={mix.slices}
          excluded={mix.excluded}
          excludedNote="giocatori su server esclusi dalla ripartizione."
          centre={data.serverMix ? online : null}
          centreLabel="online adesso"
          labelOf={(k) => k}
          colorOf={colorOfServer}
          emptyNote="Nessuna misura ancora: il campionamento non ha prodotto bucket chiusi."
        />
        <Heatmap data={data} label={`${label} · ${labelOf(range)}`} />
      </div>

      <DailyUniques data={data} label={`${label} · ${labelOf(range)}`} />

      {data.geo ? (
        <WorldMap geo={data.geo} label={`${label} · ${labelOf(range)}`} />
      ) : (
        <NotYet
          title="Provenienza geografica"
          sub={`Giocatori unici di ${label} · ${labelOf(range)} · scala per quantili, non lineare`}
          what={
            data.geoEnabled
              ? `nessun giocatore di ${label} registrato con un paese in questo periodo`
              : 'geolocalizzazione non attiva'
          }
        />
      )}
    </main>
  );
}
