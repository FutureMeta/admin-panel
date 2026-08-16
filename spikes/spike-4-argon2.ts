// SPIKE-4 (§15) — Prebuild `@node-rs/argon2` 2.1.0 e costo reale di un hash.
//
// Verificare:
//   (a) esistono i prebuild per la coppia arch+libc di produzione (linux-x64-gnu
//       e linux-arm64-gnu: immagine `-slim`, glibc, MAI musl)
//   (b) il modulo carica e produce una PHC string
//   (c) il parametro `secret` (pepper) e' esposto
//   (d) `needsRehash` esiste
//   (e) costo di un hash a m=19456 t=2 p=1 -> target < 100 ms
//
// Se il prebuild manca: pin 2.0.2. Se manca anche quello: crypto.argon2 nativo
// di Node 24 (verificare OpenSSL 3.2+).
//
// NOTA: la misura (e) su questa macchina non sostituisce la misura sul VPS di
// produzione, che §5.2 impone prima del go-live.

import { createRequire } from 'node:module';
// @node-rs/argon2 e' CommonJS: in un progetto "type": "module" va importato
// come default export, non con named import. Vale anche per il codice
// applicativo.
import argon2 from '@node-rs/argon2';

const { hash, needsRehash, verify, Algorithm } = argon2;
const require = createRequire(import.meta.url);
const results: Array<[string, boolean, string]> = [];
function check(name: string, ok: boolean, detail = '') {
  results.push([name, ok, detail]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const PARAMS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
  algorithm: Algorithm.Argon2id,
} as const;

// Coppie richieste dall'immagine di produzione (§17.6: base -slim, glibc).
const REQUIRED_TARGETS = ['@node-rs/argon2-linux-x64-gnu', '@node-rs/argon2-linux-arm64-gnu'];
const FORBIDDEN_TARGETS = ['@node-rs/argon2-linux-x64-musl', '@node-rs/argon2-linux-arm64-musl'];

async function main() {
  const pkg = require('@node-rs/argon2/package.json') as {
    version: string;
    optionalDependencies?: Record<string, string>;
  };
  const optional = Object.keys(pkg.optionalDependencies ?? {});
  console.log(`@node-rs/argon2 ${pkg.version}`);
  console.log(`piattaforma locale: ${process.platform}-${process.arch}`);
  console.log(`prebuild dichiarati (${optional.length}): ${optional.join(', ')}\n`);

  check('versione installata = 2.1.0', pkg.version === '2.1.0', pkg.version);

  for (const t of REQUIRED_TARGETS) {
    check(`(a) prebuild dichiarato: ${t}`, optional.includes(t), pkg.optionalDependencies?.[t] ?? '(assente)');
  }
  for (const t of FORBIDDEN_TARGETS) {
    const present = optional.includes(t);
    console.log(`INFO  musl ${present ? 'presente' : 'assente'}: ${t} — irrilevante, l'immagine e' glibc`);
  }

  // (b)(c)(d)
  const pepper = Buffer.alloc(32, 7);
  let phc = '';
  try {
    phc = await hash('password-di-spike-lunghissima', { ...PARAMS, secret: pepper });
  } catch (err) {
    check('(b) il modulo nativo carica e produce un hash', false, String(err).slice(0, 120));
    console.log('\n---\nSPIKE-4 FALLITO -> pin 2.0.2, poi crypto.argon2 nativo.');
    process.exit(1);
  }

  check('(b) PHC string prodotta', phc.startsWith('$argon2id$'), phc.slice(0, 45));
  check(
    '(b) parametri riflessi nella PHC string',
    phc.includes('m=19456') && phc.includes('t=2') && phc.includes('p=1'),
    phc.split('$')[3],
  );

  const okVerify = await verify(phc, 'password-di-spike-lunghissima', { secret: pepper });
  check('(c) verify con lo stesso pepper riesce', okVerify);

  const wrongPepper = await verify(phc, 'password-di-spike-lunghissima', { secret: Buffer.alloc(32, 9) }).catch(
    () => false,
  );
  check('(c) verify con pepper diverso FALLISCE (il pepper e` davvero in gioco)', wrongPepper === false);

  // (d) `needsRehash` NON esiste in @node-rs/argon2 2.1.0 (il §3.3 lo da' per
  //     presente: e' un errore del documento). Si ricava dai parametri della
  //     PHC string, che il modulo produce correttamente.
  check(
    '(d) `needsRehash` NON e` esportato dal modulo',
    typeof needsRehash !== 'function',
    `export disponibili: ${Object.keys(argon2).join(', ')}`,
  );
  const parsed = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(phc);
  check(
    '(d) i parametri sono ricavabili dalla PHC string (sostituto di needsRehash)',
    parsed !== null &&
      Number(parsed[1]) === PARAMS.memoryCost &&
      Number(parsed[2]) === PARAMS.timeCost &&
      Number(parsed[3]) === PARAMS.parallelism,
    parsed ? `m=${parsed[1]} t=${parsed[2]} p=${parsed[3]}` : 'PHC non parsabile',
  );

  // (e) costo
  const N = 12;
  const samples: number[] = [];
  for (let i = 0; i < N; i += 1) {
    const t0 = process.hrtime.bigint();
    await hash(`password-di-spike-${i}`, { ...PARAMS, secret: pepper });
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(N * 0.5)];
  const p95 = samples[Math.floor(N * 0.95)];
  console.log(`\ncosto hash (m=19456 t=2 p=1), ${N} campioni: p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms`);
  check('(e) hash singolo sotto 100 ms su questa macchina', p50 < 100, `p50=${p50.toFixed(1)}ms`);

  // Contesa sul threadpool: e' il motivo del semaforo (SEC-28).
  const conc = 12;
  const t0 = process.hrtime.bigint();
  await Promise.all(
    Array.from({ length: conc }, (_, i) => hash(`concurrent-${i}`, { ...PARAMS, secret: pepper })),
  );
  const wall = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(
    `${conc} hash concorrenti su UV_THREADPOOL_SIZE=${process.env.UV_THREADPOOL_SIZE ?? '4 (default)'}: ${wall.toFixed(0)}ms totali, ${(wall / conc).toFixed(0)}ms/hash effettivi`,
  );
  console.log(`RAM di picco stimata a 12 hash in volo: ${((12 * 19456) / 1024).toFixed(0)} MiB di solo Argon2`);

  const failed = results.filter(([, ok]) => !ok);
  console.log('\n---');
  console.log(
    failed.length === 0
      ? 'SPIKE-4 SUPERATO -> @node-rs/argon2 2.1.0 resta pinnato.'
      : `SPIKE-4: ${failed.length} check non superati -> vedi righe FAIL.`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('SPIKE-4 ERRORE NON GESTITO:', err);
  process.exit(2);
});
