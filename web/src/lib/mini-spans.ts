// Una riga MiniMessage a pezzi disegnabili: il conto, senza React.
//
// STA IN UN MODULO SENZA JSX perche' lo provano i test — che compilano sotto
// il tsconfig del server, dove il JSX non esiste — e perche' e' l'unica logica
// vera di `mini-text.tsx`: il resto e' un ciclo di `<span>`.
//
// NON GIUDICA I TAG. `<player>`, `<server>` e gli altri li risolve il plugin,
// e il pannello non ha la lista: un tag e' un tag, grigio, e il testo dopo
// prende lo stile che il parser gli da'.

import { PLACEHOLDER, paint, renderMiniMessage } from './minimessage.ts';

/** Lo stile come coppie chiave-valore: chi disegna lo passa a React. */
export type SpanStyle = Record<string, string | number>;

export type Span = { text: string; style: SpanStyle; title?: string };

/**
 * Una riga, a pezzi disegnabili.
 *
 * DUE STRATI: i tag, e dentro il testo i segnaposto. L'invariante e' la stessa
 * dell'editor — rimettendo insieme i pezzi si riottiene la riga.
 */
export function lineSpans(line: string, size: number, tags = true): Span[] {
  const spans: Span[] = [];

  for (const piece of renderMiniMessage(line)) {
    if (piece.tag) {
      // Senza i tag resta il messaggio come lo vede il giocatore: e' la
      // colonna «reso» dell'elenco lingue.
      if (tags) spans.push({ text: piece.text, style: { color: 'var(--yml-tag)' } });
      continue;
    }

    const base: SpanStyle = {
      ...(piece.style.colour === undefined ? { color: 'var(--tx-primary)' } : paint(piece.style.colour)),
      ...(piece.style.bold === true ? { WebkitTextStroke: '0.25px' } : {}),
      ...(piece.style.italic === true ? { fontStyle: 'italic' } : {}),
      ...(piece.style.underlined === true ? { textDecoration: 'underline' } : {}),
      ...(piece.style.strikethrough === true ? { textDecoration: 'line-through' } : {}),
    };

    // I segnaposto si staccano dal testo che li circonda e tengono il peso
    // del testo — sono dentro la frase — ma prendono il loro fondo.
    let last = 0;
    for (const m of piece.text.matchAll(PLACEHOLDER)) {
      if (m.index > last) spans.push({ text: piece.text.slice(last, m.index), style: base });
      spans.push({
        text: m[0],
        style: {
          ...base,
          color: 'var(--tx-primary)',
          background: 'var(--blu-soft)',
          fontWeight: 600,
          padding: '0 3px',
        },
        title: 'segnaposto: lo sostituisce il gioco',
      });
      last = m.index + m[0].length;
    }
    if (last < piece.text.length) spans.push({ text: piece.text.slice(last), style: base });
  }

  return spans.map((s) => ({ ...s, style: { ...s.style, fontSize: size } }));
}
