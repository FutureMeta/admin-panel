// Registro attività: tabella virtualizzata, paginazione keyset, riga
// espandibile con il diff prima/dopo.
//
// SEC-35 — questa è la schermata che il divieto di innerHTML protegge davvero:
// renderizza user agent, motivi di ban e payload jsonb, cioè stringhe che
// arrivano da terzi. Tutto passa da nodi di testo React; il diff è un <pre>
// con JSON.stringify, non HTML.
//
// La paginazione è KEYSET: il cursore è (occurred_at, id) dell'ultima riga.
// Con OFFSET, la pagina 900 costerebbe la scansione delle 45.000 righe che la
// precedono — è il problema del pannello legacy, e non lo si riporta dentro.

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef, useState } from 'react';
import {
  Badge,
  Banner,
  Button,
  Card,
  DateTime,
  EmptyState,
  OutcomeBadge,
  SkeletonRows,
} from '../components/ui.tsx';
import { type AuditEntry, type AuditPage, api } from '../lib/api.ts';

/** Azioni che meritano un'occhiata anche quando sono andate a buon fine. */
const SENSITIVE = new Set([
  'user.role.grant',
  'user.role.revoke',
  'user.permission.grant',
  'user.permission.revoke',
  'role.permissions.change',
  'user.banned',
  'user.offboarded',
  'user.2fa_disabled',
  'session.revoke_all',
  'twofactor_reset.executed',
]);

type Filters = { actor: string; module: string; action: string; outcome: string };

export function AuditPage_({ canVerify }: { canVerify: boolean }) {
  const [filters, setFilters] = useState<Filters>({ actor: '', module: '', action: '', outcome: '' });
  const [expanded, setExpanded] = useState<string | undefined>();
  const parentRef = useRef<HTMLDivElement>(null);

  const vocab = useQuery({
    queryKey: ['audit-actions'],
    queryFn: () =>
      api<{ actions: string[]; modules: Array<{ key: string; name: string }> }>('/api/audit/actions'),
  });

  const query = useInfiniteQuery({
    queryKey: ['audit', filters],
    initialPageParam: undefined as { beforeOccurredAt: string; beforeId: string } | undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '50' });
      if (pageParam) {
        params.set('beforeOccurredAt', pageParam.beforeOccurredAt);
        params.set('beforeId', pageParam.beforeId);
      }
      for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
      return api<AuditPage>(`/api/audit?${params.toString()}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const entries = useMemo(() => (query.data?.pages ?? []).flatMap((p) => p.entries), [query.data]);

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => parentRef.current,
    // Le righe espanse sono più alte: la stima è quella chiusa, e il
    // virtualizzatore misura quelle vere con `measureElement`.
    estimateSize: () => 56,
    overscan: 8,
  });

  return (
    <div style={{ display: 'grid', gap: 'var(--sp5)' }}>
      <Card
        title="Registro attività"
        subtitle="Ogni azione rilevante, con chi l'ha fatta, quando e da quale indirizzo. Fuso Europe/Rome."
        actions={canVerify ? <IntegrityBadge /> : undefined}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 'var(--sp3)',
            marginBottom: 'var(--sp4)',
          }}
        >
          <input
            className="input"
            placeholder="ID attore"
            aria-label="Filtra per attore"
            value={filters.actor}
            onChange={(e) => setFilters((f) => ({ ...f, actor: e.target.value }))}
          />
          <select
            className="input"
            aria-label="Filtra per modulo"
            value={filters.module}
            onChange={(e) => setFilters((f) => ({ ...f, module: e.target.value }))}
          >
            <option value="">Tutti i moduli</option>
            {(vocab.data?.modules ?? []).map((m) => (
              <option key={m.key} value={m.key}>
                {m.name}
              </option>
            ))}
          </select>
          <select
            className="input"
            aria-label="Filtra per azione"
            value={filters.action}
            onChange={(e) => setFilters((f) => ({ ...f, action: e.target.value }))}
          >
            <option value="">Tutte le azioni</option>
            {(vocab.data?.actions ?? []).map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <select
            className="input"
            aria-label="Filtra per esito"
            value={filters.outcome}
            onChange={(e) => setFilters((f) => ({ ...f, outcome: e.target.value }))}
          >
            <option value="">Tutti gli esiti</option>
            <option value="success">Riuscite</option>
            <option value="failure">Fallite</option>
            <option value="denied">Negate</option>
          </select>
        </div>

        {query.isPending ? (
          <SkeletonRows rows={10} />
        ) : query.isError ? (
          <Banner
            tone="err"
            title="Non è stato possibile caricare il registro"
            action={
              <Button size="sm" onClick={() => void query.refetch()}>
                Riprova
              </Button>
            }
          />
        ) : entries.length === 0 ? (
          <EmptyState
            title="Nessuna voce"
            description="Con questi filtri il registro è vuoto. Non significa che non sia successo nulla: prova ad allargare."
          />
        ) : (
          <>
            <div
              ref={parentRef}
              style={{
                height: '58vh',
                overflowY: 'auto',
                border: '1px solid var(--bd-subtle)',
                borderRadius: 'var(--r-md)',
              }}
            >
              <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                {virtualizer.getVirtualItems().map((item) => {
                  const entry = entries[item.index];
                  if (!entry) return null;
                  return (
                    <div
                      key={entry.id}
                      ref={virtualizer.measureElement}
                      data-index={item.index}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        transform: `translateY(${item.start}px)`,
                      }}
                    >
                      <AuditRow
                        entry={entry}
                        expanded={expanded === entry.id}
                        onToggle={() => setExpanded(expanded === entry.id ? undefined : entry.id)}
                      />
                    </div>
                  );
                })}
              </div>
            </div>

            <div style={{ marginTop: 'var(--sp4)', display: 'flex', justifyContent: 'center' }}>
              {query.hasNextPage ? (
                <Button onClick={() => void query.fetchNextPage()} loading={query.isFetchingNextPage}>
                  Carica altre 50
                </Button>
              ) : (
                <p className="t-sm" style={{ color: 'var(--tx-muted)', margin: 0 }}>
                  Fine del registro con questi filtri.
                </p>
              )}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------

function AuditRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: AuditEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const ipMismatch =
    entry.actor.ip !== null && entry.actor.socketIp !== null && entry.actor.ip !== entry.actor.socketIp;

  return (
    <div style={{ borderBottom: '1px solid var(--bd-subtle)', padding: 'var(--sp3) var(--sp4)' }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        style={{
          display: 'grid',
          gridTemplateColumns: '140px 1fr 200px 88px 28px',
          gap: 'var(--sp4)',
          alignItems: 'center',
          width: '100%',
          background: 'none',
          border: 0,
          color: 'inherit',
          textAlign: 'left',
          cursor: 'pointer',
          padding: 0,
        }}
      >
        <span className="t-sm tabular" style={{ color: 'var(--tx-muted)' }}>
          <DateTime value={entry.occurredAt} seconds />
        </span>

        <span style={{ minWidth: 0 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp2)' }}>
            <code className="mono" style={{ color: 'var(--tx-primary)' }}>
              {entry.action}
            </code>
            {SENSITIVE.has(entry.action) ? <Badge tone="ac">sensibile</Badge> : null}
          </span>
          {entry.target.label ? (
            <span
              className="t-sm"
              style={{
                display: 'block',
                color: 'var(--tx-muted)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              su {entry.target.label}
            </span>
          ) : null}
        </span>

        <span style={{ minWidth: 0 }}>
          <span
            className="t-sm"
            style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {entry.actor.name ?? '—'}
          </span>
          <span className="mono" style={{ display: 'block' }}>
            {entry.actor.ip ?? '—'}
            {ipMismatch ? ' ⚠' : ''}
          </span>
        </span>

        <span>
          <OutcomeBadge outcome={entry.outcome} />
        </span>

        <span aria-hidden="true" style={{ color: 'var(--tx-muted)', textAlign: 'right' }}>
          {expanded ? '▾' : '▸'}
        </span>
      </button>

      {expanded ? (
        <div style={{ marginTop: 'var(--sp3)', display: 'grid', gap: 'var(--sp3)' }}>
          <dl
            className="t-sm"
            style={{
              display: 'grid',
              gridTemplateColumns: 'auto 1fr',
              gap: 'var(--sp1) var(--sp4)',
              margin: 0,
            }}
          >
            <dt style={{ color: 'var(--tx-muted)' }}>Attore</dt>
            <dd className="mono" style={{ margin: 0 }}>
              {entry.actor.email ?? '—'} ({entry.actor.userId ?? 'anonimo'})
            </dd>
            <dt style={{ color: 'var(--tx-muted)' }}>IP dichiarato / socket</dt>
            <dd className="mono" style={{ margin: 0, color: ipMismatch ? 'var(--warn)' : undefined }}>
              {entry.actor.ip ?? '—'} / {entry.actor.socketIp ?? '—'}
              {ipMismatch ? ' — divergono' : ''}
            </dd>
            <dt style={{ color: 'var(--tx-muted)' }}>User agent</dt>
            {/* Stringa controllata da terzi: nodo di testo, mai HTML. */}
            <dd style={{ margin: 0, wordBreak: 'break-all' }}>{entry.actor.userAgent ?? '—'}</dd>
          </dl>

          {entry.before || entry.after || entry.meta ? (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                gap: 'var(--sp3)',
              }}
            >
              <JsonBlock title="Prima" value={entry.before} />
              <JsonBlock title="Dopo" value={entry.after} />
              <JsonBlock title="Contesto" value={entry.meta} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** jsonb controllato da terzi: `JSON.stringify` dentro un <pre>, mai HTML. */
function JsonBlock({ title, value }: { title: string; value: unknown }) {
  if (value === null || value === undefined) return null;
  return (
    <div>
      <p className="t-micro" style={{ margin: '0 0 var(--sp1)', color: 'var(--tx-muted)' }}>
        {title}
      </p>
      <pre
        className="mono"
        style={{
          margin: 0,
          padding: 'var(--sp3)',
          background: 'var(--s-inset)',
          border: '1px solid var(--bd-subtle)',
          borderRadius: 'var(--r-sm)',
          overflowX: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}
      >
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * §10 — l'integrità della catena è l'informazione che rende credibile il
 * registro. Chi lo consulta deve poterla vedere senza chiedere ai sistemi.
 */
function IntegrityBadge() {
  const check = useQuery({
    queryKey: ['audit-integrity'],
    queryFn: () => api<{ ok: boolean; rows: number; detail: string | null }>('/api/audit/integrity'),
    refetchInterval: 60_000,
  });

  if (check.isPending) return <Badge tone="neutral">verifica…</Badge>;
  if (check.isError) return <Badge tone="warn">verifica non disponibile</Badge>;
  return check.data?.ok ? (
    <Badge tone="ok">catena integra · {check.data.rows} voci</Badge>
  ) : (
    <Badge tone="err">catena compromessa</Badge>
  );
}
