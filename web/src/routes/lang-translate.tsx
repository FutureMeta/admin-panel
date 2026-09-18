// «Lingue · Traduzione». Le misure vengono da `frontend/15-lingue-traduzione.dc.html`.
//
// SCORRE SOLO LE CHIAVI NON TRADOTTE in quella lingua, una dopo l'altra:
// precedente, successiva, «Salva e avanti» — e Ctrl/⌘+Invio dalla textarea,
// perche' chi traduce non deve staccare le mani dalla tastiera.
//
// DUE CARD IMPILATE: sopra l'inglese, il testo da cui si parte; sotto la
// lingua in lavorazione, in arancio, con «Genera con l'AI» per quella chiave.
//
// UNA BOZZA PER CHIAVE, non una sola. Passare alla chiave dopo non butta
// quello che si e' scritto in quella prima: si puo' andare avanti e indietro,
// e salvare una alla volta o tutte insieme.
//
// «TRADUCI TUTTO CON L'AI» riempie le bozze di tutte le chiavi non tradotte
// che non ne hanno gia' una, mostrando l'avanzamento in un popup. NON SALVA:
// le traduzioni si scorrono con le frecce, si correggono dove serve, e
// «Salva tutte» le scrive in una volta. Ogni testo va a registro come ogni
// altro salvataggio.
//
// SALVARE FA SPARIRE LA CHIAVE DALL'ELENCO, perche' non e' piu' non
// tradotta: si resta sullo stesso indice e sotto compare la successiva. Non
// c'e' un contatore da far avanzare — e' l'elenco che si accorcia.
//
// L'anteprima «come in gioco» del disegno NON e' montata: e' fuori perimetro,
// si rifa' a parte.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useBlocker, useParams } from '@tanstack/react-router';
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
import { Modal, SkeletonRows, Spinner } from '../components/ui.tsx';
import { ApiError, type Me } from '../lib/api.ts';
import { type BulkState, bulkTargets, heat, languageName, pctOf, REFERENCE, runBulk } from '../lib/lang.ts';
import { canOpen } from '../lib/modules.ts';
import { DISABLED, GHOST, PRIMARY } from './lang-keys.tsx';

/** Quante chiavi alla volta. Tre: il giro dura minuti invece di dieci, e l'API non si ingolfa. */
const CONCURRENCY = 3;
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

type BulkRun = { state: BulkState; running: boolean; stopping: boolean };

export function LangTranslatePage({ me }: { me: Me }) {
  const { ns, code } = useParams({ from: '/shell/lingue/b/$ns/traduci/$code' });
  const queryClient = useQueryClient();
  const canWrite = canOpen(me, 'lingue', 2);

  const overview = useQuery(overviewQuery);
  const bundle = useQuery(bundleQuery(ns));

  const keys = useMemo(() => bundle.data?.keys ?? [], [bundle.data]);
  const todo = useMemo(() => keys.filter((k) => (k.values[code] ?? '') === ''), [keys, code]);

  const [index, setIndex] = useState(0);
  /** Le bozze, per chiave. Una chiave senza voce non e' stata toccata. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [aiError, setAiError] = useState<{ key: string; text: string } | null>(null);
  /** Il giro dell'AI su tutto il bundle: c'e' finche' il popup e' aperto. */
  const [bulk, setBulk] = useState<BulkRun | null>(null);
  /** «Salva tutte»: l'avanzamento mentre scrive, e cosa non e' andato dopo. */
  const [saving, setSaving] = useState<{ state: BulkState; running: boolean } | null>(null);
  const bulkAbort = useRef<AbortController | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  /** La chiave aperta ADESSO, per chi risponde dopo: l'AI della chiave singola. */
  const keyRef = useRef<string | undefined>(undefined);

  const at = Math.min(index, Math.max(0, todo.length - 1));
  const item = todo[at];

  useEffect(() => {
    setSaveError(null);
    keyRef.current = item?.key;
  }, [item?.key]);

  const draft = item === undefined ? '' : (drafts[item.key] ?? '');
  const setDraft = (value: string): void => {
    if (item !== undefined) setDrafts((prev) => ({ ...prev, [item.key]: value }));
  };
  const reference = item?.values[REFERENCE] ?? '';
  const blocked = draft.trim() === '';

  /** Le bozze pronte da salvare: chiavi ancora da fare, con un testo. */
  const ready = todo.filter((k) => (drafts[k.key] ?? '').trim() !== '').map((k) => k.key);
  /** Cosa tradurrebbe l'AI adesso: le chiavi da fare con l'inglese, senza una bozza. */
  const aiTargets = bulkTargets(todo, code).filter((key) => (drafts[key] ?? '').trim() === '');

  const done = keys.length - todo.length;
  const pct = pctOf(done, keys.length);
  const knownLanguage = overview.data?.languages.some((l) => l.code === code) ?? true;

  // Uscire con bozze non salvate, o con l'AI al lavoro, si chiede. Vale per
  // la barra laterale come per la chiusura della scheda.
  const dirty = ready.length > 0 || bulk?.running === true;
  useBlocker({
    shouldBlockFn: () =>
      !window.confirm(
        bulk?.running === true
          ? 'La traduzione con l’AI è in corso: uscendo si ferma. Uscire?'
          : `Ci sono ${plural(ready.length, 'traduzione non salvata', 'traduzioni non salvate')}. Uscire e perderle?`,
      ),
    enableBeforeUnload: dirty,
    disabled: !dirty,
  });
  // Uscire dalla pagina ferma il giro: niente chiamate per una schermata che non c'e' piu'.
  useEffect(() => () => bulkAbort.current?.abort(), []);

  const forget = (saved: readonly string[]): void =>
    setDrafts((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => !saved.includes(key))));

  const save = useMutation({
    mutationFn: (v: { key: string; value: string }) => putValue({ ns, code, ...v }),
    onSuccess: async (_res, v) => {
      forget([v.key]);
      await invalidateLang(queryClient, ns);
    },
    onError: (err) => setSaveError(err instanceof Error ? err.message : 'Salvataggio non riuscito.'),
  });

  const ai = useMutation({
    mutationFn: (key: string) => aiTranslate({ ns, key, code }),
    onMutate: () => setAiError(null),
    onSuccess: (res, key) => {
      setDrafts((prev) => ({ ...prev, [key]: res.text }));
      if (key === keyRef.current) area.current?.focus();
    },
    onError: (err, key) => setAiError({ key, text: aiErrorText(err) }),
  });

  const submit = (): void => {
    if (blocked || save.isPending || !canWrite || item === undefined) return;
    save.mutate({ key: item.key, value: draft });
  };

  const startBulk = async (): Promise<void> => {
    const targets = aiTargets;
    const ctrl = new AbortController();
    bulkAbort.current = ctrl;
    setBulk({
      state: { total: targets.length, done: 0, failed: [], stopped: null },
      running: true,
      stopping: false,
    });
    const final = await runBulk(
      targets,
      async (key) => {
        const { text } = await aiTranslate({ ns, key, code });
        setDrafts((prev) => ({ ...prev, [key]: text }));
      },
      {
        concurrency: CONCURRENCY,
        signal: ctrl.signal,
        classify: classifyBulk,
        onProgress: (state) => setBulk((b) => (b === null ? b : { ...b, state })),
      },
    );
    setIndex(0);
    // Tutto a posto: il popup si chiude da solo e si comincia a rivedere.
    // Altrimenti resta aperto a dire cosa e' stato saltato, o perche' si e' fermato.
    setBulk(
      final.failed.length === 0 && final.stopped === null
        ? null
        : { state: final, running: false, stopping: false },
    );
  };

  const saveAll = async (): Promise<void> => {
    const snapshot = { ...drafts };
    const saved: string[] = [];
    setSaving({ state: { total: ready.length, done: 0, failed: [], stopped: null }, running: true });
    const final = await runBulk(
      ready,
      async (key) => {
        await putValue({ ns, key, code, value: snapshot[key] as string });
        saved.push(key);
      },
      {
        concurrency: CONCURRENCY,
        signal: new AbortController().signal,
        classify: classifyBulk,
        onProgress: (state) => setSaving({ state, running: true }),
      },
    );
    forget(saved);
    setSaving(final.failed.length === 0 && final.stopped === null ? null : { state: final, running: false });
    await invalidateLang(queryClient, ns);
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
              busy={bulk?.running === true}
              disabled={aiTargets.length === 0}
              title={aiTargets.length === 0 ? 'Nessuna chiave da tradurre senza una bozza' : undefined}
              label="Traduci tutto con l’AI"
              onClick={() => void startBulk()}
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
                {ready.length > 0 ? (
                  <span style={{ color: 'var(--ac-text)' }}>
                    {' '}
                    · {plural(ready.length, 'bozza da salvare', 'bozze da salvare')}
                  </span>
                ) : null}
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
                {canWrite && ready.some((key) => key !== item.key) ? (
                  <button
                    type="button"
                    onClick={() => void saveAll()}
                    disabled={saving?.running === true}
                    style={{
                      ...NAV,
                      color: 'var(--ac-text)',
                      border: '1px solid rgba(219,110,25,.5)',
                      ...(saving?.running === true ? DISABLED : {}),
                    }}
                  >
                    {saving?.running === true
                      ? `Salvo ${saving.state.done + saving.state.failed.length} / ${saving.state.total}…`
                      : `Salva tutte (${ready.length})`}
                  </button>
                ) : null}
              </span>
            </div>

            {saving !== null && !saving.running ? (
              <FieldNotice tone="err">
                {saving.state.stopped === null
                  ? `${plural(saving.state.failed.length, 'bozza non salvata', 'bozze non salvate')}: ${saving.state.failed.map((f) => f.key).join(', ')}. Restano qui, da riprovare.`
                  : `Salvataggio interrotto: ${saving.state.stopped} Le bozze non salvate restano qui.`}
              </FieldNotice>
            ) : null}

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
                {canWrite && code !== REFERENCE ? (
                  <AiButton
                    background="var(--s-surface)"
                    busy={ai.isPending && ai.variables === item.key}
                    disabled={ai.isPending || reference === ''}
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
                {aiError?.key === item.key ? <FieldNotice tone="err">{aiError.text}</FieldNotice> : null}
                {saveError === null ? null : <FieldNotice tone="err">{saveError}</FieldNotice>}
              </div>
            </section>
          </>
        ) : null}
      </div>

      {bulk !== null ? (
        <BulkProgressDialog
          ns={ns}
          code={code}
          run={bulk}
          onStop={() => {
            setBulk((b) => (b === null ? b : { ...b, stopping: true }));
            bulkAbort.current?.abort();
          }}
          onClose={() => setBulk(null)}
        />
      ) : null}
    </>
  );
}

/**
 * Il popup del giro dell'AI: l'avanzamento mentre traduce, e — solo se
 * qualcosa non e' andato — cosa e' stato saltato. Se va tutto bene si chiude
 * da solo, e le traduzioni sono gia' nelle bozze.
 */
function BulkProgressDialog({
  ns,
  code,
  run,
  onStop,
  onClose,
}: {
  ns: string;
  code: string;
  run: BulkRun;
  onStop: () => void;
  onClose: () => void;
}) {
  const { state, running, stopping } = run;
  const progress = pctOf(state.done + state.failed.length, state.total);

  const footer = running ? (
    <button
      type="button"
      onClick={onStop}
      disabled={stopping}
      style={{ ...GHOST, ...(stopping ? DISABLED : {}) }}
    >
      {stopping ? 'Fermo dopo quelle in corso…' : 'Ferma'}
    </button>
  ) : (
    <button type="button" onClick={onClose} style={PRIMARY}>
      {state.done > 0 ? 'Rivedi le traduzioni' : 'Chiudi'}
    </button>
  );

  return (
    <Modal
      title="Traduzione con l’AI"
      subtitle={`${ns} · dall’inglese in ${languageName(code)} (${code})`}
      width={480}
      // Mentre gira, Esc e il clic fuori non chiudono: fermare cento
      // traduzioni per un tasto premuto per sbaglio sarebbe troppo.
      onClose={() => {
        if (!running) onClose();
      }}
      footer={footer}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            fontSize: 12.5,
            color: 'var(--tx-secondary)',
          }}
        >
          {running ? (
            <span style={{ color: 'var(--ac-text)', display: 'flex' }}>
              <Spinner />
            </span>
          ) : null}
          <span>
            {running
              ? `Traduco ${plural(state.total, 'chiave', 'chiavi')}…`
              : `${plural(state.done, 'traduzione pronta', 'traduzioni pronte')} da rivedere${
                  state.failed.length > 0 ? `, ${state.failed.length} saltate` : ''
                }.`}
          </span>
        </div>
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
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
            {state.done + state.failed.length} / {state.total}
          </span>
        </div>
        {!running && state.stopped !== null ? (
          <FieldNotice tone={state.stopped === STOPPED_BY_HAND ? 'info' : 'err'}>
            {state.stopped === STOPPED_BY_HAND ? 'Fermata prima della fine.' : `Interrotta: ${state.stopped}`}{' '}
            Rilanciando si riprende dalle chiavi che non hanno ancora una bozza.
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
    </Modal>
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
