// Primitive dell'interfaccia, sulle metriche del prototipo.
//
// SEC-35 — nessun componente qui dentro accetta HTML. Tutto passa da nodi
// React, e `dangerouslySetInnerHTML` è vietato da una regola di CI che
// fallisce la build. Vale soprattutto per la tabella audit, che renderizza
// user agent e payload jsonb, cioè stringhe controllate da terzi.

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { useEffect, useState } from 'react';

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

/**
 * Iniziali per l'avatar, nello stile del prototipo (due lettere, mono).
 * In tabella e' un quadrato con raggio piccolo; altrove e' tondo.
 */
/**
 * Le stesse regole di Mojang: lettere, cifre e trattino basso, 3-16 caratteri.
 *
 * Il controllo e' qui e non solo sul server, e serve a non chiedere niente.
 * Una pagina del registro ha cinquanta righe, e attori come `anonimo` o
 * `sistema` non sono account Minecraft: senza questo, ogni ricarica
 * spedirebbe decine di richieste destinate a un 404.
 */
const MINECRAFT_NAME = /^[A-Za-z0-9_]{3,16}$/;

/**
 * La faccia del giocatore, ritagliata dalla skin.
 *
 * Il ritaglio lo fa il browser, non il server. Una skin e' un atlante 64x64
 * (o 64x32 nelle vecchie): la faccia sta ai pixel 8-15 su entrambi gli assi,
 * e il cappello ai pixel 40-47 in orizzontale. Ingrandendo l'immagine di otto
 * volte e spostandola, la finestra da `size` pixel inquadra esattamente la
 * faccia — senza libreria di immagini sul server e senza dipendere da un
 * servizio di rendering di terze parti.
 *
 * `height: auto` non e' pigrizia: forzare un quadrato schiaccerebbe le skin
 * 64x32, che sono ancora in giro. Con la larghezza sola, la scala resta la
 * stessa sui due assi e gli scarti valgono per entrambi i formati.
 *
 * Sotto restano sempre le iniziali colorate: si vedono mentre l'immagine
 * arriva, e restano se non arriva affatto.
 */
export function Avatar({
  name,
  size = 26,
  square = false,
  fontSize,
}: {
  name: string;
  size?: number;
  square?: boolean;
  /** Il prototipo non usa un rapporto fisso: 9px a 26, 8.5 a 22, 12 a 40. */
  fontSize?: number;
}) {
  const [failed, setFailed] = useState(false);

  // Due lettere sempre: nel prototipo `Vally90` da' `VA`, non `V`. I nomi
  // Minecraft sono una parola sola, quindi prendere l'iniziale di ogni parola
  // dava una lettera sola a quasi tutti.
  const initials = name.replace(/s+/g, '').slice(0, 2).toUpperCase();
  // Tinta stabile per persona: due utenti diversi non devono avere lo stesso
  // colore per caso, e lo stesso utente non deve cambiarlo a ogni render.
  // La tavolozza e' quella del prototipo (campo `skin` di metamc-shared.js).
  const hues = ['#8B5E34', '#2F6E8F', '#3E7C63', '#A8434F', '#6B5AA6'];
  const hue = hues[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % hues.length];

  const skin = !failed && MINECRAFT_NAME.test(name) ? `/api/avatars/${encodeURIComponent(name)}.png` : null;

  const layer = (left: number): React.CSSProperties => ({
    position: 'absolute',
    left: -left * size,
    top: -size,
    width: size * 8,
    height: 'auto',
    // La preflight di Tailwind mette `max-width: 100%` su ogni <img>. Qui
    // l'immagine DEVE debordare: e' larga otto volte la finestra, ed e' cosi'
    // che la finestra inquadra un solo riquadro. Senza questa riga la skin
    // viene schiacciata a `size` pixel e si vede un pixel e mezzo di faccia.
    maxWidth: 'none',
    imageRendering: 'pixelated',
  });

  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={{
        position: 'relative',
        overflow: 'hidden',
        width: size,
        height: size,
        background: hue,
        fontSize: fontSize ?? Math.round(size * 0.35 * 2) / 2,
        lineHeight: 1,
        ...(square ? { borderRadius: 'var(--r-xs)' } : {}),
      }}
    >
      {initials || '?'}
      {skin ? (
        <>
          {/* Stessa URL per i due strati: il browser fa una richiesta sola. */}
          <img src={skin} alt="" style={layer(1)} onError={() => setFailed(true)} />
          {/* Il cappello sopra la faccia. Nelle skin che non ce l'hanno e'
              trasparente, quindi non copre niente. */}
          <img src={skin} alt="" style={layer(5)} />
        </>
      ) : null}
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
export function Icon({
  path,
  size = 17,
  style,
}: {
  path: string;
  size?: number;
  /** Si SOMMA a `flex: none`, non lo sostituisce: senza, un'icona con uno
   *  stile suo tornerebbe a restringersi dentro un flex, e il difetto si
   *  vedrebbe solo nella barra più stretta. */
  style?: React.CSSProperties;
}) {
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
      style={{ flex: 'none', ...style }}
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

/**
 * I tracciati sono quelli di `frontend/metamc-shared.js` (oggetto `I`),
 * copiati carattere per carattere. Erano stati reinventati, ed e' la ragione
 * per cui la sidebar non somigliava: il registro aveva l'icona di un
 * documento invece dell'orologio, gli utenti un gruppo diverso.
 */
export const ICONS = {
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  modes: 'M4 20V11M9.3 20V4M14.7 20v-6M20 20v-9',
  report: 'M6 3h8l5 5v13H6zM14 3v5h5M9 13h7M9 17h5',
  users:
    'M16 20v-1.6a4 4 0 0 0-4-4H7.5a4 4 0 0 0-4 4V20M9.7 10.6a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2M17 10.5a3 3 0 1 0 0-6M20.5 20v-1.6a4 4 0 0 0-2.8-3.8',
  log: 'M12 7.5V12l3 1.8M21 12a9 9 0 1 1-9-9 9 9 0 0 1 9 9z',
  search: 'M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16zM21 21l-4.3-4.3',
  bell: 'M18.5 8.5a6.5 6.5 0 1 0-13 0c0 6.5-2.5 7.8-2.5 7.8h18s-2.5-1.3-2.5-7.8M13.8 20a2 2 0 0 1-3.6 0',
  chevron: 'M9 6l6 6-6 6',
  cal: 'M3.5 9h17M7.5 3.5v3.5M16.5 3.5v3.5M5 5.5h14v15H5z',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3.5 9h17M3.5 15h17M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z',
  shield: 'M12 21s7-3.2 7-9V5.6L12 3 5 5.6V12c0 5.8 7 9 7 9z',
  mail: 'M3 7h18v11H3zM3 7l9 6 9-6',
  // Il gruppo Duels, dai mockup: `I.trend`, `I.star` e `I.cfg` di
  // `frontend/metamc-shared.js`.
  trend: 'M3 17l5-7 4 4 9-11',
  star: 'M12 3.5l2.6 5.6 6 .8-4.4 4.2 1.1 6-5.3-3-5.3 3 1.1-6-4.4-4.2 6-.8z',
  cfg: 'M4.5 7h15M4.5 12h15M4.5 17h15M8 5v4M16 10v4M11 15v4',
} as const;

/**
 * La barra di robustezza: quattro segmenti, come nel disegno.
 *
 * Misura la LUNGHEZZA e lo dice. Il disegno scrive «minimo 12 caratteri, una
 * maiuscola, un numero», ma quelle regole di composizione non esistono in
 * questo pannello — il §8.6 chiede lunghezza e controllo HIBP, non simboli.
 * Copiare quella frase avrebbe voluto dire mettere in pagina una regola che
 * il server non applica, cioe' un'istruzione falsa.
 */
export function StrengthMeter({ password }: { password: string }) {
  const filled = [12, 16, 20, 24].filter((n) => password.length >= n).length;
  const label = ['Troppo corta', 'Sufficiente', 'Buona', 'Ottima', 'Ottima'][filled] ?? '';
  const color = filled === 0 ? 'var(--err)' : filled === 1 ? 'var(--warn)' : 'var(--ok)';
  return (
    <>
      <div style={{ display: 'flex', gap: 5, margin: '10px 0 8px' }}>
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            style={{
              flex: 1,
              height: 4,
              borderRadius: 2,
              background: i < filled ? color : 'var(--bd-subtle)',
            }}
          />
        ))}
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 11.5,
          color: 'var(--tx-muted)',
          marginBottom: 20,
        }}
      >
        <span>Robustezza · conta la lunghezza</span>
        <span style={{ color, fontWeight: 600 }}>{label}</span>
      </div>
    </>
  );
}

/**
 * Modale centrato da 460px, come il prototipo — non un drawer laterale.
 *
 * STAVA DENTRO `users.tsx`, privato, ed era uno di tre modali quasi uguali
 * sparsi per il pannello. Lo usa anche Maps, e con una copia in piu' la
 * differenza non l'avrebbe notata nessuno: uno con l'ombra, uno senza, uno che
 * non si chiude cliccando fuori.
 */
export function Modal({
  title,
  subtitle,
  width = 460,
  onClose,
  footer,
  children,
}: {
  title: string;
  subtitle?: string;
  width?: number;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  // ESC CHIUDE, e prima non lo faceva. Spostandolo qui la regola di
  // accessibilita' che i due file di prima tenevano spenta si e' riaccesa, e
  // aveva ragione: un riquadro che si chiude solo cliccando fuori non si
  // chiude affatto per chi sta usando la tastiera.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    // Il clic sullo sfondo e' una scorciatoia, non l'unico modo di chiudere:
    // ci sono il pulsante di chiusura e il tasto Esc qui sopra.
    // biome-ignore lint/a11y/noStaticElementInteractions: chiudere cliccando fuori non e' l'unico modo
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 80,
        background: 'rgba(4,10,14,.66)',
        backdropFilter: 'blur(3px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 40,
      }}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: ferma il clic, non e un comando */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        style={{
          width,
          maxWidth: '100%',
          maxHeight: '88vh',
          overflowY: 'auto',
          border: '1px solid var(--bd-strong)',
          borderRadius: 'var(--r-lg)',
          background: 'var(--s-elevated)',
          boxShadow: 'var(--e3)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 16,
            padding: '20px 22px 16px',
            borderBottom: '1px solid var(--bd-subtle)',
          }}
        >
          <div>
            <div
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 17,
                fontWeight: 700,
                letterSpacing: '-.01em',
              }}
            >
              {title}
            </div>
            {subtitle ? (
              <div style={{ fontSize: 12.5, color: 'var(--tx-muted)', marginTop: 4 }}>{subtitle}</div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Chiudi"
            style={{
              width: 28,
              height: 28,
              border: '1px solid var(--bd-subtle)',
              borderRadius: 'var(--r-sm)',
              background: 'transparent',
              color: 'var(--tx-muted)',
              cursor: 'pointer',
              fontSize: 14,
              lineHeight: 1,
              flex: 'none',
            }}
          >
            ×
          </button>
        </div>
        <div style={{ padding: '20px 22px' }}>{children}</div>
        {footer ? (
          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 8,
              padding: '16px 22px',
              borderTop: '1px solid var(--bd-subtle)',
              background: 'var(--s-inset)',
            }}
          >
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
