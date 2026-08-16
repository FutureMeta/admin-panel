// App shell: sidebar, topbar, command palette.
//
// La sidebar mostra SOLO i moduli a cui l'utente ha accesso. Nessuna voce
// disabilitata, nessun lucchetto: l'elenco stesso dei moduli e' informazione,
// e mostrarlo a chi non ci entra e' ricognizione gratuita.

import { Link, useRouterState } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Me, ModuleKey } from '../lib/api.ts';
import { Badge } from './ui.tsx';

/** Voci di navigazione, per modulo. Un modulo assente = voce assente. */
const NAV: Array<{ module: ModuleKey; label: string; to: string; group: string }> = [
  { module: 'utenti', label: 'Utenti', to: '/utenti', group: 'Accessi' },
  { module: 'ruoli', label: 'Ruoli e permessi', to: '/ruoli', group: 'Accessi' },
  { module: 'inviti', label: 'Inviti', to: '/inviti', group: 'Accessi' },
  { module: 'audit', label: 'Registro attività', to: '/registro', group: 'Controllo' },
  // Le voci elencate qui sono SOLO quelle con una schermata vera. Il modello
  // dei permessi conosce anche `sessioni`, `impostazioni`, `statistiche` e
  // `server`, ma un link che porta a un 404 e' peggio di un link assente: dice
  // che qualcosa esiste e non la trova. Le sessioni si gestiscono dal dettaglio
  // utente; le altre tre sono fase 2.
];

function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--sp2)' }}>
      <svg width="24" height="27" viewBox="0 0 56 64" aria-hidden="true">
        <path d="M28 1 54 16v32L28 63 2 48V16z" fill="var(--s-inset)" stroke="var(--bd-strong)" />
        <path d="M17 42V22h9l2 4-2 4" fill="none" stroke="var(--blu)" strokeWidth="5" />
        <path d="M28 30l3-8h8v20" fill="none" stroke="var(--ac)" strokeWidth="5" />
      </svg>
      {compact ? null : (
        <span style={{ font: '700 16px/22px var(--font-display)' }}>
          <span style={{ color: 'var(--ac)' }}>Meta</span>
          <span style={{ color: 'var(--blu-viz)' }}>MC</span>
          <span style={{ color: 'var(--tx-muted)', fontWeight: 500 }}> Admin</span>
        </span>
      )}
    </span>
  );
}

export function Sidebar({ me, collapsed }: { me: Me; collapsed: boolean }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Solo i moduli concessi, nell'ordine dichiarato. `me.modules` arriva dal
  // server: il client non decide chi vede cosa, lo disegna e basta.
  const visible = useMemo(() => NAV.filter((n) => me.modules.includes(n.module)), [me.modules]);
  const groups = useMemo(() => {
    const map = new Map<string, typeof visible>();
    for (const item of visible) {
      const list = map.get(item.group) ?? [];
      list.push(item);
      map.set(item.group, list);
    }
    return [...map.entries()];
  }, [visible]);

  return (
    <nav
      aria-label="Moduli"
      style={{
        width: collapsed ? 64 : 232,
        flexShrink: 0,
        background: 'var(--s-surface)',
        borderRight: '1px solid var(--bd-subtle)',
        padding: 'var(--sp4) var(--sp3)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--sp6)',
        transition: 'width var(--dur) var(--ease)',
        overflow: 'hidden',
      }}
    >
      <div style={{ paddingLeft: 'var(--sp2)' }}>
        <Logo compact={collapsed} />
      </div>

      {groups.map(([group, items]) => (
        <div key={group} style={{ display: 'grid', gap: 'var(--sp1)' }}>
          {collapsed ? null : (
            <p className="t-micro" style={{ margin: '0 0 var(--sp1) var(--sp3)', color: 'var(--tx-muted)' }}>
              {group}
            </p>
          )}
          {items.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="nav-item"
              data-active={pathname.startsWith(item.to)}
              title={collapsed ? item.label : undefined}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  background: pathname.startsWith(item.to) ? 'var(--ac)' : 'var(--tx-disabled)',
                  flexShrink: 0,
                }}
              />
              {collapsed ? null : item.label}
            </Link>
          ))}
        </div>
      ))}

      <div style={{ marginTop: 'auto' }}>
        {collapsed ? null : (
          <p className="t-sm" style={{ color: 'var(--tx-muted)', margin: 0, paddingLeft: 'var(--sp3)' }}>
            {me.modules.length} moduli
          </p>
        )}
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------------------

export type Command = { id: string; label: string; hint?: string; run: () => void };

/**
 * Command palette (⌘K).
 *
 * Elenca solo comandi che l'utente puo' davvero eseguire: la lista arriva
 * gia' filtrata da chi la costruisce, con la stessa regola della sidebar.
 */
export function CommandPalette({
  open,
  onClose,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(q) || c.hint?.toLowerCase().includes(q));
  }, [commands, query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setIndex(0);
      inputRef.current?.focus();
    }
  }, [open]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Comandi"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(7, 18, 25, 0.7)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '12vh',
        zIndex: 50,
      }}
    >
      <div
        className="elevated"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(560px, 92vw)', overflow: 'hidden' }}
      >
        <input
          ref={inputRef}
          className="input"
          placeholder="Cerca un comando…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, filtered.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              const chosen = filtered[index];
              if (chosen) {
                chosen.run();
                onClose();
              }
            } else if (e.key === 'Escape') {
              onClose();
            }
          }}
          style={{ border: 0, borderBottom: '1px solid var(--bd-subtle)', borderRadius: 0, height: 52 }}
        />
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 'var(--sp2)',
            maxHeight: '48vh',
            overflowY: 'auto',
          }}
        >
          {filtered.length === 0 ? (
            <li className="t-sm" style={{ padding: 'var(--sp4)', color: 'var(--tx-muted)' }}>
              Nessun comando corrisponde.
            </li>
          ) : (
            filtered.map((c, i) => (
              <li key={c.id}>
                <button
                  type="button"
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => {
                    c.run();
                    onClose();
                  }}
                  style={{
                    width: '100%',
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 'var(--sp4)',
                    padding: 'var(--sp3)',
                    border: 0,
                    borderRadius: 'var(--r-md)',
                    background: i === index ? 'var(--ac-soft)' : 'transparent',
                    color: i === index ? 'var(--ac-text)' : 'var(--tx-primary)',
                    font: '500 14px/20px var(--font-ui)',
                    textAlign: 'left',
                    cursor: 'pointer',
                  }}
                >
                  <span>{c.label}</span>
                  {c.hint ? (
                    <span className="t-sm" style={{ color: 'var(--tx-muted)' }}>
                      {c.hint}
                    </span>
                  ) : null}
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function Topbar({
  me,
  onToggleSidebar,
  onOpenPalette,
  onLogout,
  feedDisconnected,
}: {
  me: Me;
  onToggleSidebar: () => void;
  onOpenPalette: () => void;
  onLogout: () => void;
  feedDisconnected: boolean;
}) {
  return (
    <header
      style={{
        height: 56,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp3)',
        padding: '0 var(--sp5)',
        borderBottom: '1px solid var(--bd-subtle)',
        background: 'var(--s-surface)',
      }}
    >
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={onToggleSidebar}
        aria-label="Comprimi menu"
      >
        ☰
      </button>

      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={onOpenPalette}
        style={{ color: 'var(--tx-muted)', gap: 'var(--sp3)' }}
      >
        Cerca…
        <kbd className="mono" style={{ padding: '2px 6px', background: 'var(--s-inset)', borderRadius: 4 }}>
          ⌘K
        </kbd>
      </button>

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 'var(--sp4)' }}>
        {feedDisconnected ? <Badge tone="warn">feed disconnesso</Badge> : <Badge tone="ok">operativo</Badge>}
        <div style={{ textAlign: 'right' }}>
          <p style={{ margin: 0, font: '600 13px/16px var(--font-ui)' }}>{me.name}</p>
          <p className="t-sm" style={{ margin: 0, color: 'var(--tx-muted)' }}>
            {me.email}
          </p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onLogout}>
          Esci
        </button>
      </div>
    </header>
  );
}
