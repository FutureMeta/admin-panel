// Estrae i font dal prototipo e li scrive come file serviti da noi.
//
// Il prototipo incorpora Inter, Montserrat e JetBrains Mono in base64 dentro
// il manifest del suo bundler, e le regole @font-face puntano agli UUID degli
// asset. Senza questo passaggio i token dichiarano quei font ma il browser
// rende tutto in system-ui: e' la ragione per cui il pannello non somigliava
// al prototipo nonostante le metriche fossero giuste.
//
// Non si scarica nulla da fonts.googleapis.com: la CSP vieta host esterni, e
// un pannello di staff non deve annunciare a terzi chi lo sta usando. I tre
// font sono sotto SIL Open Font License, quindi ospitarli e' consentito.
//
// Si esegue a mano quando il prototipo cambia:
//   node scripts/extract-fonts.ts

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FONT_DIR = join(ROOT, 'web', 'public', 'fonts');
const CSS_OUT = join(ROOT, 'web', 'src', 'fonts.css');

/**
 * L'export a file unico del prototipo: e' l'UNICA copia che porta i font
 * dentro di se', in base64 nel manifest del suo bundler. Le versioni divise in
 * `frontend/` non li hanno — puntano a fonts.googleapis.com — quindi da quelle
 * non si estrae nulla.
 *
 * I font sono gia' in `web/public/fonts` e versionati: questo script serve
 * solo a rigenerarli se il prototipo cambia. Se il file non c'e', lo dice
 * invece di fallire con un errore di lettura che non spiega niente.
 */
const SOURCES = [
  join(ROOT, 'MetaMC Admin - standalone.html'),
  join(ROOT, 'frontend', 'MetaMC Admin - standalone.html'),
];

type Asset = { mime: string; compressed: boolean; data: string };

function readManifest(html: string): Record<string, Asset> {
  const start = html.indexOf('<script type="__bundler/manifest">');
  if (start < 0) throw new Error('manifest del bundler non trovato');
  const open = html.indexOf('>', start) + 1;
  const end = html.indexOf('</script>', open);
  return JSON.parse(html.slice(open, end)) as Record<string, Asset>;
}

/**
 * Il markup del prototipo vive dentro una stringa JSON: gli apici sono
 * sequenze di escape. Si decodifica prima di cercare le regole @font-face.
 */
function readTemplate(html: string): string {
  const start = html.indexOf('<script type="__bundler/template">');
  const open = html.indexOf('>', start) + 1;
  const end = html.indexOf('</script>', open);
  const raw = html.slice(open, end);
  try {
    return JSON.parse(raw) as string;
  } catch {
    return raw;
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function main(): void {
  const source = SOURCES.find((p) => existsSync(p));
  if (!source) {
    console.error(
      "L'export a file unico del prototipo non e' nel repository.\n" +
        'Cercato in:\n' +
        SOURCES.map((p) => `  ${p}`).join('\n') +
        '\nI font gia' +
        "' estratti stanno in web/public/fonts e sono versionati: questo script\n" +
        'serve solo a rigenerarli. Rimetti il file e rilancia.',
    );
    process.exit(2);
  }

  const html = readFileSync(source, 'utf8');
  const manifest = readManifest(html);
  const template = readTemplate(html);

  mkdirSync(FONT_DIR, { recursive: true });

  // Ogni regola diventa un file: famiglia, peso e sottoinsieme Unicode
  // restano quelli di Google Fonts, cioe' quelli su cui il prototipo e'
  // stato disegnato. Tenere i sottoinsiemi separati non e' pedanteria: il
  // browser scarica solo i blocchi che gli servono davvero.
  const faces = [...template.matchAll(/@font-face\s*\{([^}]*)\}/g)];
  if (faces.length === 0) throw new Error('nessuna regola @font-face nel prototipo');

  // Un asset per UUID, non per regola: Inter e Montserrat sono font variabili,
  // e le regole dei diversi pesi puntano allo stesso file per sottoinsieme.
  // Senza deduplica si scriverebbero cinquanta file per diciotto asset.
  const fileOf = new Map<string, string>();
  const perFamily = new Map<string, number>();
  const out: string[] = [
    '/* Font del prototipo, serviti dalla nostra origine.',
    ' *',
    ' * Generato da scripts/extract-fonts.ts — non modificare a mano.',
    ' * Inter, Montserrat e JetBrains Mono, SIL Open Font License 1.1.',
    ' */',
    '',
  ];

  let written = 0;
  for (const face of faces) {
    const body = face[1];
    if (!body) continue;
    const family = /font-family:\s*'([^']+)'/.exec(body)?.[1];
    const weight = /font-weight:\s*(\d+)/.exec(body)?.[1] ?? '400';
    const style = /font-style:\s*(\w+)/.exec(body)?.[1] ?? 'normal';
    const uuid = /src:\s*url\("([^"]+)"\)/.exec(body)?.[1];
    const range = /unicode-range:\s*([^;]+);/.exec(body)?.[1]?.trim();
    if (!family || !uuid) continue;

    const asset = manifest[uuid];
    if (asset?.mime !== 'font/woff2') continue;

    let file = fileOf.get(uuid);
    if (!file) {
      const slug = slugify(family);
      const n = (perFamily.get(slug) ?? 0) + 1;
      perFamily.set(slug, n);
      file = `${slug}-${n}.woff2`;
      fileOf.set(uuid, file);
      writeFileSync(join(FONT_DIR, file), Buffer.from(asset.data, 'base64'));
      written += 1;
    }

    // Virgolette doppie: e' la forma in cui Biome riscrive il CSS, e con gli
    // apici semplici il file usciva sempre "modificato" appena dopo essere
    // stato generato.
    out.push('@font-face {');
    out.push(`  font-family: "${family}";`);
    out.push(`  font-style: ${style};`);
    out.push(`  font-weight: ${weight};`);
    // `swap` e non `block`: un pannello che resta muto finche' non arriva un
    // font e' peggio di uno che riflow-a una volta.
    out.push('  font-display: swap;');
    out.push(`  src: url("/fonts/${file}") format("woff2");`);
    if (range) out.push(`  unicode-range: ${range};`);
    out.push('}');
    out.push('');
  }

  writeFileSync(CSS_OUT, out.join('\n'));
  console.log(`${written} file di font in web/public/fonts, ${faces.length} regole in web/src/fonts.css`);
}

main();
