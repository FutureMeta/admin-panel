// Impalcatura comune delle schermate del pannello.
//
// Nel prototipo ogni pagina ha la stessa forma: intestazione (titolo display
// 22/30 + sottoriga 12.5) e uno o più riquadri con bordo, raggio `r-lg` e
// fondo `--s-surface`, con una barra in testa e una in fondo. Tenerla in un
// posto solo evita che le tre schermate divergano di due pixel alla volta.

import type { ReactNode } from 'react';
import { ICONS, Icon } from './ui.tsx';

export function PageHeader({ title, sub, action }: { title: string; sub: string; action?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 20 }}>
      <div>
        <h2
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 22,
            lineHeight: '30px',
            fontWeight: 700,
            letterSpacing: '-.01em',
            margin: '0 0 5px',
          }}
        >
          {title}
        </h2>
        <div style={{ fontSize: 12.5, color: 'var(--tx-muted)' }}>{sub}</div>
      </div>
      {action}
    </div>
  );
}

export function Panel({ children }: { children: ReactNode }) {
  return (
    <section
      style={{
        border: '1px solid var(--bd-subtle)',
        borderRadius: 'var(--r-lg)',
        background: 'var(--s-surface)',
        overflow: 'hidden',
      }}
    >
      {children}
    </section>
  );
}

/** Barra in testa al riquadro: filtri a sinistra, conteggio a destra. */
export function PanelBar({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '12px 16px',
        borderBottom: '1px solid var(--bd-subtle)',
        flexWrap: 'wrap',
      }}
    >
      {children}
    </div>
  );
}

/** Barra in fondo: conteggio a sinistra, azioni a destra. */
export function PanelFooter({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        padding: '11px 16px',
        borderTop: '1px solid var(--bd-subtle)',
        fontSize: 12,
        color: 'var(--tx-muted)',
      }}
    >
      {children}
    </div>
  );
}

/**
 * Campo di ricerca: lente più input, nella forma del prototipo (30px, `r-sm`,
 * fondo `--s-inset`, testo 12.5px).
 *
 * È UN componente per tutte le schermate, non uno per pagina: due barre che
 * fanno la stessa cosa e si disegnano da sole finiscono per differire — una
 * con la lente e una senza, che è esattamente com'era.
 *
 * L'anello di fuoco sta sul riquadro, non sull'input: la classe `.searchbox`
 * lo disegna con `:focus-within` e zittisce quello interno. Senza, l'alone
 * arancione compariva DENTRO il bordo invece che attorno.
 */
export function SearchBox({
  value,
  onChange,
  placeholder,
  label,
  width = 230,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  label: string;
  width?: number;
}) {
  return (
    <div className="searchbox" style={{ maxWidth: width }}>
      <Icon path={ICONS.search} size={14} />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
      />
    </div>
  );
}

/** Menu a tendina nella forma delle pastiglie del registro: 30px, trasparente. */
export function FilterSelect({
  value,
  onChange,
  label,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <span className="filter-select">
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{label}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon path="m6 9 6 6 6-6" size={12} />
    </span>
  );
}

/** Chip compatto da tabella: 22px, `r-xs`, 11.5px. */
export function Chip({
  tone = 'neutral',
  dot = false,
  children,
}: {
  tone?: 'ok' | 'warn' | 'err' | 'ac' | 'info' | 'neutral';
  dot?: boolean;
  children: ReactNode;
}) {
  const map = {
    ok: ['var(--ok-soft)', 'var(--ok)'],
    warn: ['var(--warn-soft)', 'var(--warn)'],
    err: ['var(--err-soft)', 'var(--err)'],
    ac: ['var(--ac-soft)', 'var(--ac-text)'],
    info: ['var(--info-soft)', 'var(--info)'],
    neutral: ['var(--s-inset)', 'var(--tx-secondary)'],
  } as const;
  const [bg, fg] = map[tone];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 22,
        padding: '0 9px',
        borderRadius: 'var(--r-xs)',
        background: bg,
        color: fg,
        fontSize: 11.5,
        fontWeight: 500,
        whiteSpace: 'nowrap',
      }}
    >
      {dot ? <span style={{ width: 5, height: 5, borderRadius: '50%', background: fg }} /> : null}
      {children}
    </span>
  );
}

/** Le etichette sono quelle del prototipo: «Attivo», «Invito in attesa». */
export function StatusChip({ status, banned }: { status: string; banned: boolean }) {
  if (banned)
    return (
      <Chip tone="err" dot>
        Bannato
      </Chip>
    );
  if (status === 'active')
    return (
      <Chip tone="ok" dot>
        Attivo
      </Chip>
    );
  if (status === 'pending_onboarding')
    return (
      <Chip tone="info" dot>
        Invito in attesa
      </Chip>
    );
  return (
    <Chip tone="neutral" dot>
      Disattivato
    </Chip>
  );
}

/** «Tutti i moduli» quando li ha tutti, «N moduli» altrimenti. */
export function moduleCountLabel(count: number, total: number): string {
  if (count >= total) return 'Tutti i moduli';
  if (count === 0) return 'nessun modulo';
  return `${count} moduli`;
}

/**
 * «oggi, 23:04», «ieri, 03:27», poi la data intera. È il formato del
 * prototipo, e per una colonna che si legge di sfuggita è quello giusto: chi
 * guarda vuole sapere se una persona c'era stamattina, non in che anno.
 */
export function lastSeenLabel(value: string | null): string {
  if (!value) return 'mai';
  const d = new Date(value);
  const time = new Intl.DateTimeFormat('it-IT', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Rome',
  }).format(d);
  const day = (x: Date) =>
    new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', dateStyle: 'short' }).format(x);
  const today = day(new Date());
  const yesterday = day(new Date(Date.now() - 86_400_000));
  const it = day(d);
  if (it === today) return `oggi, ${time}`;
  if (it === yesterday) return `ieri, ${time}`;
  return `${it}, ${time}`;
}
