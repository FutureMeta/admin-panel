// «Lingue · Chiavi». Le misure vengono da `frontend/15-lingue-esplora.dc.html`.
//
// A SINISTRA UN SOLO ALBERO: i prefissi si aprono e le chiavi compaiono sotto
// il loro prefisso. Niente seconda colonna, niente anteprima del valore nella
// lista — centodieci chiavi devono starci in una colonna, senza paginazione.
//
// A DESTRA LA CHIAVE SCELTA: una card per lingua, UN SOLO CAMPO EDITABILE per
// lingua, e sotto ogni campo gli avvisi. Tre avvisi, ognuno con la sua
// spiegazione, perche' sono tre cose diverse:
//
//   - MiniMessage non valido: il server scarterebbe il testo. SALVATAGGIO
//     BLOCCATO, perche' salvarlo vorrebbe dire un messaggio che sparisce;
//   - segnaposto che mancano rispetto all'inglese: avviso, si salva lo stesso;
//   - valore vuoto dove prima c'era un testo: non si salva, si scrive <reset>.
//
// Dove la lingua non ha valore non c'e' un errore: c'e' «in gioco si vede
// l'inglese», che e' uno stato, e lo si dice.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import {
  bundleQuery,
  Eyebrow,
  FieldNotice,
  invalidateLang,
  MiniField,
  overviewQuery,
  PropagationHint,
  putValue,
  RetryBanner,
} from '../components/lang-bits.tsx';
import { PageHeader } from '../components/page.tsx';
import { ICONS, Icon, SkeletonRows } from '../components/ui.tsx';
import type { Me } from '../lib/api.ts';
import { keyTree, languageName, missingPlaceholders, prefixesOf, REFERENCE } from '../lib/lang.ts';
import { validateMiniMessage } from '../lib/minimessage.ts';
import { canOpen } from '../lib/modules.ts';
import { INPUT, SEARCH } from './lang-overview.tsx';

export function LangKeysPage({ me }: { me: Me }) {
  const { ns } = useParams({ from: '/shell/lingue/b/$ns' });
  const queryClient = useQueryClient();
  const canWrite = canOpen(me, 'lingue', 2);

  const overview = useQuery(overviewQuery);
  const bundle = useQuery(bundleQuery(ns));

  const languages = overview.data?.languages ?? [];
  const keys = useMemo(() => bundle.data?.keys ?? [], [bundle.data]);

  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  /** Le bozze della chiave scelta, per lingua. Vuoto = niente di toccato. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);

  // La prima chiave si sceglie da sola, e con lei si aprono i suoi prefissi:
  // atterrare su un albero chiuso e una colonna vuota e' una schermata che
  // sembra rotta.
  const current = selected ?? keys[0]?.key ?? null;
  useEffect(() => {
    if (selected === null && keys[0] !== undefined) {
      setSelected(keys[0].key);
      setOpen(new Set(prefixesOf(keys[0].key)));
    }
  }, [selected, keys]);

  const row = keys.find((k) => k.key === current);
  const dirtyCodes = Object.keys(drafts).filter((code) => drafts[code] !== (row?.values[code] ?? ''));
  const dirty = dirtyCodes.length > 0;

  // Chiudere la scheda con una modifica in sospeso: il browser chiede.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const pick = (key: string): void => {
    if (key === current) return;
    if (dirty && !window.confirm('Ci sono modifiche non salvate. Scartarle?')) return;
    setSelected(key);
    setDrafts({});
    setSaveError(null);
  };

  const needle = search.trim().toLowerCase();
  const shown = needle === '' ? keys : keys.filter((k) => k.key.toLowerCase().includes(needle));
  // La ricerca NON tiene conto dei prefissi chiusi: chi cerca vuole trovare.
  const effectiveOpen = useMemo(
    () => (needle === '' ? open : new Set(shown.flatMap((k) => prefixesOf(k.key)))),
    [needle, open, shown],
  );
  const tree = useMemo(
    () =>
      keyTree(
        shown.map((k) => k.key),
        effectiveOpen,
      ),
    [shown, effectiveOpen],
  );

  const textOf = (code: string): string => drafts[code] ?? row?.values[code] ?? '';
  const reference = textOf(REFERENCE);

  const cards = languages.map((l) => {
    const value = textOf(l.code);
    const had = (row?.values[l.code] ?? '') !== '';
    const issues = value === '' ? [] : validateMiniMessage(value);
    const missing = l.code === REFERENCE || value === '' ? [] : missingPlaceholders(reference, value);
    const emptied = had && value.trim() === '';
    return { ...l, value, issues, missing, emptied, dirty: dirtyCodes.includes(l.code) };
  });
  const blocked = cards.some((c) => c.dirty && (c.issues.length > 0 || c.emptied));

  const save = useMutation({
    mutationFn: async () => {
      // Una lingua alla volta, nell'ordine del menu: se una fallisce le
      // precedenti restano salvate e l'errore dice quale.
      if (current === null) return;
      for (const c of cards) {
        if (!c.dirty || c.value.trim() === '') continue;
        await putValue({ ns, key: current, code: c.code, value: c.value });
      }
    },
    onSuccess: async () => {
      setDrafts({});
      setSaveError(null);
      await invalidateLang(queryClient, ns);
    },
    onError: (err) => setSaveError(err instanceof Error ? err.message : 'Salvataggio non riuscito.'),
  });

  return (
    <>
      <PageHeader
        title={ns}
        sub={`${keys.length} chiavi · en riferimento · le chiavi nascono dai plugin, qui si traducono`}
        action={<PropagationHint />}
      />

      {bundle.isError ? (
        <RetryBanner
          title="Non riesco a leggere i testi"
          body="Il pannello non risponde. Le modifiche restano disabilitate."
          onRetry={() => void bundle.refetch()}
        />
      ) : null}

      <div
        style={{ display: 'grid', gridTemplateColumns: '320px minmax(0,1fr)', gap: 16, alignItems: 'start' }}
      >
        <section style={PANEL}>
          <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--bd-subtle)' }}>
            <div style={SEARCH}>
              <Icon path={ICONS.search} size={14} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Cerca chiave"
                style={INPUT}
              />
            </div>
          </div>
          <div
            style={{
              maxHeight: 560,
              overflowY: 'auto',
              padding: 6,
              display: 'flex',
              flexDirection: 'column',
              gap: 1,
            }}
          >
            {bundle.isLoading ? <SkeletonRows rows={8} /> : null}
            {tree.map((n) => {
              const on = n.kind === 'key' && n.full === current;
              return (
                <button
                  key={`${n.kind}:${n.full}`}
                  type="button"
                  onClick={() =>
                    n.kind === 'dir'
                      ? setOpen((prev) => {
                          const next = new Set(prev);
                          if (!next.delete(n.full)) next.add(n.full);
                          return next;
                        })
                      : pick(n.full)
                  }
                  aria-expanded={n.kind === 'dir' ? n.open : undefined}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    flex: 'none',
                    height: 30,
                    paddingRight: 10,
                    paddingLeft: 11 + n.depth * 15,
                    border: 'none',
                    borderLeft: `2px solid ${on ? 'var(--ac)' : 'transparent'}`,
                    borderRadius: 'var(--r-sm)',
                    background: on ? 'var(--ac-soft)' : 'transparent',
                    color: on
                      ? 'var(--ac-text)'
                      : n.kind === 'dir'
                        ? 'var(--tx-primary)'
                        : 'var(--tx-secondary)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11.5,
                    fontWeight: n.kind === 'dir' ? 600 : 400,
                    textAlign: 'left',
                    cursor: 'pointer',
                  }}
                >
                  {n.kind === 'dir' ? (
                    <Icon
                      path={ICONS.chevron}
                      size={11}
                      style={{
                        flex: 'none',
                        transform: n.open ? 'rotate(90deg)' : 'none',
                        transition: 'transform var(--dur-fast) var(--ease)',
                      }}
                    />
                  ) : null}
                  <span
                    style={{
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {n.label}
                  </span>
                  {n.kind === 'dir' ? (
                    <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--tx-muted)' }}>
                      {n.count}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
          <div
            style={{
              padding: '10px 14px',
              borderTop: '1px solid var(--bd-subtle)',
              fontSize: 11,
              color: 'var(--tx-muted)',
            }}
          >
            {shown.length} chiavi visibili · {keys.length} nel bundle
          </div>
        </section>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
          <div style={{ padding: '14px 18px', ...PANEL, overflow: 'visible' }}>
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 15,
                fontWeight: 500,
                color: 'var(--tx-primary)',
              }}
            >
              {current ?? '—'}
            </div>
            <div style={{ marginTop: 4, fontSize: 11.5, color: 'var(--tx-muted)' }}>{ns}</div>
          </div>

          {cards.map((c) => (
            <section key={c.code} style={PANEL}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '13px 18px',
                  borderBottom: '1px solid var(--bd-subtle)',
                  flexWrap: 'wrap',
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 13,
                    fontWeight: 500,
                    color: 'var(--tx-primary)',
                  }}
                >
                  {c.code}
                </span>
                <span style={{ fontSize: 12.5, color: 'var(--tx-secondary)' }}>{languageName(c.code)}</span>
                {c.active ? null : (
                  <span style={{ fontSize: 11, color: 'var(--tx-muted)' }}>· disattivata</span>
                )}
                {c.dirty ? (
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--ac-text)' }}>
                    modificata
                  </span>
                ) : null}
              </div>
              <div style={{ padding: '14px 18px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 9 }}>
                  <Eyebrow>Valore</Eyebrow>
                  <span style={{ fontSize: 10.5, color: 'var(--tx-disabled)' }}>
                    modificabile · un solo valore per lingua
                  </span>
                </div>
                <MiniField
                  value={c.value}
                  readOnly={!canWrite || current === null}
                  tone={c.issues.length > 0 || c.emptied ? 'err' : c.missing.length > 0 ? 'warn' : 'neutral'}
                  onChange={(next) => setDrafts((prev) => ({ ...prev, [c.code]: next }))}
                />
                {c.issues.length > 0 ? (
                  <FieldNotice tone="err">
                    MiniMessage non valido: {c.issues[0]?.reason}. Il server scarterebbe questo testo, il
                    salvataggio è bloccato.
                  </FieldNotice>
                ) : null}
                {c.emptied ? (
                  <FieldNotice tone="err">
                    Un testo vuoto non si salva: per un messaggio senza contenuto scrivi{' '}
                    <code>&lt;reset&gt;</code>.
                  </FieldNotice>
                ) : null}
                {c.missing.length > 0 ? (
                  <FieldNotice tone="warn">
                    Placeholder: manca {c.missing.join(', ')} rispetto a en
                  </FieldNotice>
                ) : null}
              </div>
            </section>
          ))}

          {dirty ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                padding: '13px 18px',
                ...PANEL,
                overflow: 'visible',
                flexWrap: 'wrap',
              }}
            >
              <span style={{ fontSize: 12.5, color: 'var(--tx-muted)' }}>
                Modifica non salvata su{' '}
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--tx-secondary)' }}>
                  {dirtyCodes.join(', ')}
                </span>
                {saveError === null ? null : <span style={{ color: 'var(--err)' }}> · {saveError}</span>}
              </span>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                <button type="button" onClick={() => setDrafts({})} style={GHOST}>
                  Annulla
                </button>
                <button
                  type="button"
                  disabled={blocked || save.isPending}
                  onClick={() => save.mutate()}
                  style={{ ...PRIMARY, ...(blocked || save.isPending ? DISABLED : {}) }}
                >
                  {save.isPending ? 'Salvo…' : 'Salva'}
                </button>
              </span>
            </div>
          ) : null}

          <div style={{ fontSize: 11.5, color: 'var(--tx-muted)' }}>
            <Link to="/lingue">← Tutti i bundle</Link>
          </div>
        </div>
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

export const GHOST: React.CSSProperties = {
  height: 34,
  padding: '0 14px',
  border: '1px solid var(--bd-subtle)',
  borderRadius: 'var(--r-sm)',
  background: 'transparent',
  color: 'var(--tx-secondary)',
  fontFamily: 'var(--font-ui)',
  fontSize: 12.5,
  fontWeight: 500,
  cursor: 'pointer',
};

export const PRIMARY: React.CSSProperties = {
  height: 34,
  padding: '0 16px',
  border: 'none',
  borderRadius: 'var(--r-sm)',
  background: 'var(--ac)',
  color: '#160A02',
  fontFamily: 'var(--font-ui)',
  fontSize: 12.5,
  fontWeight: 700,
  cursor: 'pointer',
};

export const DISABLED: React.CSSProperties = {
  background: 'var(--s-elevated)',
  color: 'var(--tx-disabled)',
  cursor: 'default',
};
