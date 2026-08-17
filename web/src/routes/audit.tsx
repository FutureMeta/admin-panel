// Registro attività: tabella virtualizzata, paginazione keyset, riga
// espandibile con il diff prima/dopo.
//
// SEC-35 — questa è la schermata che il divieto di innerHTML protegge davvero:
// renderizza user agent, motivi di ban e payload jsonb, cioè stringhe che
// arrivano da terzi. Tutto passa da nodi di testo React; il diff è composto da
// nodi, non da HTML.
//
// La paginazione è KEYSET: il cursore è (occurred_at, id) dell'ultima riga.
// Con OFFSET, la pagina 900 costerebbe la scansione delle 45.000 righe che la
// precedono — è il problema del pannello legacy, e non lo si riporta dentro.

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef, useState } from 'react';
import { FilterSelect, PageHeader, Panel, PanelBar, PanelFooter, SearchBox } from '../components/page.tsx';
import { Avatar, Badge, Banner, Button, EmptyState, SkeletonRows } from '../components/ui.tsx';
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
    estimateSize: () => 45,
    overscan: 8,
  });

  return (
    <>
      <PageHeader
        title="Registro attività"
        sub="Ogni azione rilevante del pannello · fuso Europe/Rome"
        {...(canVerify ? { action: <IntegrityBadge /> } : {})}
      />

      <Panel>
        <PanelBar>
          {/* La stessa barra di Utenti & Ruoli, non una simile: cercare per
              attore e cercare per nome sono la stessa azione. */}
          <SearchBox
            value={filters.actor}
            onChange={(v) => setFilters((f) => ({ ...f, actor: v }))}
            placeholder="Cerca per attore"
            label="Filtra per attore"
            width={200}
          />
          <FilterSelect
            label="Tutti i moduli"
            value={filters.module}
            onChange={(v) => setFilters((f) => ({ ...f, module: v }))}
            options={(vocab.data?.modules ?? []).map((m) => ({ value: m.key, label: m.name }))}
          />
          <FilterSelect
            label="Tutte le azioni"
            value={filters.action}
            onChange={(v) => setFilters((f) => ({ ...f, action: v }))}
            options={(vocab.data?.actions ?? []).map((a) => ({ value: a, label: a }))}
          />
          <FilterSelect
            label="Tutti gli esiti"
            value={filters.outcome}
            onChange={(v) => setFilters((f) => ({ ...f, outcome: v }))}
            options={[
              { value: 'success', label: 'Riuscite' },
              { value: 'failure', label: 'Fallite' },
              { value: 'denied', label: 'Negate' },
            ]}
          />
        </PanelBar>

        {query.isPending ? (
          <SkeletonRows rows={10} />
        ) : query.isError ? (
          <div style={{ padding: 16 }}>
            <Banner
              tone="err"
              title="Non è stato possibile caricare il registro"
              action={
                <Button size="sm" onClick={() => void query.refetch()}>
                  Riprova
                </Button>
              }
            />
          </div>
        ) : entries.length === 0 ? (
          <EmptyState
            title="Nessuna voce"
            description="Con questi filtri il registro è vuoto. Non significa che non sia successo nulla: prova ad allargare."
          />
        ) : (
          <div ref={parentRef} style={{ maxHeight: '62vh', overflowY: 'auto' }}>
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
        )}

        <PanelFooter>
          <span>
            {entries.length} {entries.length === 1 ? 'azione caricata' : 'azioni caricate'}
          </span>
          {query.hasNextPage ? (
            <Button size="sm" onClick={() => void query.fetchNextPage()} loading={query.isFetchingNextPage}>
              Carica altre 50
            </Button>
          ) : (
            <span>Fine del registro con questi filtri.</span>
          )}
        </PanelFooter>
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------------------

/** Solo l'ora nella colonna stretta: la data completa sta nel pannello aperto. */
const TIME_FORMAT = new Intl.DateTimeFormat('it-IT', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  timeZone: 'Europe/Rome',
});
const DATE_FORMAT = new Intl.DateTimeFormat('it-IT', {
  dateStyle: 'medium',
  timeStyle: 'medium',
  timeZone: 'Europe/Rome',
});

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
  const occurred = new Date(entry.occurredAt);
  // Le righe che meritano attenzione si distinguono dallo sfondo, non da un
  // colore sul testo: la lettura in diagonale deve funzionare.
  const background =
    entry.outcome === 'denied'
      ? 'var(--err-soft)'
      : entry.outcome === 'failure'
        ? 'var(--warn-soft)'
        : SENSITIVE.has(entry.action)
          ? 'var(--ac-soft)'
          : undefined;

  return (
    <div style={{ borderBottom: '1px solid var(--bd-subtle)', background }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        style={{
          display: 'grid',
          gridTemplateColumns: '96px 180px 1fr 220px 26px',
          alignItems: 'center',
          gap: 14,
          padding: '12px 16px',
          width: '100%',
          background: 'none',
          border: 0,
          color: 'inherit',
          textAlign: 'left',
          cursor: 'pointer',
          fontSize: 13,
        }}
      >
        <time
          className="mono"
          dateTime={occurred.toISOString()}
          title={DATE_FORMAT.format(occurred)}
          style={{ fontSize: 12, color: 'var(--tx-secondary)', fontVariantNumeric: 'tabular-nums' }}
        >
          {TIME_FORMAT.format(occurred)}
        </time>

        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
          <Avatar name={entry.actor.name ?? '?'} size={22} square />
          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {entry.actor.name ?? 'anonimo'}
          </span>
        </span>

        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
          <span className="mono" style={{ fontWeight: 500, fontSize: 12.5 }}>
            {entry.action}
          </span>
          {entry.outcome !== 'success' ? (
            <Badge tone={entry.outcome === 'denied' ? 'err' : 'warn'}>
              {entry.outcome === 'denied' ? 'negato' : 'fallito'}
            </Badge>
          ) : null}
        </span>

        <span
          style={{
            color: 'var(--tx-secondary)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {entry.target.label ?? entry.target.id ?? '—'}
        </span>

        <span
          aria-hidden="true"
          style={{
            color: 'var(--tx-muted)',
            display: 'flex',
            justifyContent: 'flex-end',
            transform: expanded ? 'rotate(180deg)' : 'none',
            transition: 'transform var(--dur) var(--ease)',
          }}
        >
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </button>

      {expanded ? (
        <div
          style={{ padding: '0 16px 16px 112px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}
        >
          <DiffBox title="Prima" value={entry.before} tint="var(--err)" />
          <DiffBox title="Dopo" value={entry.after} tint="var(--ok)" />
          {entry.meta ? (
            <div style={{ gridColumn: '1 / -1' }}>
              <DiffBox title="Contesto" value={entry.meta} tint="var(--tx-secondary)" />
            </div>
          ) : null}
          <div
            className="mono"
            style={{
              gridColumn: '1 / -1',
              display: 'flex',
              gap: 18,
              flexWrap: 'wrap',
              fontSize: 11.5,
              color: 'var(--tx-muted)',
            }}
          >
            <span>{DATE_FORMAT.format(occurred)}</span>
            <span>{entry.actor.email ?? 'anonimo'}</span>
            <span style={ipMismatch ? { color: 'var(--warn)' } : undefined}>
              {entry.actor.ip ?? '—'}
              {ipMismatch ? ` ≠ ${entry.actor.socketIp ?? '—'}` : ''}
            </span>
            {/* Stringa controllata da terzi: nodo di testo, mai HTML. */}
            <span style={{ minWidth: 0, wordBreak: 'break-all' }}>{entry.actor.userAgent ?? '—'}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** jsonb controllato da terzi: chiavi e valori diventano nodi di testo. */
function DiffBox({ title, value, tint }: { title: string; value: unknown; tint: string }) {
  if (value === null || value === undefined) return null;
  const rows =
    typeof value === 'object' && !Array.isArray(value)
      ? Object.entries(value as Record<string, unknown>)
      : null;

  return (
    <div
      style={{
        border: '1px solid var(--bd-subtle)',
        borderRadius: 'var(--r-sm)',
        background: 'var(--s-base)',
        padding: '12px 14px',
        minWidth: 0,
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 600,
          letterSpacing: '.1em',
          textTransform: 'uppercase',
          color: 'var(--tx-muted)',
          marginBottom: 9,
        }}
      >
        {title}
      </div>
      <div
        className="mono"
        style={{ fontSize: 12, lineHeight: '20px', color: 'var(--tx-secondary)', wordBreak: 'break-word' }}
      >
        {rows
          ? rows.map(([k, v]) => (
              <div key={k}>
                {k}: <span style={{ color: tint }}>{format(v)}</span>
              </div>
            ))
          : format(value)}
      </div>
    </div>
  );
}

function format(value: unknown): string {
  if (value === null) return 'nullo';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
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
    <Badge tone="ok" dot>
      catena integra · {check.data.rows} voci
    </Badge>
  ) : (
    <Badge tone="err" dot>
      catena compromessa
    </Badge>
  );
}
