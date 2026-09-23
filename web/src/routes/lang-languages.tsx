// «Lingue · Elenco». Le misure vengono da `frontend/15-lingue-impostazioni.dc.html`.
//
// UNA TABELLA: posizione, codice, nome com'e' scritto e com'e' reso — e' MiniMessage,
// e il giocatore vede il reso — completamento, attiva si'/no. Le frecce
// spostano una lingua di un posto nel menu in gioco; il nome si cambia
// cliccandolo; il cestino cancella la lingua, coi suoi testi, dopo aver
// chiesto di scriverne il codice — e' l'unica cosa qui che non si annulla.
//
// UNA LINGUA NUOVA NASCE DISATTIVATA E VUOTA. Accenderla la mostra a tutti i
// giocatori, ed e' una decisione che si prende dopo averla riempita, non
// prima: per questo il popup chiede solo codice e nome, e l'interruttore sta
// altrove.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  CompletionBar,
  Eyebrow,
  invalidateLang,
  overviewQuery,
  RetryBanner,
} from '../components/lang-bits.tsx';
import { MiniSource } from '../components/mini-text.tsx';
import { PageHeader } from '../components/page.tsx';
import { Modal, SkeletonRows } from '../components/ui.tsx';
import { ApiError, api, type Me } from '../lib/api.ts';
import { type Language, pctOf, REFERENCE } from '../lib/lang.ts';
import { canOpen } from '../lib/modules.ts';
import { DISABLED, GHOST, PRIMARY } from './lang-keys.tsx';

export function LangLanguagesPage({ me }: { me: Me }) {
  const queryClient = useQueryClient();
  const canManage = canOpen(me, 'lingue_elenco', 3);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const overview = useQuery(overviewQuery);
  const languages = overview.data?.languages ?? [];
  const bundles = overview.data?.bundles ?? [];
  const totalKeys = bundles.reduce((sum, b) => sum + b.keys, 0);

  const invalidate = () => invalidateLang(queryClient);

  const patch = useMutation({
    mutationFn: (input: {
      code: string;
      body: { display?: string; active?: boolean; move?: 'up' | 'down' };
    }) =>
      api<Language>(`/api/lang/language/${encodeURIComponent(input.code)}`, {
        method: 'PATCH',
        body: input.body,
      }),
    onSuccess: invalidate,
    onError: (err) => setError(err instanceof Error ? err.message : 'Modifica non riuscita.'),
  });

  const remove = useMutation({
    mutationFn: (code: string) =>
      api<undefined>(`/api/lang/language/${encodeURIComponent(code)}`, { method: 'DELETE' }),
    onSuccess: invalidate,
    onError: (err) => setError(err instanceof Error ? err.message : 'Cancellazione non riuscita.'),
  });

  const askDelete = (l: Language, texts: number): void => {
    // Due conferme, e la seconda vuole il codice: e' l'unica operazione della
    // sezione che non si annulla, e un clic per sbaglio butta via traduzioni.
    if (
      !window.confirm(
        `Cancellare la lingua ${l.code}?

` +
          `Se ne vanno anche i suoi ${texts} testi tradotti. Chi la usava in gioco vedrà l’inglese. ` +
          'Il testo di prima resta solo nel registro attività.',
      )
    ) {
      return;
    }
    if (window.prompt(`Scrivi ${l.code} per confermare:`)?.trim() === l.code) remove.mutate(l.code);
  };

  return (
    <>
      <PageHeader title="Elenco lingue" sub="Quali lingue vedono i giocatori" />

      {overview.isError ? (
        <RetryBanner
          title="Non riesco a leggere le lingue"
          body="Il pannello non risponde."
          onRetry={() => void overview.refetch()}
        />
      ) : null}
      {error === null ? null : (
        <RetryBanner title="Modifica non riuscita" body={error} onRetry={() => setError(null)} />
      )}

      <section style={PANEL}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '14px 18px',
            borderBottom: '1px solid var(--bd-subtle)',
          }}
        >
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 600 }}>Lingue</div>
          <span style={{ fontSize: 12, color: 'var(--tx-muted)' }}>
            L’ordine è quello del menu in gioco · en è il fallback
          </span>
          {canManage ? (
            <button
              type="button"
              onClick={() => setAdding(true)}
              style={{
                ...PRIMARY,
                marginLeft: 'auto',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                height: 32,
                fontSize: 12,
              }}
            >
              <svg
                viewBox="0 0 24 24"
                width="12"
                height="12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
              Aggiungi lingua
            </button>
          ) : null}
        </div>

        <div style={{ ...ROW, padding: '10px 18px' }}>
          <Eyebrow>#</Eyebrow>
          <Eyebrow>Codice</Eyebrow>
          <Eyebrow>Nome (sorgente)</Eyebrow>
          <Eyebrow>Nome (reso)</Eyebrow>
          <Eyebrow>Completamento</Eyebrow>
          <Eyebrow>Attiva</Eyebrow>
          <span />
        </div>

        {overview.isLoading ? (
          <div style={{ padding: 18 }}>
            <SkeletonRows rows={3} />
          </div>
        ) : null}

        {languages.map((l, i) => {
          const done = bundles.reduce((sum, b) => sum + (b.done[l.code] ?? 0), 0);
          const pct = pctOf(done, totalKeys);
          return (
            <div key={l.code} style={{ ...ROW, alignItems: 'center', padding: '12px 18px' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--tx-muted)' }}>
                {canManage ? (
                  <span style={{ display: 'flex', flexDirection: 'column' }}>
                    <button
                      type="button"
                      title="Sposta su"
                      aria-label={`Sposta ${l.code} su`}
                      disabled={i === 0 || patch.isPending}
                      onClick={() => patch.mutate({ code: l.code, body: { move: 'up' } })}
                      style={ARROW}
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      title="Sposta giù"
                      aria-label={`Sposta ${l.code} giù`}
                      disabled={i === languages.length - 1 || patch.isPending}
                      onClick={() => patch.mutate({ code: l.code, body: { move: 'down' } })}
                      style={ARROW}
                    >
                      ▼
                    </button>
                  </span>
                ) : null}
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>{i + 1}</span>
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, fontWeight: 500 }}>
                  {l.code}
                </span>
                {l.code === REFERENCE ? (
                  <span style={{ fontSize: 10.5, color: 'var(--tx-muted)' }}>fallback</span>
                ) : null}
              </span>
              <span style={{ minWidth: 0 }}>
                <DisplayName
                  value={l.display}
                  editable={canManage && !patch.isPending}
                  onSave={(display) => patch.mutate({ code: l.code, body: { display } })}
                />
              </span>
              <span style={{ minWidth: 0 }}>
                <MiniSource text={l.display} size={13.5} tags={false} />
              </span>
              <CompletionBar pct={pct} width={34} />
              <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <button
                  type="button"
                  role="switch"
                  aria-label={`${l.code} attiva per i giocatori`}
                  aria-checked={l.active}
                  disabled={!canManage || patch.isPending}
                  onClick={() => patch.mutate({ code: l.code, body: { active: !l.active } })}
                  title={l.active ? 'Disattiva per i giocatori' : 'Attiva per i giocatori'}
                  style={{
                    width: 30,
                    height: 17,
                    borderRadius: 9,
                    border: `1px solid ${l.active ? 'var(--ac)' : 'var(--bd-strong)'}`,
                    background: l.active ? 'var(--ac)' : 'var(--s-inset)',
                    position: 'relative',
                    display: 'block',
                    flex: 'none',
                    padding: 0,
                    cursor: canManage ? 'pointer' : 'default',
                  }}
                >
                  <span
                    style={{
                      position: 'absolute',
                      top: 1,
                      left: l.active ? 15 : 2,
                      width: 13,
                      height: 13,
                      borderRadius: 7,
                      background: l.active ? '#160A02' : 'var(--tx-muted)',
                      transition: 'left var(--dur-fast) var(--ease)',
                    }}
                  />
                </button>
              </span>
              {canManage && l.code !== REFERENCE ? (
                <button
                  type="button"
                  title={`Cancella ${l.code}`}
                  aria-label={`Cancella la lingua ${l.code}`}
                  disabled={remove.isPending}
                  onClick={() => askDelete(l, done)}
                  style={TRASH}
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="14"
                    height="14"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
                  </svg>
                </button>
              ) : (
                <span />
              )}
            </div>
          );
        })}
      </section>

      {adding ? (
        <AddLanguageDialog
          onClose={() => setAdding(false)}
          onCreated={async () => {
            setAdding(false);
            await invalidate();
          }}
        />
      ) : null}
    </>
  );
}

/**
 * «Nuova lingua»: codice e nome. Il resto — attivarla, riempirla — viene dopo,
 * e ha ognuno il suo posto.
 */
function AddLanguageDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => Promise<void> }) {
  const [code, setCode] = useState('');
  const [display, setDisplay] = useState('');
  const [error, setError] = useState<string | null>(null);

  const codeOk = /^[a-z]{2}$/.test(code);
  const ready = codeOk && display.trim() !== '';

  const create = useMutation({
    mutationFn: () => api<Language>('/api/lang/language', { method: 'POST', body: { code, display } }),
    onSuccess: onCreated,
    onError: (err) =>
      setError(
        err instanceof ApiError && err.status === 409
          ? 'Esiste già una lingua con questo codice.'
          : 'Creazione non riuscita.',
      ),
  });

  return (
    <Modal
      title="Nuova lingua"
      subtitle="La lingua nasce vuota: le chiavi non tradotte ricadono sull’inglese."
      width={560}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} style={{ ...GHOST, height: 36, fontSize: 13 }}>
            Annulla
          </button>
          <button
            type="button"
            disabled={!ready || create.isPending}
            onClick={() => create.mutate()}
            style={{
              ...PRIMARY,
              height: 36,
              fontSize: 13,
              fontWeight: 600,
              ...(!ready || create.isPending ? DISABLED : {}),
            }}
          >
            {create.isPending ? 'Creo…' : 'Aggiungi lingua'}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <label htmlFor="lang-code" style={LABEL}>
            Codice
          </label>
          <input
            id="lang-code"
            value={code}
            onChange={(e) => setCode(e.target.value.toLowerCase())}
            placeholder="es. fr"
            maxLength={2}
            style={FIELD}
          />
          <div style={HINT}>Due lettere minuscole, come le altre lingue.</div>
        </div>
        <div>
          <label htmlFor="lang-display" style={LABEL}>
            Nome visualizzato
          </label>
          <input
            id="lang-display"
            value={display}
            onChange={(e) => setDisplay(e.target.value)}
            placeholder="es. <white>Français"
            style={FIELD}
          />
          <div style={HINT}>MiniMessage: è il nome che i giocatori vedono nel menu.</div>
          {display.trim() !== '' ? (
            <div
              style={{
                marginTop: 8,
                padding: '8px 11px',
                border: '1px solid var(--bd-subtle)',
                borderRadius: 'var(--r-sm)',
                background: 'var(--s-inset)',
              }}
            >
              <MiniSource text={display} size={13} tags={false} />
            </div>
          ) : null}
        </div>
        {error === null ? null : <div style={{ fontSize: 12.5, color: 'var(--err)' }}>{error}</div>}
      </div>
    </Modal>
  );
}

/**
 * Il nome com'e' scritto: si legge coi colori, e cliccandolo si scrive.
 * Invio salva, Esc lascia com'era, e uscire dal campo salva se e' cambiato.
 */
function DisplayName({
  value,
  editable,
  onSave,
}: {
  value: string;
  editable: boolean;
  onSave: (display: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  const commit = (): void => {
    const next = draft?.trim() ?? '';
    setDraft(null);
    if (next !== '' && next !== value) onSave(next);
  };

  if (draft !== null) {
    return (
      <input
        // Compare perche' lo si e' appena cliccato: il fuoco va col montaggio,
        // e il testo tutto selezionato per riscriverlo da capo.
        // biome-ignore lint/a11y/noAutofocus: il campo compare perche' lo si e' appena cliccato
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setDraft(null);
        }}
        aria-label="Nome visualizzato"
        spellCheck={false}
        style={{ ...FIELD, height: 30, fontSize: 12 }}
      />
    );
  }
  return (
    <button
      type="button"
      disabled={!editable}
      title={editable ? 'Clicca per rinominare' : undefined}
      onClick={() => setDraft(value)}
      style={{
        display: 'block',
        width: '100%',
        minWidth: 0,
        padding: '4px 6px',
        margin: '-4px -6px',
        border: '1px solid transparent',
        borderRadius: 'var(--r-sm)',
        background: 'transparent',
        textAlign: 'left',
        cursor: editable ? 'text' : 'default',
        font: 'inherit',
        color: 'inherit',
      }}
    >
      <MiniSource text={value} size={12} />
    </button>
  );
}

const TRASH: React.CSSProperties = {
  width: 28,
  height: 28,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: '1px solid transparent',
  borderRadius: 'var(--r-sm)',
  background: 'transparent',
  color: 'var(--tx-muted)',
  cursor: 'pointer',
  padding: 0,
};

const PANEL: React.CSSProperties = {
  border: '1px solid var(--bd-subtle)',
  borderRadius: 'var(--r-lg)',
  background: 'var(--s-surface)',
  overflow: 'hidden',
};

const ROW: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '44px 72px minmax(190px,1.2fr) minmax(150px,1fr) minmax(130px,.9fr) 40px 28px',
  gap: '12px 28px',
  borderBottom: '1px solid var(--bd-subtle)',
};

const ARROW: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'var(--tx-muted)',
  fontSize: 8,
  lineHeight: '10px',
  padding: 0,
  cursor: 'pointer',
};

const LABEL: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--tx-secondary)',
  marginBottom: 7,
};

const FIELD: React.CSSProperties = {
  width: '100%',
  height: 38,
  padding: '0 12px',
  border: '1px solid var(--bd-subtle)',
  borderRadius: 'var(--r-sm)',
  background: 'var(--s-inset)',
  color: 'var(--tx-primary)',
  fontFamily: 'var(--font-mono)',
  fontSize: 13,
  outline: 'none',
  boxSizing: 'border-box',
};

const HINT: React.CSSProperties = { marginTop: 7, fontSize: 11.5, color: 'var(--tx-muted)' };
