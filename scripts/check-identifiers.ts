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

/**
 * Termini di DOMINIO: sono valori del database, non nomi inventati dal codice.
 *
 * Le chiavi dei moduli (`utenti`, `ruoli`, `inviti`, `sessioni`,
 * `impostazioni`, `statistiche`) e dei ruoli (`moderatore`) stanno nel seed
 * della migration 003 e le legge lo staff nella UI. Tradurle in inglese qui
 * significherebbe romperle la', ed e' gia' successo per un giro: i test hanno
 * cercato un ruolo `moderator` che non esiste.
 */
const DOMAIN_TERMS = new Set([
  'utenti',
  'ruoli',
  'inviti',
  'sessioni',
  'impostazioni',
  'statistiche',
  'moderatore',
]);

const NEWLINE = String.fromCharCode(10);

/** Svuota il corpo di una corrispondenza tenendo i delimitatori e le newline. */
function blankBetween(match: string): string {
  const kept = [...match.slice(1, -1)].filter((c) => c === NEWLINE).join('');
  return `${match[0]}${kept}${match[match.length - 1]}`;
}

function stripJsxText(source: string, isTsx: boolean): string {
  // Il testo fra > e < e' contenuto visibile, non un identificatore: le
  // etichette dell'interfaccia sono in italiano di proposito.
  //
  // Nei .tsx il testo confina anche con le graffe di un'interpolazione:
  // `Vengono mostrati{' '}` e `{rows.length} risultati` sono etichette quanto
  // il testo fra due tag, e senza questa estensione l'apostrofo di una parola
  // italiana apre una stringa fantasma che manda in confusione tutto il resto
  // del file.
  //
  // La sostituzione preserva le newline: senza, i numeri di riga riportati
  // scivolerebbero e indicherebbero il punto sbagliato.
  if (!isTsx) return source.replace(/>[^<>{}]+</g, blankBetween);

  // Due passate: la prima consuma i delimitatori, e un segmento adiacente
  // resterebbe fuori se non si ripassasse.
  const pattern = /[>}][^<>{}]+[<{]/g;
  return source.replace(pattern, blankBetween).replace(pattern, blankBetween);
}

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
      let newlines = '';
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') i += 1;
        // Un template letterale sta su piu' righe per davvero: le newline
        // vanno riportate, o i numeri di riga da qui in poi scivolano.
        if (source[i] === NEWLINE) newlines += NEWLINE;
        i += 1;
      }
      i += 1;
      out += `""${newlines}`;
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
    // L'ordine conta: prima il testo JSX, poi le stringhe. Al contrario, un
    // apostrofo dentro una frase italiana ("l'ha fatta") aprirebbe una
    // stringa che si chiude molto piu' avanti, e tutto cio' che sta in mezzo
    // sparirebbe dall'analisi o vi entrerebbe per sbaglio.
    const code = stripCommentsAndStrings(stripJsxText(readFileSync(file, 'utf8'), rel.endsWith('.tsx')));
    code.split('\n').forEach((line, idx) => {
      for (const match of line.matchAll(pattern)) {
        if (DOMAIN_TERMS.has(match[0].toLowerCase())) continue;
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
