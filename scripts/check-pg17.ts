// Guardia di compatibilita' con PostgreSQL 17, il PAVIMENTO di produzione.
//
// PERCHE' ESISTE. In fase 1 `audit.verify_chain` usava `min(bytea)`, che e'
// stato aggiunto in PostgreSQL 18. La migration applicava pulita, i test erano
// verdi, e il guasto e' comparso solo in produzione — su un ramo di codice che
// nessuno aveva mai percorso. Due cose lo hanno reso possibile:
//
//   1. lo sviluppo gira su una versione PIU' NUOVA della produzione, quindi
//      ogni funzione introdotta dopo il 17 passa i test senza fiatare;
//   2. PL/pgSQL analizza l'SQL alla PRIMA ESECUZIONE, non alla CREATE: una
//      funzione creata e mai eseguita non e' stata verificata in nessun senso
//      utile della parola.
//
// COSA E' QUESTA GUARDIA, E COSA NON E'. E' una lista di NEGAZIONE: rende
// impossibile ripetere quella classe esatta di errore. NON e' una prova di
// compatibilita' con la 17 — nessuna analisi statica lo e'. La prova e'
// eseguire migration e test contro un cluster 17 vero, ed e' l'unica cosa che
// va scritta nel changelog come «verificato».
//
// La seconda meta' del presidio non e' qui ed e' piu' importante: OGNI
// funzione PL/pgSQL scritta va ESEGUITA almeno una volta nei test. Una
// migration che applica pulita non prova niente.
//
// Uso: `node scripts/check-pg17.ts`. Exit 1 al primo file colpevole.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIGRATIONS = join(ROOT, 'migrations');

/** La versione minima che la produzione garantisce. Cambiarla e' una decisione. */
const FLOOR = 17;

type Rule = { name: string; since: number; pattern: RegExp; why: string };

/**
 * Le funzioni predefinite si nominano NUDE.
 *
 * `auth.uuidv7()` e' una funzione di questo progetto, definita nella
 * migration 004: e' qualificata da uno schema nostro e non ha niente a che
 * vedere con la builtin della 18. Senza questo prefisso la guardia si accende
 * su codice corretto, e una guardia che grida al lupo viene disattivata.
 */
const NUDA = '(?<![.\\w])';

const RULES: Rule[] = [
  {
    name: 'min/max su bytea',
    since: 18,
    // Gli aggregati min()/max() su bytea non esistono prima della 18. E' LA
    // regressione che ha prodotto questa guardia: si scrive naturalmente in
    // una query sulla catena hash e fallisce solo dove i dati sono veri.
    pattern: /\b(?:min|max)\s*\(\s*[\w.]*(?:hash|digest|checksum|bytea|sig|mac)\w*\s*\)/i,
    why: 'aggregati su bytea: usare (array_agg(x ORDER BY ...))[1], come nella migration 010.',
  },
  {
    name: 'uuidv7()',
    since: 18,
    pattern: new RegExp(`${NUDA}uuidv7\\s*\\(`, 'i'),
    why: "generare l'UUID nell'applicazione, oppure gen_random_uuid().",
  },
  {
    name: 'casefold()',
    since: 18,
    pattern: new RegExp(`${NUDA}casefold\\s*\\(`, 'i'),
    why: "usare lower(), che e' quello che il resto dello schema gia' usa.",
  },
  {
    name: 'array_sort() / array_reverse()',
    since: 18,
    pattern: new RegExp(`${NUDA}array_(?:sort|reverse)\\s*\\(`, 'i'),
    why: 'ordinare nella sottoquery con ORDER BY dentro array_agg().',
  },
  {
    name: 'crc32() / crc32c()',
    since: 18,
    pattern: new RegExp(`${NUDA}crc32c?\\s*\\(`, 'i'),
    why: "usare digest()/sha256 come fa gia' la catena dell'audit.",
  },
  {
    name: 'vincoli NOT ENFORCED',
    since: 18,
    pattern: /\bNOT\s+ENFORCED\b/i,
    why: "un vincolo non applicato non e' un vincolo: toglierlo o applicarlo.",
  },
  {
    name: 'chiavi temporali WITHOUT OVERLAPS',
    since: 18,
    pattern: /\bWITHOUT\s+OVERLAPS\b/i,
    why: "chiave esplicita su (id, valid_from) piu' un controllo periodico di integrita'.",
  },
  {
    name: 'colonne generate VIRTUAL',
    since: 18,
    pattern: /\bGENERATED\s+ALWAYS\s+AS\s*\([^;]*?\)\s*VIRTUAL\b/is,
    why: "scrivere STORED: una colonna virtuale non e' nemmeno indicizzabile.",
  },
  {
    name: 'RETURNING OLD / NEW',
    since: 18,
    pattern: /\bRETURNING\s+(?:OLD|NEW)\b/i,
    why: "leggere il prima con una CTE separata, come fa gia' il registro attivita'.",
  },
  {
    name: 'pg_get_acl()',
    since: 18,
    pattern: new RegExp(`${NUDA}pg_get_acl\\s*\\(`, 'i'),
    why: 'interrogare direttamente relacl / proacl.',
  },
];

/**
 * Il testo senza commenti e senza letterali.
 *
 * Senza questo passaggio la guardia si accende sulla PROPRIA
 * documentazione: l'intestazione della 011 elenca per esteso tutto cio' che
 * e' vietato, ed e' giusto che lo faccia. Una guardia che costringe a non
 * scrivere il motivo del divieto e' una guardia che verra' disattivata.
 */
function strip(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    if (sql.startsWith('--', i)) {
      const nl = sql.indexOf('\n', i);
      // Si conservano gli a capo: i numeri di riga devono restare veri.
      if (nl === -1) break;
      out += '\n';
      i = nl + 1;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      const chunk = sql.slice(i, end === -1 ? sql.length : end + 2);
      out += chunk.replace(/[^\n]/g, ' ');
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    // Dollar quoting: il corpo delle funzioni NON si salta, e' proprio la
    // parte che va analizzata. Si saltano solo i letterali fra apici.
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j += 1;
      }
      out += sql.slice(i, j + 1).replace(/[^\n]/g, ' ');
      i = j + 1;
      continue;
    }
    out += sql[i];
    i += 1;
  }
  return out;
}

/**
 * Le eccezioni sono NOMINATE, con il motivo, e vengono stampate a ogni giro.
 *
 * Una guardia che si puo' zittire in silenzio non e' una guardia. Una riga qui
 * dentro deve poter essere letta fra un anno da chi non c'era, e deve dire
 * perche' e' ancora accettabile — non che qualcuno, una volta, ha deciso di
 * ignorarla.
 */
const EXCEPTIONS: { file: string; rule: string; why: string }[] = [
  {
    file: '001_schemas_roles_audit.sql',
    rule: 'min/max su bytea',
    why:
      "e' il difetto originale di audit.verify_chain, corretto dalla migration 010 " +
      "con CREATE OR REPLACE. La 001 e' applicata in produzione e non si modifica: " +
      'le migration sono forward-only.',
  },
];

type Violation = { file: string; line: number; text: string; rule: Rule };

function main(): void {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const violations: Violation[] = [];

  for (const file of files) {
    const path = join(MIGRATIONS, file);
    const lines = strip(readFileSync(path, 'utf8')).split('\n');
    for (const rule of RULES) {
      if (rule.since <= FLOOR) continue;
      if (EXCEPTIONS.some((e) => e.file === file && e.rule === rule.name)) continue;
      for (const [n, line] of lines.entries()) {
        if (!rule.pattern.test(line)) continue;
        violations.push({
          file: relative(ROOT, path).replaceAll('\\', '/'),
          line: n + 1,
          text: line.trim().slice(0, 100),
          rule,
        });
      }
    }
  }

  // Controllo positivo: STORED esplicito. Su un pavimento 17 la parola manca
  // e la CREATE fallisce; su 18 il default e' VIRTUAL e la colonna smette di
  // essere indicizzabile senza che nessuno abbia cambiato una riga.
  for (const file of files) {
    const path = join(MIGRATIONS, file);
    const body = strip(readFileSync(path, 'utf8'));
    const re = /GENERATED\s+ALWAYS\s+AS\s*\(/gi;
    for (const m of body.matchAll(re)) {
      const tail = body.slice(m.index, m.index + 400);
      if (/\bSTORED\b/i.test(tail) || /\bIDENTITY\b/i.test(tail)) continue;
      violations.push({
        file: relative(ROOT, path).replaceAll('\\', '/'),
        line: body.slice(0, m.index).split('\n').length,
        text: tail.split('\n')[0]?.trim().slice(0, 100) ?? '',
        rule: {
          name: 'colonna generata senza STORED',
          since: 18,
          pattern: re,
          why: "scrivere STORED esplicito: il default e' cambiato fra versioni.",
        },
      });
    }
  }

  if (violations.length === 0) {
    console.log(
      `pg${FLOOR} ok — ${files.length} migration analizzate, ${RULES.length} regole. ` +
        "La guardia esclude una classe di errori, non prova la compatibilita': quella si prova eseguendo.",
    );
    for (const e of EXCEPTIONS) console.log(`  eccezione: ${e.file} / ${e.rule} — ${e.why}`);
    return;
  }

  console.error(`\nCOSTRUZIONI NON DISPONIBILI IN POSTGRESQL ${FLOOR} (${violations.length}):\n`);
  for (const v of violations) {
    console.error(`  ${v.rule.name} — introdotta nella ${v.rule.since}`);
    console.error(`    ${v.file}:${v.line}  ${v.text}`);
    console.error(`    ${v.rule.why}\n`);
  }
  process.exit(1);
}

main();
