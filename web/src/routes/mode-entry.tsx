// L'ingresso al dettaglio quando nessuno ha detto QUALE modalità.
//
// «Dettaglio modalità» nella barra a sinistra non può portare a una modalità
// fissata nel codice: sarebbe quella giusta il primo giorno e quella sbagliata
// tutti gli altri. Porta invece alla più popolata in questo momento, che è la
// domanda che si sta facendo chi clicca — «dov'è la gente adesso» — e che si
// aggiorna da sola quando la rete cambia.
//
// PERCHE' UNA ROTTA E NON UN CALCOLO NELLA BARRA. Il collegamento nella barra
// dovrebbe conoscere la classifica per poterla puntare, cioè avere già in
// mano la panoramica: al primo caricamento non ce l'ha, e la voce resterebbe
// morta o punterebbe a caso. Una rotta che risolve e rimanda funziona anche a
// freddo, e funziona pure da segnalibro.
//
// LA PANORAMICA E' GIA' IN CASSA quasi sempre — stessa chiave, stesso periodo
// della schermata accanto — quindi arrivare qui di norma non costa una
// richiesta in più, e `current` non dipende dal periodo: qualunque payload la
// risponde.

import { useQuery } from '@tanstack/react-query';
import { Link, Navigate } from '@tanstack/react-router';
import { type Overview, StatsSkeleton } from '../components/stats-panels.tsx';
import { apiWithHeaders } from '../lib/api.ts';
import { busiestMode } from '../lib/busiest.ts';
import { useRange } from '../lib/range.tsx';

export function ModeEntryPage() {
  const { range } = useRange();

  const q = useQuery({
    // ESATTAMENTE la chiave della panoramica, perché è esattamente la stessa
    // richiesta: se fosse una chiave sua, entrare di qui pagherebbe una
    // seconda volta una risposta che il client ha già.
    queryKey: ['stats-overview', range],
    queryFn: () => apiWithHeaders<Overview>(`/api/stats/overview?range=${range}`),
  });

  const data = q.data?.data;

  if (q.isError) {
    return (
      <div style={{ padding: 24, fontSize: 13, color: 'var(--tx-secondary)' }}>
        Le statistiche non sono raggiungibili in questo momento, quindi non c'è modo di dire quale modalità
        sia la più popolata.{' '}
        <Link to="/modalita" style={{ color: 'var(--ac-text)' }}>
          Scegline una dall'elenco
        </Link>
        .
      </div>
    );
  }
  if (!data) return <StatsSkeleton cards={4} />;

  const target = busiestMode(data.current, data.labels);

  if (target === null) {
    return (
      <div style={{ padding: 24, fontSize: 13, color: 'var(--tx-secondary)' }}>
        Non c'è ancora nessuna modalità: i server della rete non sono stati raggruppati.{' '}
        <Link to="/modalita" style={{ color: 'var(--ac-text)' }}>
          Definisci la prima
        </Link>
        .
      </div>
    );
  }

  // `replace`: l'ingresso non deve lasciare una tappa nella cronologia, o il
  // tasto indietro rimbalzerebbe qui e da qui di nuovo in avanti.
  return <Navigate to="/dettaglio-modalita/$key" params={{ key: target }} replace />;
}
