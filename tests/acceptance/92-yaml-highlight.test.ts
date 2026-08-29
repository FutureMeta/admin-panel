// I colori dell'editor YAML.
//
// C'E' UNA COSA SOLA CHE PUO' ROMPERE DAVVERO, e non e' un colore sbagliato.
// Il testo colorato sta DIETRO a un `<textarea>` trasparente: si scrive nella
// textarea e si legge nello strato sotto. I due strati stanno incolonnati
// finche' contengono gli stessi identici caratteri — perdere uno spazio qui
// dentro sposta di una colonna tutto il resto della riga, e il risultato non e'
// «un colore sbagliato»: e' che si legge il testo doppio, sfalsato.
//
// Da qui il primo gruppo di prove, che e' anche l'unico che non riguarda i
// colori: rimettendo insieme i pezzi si riottiene la riga. Vale su ogni riga
// storta che questi file contengono davvero.
//
// I TAG MINIMESSAGE — che sono la ragione per cui tutto questo esiste — hanno
// il loro file: `94-minimessage.test.ts`. Qui si prova che il testo di un
// valore ci passi attraverso e che un commento no.

import { describe, expect, it } from 'vitest';
import { highlightYaml, type Token } from '#web/lib/yaml-highlight.ts';

/** I pezzi di una riga sola, che e' il caso di quasi tutte le prove. */
function row(source: string): Token[] {
  return highlightYaml(source)[0] as Token[];
}

/** Genere e testo, nella forma corta che si legge in un `toEqual`. */
function shape(source: string): Array<[string, string]> {
  return row(source).map((t) => [t.kind, t.text]);
}

/** Il testo dei pezzi di un certo genere, in fila. */
function only(source: string, kind: string): string[] {
  return row(source)
    .filter((t) => t.kind === kind)
    .map((t) => t.text);
}

describe('rimettendo insieme i pezzi si riottiene la riga', () => {
  // Sono righe VERE dei config del plugin, piu' quelle storte che di solito
  // rompono un evidenziatore scritto in fretta.
  const RIGHE = [
    '',
    '   ',
    'lobby:',
    '  spawn-title: "<gradient:#FFF3C4:#FFD27A><bold>DUELS</bold></gradient>"',
    '  # un commento con : dentro, e anche un #',
    '  colore: "#ff0000"',
    '  esadecimale-senza-virgolette: #ff0000',
    '  attaccato: rosso#ff0000',
    '  numero: -12.5',
    '  vero: true',
    '  vuoto:',
    '  - primo',
    '  - name: annidato',
    '    valore: 3',
    "  apostrofo: 'l''unico modo di scriverlo'",
    '  virgolette-non-chiuse: "manca la fine',
    '  url: http://example.com/x#y',
    '  chiave con spazi: valore',
    '  "chiave: con i due punti": valore',
    '  - "<gray>x<gray>: y"',
    '  ancora: &base',
    '  riferimento: *base',
    '  lista-inline: [uno, due]',
    '  mappa-inline: {a: 1}',
    '  tab\tin\tmezzo: si',
    '  discord: "<@&123456789> ha vinto"',
    '  legacy: "&aVerde &lgrassetto"',
    '  finale: valore   # con la coda di spazi',
  ];

  it('carattere per carattere, su ogni riga storta che c`e` in giro', () => {
    for (const riga of RIGHE) {
      expect(
        row(riga)
          .map((t) => t.text)
          .join(''),
      ).toBe(riga);
    }
  });

  it('e su un file intero, righe comprese quelle vuote', () => {
    const source = RIGHE.join('\n');
    const rows = highlightYaml(source);
    expect(rows).toHaveLength(RIGHE.length);
    expect(rows.map((r) => r.map((t) => t.text).join('')).join('\n')).toBe(source);
  });

  it('i ritorni a capo di Windows contano per uno, non per due', () => {
    // IL DIFETTO CHE QUESTA RIGA IMPEDISCE, ed e` stato visto solo guardando:
    // questi file vengono da un checkout su Windows e hanno CRLF dentro. Un
    // `<textarea>` normalizza il valore che riceve, lo strato colorato no:
    // sessanta righe da una parte, centoventi dall'altra — una vuota ogni due
    // — e il colore sopra la riga sbagliata da li` in poi.
    const rows = highlightYaml('a: 1\r\nb: 2\r\n');
    expect(rows).toHaveLength(3);
    expect(rows.flat().every((t) => !t.text.includes('\r'))).toBe(true);
    expect(highlightYaml('a: 1\rb: 2')).toHaveLength(2);
  });

  it('un testo vuoto da` una riga vuota, non zero righe', () => {
    // Zero righe vorrebbe dire uno strato di colore alto zero pixel sotto una
    // textarea alta trecento: il cursore starebbe su una riga che il colore
    // non ha.
    expect(highlightYaml('')).toEqual([[]]);
  });
});

describe('di che colore e` cosa', () => {
  it('la chiave, i due punti e il valore sono tre cose diverse', () => {
    expect(shape('nome: valore')).toEqual([
      ['key', 'nome'],
      ['punct', ':'],
      ['plain', ' '],
      ['plain', 'valore'],
    ]);
  });

  it('i numeri e i booleani non sono testo', () => {
    expect(only('  vite: 3', 'number')).toEqual(['3']);
    expect(only('  soglia: -12.5', 'number')).toEqual(['-12.5']);
    expect(only('  attivo: true', 'literal')).toEqual(['true']);
    expect(only('  niente: null', 'literal')).toEqual(['null']);
  });

  it('una stringa e` una stringa, apici compresi', () => {
    expect(only('  msg: "ciao"', 'string')).toEqual(['"ciao"']);
    expect(only("  msg: 'ciao'", 'string')).toEqual(["'ciao'"]);
  });

  it('il trattino di un elenco non e` parte del valore', () => {
    expect(shape('  - uno')).toEqual([
      ['plain', '  '],
      ['punct', '-'],
      ['plain', ' '],
      ['plain', 'uno'],
    ]);
  });

  it('un commento comincia dal cancelletto e arriva in fondo', () => {
    expect(only('  chiave: valore # perche` si', 'comment')).toEqual(['# perche` si']);
    expect(only('# tutta la riga', 'comment')).toEqual(['# tutta la riga']);
  });

  it('e un cancelletto attaccato a una parola NON apre un commento', () => {
    // La regola e` quella di YAML, non una nostra: il cancelletto apre un
    // commento quando ha uno spazio davanti. Attaccato e` un carattere come un
    // altro, e questi file lo usano — `rosso#ff0000` e` un valore intero.
    expect(only('  bordo: rosso#ff0000', 'comment')).toEqual([]);
    expect(only('  bordo: rosso#ff0000', 'plain')).toContain('rosso#ff0000');

    // MENTRE `bordo: #ff0000` E` UN COMMENTO, e il valore e` vuoto: e` la
    // ragione per cui negli yml del plugin gli esadecimali stanno sempre fra
    // virgolette. Colorarlo come un valore direbbe che quel colore arriva in
    // gioco, e non ci arriva.
    expect(only('  bordo: #ff0000', 'comment')).toEqual(['#ff0000']);
  });
});

describe('i blocchi di testo libero non sono YAML', () => {
  const BLOCCO = [
    'descrizione: |',
    '  la prima riga',
    '  # questo NON e` un commento',
    '',
    '  altra riga',
    'dopo: 1',
  ];

  it('dentro un blocco tutto e` testo, cancelletti compresi', () => {
    const rows = highlightYaml(BLOCCO.join('\n'));
    expect((rows[2] as Token[]).every((t) => t.kind === 'plain')).toBe(true);
  });

  it('una riga vuota non chiude il blocco', () => {
    const rows = highlightYaml(BLOCCO.join('\n'));
    expect((rows[4] as Token[]).every((t) => t.kind === 'plain')).toBe(true);
  });

  it('e si esce quando si rientra al livello della chiave', () => {
    const rows = highlightYaml(BLOCCO.join('\n'));
    expect((rows[5] as Token[]).map((t) => t.kind)).toContain('key');
  });
});

describe('il testo di un valore passa da MiniMessage, il resto no', () => {
  it('il tag veste il testo che viene dopo, non solo se stesso', () => {
    const pezzi = row('  msg: <red>Perso').filter((t) => t.kind !== 'punct');
    expect(pezzi.find((t) => t.text === 'Perso')?.style?.colour).toBe('#FF5555');
  });

  it('ma in un commento i tag sono prosa, non formattazione', () => {
    // Un commento che spiega come si usa `<red>` non deve diventare rosso: e`
    // testo su cui il gioco non passa mai.
    expect(row('# usa <red> per il rosso').every((t) => t.kind === 'comment')).toBe(true);
  });

  it('e in una chiave nemmeno', () => {
    const chiave = row('<red>: 1').find((t) => t.kind === 'key');
    expect(chiave?.style).toBeUndefined();
  });

  it('la formattazione non passa da una riga all`altra', () => {
    // UN TAG LASCIATO APERTO COLORA FINO A FINE RIGA E NON OLTRE. In gioco
    // ogni messaggio e` una stringa a se`, quindi e` anche cio` che succede
    // davvero — e per una dimenticanza in un file di seicento righe e` la
    // differenza fra una riga storta e seicento.
    const righe = highlightYaml('a: <red>rosso\nb: normale');
    const dopo = (righe[1] as Token[]).find((t) => t.text === 'normale');
    expect(dopo?.style?.colour).toBeUndefined();
  });
});

describe('una stringa con i due punti dentro non e` una chiave', () => {
  // IL DIFETTO CHE QUESTO GRUPPO IMPEDISCE, e che si e` visto in una riga
  // vera: `- "<gray>x<gray>: y"` veniva tagliato sui due punti che stanno
  // DENTRO la stringa. Meta` riga diventava una chiave — e alle chiavi la
  // formattazione MiniMessage non si applica — quindi il messaggio restava del
  // colore delle chiavi e il `<gray>` sembrava non prendere.
  const RIGA = '  - "<gray>• <yellow>GRADUAL<gray>: shrinks 20%"';

  it('la riga e` tutta una stringa, non chiave piu` valore', () => {
    expect(row(RIGA).some((t) => t.kind === 'key')).toBe(false);
    expect(only(RIGA, 'string').join('')).toBe('"• GRADUAL: shrinks 20%"');
  });

  it('e la formattazione ci arriva', () => {
    const pezzi = row(RIGA);
    expect(pezzi.find((t) => t.text === '• ')?.style?.colour).toBe('#AAAAAA');
    expect(pezzi.find((t) => t.text === 'GRADUAL')?.style?.colour).toBe('#FFFF55');
    expect(pezzi.find((t) => t.text.startsWith(': shrinks'))?.style?.colour).toBe('#AAAAAA');
  });

  it('ma una chiave CITATA resta una chiave, due punti compresi', () => {
    // La differenza sta tutta in cosa c'e` dopo la virgoletta di chiusura: i
    // due punti fanno di quella stringa una chiave, la fine della riga no.
    const pezzi = row('  "chiave: con i due punti": valore');
    expect(pezzi.find((t) => t.kind === 'key')?.text).toBe('"chiave: con i due punti"');
  });

  it('e una chiave normale non cambia di una virgola', () => {
    expect(shape('normale: valore')).toEqual([
      ['key', 'normale'],
      ['punct', ':'],
      ['plain', ' '],
      ['plain', 'valore'],
    ]);
  });
});
