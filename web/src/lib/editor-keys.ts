// I tasti che un editor deve avere, e che un `<textarea>` non ha.
//
// COSA C'E' QUI. Solo il conto: dato il testo, dove sta il cursore e che tasto
// e' stato premuto, quale pezzo va sostituito e dove finisce il cursore dopo.
// Non tocca il DOM e non sa cosa sia React: si prova senza montare niente, che
// e' l'unico modo di provare davvero il tasto Tab su una selezione di sei
// righe — a mano non lo prova mai nessuno.
//
// GLI SPAZI, NON IL CARATTERE DI TABULAZIONE. In YAML un tab in testa a una
// riga NON e' indentazione: e' un errore di sintassi, e il server lo scopre
// all'avvio con un messaggio che parla di una riga a caso. E' la ragione per
// cui il tasto Tab qui dentro scrive due spazi e non `\t`.
//
// DUE SPAZI perche' li usano i config del plugin, tutti quanti.

/** Un gradino di indentazione. */
export const INDENT = 2;

export type Edit = {
  /** L'intervallo di testo da sostituire. */
  from: number;
  to: number;
  /** Cosa scriverci al posto. */
  insert: string;
  /** La selezione dopo la modifica: uguali se e' solo un cursore. */
  selectFrom: number;
  selectTo: number;
};

export type Press = {
  text: string;
  /** L'inizio e la fine della selezione. Uguali quando e' un cursore. */
  from: number;
  to: number;
  key: string;
  shift: boolean;
};

/** L'inizio della riga in cui cade una posizione. */
function lineStart(text: string, at: number): number {
  return text.lastIndexOf('\n', at - 1) + 1;
}

/** La fine della riga in cui cade una posizione, senza il ritorno a capo. */
function lineEnd(text: string, at: number): number {
  const found = text.indexOf('\n', at);
  return found === -1 ? text.length : found;
}

/** Gli spazi in testa a una riga. */
function indentOf(line: string): string {
  return line.slice(0, line.length - line.trimStart().length);
}

/**
 * Tab e Shift+Tab su piu' righe: si sposta il blocco, non si cancella.
 *
 * IL DIFETTO CHE TOGLIE, ed e' quello che rende Tab pericoloso invece che
 * inutile: in un `<textarea>` normale, premere Tab con del testo selezionato
 * porta il fuoco al pulsante dopo. Qui invece indenta — e chi e' abituato a
 * un editor vero si aspetta questo.
 */
function shiftBlock(press: Press, out: boolean): Edit {
  const start = lineStart(press.text, press.from);
  const end = lineEnd(press.text, press.to);
  const block = press.text.slice(start, end);

  const moved = block
    .split('\n')
    .map((line) => {
      // Le righe vuote restano vuote: indentarle vorrebbe dire lasciare in
      // giro spazi in fondo a righe che non hanno niente sopra cui allinearsi.
      if (line === '') return line;
      if (!out) return ' '.repeat(INDENT) + line;
      const spaces = Math.min(INDENT, line.length - line.trimStart().length);
      return line.slice(spaces);
    })
    .join('\n');

  return { from: start, to: end, insert: moved, selectFrom: start, selectTo: start + moved.length };
}

/**
 * Cosa fa un tasto, o `null` se deve fare quello che fa sempre.
 *
 * `null` NON E' UN RIPIEGO: e' la risposta giusta per tutti i tasti tranne
 * tre. Un editor che intercetta piu' di quello che sa gestire e' un editor in
 * cui un giorno non funziona l'accento.
 */
export function keyEdit(press: Press): Edit | null {
  const { text, from, to } = press;

  if (press.key === 'Tab') {
    // Piu' righe selezionate: si sposta il blocco, in un verso o nell'altro.
    if (text.slice(from, to).includes('\n')) return shiftBlock(press, press.shift);

    if (press.shift) {
      // Su una riga sola il cursore resta dov'era, meno gli spazi tolti,
      // invece di ritrovarsi con tutta la riga selezionata.
      const edit = shiftBlock(press, true);
      const removed = lineEnd(text, to) - lineStart(text, from) - edit.insert.length;
      const at = Math.max(edit.from, from - removed);
      return { ...edit, selectFrom: at, selectTo: at };
    }

    // AL PROSSIMO GRADINO, non due spazi sempre: a meta' di una riga rientrata
    // in modo storto, due spazi lascerebbero la colonna storta com'era.
    const column = from - lineStart(text, from);
    const spaces = INDENT - (column % INDENT);
    const at = from + spaces;
    return { from, to, insert: ' '.repeat(spaces), selectFrom: at, selectTo: at };
  }

  if (press.key === 'Enter') {
    const start = lineStart(text, from);
    const before = text.slice(start, from);
    let indent = indentOf(before);
    // Una riga che apre qualcosa fa rientrare quella dopo: `chiave:`, e i
    // blocchi di testo `|` e `>` con i loro indicatori. E' l'unica regola di
    // YAML che serve sapere per andare a capo bene, ed e' anche quella che si
    // sbaglia sempre a mano.
    if (/(?::|[|>][+-]?\d*)$/.test(before.trimEnd()) && before.trim() !== '') {
      indent += ' '.repeat(INDENT);
    }
    const at = from + 1 + indent.length;
    return { from, to, insert: `\n${indent}`, selectFrom: at, selectTo: at };
  }

  if (press.key === 'Backspace' && from === to) {
    const start = lineStart(text, from);
    const before = text.slice(start, from);
    // Solo dentro l'indentazione: in mezzo alle parole il tasto cancella una
    // lettera, come dappertutto.
    if (before === '' || before.trim() !== '') return null;
    const back = before.length % INDENT === 0 ? INDENT : before.length % INDENT;
    return { from: from - back, to, insert: '', selectFrom: from - back, selectTo: from - back };
  }

  return null;
}
