// Guardie di CI che FALLISCONO la build. Non sono lint "consigliato": sono due
// invarianti di sicurezza che nessuna review manuale regge nel tempo.
//
//  1. §7 — unico punto di enforcement. Un confronto su ruoli o permessi fuori
//     da `src/authz/` significa che esiste una seconda fonte di verita', ed e'
//     quella che diverge alla prima modifica.
//  2. SEC-35 — divieto assoluto di innerHTML / dangerouslySetInnerHTML. Vale
//     soprattutto per la tabella audit, che renderizza user agent, ban_reason e
//     payload jsonb, cioe' stringhe controllate da terzi.
//
// Uso: `node scripts/check-guards.ts`. Exit 1 al primo file colpevole.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

type Violation = { file: string; line: number; text: string; rule: string; why: string };

const SCANNED_DIRS = ['src', 'web/src', 'scripts', 'tests'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage']);
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/** Il modulo che HA il diritto di parlare di ruoli e livelli. */
const AUTHZ_DIR = join('src', 'authz');
/** File a cui e' concesso nominare i ruoli perche' ne sono la definizione o il test. */
const AUTHZ_ALLOWLIST = [
  join('src', 'db', 'types.ts'), // l'interfaccia DB nomina le colonne, non decide
  join('scripts', 'check-guards.ts'), // questo file
  join('scripts', 'bootstrap-owner.ts'), // crea il primo owner: non e' una decisione di runtime
];

type Rule = {
  id: string;
  why: string;
  pattern: RegExp;
  /** true se il file e' esente */
  exempt: (rel: string) => boolean;
};

const isInAuthz = (rel: string) => rel.startsWith(AUTHZ_DIR + sep) || rel === AUTHZ_DIR;
const isAllowlisted = (rel: string) => AUTHZ_ALLOWLIST.includes(rel);
const isAuthzTest = (rel: string) => rel.startsWith(join('tests', '')) && /authz|rbac|dominan|grantab/i.test(rel);

const RULES: Rule[] = [
  {
    id: 'authz/no-session-user-role',
    why: '§9 e SEC-02: session.user e` uno snapshot, non riflette ban ne` declassamenti. Si legge authz:{userId}.',
    pattern: /\bsession\s*(\?\.)?\.\s*user\b/,
    exempt: (rel) => isInAuthz(rel) || isAllowlisted(rel) || isAuthzTest(rel),
  },
  {
    id: 'authz/no-hasPermission',
    why: '§7: l`unico helper di autorizzazione e` can(actor, module, level) in src/authz/.',
    pattern: /\bhasPermission\s*\(/,
    exempt: (rel) => isInAuthz(rel) || isAllowlisted(rel),
  },
  {
    id: 'authz/no-role-name-comparison',
    why: '§7: nessun confronto diretto su un nome di ruolo fuori da src/authz/. I permessi sono livelli, non nomi.',
    // ===/!== / includes() contro una stringa che e' un nome di ruolo noto
    pattern:
      /(===|!==|==|!=)\s*['"`](owner|admin|dev|developer|moderator|moderatore|staff)['"`]|['"`](owner|admin|dev|developer|moderator|moderatore|staff)['"`]\s*(===|!==|==|!=)|\.(includes|indexOf|startsWith)\(\s*['"`](owner|admin|dev|developer|moderator|moderatore|staff)['"`]/,
    exempt: (rel) => isInAuthz(rel) || isAllowlisted(rel) || isAuthzTest(rel),
  },
  {
    id: 'authz/no-role-field-read',
    why: '§7 e verdetto 3 del §0: il plugin admin di better-auth non e` registrato, la colonna `role` non esiste. Un accesso a .role e` codice che presume un altro modello.',
    pattern: /\.\s*role\s*(===|!==|==|!=|\?\.|\))/,
    exempt: (rel) => isInAuthz(rel) || isAllowlisted(rel) || isAuthzTest(rel),
  },
  {
    id: 'sec-35/no-innerHTML',
    why: 'SEC-35: divieto assoluto. La tabella audit renderizza stringhe controllate da terzi.',
    pattern: /\b(innerHTML|outerHTML|insertAdjacentHTML|document\s*\.\s*write)\b/,
    exempt: () => false,
  },
  {
    id: 'sec-35/no-dangerouslySetInnerHTML',
    why: 'SEC-35: divieto assoluto, anche con contenuto che "sicuramente" e` fidato.',
    pattern: /dangerouslySetInnerHTML/,
    exempt: () => false,
  },
  {
    id: 'sec-20/no-client-redirect-param',
    why: 'SEC-20: nessun parametro di redirect accettato dal client in fase 1. Le destinazioni sono costanti server-side.',
    pattern: /\b(callbackURL|callback_url|redirectTo|redirect_uri|returnTo|return_to)\b/,
    exempt: () => false,
  },
];

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (CODE_EXT.test(name)) out.push(full);
  }
}

function stripCommentsAndStrings(line: string): string {
  // Basta togliere le righe di commento: le regole devono colpire il codice,
  // non la documentazione che spiega perche' quel codice e' vietato.
  const trimmed = line.trimStart();
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return '';
  return line;
}

function main(): void {
  const files: string[] = [];
  for (const d of SCANNED_DIRS) walk(join(ROOT, d), files);

  // Questo file CONTIENE i pattern vietati: e' la loro definizione. Escluderlo
  // e' l'unica esenzione globale, ed e' esplicita.
  const SELF = join('scripts', 'check-guards.ts');

  const violations: Violation[] = [];
  for (const file of files) {
    const rel = relative(ROOT, file);
    if (rel === SELF) continue;
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    for (const rule of RULES) {
      if (rule.exempt(rel)) continue;
      lines.forEach((raw, i) => {
        const line = stripCommentsAndStrings(raw);
        if (!line) return;
        if (rule.pattern.test(line)) {
          violations.push({ file: rel, line: i + 1, text: raw.trim().slice(0, 120), rule: rule.id, why: rule.why });
        }
      });
    }
  }

  if (violations.length === 0) {
    console.log(`guardie ok — ${files.length} file analizzati, ${RULES.length} regole.`);
    return;
  }

  console.error(`\nGUARDIE VIOLATE (${violations.length}):\n`);
  const byRule = new Map<string, Violation[]>();
  for (const v of violations) {
    const list = byRule.get(v.rule) ?? [];
    list.push(v);
    byRule.set(v.rule, list);
  }
  for (const [rule, list] of byRule) {
    console.error(`  ${rule}`);
    console.error(`    ${list[0]?.why}`);
    for (const v of list) console.error(`      ${v.file}:${v.line}  ${v.text}`);
    console.error('');
  }
  process.exit(1);
}

main();
