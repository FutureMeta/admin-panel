// L'ingresso al dettaglio quando nessuno ha detto QUALE modalità.
//
// «Dettaglio modalità» nella barra a sinistra non può portare a una modalità
// fissata nel codice: sarebbe quella giusta il primo giorno e quella sbagliata
// tutti gli altri. Porta invece alla più popolata in questo momento, che è la
// domanda che si sta facendo chi clicca — «dov'è la gente» — e che si aggiorna
// da sola quando la rete cambia.
//
// PERCHÉ UNA ROTTA E NON UN CALCOLO NELLA BARRA. Il collegamento nella barra
// dovrebbe conoscere la classifica per poterla puntare, cioè avere già in mano
// la panoramica: al primo caricamento non ce l'ha, e la voce resterebbe morta o
// punterebbe a caso. Una rotta che risolve e rimanda funziona anche a freddo, e
// funziona pure da segnalibro.
//
// QUI SI CREA ANCHE LA PRIMA MODALITÀ, ed è l'unico posto dove si può. Il
// pulsante «Nuova modalità» vive nell'intestazione del dettaglio, che per
// esistere ha bisogno di una modalità: senza questo ramo, una rete appena
// collegata non avrebbe nessuna porta da cui cominciare.

import { useQuery } from '@tanstack/react-query';
import { Navigate } from '@tanstack/react-router';
import { useState } from 'react';
import { type Dictionary, NewModeDialog } from '../components/mode-editor.tsx';
import { type Overview, StatsSkeleton } from '../components/stats-panels.tsx';
import { Button, EmptyState, SkeletonRows } from '../components/ui.tsx';
import { api, apiWithHeaders, type Me } from '../lib/api.ts';
import { busiestMode } from '../lib/busiest.ts';
import { useRange } from '../lib/range.ts';

export function ModeEntryPage({ me }: { me: Me }) {
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
        sia la più popolata. Riprova fra poco.
      </div>
    );
  }
  if (!data) return <StatsSkeleton cards={4} />;

  const target = busiestMode(data.current, data.labels);
  if (target === null) return <FirstMode me={me} />;

  // `replace`: l'ingresso non deve lasciare una tappa nella cronologia, o il
  // tasto indietro rimbalzerebbe qui e da qui di nuovo in avanti.
  return <Navigate to="/dettaglio-modalita/$key" params={{ key: target }} replace />;
}

/**
 * Non esiste ancora nessuna modalità: da dove si comincia.
 *
 * DUE VUOTI DIVERSI, e confonderli manda a cercare la cosa sbagliata. «Nessun
 * server osservato» vuol dire che il campionamento non ha ancora visto niente,
 * e non c'è niente da raggruppare: il rimedio è accendere la raccolta, non
 * creare una modalità. «Il dizionario è vuoto» vuol dire che i server ci sono
 * e aspettano solo di essere raggruppati.
 */
function FirstMode({ me }: { me: Me }) {
  const [creating, setCreating] = useState(false);
  const canManage = (me.permissions.statistiche ?? 0) >= 3;

  const dict = useQuery({
    queryKey: ['stats-modes'],
    queryFn: () => api<Dictionary>('/api/stats/modes'),
  });

  if (dict.isPending) return <SkeletonRows rows={3} />;

  const servers = [...(dict.data?.unclassified ?? []), ...(dict.data?.modes ?? []).flatMap((m) => m.servers)];

  return (
    <>
      {servers.length === 0 ? (
        <EmptyState
          title="Nessun server osservato"
          description="I server non si configurano: li scopre il campionamento leggendo chi è online. Finché non è acceso, qui non c'è niente da raggruppare — e i grafici non hanno dati."
        />
      ) : (
        <EmptyState
          title="Il dizionario è vuoto"
          description="Nessuno sa a priori come questa rete vuole raggruppare i propri server: le modalità le crei tu, e finché non esistono i grafici mostrano una serie sola."
          action={
            canManage ? (
              <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
                Nuova modalità
              </Button>
            ) : undefined
          }
        />
      )}

      {creating ? (
        <NewModeDialog
          available={servers.sort()}
          taken={(dict.data?.modes ?? []).map((m) => m.modeKey)}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </>
  );
}
