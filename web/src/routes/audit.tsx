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
//
// Da qui viene anche la forma delle frecce in fondo. Un cursore dice come
// andare AVANTI, non indietro: per tornare si tiene la pila dei cursori già
// visitati. Ed è il motivo per cui il piede mostra «51–100» e non «51–100 di
// 1.284»: il totale richiederebbe un COUNT filtrato su tutte le partizioni,
// cioè esattamente la scansione che il keyset serve a evitare. Meglio nessun
// numero che un numero pagato a quel prezzo.

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  FilterSelect,
  PageArrow,
  PageHeader,
  Panel,
  PanelBar,
  PanelFooter,
  SearchBox,
  TableStates,
} from '../components/page.tsx';
import { Avatar, Badge } from '../components/ui.tsx';
import { type AuditEntry, type AuditPage, api } from '../lib/api.ts';

/**
 * Etichette per le azioni che nel registro hanno un nome fuorviante.
 *
 * Il valore memorizzato non si tocca: le righe gia' scritte sono immutabili
 * per costruzione, e riscriverle romperebbe la catena hash. Cambia solo come
 * il filtro le chiama, perche' «auth.step_up.success» su ogni login con 2FA
 * fa cercare un'operazione che il pannello non ha mai avuto.
 */
const ACTION_LABELS: Record<string, string> = {
  'auth.step_up.success': 'auth.step_up.success — storico: login con 2FA',
  'auth.step_up.failure': 'auth.step_up.failure — storico: step-up rimosso',
};

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

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

/** Quante righe per pagina. Il server accetta questo come `limit`. */
const PAGE_SIZE = 50;

type Cursor = { beforeOccurredAt: string; beforeId: string };

export function AuditPage_() {
  const [filters, setFilters] = useState<Filters>({ actor: '', module: '', action: '', outcome: '' });
  const [expanded, setExpanded] = useState<string | undefined>();
  // Un cursore per ogni pagina oltre la prima: `trail.length` è l'indice di
  // pagina, l'ultimo elemento è da dove parte quella che si sta guardando.
  const [trail, setTrail] = useState<Cursor[]>([]);

  const cursor = trail.at(-1);

  /** Cambiare filtro riporta alla prima pagina: i cursori vecchi puntano a righe che il nuovo filtro può non contenere. */
  function changeFilters(next: (f: Filters) => Filters) {
    setFilters(next);
    setTrail([]);
    setExpanded(undefined);
  }

  const vocab = useQuery({
    queryKey: ['audit-actions'],
    queryFn: () =>
      api<{ actions: string[]; modules: Array<{ key: string; name: string }> }>('/api/audit/actions'),
  });

  const query = useQuery({
    queryKey: ['audit', filters, cursor],
    queryFn: () => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (cursor) {
        params.set('beforeOccurredAt', cursor.beforeOccurredAt);
        params.set('beforeId', cursor.beforeId);
      }
      for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
      return api<AuditPage>(`/api/audit?${params.toString()}`);
    },
    // La pagina precedente resta a schermo mentre arriva la nuova: senza,
    // ogni click su una freccia fa lampeggiare lo scheletro.
    placeholderData: (previous) => previous,
  });

  const entries = query.data?.entries ?? [];
  const nextCursor = query.data?.nextCursor ?? null;
  const first = trail.length * PAGE_SIZE + 1;
  const last = trail.length * PAGE_SIZE + entries.length;

  return (
    <>
      <PageHeader title="Registro attività" sub="Ogni azione rilevante del pannello · fuso Europe/Rome" />

      <Panel>
        <PanelBar>
          {/* La stessa barra di Utenti & Ruoli, non una simile: cercare per
              attore e cercare per nome sono la stessa azione. */}
          <SearchBox
            value={filters.actor}
            onChange={(v) => changeFilters((f) => ({ ...f, actor: v }))}
            placeholder="Cerca per attore"
            label="Filtra per attore"
            width={200}
          />
          <FilterSelect
            label="Filtra per modulo"
            emptyLabel="Tutti i moduli"
            value={filters.module}
            onChange={(v) => changeFilters((f) => ({ ...f, module: v }))}
            options={(vocab.data?.modules ?? []).map((m) => ({ value: m.key, label: m.name }))}
          />
          <FilterSelect
            label="Filtra per azione"
            emptyLabel="Tutte le azioni"
            value={filters.action}
            onChange={(v) => changeFilters((f) => ({ ...f, action: v }))}
            options={(vocab.data?.actions ?? []).map((a) => ({ value: a, label: actionLabel(a) }))}
          />
          <FilterSelect
            label="Filtra per esito"
            emptyLabel="Tutti gli esiti"
            value={filters.outcome}
            onChange={(v) => changeFilters((f) => ({ ...f, outcome: v }))}
            options={[
              { value: 'success', label: 'Riuscite' },
              { value: 'failure', label: 'Fallite' },
              { value: 'denied', label: 'Negate' },
            ]}
          />
        </PanelBar>

        <TableStates
          pending={query.isPending}
          error={query.isError}
          empty={entries.length === 0}
          errorTitle="Non è stato possibile caricare il registro"
          emptyTitle="Nessuna voce"
          emptyDescription="Con questi filtri il registro è vuoto. Non significa che non sia successo nulla: prova ad allargare."
          onRetry={() => void query.refetch()}
        >
          <table className="table" style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ width: 96 }}>Ora</th>
                <th style={{ width: 200 }}>Attore</th>
                <th>Azione</th>
                <th style={{ width: 220 }}>Oggetto</th>
                <th style={{ width: 44 }} />
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <AuditRow
                  key={entry.id}
                  entry={entry}
                  expanded={expanded === entry.id}
                  onToggle={() => setExpanded(expanded === entry.id ? undefined : entry.id)}
                />
              ))}
            </tbody>
          </table>
        </TableStates>

        <PanelFooter>
          <span>{entries.length === 0 ? 'Nessuna azione' : `${first}–${last} azioni`}</span>
          <span style={{ display: 'flex', gap: 6 }}>
            <PageArrow
              glyph="‹"
              label="Pagina precedente"
              disabled={trail.length === 0 || query.isFetching}
              onClick={() => {
                setTrail((t) => t.slice(0, -1));
                setExpanded(undefined);
              }}
            />
            <PageArrow
              glyph="›"
              label="Pagina successiva"
              disabled={nextCursor === null || query.isFetching}
              onClick={() => {
                if (!nextCursor) return;
                setTrail((t) => [...t, nextCursor]);
                setExpanded(undefined);
              }}
            />
          </span>
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

/**
 * Una voce del registro: la riga chiusa piu', quando aperta, una seconda riga
 * che tiene il pannello del diff.
 *
 * Il diff sta in un `<tr>` a parte con `colSpan` invece che dentro l'ultima
 * cella perche' una cella che cresce allarga la riga chiusa sopra di se': le
 * colonne si sfaserebbero rispetto a tutte le altre righe ogni volta che
 * qualcuno apre una voce.
 */
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
    <>
      <tr onClick={onToggle} style={{ background, cursor: 'pointer' }}>
        <td
          className="mono"
          style={{ fontSize: 12, color: 'var(--tx-secondary)', fontVariantNumeric: 'tabular-nums' }}
        >
          <time dateTime={occurred.toISOString()} title={DATE_FORMAT.format(occurred)}>
            {TIME_FORMAT.format(occurred)}
          </time>
        </td>

        <td>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
            <Avatar name={entry.actor.name ?? '?'} size={22} square />
            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {entry.actor.name ?? 'anonimo'}
            </span>
          </span>
        </td>

        <td>
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
        </td>

        <td
          style={{
            color: 'var(--tx-secondary)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            maxWidth: 220,
          }}
        >
          {entry.target.label ?? entry.target.id ?? '—'}
        </td>

        <td style={{ textAlign: 'right' }}>
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? 'Chiudi i dettagli' : 'Mostra i dettagli'}
            onClick={(e) => {
              // La riga intera e' cliccabile: senza questo, il click sul
              // bottone risalirebbe fino a lei e la voce si aprirebbe e
              // richiuderebbe nello stesso gesto.
              e.stopPropagation();
              onToggle();
            }}
            style={{
              border: 0,
              background: 'transparent',
              color: 'var(--tx-muted)',
              cursor: 'pointer',
              padding: 4,
              display: 'inline-flex',
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
          </button>
        </td>
      </tr>

      {expanded ? (
        <tr style={{ background }}>
          <td colSpan={5} style={{ padding: '0 16px 16px 16px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
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
          </td>
        </tr>
      ) : null}
    </>
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
