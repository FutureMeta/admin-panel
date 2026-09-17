// «Lingue · Traduzione». Le misure vengono da `frontend/15-lingue-traduzione.dc.html`.
//
// SCORRE SOLO LE CHIAVI NON TRADOTTE in quella lingua, una dopo l'altra:
// precedente, successiva, «Salva e avanti» — e ⌘↵ dalla textarea, perche' chi
// traduce non deve staccare le mani dalla tastiera.
//
// DUE CARD IMPILATE: sopra l'inglese, il testo da cui si parte; sotto la
// lingua in lavorazione, in arancio. Il confronto dei segnaposto e' VIVO: se
// nella traduzione manca `%time%` che l'inglese ha, lo si vede prima di
// salvare, non dopo.
//
// SALVARE FA SPARIRE LA CHIAVE DALL'ELENCO, perche' non e' piu' non
// tradotta: si resta sullo stesso indice e sotto compare la successiva. Non
// c'e' un contatore da far avanzare — e' l'elenco che si accorcia.
//
// L'anteprima «come in gioco» del disegno NON e' montata: e' fuori perimetro,
// si rifa' a parte.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import {
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
import { SkeletonRows } from '../components/ui.tsx';
import type { Me } from '../lib/api.ts';
import { heat, pctOf, REFERENCE } from '../lib/lang.ts';
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

  const at = Math.min(index, Math.max(0, todo.length - 1));
  const item = todo[at];

  // Una chiave nuova, una bozza nuova: la traduzione di prima non deve
  // restare nel campo della chiave dopo.
  // biome-ignore lint/correctness/useExhaustiveDependencies: si azzera quando cambia la chiave, non a ogni render
  useEffect(() => {
    setDraft('');
    setSaveError(null);
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
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    color: 'var(--tx-muted)',
                    padding: '3px 8px',
                    border: '1px solid var(--bd-subtle)',
                    borderRadius: 'var(--r-xs)',
                    background: 'var(--s-inset)',
                  }}
                >
                  ⌘↵
                </span>
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
              </div>
              <div style={{ padding: '14px 18px' }}>
                <textarea
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
