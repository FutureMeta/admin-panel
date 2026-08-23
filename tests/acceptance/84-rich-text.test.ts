// Il poco Markdown che Svetlana produce, e tutto quello che NON deve produrre.
//
// IL DIFETTO DI PARTENZA. Il prompt le dice di scrivere in testo semplice, e
// lei lo fa quasi sempre. «Quasi» significava vedere `**1.240 di media**` in
// chat, con gli asterischi, perche' la bolla mostrava il testo tale e quale.
//
// LA META' CHE CONTA DI PIU' E' L'ALTRA. Questa e' la sola parte del pannello
// che prende testo prodotto da un modello — testo che a sua volta CITA quello
// che i giocatori scrivono in gioco — e ne fa qualcosa di visivo. Un
// renderer Markdown completo ci porterebbe dentro link, immagini e HTML, cioe'
// tre modi di trasformare una citazione in un bersaglio cliccabile dentro la
// chat di un amministratore. Qui la superficie e' chiusa per costruzione, e i
// test in fondo al file sono li' per non lasciarla allargare per distrazione.

import { describe, expect, it } from 'vitest';
import { type Line, richText, type Span } from '#web/lib/rich-text.ts';

/** Il testo semplice di una riga: serve a dire «non e' andato perso niente». */
function plain(line: Line): string {
  return line.kind === 'blank' ? '' : line.spans.map((s: Span) => s.text).join('');
}

function only(text: string): Line {
  const lines = richText(text);
  expect(lines).toHaveLength(1);
  return lines[0] as Line;
}

describe('i marcatori in linea diventano modi, e spariscono dal testo', () => {
  it('il grassetto', () => {
    const line = only('sono **1.240** di media');
    expect(plain(line)).toBe('sono 1.240 di media');
    expect(line.kind === 'text' && line.spans).toEqual([
      { text: 'sono ' },
      { text: '1.240', bold: true },
      { text: ' di media' },
    ]);
  });

  it('il corsivo, nelle due forme', () => {
    expect(plain(only('un *forse* e un _forse_'))).toBe('un forse e un forse');
    const spans = only('un *forse* e un _forse_');
    expect(spans.kind === 'text' && spans.spans.filter((s) => s.italic)).toHaveLength(2);
  });

  it('il codice, e dentro il codice non si guarda piu`', () => {
    // `a**b` non e' un grassetto: e' cio' che qualcuno ha scritto fra apici.
    // Cercare il grassetto per primo lo mangerebbe.
    const line = only('la chiave `a**b` non cambia');
    expect(plain(line)).toBe('la chiave a**b non cambia');
    expect(line.kind === 'text' && line.spans[1]).toEqual({ text: 'a**b', code: true });
  });

  it('il grassetto vince sul corsivo, o `**x**` diventa due corsivi vuoti', () => {
    const line = only('**x**');
    expect(line.kind === 'text' && line.spans).toEqual([{ text: 'x', bold: true }]);
  });

  it('i modi si sommano', () => {
    const line = only('**molto `veloce`**');
    expect(line.kind === 'text' && line.spans).toEqual([
      { text: 'molto ', bold: true },
      { text: 'veloce', bold: true, code: true },
    ]);
  });
});

describe('in streaming un marcatore aperto e` testo, non un modo', () => {
  it('la meta` di un grassetto resta com`e` finche` non arriva la chiusura', () => {
    // La risposta arriva a pezzi. Indovinare la chiusura farebbe lampeggiare
    // mezza bolla a ogni pacchetto; aspettarla mostra cio' che c'e'.
    const meta = only('sono **1.240 di me');
    expect(plain(meta)).toBe('sono **1.240 di me');
    expect(meta.kind === 'text' && meta.spans).toEqual([{ text: 'sono **1.240 di me' }]);
    // E quando arriva, diventa grassetto.
    const intera = only('sono **1.240** di media');
    expect(plain(intera)).toBe('sono 1.240 di media');
    expect(intera.kind === 'text' && intera.spans.some((s) => s.bold)).toBe(true);
  });

  it('un asterisco isolato non apre niente', () => {
    const line = only('3 * 4 = 12');
    expect(plain(line)).toBe('3 * 4 = 12');
    expect(line.kind === 'text' && line.spans).toEqual([{ text: '3 * 4 = 12' }]);
  });
});

describe('le righe: elenchi, titoli, e gli a capo che restano', () => {
  it('un trattino diventa un elenco, e il trattino sparisce dal testo', () => {
    const [line] = richText('- Survival: 412');
    expect(line?.kind).toBe('bullet');
    expect(line && plain(line)).toBe('Survival: 412');
  });

  it('un numero diventa un elenco numerato che conserva il suo numero', () => {
    const [line] = richText('3) Skywars');
    expect(line).toEqual({ kind: 'numbered', marker: '3.', spans: [{ text: 'Skywars' }] });
  });

  it('i cancelletti diventano un titolo', () => {
    const [line] = richText('## Ultime 24 ore');
    expect(line?.kind).toBe('heading');
    expect(line && plain(line)).toBe('Ultime 24 ore');
  });

  it('le righe vuote NON si buttano: separano due paragrafi', () => {
    // La bolla non usa piu' `pre-wrap`: gli a capo vengono da qui, e perderne
    // uno incolla insieme cose che il modello aveva deciso di staccare.
    const lines = richText('primo\n\nsecondo');
    expect(lines.map((l) => l.kind)).toEqual(['text', 'blank', 'text']);
  });

  it('una risposta intera si rimonta senza perdere una parola', () => {
    // Con gli accenti veri, perche' e' cio' che il modello scrive davvero:
    // l'interfaccia e' in italiano. (Scriverli con l'apice inverso, come si
    // fa nei commenti di questo progetto, qui aprirebbe uno span di codice.)
    const risposta = [
      '## Ultime 24 ore',
      '',
      'La media è **1.240** giocatori. Le modalità più giocate:',
      '- Survival: 412',
      '- Skywars: 289',
      '',
      'Il picco è stato alle `21:00`.',
    ].join('\n');
    const lines = richText(risposta);
    expect(lines.map((l) => l.kind)).toEqual([
      'heading',
      'blank',
      'text',
      'bullet',
      'bullet',
      'blank',
      'text',
    ]);
    // NIENTE VA PERSO. E' l'asserzione che conta: un parser che sbaglia puo'
    // mangiare mezza frase, e mezza frase in un pannello di amministrazione e'
    // peggio di un asterisco di troppo.
    expect(lines.map(plain).join('\n')).toBe(
      [
        'Ultime 24 ore',
        '',
        'La media è 1.240 giocatori. Le modalità più giocate:',
        'Survival: 412',
        'Skywars: 289',
        '',
        'Il picco è stato alle 21:00.',
      ].join('\n'),
    );
  });
});

describe('cio` che NON si interpreta, e non per dimenticanza', () => {
  it('un link resta scritto com`e`: si legge, non si clicca', () => {
    // LA DECISIONE DI SICUREZZA. Svetlana cita testo scritto dai giocatori —
    // nomi, motivazioni di ban, commenti alle valutazioni. Se questa sintassi
    // diventasse un collegamento vero, chiunque possa scrivere in gioco
    // potrebbe mettere un bersaglio cliccabile dentro la chat di un
    // amministratore, e nessuna sanificazione dell'URL rende quella una buona
    // idea.
    const raw = 'guarda [qui](https://esempio.invalid/paga)';
    expect(plain(only(raw))).toBe(raw);
  });

  it('e nemmeno un link con uno schema `javascript:`', () => {
    const raw = 'clicca [subito](javascript:alert(1))';
    expect(plain(only(raw))).toBe(raw);
  });

  it('un`immagine non diventa un`immagine', () => {
    const raw = '![x](https://esempio.invalid/tracciante.png)';
    expect(plain(only(raw))).toBe(raw);
  });

  it('l`HTML grezzo resta testo, tag compresi', () => {
    // Non c'e' niente da sanificare perche' non c'e' niente da interpretare:
    // il componente riceve DATI e li disegna con React, che scrive testo.
    const raw = '<img src=x onerror="alert(1)"> e <script>alert(1)</script>';
    expect(plain(only(raw))).toBe(raw);
  });

  it('nessuno span porta qualcosa che non sia testo e i tre modi', () => {
    // La guardia contro l'allargamento distratto: se un giorno qualcuno
    // aggiungesse `href`, questo test lo direbbe prima della revisione.
    const lines = richText('**a** *b* `c`\n- d\n1. e\n## f');
    const chiavi = new Set(
      lines.flatMap((l) => (l.kind === 'blank' ? [] : l.spans.flatMap((s) => Object.keys(s)))),
    );
    expect([...chiavi].sort()).toEqual(['bold', 'code', 'italic', 'text']);
  });
});
