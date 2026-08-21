// L'intestazione del dettaglio: il nome della modalità È il selettore.
//
// PRIMA ERA UNA BARRA DI SCHEDE, una per modalità, in alto a destra. Con tre
// modalità funzionava; su questa rete sono di più e andavano a capo, e una
// barra che cambia altezza sposta tutta la pagina sotto di sé. Il menù occupa
// lo spazio di una riga qualunque sia il numero di voci, e mette la scelta
// dove la si cerca — sul nome di quello che si sta guardando.
//
// PERCHÉ IL TITOLO E IL PULSANTE SONO LA STESSA COSA. Un titolo accanto a un
// controllo separato costringe a spiegare quale dei due comanda. Qui l'`h2`
// contiene il pulsante: chi legge il nome ha già la mano sul selettore, e chi
// usa uno screen reader trova un'intestazione con dentro un controllo
// dichiarato, non due elementi da correlare.

import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { navigableModes } from '../lib/busiest.ts';
import { ICONS, Icon } from './ui.tsx';

export function ModePicker({
  mode,
  labels,
  colorOf,
}: {
  mode: string;
  labels: Record<string, string>;
  colorOf: (m: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  // Si chiude con Escape e cliccando fuori. Sono le due uscite che chi usa un
  // menù prova senza pensarci: senza, l'unico modo di richiuderlo è ricliccare
  // esattamente sul nome, e un pannello che resta aperto sopra i grafici è
  // peggio di uno che non si apre.
  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };

    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  const modes = navigableModes(labels);

  return (
    <div ref={box} style={{ position: 'relative' }}>
      <h2 style={{ margin: 0 }}>
        <button
          ref={trigger}
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={`Modalità: ${labels[mode] ?? mode}. Cambia modalità`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            margin: '-4px -8px',
            padding: '4px 8px',
            border: '1px solid transparent',
            borderRadius: 'var(--r-sm)',
            background: open ? 'var(--s-inset)' : 'transparent',
            borderColor: open ? 'var(--bd-subtle)' : 'transparent',
            color: 'var(--tx-primary)',
            fontFamily: 'var(--font-display)',
            fontSize: 22,
            lineHeight: '30px',
            fontWeight: 700,
            letterSpacing: '-.01em',
            cursor: 'pointer',
            transition: 'background var(--dur) var(--ease), border-color var(--dur) var(--ease)',
          }}
        >
          <span style={{ width: 11, height: 11, borderRadius: 3, background: colorOf(mode), flex: 'none' }} />
          {labels[mode] ?? mode}
          <span
            aria-hidden="true"
            style={{
              display: 'flex',
              color: 'var(--tx-muted)',
              transform: `rotate(${open ? -90 : 90}deg)`,
              transition: 'transform var(--dur) var(--ease)',
            }}
          >
            <Icon path={ICONS.chevron} size={16} />
          </span>
        </button>
      </h2>

      {open ? (
        <div
          className="elevated"
          role="menu"
          aria-label="Modalità"
          style={{
            position: 'absolute',
            top: 42,
            left: 0,
            zIndex: 50,
            minWidth: 240,
            // Con molte modalità il menù scorre invece di uscire dallo
            // schermo: l'ultima voce deve restare raggiungibile anche su un
            // portatile, dove l'intestazione è già a metà pagina.
            maxHeight: '60vh',
            overflowY: 'auto',
            padding: 4,
          }}
        >
          {modes.map((m) => (
            <Link
              key={m}
              to="/dettaglio-modalita/$key"
              params={{ key: m }}
              role="menuitem"
              className="menu-item"
              data-active={m === mode}
              onClick={() => setOpen(false)}
            >
              <span style={{ width: 9, height: 9, borderRadius: 2, background: colorOf(m), flex: 'none' }} />
              {labels[m] ?? m}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}
