// Modalità: il dizionario che decide come i server si raggruppano nei grafici.
//
// SEGUE `frontend/5-dettaglio-modalita.dc.html`, che è UNA schermata sola: i
// grafici di una modalità, e in alto a destra il pulsante che ne crea una
// nuova. Per un po' il dizionario è stato una schermata a parte, il che
// chiedeva di uscire dai grafici per andare a cambiare ciò che i grafici
// mostrano. Adesso è di nuovo quello che il mockup diceva: due finestre che si
// aprono sopra il dettaglio, e questo file non è più una schermata ma i pezzi
// che le compongono.
//
// La prima versione sbagliava la forma di entrambe le cose che contano: la
// creazione (una finestra modale, non un modulo in fondo alla pagina) e la
// scelta dei server (elenco esplicito OPPURE pattern, non una regola per
// volta).
//
// PERCHÉ L'ANTEPRIMA È IL CUORE. Su questa rete esistono `duels_1..6`,
// `duels_lobby_1..2` e `duels_event_1`. Una regola «inizia per duels_» le
// prende tutte e nove, e chi voleva tenere separate arene, lobby ed evento se
// ne accorgerebbe giorni dopo, da un grafico sbagliato. La calcola il server
// inserendo davvero la regola e annullando la transazione: così non esiste una
// seconda copia della logica di risoluzione che possa divergere da quella vera.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import { SelectField } from './page.tsx';
import { Banner, Button, Field } from './ui.tsx';

type MatchKind = 'server' | 'prefix' | 'suffix' | 'contains';
type Alias = { matchKind: MatchKind; matchValue: string };

export type Mode = {
  modeId: number;
  modeKey: string;
  displayName: string;
  color: string | null;
  inBreakdown: boolean;
  hidden: boolean;
  sortOrder: number;
  aliases: Alias[];
  servers: string[];
};

/**
 * Gli avvisi sui colori, che il server calcola e che il pannello NON mostra
 * più: erano un banner in cima al dialogo di modifica, e su questa rete
 * elencava mezza dozzina di coppie ogni volta che lo si apriva. Il tipo resta
 * perché resta nella risposta: descrivere ciò che arriva è il lavoro di un
 * tipo, anche quando nessuno lo disegna. L'anteprima della serie, accanto alla
 * tavolozza, mostra comunque il colore scelto per quello che è.
 */
type ColourWarning =
  | { kind: 'simile'; modeKey: string; otherKey: string; distance: number }
  | { kind: 'contrasto'; modeKey: string; ratio: number };

export type Dictionary = { modes: Mode[]; unclassified: string[]; warnings: ColourWarning[] };
type PreviewChange = { serverKey: string; before: string; after: string };
type Preview = { changes: PreviewChange[]; captured: number; unchanged: number };

/**
 * I venti colori proposti.
 *
 * Generati e VERIFICATI, non scelti a occhio: ognuno sta sopra 3:1 sul fondo
 * scuro — sotto quella soglia la linea sparisce nel grafico, ed è il difetto
 * per cui #1F6E95 è stato tolto dai token — e la distanza minima fra due
 * qualsiasi è 35, appena sopra la soglia oltre la quale il pannello avvisa.
 */
const PALETTE = [
  '#d34545',
  '#d1683b',
  '#d09439',
  '#d0c139',
  '#b2d039',
  '#85d039',
  '#5cd23e',
  '#49d457',
  '#55d789',
  '#62dab6',
  '#6edddd',
  '#78c1df',
  '#7fa7e1',
  '#838ce2',
  '#9582e2',
  '#af7ee1',
  '#ca75df',
  '#dc6bd1',
  '#d95ea8',
  '#d65179',
];

/** Gli operatori del pattern. L'elenco esplicito copre il caso «è esattamente». */
const PATTERN_OPS: Array<{ kind: MatchKind; label: string; hint: string }> = [
  { kind: 'prefix', label: 'inizia per', hint: 'Cattura ogni server il cui nome comincia così.' },
  { kind: 'suffix', label: 'finisce per', hint: 'Cattura ogni server il cui nome termina così.' },
  { kind: 'contains', label: 'contiene', hint: 'Cattura ogni server che ha questo testo nel nome.' },
];

const KIND_LABEL: Record<MatchKind, string> = {
  server: 'è esattamente',
  prefix: 'inizia per',
  suffix: 'finisce per',
  contains: 'contiene',
};

/**
 * La chiave si DERIVA dal nome, non si chiede.
 *
 * È un identificatore interno: chiederla significherebbe far scegliere
 * all'operatore una cosa che non gli serve e su cui può solo sbagliare.
 */
function slug(name: string): string {
  // I segni diacritici si nominano con gli escape e non con i caratteri veri:
  // scritti letterali sono invisibili in un editor e si perdono al primo
  // copia-incolla.
  const plain = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return plain
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
}

function Dot({ color, size = 8 }: { color: string | null; size?: number }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: 2,
        background: color ?? 'var(--tx-muted)',
        flex: 'none',
      }}
    />
  );
}

/** L'anteprima della serie: che aspetto avrà la linea con quel colore. */
function SeriesPreview({ color }: { color: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        marginTop: 11,
        padding: '9px 11px',
        border: '1px solid var(--bd-subtle)',
        borderRadius: 'var(--r-sm)',
        background: 'var(--s-base)',
      }}
    >
      <Dot color={color} size={9} />
      <span style={{ fontSize: 12.5, color: 'var(--tx-secondary)' }}>Anteprima serie</span>
      <svg viewBox="0 0 200 26" preserveAspectRatio="none" style={{ flex: 1, height: 26 }} aria-hidden="true">
        <path
          d="M0,22 L25,18 L50,20 L75,13 L100,15 L125,8 L150,10 L175,4 L200,7"
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

function ColourPicker({ value, onPick }: { value: string; onPick: (c: string) => void }) {
  return (
    <div>
      <div
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 9 }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--tx-secondary)' }}>Colore serie</span>
        <span className="mono" style={{ fontSize: 11.5, color: 'var(--tx-muted)' }}>
          {value}
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(10, 1fr)', gap: 7 }}>
        {PALETTE.map((c) => (
          <button
            key={c}
            type="button"
            title={c}
            aria-label={`Colore ${c}`}
            aria-pressed={c === value}
            onClick={() => onPick(c)}
            style={{
              height: 30,
              border: 'none',
              borderRadius: 'var(--r-xs)',
              background: c,
              boxShadow: c === value ? '0 0 0 2px var(--s-surface), 0 0 0 4px var(--ac)' : 'none',
              cursor: 'pointer',
            }}
          />
        ))}
      </div>
      <SeriesPreview color={value} />
    </div>
  );
}

/**
 * «Server da sommare»: elenco esplicito oppure pattern.
 *
 * Sono due modi di dire la stessa cosa al database — l'elenco diventa una
 * regola «è esattamente» per server — ma non sono la stessa cosa per chi
 * guarda: l'elenco è stabile e dice esattamente cosa entra, il pattern cattura
 * anche i server che nasceranno domani.
 */
function ServerSource({
  available,
  picked,
  setPicked,
  op,
  setOp,
  pattern,
  setPattern,
  mode,
  setMode,
}: {
  available: string[];
  picked: string[];
  setPicked: (v: string[]) => void;
  op: MatchKind;
  setOp: (v: MatchKind) => void;
  pattern: string;
  setPattern: (v: string) => void;
  mode: 'elenco' | 'pattern';
  setMode: (v: 'elenco' | 'pattern') => void;
}) {
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--tx-secondary)', marginBottom: 9 }}>
        Server da sommare
      </div>
      <div
        style={{
          display: 'flex',
          gap: 2,
          padding: 3,
          background: 'var(--s-inset)',
          border: '1px solid var(--bd-subtle)',
          borderRadius: 'var(--r-sm)',
          marginBottom: 12,
        }}
      >
        {(['elenco', 'pattern'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            aria-pressed={mode === m}
            style={{
              flex: 1,
              border: 'none',
              borderRadius: 'var(--r-xs)',
              background: mode === m ? 'var(--s-overlay)' : 'transparent',
              color: mode === m ? 'var(--tx-primary)' : 'var(--tx-muted)',
              fontSize: 12.5,
              fontWeight: 600,
              padding: '7px 10px',
              cursor: 'pointer',
            }}
          >
            {m === 'elenco' ? 'Elenco di server' : 'Pattern sul nome'}
          </button>
        ))}
      </div>

      {mode === 'elenco' ? (
        <div>
          {/*
            SI VEDE E SI CLICCA, non si scrive.

            La prima versione era un campo con `datalist`: bisognava digitare
            il nome del server e il menù che si apriva era quello nativo del
            browser, fuori dallo stile del pannello — la stessa classe di
            difetto dei menù a tendina bianchi su bianco della fase 1. E con
            ventidue server chiedere di ricordarsi i nomi è chiedere una cosa
            che il pannello sa già.
          */}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 7,
              padding: 9,
              border: '1px solid var(--bd-subtle)',
              borderRadius: 'var(--r-sm)',
              background: 'var(--s-inset)',
              minHeight: 44,
              alignItems: 'center',
            }}
          >
            {available.length === 0 ? (
              <span style={{ fontSize: 11.5, color: 'var(--tx-disabled)' }}>
                Nessun server osservato: il campionamento non è ancora acceso.
              </span>
            ) : (
              available.map((s) => {
                const on = picked.includes(s);
                return (
                  <button
                    key={s}
                    type="button"
                    className="mono"
                    aria-pressed={on}
                    onClick={() => setPicked(on ? picked.filter((x) => x !== s) : [...picked, s])}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 7,
                      height: 26,
                      padding: '0 10px',
                      borderRadius: 'var(--r-full)',
                      background: on ? 'var(--ac-soft)' : 'var(--s-overlay)',
                      border: `1px solid ${on ? 'var(--ac)' : 'var(--bd-subtle)'}`,
                      color: on ? 'var(--ac-text)' : 'var(--tx-secondary)',
                      fontSize: 11.5,
                      cursor: 'pointer',
                    }}
                  >
                    {s}
                    {on ? <span aria-hidden="true">×</span> : null}
                  </button>
                );
              })
            )}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--tx-muted)', marginTop: 7 }}>
            I giocatori dei server elencati vengono sommati in un unico valore.
          </div>
        </div>
      ) : (
        <div>
          {/*
            Il menù a tendina è quello del pannello, non uno scritto qui.

            Ne avevo fatto uno a mano con stili in linea: fuori dallo stile
            degli altri e con il testo bianco sulle opzioni, che è esattamente
            il difetto sistemato in fase 1 — la `select` nativa disegna il
            proprio menù con i colori del sistema, e le regole che glielo
            impediscono stanno in `SelectField` e in `app.css`. Riscriverlo
            significava rifare quel lavoro male.
          */}
          <div style={{ display: 'grid', gridTemplateColumns: '150px 1fr', gap: 8, alignItems: 'end' }}>
            <SelectField
              label="Il nome del server"
              value={op}
              onChange={(v) => setOp(v as MatchKind)}
              options={PATTERN_OPS.map((o) => ({ value: o.kind, label: o.label }))}
            />
            <Field
              label="Testo da confrontare"
              className="mono"
              value={pattern}
              placeholder="duels_"
              onChange={(e) => setPattern(e.target.value)}
            />
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--tx-muted)', marginTop: 9 }}>
            {PATTERN_OPS.find((o) => o.kind === op)?.hint}
          </div>
        </div>
      )}
    </div>
  );
}

function PreviewResult({ preview }: { preview: Preview }) {
  if (preview.changes.length === 0) {
    return (
      <Banner
        tone="info"
        title="Questa regola non sposterebbe nessun server"
        description="O non ne cattura nessuno, o quelli che tocca sono già assegnati da una regola più specifica."
      />
    );
  }
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <span style={{ fontSize: 12.5, color: 'var(--tx-secondary)' }}>
        {preview.changes.length}{' '}
        {preview.changes.length === 1 ? 'server cambierebbe' : 'server cambierebbero'} modalità;{' '}
        {preview.unchanged} restano dove sono.
      </span>
      <div style={{ display: 'grid', gap: 3 }}>
        {preview.changes.map((c) => (
          <div key={c.serverKey} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <span className="mono">{c.serverKey}</span>
            <span style={{ color: 'var(--tx-muted)', marginLeft: 'auto' }}>{c.before}</span>
            <span style={{ color: 'var(--tx-muted)' }}>→</span>
            <span>{c.after}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * La conchiglia dei due dialoghi: sfondo, riquadro, intestazione, piede.
 *
 * Sta in un pezzo solo perché creare e modificare una modalità sono la stessa
 * finestra con dentro cose diverse, e due copie di cento righe di cornice
 * divergono al primo ritocco — di solito nel modo peggiore, cioè una delle due
 * smette di chiudersi con Escape e nessuno se ne accorge finché non serve.
 */
function Dialog({
  title,
  sub,
  onClose,
  closeLabel,
  children,
  footer,
}: {
  title: string;
  sub: string;
  onClose: () => void;
  closeLabel: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  // Esc chiude, come ovunque nel pannello.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 80,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 40,
      }}
    >
      {/*
        Lo sfondo è un PULSANTE, non un div con un onClick.
        «Clicca fuori per chiudere» su un elemento statico funziona solo col
        mouse: chi naviga da tastiera non lo raggiunge e chi usa uno screen
        reader non sa che esiste. Come pulsante ha un nome, prende il fuoco e
        risponde a Invio — e la regola del linter che lo segnalava aveva
        ragione, non andava zittita.
      */}
      <button
        type="button"
        aria-label={closeLabel}
        onClick={onClose}
        style={{
          position: 'absolute',
          inset: 0,
          border: 'none',
          background: 'rgba(4,10,14,.66)',
          backdropFilter: 'blur(3px)',
          cursor: 'default',
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          position: 'relative',
          width: 560,
          maxWidth: '100%',
          maxHeight: '100%',
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
            <div style={{ fontSize: 12.5, color: 'var(--tx-muted)', marginTop: 4 }}>{sub}</div>
          </div>
          <button
            type="button"
            aria-label="Chiudi"
            onClick={onClose}
            style={{
              width: 28,
              height: 28,
              border: '1px solid var(--bd-subtle)',
              borderRadius: 'var(--r-sm)',
              background: 'transparent',
              color: 'var(--tx-muted)',
              cursor: 'pointer',
              flex: 'none',
            }}
          >
            ×
          </button>
        </div>

        <div style={{ padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {children}
        </div>

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
      </div>
    </div>
  );
}

export function NewModeDialog({
  available,
  onClose,
  taken,
}: {
  available: string[];
  onClose: () => void;
  taken: string[];
}) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [color, setColor] = useState(PALETTE[0] as string);
  const [source, setSource] = useState<'elenco' | 'pattern'>('elenco');
  const [picked, setPicked] = useState<string[]>([]);
  const [op, setOp] = useState<MatchKind>('prefix');
  const [pattern, setPattern] = useState('');
  const [error, setError] = useState<string | undefined>();

  const key = slug(name);
  const aliases: Alias[] =
    source === 'elenco'
      ? picked.map((s) => ({ matchKind: 'server' as const, matchValue: s }))
      : pattern.trim() === ''
        ? []
        : [{ matchKind: op, matchValue: pattern.trim().toLowerCase() }];

  const create = useMutation({
    mutationFn: async () => {
      await api('/api/stats/modes', {
        method: 'POST',
        body: { modeKey: key, displayName: name.trim(), color },
      });
      if (aliases.length > 0) {
        await api(`/api/stats/modes/${key}/aliases`, { method: 'PUT', body: { aliases } });
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['stats-modes'] });
      onClose();
    },
    onError: () => setError('Non creata. Riprova, o cambia nome se ne esiste già una uguale.'),
  });

  const duplicate = taken.includes(key);
  const canCreate = name.trim() !== '' && key !== '' && !duplicate && !create.isPending;

  return (
    <Dialog
      title="Nuova modalità da tracciare"
      sub="I dati live vengono letti da Redis. La modalità compare nei grafici entro un minuto."
      closeLabel="Chiudi senza creare"
      onClose={onClose}
      footer={
        <>
          <Button size="sm" onClick={onClose}>
            Annulla
          </Button>
          <Button size="sm" variant="primary" disabled={!canCreate} onClick={() => create.mutate()}>
            Crea modalità
          </Button>
        </>
      }
    >
      {error ? <Banner tone="err" title={error} /> : null}

      <NameField
        id="nuova-modalita-nome"
        value={name}
        onChange={setName}
        note={duplicate ? 'Esiste già una modalità con questo nome.' : undefined}
      />

      <ColourPicker value={color} onPick={setColor} />

      <ServerSource
        available={available}
        picked={picked}
        setPicked={setPicked}
        op={op}
        setOp={setOp}
        pattern={pattern}
        setPattern={setPattern}
        mode={source}
        setMode={setSource}
      />
    </Dialog>
  );
}

/** Il campo del nome, uguale nei due dialoghi. */
function NameField({
  id,
  value,
  onChange,
  note,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  note?: string | undefined;
}) {
  return (
    <div>
      <label
        htmlFor={id}
        style={{
          display: 'block',
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--tx-secondary)',
          marginBottom: 7,
        }}
      >
        Nome modalità
      </label>
      <input
        id={id}
        value={value}
        placeholder="es. Duels"
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: '100%',
          height: 38,
          padding: '0 12px',
          border: '1px solid var(--bd-subtle)',
          borderRadius: 'var(--r-sm)',
          background: 'var(--s-inset)',
          color: 'var(--tx-primary)',
          fontSize: 13,
          outline: 'none',
        }}
      />
      {note ? <div style={{ fontSize: 11.5, color: 'var(--st-err)', marginTop: 7 }}>{note}</div> : null}
    </div>
  );
}

/** Le regole di una modalità esistente, con l'anteprima prima di aggiungerne una. */
function ModeRules({ mode, available, canManage }: { mode: Mode; available: string[]; canManage: boolean }) {
  const qc = useQueryClient();
  const [op, setOp] = useState<MatchKind>('prefix');
  const [pattern, setPattern] = useState('');
  const [source, setSource] = useState<'elenco' | 'pattern'>('pattern');
  const [picked, setPicked] = useState<string[]>([]);
  const [preview, setPreview] = useState<Preview | undefined>();
  const [error, setError] = useState<string | undefined>();

  const candidate: Alias | undefined =
    source === 'pattern'
      ? pattern.trim() === ''
        ? undefined
        : { matchKind: op, matchValue: pattern.trim().toLowerCase() }
      : picked.length === 1
        ? { matchKind: 'server', matchValue: picked[0] as string }
        : undefined;

  const save = useMutation({
    mutationFn: (aliases: Alias[]) =>
      api(`/api/stats/modes/${mode.modeKey}/aliases`, { method: 'PUT', body: { aliases } }),
    onSuccess: () => {
      setPreview(undefined);
      setPattern('');
      setPicked([]);
      void qc.invalidateQueries({ queryKey: ['stats-modes'] });
    },
    onError: () => setError('Salvataggio non riuscito.'),
  });

  const tryIt = useMutation({
    mutationFn: (a: Alias) =>
      api<Preview>(`/api/stats/modes/${mode.modeKey}/preview`, { method: 'POST', body: a }),
    onSuccess: (p) => {
      setError(undefined);
      setPreview(p);
    },
    onError: () => setError('Anteprima non riuscita.'),
  });

  const add = () => {
    const toAdd =
      source === 'elenco'
        ? picked.map((s) => ({ matchKind: 'server' as const, matchValue: s }))
        : candidate
          ? [candidate]
          : [];
    if (toAdd.length === 0) return;
    save.mutate([...mode.aliases, ...toAdd]);
  };

  return (
    <div style={{ display: 'grid', gap: 14, padding: '16px 20px 20px' }}>
      {error ? <Banner tone="err" title={error} /> : null}

      {mode.aliases.length === 0 ? (
        <p style={{ fontSize: 12.5, color: 'var(--tx-muted)', margin: 0 }}>
          Nessuna regola: questa modalità non cattura ancora nessun server e non compare nei grafici.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 5 }}>
          {mode.aliases.map((a) => (
            <li
              key={`${a.matchKind}:${a.matchValue}`}
              style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}
            >
              <span style={{ color: 'var(--tx-muted)' }}>{KIND_LABEL[a.matchKind]}</span>
              <span className="mono">{a.matchValue}</span>
              {canManage ? (
                <Button
                  size="sm"
                  variant="ghost"
                  style={{ marginLeft: 'auto' }}
                  onClick={() =>
                    save.mutate(
                      mode.aliases.filter(
                        (x) => !(x.matchKind === a.matchKind && x.matchValue === a.matchValue),
                      ),
                    )
                  }
                >
                  Rimuovi
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canManage ? (
        <>
          <ServerSource
            available={available}
            picked={picked}
            setPicked={setPicked}
            op={op}
            setOp={setOp}
            pattern={pattern}
            setPattern={setPattern}
            mode={source}
            setMode={setSource}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="sm" disabled={!candidate} onClick={() => candidate && tryIt.mutate(candidate)}>
              Prova
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={source === 'elenco' ? picked.length === 0 : !candidate}
              onClick={add}
            >
              Aggiungi
            </Button>
          </div>
          {preview ? <PreviewResult preview={preview} /> : null}
        </>
      ) : null}
    </div>
  );
}

/** Un interruttore per una scelta di visualizzazione. Nessun totale cambia. */
function Flag({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      htmlFor={id}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '11px 12px',
        border: '1px solid var(--bd-subtle)',
        borderRadius: 'var(--r-sm)',
        background: 'var(--s-inset)',
        cursor: 'pointer',
      }}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 2, flex: 'none', accentColor: 'var(--ac)' }}
      />
      <span>
        <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: 'var(--tx-primary)' }}>
          {label}
        </span>
        <span style={{ display: 'block', fontSize: 11.5, color: 'var(--tx-muted)', marginTop: 3 }}>
          {hint}
        </span>
      </span>
    </label>
  );
}

/**
 * Modificare una modalità esistente: nome, colore, come si disegna, e le regole.
 *
 * DUE SALVATAGGI DISTINTI, e non è una svista. L'anagrafica (nome, colore,
 * bandiere) va con «Salva»; le regole si applicano una alla volta dal loro
 * riquadro, perché ognuna passa dall'anteprima — vedere quali server si
 * sposterebbero PRIMA di spostarli è tutto il punto di quel pezzo, e un
 * salvataggio unico in fondo lo aggirerebbe.
 *
 * SI MANDA SOLO CIO' CHE E' CAMBIATO. Il `PATCH` scrive una riga nel registro
 * con prima e dopo: rispedire i campi intatti la riempirebbe di modifiche che
 * non sono avvenute, e il registro è append-only — quelle righe restano.
 */
export function EditModeDialog({
  mode,
  available,
  canManage,
  onClose,
}: {
  mode: Mode;
  available: string[];
  canManage: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(mode.displayName);
  const [color, setColor] = useState(mode.color ?? (PALETTE[0] as string));
  const [hidden, setHidden] = useState(mode.hidden);
  const [inBreakdown, setInBreakdown] = useState(mode.inBreakdown);
  const [error, setError] = useState<string | undefined>();

  const trimmed = name.trim();
  const changes = {
    ...(trimmed !== '' && trimmed !== mode.displayName ? { displayName: trimmed } : {}),
    ...(color !== mode.color ? { color } : {}),
    ...(hidden !== mode.hidden ? { hidden } : {}),
    ...(inBreakdown !== mode.inBreakdown ? { inBreakdown } : {}),
  };
  const dirty = Object.keys(changes).length > 0;

  const save = useMutation({
    mutationFn: () => api(`/api/stats/modes/${mode.modeKey}`, { method: 'PATCH', body: changes }),
    onSuccess: () => {
      // Il dizionario cambia i nomi e i colori di OGNI grafico, non solo di
      // questo: si invalidano anche le statistiche, o la pagina sotto resta
      // con l'etichetta di prima finché non scade da sola.
      void qc.invalidateQueries({ queryKey: ['stats-modes'] });
      void qc.invalidateQueries({ queryKey: ['stats-mode'] });
      void qc.invalidateQueries({ queryKey: ['stats-overview'] });
      onClose();
    },
    onError: () => setError('Modifica non salvata. Riprova.'),
  });

  return (
    <Dialog
      title={`Modifica «${mode.displayName}»`}
      sub="Nome e colore cambiano ovunque, subito. Le regole cambiano i numeri per modalità dal giro successivo e non toccano lo storico: si può cambiare idea."
      closeLabel="Chiudi senza salvare"
      onClose={onClose}
      footer={
        <>
          <Button size="sm" onClick={onClose}>
            Annulla
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!canManage || !dirty || save.isPending}
            onClick={() => save.mutate()}
          >
            Salva
          </Button>
        </>
      }
    >
      {error ? <Banner tone="err" title={error} /> : null}

      <NameField
        id="modifica-modalita-nome"
        value={name}
        onChange={setName}
        note={trimmed === '' ? 'Il nome non può restare vuoto.' : undefined}
      />

      <ColourPicker value={color} onPick={setColor} />

      <div style={{ display: 'grid', gap: 8 }}>
        <Flag
          id="modifica-modalita-hidden"
          label="Non accenderla all'apertura"
          hint="Resta nella legenda e si può riaccendere. Nessun totale cambia: la riga di rete è misurata, non sommata dalle modalità."
          checked={hidden}
          onChange={setHidden}
        />
        <Flag
          id="modifica-modalita-breakdown"
          label="Tienila nella ripartizione"
          hint="Toglierla la esclude dalla torta, che si dichiara sotto: una fetta tolta in silenzio sposterebbe la percentuale di tutte le altre."
          checked={inBreakdown}
          onChange={setInBreakdown}
        />
      </div>

      {/*
        Le regole hanno il loro salvataggio, con anteprima: qui si mostra il
        riquadro com'è, dentro una cornice, invece di rifarlo in piccolo.
      */}
      <div
        style={{
          border: '1px solid var(--bd-subtle)',
          borderRadius: 'var(--r-sm)',
          background: 'var(--s-surface)',
        }}
      >
        <div
          style={{
            padding: '11px 20px',
            borderBottom: '1px solid var(--bd-subtle)',
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--tx-secondary)',
          }}
        >
          Server catturati da questa modalità
        </div>
        <ModeRules mode={mode} available={available} canManage={canManage} />
      </div>
    </Dialog>
  );
}
