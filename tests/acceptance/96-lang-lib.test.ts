// Le funzioni pure di «Lingue»: la convalida MiniMessage, i segnaposto,
// l'albero delle chiavi, il sorgente disegnato.
//
// LA CONVALIDA E' LA COSA CHE CONTA DI PIU', e in due versi opposti. Troppo
// severa, e lo staff non riesce a salvare una frase normale — `<gray>starts
// in <white>%time%` NON chiude niente ed e' la forma di quasi ogni testo.
// Troppo lasca, e un `<gradient:#…` senza `>` arriva in gioco e il giocatore
// vede un messaggio sparito. Le prove qui sotto fissano i due bordi.

import { describe, expect, it } from 'vitest';
import { keyTree, missingPlaceholders, prefixesOf } from '#web/lib/lang.ts';
import { lineSpans } from '#web/lib/mini-spans.ts';
import { placeholdersOf, validateMiniMessage } from '#web/lib/minimessage.ts';

describe('cosa il gioco accetta', () => {
  it('i testi veri passano, colori aperti e mai chiusi compresi', () => {
    const REAL = [
      '<gradient:#FF4A4A:#FF2121><bold>UHC</bold></gradient> <gray>starts in <white>%time%</white>',
      '<gray>Get ready, <white>%player%',
      "<#FCA800>%host%</#FCA800> <gray>has opened an event. <click:run_command:'/event join'><hover:show_text:'Click to join'><yellow><underlined>Join now</underlined></yellow></hover></click>",
      '<gray>Mode: <white>%mode%\n<gray>Map: <white>%map%',
      '<white>Italiano',
      '<reset>',
      'testo senza tag, con a < b in mezzo',
      '<!bold>non piu` grassetto',
      '<!b>nemmeno cosi`',
      '<shadow:black><sprite:gui:icon/link> icona',
    ];
    for (const text of REAL) expect(validateMiniMessage(text), text).toEqual([]);
  });
});

describe('cosa il gioco scarterebbe', () => {
  it('un tag mai terminato: il `>` non arriva', () => {
    // IL CASO DEL MOCKUP, ed e` il piu` insidioso: si legge benissimo, e in
    // gioco sparisce tutto il messaggio.
    const issues = validateMiniMessage('<gradient:#8A8A8A:#CCCCCC Volver al menu anterior');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.at).toBe(0);
    expect(issues[0]?.reason).toMatch(/non chiuso/);
  });

  it('e si ferma a fine riga: la riga dopo si controlla lo stesso', () => {
    const issues = validateMiniMessage('<gradient:#8A8A8A rotto\n<gery>anche questo');
    expect(issues.map((i) => i.reason)).toEqual([
      expect.stringMatching(/non chiuso/),
      'tag sconosciuto: <gery>',
    ]);
  });

  it('un nome che non conosce', () => {
    expect(validateMiniMessage('<gery>ciao')[0]?.reason).toBe('tag sconosciuto: <gery>');
  });

  it('una chiusura senza apertura', () => {
    expect(validateMiniMessage('ciao</bold>')[0]?.reason).toBe('chiusura senza apertura');
    // Ma chiudere un colore con un altro nome va bene: e` MiniMessage.
    expect(validateMiniMessage('<red>a</white>b')).toEqual([]);
  });

  it('una sfumatura con un colore solo, o con un colore scritto male', () => {
    expect(validateMiniMessage('<gradient:#FF0000>x')[0]?.reason).toMatch(/due colori/);
    expect(validateMiniMessage('<gradient:#FF0000:rosso>x')[0]?.reason).toMatch(/due colori/);
    expect(validateMiniMessage('<color:rosso>x')[0]?.reason).toBe('colore sconosciuto');
  });
});

describe('i segnaposto', () => {
  it('si contano una volta, nell`ordine in cui compaiono', () => {
    expect(placeholdersOf('<gray>%host% starts in <white>%time% (%host%)')).toEqual(['%host%', '%time%']);
  });

  it('e quelli che mancano si cercano in un verso solo', () => {
    // Uno in piu` nella traduzione non e` un errore; uno in meno perde
    // un'informazione che l'inglese dava.
    expect(missingPlaceholders('<gray>%host% in <white>%time%', '<gray>tra <white>%time%')).toEqual([
      '%host%',
    ]);
    expect(missingPlaceholders('<gray>%time%', '<gray>%time% %extra%')).toEqual([]);
  });
});

describe('l`albero delle chiavi', () => {
  const KEYS = [
    'scoreboard.default.lines',
    'match.starting-title',
    'inventory.settings.back.name',
    'event.full',
    'inventory.settings.title',
    'match.ended',
  ];

  it('a ogni livello prima le chiavi, poi i prefissi, tutti in ordine', () => {
    const rows = keyTree(KEYS, new Set());
    expect(
      rows.map((r) => `${' '.repeat(r.depth * 2)}${r.kind === 'dir' ? `${r.label}/` : r.label}`),
    ).toEqual(['event/', 'inventory/', 'match/', 'scoreboard/']);
  });

  it('un prefisso aperto scrive quello che ha sotto, e conta le chiavi', () => {
    const rows = keyTree(KEYS, new Set(['inventory', 'inventory.settings']));
    expect(rows.find((r) => r.full === 'inventory')?.count).toBe(2);
    expect(rows.map((r) => r.full)).toEqual([
      'event',
      'inventory',
      'inventory.settings',
      'inventory.settings.title',
      'inventory.settings.back',
      'match',
      'scoreboard',
    ]);
  });

  it('i prefissi sopra una chiave sono quelli da aprire per vederla', () => {
    expect(prefixesOf('inventory.settings.back.name')).toEqual([
      'inventory',
      'inventory.settings',
      'inventory.settings.back',
    ]);
    expect(prefixesOf('event')).toEqual([]);
  });
});

describe('il sorgente disegnato', () => {
  it('rimettendo insieme i pezzi si riottiene la riga, anche rotta', () => {
    // E` l'invariante dell'editor, e qui vale per un'altra ragione: gli
    // errori arrivano come posizioni e i pezzi come stringhe, e combaciano
    // solo se nessun carattere si perde per strada.
    const LINES = [
      '<gray>Mode: <white>%mode%',
      '<gradient:#8A8A8A:#CCCCCC Volver al menu',
      'ciao</bold> <gery>x',
      '',
    ];
    for (const line of LINES) {
      expect(
        lineSpans(line, 12)
          .map((s) => s.text)
          .join(''),
        line,
      ).toBe(line);
    }
  });

  it('il tag e` grigio, il testo ha il colore, il segnaposto il suo fondo', () => {
    const spans = lineSpans('<red>Perso %time%', 12);
    expect(spans[0]).toMatchObject({ text: '<red>', style: { color: 'var(--yml-tag)' } });
    expect(spans[1]).toMatchObject({ text: 'Perso ', style: { color: '#FF5555' } });
    expect(spans[2]).toMatchObject({ text: '%time%', style: { background: 'var(--blu-soft)' } });
  });

  it('un tag rotto e` rosso dove sta, e senza i tag resta comunque visibile', () => {
    const bad = lineSpans('a <gery>b', 12).find((s) => s.text === '<gery>');
    expect(bad?.style.color).toBe('var(--err)');
    // Con i tag spenti si vede il messaggio come in gioco, MA un tag rotto
    // si mostra lo stesso: in gioco non sparirebbe lui, sparirebbe tutto.
    const rendered = lineSpans('<red>a <gery>b', 12, false).map((s) => s.text);
    expect(rendered).toEqual(['a ', '<gery>', 'b']);
  });
});
