// Il segnaposto del nonce deve sopravvivere al build del frontend.
//
// La CSP di §5.1 e' `strict-dynamic` con nonce: il server inietta il valore
// vero al posto di `__CSP_NONCE__` a ogni richiesta. Se Vite riscrive il tag
// script e perde l'attributo, il browser blocca il bundle e la pagina resta
// BIANCA — senza errori nel log del server, perche' dal suo punto di vista ha
// servito tutto correttamente.
//
// Il controllo e' sul TAG, non sulla presenza della stringa: cercare solo
// `__CSP_NONCE__` passerebbe anche se fosse rimasto dentro un commento.
//
// Girava in CI. Ora gira in coda a `pnpm run build:web`, che e' un posto
// migliore: copre anche il build fatto sul container al deploy, dove il
// bianco si vedrebbe in produzione invece che in una pull request.
//
// Uso: `node scripts/check-build.ts`. Exit 1 se il tag non c'e'.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const INDEX = fileURLToPath(new URL('../dist/index.html', import.meta.url));

const NONCED_SCRIPT = /<script[^>]*nonce="__CSP_NONCE__"/;

function main(): void {
  if (!existsSync(INDEX)) {
    console.error('dist/index.html non esiste: esegui prima il build.');
    process.exit(1);
  }

  const html = readFileSync(INDEX, 'utf8');
  if (NONCED_SCRIPT.test(html)) {
    console.log('build ok — il tag script del bundle porta il nonce.');
    return;
  }

  console.error('\nBUILD FUORI POLICY:\n');
  console.error('  csp/nonce-on-script-tag');
  console.error(
    '    §5.1: in dist/index.html nessun <script> ha nonce="__CSP_NONCE__". Con strict-dynamic il browser blocca il bundle e la pagina resta bianca, senza errori lato server.',
  );
  const scripts = html.match(/<script[^>]*>/g) ?? [];
  for (const tag of scripts) console.error(`      ${tag}`);
  console.error('');
  process.exit(1);
}

main();
