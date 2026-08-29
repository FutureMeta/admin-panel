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
import { buildTree, type ConfigFileSummary, moduleHue, titleOf } from '#web/lib/duels-config.ts';

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

  it('tornando a un ramo gia` visto la cartella si riscrive', () => {
    // IL CASO CHE UN CONFRONTO PIGRO SBAGLIA. Fra i due `inventories/` c'e'
    // `items.yml`, che sta nella radice: senza riscrivere la cartella, gli
    // ultimi due file sembrerebbero stare nella radice anche loro.
    expect(render([file('inventories/a.yml'), file('items.yml'), file('inventories/z.yml')])).toEqual([
      'inventories/',
      '  a.yml',
      '  z.yml',
      'items.yml',
    ]);
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
    expect(render(disordinati)).toEqual(['a.yml', 'inventories/', '  m.yml', 'z.yml']);
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
