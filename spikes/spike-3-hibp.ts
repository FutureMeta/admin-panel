// SPIKE-3 (§15) — Plugin `better-auth/plugins/haveibeenpwned`.
//
// Verificare che:
//   (a) usi davvero il k-anonymity (5 caratteri di prefisso SHA-1, mai la password)
//   (b) invii l'header `Add-Padding: true`
//   (c) il timeout sia configurabile
//   (d) il comportamento su errore di rete sia fail-closed o rendibile tale
//
// Se fallisce (in particolare b/c): client nostro con fetch globale + Agent
// keep-alive, timeout 2 s, fail-closed (§8.6).
//
// Il fetch globale viene intercettato: nessuna chiamata reale esce verso
// api.pwnedpasswords.com.

import { createHash } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { haveIBeenPwned } from 'better-auth/plugins/haveibeenpwned';

const results: Array<[string, boolean, string]> = [];
function check(name: string, ok: boolean, detail = '') {
  results.push([name, ok, detail]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const PASSWORD_PWNED = 'password-di-spike-lunghissima';
const sha1 = createHash('sha1').update(PASSWORD_PWNED).digest('hex').toUpperCase();
const PREFIX = sha1.slice(0, 5);
const SUFFIX = sha1.slice(5);

type Seen = { url: string; headers: Record<string, string>; signalPresent: boolean };
const seen: Seen[] = [];
let mode: 'pwned' | 'clean' | 'network-error' | 'hang' = 'clean';

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.includes('pwnedpasswords.com')) return realFetch(input as RequestInfo, init);

  const headers: Record<string, string> = {};
  const h = init?.headers ?? (input instanceof Request ? input.headers : undefined);
  if (h) {
    if (h instanceof Headers) h.forEach((v, k) => (headers[k.toLowerCase()] = v));
    else if (Array.isArray(h)) for (const [k, v] of h) headers[k.toLowerCase()] = v;
    else for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v);
  }
  seen.push({ url, headers, signalPresent: Boolean(init?.signal) });

  if (mode === 'network-error') throw new Error('SPIKE3_NETWORK_DOWN');
  if (mode === 'hang') {
    await new Promise((r) => setTimeout(r, 30_000));
    return new Response('', { status: 200 });
  }
  const body =
    mode === 'pwned'
      ? `${SUFFIX}:4213\r\n0018A45C4D1DEF81644B54AB7F969B88D65:1\r\n`
      : '0018A45C4D1DEF81644B54AB7F969B88D65:1\r\n00D4F6E8FA6EECAD2A3AA415EEC418D38EC:2\r\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
}) as typeof fetch;

function makeAuth() {
  return betterAuth({
    baseURL: 'https://admin.metamc.it',
    secret: 'spike-secret-che-non-va-mai-in-produzione-0123456789',
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    emailAndPassword: { enabled: true, requireEmailVerification: false, minPasswordLength: 12 },
    plugins: [haveIBeenPwned({ customPasswordCompromisedMessage: 'SPIKE3_PWNED' })],
  });
}

let seq = 0;
async function trySignUp(auth: ReturnType<typeof makeAuth>) {
  seq += 1;
  try {
    await auth.api.signUpEmail({
      body: { email: `spike3-${seq}@metamc.it`, password: PASSWORD_PWNED, name: 'Spike Tre' },
    });
    return { ok: true, err: '' };
  } catch (err) {
    return { ok: false, err: err instanceof Error ? err.message : String(err) };
  }
}

async function main() {
  // (a) k-anonymity + (b) header
  mode = 'clean';
  const clean = await trySignUp(makeAuth());
  check('password non compromessa -> signup riesce', clean.ok, clean.err);
  check('il plugin ha chiamato pwnedpasswords', seen.length >= 1, seen[0]?.url ?? '');

  if (seen[0]) {
    const url = seen[0].url;
    check('(a) k-anonymity: la URL contiene solo i 5 caratteri di prefisso', url.endsWith(`/range/${PREFIX}`), url);
    check('(a) la URL NON contiene il suffisso dell`hash', !url.includes(SUFFIX), '');
    console.log('   header inviati:', JSON.stringify(seen[0].headers));
    check(
      '(b) header `Add-Padding: true` presente',
      seen[0].headers['add-padding'] === 'true',
      seen[0].headers['add-padding'] ?? '(assente)',
    );
    check('(c) un AbortSignal viene passato al fetch (timeout)', seen[0].signalPresent, String(seen[0].signalPresent));
  }

  // password compromessa -> deve rifiutare
  mode = 'pwned';
  const pwned = await trySignUp(makeAuth());
  check('password compromessa -> signup rifiutato', !pwned.ok, pwned.err.slice(0, 60));

  // (d) errore di rete -> fail-open o fail-closed?
  mode = 'network-error';
  const netErr = await trySignUp(makeAuth());
  check(
    '(d) errore di rete: comportamento osservato',
    true,
    netErr.ok ? 'FAIL-OPEN (signup riuscito) -> serve wrapper nostro fail-closed' : `fail-closed (${netErr.err.slice(0, 40)})`,
  );

  // (c) timeout configurabile?
  const opts = haveIBeenPwned({ customPasswordCompromisedMessage: 'x' }) as unknown as Record<string, unknown>;
  console.log('\nchiavi del plugin:', Object.keys(opts).join(', '));

  const failed = results.filter(([, ok]) => !ok);
  console.log('\n---');
  console.log(
    failed.length === 0
      ? 'SPIKE-3: header e k-anonymity verificati.'
      : `SPIKE-3: ${failed.length} check non superati -> vedi righe FAIL.`,
  );
  console.log(
    `Comportamento su errore di rete: ${netErr.ok ? 'FAIL-OPEN' : 'FAIL-CLOSED'} (determina se serve il wrapper §8.6).`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error('SPIKE-3 ERRORE NON GESTITO:', err);
  process.exit(2);
});
