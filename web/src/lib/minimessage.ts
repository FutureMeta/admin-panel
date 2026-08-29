// MiniMessage: cosa vedra' il giocatore, dentro l'editor.
//
// COSA FA, IN UNA RIGA. Prende il testo di un valore YAML e lo taglia in pezzi
// che sanno di che colore sono e come sono scritti — grassetto, corsivo,
// barrato — applicando i tag come li applica il gioco. `<red>ciao` non e' un
// tag rosso seguito da del testo grigio: e' la parola «ciao» in rosso, ed e'
// tutta la differenza fra vedere il messaggio e leggerne il codice.
//
// PERCHE' NON BASTA COLORARE I TAG. In questi file un messaggio e' una riga
// sola con dentro sei o sette tag: chi lo scrive vuole sapere come verra', e
// l'unico modo di saperlo era avviare il server e farlo comparire in chat.
//
// COSA NON FA, DI PROPOSITO:
//
//   - non offusca. `<obfuscated>` in gioco fa ballare i caratteri; qui il
//     testo e' la sorgente che si sta scrivendo, e farla ballare renderebbe
//     impossibile modificarla. Si segna con una sottolineatura tratteggiata.
//   - non manda a capo. `<newline>` in gioco spezza la riga; qui una riga in
//     piu' scollerebbe il colore dal testo della textarea sotto (vedi
//     `yaml-highlight.ts`), e si leggerebbe tutto doppio.
//   - non disegna icone. `<sprite:...>` diventa un'immagine in gioco: qui
//     resta il tag, che e' cio' che c'e' scritto davvero.
//
// NON E' IL PARSER DI ADVENTURE e non deve diventarlo. Non valida, non si
// lamenta, non conosce i tag che non conosce: un tag sconosciuto non fa
// niente, che e' esattamente cio' che si vedeva prima.

/** Come e' scritto un pezzo di testo. Tutto opzionale: assente = normale. */
export type Style = {
  /** Esadecimale, gia' risolto — anche quando viene da una sfumatura. */
  colour?: string;
  bold?: boolean;
  italic?: boolean;
  underlined?: boolean;
  strikethrough?: boolean;
  obfuscated?: boolean;
};

export type Piece = {
  text: string;
  /** `true` se e' il tag stesso, `false` se e' il testo che il tag veste. */
  tag: boolean;
  style: Style;
};

/**
 * I sedici colori del client, per nome.
 *
 * NON SONO UNA SCELTA ESTETICA: `<red>` E' quel rosso — lo dice il gioco — e
 * dipingerlo di un altro colore vorrebbe dire mentire su cio' che il giocatore
 * vedra'. E' anche il motivo per cui stanno qui e non fra i token di disegno.
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

/** Un tag che colore non ha: stile, click, segnaposto. */
const NEUTRAL = '#8FA3AD';

/** I nomi con cui si scrive la stessa cosa. `<b>` e `<bold>` sono un tag solo. */
const ALIAS: Record<string, string> = {
  b: 'bold',
  i: 'italic',
  em: 'italic',
  u: 'underlined',
  st: 'strikethrough',
  obf: 'obfuscated',
  k: 'obfuscated',
  r: 'reset',
  c: 'color',
  colour: 'color',
};

const DECORATIONS = ['bold', 'italic', 'underlined', 'strikethrough', 'obfuscated'] as const;
type Decoration = (typeof DECORATIONS)[number];

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Il colore di un nome o di un esadecimale, se e' un colore.
 *
 * SEMPRE MAIUSCOLO, e non e' gusto: `<#ff5c5c>` e `<#FF5C5C>` sono lo stesso
 * colore, e due scritture diverse dello stesso colore terrebbero separati due
 * pezzi di testo che invece si possono unire — piu' nodi da disegnare, e un
 * confronto fra stili che dice «diversi» su roba identica.
 */
function colourOf(word: string): string | null {
  if (HEX.test(word)) return word.toUpperCase();
  return NAMED[word.toLowerCase()] ?? null;
}

/**
 * Il colore che un codice significa.
 *
 * Riconosce quello che c'e' davvero in questi file: i nomi, l'esadecimale, le
 * sfumature — di cui prende il primo estremo, il colore da cui la scritta
 * parte — e i vecchi codici `&a`, che sono l'unico posto da cui lo chiama
 * ancora qualcuno: i tag il colore non ce l'hanno piu', ce l'ha il testo.
 */
function codeColour(code: string): string {
  if (code.startsWith('&') || code.startsWith('§')) {
    const char = code[1] as string;
    // `&l`, `&o`, `&r`: stile, non colore.
    if (!/^[0-9a-fA-F]$/.test(char)) return NEUTRAL;
    return NAMED[LEGACY[Number.parseInt(char, 16)] as string] as string;
  }
  const parsed = parseTag(code);
  if (parsed === null) return NEUTRAL;
  const direct = colourOf(parsed.name);
  if (direct !== null) return direct;
  if (parsed.name === 'color') return colourOf(parsed.args[0] ?? '') ?? NEUTRAL;
  if (parsed.name === 'gradient') {
    return stopsOf(parsed.args)[0] ?? NEUTRAL;
  }
  return NEUTRAL;
}

/**
 * Un colore troppo scuro per il fondo dell'editor si porta dietro una velatura
 * chiara.
 *
 * SENZA, `<black>` E `<dark_blue>` SAREBBERO INVISIBILI: il testo dell'editor
 * e' disegnato solo da questo strato — sotto c'e' un `<textarea>` trasparente
 * — e nero su fondo quasi nero non e' poco leggibile, e' un pezzo di riga che
 * sparisce. Il colore resta quello vero: cambia il dietro, non il davanti.
 *
 * La soglia guarda il fondo SCURO, che e' l'unico tema che il pannello monta
 * oggi (`web/index.html`). Il giorno in cui ne monta due, questa e' la riga da
 * rivedere.
 */
export function paint(colour: string): { color: string; background?: string } {
  const n = Number.parseInt(colour.slice(1), 16);
  // Luminanza percepita, la formula corta: il verde pesa piu' del rosso, e il
  // blu quasi niente. `#0000AA` e' scuro anche se il suo numero e' grande.
  const light = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return light < 0.32 ? { color: colour, background: 'rgba(255,255,255,.12)' } : { color: colour };
}

/**
 * Un tag, o un codice legacy.
 *
 * LE VIRGOLETTE DENTRO IL TAG SONO IL PEZZO CHE CONTA:
 * `<hover:show_text:'<#C4CED6>Ciao'>` porta un tag DENTRO il proprio argomento.
 * Senza saltare le parti citate, la ricerca si fermerebbe al `<` interno e da
 * li' in poi colorerebbe la riga con il colore del suggerimento — che in gioco
 * si vede solo passandoci sopra il mouse.
 */
export const TAG = /<\/?[a-zA-Z#][^<>'"]*(?:(?:'[^']*'|"[^"]*")[^<>'"]*)*>|[&§][0-9a-fk-orA-FK-OR]/g;

type Tag = { close: boolean; name: string; args: string[] };

/** Nome e argomenti di un tag. Gli argomenti citati perdono le virgolette. */
function parseTag(raw: string): Tag | null {
  const inner = raw.replace(/^<|>$/g, '');
  if (inner === '') return null;
  const close = inner.startsWith('/');
  const body = close ? inner.slice(1) : inner;

  // Si divide sui due punti, ma non dentro le virgolette: l'argomento di
  // `hover` ne contiene, e spezzarlo li' darebbe un tag di nome diverso.
  const args: string[] = [];
  let current = '';
  let quote = '';
  for (const ch of body) {
    if (quote !== '') {
      if (ch === quote) quote = '';
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === ':') {
      args.push(current);
      current = '';
    } else current += ch;
  }
  args.push(current);

  const first = (args.shift() ?? '').toLowerCase();
  return { close, name: ALIAS[first] ?? first, args };
}

/** I colori di una sfumatura. I numeri fra gli argomenti sono la fase: si saltano. */
function stopsOf(args: readonly string[]): string[] {
  const stops = args.map(colourOf).filter((c): c is string => c !== null);
  return stops.length >= 2 ? stops : [];
}

type Gradient = { stops: string[]; total: number; seen: number };

const rgb = (hex: string): [number, number, number] => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
];

const hex2 = (n: number): string => Math.round(n).toString(16).padStart(2, '0');

/** Il colore di una sfumatura a `t`, fra 0 e 1, su piu' estremi. */
export function gradientAt(stops: readonly string[], t: number): string {
  if (stops.length === 0) return NEUTRAL;
  if (stops.length === 1) return stops[0] as string;
  const span = 1 / (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(t / span));
  const local = (t - index * span) / span;
  const a = rgb(stops[index] as string);
  const b = rgb(stops[index + 1] as string);
  return `#${a.map((v, i) => hex2(v + ((b[i] as number) - v) * local)).join('')}`.toUpperCase();
}

/**
 * Quanti caratteri VISIBILI copre una sfumatura.
 *
 * Serve prima di dipingerli: il colore del terzo carattere dipende da quanti
 * ce ne sono in tutto. I tag non contano — in gioco non si vedono — ed e' il
 * motivo per cui questo conto non e' `indexOf('</gradient>') - qui`.
 */
function gradientLength(source: string, from: number): number {
  let depth = 0;
  let count = 0;
  let at = from;
  const scan = new RegExp(TAG.source, 'g');
  scan.lastIndex = from;
  for (let m = scan.exec(source); m !== null; m = scan.exec(source)) {
    count += m.index - at;
    at = m.index + m[0].length;
    const parsed = parseTag(m[0]);
    if (parsed === null) continue;
    if (parsed.name === 'gradient') {
      if (!parsed.close) depth += 1;
      else if (depth === 0) return count;
      else depth -= 1;
    }
    // `<reset>` chiude tutto, sfumatura compresa.
    if (parsed.name === 'reset') return count;
  }
  return count + (source.length - at);
}

type Frame = { id: string; style: Style & { gradient?: Gradient } };

/** Aggiunge un pezzo, unendolo al precedente quando sono vestiti uguale. */
function push(out: Piece[], piece: Piece): void {
  const last = out.at(-1);
  if (last !== undefined && last.tag === piece.tag && same(last.style, piece.style)) {
    last.text += piece.text;
    return;
  }
  out.push(piece);
}

function same(a: Style, b: Style): boolean {
  return (
    a.colour === b.colour &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underlined === b.underlined &&
    a.strikethrough === b.strikethrough &&
    a.obfuscated === b.obfuscated
  );
}

/** Lo stile pubblico: quello interno meno la sfumatura, che qui e' gia' risolta. */
function visible(style: Style & { gradient?: Gradient }, colour?: string): Style {
  const { gradient: _gradient, ...rest } = style;
  return colour === undefined ? rest : { ...rest, colour };
}

/**
 * Il testo di un valore YAML, tagliato in pezzi che sanno come sono vestiti.
 *
 * LO STATO NON ESCE DA QUI, e chi chiama lo chiama una riga alla volta: un tag
 * lasciato aperto colora fino alla fine della sua riga e non oltre. In gioco
 * ogni messaggio e' una stringa a se', quindi e' anche cio' che succede
 * davvero — e per una dimenticanza in un file di seicento righe e' la
 * differenza fra una riga storta e seicento.
 */
export function renderMiniMessage(source: string): Piece[] {
  const out: Piece[] = [];
  const stack: Frame[] = [];
  const top = (): Frame['style'] => stack.at(-1)?.style ?? {};

  const emit = (text: string): void => {
    if (text === '') return;
    const style = top();
    const gradient = style.gradient;
    if (gradient === undefined) {
      push(out, { text, tag: false, style: visible(style) });
      return;
    }
    // Un carattere alla volta: il colore dipende da quanti ne sono passati. I
    // pezzi vicini con lo stesso colore si riuniscono da soli in `push`.
    for (const ch of text) {
      const t = gradient.total <= 1 ? 0 : gradient.seen / (gradient.total - 1);
      const colour = style.colour ?? gradientAt(gradient.stops, Math.min(1, t));
      gradient.seen += 1;
      push(out, { text: ch, tag: false, style: visible(style, colour) });
    }
  };

  let at = 0;
  const scan = new RegExp(TAG.source, 'g');
  for (let m = scan.exec(source); m !== null; m = scan.exec(source)) {
    emit(source.slice(at, m.index));
    at = m.index + m[0].length;

    const raw = m[0];
    // IL TAG NON HA UN COLORE SUO, e chi lo disegna gli da' un grigio uguale
    // per tutti (`--yml-tag`). Il colore ce l'ha il testo che il tag veste —
    // quello che il giocatore vedra' — e due colori nella stessa riga, uno per
    // il tag e uno per la parola, si contendevano l'occhio proprio dove serve
    // leggere il messaggio.
    push(out, { text: raw, tag: true, style: {} });

    if (raw.startsWith('&') || raw.startsWith('§')) {
      // I codici legacy non si annidano: ognuno riscrive quello che c'era.
      // Un colore azzera anche lo stile — e' la regola del gioco, non nostra.
      const char = (raw[1] as string).toLowerCase();
      if (char === 'r') stack.length = 0;
      else if (/^[0-9a-f]$/.test(char)) {
        stack.length = 0;
        stack.push({ id: 'legacy', style: { colour: codeColour(raw) } });
      } else {
        const decoration = { l: 'bold', o: 'italic', n: 'underlined', m: 'strikethrough', k: 'obfuscated' }[
          char
        ];
        if (decoration !== undefined) {
          const style = { ...top(), [decoration]: true };
          stack.length = 0;
          stack.push({ id: 'legacy', style });
        }
      }
      continue;
    }

    const parsed = parseTag(raw);
    if (parsed === null) continue;

    if (parsed.close) {
      // Si chiude il frame piu' recente con quel nome, e con lui tutto quello
      // che era stato aperto dentro. Una chiusura che non trova niente da
      // chiudere non fa danni: e' testo scritto male, non un motivo per
      // spegnere il colore di tutto il resto della riga.
      const id = colourOf(parsed.name) !== null ? 'color' : parsed.name;
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if ((stack[i] as Frame).id === id) {
          stack.length = i;
          break;
        }
      }
      continue;
    }

    if (parsed.name === 'reset') {
      stack.length = 0;
      continue;
    }

    const colour = colourOf(parsed.name) ?? (parsed.name === 'color' ? colourOf(parsed.args[0] ?? '') : null);
    if (colour !== null) {
      // IL COLORE VINCE SULLA SFUMATURA dentro cui sta, ma non la ferma: i
      // caratteri che si porta via contano lo stesso, o la sfumatura
      // ripartirebbe da capo dopo di lui.
      stack.push({ id: 'color', style: { ...top(), colour } });
      continue;
    }

    if (parsed.name === 'gradient') {
      const stops = stopsOf(parsed.args);
      if (stops.length === 0) continue;
      const gradient: Gradient = { stops, total: gradientLength(source, at), seen: 0 };
      // Il colore di prima si TOGLIE, non si mette a `undefined`: dentro una
      // sfumatura comanda la sfumatura, fino a un colore scritto dopo di lei.
      const { colour: _before, ...rest } = top();
      stack.push({ id: 'gradient', style: { ...rest, gradient } });
      continue;
    }

    if ((DECORATIONS as readonly string[]).includes(parsed.name)) {
      // `<bold:false>` esiste e spegne invece di accendere.
      const on = parsed.args[0] !== 'false';
      stack.push({ id: parsed.name, style: { ...top(), [parsed.name as Decoration]: on } });
      continue;
    }

    // Tutto il resto — click, hover, sprite, shadow, segnaposto — non veste
    // niente. Entra comunque nella pila, perche' la sua chiusura deve trovare
    // qualcosa da chiudere invece di andare a chiudere un colore.
    stack.push({ id: parsed.name, style: { ...top() } });
  }

  emit(source.slice(at));
  return out;
}
