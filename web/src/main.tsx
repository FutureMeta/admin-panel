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
  useNavigate,
  useRouterState,
} from '@tanstack/react-router';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { type Command, CommandPalette, Sidebar, Topbar } from './components/shell.tsx';
import { Button, Card, Field, Notice, SkeletonRows } from './components/ui.tsx';
import { ApiError, api, type Me } from './lib/api.ts';
import './app.css';
import { AcceptPage } from './routes/accept.tsx';
import { AuditPage_ } from './routes/audit.tsx';
import { InvitesPage } from './routes/invites.tsx';
import { LoginPage } from './routes/login.tsx';
import { ForgotPasswordPage, ResetPasswordPage } from './routes/password.tsx';
import { ForbiddenPage, NotFoundPage, UnauthorizedPage } from './routes/states.tsx';
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
// Challenge di step-up (§8.5). Non e' una pagina: e' un modale che compare
// quando il server risponde STEP_UP_REQUIRED, e riporta l'utente esattamente
// dov'era.
// ---------------------------------------------------------------------------

function StepUpDialog({ open, onClose }: { open: boolean; onClose: (ok: boolean) => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setCode('');
      setError(undefined);
    }
  }, [open]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Conferma la tua identità"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(7,18,25,0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 60,
      }}
    >
      <div className="elevated" style={{ width: 'min(420px, 92vw)', padding: 'var(--sp6)' }}>
        <h2 className="t-title" style={{ margin: '0 0 var(--sp2)' }}>
          Conferma la tua identità
        </h2>
        <p className="t-lead" style={{ margin: '0 0 var(--sp5)', color: 'var(--tx-muted)' }}>
          Questa operazione tocca privilegi. Serve un codice fresco della tua app: vale per i dieci minuti
          successivi.
        </p>

        {error ? (
          <div style={{ marginBottom: 'var(--sp4)' }}>
            <Notice tone="err" title={error} />
          </div>
        ) : null}

        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await api('/api/account/step-up', { method: 'POST', body: { code: code.trim() } });
              onClose(true);
            } catch {
              setError('Codice non valido.');
              setCode('');
            } finally {
              setBusy(false);
            }
          }}
          style={{ display: 'grid', gap: 'var(--sp4)' }}
        >
          <Field
            label="Codice a sei cifre"
            className="input input-mono"
            inputMode="numeric"
            maxLength={6}
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          />
          <div style={{ display: 'flex', gap: 'var(--sp3)' }}>
            <Button
              type="submit"
              variant="primary"
              loading={busy}
              disabled={code.length !== 6}
              style={{ flex: 1 }}
            >
              Conferma
            </Button>
            <Button type="button" variant="ghost" onClick={() => onClose(false)}>
              Annulla
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function AppShell() {
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [stepUpOpen, setStepUpOpen] = useState(false);
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

  if (me.isPending) {
    return (
      <main style={{ padding: 'var(--sp8)' }}>
        <SkeletonRows rows={6} />
      </main>
    );
  }
  if (me.isError) {
    return me.error instanceof ApiError && me.error.isUnauthorized ? <UnauthorizedPage /> : <ForbiddenPage />;
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
  const breadcrumb = pathname.startsWith('/utenti')
    ? 'Utenti & Ruoli'
    : pathname.startsWith('/registro')
      ? 'Registro attività'
      : 'Console';

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: 'var(--s-base)' }}>
      <Sidebar me={data} collapsed={collapsed} onOpenPalette={() => setPaletteOpen(true)} />
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
        <Topbar
          me={data}
          breadcrumb={breadcrumb}
          onToggleSidebar={() => setCollapsed((c) => !c)}
          onLogout={() => {
            void api('/api/session/logout-all', { method: 'POST' }).finally(() =>
              window.location.assign('/login'),
            );
          }}
          feedDisconnected={false}
        />
        <main className="app-main">
          <Outlet />
        </main>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
      <StepUpDialog
        open={stepUpOpen}
        onClose={(ok) => {
          setStepUpOpen(false);
          if (ok) void me.refetch();
        }}
      />
      <StepUpBridge onRequest={() => setStepUpOpen(true)} />
    </div>
  );
}

/**
 * Ponte fra le pagine e il modale di step-up: le pagine chiamano
 * `window.dispatchEvent(new Event('metamc:step-up'))` invece di ricevere una
 * callback attraverso cinque livelli di props.
 */
function StepUpBridge({ onRequest }: { onRequest: () => void }) {
  useEffect(() => {
    const handler = () => onRequest();
    window.addEventListener('metamc:step-up', handler);
    return () => window.removeEventListener('metamc:step-up', handler);
  }, [onRequest]);
  return null;
}

export function requestStepUp(): void {
  window.dispatchEvent(new Event('metamc:step-up'));
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
      {data.modules.includes('utenti') ? <UsersPage me={data} onNeedStepUp={requestStepUp} /> : null}
      {data.modules.includes('ruoli') ? <RolesPage me={data} onNeedStepUp={requestStepUp} /> : null}
      {data.modules.includes('inviti') ? <InvitesPage me={data} onNeedStepUp={requestStepUp} /> : null}
    </>
  );
}

function AuditRoute() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/api/me') });
  if (!me.data) return <SkeletonRows rows={6} />;
  if (!me.data.modules.includes('audit')) return <ForbiddenPage />;
  return <AuditPage_ canVerify={(me.data.permissions.audit ?? 0) >= 3} />;
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

const shellRoute = createRoute({ getParentRoute: () => rootRoute, id: 'shell', component: AppShell });
const homeRoute = createRoute({ getParentRoute: () => shellRoute, path: '/', component: HomePage });
const usersRoute = createRoute({ getParentRoute: () => shellRoute, path: '/utenti', component: UsersRoute });
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
  shellRoute.addChildren([homeRoute, usersRoute, auditRoute]),
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
