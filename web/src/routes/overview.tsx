// Panoramica network. Segue `frontend/4-panoramica-network.dc.html`.
//
// L'ORDINE E LE POSIZIONI SONO QUELLI DEL MOCKUP, e non è pignoleria: la
// pagina è una sequenza di risposte a domande che si fanno in quell'ordine —
// quanti ce ne sono adesso, come è andata la giornata, dove stanno, quando
// vengono, chi sono, da dove.
//
//   1. intestazione: titolo e periodo
//   2. i KPI in riga
//   3. andamento online nel tempo, con la legenda delle modalità
//   4. distribuzione per modalità (420px) accanto alla heatmap
//   5. giocatori unici giornalieri
//   6. provenienza geografica
//
// COSA NON HA ANCORA DATI, e perché non lo si finge. Dove il dato manca, il
// riquadro lo dice invece di mostrare uno zero: uno zero al posto di un dato
// mancante è la stessa bugia che il resto di questo lavoro esiste per impedire.
//
// «Nuovi giocatori oggi» non c'è più. Richiedeva l'anagrafica dei giocatori,
// che il poller non raccoglie: restava un riquadro permanentemente vuoto, e un
// posto vuoto che non si riempirà occupa attenzione senza restituire niente.
// Dire «non lo so» ha senso finché è una notizia; ripeterlo per sempre no.

// I riquadri stanno in `components/stats-panels.tsx`: li disegna anche il
// dettaglio di una modalità, e due copie dello stesso grafico divergono al
// primo ritocco — in silenzio, perché nessuna delle due smette di funzionare.

import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {
  type Card,
  DailyUniques,
  Donut,
  dayFmt,
  FALLBACK,
  Heatmap,
  hhmm,
  KpiCard,
  NotYet,
  numberFmt,
  OnlineChart,
  type Overview,
  StatsSkeleton,
} from '../components/stats-panels.tsx';
import { WorldMap } from '../components/world-map.tsx';
import { apiWithHeaders } from '../lib/api.ts';
import { slicesOf } from '../lib/distribution.ts';
import { labelOf, useRange } from '../lib/range.ts';
import { axisLabel, dayAndTime } from '../lib/when.ts';

export function OverviewPage() {
  const { range } = useRange();
  // `null` = l'operatore non ha ancora toccato la legenda in questa sessione.
  //
  // IL DIZIONARIO SEMINA, NON COMANDA. `stats.mode.hidden` dice quali serie
  // NON accendere all'apertura; da quel momento in poi decidono i click. Con
  // un `useEffect` che risincronizza a ogni payload, il refetch ogni minuto
  // riaccenderebbe cio' che era stato appena spento — e sembrerebbe un difetto
  // del grafico, non una regola.
  const [hidden, setHidden] = useState<Set<string> | null>(null);

  const q = useQuery({
    // La chiave PORTA il periodo: senza, cambiando selettore react-query
    // servirebbe la risposta gia' in cache per un altro intervallo, e la
    // pagina mostrerebbe i numeri di prima sotto l'etichetta nuova.
    queryKey: ['stats-overview', range],
    queryFn: () => apiWithHeaders<Overview>(`/api/stats/overview?range=${range}`),
    refetchInterval: 60_000,
    // I NUMERI DI PRIMA RESTANO FINCHE' ARRIVANO QUELLI DOPO.
    //
    // Senza, cambiando periodo la chiave cambia, react-query torna
    // `undefined` e la pagina spariva per un istante — con la barra laterale
    // ferma, il che la faceva sembrare rotta invece che occupata. Il soggetto
    // qui e' sempre lo stesso (la rete), quindi tenere i numeri vecchi non
    // puo' mai mostrarli sotto l'etichetta di qualcos'altro: cambia solo il
    // periodo, e finche' non e' arrivato la pagina si smorza per dirlo.
    placeholderData: (previous) => previous,
  });

  const data = q.data?.data;
  /** Sta arrivando un periodo nuovo mentre si guardano i numeri di prima. */
  const refreshing = q.isPlaceholderData && q.isFetching;
  const onlineNow = q.data?.headers.get('X-Online-Now');
  const onlineAt = q.data?.headers.get('X-Online-Now-At');

  /** Gli estremi del periodo disegnato, e la sua ampiezza. `null` se vuoto. */
  const span = useMemo(() => {
    const t = data?.online.t ?? [];
    if (t.length === 0) return null;
    const from = t[0] as number;
    const to = t[t.length - 1] as number;
    return { from, to, sec: to - from };
  }, [data?.online.t]);

  /** Cosa è spento adesso: i click se ci sono stati, altrimenti il dizionario. */
  const hiddenNow = useMemo(() => hidden ?? new Set(data?.hidden ?? []), [hidden, data?.hidden]);

  /** Le fette di ADESSO. Il selettore in alto non le tocca: vedi `slicesOf`. */
  const mix = useMemo(
    () => slicesOf(data?.current?.byMode, data?.outOfBreakdown),
    [data?.current, data?.outOfBreakdown],
  );

  // IL COLORE IDENTIFICA UNA MODALITÀ, quindi non può dipendere dal periodo.
  //
  // Prima si assegnava per indice sull'elenco delle modalità presenti nella
  // serie del range: la stessa modalità cambiava colore cambiando periodo, e
  // bastava che una entrasse o uscisse dallo storico per ricolorare tutte
  // quelle dopo di lei. Un colore che cambia non identifica più niente — e
  // peggio, invita a leggere due grafici affiancati come se lo facesse.
  //
  // Ora viene dal dizionario (`stats.mode.color`, scelto dall'operatore), che
  // non sa cosa sia un range. Chi non ha ancora un colore proprio ripiega
  // sulla sua POSIZIONE nel dizionario, che è comunque stabile.
  const colorOf = useMemo(() => {
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
        Le statistiche non sono disponibili. Se il pannello è appena stato aggiornato, manca
        <span className="mono"> DATABASE_STATS_URL</span>: le rotte rispondono 503 finché non c’è il ruolo di
        sola lettura.
      </div>
    );
  }
  if (!data) return <StatsSkeleton cards={4} />;

  // LE CINQUE DEL DESIGN, nello stesso ordine e con le stesse etichette.
  //
  // Tre non hanno ancora un dato: unici e nuovi arrivano dalle sessioni
  // (passo 6), il record storico da una query su tutto lo storico che non
  // esiste ancora. Mostrano «—» e dicono cosa manca. Sostituirle con carte
  // che ho a disposizione — media, copertura — sarebbe stato comodo e
  // sbagliato: la pagina va confrontata col design, e due carte diverse
  // rendono il confronto impossibile a chiunque non le abbia scritte.
  const today = data.uniques.v.length > 0 ? (data.uniques.v[data.uniques.v.length - 1] ?? null) : null;

  const cards: Card[] = [
    {
      label: 'Giocatori online ora',
      value: onlineNow ? numberFmt.format(Number(onlineNow)) : '—',
      unit: 'gioc.',
      delta: '',
      note: onlineAt ? `rilevato alle ${hhmm(Number(onlineAt))}` : 'nessun ciclo recente',
      tone: 'muted',
      ready: Boolean(onlineNow),
    },
    {
      label: 'Picco del periodo',
      value: data.kpi.peak === null ? '—' : numberFmt.format(data.kpi.peak),
      unit: 'gioc.',
      // Il massimo non viaggia mai da solo: senza il suo istante e la
      // copertura del bucket in cui e' avvenuto non e' verificabile.
      delta: '',
      // DUE ASSENZE DIVERSE, e chiamarle allo stesso modo manda a cercare la
      // cosa sbagliata. «Nessun bucket chiuso» vuol dire che il periodo c'è
      // ma il campionamento non ha ancora chiuso niente — si aspetta. Un
      // periodo interamente vuoto vuol dire che per quel range non esiste
      // storico: sull'1y i punti sono i rollup giornalieri, e finché non ce
      // n'è nemmeno uno non c'è niente da aspettare, c'è un livello di
      // aggregazione che non ha ancora girato.
      note: data.kpi.peakAt
        ? dayAndTime(data.kpi.peakAt)
        : data.online.total.every((v) => v === null)
          ? 'nessun dato in questo periodo'
          : 'nessun bucket chiuso',
      tone: 'muted',
      ready: data.kpi.peak !== null,
    },
    {
      label: 'Giocatori unici',
      value: today === null ? '—' : numberFmt.format(today),
      unit: 'gioc.',
      delta: '',
      // Il giorno in corso non e' definitivo: dirlo evita che qualcuno lo
      // annoti come il totale della giornata a meta' pomeriggio.
      note: today === null ? 'nessun giorno con dati' : 'giorno in corso',
      tone: 'muted',
      ready: today !== null,
    },
    {
      label: 'Record storico',
      value: data.record ? numberFmt.format(data.record.players) : '—',
      unit: 'gioc.',
      delta: '',
      // DA QUANDO, sempre. Un «record di sempre» calcolato su tre giorni di
      // raccolta e` un record di tre giorni, e chi lo legge non ha modo di
      // saperlo dal numero. Il giorno in cui lo storico sara` lungo, questa
      // nota smettera` di essere una precisazione e diventera` un vanto.
      note: data.record
        ? `dal ${dayFmt.format(new Date(data.record.since * 1000))}`
        : 'nessun giorno con dati',
      tone: 'muted',
      ready: data.record !== null,
    },
  ];

  return (
    <main
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 24,
        // Si smorza, non sparisce: la posizione di ogni riquadro resta, quindi
        // non c'e' nessun salto quando i numeri nuovi atterrano.
        opacity: refreshing ? 0.5 : 1,
        transition: 'opacity var(--dur) var(--ease)',
      }}
      aria-busy={refreshing}
    >
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
          {/*
            IL PERIODO VIENE DAL SELETTORE. Era scritto a mano — «Ultime 24
            ore» — e restava tale su ogni periodo: con l'apertura su 7g la
            pagina si presentava contraddicendo il pulsante acceso sopra di
            sé, e su un anno di dati diceva ventiquattro ore.
          */}
          <div style={{ fontSize: 12.5, color: 'var(--tx-muted)' }}>
            {labelOf(range)} · fuso Europe/Rome · aggiornato{' '}
            <span className="mono">{hhmm(data.generatedAt)}</span>
          </div>
        </div>
      </div>

      {/*
        Le colonne le conta l'array, non io. Erano cinque scritte a mano:
        togliendo una carta restava una colonna vuota a destra, cioè un
        buco che sembra un riquadro non caricato.
      */}
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
            {/*
              Gli estremi si scrivono con la stessa regola dell'asse: erano
              ore e minuti sempre, quindi su un anno di dati l'intervallo
              diceva «00:00–00:00». Sul 24h la regola tiene il giorno della
              settimana, ed è un guadagno: «mer 12:00–gio 12:00» dice a colpo
              d'occhio che la finestra scavalca la mezzanotte, che è
              esattamente l'equivoco del picco.
            */}
            Giocatori connessi · {labelOf(range)} ({span === null ? '—' : axisLabel(span.from, span.sec)}–
            {span === null ? '—' : axisLabel(span.to, span.sec)}, Europe/Rome) · copertura{' '}
            {Math.round(data.kpi.coverage * 100)}%
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
                  const next = new Set(prev ?? data.hidden);
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
                opacity: hiddenNow.has(m) ? 0.35 : 1,
              }}
            >
              <span style={{ width: 18, height: 3, borderRadius: 2, background: colorOf(m) }} />
              {data.labels[m] ?? m}
            </button>
          ))}
        </div>
        <OnlineChart data={data} hidden={hiddenNow} colorOf={colorOf} />
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: '420px 1fr', gap: 16 }}>
        <Donut
          title="Distribuzione per modalità"
          note="Popolazione corrente"
          hint="«Non classificata» raccoglie i server non ancora tracciati."
          at={data.current?.at ?? null}
          slices={mix.slices}
          excluded={mix.excluded}
          excludedNote="giocatori in modalità escluse dalla ripartizione: le percentuali qui sopra non li contano."
          centre={onlineNow ? Number(onlineNow) : null}
          centreLabel="online adesso"
          labelOf={(k) => data.labels[k] ?? k}
          colorOf={colorOf}
          emptyNote="Nessuna misura ancora: il campionamento non ha prodotto bucket chiusi."
        />
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
              ? // «oggi» era rimasto da quando la mappa era ferma al giorno
                // corrente. Ora la geografia segue il selettore come tutto il
                // resto, e il riquadro si contraddiceva da solo: sotto un
                // sottotitolo che diceva «1y» spiegava un'assenza «di oggi».
                `nessun giocatore registrato con un paese in questo periodo (${labelOf(range)})`
              : 'geolocalizzazione non attiva'
          }
        />
      )}
    </main>
  );
}
