// Impalcatura comune delle schermate del pannello.
//
// Nel prototipo ogni pagina ha la stessa forma: intestazione (titolo display
// 22/30 + sottoriga 12.5) e uno o più riquadri con bordo, raggio `r-lg` e
// fondo `--s-surface`, con una barra in testa e una in fondo. Tenerla in un
// posto solo evita che le tre schermate divergano di due pixel alla volta.

import type { ReactNode } from 'react';
import { Button, EmptyState, ICONS, Icon, Notice, SkeletonRows } from './ui.tsx';

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

/**
 * Menu a tendina nella forma delle pastiglie del registro: 30px, fondo
 * trasparente, freccia subito dopo il testo.
 *
 * La pastiglia visibile è uno `span`, e la `select` vera ci sta sopra
 * trasparente. Il motivo è di misura, non di gusto: una `select` nativa si
 * dimensiona sull'opzione PIÙ LUNGA, non sul valore mostrato — per «Tutti i
 * moduli» veniva larga 132px contro i 116.4 del disegno, e quei sedici pixel
 * di vuoto dopo il testo facevano sembrare l'etichetta e la freccia spostate
 * a destra. Così la pastiglia si stringe sul contenuto come nel prototipo, e
 * il menu resta quello del sistema operativo: nessuna tendina reimplementata,
 * nessuna tastiera da rifare.
 */
/**
 * La tendina a pastiglia.
 *
 * `emptyLabel` distingue i due usi, e non e' un dettaglio di stile. Un FILTRO
 * ha uno stato «nessun filtro», e quella voce va nella lista: «Tutti i
 * moduli». Un SELETTORE — quale ruolo sto modificando — non ce l'ha: qualcosa
 * e' sempre scelto, e offrire una voce vuota significa offrire di scegliere il
 * nulla. Prima la stessa stringa faceva da etichetta accessibile e da voce
 * vuota, per cui il selettore del ruolo mostrava «Ruolo da modificare» fra le
 * opzioni e sceglierla passava `Number('')`, cioe' `NaN`, come id.
 *
 * Quindi: `label` e' solo il nome per chi usa uno screen reader, e la voce
 * vuota esiste soltanto se qualcuno la chiede.
 */
export function FilterSelect({
  value,
  onChange,
  label,
  emptyLabel,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  emptyLabel?: string;
  options: Array<{ value: string; label: string }>;
}) {
  const current = options.find((o) => o.value === value)?.label ?? emptyLabel ?? label;
  return (
    <span className="filter-select">
      <span className="filter-select-face" aria-hidden="true">
        {current}
        <Icon path="m6 9 6 6 6-6" size={12} />
      </span>
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        {emptyLabel ? <option value="">{emptyLabel}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}

/**
 * Tendina a piena larghezza dentro un modulo: la forma del campo «Ruolo»
 * della finestra d'invito nel prototipo — 38px, fondo `--s-inset`, testo a
 * sinistra e freccia sul bordo destro.
 *
 * Qui la larghezza la decide il contenitore, non l'opzione più lunga, quindi
 * la `select` nativa va bene com'è: serve solo spegnere la freccia del
 * sistema operativo e disegnare la nostra. Il caso della pastiglia è diverso
 * ed è trattato in `FilterSelect`.
 */
export function SelectField({
  label,
  value,
  onChange,
  hint,
  required = false,
  placeholder,
  options,
  id,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  required?: boolean;
  placeholder?: string;
  options: Array<{ value: string; label: string }>;
  id?: string;
}) {
  const fieldId = id ?? `s-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div className="field">
      <label className="label" htmlFor={fieldId}>
        {label}
      </label>
      <span className="select-field">
        <select
          id={fieldId}
          className="input"
          required={required}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          {placeholder ? (
            <option value="" disabled>
              {placeholder}
            </option>
          ) : null}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <Icon path="m6 9 6 6 6-6" size={13} />
      </span>
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
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

/**
 * Una freccia del piede. Spenta quando non c'è dove andare, non nascosta: la
 * posizione del controllo non deve saltare.
 *
 * NASCE NEL REGISTRO ATTIVITÀ e adesso vive qui. Utenti aveva le stesse due
 * frecce ridisegnate a mano come `<span aria-hidden>` — stessa geometria,
 * stessi token, e **nessun click possibile**: due controlli che sembravano
 * uguali, uno funzionante e uno finto.
 */
export function PageArrow({
  glyph,
  label,
  disabled,
  onClick,
}: {
  glyph: string;
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      style={{
        width: 26,
        height: 26,
        border: '1px solid var(--bd-subtle)',
        borderRadius: 'var(--r-sm)',
        background: 'transparent',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: disabled ? 'var(--tx-disabled)' : 'var(--tx-secondary)',
        cursor: disabled ? 'default' : 'pointer',
        font: 'inherit',
        lineHeight: 1,
      }}
    >
      {glyph}
    </button>
  );
}

/**
 * I QUATTRO STATI di una tabella, in un posto solo: caricamento, errore,
 * vuoto, dati.
 *
 * Ogni schermata li riscriveva. Non erano ancora divergenti nella sostanza, ma
 * lo erano già nella forma — chi mostrava un riquadro d'errore con «Riprova» e
 * chi una riga di testo grigio, chi il ritorno a capo orizzontale e chi no — e
 * il quarto stato è quello che si dimentica: una tabella senza stato vuoto
 * disegna un'intestazione e basta, che si legge come «sta ancora caricando».
 *
 * La tabella vera la disegna chi chiama, perché le colonne sono sue. Questo
 * componente possiede solo la macchina a stati e il ritorno a capo.
 */
export function TableStates({
  pending,
  error,
  empty,
  errorTitle,
  emptyTitle,
  emptyDescription,
  onRetry,
  rows = 10,
  children,
}: {
  pending: boolean;
  error: boolean;
  empty: boolean;
  errorTitle: string;
  emptyTitle: string;
  emptyDescription: string;
  onRetry: () => void;
  rows?: number;
  children: ReactNode;
}) {
  if (pending) return <SkeletonRows rows={rows} />;
  if (error) {
    return (
      <div style={{ padding: 16 }}>
        <Notice
          tone="err"
          title={errorTitle}
          action={
            <Button size="sm" onClick={onRetry}>
              Riprova
            </Button>
          }
        />
      </div>
    );
  }
  if (empty) return <EmptyState title={emptyTitle} description={emptyDescription} />;
  // Il ritorno a capo orizzontale sta QUI e non nelle singole schermate: una
  // tabella che sfora e non scorre taglia le colonne di destra su uno schermo
  // stretto, e non c'è modo di accorgersene su uno largo.
  return <div style={{ overflowX: 'auto' }}>{children}</div>;
}
