// Radice del frontend: router, query client, app shell.
//
// Le rotte sono dichiarate in codice, non generate da file: il plugin di
// routing di TanStack aggiungerebbe un passo di codegen a un'applicazione con
// sei schermate, e il codegen e' una cosa in piu' che si puo' rompere.

import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  retainSearchParams,
  useNavigate,
  useRouterState,
} from '@tanstack/react-router';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { type Command, CommandPalette, Sidebar, Topbar } from './components/shell.tsx';
import { Card, SkeletonRows } from './components/ui.tsx';
import { ApiError, api, type Me } from './lib/api.ts';
import { ratingsSearch } from './lib/duels.ts';
import { rangeSearch } from './lib/range.ts';
import './app.css';
import { AcceptPage } from './routes/accept.tsx';
import { AuditPage_ } from './routes/audit.tsx';
import { DuelsRatingsRoute as DuelsRatingsPage } from './routes/duels-ratings.tsx';
import { DuelsTrendsRoute as DuelsTrendsPage } from './routes/duels-trends.tsx';
import { InvitesPage } from './routes/invites.tsx';
import { LoginPage } from './routes/login.tsx';
import { ModeDetailPage } from './routes/mode-detail.tsx';
import { ModeEntryPage } from './routes/mode-entry.tsx';
import { OverviewPage } from './routes/overview.tsx';
import { ForgotPasswordPage, ResetPasswordPage } from './routes/password.tsx';
import { ForbiddenPage, NotFoundPage } from './routes/states.tsx';
import { RolesPage, UsersPage } from './routes/users.tsx';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Nessuna risposta autenticata viene cachata dal browser (§9), ma in
      // memoria un minuto di freschezza evita di ricaricare la stessa lista a
      // ogni cambio di schermata.
      staleTime: 30_000,
      retry: (count, error) => {
        // Un 401 o un 403 non migliorano ritentando: peggiorano, perche'
        // consumano rate limit.
        if (error instanceof ApiError && (error.isUnauthorized || error.isForbidden)) return false;
        return count < 2;
      },
      refetchOnWindowFocus: false,
    },
  },
});

// ---------------------------------------------------------------------------

function AppShell() {
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/api/me') });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Sessione scaduta o assente: si va al login, senza una schermata che
  // chieda di cliccare per andarci. Chi arriva qui non ha scelto di vedere un
  // messaggio, ha chiesto una pagina che non puo' avere.
  //
  // SEC-20 — la destinazione e' COSTANTE. Nessun parametro di ritorno viene
  // letto dalla URL, e non se ne scrive uno: un "torna a" controllato dal
  // client e' il modo classico di trasformare un login in un redirect aperto.
  //
  // `replace` e non `assign`: la pagina che non si e' potuta aprire non deve
  // restare nella cronologia, o il tasto indietro ci riporta sopra.
  const unauthorized = me.isError && me.error instanceof ApiError && me.error.isUnauthorized;
  useEffect(() => {
    if (unauthorized) window.location.replace('/login');
  }, [unauthorized]);

  if (me.isPending) {
    return (
      <main style={{ padding: 'var(--sp8)' }}>
        <SkeletonRows rows={6} />
      </main>
    );
  }
  if (me.isError) {
    // Il 401 non disegna niente: l'effetto qui sopra sta gia' cambiando pagina,
    // e un lampo di schermata prima del salto e' peggio di uno schermo vuoto.
    return unauthorized ? null : <ForbiddenPage />;
  }

  const data = me.data;
  // I comandi sono filtrati con la stessa regola della sidebar: si elencano
  // solo quelli che l'utente puo' davvero eseguire.
  const commands: Command[] = [
    ...((['utenti', 'ruoli', 'inviti'] as const).some((m) => data.modules.includes(m))
      ? [
          {
            id: 'users',
            label: 'Vai a Utenti & Ruoli',
            hint: 'g u',
            run: () => void navigate({ to: '/utenti' }),
          },
        ]
      : []),
    ...(data.modules.includes('duels')
      ? [
          {
            id: 'duels-trends',
            label: 'Vai a Duels · Trends',
            hint: 'andamento delle partite',
            run: () => void navigate({ to: '/duels/trends' }),
          },
        ]
      : []),
    ...(data.modules.includes('duels_feedback')
      ? [
          {
            id: 'duels-ratings',
            label: 'Vai a Duels · Ratings',
            hint: 'feedback dei giocatori',
            run: () => void navigate({ to: '/duels/ratings' }),
          },
        ]
      : []),
    ...(data.modules.includes('audit')
      ? [
          {
            id: 'audit',
            label: 'Vai al Registro attività',
            hint: 'g r',
            run: () => void navigate({ to: '/registro' }),
          },
        ]
      : []),
    {
      id: 'logout-all',
      label: 'Chiudi tutte le mie sessioni',
      hint: 'esci da ogni dispositivo',
      run: () => {
        void api('/api/session/logout-all', { method: 'POST' }).then(() => window.location.assign('/login'));
      },
    },
  ];

  // Il titolo della pagina corrente, per il breadcrumb della topbar.
  // Sono le etichette di `BREAD` in frontend/metamc-shared.js.
  //
  // ELENCO ESPLICITO, e il ripiego è l'ULTIMA voce, non la prima. Prima erano
  // due `startsWith` e poi `'Console'` per tutto il resto: ogni schermata
  // aggiunta dopo — la panoramica, il dettaglio modalità, le due dei duels —
  // finiva nel ripiego, e la barra in alto scriveva «Console › Console» invece
  // del nome della pagina. Un ripiego che copre il caso normale non è un
  // ripiego: è l'unico comportamento, e non fallisce mai abbastanza da farsi
  // notare.
  const breadcrumb =
    (
      [
        ['/utenti', 'Utenti & Ruoli'],
        ['/registro', 'Registro attività'],
        ['/panoramica', 'Panoramica network'],
        ['/dettaglio-modalita', 'Dettaglio modalità'],
        ['/duels/trends', 'Duels · Trends'],
        ['/duels/ratings', 'Duels · Ratings'],
      ] as const
    ).find(([prefix]) => pathname.startsWith(prefix))?.[1] ?? 'Console';

  // Il periodo governa solo le schermate che hanno un periodo. Sono le
  // stesse che il design elenca: non «Utenti», non «Registro».
  const showFilters = !pathname.startsWith('/utenti') && !pathname.startsWith('/registro');

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: 'var(--s-base)' }}>
      <Sidebar me={data} onOpenPalette={() => setPaletteOpen(true)} />
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
        <Topbar
          me={data}
          breadcrumb={breadcrumb}
          onLogout={() => {
            void api('/api/session/logout-all', { method: 'POST' }).finally(() =>
              window.location.assign('/login'),
            );
          }}
          feedDisconnected={false}
          showFilters={showFilters}
        />
        <main className="app-main">
          <Outlet />
        </main>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function HomePage() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/api/me') });
  if (!me.data) return <SkeletonRows rows={4} />;
  return (
    <Card
      title={`Ciao, ${me.data.name}`}
      subtitle="Fase 1: accessi, ruoli e registro. Le statistiche arrivano dopo."
    >
      <p className="t-lead" style={{ color: 'var(--tx-secondary)', margin: 0 }}>
        Hai accesso a {me.data.modules.length} moduli. Li trovi nel menu a sinistra: compaiono solo quelli che
        puoi davvero aprire.
      </p>
    </Card>
  );
}

/**
 * "Utenti & Ruoli" è UNA schermata, come nel prototipo: la tabella, l'editor
 * della matrice e gli inviti pendenti sono tre sezioni della stessa pagina.
 *
 * Ogni sezione compare solo se l'utente ha il modulo corrispondente: chi ha
 * `inviti` ma non `utenti` vede la sola lista degli inviti, e non una pagina
 * vuota con dei blocchi disabilitati.
 */
function UsersRoute() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/api/me') });
  if (!me.data) return <SkeletonRows rows={6} />;
  const data = me.data;
  const sections = ['utenti', 'ruoli', 'inviti'] as const;
  if (!sections.some((m) => data.modules.includes(m))) return <ForbiddenPage />;
  return (
    <>
      {data.modules.includes('utenti') ? <UsersPage me={data} /> : null}
      {data.modules.includes('ruoli') ? <RolesPage me={data} /> : null}
      {data.modules.includes('inviti') ? <InvitesPage me={data} /> : null}
    </>
  );
}

function OverviewRoute() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/api/me') });
  if (!me.data) return <SkeletonRows rows={6} />;
  if (!me.data.modules.includes('statistiche')) return <ForbiddenPage />;
  return <OverviewPage />;
}

function ModeDetailRoute() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/api/me') });
  if (!me.data) return <SkeletonRows rows={6} />;
  if (!me.data.modules.includes('statistiche')) return <ForbiddenPage />;
  return <ModeDetailPage me={me.data} />;
}

function ModeEntryRoute() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/api/me') });
  if (!me.data) return <SkeletonRows rows={6} />;
  if (!me.data.modules.includes('statistiche')) return <ForbiddenPage />;
  return <ModeEntryPage me={me.data} />;
}

function DuelsTrendsRoute() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/api/me') });
  if (!me.data) return <SkeletonRows rows={6} />;
  if (!me.data.modules.includes('duels')) return <ForbiddenPage />;
  return <DuelsTrendsPage />;
}

function DuelsRatingsRoute() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/api/me') });
  if (!me.data) return <SkeletonRows rows={6} />;
  if (!me.data.modules.includes('duels_feedback')) return <ForbiddenPage />;
  return <DuelsRatingsPage />;
}

function AuditRoute() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/api/me') });
  if (!me.data) return <SkeletonRows rows={6} />;
  if (!me.data.modules.includes('audit')) return <ForbiddenPage />;
  return <AuditPage_ />;
}

// ---------------------------------------------------------------------------

const rootRoute = createRootRoute({ component: Outlet, notFoundComponent: NotFoundPage });

const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: '/login', component: LoginPage });
const acceptRoute = createRoute({ getParentRoute: () => rootRoute, path: '/accept', component: AcceptPage });

const forgotRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/password-dimenticata',
  component: ForgotPasswordPage,
});
const resetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reset',
  component: ResetPasswordPage,
});

// Il PERIODO sta qui, sulla rotta del guscio, e ogni schermata sotto lo
// eredita: il selettore vive nella barra in alto, che e` del guscio, e
// dichiararlo su ognuna sarebbe cinque occasioni di dimenticarlo su una.
const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'shell',
  component: AppShell,
  validateSearch: rangeSearch,
  // IL PERIODO SOPRAVVIVE ALLA NAVIGAZIONE, e senza questa riga non lo farebbe.
  //
  // Il router NON conserva i parametri di ricerca da solo: verificato contro
  // il router vero, non dedotto. Con `?range=30d` sulla panoramica, un
  // collegamento a una modalità produceva `/dettaglio-modalita/duels` e basta,
  // cioè il periodo tornava a sette giorni cambiando schermata — una
  // regressione rispetto allo stato in React che c'era prima, e proprio nel
  // gesto che si fa più spesso.
  //
  // Resta anche su Utenti e Registro, che un periodo non ce l'hanno e lo
  // ignorano. È il prezzo di una riga sola invece di un elenco di rotte da
  // tenere aggiornato: quelle due schermate portano in URL un parametro inerte,
  // e in cambio andare a controllare un utente e tornare indietro non
  // ricomincia da capo.
  search: { middlewares: [retainSearchParams(['range'])] },
});
const homeRoute = createRoute({ getParentRoute: () => shellRoute, path: '/', component: HomePage });
const usersRoute = createRoute({ getParentRoute: () => shellRoute, path: '/utenti', component: UsersRoute });
const overviewRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/panoramica',
  component: OverviewRoute,
});
const modeDetailRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/dettaglio-modalita/$key',
  component: ModeDetailRoute,
});
// L'ingresso al dettaglio senza una modalità scelta: risolve la più popolata e
// rimanda. Il percorso porta un TRATTINO, che le chiavi di modalità non possono
// contenere (`^[a-z0-9_]{1,32}$`): così non c'è modo che collida con una
// modalità vera, né oggi né il giorno in cui qualcuno ne crea una di nome
// «dettaglio».
const modeEntryRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/dettaglio-modalita',
  component: ModeEntryRoute,
});
const duelsTrendsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/duels/trends',
  component: DuelsTrendsRoute,
});
const duelsRatingsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/duels/ratings',
  // I filtri della lista vivono nella URL insieme al periodo: senza, la vista
  // filtrata non e' condivisibile e chi manda il collegamento a «le peggiori
  // valutazioni di Sumo» manda la lista di tutto.
  validateSearch: ratingsSearch,
  component: DuelsRatingsRoute,
});
const auditRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/registro',
  component: AuditRoute,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  acceptRoute,
  forgotRoute,
  resetRoute,
  shellRoute.addChildren([
    homeRoute,
    usersRoute,
    overviewRoute,
    modeEntryRoute,
    modeDetailRoute,
    duelsTrendsRoute,
    duelsRatingsRoute,
    auditRoute,
  ]),
]);

const router = createRouter({ routeTree, defaultPreload: false });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const container = document.getElementById('root');
if (!container) throw new Error('#root assente in index.html');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
