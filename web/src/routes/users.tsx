// Utenti & Ruoli, sulla struttura del prototipo.
//
// Due sezioni: la tabella degli utenti (barra di ricerca in testa, conteggio a
// destra, paginazione in fondo) e l'editor del ruolo con la matrice dei
// permessi — moduli in riga raggruppati per area, livelli in colonna, un
// pallino per casella.
//
// Le azioni che l'utente non può compiere NON compaiono: la stessa regola
// della sidebar. `canManage` arriva dal server (è il risultato della query di
// dominanza del §7), il client non lo ricalcola.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, type ReactNode, useState } from 'react';
import {
  Chip,
  lastSeenLabel,
  moduleCountLabel,
  PageHeader,
  Panel,
  PanelBar,
  PanelFooter,
  SearchBox,
  StatusChip,
} from '../components/page.tsx';
import { Avatar, Button, DateTime, EmptyState, Field, Notice, SkeletonRows } from '../components/ui.tsx';
import { ApiError, api, type Me, type RolesMatrix, type UserDetail, type UserRow } from '../lib/api.ts';

const LEVELS = ['Nessuno', 'Lettura', 'Scrittura', 'Gestione'] as const;

/** Quanti moduli esistono in tutto: serve a dire «Tutti i moduli». */
const MODULE_TOTAL = 8;

// ---------------------------------------------------------------------------

export function UsersPage({ me, onNeedStepUp }: { me: Me; onNeedStepUp: () => void }) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | undefined>();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [filter, setFilter] = useState('');

  const users = useQuery({ queryKey: ['users'], queryFn: () => api<{ users: UserRow[] }>('/api/users') });
  const invites = useQuery({
    queryKey: ['invites'],
    queryFn: () => api<{ invites: unknown[] }>('/api/invites'),
    enabled: me.modules.includes('inviti'),
  });

  const rows = (users.data?.users ?? []).filter((u) => {
    const q = filter.trim().toLowerCase();
    if (!q) return true;
    return u.email.toLowerCase().includes(q) || u.name.toLowerCase().includes(q);
  });

  const canInvite = (me.permissions.inviti ?? 0) >= 2;
  const pending = invites.data?.invites.length ?? 0;

  return (
    <>
      <PageHeader
        title="Utenti & Ruoli"
        sub={`${users.data?.users.length ?? 0} utenti · ${pending} inviti in attesa · accesso solo su invito`}
        action={
          canInvite ? (
            <Button variant="primary" onClick={() => setInviteOpen(true)}>
              Invita utente
            </Button>
          ) : undefined
        }
      />

      <Panel>
        <PanelBar>
          <SearchBox
            value={filter}
            onChange={setFilter}
            placeholder="Cerca per nome o email"
            label="Cerca utenti"
          />
          <span className="mono" style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--tx-muted)' }}>
            {rows.length} risultati
          </span>
        </PanelBar>

        {users.isPending ? (
          <SkeletonRows />
        ) : users.isError ? (
          <div style={{ padding: 16 }}>
            <Notice
              tone="err"
              title="Non è stato possibile caricare gli utenti"
              action={
                <Button size="sm" onClick={() => void users.refetch()}>
                  Riprova
                </Button>
              }
            />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            title="Nessun utente corrisponde"
            description="Prova a cambiare il filtro, oppure invita qualcuno di nuovo."
          />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table" style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--s-inset)' }}>
                  {/* La casella nell'intestazione non è decorazione: è lei a
                      dare all'header i suoi 35.5px. Senza, la riga è alta 4px
                      di meno di quella del disegno. */}
                  <th style={{ width: 36, padding: '9px 0 9px 16px' }}>
                    <span
                      style={{
                        display: 'inline-block',
                        width: 14,
                        height: 14,
                        borderRadius: 'var(--r-xs)',
                        border: '1px solid var(--bd-strong)',
                      }}
                    />
                  </th>
                  <th>Utente</th>
                  <th>Ruolo</th>
                  <th>Moduli</th>
                  <th style={{ textAlign: 'right' }}>Ultimo accesso</th>
                  <th>Stato</th>
                  <th style={{ width: 44 }} />
                </tr>
              </thead>
              <tbody>
                {rows.map((u) => (
                  <tr key={u.id}>
                    <td style={{ paddingLeft: 16, paddingRight: 0 }}>
                      <span
                        style={{
                          display: 'inline-block',
                          width: 14,
                          height: 14,
                          borderRadius: 'var(--r-xs)',
                          border: '1px solid var(--bd-strong)',
                        }}
                      />
                    </td>
                    <td>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                        <Avatar name={u.name} size={26} square />
                        <span>
                          <span style={{ display: 'block', fontWeight: 500 }}>{u.name}</span>
                          <span style={{ display: 'block', fontSize: 11.5, color: 'var(--tx-muted)' }}>
                            {u.email}
                          </span>
                        </span>
                      </span>
                    </td>
                    <td>
                      <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
                        {u.roles.length === 0 ? (
                          <span style={{ color: 'var(--tx-muted)' }}>—</span>
                        ) : (
                          u.roles.map((r) => (
                            <Chip key={r.key} tone={r.isSystem ? 'ac' : 'neutral'}>
                              {r.name}
                            </Chip>
                          ))
                        )}
                      </span>
                    </td>
                    <td style={{ color: u.modules > 0 ? 'var(--tx-secondary)' : 'var(--tx-muted)' }}>
                      {moduleCountLabel(u.modules, MODULE_TOTAL)}
                    </td>
                    <td
                      className="mono"
                      style={{
                        textAlign: 'right',
                        fontSize: 12,
                        color: u.lastSeenAt ? 'var(--tx-secondary)' : 'var(--tx-muted)',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {lastSeenLabel(u.lastSeenAt)}
                    </td>
                    <td>
                      <StatusChip status={u.status} banned={u.banned} />
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        type="button"
                        onClick={() => setSelected(u.id)}
                        aria-label={`Dettagli di ${u.name}`}
                        style={{
                          border: 0,
                          background: 'transparent',
                          color: 'var(--tx-muted)',
                          cursor: 'pointer',
                          padding: 4,
                        }}
                      >
                        <svg
                          viewBox="0 0 24 24"
                          width="15"
                          height="15"
                          fill="currentColor"
                          aria-hidden="true"
                        >
                          <circle cx="12" cy="5" r="1.4" />
                          <circle cx="12" cy="12" r="1.4" />
                          <circle cx="12" cy="19" r="1.4" />
                        </svg>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <PanelFooter>
          <span>
            1–{rows.length} di {rows.length}
          </span>
          {/* Con 10-50 utenti la lista sta in una pagina sola: le frecce
              restano inerti finché non c'è davvero una seconda pagina. */}
          <span style={{ display: 'flex', gap: 6 }}>
            {['‹', '›'].map((glyph) => (
              <span
                key={glyph}
                aria-hidden="true"
                style={{
                  width: 26,
                  height: 26,
                  border: '1px solid var(--bd-subtle)',
                  borderRadius: 'var(--r-sm)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--tx-disabled)',
                }}
              >
                {glyph}
              </span>
            ))}
          </span>
        </PanelFooter>
      </Panel>

      {selected ? (
        <UserDialog
          userId={selected}
          me={me}
          onClose={() => setSelected(undefined)}
          onChanged={() => void qc.invalidateQueries({ queryKey: ['users'] })}
          onNeedStepUp={onNeedStepUp}
        />
      ) : null}

      {inviteOpen ? (
        <InviteDialog
          onClose={() => setInviteOpen(false)}
          onCreated={() => void qc.invalidateQueries({ queryKey: ['invites'] })}
          onNeedStepUp={onNeedStepUp}
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------

/** Modale centrato da 460px, come il prototipo — non un drawer laterale. */
function Modal({
  title,
  subtitle,
  width = 460,
  onClose,
  footer,
  children,
}: {
  title: string;
  subtitle?: string;
  width?: number;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 80,
        background: 'rgba(4,10,14,.66)',
        backdropFilter: 'blur(3px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 40,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        style={{
          width,
          maxWidth: '100%',
          maxHeight: '88vh',
          overflowY: 'auto',
          border: '1px solid var(--bd-strong)',
          borderRadius: 'var(--r-lg)',
          background: 'var(--s-elevated)',
          boxShadow: 'var(--e3)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 16,
            padding: '20px 22px 16px',
            borderBottom: '1px solid var(--bd-subtle)',
          }}
        >
          <div>
            <div
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 17,
                fontWeight: 700,
                letterSpacing: '-.01em',
              }}
            >
              {title}
            </div>
            {subtitle ? (
              <div style={{ fontSize: 12.5, color: 'var(--tx-muted)', marginTop: 4 }}>{subtitle}</div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Chiudi"
            style={{
              width: 28,
              height: 28,
              border: '1px solid var(--bd-subtle)',
              borderRadius: 'var(--r-sm)',
              background: 'transparent',
              color: 'var(--tx-muted)',
              cursor: 'pointer',
              fontSize: 14,
              lineHeight: 1,
              flex: 'none',
            }}
          >
            ×
          </button>
        </div>
        <div style={{ padding: '20px 22px' }}>{children}</div>
        {footer ? (
          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 8,
              padding: '16px 22px',
              borderTop: '1px solid var(--bd-subtle)',
              background: 'var(--s-inset)',
            }}
          >
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function UserDialog({
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
      <Modal title="Dettaglio" onClose={onClose} width={520}>
        <SkeletonRows rows={7} />
      </Modal>
    );
  }
  if (detail.isError || !detail.data) {
    return (
      <Modal title="Non disponibile" onClose={onClose} width={520}>
        {/* SEC-31 — 404 e "non puoi" sono la stessa risposta: la UI non
            inventa una distinzione che il server non fa. */}
        <p className="t-lead" style={{ margin: 0 }}>
          Questa persona non esiste, oppure non è tua da gestire.
        </p>
      </Modal>
    );
  }

  const { user, permissions, roles, sessions, canManage } = detail.data;
  const canManageUsers = (me.permissions.utenti ?? 0) >= 3 && canManage;
  const canManageSessions = (me.permissions.sessioni ?? 0) >= 2 && canManage;

  return (
    <Modal title={user.name} subtitle={user.email} width={520} onClose={onClose}>
      <div style={{ display: 'grid', gap: 20 }}>
        {error ? <Notice tone="err" title={error} /> : null}

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <StatusChip status={user.status} banned={user.banned} />
          {user.twoFactorEnabled ? <Chip tone="ok">2FA attiva</Chip> : <Chip tone="warn">2FA assente</Chip>}
          {roles.map((r) => (
            <Chip key={r.key} tone={r.isSystem ? 'ac' : 'neutral'}>
              {r.name}
            </Chip>
          ))}
        </div>

        {user.banned && user.banReason ? (
          <div style={{ fontSize: 12.5, color: 'var(--tx-secondary)' }}>Motivo del ban: {user.banReason}</div>
        ) : null}

        <div>
          <div className="t-group" style={{ marginBottom: 9 }}>
            Permessi effettivi
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            {Object.entries(permissions)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([module, level]) => (
                <div
                  key={module}
                  style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}
                >
                  <span style={{ textTransform: 'capitalize', color: 'var(--tx-secondary)' }}>{module}</span>
                  <span style={{ color: level >= 1 ? 'var(--tx-primary)' : 'var(--tx-disabled)' }}>
                    {LEVELS[level] ?? level}
                  </span>
                </div>
              ))}
          </div>
        </div>

        <div>
          <div className="t-group" style={{ marginBottom: 9 }}>
            Sessioni attive ({sessions.length})
          </div>
          {sessions.length === 0 ? (
            <p className="t-lead" style={{ margin: 0 }}>
              Nessuna sessione aperta.
            </p>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {sessions.map((s) => (
                <div
                  key={s.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 12,
                    fontSize: 12,
                    color: 'var(--tx-secondary)',
                  }}
                >
                  <span className="mono">{s.ipAddress ?? '—'}</span>
                  <DateTime value={s.updatedAt} />
                </div>
              ))}
            </div>
          )}
        </div>

        {canManageUsers || canManageSessions ? (
          <div style={{ display: 'grid', gap: 8, paddingTop: 4 }}>
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
                    'Offboarding: chiude le sessioni, toglie ruoli e permessi e revoca gli inviti pendenti ' +
                      'emessi da questa persona. Motivo:',
                  );
                  if (reason && reason.trim().length >= 3) {
                    act.mutate({ path: `/api/users/${userId}/offboard`, body: { reason: reason.trim() } });
                  }
                }}
              >
                Offboarding
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function InviteDialog({
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

  // Solo i ruoli che l'attore può davvero concedere (SEC-07). L'elenco arriva
  // dal server: mostrarne di più e poi rifiutare sarebbe una promessa rotta.
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
    <Modal
      title="Invita utente"
      subtitle="L'invito arriva via email, vale 72 ore e funziona una volta sola."
      onClose={onClose}
      footer={
        done ? undefined : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Annulla
            </Button>
            {/* Il submit vive nel footer ma appartiene al form: `form=` lo
                collega senza duplicare la logica di invio. */}
            <Button
              type="submit"
              form="invite-form"
              variant="primary"
              loading={create.isPending}
              disabled={!roleId}
            >
              Invia invito
            </Button>
          </>
        )
      }
    >
      {done ? (
        <div style={{ display: 'grid', gap: 20 }}>
          <Notice
            tone="info"
            title="Invito inviato"
            description="Il link non è visibile da qui: esiste solo nell'email, e in tabella c'è soltanto il suo SHA-256."
          />
          <Button variant="primary" onClick={onClose} block>
            Chiudi
          </Button>
        </div>
      ) : (
        <form
          id="invite-form"
          onSubmit={(e) => {
            e.preventDefault();
            setError(undefined);
            create.mutate();
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
        >
          {error ? <Notice tone="err" title={error} /> : null}

          <Field
            label="Email"
            type="email"
            required
            placeholder="nome@metamc.it"
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
              Compaiono solo i ruoli che puoi concedere: nessuno dà più di quanto ha.
            </span>
          </div>
        </form>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------

/** Aree della matrice: lo stesso raggruppamento della sidebar. */
const MODULE_AREAS: Record<string, string> = {
  utenti: 'Accessi',
  ruoli: 'Accessi',
  inviti: 'Accessi',
  sessioni: 'Accessi',
  audit: 'Controllo',
  impostazioni: 'Sistema',
  statistiche: 'Analisi',
  server: 'Sistema',
};

export function RolesPage({ me, onNeedStepUp }: { me: Me; onNeedStepUp: () => void }) {
  const [error, setError] = useState<string | undefined>();
  const [roleId, setRoleId] = useState<number | undefined>();
  // Bozza locale: cambiare la matrice declassa tutti quelli che hanno il
  // ruolo, quindi si conferma in blocco. Una PUT per pallino significherebbe
  // anche una challenge di step-up per pallino.
  const [draft, setDraft] = useState<Record<number, number>>({});
  const matrix = useQuery({ queryKey: ['roles'], queryFn: () => api<RolesMatrix>('/api/roles') });
  const canEdit = (me.permissions.ruoli ?? 0) >= 3;

  const save = useMutation({
    mutationFn: (input: { roleId: number; entries: Array<{ moduleId: number; level: number }> }) =>
      api(`/api/roles/${input.roleId}/permissions`, {
        method: 'PUT',
        body: { entries: input.entries },
      }),
    onSuccess: () => {
      setError(undefined);
      setDraft({});
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
          : err instanceof ApiError && err.code === 'RUOLO_DI_SISTEMA'
            ? 'Il ruolo di sistema non è modificabile: lo impedisce il database, non la schermata.'
            : 'Modifica non riuscita.',
      );
    },
  });

  if (matrix.isPending) return <SkeletonRows rows={10} />;
  if (matrix.isError || !matrix.data) {
    return <Notice tone="err" title="Non è stato possibile caricare la matrice dei permessi" />;
  }

  const { modules, roles, permissions } = matrix.data;
  const current = roles.find((r) => r.id === roleId) ?? roles[0];
  if (!current) return <Notice tone="err" title="Nessun ruolo configurato" />;

  const savedLevelOf = (module: number) =>
    permissions.find((p) => p.role_id === current.id && p.module_id === module)?.level ?? 0;
  const levelOf = (module: number) => draft[module] ?? savedLevelOf(module);

  const areas = [...new Set(modules.map((m) => MODULE_AREAS[m.key] ?? 'Altro'))];
  const editable = canEdit && current.editable;
  const pending = Object.entries(draft)
    .map(([module, level]) => ({ moduleId: Number(module), level }))
    .filter((e) => e.level !== savedLevelOf(e.moduleId));

  return (
    <>
      <PageHeader
        title="Ruoli e permessi"
        sub={`${roles.length} ruoli · ${modules.length} moduli · il livello più alto vince quando i ruoli si sommano`}
      />

      {error ? <Notice tone="err" title={error} /> : null}

      <Panel>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 20,
            padding: '18px 20px 14px',
          }}
        >
          <div>
            <h3
              style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 600, margin: '0 0 4px' }}
            >
              Editor del ruolo · {current.name}
            </h3>
            <div style={{ fontSize: 12, color: 'var(--tx-muted)' }}>
              Moduli in riga, livelli in colonna. Un modulo su «Nessuno» sparisce dalla sidebar di chi ha
              questo ruolo.
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 'none' }}>
            <select
              className="input"
              aria-label="Ruolo da modificare"
              value={current.id}
              onChange={(e) => {
                setRoleId(Number(e.target.value));
                setDraft({});
                setError(undefined);
              }}
              style={{ height: 32, width: 180, fontSize: 12.5 }}
            >
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <span style={{ fontSize: 11.5, color: 'var(--tx-muted)', whiteSpace: 'nowrap' }}>
              {current.members} {current.members === 1 ? 'utente' : 'utenti'}
            </span>
          </div>
        </div>

        <div style={{ maxHeight: 420, overflow: 'auto' }}>
          <table className="table" style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ background: 'var(--s-inset)', paddingLeft: 20 }}>Modulo</th>
                {LEVELS.map((l) => (
                  <th key={l} style={{ background: 'var(--s-inset)', width: 110, textAlign: 'center' }}>
                    {l}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {areas.map((area) => (
                <Fragment key={area}>
                  <tr>
                    <td
                      colSpan={5}
                      className="t-group"
                      style={{ background: 'var(--s-base)', padding: '8px 20px', letterSpacing: '.1em' }}
                    >
                      {area}
                    </td>
                  </tr>
                  {modules
                    .filter((m) => (MODULE_AREAS[m.key] ?? 'Altro') === area)
                    .map((m) => {
                      const level = levelOf(m.id);
                      return (
                        <tr key={m.id}>
                          <td style={{ paddingLeft: 20 }}>{m.name}</td>
                          {LEVELS.map((label, value) => {
                            const on = level === value;
                            const changed = draft[m.id] !== undefined && draft[m.id] !== savedLevelOf(m.id);
                            const dot = on
                              ? changed
                                ? 'var(--ac)'
                                : 'var(--tx-secondary)'
                              : 'var(--bd-strong)';
                            return (
                              <td
                                key={label}
                                style={{
                                  textAlign: 'center',
                                  padding: '9px 8px',
                                  background: changed ? 'var(--ac-soft)' : undefined,
                                }}
                              >
                                <button
                                  type="button"
                                  disabled={!editable || save.isPending}
                                  aria-label={`${m.name}: ${label}`}
                                  aria-pressed={on}
                                  onClick={() => setDraft((d) => ({ ...d, [m.id]: value }))}
                                  style={{
                                    width: 13,
                                    height: 13,
                                    padding: 0,
                                    borderRadius: '50%',
                                    border: `1.5px solid ${dot}`,
                                    background: 'transparent',
                                    boxShadow: on
                                      ? `inset 0 0 0 2.5px var(--s-surface), inset 0 0 0 9px ${dot}`
                                      : 'none',
                                    cursor: editable ? 'pointer' : 'not-allowed',
                                  }}
                                />
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            padding: '14px 20px',
            borderTop: '1px solid var(--bd-subtle)',
            background: 'var(--s-inset)',
            fontSize: 12,
            color: 'var(--tx-muted)',
          }}
        >
          <span>
            {!editable
              ? current.isSystem
                ? 'Ruolo di sistema: non modificabile. Lo impedisce il database, non questa schermata.'
                : 'Serve il livello «Gestione» sul modulo Ruoli per modificare la matrice.'
              : pending.length === 0
                ? 'Nessuna modifica in sospeso.'
                : `${pending.length} ${pending.length === 1 ? 'modulo modificato' : 'moduli modificati'} · alla conferma cambia l'accesso di ${current.members} ${current.members === 1 ? 'persona' : 'persone'}.`}
          </span>
          {editable ? (
            <span style={{ display: 'flex', gap: 8 }}>
              <Button
                size="sm"
                disabled={pending.length === 0 || save.isPending}
                onClick={() => setDraft({})}
              >
                Annulla
              </Button>
              <Button
                size="sm"
                variant="primary"
                loading={save.isPending}
                disabled={pending.length === 0}
                onClick={() => save.mutate({ roleId: current.id, entries: pending })}
              >
                Conferma modifiche
              </Button>
            </span>
          ) : null}
        </div>
      </Panel>
    </>
  );
}
