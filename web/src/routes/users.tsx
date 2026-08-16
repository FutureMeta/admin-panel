// Utenti & Ruoli: elenco, dettaglio, matrice dei permessi, invito.
//
// Le azioni che l'utente non puo' compiere NON compaiono: la stessa regola
// della sidebar. `canManage` arriva dal server (e' il risultato della query di
// dominanza del §7), il client non lo ricalcola.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Badge,
  Banner,
  Button,
  Card,
  DateTime,
  EmptyState,
  Field,
  SkeletonRows,
  UserStatusBadge,
} from '../components/ui.tsx';
import { ApiError, api, type Me, type RolesMatrix, type UserDetail, type UserRow } from '../lib/api.ts';

const LEVELS = ['nessuno', 'lettura', 'scrittura', 'gestione'] as const;

export function UsersPage({ me, onNeedStepUp }: { me: Me; onNeedStepUp: () => void }) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | undefined>();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [filter, setFilter] = useState('');

  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => api<{ users: UserRow[] }>('/api/users'),
  });

  const rows = (users.data?.users ?? []).filter((u) => {
    const q = filter.trim().toLowerCase();
    if (!q) return true;
    return u.email.toLowerCase().includes(q) || u.name.toLowerCase().includes(q);
  });

  const canInvite = (me.permissions.inviti ?? 0) >= 2;

  return (
    <div style={{ display: 'grid', gap: 'var(--sp5)' }}>
      <Card
        title="Utenti"
        subtitle={`${rows.length} persone con accesso al pannello`}
        actions={
          canInvite ? (
            <Button variant="primary" onClick={() => setInviteOpen(true)}>
              Invita
            </Button>
          ) : undefined
        }
      >
        <div style={{ marginBottom: 'var(--sp4)', maxWidth: 320 }}>
          <input
            className="input"
            placeholder="Filtra per nome o email…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filtra utenti"
          />
        </div>

        {users.isPending ? (
          <SkeletonRows />
        ) : users.isError ? (
          <Banner
            tone="err"
            title="Non è stato possibile caricare gli utenti"
            action={
              <Button size="sm" onClick={() => void users.refetch()}>
                Riprova
              </Button>
            }
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title="Nessun utente corrisponde"
            description="Prova a cambiare il filtro, oppure invita qualcuno di nuovo."
          />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Persona</th>
                  <th>Ruoli</th>
                  <th>Stato</th>
                  <th>Dal</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <p style={{ margin: 0, font: '600 14px/20px var(--font-ui)' }}>{u.name}</p>
                      <p className="t-sm" style={{ margin: 0, color: 'var(--tx-muted)' }}>
                        {u.email}
                      </p>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 'var(--sp2)', flexWrap: 'wrap' }}>
                        {u.roles.length === 0 ? (
                          <span className="t-sm" style={{ color: 'var(--tx-muted)' }}>
                            nessuno
                          </span>
                        ) : (
                          u.roles.map((r) => (
                            <Badge key={r.key} tone={r.isSystem ? 'ac' : 'neutral'}>
                              {r.name}
                            </Badge>
                          ))
                        )}
                      </div>
                    </td>
                    <td>
                      <UserStatusBadge status={u.status} banned={u.banned} />
                    </td>
                    <td className="num">
                      <DateTime value={u.createdAt} />
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <Button size="sm" variant="ghost" onClick={() => setSelected(u.id)}>
                        Dettagli
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {selected ? (
        <UserDrawer
          userId={selected}
          me={me}
          onClose={() => setSelected(undefined)}
          onChanged={() => void qc.invalidateQueries({ queryKey: ['users'] })}
          onNeedStepUp={onNeedStepUp}
        />
      ) : null}

      {inviteOpen ? (
        <InviteDrawer
          onClose={() => setInviteOpen(false)}
          onCreated={() => void qc.invalidateQueries({ queryKey: ['invites'] })}
          onNeedStepUp={onNeedStepUp}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Drawer({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(7,18,25,0.6)',
        display: 'flex',
        justifyContent: 'flex-end',
        zIndex: 40,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(560px, 100%)',
          height: '100%',
          background: 'var(--s-surface)',
          borderLeft: '1px solid var(--bd-subtle)',
          padding: 'var(--sp6)',
          overflowY: 'auto',
        }}
      >
        <header style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 'var(--sp5)' }}>
          <h2 className="t-h2" style={{ margin: 0 }}>
            {title}
          </h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Chiudi">
            ✕
          </Button>
        </header>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function UserDrawer({
  userId,
  me,
  onClose,
  onChanged,
  onNeedStepUp,
}: {
  userId: string;
  me: Me;
  onClose: () => void;
  onChanged: () => void;
  onNeedStepUp: () => void;
}) {
  const [error, setError] = useState<string | undefined>();
  const detail = useQuery({
    queryKey: ['user', userId],
    queryFn: () => api<UserDetail>(`/api/users/${userId}`),
  });

  const act = useMutation({
    mutationFn: (input: { path: string; body?: unknown }) =>
      api(input.path, { method: 'POST', ...(input.body ? { body: input.body } : {}) }),
    onSuccess: () => {
      setError(undefined);
      void detail.refetch();
      onChanged();
    },
    onError: (err) => {
      // SEC-36 — un'operazione sui privilegi richiede step-up. Il client non
      // decide se serve: lo dice il server, e qui si apre la challenge.
      if (err instanceof ApiError && err.needsStepUp) {
        onNeedStepUp();
        setError(undefined);
        return;
      }
      setError(
        err instanceof ApiError && err.isNotFound
          ? 'Operazione non consentita su questa persona.'
          : 'Operazione non riuscita.',
      );
    },
  });

  if (detail.isPending) {
    return (
      <Drawer title="Dettaglio" onClose={onClose}>
        <SkeletonRows rows={8} />
      </Drawer>
    );
  }
  if (detail.isError || !detail.data) {
    return (
      <Drawer title="Dettaglio" onClose={onClose}>
        {/* SEC-31 — 404 e "non puoi" sono la stessa risposta: la UI non
            inventa una distinzione che il server non fa. */}
        <EmptyState title="Non disponibile" description="Questa persona non esiste o non è tua da gestire." />
      </Drawer>
    );
  }

  const { user, permissions, roles, sessions, canManage } = detail.data;
  const canManageUsers = (me.permissions.utenti ?? 0) >= 3 && canManage;
  const canManageSessions = (me.permissions.sessioni ?? 0) >= 2 && canManage;

  return (
    <Drawer title={user.name} onClose={onClose}>
      <div style={{ display: 'grid', gap: 'var(--sp6)' }}>
        {error ? <Banner tone="err" title={error} /> : null}

        <div>
          <p className="t-sm" style={{ margin: 0, color: 'var(--tx-muted)' }}>
            {user.email}
          </p>
          <div style={{ display: 'flex', gap: 'var(--sp2)', marginTop: 'var(--sp3)', flexWrap: 'wrap' }}>
            <UserStatusBadge status={user.status} banned={user.banned} />
            {user.twoFactorEnabled ? (
              <Badge tone="ok">2FA attivo</Badge>
            ) : (
              <Badge tone="warn">2FA assente</Badge>
            )}
            {roles.map((r) => (
              <Badge key={r.key} tone={r.isSystem ? 'ac' : 'neutral'}>
                {r.name}
              </Badge>
            ))}
          </div>
          {user.banned && user.banReason ? (
            <p className="t-sm" style={{ margin: 'var(--sp3) 0 0', color: 'var(--tx-secondary)' }}>
              Motivo: {user.banReason}
            </p>
          ) : null}
        </div>

        <section>
          <h3 className="t-h3" style={{ margin: '0 0 var(--sp3)' }}>
            Permessi effettivi
          </h3>
          <table className="table">
            <tbody>
              {Object.entries(permissions)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([module, level]) => (
                  <tr key={module}>
                    <td style={{ textTransform: 'capitalize' }}>{module}</td>
                    <td className="num">
                      <Badge tone={level >= 3 ? 'ac' : level >= 1 ? 'info' : 'neutral'}>
                        {LEVELS[level] ?? level}
                      </Badge>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>

        <section>
          <h3 className="t-h3" style={{ margin: '0 0 var(--sp3)' }}>
            Sessioni attive ({sessions.length})
          </h3>
          {sessions.length === 0 ? (
            <p className="t-sm" style={{ color: 'var(--tx-muted)', margin: 0 }}>
              Nessuna sessione aperta.
            </p>
          ) : (
            <table className="table">
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <DateTime value={s.updatedAt} />
                      <p className="mono" style={{ margin: 0 }}>
                        {s.ipAddress ?? '—'}
                      </p>
                    </td>
                    <td className="t-sm" style={{ color: 'var(--tx-muted)', maxWidth: 220 }}>
                      {s.userAgent ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {canManageUsers || canManageSessions ? (
          <section style={{ display: 'grid', gap: 'var(--sp3)' }}>
            <h3 className="t-h3" style={{ margin: 0 }}>
              Azioni
            </h3>
            {canManageSessions ? (
              <Button
                onClick={() => act.mutate({ path: `/api/users/${userId}/revoke-sessions` })}
                loading={act.isPending}
              >
                Chiudi tutte le sessioni
              </Button>
            ) : null}
            {canManageUsers ? (
              user.banned ? (
                <Button
                  onClick={() => act.mutate({ path: `/api/users/${userId}/unban` })}
                  loading={act.isPending}
                >
                  Rimuovi il ban
                </Button>
              ) : (
                <Button
                  variant="danger"
                  loading={act.isPending}
                  onClick={() => {
                    const reason = window.prompt('Motivo del ban (finisce nel registro):');
                    if (reason && reason.trim().length >= 3) {
                      act.mutate({ path: `/api/users/${userId}/ban`, body: { reason: reason.trim() } });
                    }
                  }}
                >
                  Banna
                </Button>
              )
            ) : null}
            {canManageUsers ? (
              <Button
                variant="danger"
                loading={act.isPending}
                onClick={() => {
                  const reason = window.prompt(
                    'Offboarding: chiude le sessioni, toglie ruoli e permessi e revoca gli inviti ' +
                      'pendenti emessi da questa persona. Motivo:',
                  );
                  if (reason && reason.trim().length >= 3) {
                    act.mutate({ path: `/api/users/${userId}/offboard`, body: { reason: reason.trim() } });
                  }
                }}
              >
                Offboarding
              </Button>
            ) : null}
          </section>
        ) : null}
      </div>
    </Drawer>
  );
}

// ---------------------------------------------------------------------------

function InviteDrawer({
  onClose,
  onCreated,
  onNeedStepUp,
}: {
  onClose: () => void;
  onCreated: () => void;
  onNeedStepUp: () => void;
}) {
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState<number | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState(false);

  // Solo i ruoli che l'attore puo' davvero concedere (SEC-07). L'elenco arriva
  // dal server: mostrarne di piu' e poi rifiutare sarebbe una promessa rotta.
  const roles = useQuery({
    queryKey: ['grantable-roles'],
    queryFn: () =>
      api<{ roles: Array<{ id: number; key: string; name: string }> }>('/api/users/grantable-roles'),
  });

  const create = useMutation({
    mutationFn: () => api('/api/invites', { method: 'POST', body: { email: email.trim(), roleId } }),
    onSuccess: () => {
      setDone(true);
      onCreated();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.needsStepUp) {
        onNeedStepUp();
        return;
      }
      if (err instanceof ApiError && err.status === 409) {
        setError('Esiste già un utente o un invito pendente per questo indirizzo.');
        return;
      }
      if (err instanceof ApiError && err.code === 'RUOLO_NON_CONCEDIBILE') {
        setError('Non puoi concedere un ruolo che dà più di quanto hai tu.');
        return;
      }
      setError("Non è stato possibile creare l'invito.");
    },
  });

  return (
    <Drawer title="Invita una persona" onClose={onClose}>
      {done ? (
        <div style={{ display: 'grid', gap: 'var(--sp5)' }}>
          <Banner
            tone="info"
            title="Invito inviato"
            description="Il link vale 72 ore e funziona una volta sola. Non è visibile qui: esiste solo nell'email."
          />
          <Button variant="primary" onClick={onClose}>
            Chiudi
          </Button>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError(undefined);
            create.mutate();
          }}
          style={{ display: 'grid', gap: 'var(--sp4)' }}
        >
          {error ? <Banner tone="err" title={error} /> : null}

          <Field
            label="Email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            hint="L'indirizzo non sarà modificabile in fase di accettazione."
          />

          <div className="field">
            <label className="label" htmlFor="ruolo">
              Ruolo
            </label>
            <select
              id="ruolo"
              className="input"
              required
              value={roleId ?? ''}
              onChange={(e) => setRoleId(Number(e.target.value))}
            >
              <option value="" disabled>
                Scegli…
              </option>
              {(roles.data?.roles ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <span className="hint">
              Compaiono solo i ruoli che puoi concedere: nessuno può dare più di quanto ha.
            </span>
          </div>

          <Button type="submit" variant="primary" size="lg" loading={create.isPending} disabled={!roleId}>
            Invia l'invito
          </Button>
        </form>
      )}
    </Drawer>
  );
}

// ---------------------------------------------------------------------------

export function RolesPage({ me, onNeedStepUp }: { me: Me; onNeedStepUp: () => void }) {
  const [error, setError] = useState<string | undefined>();
  const matrix = useQuery({ queryKey: ['roles'], queryFn: () => api<RolesMatrix>('/api/roles') });
  const canEdit = (me.permissions.ruoli ?? 0) >= 3;

  const save = useMutation({
    mutationFn: (input: { roleId: number; entries: Array<{ moduleId: number; level: number }> }) =>
      api(`/api/roles/${input.roleId}/permissions`, { method: 'PUT', body: { entries: input.entries } }),
    onSuccess: () => {
      setError(undefined);
      void matrix.refetch();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.needsStepUp) {
        onNeedStepUp();
        return;
      }
      setError(
        err instanceof ApiError && err.code === 'LIVELLO_NON_CONCEDIBILE'
          ? 'Non puoi impostare un livello superiore al tuo.'
          : 'Modifica non riuscita.',
      );
    },
  });

  if (matrix.isPending) return <SkeletonRows rows={10} />;
  if (matrix.isError || !matrix.data) {
    return <Banner tone="err" title="Non è stato possibile caricare la matrice dei permessi" />;
  }

  const { modules, roles, permissions } = matrix.data;
  const levelOf = (roleId: number, moduleId: number) =>
    permissions.find((p) => p.role_id === roleId && p.module_id === moduleId)?.level ?? 0;

  return (
    <Card
      title="Ruoli e permessi"
      subtitle="Moduli in riga, ruoli in colonna. Il livello più alto vince quando i ruoli si sommano."
    >
      {error ? (
        <div style={{ marginBottom: 'var(--sp4)' }}>
          <Banner tone="err" title={error} />
        </div>
      ) : null}

      <div style={{ overflowX: 'auto', maxHeight: '64vh' }}>
        <table className="table">
          <thead>
            <tr>
              <th style={{ minWidth: 180 }}>Modulo</th>
              {roles.map((r) => (
                <th key={r.id} style={{ textAlign: 'center', minWidth: 132 }}>
                  {r.name}
                  {r.isSystem ? (
                    <p className="t-sm" style={{ margin: 0, textTransform: 'none', letterSpacing: 0 }}>
                      non modificabile
                    </p>
                  ) : (
                    <p className="t-sm" style={{ margin: 0, textTransform: 'none', letterSpacing: 0 }}>
                      {r.members} {r.members === 1 ? 'persona' : 'persone'}
                    </p>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {modules.map((m) => (
              <tr key={m.id}>
                <td style={{ fontWeight: 600 }}>{m.name}</td>
                {roles.map((r) => {
                  const level = levelOf(r.id, m.id);
                  // Un ruolo di sistema non e' modificabile nemmeno da un
                  // owner: e' un vincolo del database (SEC-09), non una scelta
                  // della UI, e mostrarlo come editabile sarebbe una bugia.
                  const editable = canEdit && r.editable;
                  return (
                    <td key={r.id} style={{ textAlign: 'center' }}>
                      {editable ? (
                        <select
                          className="input"
                          aria-label={`${r.name} su ${m.name}`}
                          value={level}
                          onChange={(e) =>
                            save.mutate({
                              roleId: r.id,
                              entries: [{ moduleId: m.id, level: Number(e.target.value) }],
                            })
                          }
                          style={{ height: 32, padding: '0 var(--sp2)', width: 116 }}
                        >
                          {LEVELS.map((label, value) => (
                            <option key={label} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <Badge tone={level >= 3 ? 'ac' : level >= 1 ? 'info' : 'neutral'}>
                          {LEVELS[level] ?? level}
                        </Badge>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
