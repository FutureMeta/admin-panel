// Guardia di CI: gli IDENTIFICATORI sono in inglese.
//
// I commenti restano in italiano di proposito — spiegano decisioni a chi
// mantiene il sistema, e sono la parte del codice che si legge di piu'. Ma
// nomi di classi, funzioni, variabili, campi e valori di unione devono essere
// in inglese: sono l'interfaccia con librerie, log e chiunque legga uno stack
// trace.
//
// Il controllo lavora sul sorgente ripulito da commenti e stringhe: una
// parola italiana dentro un messaggio d'errore o un commento non e' una
// violazione.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIRS = ['src', 'scripts', 'tests', 'web/src'];
const SKIP = new Set(['node_modules', 'dist', '.git', 'coverage']);

/**
 * Parole italiane che sono comparse davvero in questo repository. Non e' un
 * dizionario: e' l'elenco di cio' che va cercato, e cresce solo quando
 * qualcuno prova a introdurne una nuova.
 */
const ITALIAN = [
  'annulla',
  'apri',
  'attendi',
  'bersaglio',
  'bottone',
  'conferma',
  'consumo',
  'corpo',
  'debole',
  'discrepanze',
  'emetti',
  'errate',
  'esistente',
  'esiti',
  'esito',
  'firma',
  'forte',
  'guscio',
  'inesistente',
  'invia',
  'invito',
  'latenze',
  'mediana',
  'nome',
  'nostro',
  'nuova',
  'occupata',
  'paragrafo',
  'raffica',
  'risolto',
  'risultato',
  'risultati',
  'riusciti',
  'scadenza',
  'semaforo',
  'speso',
  'sveglia',
  'testo',
  'titolo',
  'trascritto',
  'utenti',
  'vecchio',
  // composti camelCase gia' incontrati
  'emettiInvito',
  'apriInvito',
  'tempoDiLogin',
  'attendiSlot',
];

function stripCommentsAndStrings(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (two === '/*') {
      i += 2;
      while (i < n && source.slice(i, i + 2) !== '*/') i += 1;
      i += 2;
      continue;
    }
    const c = source[i];
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i += 1;
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      out += '""';
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function walk(dir: string, acc: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx)$/.test(name)) acc.push(full);
  }
}

function main(): void {
  const files: string[] = [];
  for (const d of DIRS) walk(join(ROOT, d), files);

  const found: string[] = [];
  const pattern = new RegExp(`(?<![A-Za-z0-9_$])(${ITALIAN.join('|')})(?![A-Za-z0-9_$])`, 'gi');

  for (const file of files) {
    const rel = relative(ROOT, file);
    if (rel === join('scripts', 'check-identifiers.ts')) continue;
    const code = stripCommentsAndStrings(readFileSync(file, 'utf8'));
    code.split('\n').forEach((line, idx) => {
      for (const match of line.matchAll(pattern)) {
        found.push(`  ${rel}:${idx + 1}  ${match[0]}`);
      }
    });
  }

  if (found.length === 0) {
    console.log(`identificatori ok — ${files.length} file analizzati.`);
    return;
  }
  console.error(`\nIDENTIFICATORI NON IN INGLESE (${found.length}):\n`);
  for (const f of found) console.error(f);
  console.error('\nI commenti possono restare in italiano; i nomi no.\n');
  process.exit(1);
}

main();
