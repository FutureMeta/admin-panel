// App shell: sidebar, topbar, command palette. Metriche del prototipo.
//
// La sidebar mostra SOLO i moduli a cui l'utente ha accesso. Nessuna voce
// disabilitata, nessun lucchetto: l'elenco stesso dei moduli è informazione,
// e mostrarlo a chi non ci entra è ricognizione gratuita.

import { Link, useRouterState } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Me } from '../lib/api.ts';
import { canOpen } from '../lib/modules.ts';
import { NAV, type NavEntry } from '../lib/nav.ts';
import {
  COLLAPSED_KEY,
  chainOf,
  isActive,
  openChain,
  readCollapsed,
  safeStorage,
  toggleArea,
  writeCollapsed,
} from '../lib/nav-collapse.ts';
import { RANGES, useRange } from '../lib/range.ts';
import { loadWorld } from '../lib/world.ts';
import { Avatar, ICONS, Icon } from './ui.tsx';

/**
 * Icona e prefetch di ogni voce, per percorso.
 *
 * IL RESTO STA IN `lib/nav.ts`: percorsi, nomi, moduli e livelli sono dati, e
 * li leggono anche il breadcrumb, la palette e il selettore del periodo. Qui
 * resta solo ciò che è di questo componente — un tracciato SVG e una funzione
 * che anticipa un file — perché un file di dati che importasse dai componenti
 * sarebbe una libreria che dipende dal disegno, e non si potrebbe provare
 * senza montare React.
 */
const DECOR: Record<string, { icon: string; prefetch?: () => void }> = {
  // Il file dei contorni pesa 108 kB e serve a una schermata sola: scaricarlo
  // per tutti sarebbe uno spreco, scaricarlo all'apertura significa vedere il
  // riquadro vuoto per un istante. §8.9
  '/panoramica': { icon: ICONS.grid, prefetch: () => void loadWorld().catch(() => undefined) },
  '/dettaglio-modalita': { icon: ICONS.modes },
  '/duels/trends': { icon: ICONS.trend },
  '/duels/ratings': { icon: ICONS.star },
  '/duels/modes': { icon: ICONS.cfg },
  '/duels/maps': { icon: ICONS.grid },
  '/duels/live': { icon: ICONS.pulse },
  '/duels/config': { icon: ICONS.cfg },
  '/utenti': { icon: ICONS.users },
  '/registro': { icon: ICONS.log },
};

/**
 * Le voci che questa persona puo' aprire.
 *
 * La usa anche la palette ⌘K, o si otterrebbero due elenchi: e' gia'
 * successo, e la palette non nominava due schermate che esistevano da mesi.
 */
export function visibleNav(me: Me): NavEntry[] {
  return NAV.filter((n) => n.modules.some((m) => canOpen(me, m, n.minLevel ?? 1)));
}

/**
 * I sottogruppi di una categoria, nell'ordine in cui compaiono le voci.
 *
 * Non alfabetico di proposito: l'ordine di `NAV` e' una decisione presa
 * scrivendolo, e riordinare qui la scavalcherebbe senza che si veda.
 */
function subGroups(items: readonly NavEntry[]): Array<[string, NavEntry[]]> {
  const map = new Map<string, NavEntry[]>();
  for (const item of items) {
    if (item.group === undefined) continue;
    map.set(item.group, [...(map.get(item.group) ?? []), item]);
  }
  return [...map.entries()];
}

/** Una voce della barra. Identica ai due livelli: cambia solo il rientro. */
function NavLink({ item, pathname }: { item: NavEntry; pathname: string }) {
  const decor = DECOR[item.to];
  return (
    <Link
      to={item.to}
      className="nav-item"
      data-active={isActive(pathname, item.to)}
      onMouseEnter={decor?.prefetch}
      onFocus={decor?.prefetch}
    >
      <Icon path={decor?.icon ?? ICONS.grid} />
      <span className="nav-label">{item.label}</span>
    </Link>
  );
}

export function Sidebar({ me, onOpenPalette }: { me: Me; onOpenPalette: () => void }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Chi vede cosa lo decide il server: `me` porta i moduli e i livelli, e la
  // barra li disegna. La stessa `canOpen` la usano la palette e le guardie di
  // rotta, o si otterrebbero tre risposte alla stessa domanda.
  //
  // La dipendenza è `me` intero e non `me.modules`: adesso si guardano anche i
  // livelli, e una dipendenza più stretta di ciò che si legge è il modo in cui
  // una voce resta visibile dopo che il permesso è stato tolto.
  const groups = useMemo(() => {
    const visible = visibleNav(me);
    const map = new Map<string, NavEntry[]>();
    for (const item of visible) {
      const list = map.get(item.area) ?? [];
      list.push(item);
      map.set(item.area, list);
    }
    return [...map.entries()];
  }, [me]);

  // Il ricordo si legge UNA VOLTA, all'apertura: leggerlo a ogni disegno
  // significherebbe che una scheda aperta accanto sovrascrive quello che si
  // sta facendo in questa.
  //
  // E la categoria della pagina su cui si atterra si apre GIA' QUI, non
  // nell'effetto qui sotto: quell'effetto guarda i cambi di percorso, e al
  // primo disegno non ce n'è stato nessuno. Senza questa riga il caso più
  // comune — il link aperto da fuori, la scheda ripristinata il giorno dopo —
  // resterebbe l'unico non coperto, che è il modo in cui una correzione
  // sembra fatta e non lo è.
  const [collapsed, setCollapsed] = useState<Set<string>>(() =>
    openChain(readCollapsed(safeStorage()?.getItem(COLLAPSED_KEY) ?? null), chainOf(groups, pathname)),
  );
  useEffect(() => {
    safeStorage()?.setItem(COLLAPSED_KEY, writeCollapsed(collapsed));
  }, [collapsed]);

  // ARRIVARE su una pagina apre la sua categoria, se era chiusa: alla palette
  // ⌘K e ai link condivisi la barra non serve, e senza questo si finirebbe su
  // una schermata con nessuna voce evidenziata — cioè senza l'unica cosa che
  // dice dove ci si trova.
  //
  // Solo al CAMBIO di percorso: vedi `openChain`, chiuderla restando fermi deve
  // continuare a funzionare.
  const wasAt = useRef(pathname);
  useEffect(() => {
    if (wasAt.current === pathname) return;
    wasAt.current = pathname;
    setCollapsed((prev) => openChain(prev, chainOf(groups, pathname)));
  }, [pathname, groups]);

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

      {groups.map(([area, items]) => {
        const open = !collapsed.has(area);
        return (
          <div key={area}>
            <button
              type="button"
              className="nav-group"
              aria-expanded={open}
              aria-controls={`nav-${area}`}
              onClick={() => setCollapsed((prev) => toggleArea(prev, area))}
            >
              <span className="t-group">{area}</span>
              {/* La freccia PUNTA GIU' quando è aperta e a destra quando è
                  chiusa: è la direzione in cui sta il contenuto, ed è l'unica
                  cosa che distingue una categoria chiusa da una categoria
                  vuota. Senza, sparire e non avere voci si disegnano uguale. */}
              <Icon
                path={ICONS.chevron}
                size={13}
                style={{
                  marginLeft: 'auto',
                  transform: open ? 'rotate(90deg)' : 'none',
                  transition: 'transform var(--dur) var(--ease)',
                }}
              />
            </button>
            {open ? (
              <div id={`nav-${area}`} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {items
                  .filter((item) => item.group === undefined)
                  .map((item) => (
                    <NavLink key={item.to} item={item} pathname={pathname} />
                  ))}
                {/* I SOTTOGRUPPI, dopo le voci sciolte. La chiave del ricordo e'
                    `Area/Gruppo`: usa lo stesso insieme e lo stesso
                    `localStorage` delle categorie, quindi aprire e chiudere si
                    comporta allo stesso modo ai due livelli senza una seconda
                    macchina che fa la stessa cosa. */}
                {subGroups(items).map(([name, sub]) => {
                  const key = `${area}/${name}`;
                  const subOpen = !collapsed.has(key);
                  // L'id del DOM non è la chiave del ricordo: quella contiene
                  // una barra, e un id con dentro `/` diventa un selettore che
                  // non si può scrivere il giorno in cui serve.
                  const domId = `nav-${area}-${name}`;
                  return (
                    <div key={key}>
                      <button
                        type="button"
                        className="nav-item"
                        aria-expanded={subOpen}
                        aria-controls={domId}
                        onClick={() => setCollapsed((prev) => toggleArea(prev, key))}
                      >
                        <Icon path={ICONS.folder} />
                        <span className="nav-label">{name}</span>
                        <Icon
                          path={ICONS.chevron}
                          size={12}
                          style={{
                            marginLeft: 'auto',
                            transform: subOpen ? 'rotate(90deg)' : 'none',
                            transition: 'transform var(--dur) var(--ease)',
                          }}
                        />
                      </button>
                      {subOpen ? (
                        <div
                          id={domId}
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 2,
                            // Il rientro e' l'unica cosa che dice che queste
                            // voci stanno DENTRO il sottogruppo e non accanto.
                            paddingLeft: 14,
                          }}
                        >
                          {sub.map((item) => (
                            <NavLink key={item.to} item={item} pathname={pathname} />
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      })}
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
  showFilters,
}: {
  me: Me;
  breadcrumb: string;
  onLogout: () => void;
  feedDisconnected: boolean;
  /**
   * I pulsanti del periodo si mostrano solo dove hanno un effetto.
   *
   * Su «Utenti» e «Registro» non governano niente: lasciarli visibili sarebbe
   * peggio che toglierli, perche' un comando che non fa niente si prova una
   * volta e poi non ci si fida piu' nemmeno dove funziona.
   */
  showFilters: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { range, setRange } = useRange();

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

      {showFilters ? (
        <div
          style={{
            display: 'flex',
            gap: 2,
            marginLeft: 12,
            padding: 3,
            background: 'var(--s-inset)',
            border: '1px solid var(--bd-subtle)',
            borderRadius: 'var(--r-sm)',
          }}
        >
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => setRange(r.key)}
              aria-pressed={r.key === range}
              style={{
                border: 'none',
                borderRadius: 'var(--r-xs)',
                background: r.key === range ? 'var(--s-overlay)' : 'transparent',
                color: r.key === range ? 'var(--tx-primary)' : 'var(--tx-muted)',
                fontFamily: 'var(--font-ui)',
                fontSize: 12,
                fontWeight: 600,
                padding: '5px 10px',
                cursor: 'pointer',
                transition: 'all var(--dur) var(--ease)',
              }}
            >
              {r.label}
            </button>
          ))}
        </div>
      ) : null}

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
