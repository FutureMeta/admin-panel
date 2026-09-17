// Le funzioni pure di «Lingue»: l'albero delle chiavi, il sorgente disegnato.
//
// NIENTE CONVALIDA DEL MINIMESSAGE, ed e' voluto: `<player>`, `<server>` e i
// tag che ogni bundle si inventa li risolve il plugin, e il pannello non ha
// la lista. Un controllo qui rifiuterebbe testi giusti.

import { describe, expect, it } from 'vitest';
import { keyTree, prefixesOf } from '#web/lib/lang.ts';
import { lineSpans } from '#web/lib/mini-spans.ts';

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
    // E` l'invariante dell'editor: nessun carattere si perde per strada.
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

  it('un segnaposto <cosi> e` testo: prende il colore attorno, e resta anche senza i tag', () => {
    const spans = lineSpans('<white><world></white> <gray>Ciao <player>', 12);
    expect(spans.map((s) => s.text)).toEqual([
      '<white>',
      '<world>',
      '</white>',
      ' ',
      '<gray>',
      'Ciao <player>',
    ]);
    expect(spans[1]?.style).toMatchObject({ color: '#FFFFFF' });
    expect(spans[1]?.style.color).not.toBe('var(--yml-tag)');
    // Senza i tag resta il messaggio come lo vede il giocatore: il segnaposto c'e`.
    expect(lineSpans('<gray>Ciao <player>', 12, false).map((s) => s.text)).toEqual(['Ciao <player>']);
  });
});
