// Svetlana, il pannello. Le misure vengono da `frontend/3-app-shell.dc.html`.
//
// E' un PANNELLO DENTRO IL GUSCIO, non una schermata: sta sopra a qualunque
// pagina, e la barra sotto il nome dice quale. E' il motivo per cui esiste —
// «e i duels di ieri?» ha senso solo sapendo dove si trova chi lo chiede.
//
// L'ETICHETTA «Contesto automatico attivo · solo lettura» NON E' DECORAZIONE.
// Dice due cose vere della versione 1: che la pagina corrente viene mandata a
// ogni messaggio, e che Svetlana non modifica niente. La prima e' una cosa che
// chi scrive ha diritto di sapere; la seconda e' cio' che rende ragionevole
// fidarsi di una chat dentro un pannello di amministrazione.
//
// LO STATO DELLA CHAT NON E' QUI: sta in `lib/svetlana.ts`, con i suoi test.
// Qui c'e' solo il disegno e la connessione.

import { useCallback, useEffect, useRef, useState } from 'react';
import { csrfToken, type Me } from '../lib/api.ts';
import { canOpen } from '../lib/modules.ts';
import { richText, type Span } from '../lib/rich-text.ts';
import { applyEvent, askedState, initialState, readChunk, type SvState, toolLabel } from '../lib/svetlana.ts';

/** Il colore del testo sull'accento. Lo stesso dei pulsanti del pannello. */
const ON_ACCENT = '#160A02';

/** Di quanto e in che direzione sposta ogni freccia. */
const MOVES: Record<string, { x: number; y: number } | undefined> = {
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
};

export type SvetlanaPage = {
  /** Il percorso della schermata aperta. Il TITOLO lo sceglie il server. */
  path: string;
  /** Il breadcrumb, per la riga «Sta guardando». */
  breadcrumb: string;
  range?: string | undefined;
  mode?: string | undefined;
};

export function Svetlana({ me, page }: { me: Me; page: SvetlanaPage }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<{ mx: number; my: number; startX: number; startY: number } | null>(null);
  const [input, setInput] = useState('');
  const [state, setState] = useState<SvState>(initialState);
  const boxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Il trascinamento vive su `window` e non sul riquadro: staccando il mouse
  // fuori dal bordo, un listener attaccato al riquadro non riceverebbe piu'
  // niente e la finestra resterebbe incollata al cursore.
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: MouseEvent) =>
      setPos({ x: drag.startX + (e.clientX - drag.mx), y: drag.startY + (e.clientY - drag.my) });
    const onUp = () => setDrag(null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [drag]);

  // Si scende in fondo a ogni parola che arriva: una risposta che si forma
  // sopra il bordo visibile e' una risposta che non si legge.
  // biome-ignore lint/correctness/useExhaustiveDependencies: dipende dal contenuto, non da un riferimento
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [state.messages, state.streaming, state.tool]);

  // La richiesta in volo si annulla quando il pannello si chiude o la pagina
  // cambia: e' una richiesta che si sta pagando.
  useEffect(() => () => abortRef.current?.abort(), []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (text === '' || state.busy) return;
    setInput('');
    setState((s) => askedState(s, text));

    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;

    try {
      const csrf = csrfToken();
      const res = await fetch('/api/stream/assistant', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
        },
        credentials: 'same-origin',
        signal: controller.signal,
        body: JSON.stringify({
          ...(state.conversationId ? { conversationId: state.conversationId } : {}),
          text,
          page: {
            path: page.path,
            ...(page.range ? { range: page.range } : {}),
            ...(page.mode ? { mode: page.mode } : {}),
          },
        }),
      });

      if (!res.ok || !res.body) {
        // Il server risponde JSON quando rifiuta PRIMA di aprire lo stream:
        // assistente spento, tetto di spesa, limite di frequenza. Il dettaglio
        // e' scritto per essere letto da chi guarda, quindi si mostra.
        const detail = await res
          .json()
          .then((body: { detail?: string; error?: string }) => body.detail ?? body.error)
          .catch(() => undefined);
        setState((s) => ({
          ...s,
          busy: false,
          streaming: null,
          error: detail ?? 'Non sono riuscita a rispondere.',
        }));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let carry = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = readChunk(carry, decoder.decode(value, { stream: true }));
        carry = chunk.carry;
        // Un `setState` per pacchetto e non per evento: dentro lo stesso
        // pacchetto arrivano piu' delta, e React li raggrupperebbe comunque.
        for (const event of chunk.events) setState((s) => applyEvent(s, event));
      }
      // Se lo stream si chiude senza `done` — connessione caduta a meta' — la
      // risposta parziale resta appesa. Si chiude a mano, altrimenti il campo
      // di testo resta disabilitato per sempre.
      setState((s) =>
        s.busy ? applyEvent(s, { type: 'done', usage: null, iterations: 0, truncated: false }) : s,
      );
    } catch {
      // Un annullamento non e` un guasto: succede chiudendo il pannello o
      // mandando la domanda dopo, ed e` voluto.
      if (controller.signal.aborted) return;
      setState((s) => ({
        ...s,
        busy: false,
        streaming: null,
        error: 'Il collegamento si è interrotto. Riprova.',
      }));
    }
  }, [input, page, state.busy, state.conversationId]);

  // Il modulo si concede e si toglie: chi non ce l'ha non vede nemmeno il
  // pulsante. Non e' sicurezza — quella sta sulla rotta — e' che una manopola
  // che porta a un rifiuto insegna a non fidarsi di quelle che funzionano.
  if (!canOpen(me, 'assistente')) return null;

  const windowStyle: React.CSSProperties = pos
    ? {
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        right: 'auto',
        bottom: 'auto',
      }
    : // Non trascinata, la finestra e' un figlio della colonna: il contenitore
      // la mette sopra il pulsante, allineata a destra, con i suoi 10px di
      // stacco. Il mockup ottiene lo stesso risultato con `bottom:64px`, che
      // pero' dipende da quale antenato faccia da blocco contenitore — e con
      // `position:fixed` quell'antenato e' la finestra del browser, non la
      // colonna. Lasciarlo al flex e' la stessa figura senza quella scommessa.
      {};

  return (
    <div
      style={{
        position: 'fixed',
        // Le misure vengono da `app.css`, e non sono scritte qui, perché lo
        // stesso numero serve a `--fab-clear`: è lo spazio che `main` tiene
        // libero in fondo perché il pallino non copra le frecce di
        // paginazione. Due copie dello stesso 24 sono due copie che prima o
        // poi divergono, e quando divergono il click smette di arrivare.
        bottom: 'var(--fab-gap)',
        right: 'var(--fab-gap)',
        zIndex: 80,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: 10,
      }}
    >
      {open ? (
        <div
          ref={boxRef}
          style={{
            width: 340,
            height: 440,
            display: 'flex',
            flexDirection: 'column',
            border: '1px solid var(--bd-strong)',
            borderRadius: 'var(--r-lg)',
            background: 'var(--s-overlay)',
            boxShadow: 'var(--e3)',
            overflow: 'hidden',
            ...windowStyle,
          }}
        >
          {/* Intestazione, che e' anche la maniglia.
              SI SPOSTA ANCHE CON LE FRECCE, e non e' una concessione a una
              regola di lint: un pannello che copre proprio il numero che si
              sta leggendo si sposta col mouse, e chi non usa il mouse
              resterebbe senza. Sono sei righe. */}
          {/* biome-ignore lint/a11y/useSemanticElements: la maniglia contiene gia' il pulsante di chiusura, e un button dentro un button non e' HTML valido */}
          <div
            role="button"
            tabIndex={0}
            aria-label="Sposta il pannello di Svetlana: usa le frecce"
            onMouseDown={(e) => {
              const box = boxRef.current;
              if (!box) return;
              e.preventDefault();
              const r = box.getBoundingClientRect();
              setPos({ x: r.left, y: r.top });
              setDrag({ mx: e.clientX, my: e.clientY, startX: r.left, startY: r.top });
            }}
            onKeyDown={(e) => {
              const step = e.shiftKey ? 40 : 10;
              const delta = MOVES[e.key];
              if (!delta) return;
              const box = boxRef.current;
              if (!box) return;
              e.preventDefault();
              const r = box.getBoundingClientRect();
              const from = pos ?? { x: r.left, y: r.top };
              setPos({ x: from.x + delta.x * step, y: from.y + delta.y * step });
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '12px 14px',
              borderBottom: '1px solid var(--bd-subtle)',
              cursor: 'grab',
              userSelect: 'none',
            }}
          >
            <div
              style={{
                width: 30,
                height: 30,
                borderRadius: 'var(--r-full)',
                background: 'var(--ac-soft)',
                border: '1px solid var(--bd-subtle)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flex: 'none',
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 12,
                  fontWeight: 700,
                  color: 'var(--ac-text)',
                }}
              >
                S
              </span>
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 13, fontWeight: 700 }}>Svetlana</div>
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--tx-muted)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                Sta guardando: {page.breadcrumb}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Chiudi Svetlana"
              style={{
                width: 26,
                height: 26,
                flex: 'none',
                border: '1px solid var(--bd-subtle)',
                borderRadius: 'var(--r-sm)',
                background: 'var(--s-inset)',
                color: 'var(--tx-muted)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
              }}
            >
              <svg
                viewBox="0 0 24 24"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M18 6 6 18" />
                <path d="M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Lo stato reale della v1, non un ornamento. */}
          <div
            style={{
              padding: '8px 14px',
              borderBottom: '1px solid var(--bd-subtle)',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: 'var(--r-full)', background: 'var(--ok)' }} />
            <span style={{ fontSize: 11, color: 'var(--tx-muted)' }}>
              Contesto automatico attivo · solo lettura
            </span>
          </div>

          <div
            ref={listRef}
            aria-live="polite"
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: 14,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            {state.messages.map((m) => (
              <Bubble key={m.id} from={m.from} text={m.text} />
            ))}
            {state.streaming !== null && state.streaming !== '' ? (
              <Bubble from="bot" text={state.streaming} />
            ) : null}
            {state.tool ? (
              <div style={{ fontSize: 11, color: 'var(--tx-muted)', paddingLeft: 2 }}>
                {toolLabel(state.tool)}…
              </div>
            ) : null}
            {state.busy && state.streaming === '' && !state.tool ? (
              <div style={{ fontSize: 11, color: 'var(--tx-muted)', paddingLeft: 2 }}>sto pensando…</div>
            ) : null}
            {state.error ? (
              <div
                style={{
                  fontSize: 12,
                  lineHeight: '17px',
                  color: 'var(--err-text)',
                  background: 'var(--err-soft)',
                  border: '1px solid var(--bd-subtle)',
                  borderRadius: 'var(--r-sm)',
                  padding: '8px 10px',
                }}
              >
                {state.error}
              </div>
            ) : null}
          </div>

          <div
            style={{
              padding: 10,
              borderTop: '1px solid var(--bd-subtle)',
              display: 'flex',
              gap: 8,
            }}
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void send();
              }}
              disabled={state.busy}
              maxLength={2000}
              placeholder="Chiedi qualcosa a Svetlana…"
              aria-label="Chiedi qualcosa a Svetlana"
              style={{
                flex: 1,
                minWidth: 0,
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
            <button
              type="button"
              onClick={() => void send()}
              disabled={state.busy || input.trim() === ''}
              aria-label="Invia"
              style={{
                width: 36,
                height: 36,
                flex: 'none',
                border: 'none',
                borderRadius: 'var(--r-sm)',
                background: 'var(--ac)',
                color: ON_ACCENT,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: state.busy || input.trim() === '' ? 'default' : 'pointer',
                opacity: state.busy || input.trim() === '' ? 0.55 : 1,
              }}
            >
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m22 2-7 20-4-9-9-4Z" />
                <path d="M22 2 11 13" />
              </svg>
            </button>
          </div>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? 'Chiudi Svetlana' : 'Apri Svetlana'}
        aria-expanded={open}
        style={{
          // Stessa ragione di `--fab-gap`: la misura la conosce `app.css`,
          // che è anche l'unico posto che sa quanto spazio lasciare sotto.
          width: 'var(--fab-size)',
          height: 'var(--fab-size)',
          border: '1px solid var(--bd-strong)',
          borderRadius: 'var(--r-full)',
          background: 'var(--s-elevated)',
          boxShadow: 'var(--e3)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          position: 'relative',
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: -2,
            right: -2,
            width: 11,
            height: 11,
            borderRadius: 'var(--r-full)',
            background: 'var(--ok)',
            border: '2px solid var(--s-base)',
          }}
        />
        <span
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 16,
            fontWeight: 700,
            color: 'var(--ac-text)',
          }}
        >
          S
        </span>
      </button>
    </div>
  );
}

/** Una bolla. Le due forme differiscono per l'angolo, come nel mockup. */
function Bubble({ from, text }: { from: 'bot' | 'user'; text: string }) {
  const mine = from === 'user';
  return (
    <div style={{ display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start' }}>
      <div
        style={{
          maxWidth: '78%',
          padding: '9px 12px',
          borderRadius: mine
            ? 'var(--r-md) var(--r-md) 2px var(--r-md)'
            : 'var(--r-md) var(--r-md) var(--r-md) 2px',
          background: mine ? 'var(--ac-soft)' : 'var(--s-inset)',
          ...(mine ? {} : { border: '1px solid var(--bd-subtle)' }),
          color: mine ? 'var(--tx-primary)' : 'var(--tx-secondary)',
          fontSize: 13,
          lineHeight: '19px',
          // Una riga lunga si spezza invece di allargare la bolla. Gli a capo
          // NON vengono piu' da `pre-wrap`: adesso li disegna `richText`, riga
          // per riga, perche' un elenco ha bisogno di un rientro e `pre-wrap`
          // non sa rientrare niente.
          overflowWrap: 'anywhere',
        }}
      >
        {/* La domanda dell'utente e' la sua, e si mostra COM'E' SCRITTA: se
            qualcuno scrive due asterischi, ha scritto due asterischi. La
            formattazione si legge solo dove serve, cioe' nelle risposte. */}
        {mine ? text : <Formatted text={text} />}
      </div>
    </div>
  );
}

/**
 * Il poco Markdown che il modello produce davvero, disegnato con React.
 *
 * Nessun `dangerouslySetInnerHTML` e nessuna marcatura costruita a mano: qui
 * arrivano dati, ed escono elementi. E' cio' che rende impossibile — e non
 * soltanto improbabile — che il testo citato da un giocatore diventi qualcosa
 * di piu' di testo. Vedi `web/src/lib/rich-text.ts` per il perche' i link non
 * si fanno.
 */
function Formatted({ text }: { text: string }) {
  return (
    <>
      {richText(text).map((line, i) => {
        // L'indice come chiave: le righe non hanno identita' propria e
        // l'elenco si ridisegna intero a ogni pacchetto dello streaming.
        const key = `${i}`;
        if (line.kind === 'blank') return <div key={key} style={{ height: 8 }} />;

        const spans = <Spans spans={line.spans} />;
        if (line.kind === 'heading') {
          return (
            <div
              key={key}
              style={{ fontWeight: 600, color: 'var(--tx-primary)', marginTop: i === 0 ? 0 : 6 }}
            >
              {spans}
            </div>
          );
        }
        if (line.kind === 'text') return <div key={key}>{spans}</div>;

        // Elenchi: il segno sta in una colonna sua, cosi' una riga che va a
        // capo si allinea sotto il testo e non sotto il pallino.
        const marker = line.kind === 'bullet' ? '•' : line.marker;
        return (
          <div key={key} style={{ display: 'flex', gap: 6 }}>
            <span style={{ flex: 'none', opacity: 0.7 }}>{marker}</span>
            <span>{spans}</span>
          </div>
        );
      })}
    </>
  );
}

function Spans({ spans }: { spans: readonly Span[] }) {
  return (
    <>
      {spans.map((span, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: un pezzo di riga non ha identita` propria e in streaming la riga si rimonta da capo a ogni pacchetto
          key={`${i}:${span.text}`}
          style={{
            ...(span.bold ? { fontWeight: 600, color: 'var(--tx-primary)' } : {}),
            ...(span.italic ? { fontStyle: 'italic' } : {}),
            ...(span.code
              ? {
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                  background: 'var(--s-elevated)',
                  borderRadius: 4,
                  padding: '1px 4px',
                }
              : {}),
          }}
        >
          {span.text}
        </span>
      ))}
    </>
  );
}
