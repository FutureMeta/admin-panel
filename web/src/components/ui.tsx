// Primitive dell'interfaccia.
//
// SEC-35 — nessun componente qui dentro accetta HTML. Tutto passa da nodi
// React, e `dangerouslySetInnerHTML` e' vietato da una regola di CI che
// fallisce la build. Vale soprattutto per la tabella audit, che renderizza
// user agent e payload jsonb, cioe' stringhe controllate da terzi.

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

// ---------------------------------------------------------------------------

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
};

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  disabled,
  children,
  className = '',
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
    <button type="button" className={classes} disabled={disabled || loading} aria-busy={loading} {...rest}>
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
        width: 14,
        height: 14,
        border: '2px solid currentColor',
        borderTopColor: 'transparent',
        borderRadius: '50%',
        display: 'inline-block',
        animation: 'spin 700ms linear infinite',
      }}
    />
  );
}

// ---------------------------------------------------------------------------

export type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  error?: string | undefined;
};

export function Field({ label, hint, error, id, className = '', ...rest }: FieldProps) {
  const inputId = id ?? `f-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div className="field">
      <label className="label" htmlFor={inputId}>
        {label}
      </label>
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

export type BadgeTone = 'ok' | 'warn' | 'err' | 'info' | 'neutral' | 'ac';

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

/** Stato dell'utente: una sola mappatura, usata ovunque. */
export function UserStatusBadge({ status, banned }: { status: string; banned: boolean }) {
  if (banned) return <Badge tone="err">bannato</Badge>;
  if (status === 'active') return <Badge tone="ok">attivo</Badge>;
  if (status === 'pending_onboarding') return <Badge tone="warn">in attesa</Badge>;
  return <Badge tone="neutral">disattivato</Badge>;
}

export function OutcomeBadge({ outcome }: { outcome: 'success' | 'failure' | 'denied' }) {
  if (outcome === 'success') return <Badge tone="ok">ok</Badge>;
  if (outcome === 'denied') return <Badge tone="err">negato</Badge>;
  return <Badge tone="warn">fallito</Badge>;
}

// ---------------------------------------------------------------------------

export function Card({
  title,
  subtitle,
  actions,
  children,
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="surface" style={{ padding: 'var(--sp5)' }}>
      {title ? (
        <header
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 'var(--sp4)',
            marginBottom: 'var(--sp4)',
          }}
        >
          <div>
            <h2 className="t-h2" style={{ margin: 0 }}>
              {title}
            </h2>
            {subtitle ? (
              <p className="t-sm" style={{ margin: '4px 0 0', color: 'var(--tx-muted)' }}>
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

/**
 * Stato vuoto. Non e' decorazione: uno stato vuoto senza spiegazione e' la
 * stessa cosa di un errore silenzioso per chi guarda.
 */
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
    <div style={{ padding: 'var(--sp12) var(--sp6)', textAlign: 'center' }}>
      <p className="t-h3" style={{ margin: 0 }}>
        {title}
      </p>
      <p className="t-sm" style={{ margin: 'var(--sp2) auto 0', maxWidth: 460, color: 'var(--tx-muted)' }}>
        {description}
      </p>
      {action ? <div style={{ marginTop: 'var(--sp5)' }}>{action}</div> : null}
    </div>
  );
}

export function Skeleton({ height = 20, width = '100%' }: { height?: number; width?: number | string }) {
  return <div className="skeleton" style={{ height, width }} aria-hidden="true" />;
}

export function SkeletonRows({ rows = 6 }: { rows?: number }) {
  return (
    <div
      style={{ display: 'grid', gap: 'var(--sp3)', padding: 'var(--sp4)' }}
      role="status"
      aria-label="caricamento"
    >
      {Array.from({ length: rows }, (_, i) => `riga-${i}`).map((id, i) => (
        <Skeleton key={id} height={16} width={`${60 + ((i * 13) % 40)}%`} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Banner non bloccante: usato per il feed disconnesso e la manutenzione. */
export function Banner({
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
  const bg = tone === 'err' ? 'var(--err-soft)' : tone === 'warn' ? 'var(--warn-soft)' : 'var(--info-soft)';
  const fg = tone === 'err' ? 'var(--err)' : tone === 'warn' ? 'var(--warn)' : 'var(--info)';
  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 'var(--sp4)',
        background: bg,
        border: `1px solid ${fg}`,
        borderRadius: 'var(--r-md)',
        padding: 'var(--sp3) var(--sp4)',
      }}
    >
      <div>
        <strong style={{ color: fg, font: '600 13px/20px var(--font-ui)' }}>{title}</strong>
        {description ? (
          <p className="t-sm" style={{ margin: '2px 0 0', color: 'var(--tx-secondary)' }}>
            {description}
          </p>
        ) : null}
      </div>
      {action}
    </div>
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
    <time className="tabular" dateTime={d.toISOString()} title={`${d.toISOString()} (UTC)`}>
      {formatted}
    </time>
  );
}

export function RelativeTime({ value }: { value: string | Date }) {
  const d = typeof value === 'string' ? new Date(value) : value;
  const diff = Math.round((d.getTime() - Date.now()) / 1000);
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat('it-IT', { numeric: 'auto' });
  const [value2, unit]: [number, Intl.RelativeTimeFormatUnit] =
    abs < 60
      ? [diff, 'second']
      : abs < 3600
        ? [Math.round(diff / 60), 'minute']
        : abs < 86400
          ? [Math.round(diff / 3600), 'hour']
          : [Math.round(diff / 86400), 'day'];
  return (
    <time dateTime={d.toISOString()} title={d.toISOString()}>
      {rtf.format(value2, unit)}
    </time>
  );
}
