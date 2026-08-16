// Inviti pendenti.
//
// Il token non compare da nessuna parte: esiste solo nell'email, e in tabella
// c'è solo il suo SHA-256. La schermata mostra chi ha invitato chi, con quale
// ruolo e fino a quando — non offre un modo di rivedere il link, perché non
// esiste un modo.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Badge,
  Banner,
  Button,
  Card,
  DateTime,
  EmptyState,
  RelativeTime,
  SkeletonRows,
} from '../components/ui.tsx';
import { ApiError, api, type InviteRow, type Me } from '../lib/api.ts';

export function InvitesPage({ me, onNeedStepUp }: { me: Me; onNeedStepUp: () => void }) {
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
      if (err instanceof ApiError && err.needsStepUp) {
        onNeedStepUp();
        return;
      }
      setError('Revoca non riuscita.');
    },
  });

  const canRevoke = (me.permissions.inviti ?? 0) >= 2;
  const rows = invites.data?.invites ?? [];

  return (
    <Card
      title="Inviti pendenti"
      subtitle="Il link vale 72 ore e funziona una volta sola. Non è recuperabile da qui: esiste solo nell'email."
    >
      {error ? (
        <div style={{ marginBottom: 'var(--sp4)' }}>
          <Banner tone="err" title={error} />
        </div>
      ) : null}

      {invites.isPending ? (
        <SkeletonRows />
      ) : invites.isError ? (
        <Banner
          tone="err"
          title="Non è stato possibile caricare gli inviti"
          action={
            <Button size="sm" onClick={() => void invites.refetch()}>
              Riprova
            </Button>
          }
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="Nessun invito in sospeso"
          description="Quando inviti qualcuno, l'invito compare qui finché non viene accettato, revocato o non scade."
        />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Destinatario</th>
                <th>Ruolo</th>
                <th>Invitato da</th>
                <th>Scade</th>
                {canRevoke ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((invite) => {
                const expiringSoon = new Date(invite.expiresAt).getTime() - Date.now() < 12 * 3600_000;
                return (
                  <tr key={invite.id}>
                    <td>{invite.email}</td>
                    <td>
                      <Badge tone="neutral">{invite.roleName}</Badge>
                    </td>
                    <td className="t-sm" style={{ color: 'var(--tx-muted)' }}>
                      {invite.invitedByName ?? '—'}
                    </td>
                    <td>
                      <DateTime value={invite.expiresAt} />{' '}
                      <span
                        className="t-sm"
                        style={{ color: expiringSoon ? 'var(--warn)' : 'var(--tx-muted)' }}
                      >
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
    </Card>
  );
}
