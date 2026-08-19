// App shell: sidebar, topbar, command palette. Metriche del prototipo.
//
// La sidebar mostra SOLO i moduli a cui l'utente ha accesso. Nessuna voce
// disabilitata, nessun lucchetto: l'elenco stesso dei moduli è informazione,
// e mostrarlo a chi non ci entra è ricognizione gratuita.

import { Link, useRouterState } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Me, ModuleKey } from '../lib/api.ts';
import { Avatar, ICONS, Icon } from './ui.tsx';

/**
 * Voci di navigazione: quelle di `frontend/metamc-shared.js` (`NAV`), meno il
 * gruppo "Analisi" che è la fase 2.
 *
 * "Utenti & Ruoli" è UNA voce, non tre: nel prototipo utenti, matrice dei
 * permessi e inviti stanno sulla stessa schermata. Una voce compare se
 * l'utente ha accesso ad almeno uno dei moduli che quella schermata mostra —
 * e la schermata poi disegna solo le sezioni che gli competono.
 */
const NAV: Array<{ modules: ModuleKey[]; label: string; to: string; area: string; icon: string }> = [
  {
    modules: ['utenti', 'ruoli', 'inviti'],
    label: 'Utenti & Ruoli',
    to: '/utenti',
    area: 'Amministrazione',
    icon: ICONS.users,
  },
  {
    modules: ['audit'],
    label: 'Registro attività',
    to: '/registro',
    area: 'Amministrazione',
    icon: ICONS.log,
  },
];

export function Sidebar({ me, onOpenPalette }: { me: Me; onOpenPalette: () => void }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // `me.modules` arriva già filtrato dal server: il client non decide chi vede
  // cosa, lo disegna e basta.
  const groups = useMemo(() => {
    const visible = NAV.filter((n) => n.modules.some((m) => me.modules.includes(m)));
    const map = new Map<string, typeof visible>();
    for (const item of visible) {
      const list = map.get(item.area) ?? [];
      list.push(item);
      map.set(item.area, list);
    }
    return [...map.entries()];
  }, [me.modules]);

  return (
    <aside
      aria-label="Moduli"
      style={{
        width: 248,
        flex: 'none',
        alignSelf: 'stretch',
        background: 'var(--s-surface)',
        borderRight: '1px solid var(--bd-subtle)',
        padding: '16px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 22,
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 4px' }}>
        <img
          src="/assets/logo.png"
          alt=""
          width={28}
          height={28}
          style={{ objectFit: 'contain', flex: 'none' }}
        />
        <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontFamily: 'var(--font-display)',
                fontWeight: 700,
                fontSize: 13,
                letterSpacing: '.12em',
                textTransform: 'uppercase',
              }}
            >
              MetaMC
            </div>
          <div
            style={{
              fontSize: 10.5,
              color: 'var(--tx-muted)',
              letterSpacing: '.08em',
              textTransform: 'uppercase',
              marginTop: 1,
            }}
          >
            Console
          </div>
        </div>
      </div>

      <button type="button" className="search-trigger" onClick={onOpenPalette}>
        <Icon path={ICONS.search} size={15} />
        <span>Cerca moduli</span>
        <span className="kbd" style={{ marginLeft: 'auto' }}>
          ⌘K
        </span>
      </button>

      {groups.map(([area, items]) => (
        <div key={area}>
          <div className="t-group" style={{ padding: '0 8px', marginBottom: 8 }}>
            {area}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {items.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className="nav-item"
                data-active={pathname.startsWith(item.to)}
              >
                <Icon path={item.icon} />
                <span className="nav-label">{item.label}</span>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </aside>
  );
}

// ---------------------------------------------------------------------------

export type Command = { id: string; label: string; hint?: string; run: () => void };

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

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(7,18,25,.72)',
        backdropFilter: 'blur(2px)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '12vh',
        zIndex: 50,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Comandi"
        className="elevated"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(560px, 92vw)', overflow: 'hidden' }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '0 14px',
            height: 48,
            borderBottom: '1px solid var(--bd-subtle)',
            color: 'var(--tx-muted)',
          }}
        >
          <Icon path={ICONS.search} size={16} />
          <input
            ref={inputRef}
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
              }
            }}
            style={{
              flex: 1,
              border: 0,
              background: 'transparent',
              color: 'var(--tx-primary)',
              fontFamily: 'var(--font-ui)',
              fontSize: 14,
              outline: 'none',
            }}
          />
          <span className="kbd">esc</span>
        </div>

        <ul style={{ listStyle: 'none', margin: 0, padding: 8, maxHeight: '48vh', overflowY: 'auto' }}>
          {filtered.length === 0 ? (
            <li className="t-lead" style={{ padding: 16 }}>
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
                    gap: 16,
                    padding: '9px 10px',
                    border: 0,
                    borderRadius: 'var(--r-sm)',
                    background: i === index ? 'var(--ac-soft)' : 'transparent',
                    color: i === index ? 'var(--ac-text)' : 'var(--tx-primary)',
                    fontFamily: 'var(--font-ui)',
                    fontSize: 13,
                    fontWeight: 500,
                    textAlign: 'left',
                    cursor: 'pointer',
                  }}
                >
                  <span>{c.label}</span>
                  {c.hint ? <span style={{ fontSize: 12, color: 'var(--tx-muted)' }}>{c.hint}</span> : null}
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

/** Il quadrato da 32px della topbar: campanella e comando della sidebar. */
const SQUARE_CONTROL = {
  width: 32,
  height: 32,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: '1px solid var(--bd-subtle)',
  borderRadius: 'var(--r-sm)',
  background: 'var(--s-inset)',
  color: 'var(--tx-secondary)',
  cursor: 'pointer',
  flex: 'none',
} as const;

export function Topbar({
  me,
  breadcrumb,
  onLogout,
  feedDisconnected,
}: {
  me: Me;
  breadcrumb: string;
  onLogout: () => void;
  feedDisconnected: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 20,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        height: 56,
        padding: '0 20px',
        background: 'rgba(14,31,40,.9)',
        backdropFilter: 'blur(12px)',
        borderBottom: '1px solid var(--bd-subtle)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 13,
          color: 'var(--tx-muted)',
          minWidth: 0,
        }}
      >
        <span>Console</span>
        <Icon path={ICONS.chevron} size={13} />
        <span style={{ color: 'var(--tx-primary)', fontWeight: 600, whiteSpace: 'nowrap' }}>
          {breadcrumb}
        </span>
      </div>

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
        {/* Il prototipo mette la campanella in un quadrato da 32px con un
            contatore. Il contatore qui non c'è: non abbiamo notifiche, e un
            "3" finto sarebbe l'unica cosa dell'interfaccia che mente. Al suo
            posto il quadrato porta il solo segnale che abbiamo davvero, cioè
            se il feed del registro è vivo. */}
        <div
          title={feedDisconnected ? 'Feed del registro disconnesso' : 'Feed del registro attivo'}
          style={{ ...SQUARE_CONTROL, position: 'relative', cursor: 'default' }}
        >
          <Icon path={ICONS.bell} size={16} />
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              top: -3,
              right: -3,
              width: 9,
              height: 9,
              borderRadius: 'var(--r-full)',
              border: '2px solid var(--s-surface)',
              background: feedDisconnected ? 'var(--warn)' : 'var(--ok)',
            }}
          />
        </div>

        <div style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            aria-expanded={menuOpen}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              height: 32,
              padding: '2px 10px 2px 2px',
              border: '1px solid var(--bd-subtle)',
              borderRadius: 'var(--r-full)',
              background: 'var(--s-inset)',
              color: 'var(--tx-primary)',
              fontFamily: 'var(--font-ui)',
              cursor: 'pointer',
            }}
          >
            <Avatar name={me.name} />
            <span style={{ fontSize: 12.5, fontWeight: 600 }}>{me.name}</span>
            <Icon path={ICONS.chevron} size={13} />
          </button>

          {menuOpen ? (
            <div
              className="elevated"
              style={{ position: 'absolute', top: 40, right: 0, zIndex: 50, width: 280, overflow: 'hidden' }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: 16,
                  borderBottom: '1px solid var(--bd-subtle)',
                }}
              >
                <Avatar name={me.name} size={40} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 600 }}>
                    {me.name}
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: 'var(--tx-muted)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {me.email}
                  </div>
                </div>
              </div>

              <div
                style={{
                  padding: '14px 16px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 9,
                  borderBottom: '1px solid var(--bd-subtle)',
                  fontSize: 12.5,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--tx-muted)' }}>Moduli</span>
                  <span>{me.modules.length}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--tx-muted)' }}>2FA</span>
                  <span style={{ color: 'var(--ok)' }}>Attiva</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--tx-muted)' }}>Ri-autenticazione</span>
                  <span className="mono">
                    {me.stepUpValidForSeconds > 0
                      ? `${Math.ceil(me.stepUpValidForSeconds / 60)} min`
                      : 'scaduta'}
                  </span>
                </div>
              </div>

              <div style={{ padding: 8 }}>
                <button
                  type="button"
                  onClick={onLogout}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    padding: '9px 10px',
                    border: 0,
                    borderRadius: 'var(--r-sm)',
                    background: 'transparent',
                    color: 'var(--err)',
                    fontFamily: 'var(--font-ui)',
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  Esci da tutti i dispositivi
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
