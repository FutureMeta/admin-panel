// I pezzi che Modes e Maps hanno in comune.
//
// SONO DUE SCHERMATE CON LA STESSA FIGURA: un elenco a sinistra con ricerca e
// due filtri, il dettaglio a destra, un blocco che si modifica e un pulsante
// Salva che compare solo quando c'e' qualcosa da salvare. Scriverla due volte
// vorrebbe dire che fra un mese sono due schermate leggermente diverse — una
// con la conferma di eliminazione e una senza, una che dice quante modifiche
// ci sono e una no — e la deriva non la nota nessuno finche' non si mettono
// una accanto all'altra.
//
// IL PULSANTE SALVA E' LA COSA PIU' IMPORTANTE DI QUESTO FILE. Qui si modifica
// la configurazione del gioco, tutto resta locale finche' non si salva, e un
// Salva sempre acceso non distingue «ho modificato qualcosa» da «non ho toccato
// niente». Quella distinzione e' cio' che si guarda prima di chiudere la
// pagina.

import type { ReactNode } from 'react';
import { isOverride, looksValid, type SettingSpec } from '../lib/config-draft.ts';
import { Button, ICONS, Icon } from './ui.tsx';

/** Elenco a sinistra, dettaglio a destra. Le misure sono quelle del mockup. */
export function MasterDetail({ list, detail }: { list: ReactNode; detail: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '360px 1fr', gap: 16, alignItems: 'start' }}>
      {list}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>{detail}</div>
    </div>
  );
}

export type PickerRow = {
  id: number;
  title: string;
  /** L'identificativo interno: minuscolo, e' quello che usa il plugin. */
  name: string;
  /** Le due etichette a destra: tipo e ranking, oppure tipo e contesto. */
  tags: [string, string];
};

/**
 * L'elenco selezionabile.
 *
 * La riga corrente si riconosce dal fondo e dal bordo sinistro, come le voci
 * della barra laterale: e' lo stesso significato — «sei qui» — e usare un
 * segnale diverso costringerebbe a impararne due.
 */
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
  /** La barra dei filtri, che cambia fra le due schermate. */
  children: ReactNode;
}) {
  return (
    <section
      style={{
        background: 'var(--s-surface)',
        border: '1px solid var(--bd-subtle)',
        borderRadius: 'var(--r-md)',
        overflow: 'hidden',
      }}
    >
      {/* RICERCA E FILTRI SULLA STESSA RIGA, come nel mockup. Erano a capo: la
          casella di ricerca ha `flex: 1`, e con `flex-wrap: wrap` si prendeva
          tutta la prima riga spingendo i due filtri sotto. Il risultato era
          una barra alta il doppio e due schermate che non somigliavano al
          disegno in un punto che si guarda ogni volta. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: 12,
          borderBottom: '1px solid var(--bd-subtle)',
          flexWrap: 'nowrap',
          minWidth: 0,
        }}
      >
        {children}
      </div>
      <div style={{ maxHeight: 560, overflowY: 'auto' }}>
        {rows.length === 0 ? (
          <div style={{ padding: '18px 14px', fontSize: 12.5, color: 'var(--tx-muted)' }}>{empty}</div>
        ) : (
          rows.map((row) => (
            <button
              key={row.id}
              type="button"
              onClick={() => onSelect(row.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                width: '100%',
                padding: '10px 14px',
                border: 'none',
                borderLeft: `2px solid ${row.id === selected ? 'var(--ac)' : 'transparent'}`,
                background: row.id === selected ? 'var(--ac-soft)' : 'transparent',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <span style={{ minWidth: 0, flex: 1 }}>
                <span
                  style={{
                    display: 'block',
                    fontSize: 13,
                    fontWeight: 500,
                    color: row.id === selected ? 'var(--ac-text)' : 'var(--tx-primary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {row.title}
                </span>
                <span className="mono" style={{ display: 'block', fontSize: 11, color: 'var(--tx-muted)' }}>
                  {row.name}
                </span>
              </span>
              <span style={{ display: 'flex', gap: 6, flex: 'none' }}>
                {row.tags.map((tag) => (
                  <span key={tag} style={{ fontSize: 10.5, color: 'var(--tx-muted)' }}>
                    {tag}
                  </span>
                ))}
              </span>
            </button>
          ))
        )}
      </div>
    </section>
  );
}

/**
 * La barra del salvataggio.
 *
 * NON C'E' QUANDO NON C'E' NIENTE DA SALVARE. Non e' disabilitata: non c'e'.
 * Un pulsante spento occupa comunque lo spazio e va letto per capire che e'
 * spento, mentre la sua assenza si vede senza leggere — ed e' la risposta alla
 * sola domanda che ci si fa davanti a questa schermata, cioe' se le modifiche
 * fatte finora sono nel gioco o soltanto qui.
 *
 * Dice anche QUANTE sono, perche' su quarantotto settings raggruppati in sei
 * sezioni chiuse una modifica fatta dieci minuti fa non e' piu' visibile.
 */
export function SaveBar({
  changes,
  saving,
  onSave,
  onReset,
}: {
  changes: number;
  saving: boolean;
  onSave: () => void;
  onReset: () => void;
}) {
  if (changes === 0) return null;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 14px',
        borderRadius: 'var(--r-md)',
        border: '1px solid var(--bd-strong)',
        background: 'var(--ac-soft)',
      }}
    >
      <span style={{ fontSize: 12.5, color: 'var(--tx-secondary)' }}>
        {changes === 1 ? '1 modifica non salvata' : `${changes} modifiche non salvate`}
      </span>
      <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
        <Button size="sm" onClick={onReset} disabled={saving}>
          Annulla
        </Button>
        <Button size="sm" variant="primary" onClick={onSave} disabled={saving}>
          {saving ? 'Salvataggio…' : 'Salva'}
        </Button>
      </span>
    </div>
  );
}

/**
 * Una riga di setting: la costante, il suo stato, il controllo, il ripristino.
 *
 * IL CONTROLLO SEGUE IL TIPO, e il tipo lo dichiara il server. Un interruttore
 * per un booleano, un campo per un numero, un elenco chiuso per un enum: sono
 * i valori che il plugin sa rileggere, e un campo di testo libero su un enum
 * sarebbe il modo piu' diretto di impedire il caricamento di una modalita'.
 */
export function SettingRow({
  spec,
  value,
  changed,
  onChange,
}: {
  spec: SettingSpec;
  value: string;
  /** La bozza lo ha toccato rispetto a cio' che e' salvato. */
  changed: boolean;
  onChange: (value: string) => void;
}) {
  const custom = isOverride(spec, value);
  const invalid = !looksValid(spec, value);

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 56px 190px 100px',
        alignItems: 'center',
        gap: 10,
        padding: '9px 14px',
        borderTop: '1px solid var(--bd-subtle)',
        background: changed ? 'var(--ac-soft)' : 'transparent',
      }}
    >
      {/* IL NOME DELLA COSTANTE E BASTA. Sopra ce n'era anche una traduzione
          italiana, scritta da me: una seconda verità da tenere allineata a
          mano, e chi cerca SHIELD_STUN cerca SHIELD_STUN. */}
      <div
        className="mono"
        style={{
          minWidth: 0,
          fontSize: 12.5,
          color: 'var(--tx-primary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {spec.key}
      </div>

      {/* «personalizzato» e non «diverso dal default»: e' la stessa cosa detta
          come la si legge, e sta accanto al valore perche' e' di quel valore
          che parla. */}
      <span style={{ fontSize: 10.5, color: custom ? 'var(--ac-text)' : 'var(--tx-muted)' }}>
        {custom ? 'person.' : 'default'}
      </span>

      <div>
        {spec.kind === 'bool' ? (
          <Toggle on={value === '1'} onToggle={() => onChange(value === '1' ? '0' : '1')} label={spec.key} />
        ) : spec.kind === 'enum' ? (
          <select
            className="input"
            aria-label={spec.key}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            style={{ width: '100%', height: 30, fontSize: 12.5 }}
          >
            {(spec.options ?? []).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="input"
            aria-label={spec.key}
            value={value}
            inputMode="decimal"
            onChange={(e) => onChange(e.target.value)}
            style={{
              width: '100%',
              height: 30,
              fontSize: 12.5,
              // Il bordo rosso PRIMA di premere Salva: `3,5` con la virgola e'
              // come si scrive in italiano ed e' esattamente cio' che il
              // plugin non sa rileggere.
              borderColor: invalid ? 'var(--err)' : undefined,
            }}
          />
        )}
      </div>

      <div style={{ textAlign: 'right' }}>
        {custom ? (
          <Button size="sm" onClick={() => onChange(spec.fallback)} title="Riporta al default">
            Reset
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function Toggle({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onToggle}
      style={{
        width: 38,
        height: 21,
        padding: 2,
        borderRadius: 999,
        border: '1px solid var(--bd-strong)',
        background: on ? 'var(--ac)' : 'var(--s-inset)',
        cursor: 'pointer',
        display: 'flex',
        justifyContent: on ? 'flex-end' : 'flex-start',
        alignItems: 'center',
        transition: 'background var(--dur) var(--ease)',
      }}
    >
      <span
        style={{
          width: 15,
          height: 15,
          borderRadius: '50%',
          background: on ? 'var(--s-surface)' : 'var(--tx-muted)',
          display: 'block',
        }}
      />
    </button>
  );
}

/** L'intestazione di un blocco del dettaglio, con le sue azioni a destra. */
export function BlockHeader({ title, sub, children }: { title: string; sub: string; children?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: 14 }}>
      <div style={{ minWidth: 0 }}>
        <h3
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 16,
            fontWeight: 600,
            margin: '0 0 4px',
          }}
        >
          {title}
        </h3>
        <div style={{ fontSize: 12, color: 'var(--tx-muted)' }}>{sub}</div>
      </div>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flex: 'none' }}>{children}</div>
    </div>
  );
}

/**
 * La conferma di un'eliminazione, in linea e non in una finestra.
 *
 * Dice cosa si porta via PRIMA, non dopo: le cascate di queste tabelle
 * arrivano ai preferiti dei giocatori, e chi elimina una modalita' non ha
 * modo di saperlo se non glielo si dice qui.
 */
export function ConfirmDelete({
  what,
  cascade,
  busy,
  onConfirm,
  onCancel,
}: {
  what: string;
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
        margin: '0 14px 14px',
        padding: 12,
        borderRadius: 'var(--r-sm)',
        border: '1px solid var(--err)',
        background: 'var(--err-soft)',
      }}
    >
      <Icon path={ICONS.shield} size={15} />
      <div>
        <div style={{ fontSize: 12.5, lineHeight: '19px', color: 'var(--tx-secondary)' }}>
          Elimina <strong style={{ color: 'var(--tx-primary)' }}>{what}</strong>? {cascade} Non è reversibile.
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <Button size="sm" variant="danger" onClick={onConfirm} disabled={busy}>
            Elimina definitivamente
          </Button>
          <Button size="sm" onClick={onCancel} disabled={busy}>
            Annulla
          </Button>
        </div>
      </div>
    </div>
  );
}
