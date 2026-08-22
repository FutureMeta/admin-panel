// App shell: sidebar, topbar, command palette. Metriche del prototipo.
//
// La sidebar mostra SOLO i moduli a cui l'utente ha accesso. Nessuna voce
// disabilitata, nessun lucchetto: l'elenco stesso dei moduli è informazione,
// e mostrarlo a chi non ci entra è ricognizione gratuita.

import { Link, useRouterState } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Me, ModuleKey } from '../lib/api.ts';
import { RANGES, useRange } from '../lib/range.ts';
import { loadWorld } from '../lib/world.ts';
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
type NavItem = {
  modules: ModuleKey[];
  label: string;
  to: string;
  area: string;
  icon: string;
  /**
   * Da chiamare al passaggio del mouse. §8.9
   *
   * Il file dei contorni pesa 108 kB e serve a una schermata sola: scaricarlo
   * per tutti sarebbe uno spreco, scaricarlo all'apertura significa vedere il
   * riquadro vuoto per un istante. Anticiparlo al passaggio del mouse toglie
   * la latenza senza costare un byte a chi quella schermata non la apre mai.
   */
  prefetch?: () => void;
};

const NAV: NavItem[] = [
  // L'ordine di questo array E' l'ordine della barra: i gruppi si formano
  // nell'ordine in cui compaiono le voci. «Analisi» sta sopra, come nel
  // design — e' la ragione per cui il pannello esiste, l'amministrazione e'
  // cio' che serve per farlo funzionare.
  //
  // I nomi vengono da `frontend/support.js`, che porta i dati veri dietro i
  // segnaposto dei mockup: area «Analisi», voci «Panoramica network» e
  // «Dettaglio modalita'».
  {
    modules: ['statistiche'],
    label: 'Panoramica network',
    to: '/panoramica',
    area: 'Analisi',
    icon: ICONS.grid,
    prefetch: () => void loadWorld().catch(() => undefined),
  },
  // Porta all'INGRESSO, non a una modalità fissata: la rotta risolve la più
  // popolata in questo momento e rimanda lì. Una chiave scritta qui sarebbe
  // quella giusta il primo giorno e quella sbagliata tutti gli altri.
  //
  // E' UNA VOCE SOLA perché la schermata è una sola. Il dizionario — creare
  // una modalità, cambiarne nome, colore e regole — stava su una schermata sua
  // accanto a questa, e chiedeva di uscire dai grafici per andare a cambiare
  // ciò che i grafici mostrano. Adesso i due pulsanti stanno nell'intestazione
  // del dettaglio, come nel mockup, e si modifica la modalità mentre la si
  // guarda.
  {
    modules: ['statistiche'],
    label: 'Dettaglio modalità',
    to: '/dettaglio-modalita',
    area: 'Analisi',
    icon: ICONS.modes,
  },
  // Il gruppo «Duels» sta fra Analisi e Amministrazione, come nei mockup.
  //
  // Il MODULO E' `duels`, non `statistiche`: sono due permessi distinti perché
  // sono due domande distinte su chi può vedere cosa. Chi ha le statistiche
  // del network non ha per questo il diritto di guardare le partite dei duels.
  {
    modules: ['duels'],
    label: 'Trends',
    to: '/duels/trends',
    area: 'Duels',
    icon: ICONS.trend,
  },
  // `duels_feedback` e non `duels`: qui ci sono i nomi dei giocatori e il
  // testo che hanno scritto loro, ed è una domanda diversa su chi può vederli.
  {
    modules: ['duels_feedback'],
    label: 'Ratings',
    to: '/duels/ratings',
    area: 'Duels',
    icon: ICONS.star,
  },
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
                onMouseEnter={item.prefetch}
                onFocus={item.prefetch}
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
