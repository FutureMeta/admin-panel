// Una riga MiniMessage a pezzi disegnabili: il conto, senza React.
//
// STA IN UN MODULO SENZA JSX perche' lo provano i test — che compilano sotto
// il tsconfig del server, dove il JSX non esiste — e perche' e' l'unica logica
// vera di `mini-text.tsx`: il resto e' un ciclo di `<span>`.

import { PLACEHOLDER, paint, renderMiniMessage, validateMiniMessage } from './minimessage.ts';

/** Lo stile come coppie chiave-valore: chi disegna lo passa a React. */
export type SpanStyle = Record<string, string | number>;

export type Span = { text: string; style: SpanStyle; title?: string };

/**
 * Una riga, a pezzi disegnabili.
 *
 * TRE STRATI, in quest'ordine: gli errori (che vincono su tutto), i tag, e
 * dentro il testo i segnaposto. L'invariante e' la stessa dell'editor —
 * rimettendo insieme i pezzi si riottiene la riga — anche se qui non c'e' una
 * textarea sotto: e' cio' che permette di far combaciare gli errori, che
 * arrivano come posizioni nel testo, con i pezzi, che arrivano come stringhe.
 */
export function lineSpans(line: string, size: number, tags = true): Span[] {
  const issues = validateMiniMessage(line);
  const badAt = new Map<number, string>();
  let cutAt = -1;
  for (const issue of issues) {
    if (issue.reason.startsWith('tag non chiuso'))
      cutAt = cutAt === -1 ? issue.at : Math.min(cutAt, issue.at);
    else badAt.set(issue.at, issue.reason);
  }

  // Da un tag mai terminato in poi e' tutto errore: si disegna cosi', e il
  // resto della riga non prova nemmeno a vestirsi.
  const head = cutAt === -1 ? line : line.slice(0, cutAt);
  const spans: Span[] = [];
  let at = 0;

  for (const piece of renderMiniMessage(head)) {
    const start = at;
    at += piece.text.length;

    if (piece.tag) {
      // Senza i tag resta il messaggio come lo vede il giocatore: e' la
      // colonna «reso» dell'elenco lingue. Un tag ROTTO si mostra lo stesso,
      // perche' in gioco non sparirebbe — sparirebbe tutto il testo.
      const reason = badAt.get(start);
      if (!tags && reason === undefined) continue;
      spans.push({
        text: piece.text,
        style:
          reason === undefined
            ? { color: 'var(--yml-tag)' }
            : {
                color: 'var(--err)',
                background: 'var(--err-soft)',
                textDecoration: 'underline',
                padding: '0 2px',
              },
        ...(reason === undefined ? {} : { title: reason }),
      });
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

  if (cutAt !== -1) {
    spans.push({
      text: line.slice(cutAt),
      style: {
        color: 'var(--err)',
        background: 'var(--err-soft)',
        textDecoration: 'underline',
        padding: '0 2px',
      },
      title: 'tag non chiuso: manca il `>`',
    });
  }

  return spans.map((s) => ({ ...s, style: { ...s.style, fontSize: size } }));
}
