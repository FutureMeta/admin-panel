// I pezzi che le quattro schermate di «Lingue» si passano.
//
// STANNO QUI E NON IN OGNUNA perche' sono le cose che devono restare uguali
// dappertutto: come si modifica un testo, come si legge un completamento, da
// dove si leggono e si scrivono i dati. Quattro copie divergono al
// terzo ritocco.

import type { QueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, api } from '../lib/api.ts';
import { type BundleKeys, heat, type Overview } from '../lib/lang.ts';
import { renderMiniMessage } from '../lib/minimessage.ts';
import { MiniSource } from './mini-text.tsx';

/** La panoramica: lingue e bundle. UNA chiave, cosi' ogni schermata legge la stessa cache. */
export const overviewQuery = { queryKey: ['lang'] as const, queryFn: () => api<Overview>('/api/lang') };

export const bundleQuery = (ns: string) => ({
  queryKey: ['lang-keys', ns] as const,
  queryFn: () => api<BundleKeys>(`/api/lang/keys?ns=${encodeURIComponent(ns)}`),
});

export const putValue = (body: { ns: string; key: string; code: string; value: string }) =>
  api<{ ok: true }>('/api/lang/value', { method: 'PUT', body });

/**
 * Dopo una scrittura: il bundle e la panoramica, che ne conta i testi.
 *
 * `counts: 'later'` dove i conteggi non si vedono — la traduzione e le
 * chiavi usano la panoramica solo per l'elenco delle lingue. La si segna
 * vecchia e si rilegge quando la si riapre, invece di rifare a ogni testo
 * salvato due GROUP BY su tutti i messaggi del database di gioco.
 */
export async function invalidateLang(
  queryClient: QueryClient,
  ns?: string,
  counts: 'now' | 'later' = 'now',
): Promise<void> {
  if (ns !== undefined) await queryClient.invalidateQueries({ queryKey: ['lang-keys', ns] });
  await queryClient.invalidateQueries({
    queryKey: ['lang'],
    ...(counts === 'later' ? { refetchType: 'none' } : {}),
  });
}

/**
 * Un testo appena salvato, scritto nella cache del bundle invece di rileggere
 * il bundle intero: nella traduzione si salva una chiave dopo l'altra, e ogni
 * salvataggio ricaricava tutte le chiavi in tutte le lingue. Il server salva
 * il testo com'e', quindi la copia locale e' quella vera.
 */
export function patchValue(
  queryClient: QueryClient,
  v: { ns: string; key: string; code: string; value: string },
): void {
  queryClient.setQueryData<BundleKeys>(['lang-keys', v.ns], (old) =>
    old
      ? {
          ...old,
          keys: old.keys.map((k) =>
            k.key === v.key ? { ...k, values: { ...k.values, [v.code]: v.value } } : k,
          ),
        }
      : old,
  );
  void queryClient.invalidateQueries({ queryKey: ['lang'], refetchType: 'none' });
}

/**
 * «Genera con l'AI»: una proposta di traduzione dall'inglese, da rivedere e
 * salvare come ogni altro testo. L'inglese lo legge il server.
 */
export const aiTranslate = (body: { ns: string; key: string; code: string }) =>
  api<{ text: string }>('/api/lang/translate', { method: 'POST', body });

const AI_ERRORS: Record<string, string> = {
  ai_non_configurata: 'L’AI non è configurata su questo pannello.',
  tetto_di_spesa: 'Il budget mensile dell’AI è finito: si traduce a mano fino al mese prossimo.',
  niente_da_tradurre: 'L’inglese non ha un testo per questa chiave.',
  formato_cambiato: 'L’AI ha cambiato tag o segnaposto anche al secondo tentativo: traducilo a mano.',
  rifiuto: 'L’AI si è rifiutata di tradurre questo testo.',
  incompleta: 'La risposta dell’AI è arrivata incompleta. Riprova.',
  ai_non_raggiungibile: 'L’AI non risponde adesso. Riprova tra poco.',
};

/** Cosa dire quando un salvataggio viene rifiutato. */
export function saveErrorText(err: unknown): string {
  if (err instanceof ApiError && err.code === 'COMANDO_NON_PREVISTO') {
    return 'Il testo contiene un comando cliccabile che il plugin non prevede per questa chiave: non si salva.';
  }
  if (err instanceof ApiError && err.code === 'TESTO_VUOTO') {
    return 'Un testo vuoto non si salva: per un messaggio senza contenuto scrivi <reset>.';
  }
  if (err instanceof ApiError && (err.isForbidden || err.isNotFound)) {
    return 'Non si può salvare: la chiave o la lingua non c’è più, o non hai più il permesso.';
  }
  return 'Salvataggio non riuscito. Riprova.';
}

/** Cosa dire quando «Genera con l'AI» non va. */
export function aiErrorText(err: unknown): string {
  if (err instanceof ApiError && err.isRateLimited)
    return 'Troppe richieste all’AI: riprova tra qualche minuto.';
  const code = err instanceof ApiError ? err.code : undefined;
  return (
    (code === undefined ? undefined : AI_ERRORS[code]) ?? 'L’AI non ha risposto. Riprova, o traduci a mano.'
  );
}

/** Il pulsante «Genera con l'AI»: la stella, e «Genero…» mentre aspetta. */
export function AiButton({
  busy,
  disabled = false,
  title,
  background,
  label = 'Genera con l’AI',
  onClick,
}: {
  busy: boolean;
  label?: string;
  disabled?: boolean;
  title?: string | undefined;
  /** Il fondo cambia con la card che lo ospita, come nel disegno. */
  background: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="lang-ai"
      disabled={busy || disabled}
      title={title}
      onClick={onClick}
      style={{
        marginLeft: 'auto',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        height: 26,
        padding: '0 10px',
        borderRadius: 'var(--r-sm)',
        background,
        fontFamily: 'var(--font-ui)',
        fontSize: 11.5,
        fontWeight: 600,
        cursor: busy || disabled ? 'default' : 'pointer',
        opacity: disabled && !busy ? 0.5 : 1,
      }}
    >
      <svg
        viewBox="0 0 24 24"
        width="12"
        height="12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ flex: 'none' }}
        aria-hidden="true"
      >
        <path d="M12 3.5l1.6 4.3 4.3 1.6-4.3 1.6-1.6 4.3-1.6-4.3-4.3-1.6 4.3-1.6zM18 16l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z" />
      </svg>
      {busy ? <span style={{ color: 'var(--ac-text)' }}>Genero…</span> : <span>{label}</span>}
    </button>
  );
}

/** La barra di completamento con la percentuale accanto. */
export function CompletionBar({ pct, width = 36 }: { pct: number; width?: number }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0, flex: 1 }}>
      <span style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--s-inset)', overflow: 'hidden' }}>
        <span style={{ display: 'block', height: '100%', background: heat(pct), width: `${pct}%` }} />
      </span>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11.5,
          color: 'var(--tx-primary)',
          fontVariantNumeric: 'tabular-nums',
          width,
          textAlign: 'right',
        }}
      >
        {pct}%
      </span>
    </span>
  );
}

/** L'etichetta di sezione in maiuscoletto, come in tutto il pannello. */
export function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: '.12em',
        textTransform: 'uppercase',
        color: 'var(--tx-muted)',
      }}
    >
      {children}
    </span>
  );
}

/**
 * Il campo di un testo: si legge con i colori, si scrive con la tastiera.
 *
 * UN SOLO CAMPO PER LINGUA, che e' la regola della sezione. A riposo mostra
 * il sorgente vestito — tag in grigio, testo nel suo colore, segnaposto a
 * parte; cliccato, diventa una textarea con lo stesso testo; lasciato, torna
 * a vestirsi. Non c'e' una textarea trasparente sopra al colore come
 * nell'editor dei config: qui i segnaposto hanno un riquadro loro, largo
 * qualche pixel piu' del testo, e le due righe non combacerebbero.
 *
 * VUOTO E' UNO STATO, non un campo vuoto: «Nessun valore per questa lingua»
 * in un riquadro tratteggiato, che si clicca per cominciare.
 */
export function MiniField({
  value,
  onChange,
  readOnly = false,
  tone = 'neutral',
}: {
  value: string;
  onChange: (next: string) => void;
  readOnly?: boolean;
  /** Il bordo: dice se sotto c'e' un errore, prima ancora di leggerlo. */
  tone?: 'neutral' | 'err';
}) {
  const [editing, setEditing] = useState(false);

  const border = tone === 'err' ? 'var(--err)' : 'var(--bd-strong)';

  if (editing && !readOnly) {
    return (
      <textarea
        // Il fuoco arriva COL montaggio, non in un effetto dopo: chi clicca e
        // preme subito Ctrl+A deve trovare il testo selezionabile, e un
        // effetto arriva un disegno dopo il tasto. `onFocus` porta il cursore
        // in fondo, che e' dove si comincia a scrivere.
        // biome-ignore lint/a11y/noAutofocus: il campo compare perche' lo si e' appena cliccato
        autoFocus
        onFocus={(e) =>
          e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)
        }
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => setEditing(false)}
        rows={Math.max(2, value.split('\n').length + 1)}
        spellCheck={false}
        placeholder="Scrivi il testo…"
        className="code-area"
        style={{
          width: '100%',
          boxSizing: 'border-box',
          padding: '10px 12px',
          border: `1px solid ${border}`,
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
    );
  }

  if (value === '') {
    return (
      <button
        type="button"
        disabled={readOnly}
        onClick={() => setEditing(true)}
        style={{
          width: '100%',
          textAlign: 'left',
          padding: '10px 12px',
          border: '1px dashed var(--bd-subtle)',
          borderRadius: 'var(--r-sm)',
          background: 'transparent',
          color: 'var(--tx-muted)',
          fontFamily: 'var(--font-ui)',
          fontSize: 12,
          cursor: readOnly ? 'default' : 'text',
        }}
      >
        Nessun valore per questa lingua: in gioco si vede l’inglese.
        {readOnly ? null : <span style={{ color: 'var(--tx-disabled)' }}> Clicca per scriverlo.</span>}
      </button>
    );
  }

  return (
    <button
      type="button"
      disabled={readOnly}
      onClick={() => setEditing(true)}
      title={readOnly ? undefined : 'Clicca per modificare: compaiono i tag'}
      style={{
        width: '100%',
        textAlign: 'left',
        padding: '10px 12px',
        border: `1px solid ${border}`,
        borderRadius: 'var(--r-sm)',
        background: 'var(--s-inset)',
        cursor: readOnly ? 'default' : 'text',
        font: 'inherit',
        color: 'inherit',
      }}
    >
      {/* A riposo si legge il messaggio come in gioco, senza i tag: quelli
          compaiono nel campo appena si clicca. Un valore fatto SOLO di tag —
          `<reset>` — senza di loro sarebbe una riga vuota, e allora si mostra
          com'e'. */}
      <MiniSource text={value} tags={renderMiniMessage(value).every((p) => p.tag)} />
    </button>
  );
}

/** L'avviso sotto un campo: un punto colorato e una riga. */
export function FieldNotice({ tone, children }: { tone: 'err' | 'info'; children: React.ReactNode }) {
  const colour = tone === 'err' ? 'var(--err)' : 'var(--blu-viz)';
  const soft = tone === 'err' ? 'var(--err-soft)' : 'var(--blu-soft)';
  const line = tone === 'err' ? 'rgba(219,52,52,.4)' : 'rgba(63,163,212,.4)';
  return (
    <div
      style={{
        marginTop: 9,
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '9px 11px',
        border: `1px solid ${line}`,
        borderRadius: 'var(--r-sm)',
        background: soft,
      }}
    >
      <span
        style={{ width: 6, height: 6, borderRadius: 'var(--r-full)', background: colour, flex: 'none' }}
      />
      <span style={{ fontSize: 12, color: 'var(--tx-primary)' }}>{children}</span>
    </div>
  );
}

/** Il riquadro di errore non bloccante, con «Riprova». */
export function RetryBanner({ title, body, onRetry }: { title: string; body: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '13px 16px',
        border: '1px solid rgba(219,52,52,.4)',
        borderRadius: 'var(--r-md)',
        background: 'var(--err-soft)',
        flexWrap: 'wrap',
      }}
    >
      <span
        style={{ width: 7, height: 7, borderRadius: 'var(--r-full)', background: 'var(--err)', flex: 'none' }}
      />
      <span style={{ fontSize: 12.5, color: 'var(--tx-primary)', fontWeight: 600 }}>{title}</span>
      <span style={{ fontSize: 12, color: 'var(--tx-secondary)' }}>{body}</span>
      <button
        type="button"
        onClick={onRetry}
        style={{
          marginLeft: 'auto',
          height: 30,
          padding: '0 12px',
          border: '1px solid var(--bd-strong)',
          borderRadius: 'var(--r-sm)',
          background: 'var(--s-surface)',
          color: 'var(--tx-primary)',
          fontFamily: 'var(--font-ui)',
          fontSize: 12,
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        Riprova
      </button>
    </div>
  );
}
