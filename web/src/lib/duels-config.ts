// I tipi e le funzioni pure di «Duels · Configs».
//
// STANNO IN UN MODULO SENZA JSX perche' li usano due componenti — la schermata
// e i suoi dialoghi — e perche' l'albero si puo' provare senza montare React.
// La costruzione dell'albero dai percorsi e' l'unico pezzo di logica vera di
// tutta la schermata, ed e' proprio quello che senza un test si nota solo
// guardando una barra laterale storta.

export type ConfigVersion = {
  id: number;
  modules: string[];
  published: string | null;
  publishedAt: string | null;
  publishedBy: string | null;
  draft: string | null;
  draftAt: string | null;
  draftBy: string | null;
};

export type ConfigFileSummary = {
  path: string;
  modules: string[];
  split: boolean;
  versions: number;
  hasDraft: boolean;
  by: string | null;
  at: string | null;
};

export type ConfigTree = { modules: string[]; files: ConfigFileSummary[] };
export type ConfigFile = { path: string; split: boolean; versions: ConfigVersion[] };

/**
 * Il colore di un modulo. Stabile per nome, dalla tavolozza categorica del
 * design system: due moduli diversi non devono avere lo stesso colore per
 * caso, e lo stesso modulo non deve cambiarlo fra una schermata e l'altra.
 */
const MODULE_HUES: Record<string, string> = {
  lobby: '#E8822B',
  game: '#3FA3D4',
  ffa: '#57B8A6',
  event: '#9B8FD9',
  replay: '#8FA3AD',
  setup: '#C4566A',
  'duel-command': '#F2CC7B',
  'event-command': '#D9E2E7',
};

export function moduleHue(module: string): string {
  return MODULE_HUES[module] ?? '#8FA3AD';
}

/** Il nome che si legge in testa: il file, senza estensione. */
export function titleOf(path: string): string {
  const name = path.split('/').at(-1) ?? path;
  return name.replace(/\.yml$/, '');
}

export type TreeRow = {
  kind: 'dir' | 'file';
  label: string;
  depth: number;
  /** Il percorso della riga: la cartella, o il file. Identifica la riga. */
  key: string;
  /** La cartella che la contiene, `''` per la radice. Serve a chiuderla. */
  parent: string;
  /** Solo sui file. */
  path?: string;
  versions?: number;
};

/**
 * Dall'elenco piatto dei percorsi all'albero della barra laterale.
 *
 * LE CARTELLE NON ESISTONO nel database: sono implicite nel percorso e nascono
 * qui. E' il motivo per cui non c'e' modo di avere una cartella vuota da
 * ripulire — senza un file dentro, la cartella non compare.
 *
 * A OGNI LIVELLO PRIMA I FILE, POI LE CARTELLE, ognuno dei due gruppi in ordine
 * alfabetico. Con l'ordinamento per percorso e basta, `inventories/` finiva in
 * mezzo ai file della radice e ci si portava dietro sessanta righe: i due file
 * di primo livello rimasti sotto sembravano stare dentro la cartella.
 *
 * SI SCENDE PER LIVELLI e non si ordina una lista piatta, ed e' la differenza
 * che conta. Scrivendo le cartelle mentre si scorrono i percorsi in fila
 * bisogna ricordarsi quale ramo si era gia' aperto — e sbagliare quel confronto
 * produce una cartella ripetuta o, peggio, un file che sembra stare altrove.
 * Camminando l'albero il problema non si pone: ogni cartella si scrive una
 * volta, quando ci si entra.
 */
export function buildTree(files: readonly ConfigFileSummary[]): TreeRow[] {
  /** I file di ciascuna cartella, per percorso della cartella. */
  const inDir = new Map<string, ConfigFileSummary[]>();
  /** Le sottocartelle di ciascuna cartella. */
  const subDirs = new Map<string, Set<string>>();

  for (const file of files) {
    const parts = file.path.split('/');
    const dir = parts.slice(0, -1).join('/');
    inDir.set(dir, [...(inDir.get(dir) ?? []), file]);

    // Tutta la catena di antenati, non solo il genitore: una cartella che
    // contiene solo altre cartelle esiste lo stesso e va scritta.
    for (let depth = 0; depth < parts.length - 1; depth += 1) {
      const parent = parts.slice(0, depth).join('/');
      const child = parts.slice(0, depth + 1).join('/');
      subDirs.set(parent, (subDirs.get(parent) ?? new Set()).add(child));
    }
  }

  const rows: TreeRow[] = [];

  const walk = (dir: string, depth: number): void => {
    for (const file of (inDir.get(dir) ?? []).sort((a, b) => a.path.localeCompare(b.path))) {
      rows.push({
        kind: 'file',
        label: file.path.split('/').at(-1) ?? file.path,
        depth,
        key: file.path,
        parent: dir,
        path: file.path,
        versions: file.versions,
      });
    }
    for (const child of [...(subDirs.get(dir) ?? [])].sort((a, b) => a.localeCompare(b))) {
      rows.push({
        kind: 'dir',
        label: `${child.split('/').at(-1)}/`,
        depth,
        key: child,
        parent: dir,
      });
      walk(child, depth + 1);
    }
  };

  walk('', 0);
  return rows;
}

/**
 * La riga e' nascosta perche' una cartella sopra di lei e' chiusa?
 *
 * Si guarda TUTTA la catena e non solo il genitore: chiudendo `inventories/`
 * devono sparire anche i file dentro `inventories/event/`, che di genitore
 * hanno `event` — ancora aperto.
 */
export function isHidden(row: TreeRow, collapsed: ReadonlySet<string>): boolean {
  let dir = row.parent;
  while (dir !== '') {
    if (collapsed.has(dir)) return true;
    dir = dir.split('/').slice(0, -1).join('/');
  }
  return false;
}
