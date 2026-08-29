// Anteprima delle schermate con dati finti. SOLO SVILUPPO.
//
// Non entra mai in `dist/`: `vite.config.ts` ha un solo input di build
// (`index.html`), quindi questo file esiste unicamente sotto `vite dev`.
//
// A cosa serve: le schermate del pannello stanno dietro il login, e il login
// richiede una password e un codice TOTP. Senza questa pagina l'unico modo di
// controllare che l'interfaccia corrisponda al disegno è leggere il sorgente —
// che è come ho lasciato passare i font mancanti per tre giri. Qui i
// componenti veri vengono montati con dati finti, sulla stessa origine, e si
// possono confrontare gli stili calcolati con quelli del prototipo.
//
// I dati sono quelli del prototipo (`frontend/metamc-shared.js`), così il
// confronto misura l'interfaccia e non la differenza fra due insiemi di dati.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Sidebar, Topbar } from './components/shell.tsx';
import type { AuditPage, InviteRow, Me, RolesMatrix, UserRow } from './lib/api.ts';
import { AcceptPage } from './routes/accept.tsx';
import './app.css';
import { AuditPage_ } from './routes/audit.tsx';
import { InvitesPage } from './routes/invites.tsx';
import { RolesPage, UsersPage } from './routes/users.tsx';

const screen = new URLSearchParams(window.location.search).get('screen') ?? 'utenti';

const ME: Me = {
  userId: 'u-1',
  email: 'vally90@metamc.it',
  name: 'Vally90',
  permissions: {
    utenti: 3,
    ruoli: 3,
    inviti: 3,
    sessioni: 3,
    audit: 3,
    impostazioni: 3,
    statistiche: 3,
    server: 3,
    duels: 3,
    duels_feedback: 3,
    duels_modes: 3,
    duels_maps: 3,
    duels_live: 3,
    duels_config: 3,
    assistente: 3,
  },
  modules: [
    'utenti',
    'ruoli',
    'inviti',
    'sessioni',
    'audit',
    'impostazioni',
    'statistiche',
    'server',
    'duels',
    'duels_feedback',
    'duels_modes',
    'duels_maps',
    'assistente',
  ],
  aal: 2,
  authenticatedAt: new Date().toISOString(),
};

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

const USERS: UserRow[] = [
  {
    id: 'u-1',
    email: 'vally90@metamc.it',
    name: 'Vally90',
    status: 'active',
    banned: false,
    banReason: null,
    banExpires: null,
    createdAt: hoursAgo(9000),
    roles: [{ key: 'founder', name: 'Founder', isSystem: true }],
    modules: 10,
    lastSeenAt: hoursAgo(1),
  },
  {
    id: 'u-2',
    email: 'psicosi@metamc.it',
    name: 'Psicosi',
    status: 'active',
    banned: false,
    banReason: null,
    banExpires: null,
    createdAt: hoursAgo(8000),
    roles: [{ key: 'owner', name: 'Owner', isSystem: true }],
    modules: 10,
    lastSeenAt: hoursAgo(2),
  },
  {
    id: 'u-3',
    email: 'sadkiwi@metamc.it',
    name: 'SadKiwi',
    status: 'active',
    banned: false,
    banReason: null,
    banExpires: null,
    createdAt: hoursAgo(5000),
    roles: [{ key: 'sr-admin', name: 'Sr. Admin', isSystem: false }],
    modules: 6,
    lastSeenAt: hoursAgo(5),
  },
  {
    id: 'u-4',
    email: 'sbrodino@metamc.it',
    name: 'sbrodino',
    status: 'active',
    banned: false,
    banReason: null,
    banExpires: null,
    createdAt: hoursAgo(3000),
    roles: [{ key: 'developer', name: 'Developer', isSystem: false }],
    modules: 5,
    lastSeenAt: hoursAgo(30),
  },
  {
    id: 'u-5',
    email: 'miky88@metamc.it',
    name: 'Miky88',
    status: 'pending_onboarding',
    banned: false,
    banReason: null,
    banExpires: null,
    createdAt: hoursAgo(20),
    roles: [{ key: 'moderatore', name: 'Moderatore', isSystem: false }],
    modules: 2,
    lastSeenAt: null,
  },
];

const INVITES: InviteRow[] = [
  {
    id: 'i-1',
    email: 'nuovo@metamc.it',
    name: 'Kryos',
    createdAt: hoursAgo(10),
    expiresAt: new Date(Date.now() + 60 * 3600_000).toISOString(),
    roleName: 'Moderatore',
    invitedByName: 'Vally90',
  },
  {
    id: 'i-2',
    email: 'altro@metamc.it',
    name: 'Miky88',
    createdAt: hoursAgo(40),
    expiresAt: new Date(Date.now() + 8 * 3600_000).toISOString(),
    roleName: 'Developer',
    invitedByName: 'Psicosi',
  },
];

const MODULES: RolesMatrix['modules'] = [
  { id: 1, key: 'utenti', name: 'Utenti', sort_order: 1 },
  { id: 2, key: 'ruoli', name: 'Ruoli', sort_order: 2 },
  { id: 3, key: 'inviti', name: 'Inviti', sort_order: 3 },
  { id: 4, key: 'sessioni', name: 'Sessioni', sort_order: 4 },
  { id: 5, key: 'audit', name: 'Registro attività', sort_order: 5 },
  { id: 6, key: 'impostazioni', name: 'Impostazioni', sort_order: 6 },
  { id: 7, key: 'statistiche', name: 'Statistiche', sort_order: 7 },
  { id: 8, key: 'server', name: 'Server', sort_order: 8 },
];

const ROLES_MATRIX: RolesMatrix = {
  modules: MODULES,
  roles: [
    { id: 1, key: 'owner', name: 'Owner', isSystem: true, members: 2, editable: false },
    { id: 2, key: 'sr-admin', name: 'Sr. Admin', isSystem: false, members: 3, editable: true },
    { id: 3, key: 'moderatore', name: 'Moderatore', isSystem: false, members: 4, editable: true },
  ],
  permissions: [
    { role_id: 2, module_id: 1, level: 2 },
    { role_id: 2, module_id: 2, level: 1 },
    { role_id: 2, module_id: 3, level: 3 },
    { role_id: 2, module_id: 5, level: 1 },
    { role_id: 2, module_id: 7, level: 2 },
  ],
};

const AUDIT: AuditPage = {
  entries: [
    {
      id: 'a-1',
      occurredAt: hoursAgo(1),
      actor: {
        userId: 'u-1',
        email: 'vally90@metamc.it',
        name: 'Vally90',
        ip: '81.20.4.9',
        socketIp: '81.20.4.9',
        userAgent: 'Mozilla/5.0 (Macintosh) Chrome/128',
      },
      action: 'role.permissions.change',
      moduleKey: 'ruoli',
      target: { type: 'role', id: '2', label: 'Sr. Admin' },
      outcome: 'success',
      before: { ruolo: 'Staff', moduli: 2, report_export: 'nessuno' },
      after: { ruolo: 'Admin modalità', moduli: 4, report_export: 'scrittura' },
      meta: { membri: 3 },
    },
    {
      id: 'a-2',
      occurredAt: hoursAgo(3),
      actor: {
        userId: 'u-2',
        email: 'psicosi@metamc.it',
        name: 'Psicosi',
        ip: '81.20.4.11',
        socketIp: '81.20.4.11',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0) Firefox/131',
      },
      action: 'invite.created',
      moduleKey: 'inviti',
      target: { type: 'invitation', id: 'i-1', label: 'nuovo@metamc.it' },
      outcome: 'success',
      before: null,
      after: { ruolo: 'Moderatore' },
      meta: null,
    },
    {
      id: 'a-3',
      occurredAt: hoursAgo(6),
      actor: {
        userId: null,
        email: null,
        name: null,
        ip: '203.0.113.7',
        socketIp: '203.0.113.7',
        userAgent: 'curl/8.7.1',
      },
      action: 'auth.login',
      moduleKey: null,
      target: { type: 'user', id: null, label: 'sconosciuto' },
      outcome: 'denied',
      before: null,
      after: null,
      meta: { reason: 'credenziali' },
    },
  ],
  nextCursor: null,
};

// `staleTime: Infinity` più i dati già in cache: i componenti leggono e non
// partono richieste. È il modo di montarli senza toccare l'API.
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
});

queryClient.setQueryData(['me'], ME);
queryClient.setQueryData(['users'], { users: USERS });
queryClient.setQueryData(['invites'], { invites: INVITES });
queryClient.setQueryData(['roles'], ROLES_MATRIX);
// Il dettaglio di u-2: serve a guardare le sezioni Ruoli e Override, che
// senza dati non renderizzano niente.
queryClient.setQueryData(['user', 'u-2'], {
  user: { ...USERS[1], twoFactorEnabled: true },
  permissions: {
    utenti: 2,
    ruoli: 1,
    inviti: 2,
    sessioni: 1,
    registro: 3,
    impostazioni: 0,
    statistiche: 1,
    server: 0,
  },
  // Su `registro` l'effettivo (3) viene dall'override; su `utenti` l'override
  // e' piu' basso del ruolo e non fa niente: sono i due casi che la nota del §7
  // deve rendere comprensibili.
  overrides: { registro: 3, utenti: 1 },
  roles: [{ id: 3, key: 'moderatore', name: 'Moderatore', isSystem: false, granted_at: hoursAgo(200) }],
  sessions: [
    {
      id: 's-1',
      createdAt: hoursAgo(3),
      updatedAt: hoursAgo(1),
      ipAddress: '203.0.113.9',
      userAgent: 'Chrome 141 · Windows',
      aal: 2,
    },
  ],
  canManage: true,
});

queryClient.setQueryData(['grantable-roles'], {
  roles: [
    { id: 2, key: 'sr-admin', name: 'Sr. Admin' },
    { id: 3, key: 'moderatore', name: 'Moderatore' },
  ],
});
queryClient.setQueryData(['audit-actions'], {
  actions: ['role.permissions.change', 'invite.created', 'auth.login'],
  modules: MODULES.map((m) => ({ key: m.key, name: m.name })),
});
// La chiave porta anche il cursore: `undefined` e' la prima pagina.
queryClient.setQueryData(['audit', { actor: '', module: '', action: '', outcome: '' }, undefined], AUDIT);

function Preview() {
  // Lo stesso guscio di `main.tsx`, non uno simile: se l'anteprima impagina in
  // modo diverso dall'app non serve a trovare i difetti dell'app.
  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: 'var(--s-base)' }}>
      <Sidebar me={ME} onOpenPalette={() => {}} />
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
        <Topbar
          me={ME}
          breadcrumb={screen === 'registro' ? 'Registro attività' : 'Utenti & Ruoli'}
          onLogout={() => {}}
          feedDisconnected={false}
          // L'anteprima mostra solo Utenti e Registro, che il periodo non lo
          // usano: mostrarne i pulsanti sarebbe un comando senza effetto.
          showFilters={false}
        />
        <main className="app-main">
          {screen === 'registro' ? (
            <AuditPage_ />
          ) : (
            <>
              <UsersPage me={ME} />
              <RolesPage me={ME} />
              <InvitesPage me={ME} />
            </>
          )}
        </main>
      </div>
    </div>
  );
}

// Il router serve solo perché la sidebar usa `useRouterState` e `Link`.
const rootRoute = createRootRoute({ component: Outlet });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: Preview });
// L'accettazione invito e' l'unica schermata che non vive dentro il guscio:
// ha il suo layout a piena pagina, e in sviluppo non e' raggiungibile
// dall'app perche' il proxy manda `/accept` al server, che li' scambia il
// token con un cookie. Qui si guarda per quello che e'.
const acceptRoute = createRoute({ getParentRoute: () => rootRoute, path: '/accept', component: AcceptPage });
const usersRoute = createRoute({ getParentRoute: () => rootRoute, path: '/utenti', component: Preview });
const auditRoute = createRoute({ getParentRoute: () => rootRoute, path: '/registro', component: Preview });
const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, usersRoute, auditRoute, acceptRoute]),
  history: createMemoryHistory({
    initialEntries: [screen === 'registro' ? '/registro' : screen === 'invito' ? '/accept' : '/utenti'],
  }),
});

const container = document.getElementById('root');
if (!container) throw new Error('#root assente');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
