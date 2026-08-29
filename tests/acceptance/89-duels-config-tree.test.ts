// L'albero della barra laterale, costruito dai percorsi.
//
// E' L'UNICA LOGICA VERA DELLA SCHERMATA, e senza un test si nota solo
// guardando una barra laterale storta — che e' il modo in cui un difetto di
// impaginazione sopravvive per mesi.
//
// LE CARTELLE NON ESISTONO NEL DATABASE: sono implicite nel percorso e nascono
// qui. Da questo discendono due cose che i test qui sotto fissano: non puo'
// esistere una cartella vuota, e una cartella non si ripete per ognuno dei
// sessanta file che contiene.

import { describe, expect, it } from 'vitest';
import {
  buildTree,
  type ConfigFileSummary,
  filesUnder,
  isHidden,
  moduleHue,
  titleOf,
} from '#web/lib/duels-config.ts';

function file(path: string, versions = 1): ConfigFileSummary {
  return { path, modules: ['lobby'], split: versions > 1, versions, hasDraft: false, by: null, at: null };
}

/** Come si legge l'albero: indentazione compresa, che e' meta' dell'informazione. */
function render(files: ConfigFileSummary[]): string[] {
  return buildTree(files).map((r) => `${' '.repeat(r.depth * 2)}${r.label}`);
}

describe('le cartelle nascono dai percorsi, e non si ripetono', () => {
  it('una cartella compare una volta sola, non una per file', () => {
    // IL DIFETTO CHE QUESTA RIGA IMPEDISCE: con sessanta file dentro
    // `inventories/`, una cartella scritta per ogni file darebbe una barra
    // laterale lunga il doppio e illeggibile.
    expect(render([file('inventories/a.yml'), file('inventories/b.yml'), file('inventories/c.yml')])).toEqual(
      ['inventories/', '  a.yml', '  b.yml', '  c.yml'],
    );
  });

  it('i file della radice restano in cima, senza cartella', () => {
    expect(render([file('config.yml'), file('messages.yml')])).toEqual(['config.yml', 'messages.yml']);
  });

  it('due sottocartelle dello stesso ramo scrivono solo la seconda', () => {
    // `inventories/` non si riscrive passando da `event/` a `ffa/`: cambia il
    // livello sotto, non quello sopra.
    expect(
      render([
        file('inventories/event/uhc.yml'),
        file('inventories/event/tnt_run.yml'),
        file('inventories/ffa/sword.yml'),
      ]),
    ).toEqual(['inventories/', '  event/', '    tnt_run.yml', '    uhc.yml', '  ffa/', '    sword.yml']);
  });

  it('prima tutti i file di un livello, poi le sue cartelle', () => {
    // E' L'ORDINE, ed e' anche la ragione per cui una vecchia classe di difetti
    // non esiste piu'. Prima le righe uscivano scorrendo i percorsi in fila, e
    // `items.yml` finiva DOPO `inventories/`: i due file della cartella
    // restavano sopra di lui, e lui sembrava starci dentro. Camminando l'albero
    // per livelli il caso non si presenta — i file della radice escono tutti
    // prima che una cartella si apra.
    expect(render([file('inventories/a.yml'), file('items.yml'), file('inventories/z.yml')])).toEqual([
      'items.yml',
      'inventories/',
      '  a.yml',
      '  z.yml',
    ]);
  });

  it('e vale a ogni livello, non solo alla radice', () => {
    expect(
      render([
        file('inventories/event/uhc.yml'),
        file('inventories/settings.yml'),
        file('inventories/ffa/sword.yml'),
      ]),
    ).toEqual(['inventories/', '  settings.yml', '  event/', '    uhc.yml', '  ffa/', '    sword.yml']);
  });

  it('non esiste una cartella senza file dentro', () => {
    // Non e' una regola scritta da qualche parte: e' una conseguenza. Le
    // cartelle si ricavano dai file, quindi senza file non c'e' cartella, e
    // non c'e' niente da ripulire.
    const rows = buildTree([file('inventories/event/uhc.yml')]);
    const dirs = rows.filter((r) => r.kind === 'dir');
    const files = rows.filter((r) => r.kind === 'file');
    expect(dirs).toHaveLength(2);
    expect(files).toHaveLength(1);
  });

  it('un elenco vuoto da` un albero vuoto, non una riga fantasma', () => {
    expect(buildTree([])).toEqual([]);
  });
});

describe('l`ordine e` quello del percorso, sempre lo stesso', () => {
  it('l`albero non balla fra due letture', () => {
    // L'API ordina gia' per percorso, ma la barra laterale non puo' dipendere
    // da quello: un ordine che cambia a ogni richiesta farebbe saltare la voce
    // sotto il cursore mentre qualcuno la sta cliccando.
    const disordinati = [file('z.yml'), file('a.yml'), file('inventories/m.yml')];
    expect(render(disordinati)).toEqual(render([...disordinati].reverse()));
    expect(render(disordinati)).toEqual(['a.yml', 'z.yml', 'inventories/', '  m.yml']);
  });
});

describe('le briciole della schermata', () => {
  it('il titolo e` il nome del file senza estensione', () => {
    expect(titleOf('inventories/event/tnt_run.yml')).toBe('tnt_run');
    expect(titleOf('config.yml')).toBe('config');
  });

  it('il colore di un modulo e` stabile, e non due moduli lo condividono', () => {
    // Due moduli con lo stesso colore per caso renderebbero le pastiglie
    // inutili proprio dove servono: accanto al nome di un file condiviso.
    const moduli = ['lobby', 'game', 'ffa', 'event', 'replay', 'setup', 'duel-command', 'event-command'];
    const colori = moduli.map(moduleHue);
    expect(new Set(colori).size).toBe(moduli.length);
    expect(moduleHue('lobby')).toBe(moduleHue('lobby'));
    // Un modulo che il pannello non conosce ha comunque un colore, invece di
    // una pastiglia trasparente che sembra un errore di disegno.
    expect(moduleHue('modulo-di-domani')).toMatch(/^#[0-9A-F]{6}$/i);
  });
});

describe('le cartelle si chiudono, e si portano dietro tutto', () => {
  const ALBERO = [
    file('items.yml'),
    file('inventories/settings.yml'),
    file('inventories/event/uhc.yml'),
    file('inventories/event/tnt_run.yml'),
  ];

  it('chiudendo una cartella spariscono anche i suoi nipoti', () => {
    // SI GUARDA TUTTA LA CATENA, non solo il genitore: `uhc.yml` sta dentro
    // `inventories/event/`, che e` ancora aperta — ma sua nonna no.
    const rows = buildTree(ALBERO);
    const chiuse = new Set(['inventories']);
    const visibili = rows.filter((r) => !isHidden(r, chiuse)).map((r) => r.label);
    expect(visibili).toEqual(['items.yml', 'inventories/']);
  });

  it('chiudendo solo la sottocartella resta il resto del livello', () => {
    const rows = buildTree(ALBERO);
    const chiuse = new Set(['inventories/event']);
    const visibili = rows.filter((r) => !isHidden(r, chiuse)).map((r) => r.label);
    expect(visibili).toEqual(['items.yml', 'inventories/', 'settings.yml', 'event/']);
  });

  it('una cartella chiusa non nasconde se stessa', () => {
    // Sarebbe il difetto piu` sciocco possibile: la si chiude e sparisce, e da
    // quel momento non c'e` piu` modo di riaprirla.
    const rows = buildTree(ALBERO);
    const dir = rows.find((r) => r.key === 'inventories');
    expect(dir && isHidden(dir, new Set(['inventories']))).toBe(false);
  });

  it('senza niente di chiuso si vede tutto', () => {
    const rows = buildTree(ALBERO);
    expect(rows.every((r) => !isHidden(r, new Set()))).toBe(true);
  });
});

describe('cosa porta via una cartella', () => {
  const ALBERO = [
    file('menus/main.yml'),
    file('menus/duel/arena.yml'),
    file('menus/duel/kit.yml'),
    file('menus_old/main.yml'),
    file('config.yml'),
  ];

  it('prende tutto quello che ci sta sotto, a ogni profondita`', () => {
    expect(filesUnder(ALBERO, 'menus').map((f) => f.path)).toEqual([
      'menus/main.yml',
      'menus/duel/arena.yml',
      'menus/duel/kit.yml',
    ]);
    expect(filesUnder(ALBERO, 'menus/duel').map((f) => f.path)).toEqual([
      'menus/duel/arena.yml',
      'menus/duel/kit.yml',
    ]);
  });

  it('e NON prende la cartella che comincia allo stesso modo', () => {
    // IL DIFETTO CHE QUESTA RIGA IMPEDISCE. `menus_old/` comincia per `menus`,
    // e senza la barra in fondo al prefisso comparirebbe nell'elenco dei file
    // che si stanno per cancellare — cioe` la finestra di conferma direbbe una
    // cosa e il server ne farebbe un'altra.
    expect(filesUnder(ALBERO, 'menus').map((f) => f.path)).not.toContain('menus_old/main.yml');
  });

  it('una cartella che non esiste non porta via niente', () => {
    expect(filesUnder(ALBERO, 'inventories')).toEqual([]);
    // E nemmeno la radice: la stringa vuota qui vorrebbe dire «tutto», ed e`
    // esattamente la cosa che non deve poter succedere per sbaglio.
    expect(filesUnder(ALBERO, '').map((f) => f.path)).toEqual([]);
  });
});
