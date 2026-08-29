// I tipi e le funzioni pure di «Duels · Configurazioni».
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

export type TreeRow =
  | { kind: 'dir'; label: string; depth: number; key: string }
  | { kind: 'file'; label: string; depth: number; key: string; path: string; versions: number };

/**
 * Dall'elenco piatto dei percorsi all'albero della barra laterale.
 *
 * LE CARTELLE NON ESISTONO nel database: sono implicite nel percorso e nascono
 * qui. E' il motivo per cui non c'e' modo di avere una cartella vuota da
 * ripulire — senza un file dentro, la cartella non compare.
 *
 * UNA CARTELLA SI SCRIVE SOLO QUANDO CAMBIA rispetto al file precedente. Senza
 * quel confronto, `inventories/` comparirebbe sessanta volte di fila, una per
 * ogni file che ci sta dentro.
 */
export function buildTree(files: readonly ConfigFileSummary[]): TreeRow[] {
  const rows: TreeRow[] = [];
  let previous: string[] = [];

  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const parts = file.path.split('/');
    const dirs = parts.slice(0, -1);

    for (const [depth, dir] of dirs.entries()) {
      // Basta che UN livello differisca perche' tutti quelli sotto vadano
      // riscritti: passando da `inventories/event/` a `inventories/ffa/`, la
      // prima cartella e' la stessa e la seconda no.
      if (previous[depth] === dir && dirs.slice(0, depth).join('/') === previous.slice(0, depth).join('/')) {
        continue;
      }
      rows.push({ kind: 'dir', label: `${dir}/`, depth, key: dirs.slice(0, depth + 1).join('/') });
    }

    rows.push({
      kind: 'file',
      label: parts.at(-1) ?? file.path,
      depth: dirs.length,
      key: file.path,
      path: file.path,
      versions: file.versions,
    });
    previous = dirs;
  }
  return rows;
}
