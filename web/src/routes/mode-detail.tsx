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
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { type Dictionary, EditModeDialog, NewModeDialog } from '../components/mode-editor.tsx';
import { ModePicker } from '../components/mode-picker.tsx';
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
import { Button } from '../components/ui.tsx';
import { WorldMap } from '../components/world-map.tsx';
import { api, apiWithHeaders, type Me } from '../lib/api.ts';
import { slicesOf } from '../lib/distribution.ts';
import { labelOf, type Range, useRange } from '../lib/range.ts';
import { axisLabel } from '../lib/when.ts';

type ModeStats = Overview & {
  mode: string;
  serverMix: { at: number; byServer: Record<string, number> } | null;
  byServer: { keys: string[]; series: Record<string, (number | null)[]> } | null;
};

/** Un solo server: si disegna il totale e basta. Vedi `ModePayload.byServer`. */
const NO_PARTS = { keys: [], series: {} };

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
 * Nome, colore e selettore: la parte che si sa SEMPRE.
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
  actions,
}: {
  mode: string;
  labels: Record<string, string>;
  colorOf: (m: string) => string;
  range: Range;
  when: ReactNode;
  actions: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 20 }}>
      <div>
        {/*
          Il selettore È il titolo, e l'elenco viene dal DIZIONARIO del payload
          — non da una seconda chiamata. Ogni payload lo porta intero da quando
          nomi e colori hanno smesso di dipendere dal range, quindi il menù è
          identico su ogni modalità e non cambia mentre si naviga.
        */}
        <ModePicker mode={mode} labels={labels} colorOf={colorOf} />
        <div style={{ fontSize: 12.5, color: 'var(--tx-muted)', marginTop: 6 }}>
          {labelOf(range)} · fuso Europe/Rome · {when}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 'none' }}>{actions}</div>
    </div>
  );
}

/**
 * Vero quando `flag` è vero ININTERROTTAMENTE da almeno `ms`.
 *
 * Serve a non mostrare mai un'attesa che non c'è stata. Uno scheletro che
 * compare e sparisce in centocinquanta millisecondi si legge come uno sfarfallio,
 * non come un caricamento: è più fastidioso del caricamento stesso, e la rotta
 * risponde quasi sempre più in fretta di così. Il ritardo lo tiene fuori dal
 * caso normale senza toglierlo dal caso lento, dove invece serve.
 */
function useSettled(flag: boolean, ms: number): boolean {
  const [elapsed, setElapsed] = useState(false);

  useEffect(() => {
    if (!flag) {
      setElapsed(false);
      return;
    }
    const timer = setTimeout(() => setElapsed(true), ms);
    return () => clearTimeout(timer);
  }, [flag, ms]);

  return flag && elapsed;
}

export function ModeDetailPage({ me }: { me: Me }) {
  const { range } = useRange();
  const { key } = useParams({ from: '/shell/dettaglio-modalita/$key' });
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  /** I server spenti dalla legenda. Locale: è una preferenza di lettura. */
  const [hiddenServers, setHiddenServers] = useState<Set<string>>(new Set());
  const canManage = (me.permissions.statistiche ?? 0) >= 3;

  // IL DIZIONARIO SI SCARICA SOLO A CHI PUO' USARLO. Serve ai due dialoghi —
  // regole, server liberi, chiavi già prese — e chi non gestisce le modalità
  // non vede nemmeno i pulsanti: fargli pagare la richiesta sarebbe un costo
  // per una cosa che non può fare.
  const dict = useQuery({
    queryKey: ['stats-modes'],
    queryFn: () => api<Dictionary>('/api/stats/modes'),
    enabled: canManage,
  });

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
    // toccata. Quanto a lungo si possano tenere anche i NUMERI lo decide
    // `tooLong`, non questa riga.
    placeholderData: (previous) => previous,
  });

  const data = q.data?.data;
  /** Numeri di prima sullo schermo, nuovi in arrivo. Cambio di periodo o di modalità. */
  const busy = q.isPlaceholderData && q.isFetching;
  /** I numeri in mano sono di un'altra modalità: l'intestazione è avanti, loro no. */
  const stale = data !== undefined && data.mode !== key;
  /**
   * Il ritardo è finito e i numeri di prima non si possono più tenere.
   *
   * Sotto i due decimi di secondo — il caso normale, la rotta sta sui 50-130ms
   * — non compare niente: i grafici si smorzano e vengono sostituiti, come
   * cambiando periodo. Oltre, smorzati o no restano i numeri di un'altra
   * modalità sotto un altro nome, e allora lo scheletro dice la verità.
   */
  const tooLong = useSettled(stale, 220);

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

  /**
   * UNA SOLA TAVOLOZZA PER I SERVER, dall'unione dei due riquadri.
   *
   * La torta guarda adesso, il grafico guarda il periodo: un server spento
   * ieri sta solo nel secondo, uno acceso da un'ora quasi solo nel primo.
   * Costruendo due tavolozze separate, ognuna sui propri nomi, lo stesso
   * server prenderebbe due colori diversi in due riquadri affiancati — e il
   * colore smetterebbe di identificare qualcosa proprio dove serve di più.
   */
  const colorOfServer = useMemo(
    () =>
      serverPalette([
        ...new Set([...(data?.byServer?.keys ?? []), ...Object.keys(data?.serverMix?.byServer ?? {})]),
      ]),
    [data?.byServer, data?.serverMix],
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

  /** Tutti i server osservati: quelli assegnati e quelli ancora liberi. */
  const allServers = useMemo(
    () => [...(dict.data?.unclassified ?? []), ...(dict.data?.modes ?? []).flatMap((m) => m.servers)].sort(),
    [dict.data],
  );
  /** La riga di dizionario di QUESTA modalità: regole, colore scelto, bandiere. */
  const record = dict.data?.modes.find((m) => m.modeKey === key);

  // I due pulsanti del mockup, a destra dell'intestazione. Compaiono solo a
  // chi può usarli: un pulsante che risponde «non puoi» è un modo di far
  // scoprire i permessi provandoli.
  const actions = canManage ? (
    <>
      <Button size="sm" disabled={!record} onClick={() => setEditing(true)}>
        Modifica
      </Button>
      <Button size="sm" variant="primary" disabled={!dict.data} onClick={() => setCreating(true)}>
        Nuova modalità
      </Button>
    </>
  ) : null;

  const dialogs = (
    <>
      {editing && record ? (
        <EditModeDialog
          mode={record}
          onDeleted={() => {
            setEditing(false);
            // All'ingresso, non alla panoramica: risolve di nuovo la più
            // popolata fra quelle rimaste. `replace` perché la modalità appena
            // eliminata non deve restare nella cronologia.
            void navigate({ to: '/dettaglio-modalita', replace: true });
          }}
          available={allServers}
          canManage={canManage}
          onClose={() => setEditing(false)}
        />
      ) : null}
      {creating && dict.data ? (
        <NewModeDialog
          available={allServers}
          taken={dict.data.modes.map((m) => m.modeKey)}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </>
  );

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

  // La modalità nuova si fa attendere. Fin qui i riquadri di prima erano
  // rimasti smorzati — così il cambio di modalità si legge come quello di
  // periodo, che è la cosa che funzionava — ma oltre un certo punto tenerli
  // vuol dire lasciare i numeri di un'altra modalità sotto un altro nome, e a
  // quel punto lo scheletro dice la verità. L'intestazione resta comunque
  // quella giusta: nome, colore e scheda evidenziata vengono da `key` e dal
  // dizionario, non dai numeri.
  if (tooLong) {
    return (
      <main style={{ display: 'flex', flexDirection: 'column', gap: 24 }} aria-busy>
        <ModeHeader
          mode={key}
          labels={data.labels}
          colorOf={colorOfMode}
          range={range}
          when={<span style={{ color: 'var(--tx-muted)' }}>caricamento…</span>}
          actions={actions}
        />
        <StatsPanelsSkeleton cards={4} />
        {dialogs}
      </main>
    );
  }

  // L'etichetta dei RIQUADRI segue i dati, non l'URL. Finché sotto ci sono i
  // numeri della modalità di prima, i riquadri dicono di chi sono: altrimenti
  // per un attimo si leggerebbe «Giocatori su Duels» sopra la curva di Towny,
  // che è la solita bugia plausibile, solo più breve. L'intestazione invece
  // segue `key`, perché quella deve rispondere al clic. A dire che i due non
  // sono ancora d'accordo è la smorzatura.
  const label = data.labels[data.mode] ?? data.mode;
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
        opacity: busy ? 0.5 : 1,
        transition: 'opacity var(--dur) var(--ease)',
      }}
      aria-busy={busy}
    >
      <ModeHeader
        mode={key}
        labels={data.labels}
        colorOf={colorOfMode}
        range={range}
        when={<span className="mono">aggiornato {hhmm(data.generatedAt)}</span>}
        actions={actions}
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
          LA LEGENDA COMPARE SOLO SE C'È QUALCOSA DA DISTINGUERE. Con un
          server solo la riga è una — il totale — e una legenda con una voce
          sola occupa spazio per non dire niente.
        */}
        {data.byServer ? (
          <div
            style={{
              display: 'flex',
              gap: 16,
              padding: '0 20px 6px',
              flexWrap: 'wrap',
              alignItems: 'center',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, fontWeight: 600 }}>
              <span style={{ width: 18, height: 3, borderRadius: 2, background: 'var(--ac)' }} />
              Totale {label}
            </div>
            {data.byServer.keys.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() =>
                  setHiddenServers((prev) => {
                    const next = new Set(prev);
                    if (next.has(s)) next.delete(s);
                    else next.add(s);
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
                  opacity: hiddenServers.has(s) ? 0.35 : 1,
                }}
              >
                <span style={{ width: 18, height: 3, borderRadius: 2, background: colorOfServer(s) }} />
                {s}
              </button>
            ))}
          </div>
        ) : null}
        {/*
          Il totale resta la riga della MODALITÀ: spegnere un server dalla
          legenda toglie la sua riga, non lo sottrae dal totale. Il totale è
          misurato, non sommato — è la stessa regola della riga di rete sulla
          panoramica, un gradino più giù.
        */}
        <OnlineChart
          data={data}
          hidden={hiddenServers}
          colorOf={colorOfServer}
          parts={data.byServer ?? NO_PARTS}
        />
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
      {dialogs}
    </main>
  );
}
