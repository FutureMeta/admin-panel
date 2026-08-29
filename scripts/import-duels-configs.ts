// Il primo caricamento: dai sorgenti del plugin alle tabelle del pannello.
//
// SI ESEGUE UNA VOLTA SOLA, da una macchina che ha il checkout di `duels`, e
// STAMPA SQL invece di scrivere sul database. Il pannello gira in un container
// che quel checkout non ce l'ha, e mandare le INSERT via rete da qui vorrebbe
// dire aprire Postgres verso l'esterno per un'operazione che si fa una volta.
// Cosi' l'output si legge prima di applicarlo, che su centosedici file e' la
// differenza fra una migrazione e una scommessa.
//
// COME DECIDE SE UN FILE E' CONDIVISO. Solo per identita' dei byte: se tutti i
// moduli che hanno quel percorso hanno lo stesso identico contenuto, nasce una
// versione sola legata a tutti; altrimenti nasce una versione per modulo.
//
// NON PROVA A UNIFICARE I QUASI-UGUALI, ed e' deliberato. Ventisei percorsi
// esistono in piu' moduli e diciotto hanno oltre il 95% delle chiavi in comune
// — sono lo stesso file andato alla deriva — ma «somiglia molto» non e' «e' lo
// stesso», e uno script che decidesse da solo sceglierebbe quale versione
// sopravvive senza che nessuno l'abbia guardata. L'unificazione si fa dal
// pannello, guardandole.
//
// Uso:
//   node scripts/import-duels-configs.ts "C:/Users/fiore/Desktop/Progetti/duels" import.sql
//
// Poi si legge `import.sql`, e si applica con psql come qualunque altra cosa.
//
// IL FILE LO SCRIVE LUI: la redirezione della console lo rovinerebbe, e per
// come e` fatto il danno non se ne accorgerebbe nessuno fino al gioco. Vedi la
// nota in fondo, e `fix-config-encoding.ts`.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { CONFIG_FORBIDDEN, CONFIG_MODULES, isConfigPath } from '#src/duels/config-store.ts';

/**
 * Dove stanno i moduli, e come si chiamano nel pannello.
 *
 * SOLO `servers/` E `standalone/`. `platform/` e `event/` sono librerie: le
 * loro risorse finiscono dentro i jar dei server, e trattarle come moduli a se'
 * darebbe percorsi che nessun server chiede mai.
 */
const MODULE_DIRS: ReadonlyArray<{ dir: string; module: string }> = [
  { dir: 'servers/lobby', module: 'lobby' },
  { dir: 'servers/game', module: 'game' },
  { dir: 'servers/ffa', module: 'ffa' },
  { dir: 'servers/event', module: 'event' },
  { dir: 'servers/replay', module: 'replay' },
  { dir: 'servers/setup', module: 'setup' },
  { dir: 'standalone/duel-command', module: 'duel-command' },
  { dir: 'standalone/event-command', module: 'event-command' },
];

/** L'autore delle righe importate. Non e' una persona, e non deve sembrarlo. */
const AUTHOR = 'import@metamc.it';

type Found = { module: string; path: string; content: string };

function walk(root: string, current: string, out: string[]): void {
  for (const entry of readdirSync(current)) {
    const full = join(current, entry);
    if (statSync(full).isDirectory()) {
      walk(root, full, out);
      continue;
    }
    if (entry.endsWith('.yml')) out.push(relative(root, full).split(sep).join('/'));
  }
}

function collect(checkout: string): Found[] {
  const found: Found[] = [];
  for (const { dir, module } of MODULE_DIRS) {
    const root = join(checkout, ...dir.split('/'), 'src', 'main', 'resources');
    let paths: string[] = [];
    try {
      walk(root, root, paths);
    } catch {
      // Un modulo che non esiste in questo checkout non e' un errore: il
      // plugin cambia, e lo script deve poter girare su una versione che ha un
      // modulo in meno.
      paths = [];
    }
    for (const path of paths) {
      if (CONFIG_FORBIDDEN.includes(path)) continue;
      if (!isConfigPath(path)) continue;
      found.push({ module, path, content: readFileSync(join(root, ...path.split('/')), 'utf8') });
    }
  }
  return found;
}

/** L'apostrofo raddoppiato: e' l'unica fuga che una stringa SQL richiede. */
function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function digest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function main(): void {
  const checkout = process.argv[2];
  const out = process.argv[3];
  if (!checkout || !out) {
    console.error('uso: node scripts/import-duels-configs.ts <checkout di duels> <file da scrivere>');
    process.exit(2);
  }

  const found = collect(checkout);
  const byPath = new Map<string, Found[]>();
  for (const item of found) {
    const list = byPath.get(item.path) ?? [];
    list.push(item);
    byPath.set(item.path, list);
  }

  const paths = [...byPath.keys()].sort();
  let shared = 0;
  let split = 0;

  const lines: string[] = [
    '-- Generato da scripts/import-duels-configs.ts. Si legge prima di applicarlo.',
    '--',
    '-- I file nascono GIA` PUBBLICATI: sono cio` che i server hanno adesso, quindi',
    '-- importarli come bozze vorrebbe dire che al primo avvio dopo l`import i',
    '-- server non riceverebbero niente e tornerebbero ai default del jar.',
    'BEGIN;',
    '',
  ];

  for (const path of paths) {
    const items = (byPath.get(path) ?? []).slice().sort((a, b) => a.module.localeCompare(b.module));
    const hashes = new Set(items.map((i) => digest(i.content)));
    const uniform = hashes.size === 1;
    if (uniform) shared += 1;
    else split += 1;

    lines.push(
      `-- ${path} · ${items.length} modul${items.length === 1 ? 'o' : 'i'} · ` +
        `${uniform ? 'una versione condivisa' : `${hashes.size} versioni distinte`}`,
    );
    lines.push('WITH p AS (');
    lines.push('  INSERT INTO stats.duels_config_path (path, created_by)');
    lines.push(`  VALUES (${quote(path)}, ${quote(AUTHOR)}) RETURNING id`);
    lines.push(')');

    if (uniform) {
      const content = items[0]?.content ?? '';
      lines.push(', v AS (');
      lines.push('  INSERT INTO stats.duels_config_version (path_id, published, published_at, published_by)');
      lines.push(`  SELECT p.id, ${quote(content)}, now(), ${quote(AUTHOR)} FROM p RETURNING id, path_id`);
      lines.push(')');
      lines.push('INSERT INTO stats.duels_config_binding (path_id, module, version_id)');
      lines.push(
        `SELECT v.path_id, m.module, v.id FROM v, (VALUES ${items
          .map((i) => `(${quote(i.module)})`)
          .join(', ')}) AS m(module);`,
      );
    } else {
      // Una CTE per modulo: ognuna crea la sua versione e il suo legame. Piu'
      // verbosa di un ciclo, e leggibile riga per riga — che e' cio' che serve
      // a chi rilegge il file prima di applicarlo.
      const parts: string[] = [];
      for (const [index, item] of items.entries()) {
        parts.push(`, v${index} AS (`);
        parts.push(
          '  INSERT INTO stats.duels_config_version (path_id, published, published_at, published_by)',
        );
        parts.push(
          `  SELECT p.id, ${quote(item.content)}, now(), ${quote(AUTHOR)} FROM p RETURNING id, path_id`,
        );
        parts.push(')');
        parts.push(`, b${index} AS (`);
        parts.push('  INSERT INTO stats.duels_config_binding (path_id, module, version_id)');
        parts.push(`  SELECT path_id, ${quote(item.module)}, id FROM v${index} RETURNING 1`);
        parts.push(')');
      }
      lines.push(...parts);
      lines.push(`SELECT 1;`);
    }
    lines.push('');
  }

  lines.push('COMMIT;');
  // SCRIVE LUI IL FILE, e non si fa redirigere lo standard output.
  //
  // La console di Windows non parla UTF-8: passando di li', `●` — che e' un
  // carattere solo, tre byte — arriva nel file come `ÔùÅ`, cioe' i suoi tre
  // byte letti uno per uno come CP850 e riscritti. Da quel momento il testo
  // giusto non esiste piu' da nessuna parte, e i server servono ai giocatori
  // dei menu pieni di caratteri a caso. E' successo davvero: a rimetterlo a
  // posto c'e' voluto `fix-config-encoding.ts`.
  writeFileSync(out, `${lines.join('\n')}\n`, 'utf8');
  console.error(`scritto ${out}`);

  console.error(
    `${paths.length} percorsi · ${shared} con una versione condivisa · ${split} divisi per modulo`,
  );
  console.error(
    `moduli letti: ${MODULE_DIRS.filter((m) => found.some((f) => f.module === m.module))
      .map((m) => m.module)
      .join(', ')}`,
  );
  console.error(`esclusi per regola: ${CONFIG_FORBIDDEN.join(', ')}`);
  console.error(`moduli ammessi dal pannello: ${CONFIG_MODULES.join(', ')}`);
}

main();
