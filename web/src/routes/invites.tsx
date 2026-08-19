// Inviti pendenti.
//
// Il token non compare da nessuna parte: esiste solo nell'email, e in tabella
// c'è solo il suo SHA-256. La schermata mostra chi ha invitato chi, con quale
// ruolo e fino a quando — non offre un modo di rivedere il link, perché non
// esiste un modo.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Chip, PageHeader, Panel, PanelBar, PanelFooter } from '../components/page.tsx';
import {
  Avatar,
  Banner,
  Button,
  DateTime,
  EmptyState,
  RelativeTime,
  SkeletonRows,
} from '../components/ui.tsx';
import { ApiError, api, type InviteRow, type Me } from '../lib/api.ts';

export function InvitesPage({ me }: { me: Me }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | undefined>();

  const invites = useQuery({
    queryKey: ['invites'],
    queryFn: () => api<{ invites: InviteRow[] }>('/api/invites'),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api/invites/${id}/revoke`, { method: 'POST' }),
    onSuccess: () => {
      setError(undefined);
      void qc.invalidateQueries({ queryKey: ['invites'] });
    },
    onError: (err) => {
      // La revoca è fra le operazioni che richiedono step-up (§8.5): un
      // invito revocato per errore non si riapre.
      setError('Revoca non riuscita.');
    },
  });

  const canRevoke = (me.permissions.inviti ?? 0) >= 2;
  const rows = invites.data?.invites ?? [];

  return (
    <>
      <PageHeader
        title="Inviti pendenti"
        sub="Il link vale 72 ore e funziona una volta sola. Non è recuperabile da qui: esiste solo nell'email."
      />

      {error ? <Banner tone="err" title={error} /> : null}

      <Panel>
        <PanelBar>
          <span style={{ fontSize: 12.5, color: 'var(--tx-secondary)' }}>In attesa di accettazione</span>
          <span className="mono" style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--tx-muted)' }}>
            {rows.length} {rows.length === 1 ? 'invito' : 'inviti'}
          </span>
        </PanelBar>

        {invites.isPending ? (
          <SkeletonRows />
        ) : invites.isError ? (
          <div style={{ padding: 16 }}>
            <Banner
              tone="err"
              title="Non è stato possibile caricare gli inviti"
              action={
                <Button size="sm" onClick={() => void invites.refetch()}>
                  Riprova
                </Button>
              }
            />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            title="Nessun invito in sospeso"
            description="Quando inviti qualcuno, l'invito compare qui finché non viene accettato, revocato o non scade."
          />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table" style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--s-inset)' }}>
                  <th style={{ paddingLeft: 16 }}>Destinatario</th>
                  <th>Ruolo</th>
                  <th>Invitato da</th>
                  <th style={{ textAlign: 'right' }}>Scade</th>
                  {canRevoke ? <th style={{ width: 100 }} /> : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((invite) => {
                  const expiringSoon = new Date(invite.expiresAt).getTime() - Date.now() < 12 * 3600_000;
                  return (
                    <tr key={invite.id}>
                      <td style={{ paddingLeft: 16 }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                          <Avatar name={invite.name} size={26} square />
                          <span>
                            <span style={{ display: 'block', fontWeight: 500 }}>{invite.name}</span>
                            <span style={{ display: 'block', fontSize: 11.5, color: 'var(--tx-muted)' }}>
                              {invite.email}
                            </span>
                          </span>
                        </span>
                      </td>
                      <td>
                        <Chip>{invite.roleName}</Chip>
                      </td>
                      <td style={{ color: 'var(--tx-secondary)' }}>{invite.invitedByName ?? '—'}</td>
                      <td
                        style={{
                          textAlign: 'right',
                          fontSize: 12,
                          color: expiringSoon ? 'var(--warn)' : 'var(--tx-secondary)',
                        }}
                      >
                        <DateTime value={invite.expiresAt} />{' '}
                        <span style={{ color: 'var(--tx-muted)' }}>
                          (<RelativeTime value={invite.expiresAt} />)
                        </span>
                      </td>
                      {canRevoke ? (
                        <td style={{ textAlign: 'right' }}>
                          <Button
                            size="sm"
                            variant="ghost"
                            loading={revoke.isPending}
                            onClick={() => {
                              if (window.confirm(`Revocare l'invito per ${invite.email}? Non si riapre.`)) {
                                revoke.mutate(invite.id);
                              }
                            }}
                          >
                            Revoca
                          </Button>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <PanelFooter>
          <span>Un invito revocato non si riapre: se serve ancora, se ne emette uno nuovo.</span>
        </PanelFooter>
      </Panel>
    </>
  );
}
