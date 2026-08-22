// I pezzi che Modes e Maps hanno in comune.
//
// LE MISURE VENGONO DAI MOCKUP, non da una loro interpretazione. La prima
// versione di questo file le aveva inventate: avevo letto
// `frontend/11-duels-configurazione.dc.html` e `12-duels-mappe.dc.html`
// TOGLIENDO gli attributi `style`, quindi avevo visto la struttura e non
// l'aspetto, e avevo riempito il buco con i componenti generici del pannello.
// Il risultato erano due schermate con la struttura giusta e tutto il resto
// diverso: pulsanti di un'altra forma, filtri che uscivano dal riquadro,
// etichette che il disegno non ha.
//
// Da cui la regola che questo file rispetta: ogni valore qui dentro si trova
// scritto in uno dei due mockup. Dove non c'e', non c'e' nemmeno qui.
//
// IL SALVA C'E' SOLO QUANDO C'E' QUALCOSA DA SALVARE, ed e' il disegno stesso a
// chiederlo: nel mockup quel pulsante porta `visibility:{{
// duelsMapSaveVisibility }}`. Un Salva sempre acceso non distingue «ho
// modificato» da «non ho toccato niente», e su una schermata dove tutto resta
// locale quella e' la sola domanda che ci si fa.

import type { CSSProperties, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { isOverride, type SettingSpec } from '../lib/config-draft.ts';
import { ICONS, Icon } from './ui.tsx';

/** Il testo su fondo accento, nei mockup. Non e' una variabile del tema. */
export const ON_ACCENT = '#160A02';

const ICON_CHEVRON_DOWN = 'm6 9 6 6 6-6';
export const ICON_PLUS = 'M12 5v14M5 12h14';
export const ICON_CHECK = 'm5 13 4 4 10-10';
const ICON_UNDO = 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5';

// ---------------------------------------------------------------------------
// Contenitori
// ---------------------------------------------------------------------------

/** Elenco a sinistra, dettaglio a destra: `360px 1fr`, gap 16. */
export function MasterDetail({ list, detail }: { list: ReactNode; detail: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '360px 1fr', gap: 16, alignItems: 'start' }}>
      {list}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>{detail}</div>
    </div>
  );
}

export function Section({ children, padded = false }: { children: ReactNode; padded?: boolean }) {
  return (
    <section
      style={{
        border: '1px solid var(--bd-subtle)',
        borderRadius: 'var(--r-lg)',
        background: 'var(--s-surface)',
        overflow: 'hidden',
        ...(padded ? { padding: 20 } : {}),
      }}
    >
      {children}
    </section>
  );
}

/** L'intestazione di una sezione: 16px 20px, titolo 16/600, riga sotto. */
export function SectionHead({ title, sub, action }: { title: string; sub: string; action?: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        padding: '16px 20px',
        borderBottom: '1px solid var(--bd-subtle)',
      }}
    >
      <div>
        <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 600, margin: '0 0 4px' }}>
          {title}
        </h3>
        <div style={{ fontSize: 12, color: 'var(--tx-muted)' }}>{sub}</div>
      </div>
      {action}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pulsanti, nelle forme che i mockup usano
// ---------------------------------------------------------------------------

type BtnProps = {
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  height?: number;
  style?: CSSProperties;
};

const base = (height: number): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  height,
  borderRadius: 'var(--r-sm)',
  fontFamily: 'var(--font-ui)',
  cursor: 'pointer',
  flex: 'none',
});

/**
 * Lato e corpo di un pulsante, per altezza.
 *
 * UNA TABELLA E NON UNA SOGLIA. Avevo scritto `height >= 28 ? 14 : 11` e mi
 * ero convinto che bastasse: nei mockup il lato non cresce con l'altezza in
 * modo regolare — 10 a 26, 11 a 28, 14 a 30 e a 32, 16 a 34 sul pulsante
 * accento della modale — e ogni soglia che si inventa sbaglia almeno una
 * misura. Sono i numeri del disegno, presi uno per uno.
 */
const SIDE: Record<number, { accent: number; quiet: number; font: number }> = {
  26: { accent: 10, quiet: 10, font: 11.5 },
  28: { accent: 11, quiet: 11, font: 12 },
  30: { accent: 14, quiet: 12, font: 12 },
  32: { accent: 14, quiet: 12, font: 12.5 },
  34: { accent: 16, quiet: 14, font: 13 },
};

const metrics = (height: number) => SIDE[height] ?? { accent: 14, quiet: 12, font: 12.5 };

/** Fondo accento, testo scuro: l'azione principale di un riquadro. */
export function AccentBtn({ onClick, children, disabled, height = 32, style }: BtnProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        ...base(height),
        padding: `0 ${metrics(height).accent}px`,
        border: '1px solid transparent',
        background: 'var(--ac)',
        color: ON_ACCENT,
        fontSize: metrics(height).font,
        fontWeight: 600,
        opacity: disabled ? 0.5 : 1,
        ...style,
      }}
    >
      {children}
    </button>
  );
}

/** Bordo netto su fondo rialzato: «Modifica». */
export function RaisedBtn({ onClick, children, disabled, height = 30 }: BtnProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        ...base(height),
        padding: `0 ${metrics(height).quiet}px`,
        border: '1px solid var(--bd-strong)',
        background: 'var(--s-elevated)',
        color: 'var(--tx-primary)',
        fontSize: metrics(height).font,
        fontWeight: 500,
      }}
    >
      {children}
    </button>
  );
}

/** Bordo sottile su fondo trasparente: «Annulla». */
export function QuietBtn({ onClick, children, disabled, height = 30 }: BtnProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        ...base(height),
        padding: `0 ${metrics(height).quiet}px`,
        border: '1px solid var(--bd-subtle)',
        background: 'transparent',
        color: 'var(--tx-secondary)',
        fontSize: metrics(height).font,
      }}
    >
      {children}
    </button>
  );
}

/** Rosso tenue con bordo rosso: «Elimina», «Rimuovi». */
export function DangerBtn({ onClick, children, disabled, height = 30 }: BtnProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        ...base(height),
        padding: `0 ${metrics(height).quiet}px`,
        border: '1px solid rgba(219,52,52,.4)',
        background: 'var(--err-soft)',
        color: 'var(--err)',
        fontSize: metrics(height).font,
        fontWeight: 600,
      }}
    >
      {children}
    </button>
  );
}

/** Rosso pieno: la sola conferma distruttiva. */
export function DangerSolidBtn({ onClick, children, disabled }: BtnProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        ...base(28),
        padding: '0 12px',
        border: 'none',
        background: 'var(--err)',
        color: '#fff',
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Ricerca e filtri, sulla stessa riga
// ---------------------------------------------------------------------------

/**
 * La casella di ricerca dei mockup: alta 32, `flex: 1`, `min-width: 0`.
 *
 * `min-width: 0` E' CIO' CHE LE PERMETTE DI STRINGERSI. Senza, un figlio flex
 * non scende sotto la larghezza del proprio contenuto: la casella teneva la
 * sua misura, i due filtri finivano oltre il bordo del riquadro, e il secondo
 * spariva sotto `overflow: hidden` — visibile solo quando il riquadro e'
 * stretto, cioe' sempre, perche' quella colonna e' larga 360.
 */
export function SearchField({
  value,
  onChange,
  placeholder,
  label,
  maxWidth,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  label: string;
  maxWidth?: number;
}) {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        height: 32,
        padding: '0 10px',
        border: '1px solid var(--bd-subtle)',
        borderRadius: 'var(--r-sm)',
        background: 'var(--s-inset)',
        color: 'var(--tx-muted)',
        minWidth: 0,
        ...(maxWidth ? { maxWidth } : {}),
      }}
    >
      <Icon path={ICONS.search} size={14} />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        style={{
          border: 'none',
          background: 'transparent',
          outline: 'none',
          color: 'var(--tx-primary)',
          fontFamily: 'var(--font-ui)',
          fontSize: 12.5,
          flex: 1,
          minWidth: 0,
        }}
      />
    </div>
  );
}

/**
 * Il filtro a tendina dei mockup: un pulsante da 32 e un pannello sotto.
 *
 * NON E' `FilterSelect`, la pastiglia usata nelle altre schermate: qui il
 * disegno vuole un pulsante con il fondo `--s-inset`, uguale a quello della
 * casella di ricerca che gli sta accanto, e un pannello proprio. Le due forme
 * convivono nel pannello perche' rispondono a due disegni diversi.
 */
export function MenuFilter({
  value,
  options,
  onChange,
  label,
  width = 130,
}: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
  label: string;
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);

  // Si chiude cliccando fuori e con Esc: un pannello che si chiude solo
  // riscegliendo una voce resta aperto sopra la lista che si vuole leggere.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = options.find((o) => o.value === value)?.label ?? label;

  return (
    <div ref={box} style={{ position: 'relative', flex: 'none' }}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          height: 32,
          padding: '0 9px',
          border: '1px solid var(--bd-subtle)',
          borderRadius: 'var(--r-sm)',
          background: 'var(--s-inset)',
          color: 'var(--tx-secondary)',
          fontFamily: 'var(--font-ui)',
          fontSize: 12,
          fontWeight: 500,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        {current}
        <Icon path={ICON_CHEVRON_DOWN} size={12} />
      </button>

      {open ? (
        <div
          style={{
            position: 'absolute',
            top: 38,
            right: 0,
            zIndex: 30,
            width,
            padding: 5,
            border: '1px solid var(--bd-strong)',
            borderRadius: 'var(--r-sm)',
            background: 'var(--s-overlay)',
            boxShadow: 'var(--e2)',
          }}
        >
          {options.map((option) => {
            const on = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '7px 9px',
                  border: 'none',
                  borderRadius: 'var(--r-xs)',
                  background: on ? 'var(--ac-soft)' : 'transparent',
                  color: on ? 'var(--ac-text)' : 'var(--tx-secondary)',
                  fontFamily: 'var(--font-ui)',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// L'elenco a sinistra
// ---------------------------------------------------------------------------

export type PickerRow = {
  id: number;
  title: string;
  name: string;
  /** Le due etichette a destra: tipo e ranking, oppure tipo e contesto. */
  tags: [string, string];
  /**
   * I colori delle due etichette. Nel disegno DUEL e FFA hanno colori
   * diversi, e RANKED si distingue da UNRANKED: senza, le due colonne sono
   * grigie uguali e tanto varrebbe non scriverle.
   */
  tagColors: [string, string];
  /** Le mappe disattivate si attenuano, come nel mockup. */
  dim?: boolean;
};

export function Picker({
  rows,
  selected,
  onSelect,
  empty,
  children,
}: {
  rows: PickerRow[];
  selected: number | null;
  onSelect: (id: number) => void;
  empty: string;
  /** Ricerca e filtri: `gap: 6`, una riga sola. */
  children: ReactNode;
}) {
  return (
    <Section>
      <div
        style={{
          padding: '12px 14px',
          borderBottom: '1px solid var(--bd-subtle)',
          display: 'flex',
          gap: 6,
        }}
      >
        {children}
      </div>
      <div style={{ maxHeight: 640, overflowY: 'auto' }}>
        {rows.length === 0 ? (
          <div style={{ padding: '18px 14px', fontSize: 12.5, color: 'var(--tx-muted)' }}>{empty}</div>
        ) : (
          rows.map((row) => {
            const on = row.id === selected;
            return (
              <button
                key={row.id}
                type="button"
                onClick={() => onSelect(row.id)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '11px 14px',
                  border: 'none',
                  borderLeft: `2px solid ${on ? 'var(--ac)' : 'transparent'}`,
                  borderBottom: '1px solid var(--bd-subtle)',
                  background: on ? 'var(--ac-soft)' : 'transparent',
                  cursor: 'pointer',
                  opacity: row.dim ? 0.55 : 1,
                }}
              >
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span
                    style={{
                      display: 'block',
                      fontSize: 13,
                      fontWeight: 600,
                      color: 'var(--tx-primary)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {row.title}
                  </span>
                  <span
                    style={{
                      display: 'block',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10.5,
                      color: 'var(--tx-muted)',
                      marginTop: 1,
                    }}
                  >
                    {row.name}
                  </span>
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 'none' }}>
                  <span
                    style={{
                      fontSize: 9.5,
                      fontWeight: 700,
                      letterSpacing: '.04em',
                      color: row.tagColors[0],
                    }}
                  >
                    {row.tags[0]}
                  </span>
                  <span
                    style={{ width: 3, height: 3, borderRadius: '50%', background: 'var(--tx-disabled)' }}
                  />
                  <span style={{ fontSize: 9.5, fontWeight: 600, color: row.tagColors[1] }}>
                    {row.tags[1]}
                  </span>
                </span>
              </button>
            );
          })
        )}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Il dettaglio
// ---------------------------------------------------------------------------

/** L'intestazione del riquadro principale: nome, chiave, due etichette. */
export function DetailHead({
  title,
  name,
  tags,
  tagColor,
  actions,
}: {
  title: string;
  name: string;
  tags: [string, string];
  /** Il colore del tipo, come nell'elenco: DUEL e FFA non sono lo stesso. */
  tagColor: string;
  actions: ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 16,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <h3
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 18,
            fontWeight: 700,
            margin: '0 0 5px',
            letterSpacing: '-.01em',
          }}
        >
          {title}
        </h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--tx-muted)' }}>
            {name}
          </span>
          <span style={{ width: 3, height: 3, borderRadius: '50%', background: 'var(--tx-disabled)' }} />
          <span style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '.04em', color: tagColor }}>
            {tags[0]}
          </span>
          <span style={{ fontSize: 10.5, color: 'var(--tx-muted)' }}>{tags[1]}</span>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flex: 'none', flexWrap: 'wrap' }}>{actions}</div>
    </div>
  );
}

/** Due scelte affiancate dentro una vaschetta: tipo, ranking, contesto. */
export function Segmented({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <span
        style={{
          display: 'block',
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--tx-secondary)',
          marginBottom: 7,
        }}
      >
        {label}
      </span>
      <div
        style={{
          display: 'flex',
          gap: 2,
          padding: 3,
          background: 'var(--s-inset)',
          border: '1px solid var(--bd-subtle)',
          borderRadius: 'var(--r-sm)',
        }}
      >
        {options.map((option) => {
          const on = option === value;
          return (
            <button
              key={option}
              type="button"
              onClick={() => onChange(option)}
              style={{
                flex: 1,
                border: 'none',
                borderRadius: 'var(--r-xs)',
                background: on ? 'var(--s-overlay)' : 'transparent',
                color: on ? 'var(--tx-primary)' : 'var(--tx-muted)',
                fontFamily: 'var(--font-ui)',
                fontSize: 12.5,
                fontWeight: 600,
                padding: '7px 10px',
                cursor: 'pointer',
              }}
            >
              {option}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Il campo di testo del disegno: 36px, fondo `--s-inset`. */
export function TextField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <span
        style={{
          display: 'block',
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--tx-secondary)',
          marginBottom: 7,
        }}
      >
        {label}
      </span>
      <input
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: '100%',
          height: 36,
          padding: '0 11px',
          border: '1px solid var(--bd-subtle)',
          borderRadius: 'var(--r-sm)',
          background: 'var(--s-inset)',
          color: 'var(--tx-primary)',
          fontFamily: 'var(--font-ui)',
          fontSize: 13,
          outline: 'none',
        }}
      />
    </div>
  );
}

/**
 * La costante resa leggibile: `START_COOLDOWN` diventa `Start Cooldown`.
 *
 * E' `fmtSettingLabel` del mockup, riga per riga. NON e' una traduzione — la
 * riga mostra comunque la costante sotto — ed e' esattamente per questo che
 * puo' esistere: le descrizioni italiane che avevo scritto io erano una
 * seconda verita' da tenere allineata a mano, questa e' la stessa parola.
 */
export function prettyKey(key: string): string {
  return key
    .split('_')
    .map((word) => (word[0] ?? '') + word.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Una riga di setting, nella griglia del mockup.
 *
 * Le colonne cambiano fra le due schermate — `1fr 56px 190px 100px` sui
 * settings di modalita', `1fr 60px 200px 110px` su quelli di mappa — perche' i
 * primi sono rientrati dentro una sezione e i secondi no.
 */
export function SettingRow({
  spec,
  value,
  columns,
  padding,
  variant,
  onChange,
}: {
  spec: SettingSpec;
  value: string;
  columns: string;
  padding: string;
  /**
   * LE DUE SCHERMATE DISEGNANO LA STESSA RIGA IN DUE MODI, e non e' una
   * svista del disegno: su Modes la colonna di destra ha solo un «Reset»
   * testuale, su Maps una pastiglia «Personalizzato/Predefinito» e un pulsante
   * icona. Anche il filetto cambia lato — sopra su Modes, sotto su Maps —
   * perche' li' le righe stanno dentro una sezione che ha gia' la sua riga di
   * chiusura.
   */
  variant: 'modes' | 'maps';
  onChange: (value: string) => void;
}) {
  const custom = isOverride(spec, value);
  const on = value === '1';
  const edge =
    variant === 'maps'
      ? { borderBottom: '1px solid var(--bd-subtle)' }
      : { borderTop: '1px solid var(--bd-subtle)' };

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: columns,
        alignItems: 'center',
        gap: 12,
        padding,
        ...edge,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, color: 'var(--tx-primary)' }}>{prettyKey(spec.key)}</div>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10.5,
            color: 'var(--tx-disabled)',
            marginTop: 1,
          }}
        >
          {spec.key}
        </div>
      </div>

      {/* Il badge e' il TIPO — bool, int, double, enum — non lo stato. Lo stato
          sta a destra, accanto al ripristino. */}
      <span
        style={{
          fontSize: 9.5,
          fontWeight: 700,
          letterSpacing: '.05em',
          color: 'var(--tx-muted)',
          textTransform: 'uppercase',
        }}
      >
        {spec.kind}
      </span>

      {spec.kind === 'bool' ? (
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={spec.key}
          onClick={() => onChange(on ? '0' : '1')}
          style={{
            justifySelf: 'start',
            width: 38,
            height: 22,
            borderRadius: 'var(--r-full)',
            border: 'none',
            background: on ? 'var(--ac)' : 'var(--s-inset)',
            position: 'relative',
            cursor: 'pointer',
            transition: 'background var(--dur-fast) var(--ease)',
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: 2,
              left: on ? 18 : 2,
              width: 18,
              height: 18,
              borderRadius: '50%',
              background: on ? ON_ACCENT : 'var(--tx-muted)',
              transition: 'left var(--dur-fast) var(--ease)',
            }}
          />
        </button>
      ) : spec.kind === 'enum' ? (
        <select
          aria-label={spec.key}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{
            width: '100%',
            height: 30,
            padding: '0 8px',
            border: '1px solid var(--bd-subtle)',
            borderRadius: 'var(--r-xs)',
            background: 'var(--s-inset)',
            color: 'var(--tx-primary)',
            fontFamily: 'var(--font-ui)',
            fontSize: 12,
            outline: 'none',
          }}
        >
          {(spec.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : (
        <input
          aria-label={spec.key}
          value={value}
          inputMode="decimal"
          onChange={(e) => onChange(e.target.value)}
          style={{
            width: '100%',
            height: 30,
            padding: '0 9px',
            border: '1px solid var(--bd-subtle)',
            borderRadius: 'var(--r-xs)',
            background: 'var(--s-inset)',
            color: 'var(--tx-primary)',
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            outline: 'none',
          }}
        />
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
        {variant === 'maps' ? (
          <span
            style={{
              fontSize: 10.5,
              padding: '2px 7px',
              borderRadius: 'var(--r-xs)',
              background: custom ? 'var(--ac-soft)' : 'transparent',
              color: custom ? 'var(--ac-text)' : 'var(--tx-disabled)',
              whiteSpace: 'nowrap',
            }}
          >
            {custom ? 'Personalizzato' : 'Predefinito'}
          </span>
        ) : null}
        {custom ? (
          variant === 'maps' ? (
            <button
              type="button"
              onClick={() => onChange(spec.fallback)}
              title="Ripristina default"
              aria-label={`Ripristina ${spec.key}`}
              style={{
                width: 22,
                height: 22,
                border: '1px solid var(--bd-subtle)',
                borderRadius: 'var(--r-xs)',
                background: 'transparent',
                color: 'var(--tx-muted)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flex: 'none',
              }}
            >
              <Icon path={ICON_UNDO} size={12} stroke={1.8} />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onChange(spec.fallback)}
              aria-label={`Ripristina ${spec.key}`}
              style={{
                height: 22,
                padding: '0 8px',
                border: 'none',
                borderRadius: 'var(--r-xs)',
                background: 'transparent',
                color: 'var(--ac-text)',
                fontFamily: 'var(--font-ui)',
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              Reset
            </button>
          )
        ) : null}
      </div>
    </div>
  );
}

/** La conferma d'eliminazione, in linea sotto l'intestazione. */
export function ConfirmDelete({
  what,
  cascade,
  busy,
  onConfirm,
  onCancel,
}: {
  what: string;
  /** La frase intera, chiusura compresa: Maps non dice «non e reversibile». */
  cascade: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        padding: '12px 14px',
        border: '1px solid rgba(219,52,52,.35)',
        background: 'var(--err-soft)',
        borderRadius: 'var(--r-sm)',
        marginTop: 16,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: 'var(--err)',
          marginTop: 6,
          flex: 'none',
        }}
      />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12.5, lineHeight: '19px', color: 'var(--tx-secondary)' }}>
          Elimina <strong style={{ color: 'var(--tx-primary)' }}>{what}</strong>? {cascade}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <DangerSolidBtn onClick={onConfirm} disabled={busy}>
            Elimina definitivamente
          </DangerSolidBtn>
          <QuietBtn onClick={onCancel} disabled={busy} height={28}>
            Annulla
          </QuietBtn>
        </div>
      </div>
    </div>
  );
}

/**
 * Il riquadro in basso a destra dopo un salvataggio.
 *
 * SI SPEGNE DA SOLO dopo 3,2 secondi, come nel mockup. Restando li' finche' non
 * si cambia riga diventerebbe una decorazione: si smette di leggerlo, e la
 * volta che dice qualcosa di diverso non se ne accorge nessuno.
 */
export function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDone, 3200);
    return () => clearTimeout(timer);
  }, [onDone]);

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 24,
        right: 24,
        zIndex: 90,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '12px 16px',
        border: '1px solid var(--bd-strong)',
        borderRadius: 'var(--r-md)',
        background: 'var(--s-overlay)',
        boxShadow: 'var(--e3)',
        animation: 'mmRise var(--dur) var(--ease)',
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--ok)', flex: 'none' }} />
      <span style={{ fontSize: 12.5, color: 'var(--tx-primary)' }}>{message}</span>
    </div>
  );
}
