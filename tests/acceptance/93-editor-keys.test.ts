// I tasti dell'editor YAML: Tab, Invio, Backspace.
//
// PERCHE' UN TEST, PER TRE TASTI. Perche' nessuno li prova a mano nel caso che
// conta. Tab con il cursore fermo lo prova chiunque al primo minuto; Tab con
// sei righe selezionate e Shift premuto, dentro un blocco gia' rientrato, non
// lo prova nessuno — ed e' li' che un editor scritto in fretta cancella del
// testo invece di spostarlo.
//
// GLI SPAZI, NON IL CARATTERE DI TABULAZIONE, e vale la pena scriverlo due
// volte: in YAML un tab in testa a una riga e' un errore di sintassi. Il file
// verrebbe rifiutato dal server all'avvio, con un messaggio che parla di
// tutt'altra riga — e nel frattempo il pannello direbbe che e' pubblicato.

import { describe, expect, it } from 'vitest';
import { type Edit, INDENT, keyEdit } from '#web/lib/editor-keys.ts';

/** Applica la modifica, e segna il cursore con `|` per leggerla. */
function press(text: string, key: string, from: number, to = from, shift = false): string {
  const edit = keyEdit({ text, from, to, key, shift });
  if (edit === null) return 'NIENTE';
  const after = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
  return edit.selectFrom === edit.selectTo
    ? `${after.slice(0, edit.selectFrom)}|${after.slice(edit.selectFrom)}`
    : `${after.slice(0, edit.selectFrom)}[${after.slice(edit.selectFrom, edit.selectTo)}]${after.slice(edit.selectTo)}`;
}

/** Dove cade il cursore, per le prove che guardano solo quello. */
function edit(text: string, key: string, from: number, to = from, shift = false): Edit {
  return keyEdit({ text, from, to, key, shift }) as Edit;
}

describe('Tab indenta, e non porta il fuoco altrove', () => {
  it('due spazi, non un carattere di tabulazione', () => {
    // IL DIFETTO CHE QUESTA RIGA IMPEDISCE non si vede nel pannello: si vede
    // in gioco. Un `\t` in testa a una riga fa rifiutare il file da snakeyaml,
    // e il server riparte con la configurazione di prima senza dirlo a nessuno.
    expect(press('chiave:', 'Tab', 0)).toBe('  |chiave:');
    expect(edit('chiave:', 'Tab', 0).insert).not.toContain('\t');
  });

  it('porta al gradino successivo, non sempre due spazi', () => {
    // A meta` di una riga rientrata di uno, due spazi lascerebbero la colonna
    // dispari com'era: si scende al gradino, che e` quello che fa un editor.
    expect(press(' a', 'Tab', 1)).toBe('  |a');
    expect(edit(' a', 'Tab', 1).insert).toHaveLength(1);
    expect(edit('  a', 'Tab', 2).insert).toHaveLength(INDENT);
  });

  it('su piu` righe sposta il blocco e lo lascia selezionato', () => {
    // Selezionato perche` si preme Tab piu` volte di fila: perdere la
    // selezione al primo colpo vuol dire rifare la selezione ogni volta.
    const text = 'a:\n  b: 1\n  c: 2';
    expect(press(text, 'Tab', 0, text.length)).toBe('[  a:\n    b: 1\n    c: 2]');
  });

  it('e le righe vuote restano vuote', () => {
    // Indentarle vorrebbe dire spazi in fondo a righe che non hanno niente
    // sopra cui allinearsi: si vedono solo quando qualcuno apre un diff.
    const text = 'a: 1\n\nb: 2';
    expect(press(text, 'Tab', 0, text.length)).toBe('[  a: 1\n\n  b: 2]');
  });
});

describe('Shift+Tab toglie il rientro, e non toglie altro', () => {
  it('due spazi in meno, e il cursore resta dov`era', () => {
    expect(press('    a: 1', 'Tab', 7, 7, true)).toBe('  a: |1');
  });

  it('su una riga senza rientro non fa niente di male', () => {
    // NON cancella il primo carattere: e` il modo piu` veloce di rovinare un
    // file premendo un tasto che «non doveva fare niente».
    expect(press('a: 1', 'Tab', 2, 2, true)).toBe('a:| 1');
  });

  it('toglie meno di un gradino se ce n`e` meno', () => {
    expect(press(' a: 1', 'Tab', 3, 3, true)).toBe('a:| 1');
  });

  it('su piu` righe le tira indietro tutte insieme', () => {
    const text = '  a:\n    b: 1\n\n    c: 2';
    expect(press(text, 'Tab', 0, text.length, true)).toBe('[a:\n  b: 1\n\n  c: 2]');
  });
});

describe('Invio mantiene il rientro', () => {
  it('la riga nuova comincia dove cominciava quella prima', () => {
    expect(press('    b: 1', 'Enter', 8)).toBe('    b: 1\n    |');
  });

  it('dopo una chiave rientra di un gradino', () => {
    // `chiave:` apre qualcosa, e quel qualcosa sta piu` dentro. E` l'unica
    // regola di YAML che serve sapere per andare a capo, ed e` anche quella
    // che si sbaglia sempre a mano.
    expect(press('  lobby:', 'Enter', 8)).toBe('  lobby:\n    |');
  });

  it('e dopo un blocco di testo pure', () => {
    expect(press('msg: |', 'Enter', 6)).toBe('msg: |\n  |');
    expect(press('msg: >-', 'Enter', 7)).toBe('msg: >-\n  |');
  });

  it('ma non dopo un valore', () => {
    expect(press('  b: 1', 'Enter', 6)).toBe('  b: 1\n  |');
  });

  it('a meta` riga porta di sotto quello che resta', () => {
    expect(press('  ab', 'Enter', 3)).toBe('  a\n  |b');
  });

  it('su una riga vuota non inventa un rientro', () => {
    expect(press('', 'Enter', 0)).toBe('\n|');
  });
});

describe('Backspace cancella un gradino, dentro il rientro', () => {
  it('due spazi in un colpo, non uno alla volta', () => {
    expect(press('    a', 'Backspace', 4)).toBe('  |a');
  });

  it('e quello che avanza, se il rientro e` storto', () => {
    expect(press('   a', 'Backspace', 3)).toBe('  |a');
  });

  it('ma fra le parole cancella una lettera, come dappertutto', () => {
    // `null` vuol dire «fai quello che fai sempre»: e` la risposta giusta per
    // tutti i tasti tranne tre, e un editor che intercetta piu` di cio` che sa
    // gestire e` un editor in cui un giorno non funziona l'accento.
    expect(keyEdit({ text: '  ab', from: 4, to: 4, key: 'Backspace', shift: false })).toBeNull();
    expect(keyEdit({ text: '  ab', from: 0, to: 0, key: 'Backspace', shift: false })).toBeNull();
  });

  it('e con del testo selezionato lascia fare al browser', () => {
    expect(keyEdit({ text: '    a', from: 0, to: 4, key: 'Backspace', shift: false })).toBeNull();
  });
});

describe('tutti gli altri tasti restano quelli del browser', () => {
  it('nessuna sorpresa su lettere, frecce, incolla', () => {
    for (const key of ['a', 'ArrowLeft', 'Home', 'End', 'Delete', 'Escape', 'v']) {
      expect(keyEdit({ text: 'a: 1', from: 1, to: 1, key, shift: false })).toBeNull();
    }
  });
});
