// Guardie di CI che FALLISCONO la build. Non sono lint "consigliato": sono
// invarianti di sicurezza che nessuna review manuale regge nel tempo.
//
//  1. §7 — unico punto di enforcement. Un confronto su ruoli o permessi fuori
//     da `src/authz/` significa che esiste una seconda fonte di verita', ed e'
//     quella che diverge alla prima modifica.
//  2. SEC-35 — divieto assoluto di innerHTML / dangerouslySetInnerHTML. Vale
//     soprattutto per la tabella audit, che renderizza user agent, ban_reason e
//     payload jsonb, cioe' stringhe controllate da terzi.
//  3. §8.7 — l'IP di un giocatore non esce dalla funzione che lo risolve. E'
//     l'invariante piu' fragile delle tre, perche' violarla non rompe niente:
//     tutto continua a funzionare, e quello che cambia e' solo cosa c'e'
//     scritto su disco.
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
const STATS_DIR = join('src', 'stats');
const GEO_DIR = join('src', 'geo');
/** L'unico file fuori da src/geo in cui un indirizzo puo' comparire: e' dove
 *  viene letto dall'hash e convertito, e non ne esce. */
const GEO_LOOKUP_FILE = join('src', 'stats', 'game-redis.ts');
const SCRIPTS_DIR = 'scripts';
/**
 * Dove valgono le regole geografiche.
 *
 * La cartella degli script E' INCLUSA, e non e' zelo: la sonda del passo 0
 * legge lo stesso campo, e chi la esegue ne redirige l'uscita su un file. Una
 * riga di stampa aggiunta li' domani passerebbe la CI e finirebbe su disco —
 * cioe' esattamente la cosa che queste guardie dichiarano di impedire.
 */
const inGeoScope = (rel: string) =>
  rel.startsWith(STATS_DIR + sep) || rel.startsWith(GEO_DIR + sep) || rel.startsWith(SCRIPTS_DIR + sep);
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
  /**
   * Cerca sul TESTO INTERO invece che riga per riga.
   *
   * Serve alle regole che devono tenere insieme due token che il formattatore
   * puo' separare con un a capo — per esempio `logger.info(` e l'oggetto di
   * contesto che lo segue.
   */
  multiline?: boolean;
};

const isInAuthz = (rel: string) => rel.startsWith(AUTHZ_DIR + sep) || rel === AUTHZ_DIR;
const isAllowlisted = (rel: string) => AUTHZ_ALLOWLIST.includes(rel);
const isAuthzTest = (rel: string) =>
  rel.startsWith(join('tests', '')) && /authz|rbac|dominan|grantab/i.test(rel);

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

  // §8.7 — l'IP di un giocatore non deve poter finire su disco.
  //
  // Non e' una regola di stile. La geolocalizzazione e' costruita perche'
  // l'indirizzo viva dentro UNA funzione e ne esca come due lettere: se un
  // giorno qualcuno lo porta fuori da li' — in un log, in una riga di
  // tabella, in un oggetto di contesto — la promessa scritta nel registro dei
  // trattamenti smette di essere vera, e non se ne accorge nessuno, perche'
  // funziona tutto.
  {
    id: 'geo/no-raw-ip-outside-lookup',
    why: "§8.5: l'indirizzo si risolve in `src/geo` e in `game-redis.ts`, e da li` esce come codice paese. Altrove in src/stats non deve nemmeno esistere come identificatore.",
    pattern: /\b(ip|address)\b/,
    exempt: (rel) => !rel.startsWith(STATS_DIR + sep) || rel === GEO_LOOKUP_FILE,
  },
  {
    id: 'geo/no-ip-in-logs',
    why: "§8.7: il rischio non e` il logger che si controlla, e` l'oggetto errore — un throw con l'hash Redis nel contesto serializza `address` e `ip` dentro lo stack.",
    pattern: /logger\s*\.\s*\w+\s*\(\s*\{[^}]*\b(ip|address)\b|JSON\s*\.\s*stringify\s*\(\s*\w*(hash|Hash)\b/,
    exempt: (rel) => !inGeoScope(rel),
    // PER FILE INTERO, non riga per riga.
    //
    // Il formattatore va a capo a 110 colonne, quindi una chiamata di log un
    // po` lunga finisce spezzata: `logger.info(` su una riga e l'oggetto sulla
    // successiva. Una regola per riga non la vede piu' — e quella e'
    // esattamente la forma che il codice assume dopo il primo `lint:fix`.
    // La guardia era stata provata a riga singola, che e' l'unica forma che
    // in pratica non capita.
    multiline: true,
  },
  {
    id: 'geo/no-ip-interpolated',
    why: "§8.7: la redazione di pino lavora sui PERCORSI di un oggetto, non dentro le stringhe. Un indirizzo interpolato in un messaggio d'errore arriva su disco intatto.",
    // `${...ip...}` dentro un template literal: copre `new Error(...)`, i
    // messaggi di log e qualunque stringa costruita a mano.
    pattern: /\$\{[^}]*\b(ip|address)\b[^}]*\}|\$\{[^}]*\[['"](ip|address)['"]\][^}]*\}/,
    // Vale ANCHE dentro game-redis.ts: li' l'identificatore e' legittimo, ma
    // infilarlo in una stringa non lo e' mai.
    exempt: (rel) => !inGeoScope(rel),
    multiline: true,
  },
  {
    id: 'stats/intl-formatters-are-module-level',
    why: "costruire un `Intl.DateTimeFormat` costa piu' che usarlo, e in questo modulo si formatta dentro cicli lunghi: l'asse di un anno ne creava 730 e ci metteva 93 ms a ogni giro di warm, cioe` ogni minuto, per un risultato identico. Con i formattatori a livello di modulo sono 6 ms. Un formattatore dentro una funzione e` sempre un errore qui, e non e` visibile in nessun test di correttezza: il risultato e` giusto, costa e basta.",
    // Rientrato di un livello significa dentro qualcosa: una funzione, un
    // metodo, un blocco. A colonna zero e` una costante di modulo, ed e` la
    // forma voluta.
    pattern: /^\s+.*\bnew Intl\.(DateTimeFormat|NumberFormat)\(/,
    exempt: (rel) => !rel.startsWith(STATS_DIR + sep),
  },
  {
    id: 'stats/date-column-never-against-a-bare-param',
    why: "una colonna `date` confrontata con un parametro nudo fa inferire il parametro come date, e il driver serializza la Date di JavaScript nel fuso del PROCESSO: in un container a UTC la mezzanotte romana diventa il giorno prima e la finestra perde l'ultimo giorno. Il difetto e` invisibile su una macchina italiana e presente solo in produzione, che e` il modo peggiore in cui un difetto possa esistere. Si passa da `stats.civil_day`, che decide il giorno nel fuso giusto e non in quello di chi esegue.",
    // Un parametro seguito da `::date` non e` in discussione: li' il valore
    // e` gia` una stringa di data e il fuso non entra nella conversione. Il
    // caso pericoloso e` la `Date` di JavaScript lasciata decidere al driver.
    pattern: /\b\w*\.?day\s*(?:>=|<=|<>|<|>|=)\s*\$\{[^}]*\}(?!::date)/,
    exempt: (rel) => !rel.startsWith(STATS_DIR + sep),
  },
  {
    id: 'stats/per-mode-behind-the-gate',
    why: 'le tre query per modalita` sono la parte cara del giro — `heatmapModeRows` misura 1,7 s sul 90g contro i 25 ms della gemella di rete — e la panoramica non ne legge una riga. Fuori dal cancello `anyMode` si pagano anche quando nessuno ha aperto una modalita`, e il range lungo torna troppo caro per essere riscaldato come gli altri: e` da li` che nasceva il 24h fresco e il 90g fermo a un quarto d`ora prima.',
    // La chiamata deve stare sul ramo vero di `anyMode ? ... : []`. Una riga
    // che nomina una di queste funzioni con `db` senza il cancello davanti e`
    // esattamente la regressione: non rompe niente, costa e basta — e un
    // difetto che non rompe niente non lo trova nessun test di correttezza.
    // `(db,` e non `(db`: la seconda forma colpisce anche la DICHIARAZIONE
    // `function distinctPlayersByMode(db: Database, ...)`, che ovviamente non
    // ha nessun cancello davanti — una guardia che grida sulla definizione
    // della cosa che protegge si disattiva da sola alla prima occhiata.
    pattern:
      /^(?!.*anyMode \?).*\b(heatmapModeRows|uniquesByModeRows|distinctPlayersByMode|serverMix)\(db[,)]/,
    exempt: (rel) => rel !== join('src', 'stats', 'read.ts'),
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
    /** Il file senza le righe di commento, ma con gli a capo al loro posto. */
    const body = lines.map(stripCommentsAndStrings).join('\n');

    for (const rule of RULES) {
      if (rule.exempt(rel)) continue;

      if (rule.multiline) {
        // Sul testo intero: il formattatore puo' separare con un a capo i due
        // token che la regola deve vedere insieme.
        const found = new RegExp(rule.pattern.source, `${rule.pattern.flags.replace('g', '')}g`);
        for (const m of body.matchAll(found)) {
          const line = body.slice(0, m.index).split('\n').length;
          violations.push({
            file: rel,
            line,
            text: (lines[line - 1] ?? m[0]).trim().slice(0, 120),
            rule: rule.id,
            why: rule.why,
          });
        }
        continue;
      }

      lines.forEach((raw, i) => {
        const line = stripCommentsAndStrings(raw);
        if (!line) return;
        if (rule.pattern.test(line)) {
          violations.push({
            file: rel,
            line: i + 1,
            text: raw.trim().slice(0, 120),
            rule: rule.id,
            why: rule.why,
          });
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
