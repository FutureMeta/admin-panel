// Modalità: il dizionario che decide come i server si raggruppano nei grafici.
//
// SEGUE `frontend/5-dettaglio-modalita.dc.html`. La prima versione di questa
// schermata era disegnata da zero e sbagliava la forma di entrambe le cose che
// contano: la creazione (una finestra modale, non un modulo in fondo alla
// pagina) e la scelta dei server (elenco esplicito OPPURE pattern, non una
// regola per volta).
//
// PERCHÉ L'ANTEPRIMA È IL CUORE. Su questa rete esistono `duels_1..6`,
// `duels_lobby_1..2` e `duels_event_1`. Una regola «inizia per duels_» le
// prende tutte e nove, e chi voleva tenere separate arene, lobby ed evento se
// ne accorgerebbe giorni dopo, da un grafico sbagliato. La calcola il server
// inserendo davvero la regola e annullando la transazione: così non esiste una
// seconda copia della logica di risoluzione che possa divergere da quella vera.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { PageHeader, Panel, PanelBar, SelectField } from '../components/page.tsx';
import { Banner, Button, EmptyState, Field, SkeletonRows } from '../components/ui.tsx';
import { api, type Me } from '../lib/api.ts';

type MatchKind = 'server' | 'prefix' | 'suffix' | 'contains';
type Alias = { matchKind: MatchKind; matchValue: string };

type Mode = {
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

type ColourWarning =
  | { kind: 'simile'; modeKey: string; otherKey: string; distance: number }
  | { kind: 'contrasto'; modeKey: string; ratio: number };

type Dictionary = { modes: Mode[]; unclassified: string[]; warnings: ColourWarning[] };
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

function NewModeDialog({
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

  // Esc chiude, come ovunque nel pannello.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

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
        aria-label="Chiudi senza creare"
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
        aria-label="Nuova modalità da tracciare"
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
              Nuova modalità da tracciare
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--tx-muted)', marginTop: 4 }}>
              I dati live vengono letti da Redis. La modalità compare nei grafici entro un minuto.
            </div>
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
          {error ? <Banner tone="err" title={error} /> : null}

          <div>
            <label
              htmlFor="nuova-modalita-nome"
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
              id="nuova-modalita-nome"
              value={name}
              placeholder="es. Duels"
              onChange={(e) => setName(e.target.value)}
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
            {duplicate ? (
              <div style={{ fontSize: 11.5, color: 'var(--st-err)', marginTop: 7 }}>
                Esiste già una modalità con questo nome.
              </div>
            ) : null}
          </div>

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
          <Button size="sm" onClick={onClose}>
            Annulla
          </Button>
          <Button size="sm" variant="primary" disabled={!canCreate} onClick={() => create.mutate()}>
            Crea modalità
          </Button>
        </div>
      </div>
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

function ColourNotices({ warnings, modes }: { warnings: ColourWarning[]; modes: Mode[] }) {
  if (warnings.length === 0) return null;
  const nameOf = (k: string) => modes.find((m) => m.modeKey === k)?.displayName ?? k;
  return (
    <Banner
      tone="warn"
      title="Colori da rivedere"
      description={warnings
        .map((w) =>
          w.kind === 'contrasto'
            ? `«${nameOf(w.modeKey)}» ha un contrasto di ${w.ratio}:1 sul fondo: sotto 3:1 la sua linea sparisce nel grafico.`
            : `«${nameOf(w.modeKey)}» e «${nameOf(w.otherKey)}» hanno colori quasi identici: sul grafico le due linee non si distinguono.`,
        )
        .join(' ')}
    />
  );
}

export function ModesPage({ me }: { me: Me }) {
  const [selected, setSelected] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);
  const canManage = (me.permissions.statistiche ?? 0) >= 3;

  const dict = useQuery({
    queryKey: ['stats-modes'],
    queryFn: () => api<Dictionary>('/api/stats/modes'),
  });

  const modes = useMemo(() => dict.data?.modes ?? [], [dict.data]);
  const current = modes.find((m) => m.modeKey === selected);

  /** Tutti i server osservati: quelli assegnati e quelli ancora liberi. */
  const allServers = useMemo(
    () => [...(dict.data?.unclassified ?? []), ...modes.flatMap((m) => m.servers)].sort(),
    [dict.data, modes],
  );

  return (
    <>
      <PageHeader
        title="Modalità e server"
        sub="Come i server della rete si raggruppano nei grafici. Cambiare una regola cambia i numeri per modalità dal giro successivo e non tocca lo storico: si può cambiare idea."
        action={
          canManage ? (
            <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
              Nuova modalità
            </Button>
          ) : undefined
        }
      />

      {dict.isPending ? <SkeletonRows rows={3} /> : null}
      {dict.data ? <ColourNotices warnings={dict.data.warnings} modes={modes} /> : null}

      {/* Le schede, come nel design: pallino del colore piu` il nome. */}
      {modes.length > 0 ? (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 2,
            padding: 3,
            background: 'var(--s-inset)',
            border: '1px solid var(--bd-subtle)',
            borderRadius: 'var(--r-sm)',
          }}
        >
          {modes.map((m) => (
            <button
              key={m.modeKey}
              type="button"
              onClick={() => setSelected(selected === m.modeKey ? undefined : m.modeKey)}
              aria-pressed={selected === m.modeKey}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                border: 'none',
                borderRadius: 'var(--r-xs)',
                background: selected === m.modeKey ? 'var(--s-overlay)' : 'transparent',
                color: selected === m.modeKey ? 'var(--tx-primary)' : 'var(--tx-muted)',
                fontSize: 12.5,
                fontWeight: 600,
                padding: '6px 11px',
                cursor: 'pointer',
              }}
            >
              <Dot color={m.color} />
              {m.displayName}
              <span className="mono" style={{ fontSize: 11, opacity: 0.7 }}>
                {m.servers.length}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {current ? (
        <Panel>
          <PanelBar>
            <Dot color={current.color} size={9} />
            <span style={{ fontSize: 12.5, color: 'var(--tx-secondary)' }}>{current.displayName}</span>
            <span className="mono" style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--tx-muted)' }}>
              {current.servers.length === 0 ? 'nessun server' : `${current.servers.length} server`}
            </span>
            {/*
              LA VIA D'INGRESSO al dettaglio, e sta qui perché è qui che si
              guarda una modalità alla volta. Solo se ha almeno un server:
              senza, la rotta risponde 404 di proposito — «esiste ma non ha
              osservazioni» — e un collegamento che porta a un errore è peggio
              di un collegamento assente.
            */}
            {current.servers.length > 0 ? (
              <Link
                to="/dettaglio-modalita/$key"
                params={{ key: current.modeKey }}
                style={{ fontSize: 12, color: 'var(--ac-text)', textDecoration: 'none' }}
              >
                Vedi le statistiche →
              </Link>
            ) : null}
          </PanelBar>
          <ModeRules mode={current} available={allServers} canManage={canManage} />
        </Panel>
      ) : null}

      {/*
        Quando il campionamento non ha ancora osservato niente lo si dice qui,
        e si dice che i grafici non hanno dati: «nessuna modalita'» e «nessun
        server» si assomigliano e non sono la stessa cosa.
      */}
      {!dict.isPending && allServers.length === 0 ? (
        <EmptyState
          title="Nessun server osservato"
          description="I server non si configurano: li scopre il campionamento leggendo chi è online. Finché non è acceso, qui non c'è niente da raggruppare — e i grafici non hanno dati."
        />
      ) : null}

      {modes.length === 0 && !dict.isPending ? (
        <EmptyState
          title="Il dizionario è vuoto"
          description="Nessuno sa a priori come questa rete vuole raggruppare i propri server: le modalità le crei tu, e finché non esistono i grafici mostrano una serie sola."
        />
      ) : null}

      {creating ? (
        <NewModeDialog
          available={allServers}
          taken={modes.map((m) => m.modeKey)}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </>
  );
}
