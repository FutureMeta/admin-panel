// Le due regole sul manifest che stavano nel workflow di CI.
//
// Il workflow non c'e' piu'. Senza queste, la policy del §12 resterebbe
// scritta in un documento e in nessun posto capace di fermare un errore.
//
//  1. Versioni ESATTE. Un range in package.json rende il lockfile la
//     fotografia di ieri invece che un vincolo: basta che qualcuno rigeneri
//     il lock e `^1.2.3` diventa una minor mai provata.
//  2. Allowlist @better-auth/*. Quello scope e' un solo maintainer npm, 211
//     release e 13 advisory nel 2026: da solo vale meta' della superficie di
//     supply chain del progetto. Un pacchetto nuovo li' dentro deve entrare
//     di proposito, non perche' l'ha tirato dentro un comando.
//
// Uso: `node scripts/check-deps.ts`. Exit 1 alla prima violazione.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MANIFEST = fileURLToPath(new URL('../package.json', import.meta.url));

/** Gli unici @better-auth/* ammessi. Aggiungerne uno e' una decisione. */
const ALLOWED_BETTER_AUTH = new Set(['better-auth', '@better-auth/redis-storage']);

/** Un range: tutto cio' che non e' una versione e basta. */
const RANGE_PREFIX = /^[\^~><=]|\s\|\|\s|\s-\s|[x*]$/;

type Manifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function main(): void {
  const pkg = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const entries = Object.entries(deps);

  const loose = entries.filter(([, version]) => RANGE_PREFIX.test(version));
  const strays = entries
    .map(([name]) => name)
    .filter((name) => name.startsWith('@better-auth/') && !ALLOWED_BETTER_AUTH.has(name));

  if (loose.length === 0 && strays.length === 0) {
    console.log(`dipendenze ok — ${entries.length} pacchetti, tutti pinnati.`);
    return;
  }

  console.error('\nDIPENDENZE FUORI POLICY:\n');
  if (loose.length > 0) {
    console.error('  deps/exact-versions');
    console.error(
      '    §12: un range rende il lockfile una fotografia, non un vincolo. Scrivi la versione esatta.',
    );
    for (const [name, version] of loose) console.error(`      ${name}@${version}`);
    console.error('');
  }
  if (strays.length > 0) {
    console.error('  deps/better-auth-allowlist');
    console.error(
      `    §12: fuori allowlist (${[...ALLOWED_BETTER_AUTH].join(', ')}). Aggiungerne uno e' una decisione, non un effetto collaterale.`,
    );
    for (const name of strays) console.error(`      ${name}`);
    console.error('');
  }
  process.exit(1);
}

main();
