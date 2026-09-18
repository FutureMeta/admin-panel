// «Lingue · Traduzione». Le misure vengono da `frontend/15-lingue-traduzione.dc.html`.
//
// SCORRE SOLO LE CHIAVI NON TRADOTTE in quella lingua, una dopo l'altra:
// precedente, successiva, «Salva e avanti» — e Ctrl/⌘+Invio dalla textarea,
// perche' chi traduce non deve staccare le mani dalla tastiera.
//
// DUE CARD IMPILATE: sopra l'inglese, il testo da cui si parte; sotto la
// lingua in lavorazione, in arancio, con «Genera con l'AI»: la proposta
// finisce nella textarea, e ⌘↵ la salva come se l'avesse scritta chi traduce.
//
// «TRADUCI TUTTO CON L'AI» fa lo stesso su tutto il bundle, in una volta: un
// popup chiede se solo le chiavi non tradotte o tutte, e le traduzioni si
// SALVANO subito — rivederne cento una per una e' il lavoro che si voleva
// evitare. Ogni testo va a registro come se l'avesse salvato chi ha avviato.
//
// SALVARE FA SPARIRE LA CHIAVE DALL'ELENCO, perche' non e' piu' non
// tradotta: si resta sullo stesso indice e sotto compare la successiva. Non
// c'e' un contatore da far avanzare — e' l'elenco che si accorcia.
//
// L'anteprima «come in gioco» del disegno NON e' montata: e' fuori perimetro,
// si rifa' a parte.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AiButton,
  aiErrorText,
  aiTranslate,
  bundleQuery,
  Eyebrow,
  FieldNotice,
  invalidateLang,
  overviewQuery,
  putValue,
  RetryBanner,
} from '../components/lang-bits.tsx';
import { MiniSource } from '../components/mini-text.tsx';
import { PageHeader } from '../components/page.tsx';
import { Modal, SkeletonRows } from '../components/ui.tsx';
import { ApiError, type Me } from '../lib/api.ts';
import {
  type BulkMode,
  type BulkState,
  bulkTargets,
  heat,
  type KeyValues,
  languageName,
  pctOf,
  REFERENCE,
  runBulk,
} from '../lib/lang.ts';
import { canOpen } from '../lib/modules.ts';
import { DISABLED, GHOST, PRIMARY } from './lang-keys.tsx';

export function LangTranslatePage({ me }: { me: Me }) {
  const { ns, code } = useParams({ from: '/shell/lingue/b/$ns/traduci/$code' });
  const queryClient = useQueryClient();
  const canWrite = canOpen(me, 'lingue', 2);

  const overview = useQuery(overviewQuery);
  const bundle = useQuery(bundleQuery(ns));

  const keys = useMemo(() => bundle.data?.keys ?? [], [bundle.data]);
  const todo = useMemo(() => keys.filter((k) => (k.values[code] ?? '') === ''), [keys, code]);

  const [index, setIndex] = useState(0);
  const [draft, setDraft] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  /** La chiave aperta ADESSO: una risposta dell'AI per un'altra chiave si butta. */
  const keyRef = useRef<string | undefined>(undefined);

  const at = Math.min(index, Math.max(0, todo.length - 1));
  const item = todo[at];

  // Una chiave nuova, una bozza nuova: la traduzione di prima non deve
  // restare nel campo della chiave dopo.
  useEffect(() => {
    setDraft('');
    setSaveError(null);
    keyRef.current = item?.key;
  }, [item?.key]);

  const reference = item?.values[REFERENCE] ?? '';
  const blocked = draft.trim() === '';

  const done = keys.length - todo.length;
  const pct = pctOf(done, keys.length);
  const knownLanguage = overview.data?.languages.some((l) => l.code === code) ?? true;

  const save = useMutation({
    mutationFn: () => putValue({ ns, key: item?.key ?? '', code, value: draft }),
    onSuccess: async () => {
      await invalidateLang(queryClient, ns);
    },
    onError: (err) => setSaveError(err instanceof Error ? err.message : 'Salvataggio non riuscito.'),
  });

  const ai = useMutation({
    mutationFn: (key: string) => aiTranslate({ ns, key, code }),
    onMutate: () => setSaveError(null),
    onSuccess: (res, key) => {
      if (key !== keyRef.current) return;
      setDraft(res.text);
      area.current?.focus();
    },
    onError: (err, key) => {
      if (key === keyRef.current) setSaveError(aiErrorText(err));
    },
  });

  const submit = (): void => {
    if (blocked || save.isPending || !canWrite || item === undefined) return;
    save.mutate();
  };

  return (
    <>
      <PageHeader title="Traduzione" sub="Solo le chiavi non tradotte, una dopo l’altra" />

      {bundle.isError ? (
        <RetryBanner
          title="Non riesco a leggere i testi"
          body="Il pannello non risponde. Le modifiche restano disabilitate."
          onRetry={() => void bundle.refetch()}
        />
      ) : null}

      {!knownLanguage ? (
        <RetryBanner
          title={`La lingua «${code}» non esiste`}
          body="Si crea dall’elenco lingue, e nasce disattivata."
          onRetry={() => void overview.refetch()}
        />
      ) : null}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ ...BAR, gap: 16, padding: '14px 18px' }}>
          <Link
            to="/lingue"
            style={{
              display: 'flex',
              alignItems: 'center',
              height: 30,
              padding: '0 11px',
              border: '1px solid var(--bd-subtle)',
              borderRadius: 'var(--r-sm)',
              background: 'var(--s-inset)',
              color: 'var(--tx-secondary)',
              fontSize: 12,
            }}
          >
            ← Cambia bundle
          </Link>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--tx-primary)' }}>
            {ns}
          </span>
          <span
            style={{
              padding: '2px 9px',
              borderRadius: 'var(--r-full)',
              background: 'var(--ac-soft)',
              color: 'var(--ac-text)',
              fontFamily: 'var(--font-mono)',
              fontSize: 11.5,
              fontWeight: 600,
            }}
          >
            {code}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 240, flex: 1 }}>
            <span
              style={{
                flex: 1,
                height: 6,
                borderRadius: 3,
                background: 'var(--s-inset)',
                overflow: 'hidden',
              }}
            >
              <span style={{ display: 'block', height: '100%', background: heat(pct), width: `${pct}%` }} />
            </span>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                color: 'var(--tx-primary)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {pct}%
            </span>
          </span>
          <span style={{ fontSize: 11.5, color: 'var(--tx-muted)' }}>
            {done} / {keys.length} chiavi tradotte ·{' '}
            <span style={{ color: 'var(--warn)', fontWeight: 600 }}>{todo.length} da fare</span>
          </span>
          {canWrite && code !== REFERENCE && keys.length > 0 ? (
            <AiButton
              background="var(--s-elevated)"
              busy={false}
              label="Traduci tutto con l’AI"
              onClick={() => setBulkOpen(true)}
            />
          ) : null}
        </div>

        {bundle.isLoading ? <SkeletonRows rows={6} /> : null}

        {bundle.isSuccess && item === undefined ? (
          <div style={{ ...BAR, padding: '40px 24px', flexDirection: 'column', textAlign: 'center', gap: 8 }}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 600 }}>
              Tutto tradotto in {code}
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--tx-muted)' }}>
              Nessuna chiave di {ns} e' senza testo in questa lingua.{' '}
              <Link to="/lingue/b/$ns" params={{ ns }}>
                Apri le chiavi
              </Link>{' '}
              per correggere quelle che ci sono.
            </div>
          </div>
        ) : null}

        {item !== undefined ? (
          <>
            <div style={{ ...BAR, gap: 14, padding: '12px 18px' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13.5, color: 'var(--tx-primary)' }}>
                {item.key}
              </span>
              <span style={{ fontSize: 11.5, color: 'var(--tx-muted)' }}>
                {at + 1} / {todo.length} non tradotte
              </span>
              <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  type="button"
                  onClick={() => setIndex(Math.max(0, at - 1))}
                  disabled={at === 0}
                  style={NAV}
                >
                  ←
                </button>
                <button
                  type="button"
                  onClick={() => setIndex(Math.min(todo.length - 1, at + 1))}
                  disabled={at >= todo.length - 1}
                  style={NAV}
                >
                  →
                </button>
                <button
                  type="button"
                  onClick={submit}
                  disabled={blocked || save.isPending || !canWrite}
                  style={{
                    ...PRIMARY,
                    height: 32,
                    fontSize: 12,
                    ...(blocked || save.isPending || !canWrite ? DISABLED : {}),
                  }}
                >
                  {save.isPending ? 'Salvo…' : 'Salva e avanti'}
                </button>
              </span>
            </div>

            <section style={PANEL}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '13px 18px',
                  borderBottom: '1px solid var(--bd-subtle)',
                }}
              >
                <span
                  style={{
                    padding: '2px 9px',
                    borderRadius: 'var(--r-xs)',
                    background: 'var(--blu-soft)',
                    color: 'var(--blu-viz)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11.5,
                    fontWeight: 600,
                  }}
                >
                  {REFERENCE}
                </span>
                <span style={{ fontSize: 12, color: 'var(--tx-secondary)' }}>testo di partenza</span>
              </div>
              <div style={{ padding: '13px 18px' }}>
                <div style={{ marginBottom: 9 }}>
                  <Eyebrow>Sorgente</Eyebrow>
                </div>
                {reference === '' ? (
                  <div style={{ fontSize: 12, color: 'var(--tx-muted)' }}>
                    Nemmeno l’inglese ha un testo per questa chiave.
                  </div>
                ) : (
                  <MiniSource text={reference} />
                )}
              </div>
            </section>

            <section style={{ ...PANEL, border: '1px solid rgba(219,110,25,.45)' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '13px 18px',
                  borderBottom: '1px solid var(--bd-subtle)',
                  background: 'var(--ac-soft)',
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 13,
                    fontWeight: 600,
                    color: 'var(--ac-text)',
                  }}
                >
                  {code}
                </span>
                <span style={{ fontSize: 12, color: 'var(--tx-secondary)' }}>stai traducendo questa</span>
                {canWrite && code !== REFERENCE && item !== undefined ? (
                  <AiButton
                    background="var(--s-surface)"
                    busy={ai.isPending}
                    disabled={reference === ''}
                    title={reference === '' ? 'L’inglese non ha un testo per questa chiave' : undefined}
                    onClick={() => ai.mutate(item.key)}
                  />
                ) : null}
              </div>
              <div style={{ padding: '14px 18px' }}>
                <textarea
                  ref={area}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                      e.preventDefault();
                      submit();
                    }
                  }}
                  rows={3}
                  spellCheck={false}
                  readOnly={!canWrite}
                  placeholder="Scrivi la traduzione…"
                  className="code-area"
                  style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    padding: '10px 12px',
                    border: '1px solid var(--bd-strong)',
                    borderRadius: 'var(--r-sm)',
                    background: 'var(--s-inset)',
                    color: 'var(--tx-primary)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12.5,
                    lineHeight: '21px',
                    outline: 'none',
                    resize: 'vertical',
                  }}
                />
                {draft !== '' ? (
                  <div style={{ marginTop: 10, padding: '9px 12px', borderLeft: '2px solid var(--ac)' }}>
                    <MiniSource text={draft} tags={false} />
                  </div>
                ) : null}
                {saveError === null ? null : <FieldNotice tone="err">{saveError}</FieldNotice>}
              </div>
            </section>
          </>
        ) : null}
      </div>

      {bulkOpen ? (
        <BulkTranslateDialog ns={ns} code={code} keys={keys} onClose={() => setBulkOpen(false)} />
      ) : null}
    </>
  );
}

const PANEL: React.CSSProperties = {
  border: '1px solid var(--bd-subtle)',
  borderRadius: 'var(--r-lg)',
  background: 'var(--s-surface)',
  overflow: 'hidden',
};

const BAR: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  border: '1px solid var(--bd-subtle)',
  borderRadius: 'var(--r-lg)',
  background: 'var(--s-surface)',
  flexWrap: 'wrap',
};

const NAV: React.CSSProperties = {
  ...GHOST,
  height: 32,
  padding: '0 12px',
  background: 'var(--s-inset)',
  fontSize: 12,
};

/** Quante chiavi alla volta. Tre: il giro dura minuti invece di dieci, e l'API non si ingolfa. */
const BULK_CONCURRENCY = 3;
const STOPPED_BY_HAND = 'Fermata a mano.';

/** Le ragioni brevi, per l'elenco delle chiavi saltate. */
const SKIPPED: Record<string, string> = {
  formato_cambiato: 'l’AI ha cambiato tag o segnaposto',
  rifiuto: 'l’AI si è rifiutata',
  incompleta: 'risposta incompleta',
  niente_da_tradurre: 'l’inglese non ha un testo',
};

/**
 * Cosa fare di un errore, chiave per chiave.
 *
 * I 4xx di una chiave sola — formato cambiato, chiave sparita, testo vuoto —
 * saltano quella chiave. Tutto il resto vale per tutte, e ferma il giro.
 */
function classifyBulk(err: unknown): { fatal: boolean; reason: string } {
  if (err instanceof ApiError) {
    if ([400, 404, 409, 422].includes(err.status)) {
      return { fatal: false, reason: SKIPPED[err.code ?? ''] ?? 'non riuscita' };
    }
    if (err.isUnauthorized) return { fatal: true, reason: 'la sessione è scaduta: rientra e riprendi.' };
    if (err.isForbidden) return { fatal: true, reason: 'non hai più il permesso di modificare i testi.' };
  }
  return { fatal: true, reason: aiErrorText(err) };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function BulkTranslateDialog({
  ns,
  code,
  keys,
  onClose,
}: {
  ns: string;
  code: string;
  keys: readonly KeyValues[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<BulkMode>('missing');
  const [state, setState] = useState<BulkState | null>(null);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const missing = bulkTargets(keys, code, 'missing');
  const all = bulkTargets(keys, code, 'all');
  const targets = mode === 'missing' ? missing : all;

  // Uscire dalla pagina ferma il giro: niente chiamate a nome di una
  // schermata che non c'e' piu'. Quello gia' salvato resta.
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    if (!running) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [running]);

  const start = async (): Promise<void> => {
    const ctrl = new AbortController();
    abort.current = ctrl;
    setRunning(true);
    const before = new Map(keys.map((k) => [k.key, k.values[code] ?? '']));
    const final = await runBulk(
      targets,
      async (key) => {
        const { text } = await aiTranslate({ ns, key, code });
        // Uguale a quello che c'e' gia': niente scrittura, e niente giro di
        // rilettura dei server per un testo che non cambia.
        if (text !== before.get(key)) await putValue({ ns, key, code, value: text });
      },
      { concurrency: BULK_CONCURRENCY, signal: ctrl.signal, classify: classifyBulk, onProgress: setState },
    );
    setState(final);
    setRunning(false);
    setStopping(false);
    await invalidateLang(queryClient, ns);
  };

  const stop = (): void => {
    setStopping(true);
    abort.current?.abort();
  };

  // Mentre gira, Esc e il clic fuori non chiudono: fermare cento traduzioni
  // per un tasto premuto per sbaglio sarebbe troppo. Si ferma con «Ferma».
  const close = (): void => {
    if (!running) onClose();
  };

  const finished = state !== null && !running;
  const progress = state === null ? 0 : pctOf(state.done + state.failed.length, state.total);
  const skipped = state === null || state.failed.length === 0 ? '' : `, ${state.failed.length} saltate`;

  let footer: React.ReactNode;
  if (finished) {
    footer = (
      <button type="button" onClick={onClose} style={PRIMARY}>
        Chiudi
      </button>
    );
  } else if (running) {
    footer = (
      <button
        type="button"
        onClick={stop}
        disabled={stopping}
        style={{ ...GHOST, ...(stopping ? DISABLED : {}) }}
      >
        {stopping ? 'Fermo dopo quelle in corso…' : 'Ferma'}
      </button>
    );
  } else {
    footer = (
      <>
        <button type="button" onClick={onClose} style={GHOST}>
          Annulla
        </button>
        <button
          type="button"
          onClick={() => void start()}
          disabled={targets.length === 0}
          style={{ ...PRIMARY, ...(targets.length === 0 ? DISABLED : {}) }}
        >
          Traduci {plural(targets.length, 'chiave', 'chiavi')}
        </button>
      </>
    );
  }

  return (
    <Modal
      title="Tradurre tutto con l’AI"
      subtitle={`${ns} · dall’inglese in ${languageName(code)} (${code})`}
      width={520}
      onClose={close}
      footer={footer}
    >
      {state === null ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <BulkOption
            on={mode === 'missing'}
            onPick={() => setMode('missing')}
            title="Solo le chiavi non tradotte"
            detail={
              missing.length === 0
                ? `Tutte le chiavi hanno già un testo in ${code}.`
                : `${plural(missing.length, 'chiave', 'chiavi')} senza testo in ${code}. Quelle già tradotte non si toccano.`
            }
          />
          <BulkOption
            on={mode === 'all'}
            onPick={() => setMode('all')}
            title="Tutte, anche quelle già tradotte"
            detail={`${plural(all.length, 'chiave', 'chiavi')}. Sovrascrive ${plural(all.length - missing.length, 'traduzione esistente', 'traduzioni esistenti')}, anche quelle scritte a mano: il testo di prima resta nel registro.`}
          />
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span
              style={{
                flex: 1,
                height: 6,
                borderRadius: 3,
                background: 'var(--s-inset)',
                overflow: 'hidden',
              }}
            >
              <span
                style={{
                  display: 'block',
                  height: '100%',
                  width: `${progress}%`,
                  background: 'var(--ac)',
                  transition: 'width .3s',
                }}
              />
            </span>
            <span
              style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}
            >
              {state.done + state.failed.length} / {state.total}
            </span>
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--tx-secondary)', lineHeight: '19px' }}>
            {running
              ? `Traduco… ${state.done} salvate${skipped}.`
              : `${plural(state.done, 'traduzione salvata', 'traduzioni salvate')}${skipped}.`}
          </div>
          {finished && state.stopped !== null ? (
            <FieldNotice tone={state.stopped === STOPPED_BY_HAND ? 'info' : 'err'}>
              {state.stopped === STOPPED_BY_HAND
                ? 'Fermata prima della fine.'
                : `Interrotta: ${state.stopped}`}{' '}
              Quelle non ancora fatte restano da tradurre: rilanciando «solo le non tradotte» si riprende da
              lì.
            </FieldNotice>
          ) : null}
          {state.failed.length > 0 ? (
            <div
              style={{
                maxHeight: 180,
                overflowY: 'auto',
                border: '1px solid var(--bd-subtle)',
                borderRadius: 'var(--r-sm)',
                background: 'var(--s-inset)',
                padding: '8px 12px',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              {state.failed.map((f) => (
                <div key={f.key} style={{ display: 'flex', gap: 10, fontSize: 11.5 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--tx-primary)' }}>{f.key}</span>
                  <span style={{ color: 'var(--tx-muted)' }}>{f.reason}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

function BulkOption({
  on,
  onPick,
  title,
  detail,
}: {
  on: boolean;
  onPick: () => void;
  title: string;
  detail: string;
}) {
  return (
    <label
      style={{
        display: 'flex',
        gap: 11,
        alignItems: 'flex-start',
        padding: '11px 13px',
        border: `1px solid ${on ? 'rgba(219,110,25,.55)' : 'var(--bd-subtle)'}`,
        borderRadius: 'var(--r-sm)',
        background: on ? 'var(--ac-soft)' : 'var(--s-inset)',
        cursor: 'pointer',
      }}
    >
      <input
        type="radio"
        name="bulk-mode"
        checked={on}
        onChange={onPick}
        style={{ margin: '2px 0 0', accentColor: 'var(--ac)', flex: 'none' }}
      />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: on ? 'var(--ac-text)' : 'var(--tx-primary)' }}>
          {title}
        </span>
        <span style={{ fontSize: 11.5, lineHeight: '17px', color: 'var(--tx-muted)' }}>{detail}</span>
      </span>
    </label>
  );
}
