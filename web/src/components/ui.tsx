// Primitive dell'interfaccia, sulle metriche del prototipo.
//
// SEC-35 — nessun componente qui dentro accetta HTML. Tutto passa da nodi
// React, e `dangerouslySetInnerHTML` è vietato da una regola di CI che
// fallisce la build. Vale soprattutto per la tabella audit, che renderizza
// user agent e payload jsonb, cioè stringhe controllate da terzi.

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

// ---------------------------------------------------------------------------

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  block?: boolean;
};

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  block = false,
  disabled,
  children,
  className = '',
  style,
  ...rest
}: ButtonProps) {
  const classes = [
    'btn',
    `btn-${variant}`,
    size === 'sm' ? 'btn-sm' : size === 'lg' ? 'btn-lg' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading}
      style={block ? { width: '100%', ...style } : style}
      {...rest}
    >
      {loading ? <Spinner /> : null}
      {children}
    </button>
  );
}

export function Spinner() {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 13,
        height: 13,
        border: '2px solid currentColor',
        borderTopColor: 'transparent',
        borderRadius: '50%',
        display: 'inline-block',
        animation: 'mmSpin 700ms linear infinite',
      }}
    />
  );
}

// ---------------------------------------------------------------------------

export type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  error?: string | undefined;
  /** Nodo mostrato a destra dell'etichetta: nel prototipo è "Password dimenticata?". */
  aside?: ReactNode;
};

export function Field({ label, hint, error, aside, id, className = '', ...rest }: FieldProps) {
  const inputId = id ?? `f-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div className="field">
      {aside ? (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 7,
          }}
        >
          <label className="label" htmlFor={inputId} style={{ marginBottom: 0 }}>
            {label}
          </label>
          {aside}
        </div>
      ) : (
        <label className="label" htmlFor={inputId}>
          {label}
        </label>
      )}
      <input
        id={inputId}
        className={`input ${className}`}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={error ? `${inputId}-err` : hint ? `${inputId}-hint` : undefined}
        {...rest}
      />
      {error ? (
        <span className="error-text" id={`${inputId}-err`} role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="hint" id={`${inputId}-hint`}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

export type Tone = 'ok' | 'warn' | 'err' | 'info' | 'neutral' | 'ac';

export function Pill({
  tone = 'neutral',
  dot = false,
  children,
}: {
  tone?: Tone;
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={`pill pill-${tone}`}>
      {dot ? <span className="pill-dot" /> : null}
      {children}
    </span>
  );
}

/** Alias storico: nel resto del pannello il componente si chiama Badge. */
export const Badge = Pill;

export function UserStatusBadge({ status, banned }: { status: string; banned: boolean }) {
  if (banned)
    return (
      <Pill tone="err" dot>
        bannato
      </Pill>
    );
  if (status === 'active')
    return (
      <Pill tone="ok" dot>
        attivo
      </Pill>
    );
  if (status === 'pending_onboarding')
    return (
      <Pill tone="warn" dot>
        in attesa
      </Pill>
    );
  return (
    <Pill tone="neutral" dot>
      disattivato
    </Pill>
  );
}

export function OutcomeBadge({ outcome }: { outcome: 'success' | 'failure' | 'denied' }) {
  if (outcome === 'success') return <Pill tone="ok">ok</Pill>;
  if (outcome === 'denied') return <Pill tone="err">negato</Pill>;
  return <Pill tone="warn">fallito</Pill>;
}

// ---------------------------------------------------------------------------

/** Avviso in linea, nella forma del prototipo: pallino, titolo, riga di dettaglio. */
export function Notice({
  tone,
  title,
  description,
  action,
}: {
  tone: 'warn' | 'err' | 'info';
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className={`notice notice-${tone}`} role="status">
      <span className="notice-dot" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="notice-title">{title}</div>
        {description ? <div className="notice-body">{description}</div> : null}
      </div>
      {action}
    </div>
  );
}

/** Alias storico. */
export const Banner = Notice;

// ---------------------------------------------------------------------------

export function Card({
  title,
  subtitle,
  actions,
  padded = true,
  children,
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  padded?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="surface" style={{ padding: padded ? 20 : 0, overflow: 'hidden' }}>
      {title ? (
        <header
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 16,
            marginBottom: 16,
            padding: padded ? 0 : '18px 20px 0',
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 700 }}>
              {title}
            </h2>
            {subtitle ? (
              <p className="t-lead" style={{ margin: '5px 0 0', maxWidth: 620 }}>
                {subtitle}
              </p>
            ) : null}
          </div>
          {actions}
        </header>
      ) : null}
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div style={{ padding: '48px 24px', textAlign: 'center' }}>
      <p style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 600 }}>{title}</p>
      <p className="t-lead" style={{ margin: '8px auto 0', maxWidth: 460 }}>
        {description}
      </p>
      {action ? <div style={{ marginTop: 20 }}>{action}</div> : null}
    </div>
  );
}

export function Skeleton({ height = 16, width = '100%' }: { height?: number; width?: number | string }) {
  return <div className="skeleton" style={{ height, width }} aria-hidden="true" />;
}

export function SkeletonRows({ rows = 6 }: { rows?: number }) {
  return (
    <div style={{ display: 'grid', gap: 12, padding: 16 }} role="status" aria-label="caricamento">
      {Array.from({ length: rows }, (_, i) => `riga-${i}`).map((id, i) => (
        <Skeleton key={id} height={14} width={`${58 + ((i * 13) % 40)}%`} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Iniziali per l'avatar, nello stile del prototipo (due lettere, mono). */
export function Avatar({ name, size = 26 }: { name: string; size?: number }) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0] ?? '')
    .join('')
    .toUpperCase();
  // Tinta stabile per persona: due utenti diversi non devono avere lo stesso
  // colore per caso, e lo stesso utente non deve cambiarlo a ogni render.
  const hues = ['#8B5E34', '#2478A1', '#57B8A6', '#B85A12', '#4B5F6B'];
  const hue = hues[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % hues.length];
  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={{ width: size, height: size, background: hue, fontSize: size * 0.38 }}
    >
      {initials || '?'}
    </span>
  );
}

// ---------------------------------------------------------------------------

/** Data e ora in italiano, fuso Europe/Rome, sempre dichiarato. */
export function DateTime({ value, seconds = false }: { value: string | Date; seconds?: boolean }) {
  const d = typeof value === 'string' ? new Date(value) : value;
  const formatted = new Intl.DateTimeFormat('it-IT', {
    dateStyle: 'short',
    timeStyle: seconds ? 'medium' : 'short',
    timeZone: 'Europe/Rome',
  }).format(d);
  return (
    <time className="mono" dateTime={d.toISOString()} title={`${d.toISOString()} (UTC)`}>
      {formatted}
    </time>
  );
}

export function RelativeTime({ value }: { value: string | Date }) {
  const d = typeof value === 'string' ? new Date(value) : value;
  const diff = Math.round((d.getTime() - Date.now()) / 1000);
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat('it-IT', { numeric: 'auto' });
  const [amount, unit]: [number, Intl.RelativeTimeFormatUnit] =
    abs < 60
      ? [diff, 'second']
      : abs < 3600
        ? [Math.round(diff / 60), 'minute']
        : abs < 86400
          ? [Math.round(diff / 3600), 'hour']
          : [Math.round(diff / 86400), 'day'];
  return (
    <time dateTime={d.toISOString()} title={d.toISOString()}>
      {rtf.format(amount, unit)}
    </time>
  );
}

// ---------------------------------------------------------------------------

/** Icone lineari 1.5px, un solo set in tutta l'app. */
export function Icon({ path, size = 17 }: { path: string; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flex: 'none' }}
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

export const ICONS = {
  users: 'M16 19v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6m13 10v-2a4 4 0 0 0-3-3.9',
  shield: 'M12 3 4 6v6c0 4.4 3.4 8.5 8 9.5 4.6-1 8-5.1 8-9.5V6z',
  mail: 'M3 7h18v11H3zM3 7l9 6 9-6',
  log: 'M5 4h11l4 4v12H5zM8 12h8M8 16h5',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16m10 2-4.3-4.3',
  chevron: 'm9 6 6 6-6 6',
  bell: 'M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8M13.7 21a2 2 0 0 1-3.4 0',
} as const;
