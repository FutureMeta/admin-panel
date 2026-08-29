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
// NON E' UN PARSER YAML e non deve diventarlo. Non valida, non si lamenta, non
// costruisce niente: guarda una riga alla volta e decide di che colore
// dipingerla. Su una riga che non capisce ripiega su `plain`, che e' il colore
// del testo normale — cioe' esattamente quello che si vedeva prima.

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

export type Token = { kind: TokenKind; text: string };

/**
 * I sedici colori del client, per nome MiniMessage.
 *
 * STANNO QUI E NON FRA I TOKEN DI DISEGNO perche' non sono una scelta
 * estetica: `<red>` E' quel rosso — lo dice il gioco — e dipingerlo di un
 * altro colore vorrebbe dire mentire su cio' che il giocatore vedra'.
 */
const NAMED: Record<string, string> = {
  black: '#000000',
  dark_blue: '#0000AA',
  dark_green: '#00AA00',
  dark_aqua: '#00AAAA',
  dark_red: '#AA0000',
  dark_purple: '#AA00AA',
  gold: '#FFAA00',
  gray: '#AAAAAA',
  dark_gray: '#555555',
  blue: '#5555FF',
  green: '#55FF55',
  aqua: '#55FFFF',
  red: '#FF5555',
  light_purple: '#FF55FF',
  yellow: '#FFFF55',
  white: '#FFFFFF',
};

/**
 * I codici legacy, nell'ordine che DEFINISCE quale colore sono: `&0` e' il
 * primo nome, `&f` l'ultimo. Ricavati dai nomi invece che riscritti, o le due
 * tavolozze potrebbero divergere restando tutt'e due plausibili.
 */
const LEGACY = Object.keys(NAMED);

/** Un tag o un codice che non e' un colore: `<bold>`, `<click:…>`, `&l`. */
const NEUTRAL = '#8FA3AD';

/**
 * Il colore che un codice significa.
 *
 * Riconosce quello che c'e' davvero in questi file: i nomi MiniMessage, l'esa
 * `<#FF5C5C>`, le sfumature — di cui si prende il primo estremo, che e' il
 * colore da cui la scritta parte — e i vecchi codici `&a`. Tutto il resto e'
 * un tag che colore non ha: stile, click, segnaposto.
 */
export function codeColour(code: string): string {
  if (code.startsWith('&') || code.startsWith('§')) {
    const char = code[1] as string;
    // `&l`, `&o`, `&r`: stile, non colore.
    if (!/^[0-9a-fA-F]$/.test(char)) return NEUTRAL;
    return NAMED[LEGACY[Number.parseInt(char, 16)] as string] as string;
  }
  const body = code.replace(/^<\/?/, '').replace(/>$/, '');
  const hex = /^#[0-9a-fA-F]{6}$/.exec(body);
  if (hex !== null) return body;
  const gradient = /^gradient:(#[0-9a-fA-F]{6})/.exec(body);
  if (gradient !== null) return gradient[1] as string;
  return NAMED[body.toLowerCase()] ?? NEUTRAL;
}

/**
 * Un colore troppo scuro per il fondo dell'editor si porta dietro una velatura
 * chiara.
 *
 * SENZA, `<black>` E `<dark_blue>` SAREBBERO INVISIBILI: il testo dell'editor
 * e' disegnato solo da questo strato — sotto c'e' un `<textarea>` trasparente
 * — e un tag nero su fondo quasi nero non e' un colore poco leggibile, e' un
 * pezzo di riga che sparisce. Il colore resta quello vero: cambia il dietro,
 * non il davanti.
 */
export function codeStyle(code: string): { color: string; background?: string } {
  const colour = codeColour(code);
  const n = Number.parseInt(colour.slice(1), 16);
  // Luminanza percepita, la formula corta: il verde pesa piu' del rosso, e il
  // blu quasi niente. `#0000AA` e' scuro anche se il suo numero e' grande.
  const light = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return light < 0.32 ? { color: colour, background: 'rgba(255,255,255,.12)' } : { color: colour };
}

/** Un codice legacy, oppure un tag MiniMessage — di apertura o di chiusura. */
const CODE = /[&§][0-9a-fk-orA-FK-OR]|<\/?[^<>\s][^<>]*>/g;

/**
 * Aggiunge del testo, staccando i codici colore che ci trova dentro.
 *
 * Solo dentro le stringhe e il testo semplice: in un commento `&a` e' due
 * caratteri di prosa, e in una chiave non ci arriva mai.
 */
function pushText(out: Token[], kind: TokenKind, text: string): void {
  if (text === '') return;
  if (kind !== 'string' && kind !== 'plain') {
    out.push({ kind, text });
    return;
  }
  let at = 0;
  CODE.lastIndex = 0;
  for (let m = CODE.exec(text); m !== null; m = CODE.exec(text)) {
    if (m.index > at) out.push({ kind, text: text.slice(at, m.index) });
    out.push({ kind: 'code', text: m[0] });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ kind, text: text.slice(at) });
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
