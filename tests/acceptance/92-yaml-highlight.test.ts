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
// IL SECONDO GRUPPO E' SUI CODICI DI FORMATTAZIONE, ed e' la ragione per cui
// tutto questo esiste: chi scrive `<dark_gray>` vuole vedere che colore sara'.
// Dipingerlo di un colore diverso da quello che il giocatore vedra' sarebbe
// peggio che non colorarlo affatto.

import { describe, expect, it } from 'vitest';
import { codeColour, codeStyle, highlightYaml, type Token } from '#web/lib/yaml-highlight.ts';

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

describe('i codici di formattazione hanno il colore che avranno in gioco', () => {
  it('i nomi MiniMessage, aperti e chiusi', () => {
    expect(codeColour('<red>')).toBe('#FF5555');
    expect(codeColour('</white>')).toBe('#FFFFFF');
    expect(codeColour('<dark_gray>')).toBe('#555555');
  });

  it('l`esadecimale e` se stesso', () => {
    expect(codeColour('<#FF5C5C>')).toBe('#FF5C5C');
    expect(codeColour('</#9FE6B8>')).toBe('#9FE6B8');
  });

  it('una sfumatura prende il colore da cui parte', () => {
    expect(codeColour('<gradient:#FFF3C4:#FFD27A>')).toBe('#FFF3C4');
  });

  it('i vecchi codici valgono ancora, e sono gli stessi colori', () => {
    // `&a` e `<green>` sono lo stesso verde: la tavolozza e` una sola, e i
    // codici legacy si ricavano da quella invece di essere riscritti.
    expect(codeColour('&a')).toBe(codeColour('<green>'));
    expect(codeColour('&0')).toBe(codeColour('<black>'));
    expect(codeColour('§c')).toBe(codeColour('<red>'));
  });

  it('cio` che colore non ha resta neutro', () => {
    // Stile, click, segnaposto: non dire niente e` giusto, inventare un colore
    // no — sarebbe un tag che sembra dipingere e non dipinge.
    for (const code of ['<bold>', '&l', "<click:run_command:'/event join'>", '<player>', '<@&123456789>']) {
      expect(codeColour(code)).toBe('#8FA3AD');
    }
  });

  it('i colori troppo scuri si portano dietro una velatura', () => {
    // SENZA, `<black>` SAREBBE INVISIBILE: sotto questo strato c'e` una
    // textarea trasparente, quindi un tag nero su fondo scuro non e` poco
    // leggibile — e` un pezzo di riga che sparisce.
    expect(codeStyle('<black>').background).toBeDefined();
    expect(codeStyle('<dark_blue>').background).toBeDefined();
    expect(codeStyle('<white>').background).toBeUndefined();
    expect(codeStyle('<yellow>').background).toBeUndefined();
    // E il colore resta quello vero: cambia il dietro, non il davanti.
    expect(codeStyle('<black>').color).toBe('#000000');
  });

  it('i codici si staccano dal testo che li circonda', () => {
    expect(shape('  msg: "<red>Perso</red>"')).toEqual([
      ['plain', '  '],
      ['key', 'msg'],
      ['punct', ':'],
      ['plain', ' '],
      ['string', '"'],
      ['code', '<red>'],
      ['string', 'Perso'],
      ['code', '</red>'],
      ['string', '"'],
    ]);
  });

  it('ma non dentro un commento, dove sono prosa', () => {
    expect(only('# usa <red> per il rosso', 'code')).toEqual([]);
  });
});
