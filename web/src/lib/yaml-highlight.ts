// I colori dell'editor YAML: chiavi, stringhe, numeri, commenti.
//
// PERCHE' SCRITTO E NON IMPORTATO. Le librerie di evidenziazione che si usano
// di solito — Prism, highlight.js — restituiscono HTML da mettere dentro un
// nodo, e `dangerouslySetInnerHTML` in questo pannello lo ferma una regola di
// CI (SEC-35). CodeMirror non avrebbe quel problema, ma porta con se' un
// editor intero: sostituirebbe il riquadro che viene dal mockup, e sarebbero
// trecento kilobyte per del colore. Qui esce DATO — un elenco di pezzi con la
// loro natura — e a disegnarlo ci pensa React, come per `rich-text.ts`.
//
// L'INVARIANTE CHE TIENE IN PIEDI TUTTO: rimettendo insieme i pezzi di una
// riga si riottiene la riga, carattere per carattere. Il colore si disegna
// dietro a un `<textarea>` trasparente, e i due strati devono stare
// sovrapposti: un solo carattere perso qui sposterebbe tutto il resto della
// riga di una colonna, e il testo si vedrebbe doppio. E' l'unico modo in cui
// questo file puo' rompere qualcosa, ed e' provato in
// `tests/acceptance/92-yaml-highlight.test.ts`.
//
// I TAG MINIMESSAGE LI RISOLVE `minimessage.ts`: qui si decide che un pezzo
// di riga e' testo, li' si decide di che colore sara' in gioco.
//
// NON E' UN PARSER YAML e non deve diventarlo. Non valida, non si lamenta, non
// costruisce niente: guarda una riga alla volta e decide di che colore
// dipingerla. Su una riga che non capisce ripiega su `plain`, che e' il colore
// del testo normale — cioe' esattamente quello che si vedeva prima.

import { renderMiniMessage, type Style } from './minimessage.ts';

export type TokenKind =
  /** Il nome prima dei due punti. */
  | 'key'
  /** Fra apici o virgolette. */
  | 'string'
  | 'number'
  /** `true`, `false`, `null`, `~`. */
  | 'literal'
  | 'comment'
  /** I due punti, i trattini di elenco, gli indicatori di blocco. */
  | 'punct'
  /** `&ancora` e `*riferimento`. */
  | 'anchor'
  /** Un codice di formattazione: `<red>`, `<#FF5C5C>`, `&a`. */
  | 'code'
  /** Tutto il resto, spazi compresi. */
  | 'plain';

export type Token = {
  kind: TokenKind;
  text: string;
  /**
   * Come sara' scritto in gioco, quando il pezzo sta dentro del testo: il
   * colore che i tag MiniMessage gli danno, il grassetto, il corsivo. Assente
   * su tutto cio' che testo non e' — chiavi, numeri, commenti.
   */
  style?: Style;
};

/**
 * Aggiunge del testo, applicandogli la formattazione MiniMessage.
 *
 * SOLO DENTRO LE STRINGHE E IL TESTO SEMPLICE. In un commento `<red>` sono
 * cinque caratteri di prosa, e in una chiave non ci arriva mai: applicarlo li'
 * vorrebbe dire colorare di rosso un commento che parla del rosso.
 */
function pushText(out: Token[], kind: TokenKind, text: string): void {
  if (text === '') return;
  if (kind !== 'string' && kind !== 'plain') {
    out.push({ kind, text });
    return;
  }
  for (const piece of renderMiniMessage(text)) {
    out.push({ kind: piece.tag ? 'code' : kind, text: piece.text, style: piece.style });
  }
}

/** Una stringa fra virgolette o apici, con la sua chiusura se c'e'. */
const QUOTED = /^("(?:[^"\\]|\\.)*"?|'(?:[^']|'')*'?)/;
/** `chiave:` — anche fra virgolette, anche vuota. Il `:` vuole spazio o fine. */
const KEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:#\s][^:#]*|)(:)(?=\s|$)/;
/** `|`, `>`, con i loro indicatori: apre un blocco di testo libero. */
const BLOCK = /^([|>][+-]?\d*)(\s*)$/;
const NUMBER = /^[-+]?(?:\d[\d_]*)(?:\.\d+)?(?:[eE][-+]?\d+)?$/;
const LITERAL = /^(?:true|false|yes|no|on|off|null|~|Null|NULL|True|False|None)$/;

/** Il valore dopo i due punti, o l'elemento di un elenco senza chiave. */
function value(out: Token[], rest: string): { block: boolean } {
  if (rest === '') return { block: false };

  if (rest.startsWith('#')) {
    out.push({ kind: 'comment', text: rest });
    return { block: false };
  }

  const block = BLOCK.exec(rest);
  if (block !== null) {
    out.push({ kind: 'punct', text: block[1] as string });
    pushText(out, 'plain', block[2] as string);
    return { block: true };
  }

  const quoted = QUOTED.exec(rest);
  if (quoted !== null) {
    const text = quoted[1] as string;
    pushText(out, 'string', text);
    // Dopo una stringa chiusa puo' esserci un commento, e nient'altro che
    // valga la pena colorare.
    const tail = rest.slice(text.length);
    const hash = tail.indexOf('#');
    if (hash === -1) pushText(out, 'plain', tail);
    else {
      pushText(out, 'plain', tail.slice(0, hash));
      out.push({ kind: 'comment', text: tail.slice(hash) });
    }
    return { block: false };
  }

  // Uno scalare semplice arriva fino a un ` #`, che apre un commento. Senza lo
  // spazio davanti il cancelletto e' parte del valore: `colore: #ff0000` e'
  // un colore, non un commento — ed e' un caso che in questi file c'e'.
  const hash = rest.search(/\s#/);
  const body = hash === -1 ? rest : rest.slice(0, hash);
  const tail = hash === -1 ? '' : rest.slice(hash);

  const trimmed = body.trimEnd();
  const spaces = body.slice(trimmed.length);
  if (NUMBER.test(trimmed)) out.push({ kind: 'number', text: trimmed });
  else if (LITERAL.test(trimmed)) out.push({ kind: 'literal', text: trimmed });
  else if (/^[&*]\S+$/.test(trimmed)) out.push({ kind: 'anchor', text: trimmed });
  else pushText(out, 'plain', trimmed);
  pushText(out, 'plain', spaces);

  if (tail !== '') {
    const at = tail.indexOf('#');
    pushText(out, 'plain', tail.slice(0, at));
    out.push({ kind: 'comment', text: tail.slice(at) });
  }
  return { block: false };
}

/** Una riga di YAML, fuori da un blocco di testo libero. */
function line(source: string): { tokens: Token[]; block: number | null } {
  const out: Token[] = [];
  const indent = source.length - source.trimStart().length;
  let rest = source.slice(indent);
  pushText(out, 'plain', source.slice(0, indent));

  if (rest === '') return { tokens: out, block: null };

  // I trattini di un elenco, anche piu' d'uno: `- - a` e' YAML valido.
  for (let dash = /^-(\s+|$)/.exec(rest); dash !== null; dash = /^-(\s+|$)/.exec(rest)) {
    out.push({ kind: 'punct', text: '-' });
    pushText(out, 'plain', dash[1] as string);
    rest = rest.slice(dash[0].length);
  }

  if (rest.startsWith('#')) {
    out.push({ kind: 'comment', text: rest });
    return { tokens: out, block: null };
  }

  const key = KEY.exec(rest);
  if (key !== null) {
    pushText(out, 'key', key[1] as string);
    out.push({ kind: 'punct', text: ':' });
    rest = rest.slice(key[0].length);
    const spaces = rest.length - rest.trimStart().length;
    pushText(out, 'plain', rest.slice(0, spaces));
    rest = rest.slice(spaces);
  }

  const after = value(out, rest);
  return { tokens: out, block: after.block ? indent : null };
}

/**
 * Il testo, riga per riga, a pezzi colorati.
 *
 * I BLOCCHI DI TESTO LIBERO (`|` e `>`) SONO L'UNICA COSA CHE SI RICORDA da
 * una riga all'altra. Dentro un blocco non c'e' YAML: sono righe di testo, e
 * un `#` li' dentro e' un cancelletto, non un commento. Si esce quando una
 * riga non vuota rientra al livello della chiave che l'aveva aperto.
 */
export function highlightYaml(source: string): Token[][] {
  const rows: Token[][] = [];
  /** L'indentazione della chiave che ha aperto il blocco, se siamo dentro. */
  let block: number | null = null;

  // I RITORNI A CAPO DI WINDOWS SI NORMALIZZANO QUI, e non e' pignoleria: e'
  // esattamente cio' che fa un `<textarea>` con il valore che riceve. Questi
  // file arrivano da un checkout su Windows e hanno CRLF dentro; senza questa
  // riga la textarea mostrava sessanta righe e lo strato colorato centoventi,
  // una vuota ogni due, e dalla prima in poi il colore stava sopra la riga
  // sbagliata. Si vede solo guardando — nessun test sui pezzi lo direbbe.
  for (const raw of source.replace(/\r\n?/g, '\n').split('\n')) {
    const indent = raw.length - raw.trimStart().length;
    const empty = raw.trim() === '';

    if (block !== null && (empty || indent > block)) {
      const out: Token[] = [];
      pushText(out, 'plain', raw);
      rows.push(out);
      continue;
    }
    block = null;

    const done = line(raw);
    rows.push(done.tokens);
    block = done.block;
  }
  return rows;
}
