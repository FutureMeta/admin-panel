// SPIKE-5 (§15) — Body parsing di better-auth su Fastify.
//
// Verificare:
//   (a) il ponte Fastify -> better-auth funziona: l'handler serializza
//       JSON.stringify(request.body) e better-auth riceve il body giusto
//   (b) nessun content-type parser custom globale interferisce
//   (c) la rotta /webhooks/resend ha un parser dedicato che preserva il
//       buffer GREZZO (la firma Svix si verifica sul raw body — SEC-19)
//   (d) `bodyLimit` per-rotta e' applicato (SEC-29)
//   (e) regressione CVE-2026-33806: un Content-Type con spazio iniziale non
//       salta la validazione dello schema

import { createHmac, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';

const results: Array<[string, boolean, string]> = [];
function check(name: string, ok: boolean, detail = '') {
  results.push([name, ok, detail]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const auth = betterAuth({
  baseURL: 'http://localhost:3998',
  secret: 'spike-secret-che-non-va-mai-in-produzione-0123456789',
  database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
  emailAndPassword: { enabled: true, requireEmailVerification: false },
  advanced: {
    useSecureCookies: false,
    cookies: { session_token: { name: '__Host-metamc_session', attributes: { path: '/', secure: true, httpOnly: true, sameSite: 'strict' } } },
  },
});

const app = Fastify({ bodyLimit: 65536, logger: false });

// Parser dedicato al webhook: preserva il buffer grezzo. Registrato PRIMA di
// tutto e vincolato alla sola rotta tramite un check sull'url.
const rawBodies = new WeakMap<object, Buffer>();
app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
  const buf = body as Buffer;
  if (req.url.startsWith('/webhooks/')) {
    rawBodies.set(req as unknown as object, buf);
    done(null, buf); // il webhook riceve il Buffer, non l'oggetto parsato
    return;
  }
  try {
    done(null, buf.length === 0 ? undefined : JSON.parse(buf.toString('utf8')));
  } catch (err) {
    const e = err as Error & { statusCode?: number };
    e.statusCode = 400;
    done(e, undefined);
  }
});

// Ponte better-auth <- Fastify
app.route({
  method: ['GET', 'POST'],
  url: '/api/auth/*',
  bodyLimit: 4096, // SEC-29
  async handler(request, reply) {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const headers = new Headers();
    for (const [k, v] of Object.entries(request.headers)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) for (const vv of v) headers.append(k, vv);
      else headers.append(k, v);
    }
    const req = new Request(url, {
      method: request.method,
      headers,
      body: request.body ? JSON.stringify(request.body) : undefined,
    });
    const res = await auth.handler(req);
    reply.status(res.status);
    for (const [k, v] of res.headers.entries()) reply.header(k, v);
    reply.send(res.body ? await res.text() : null);
  },
});

const WEBHOOK_SECRET = Buffer.from('spike-webhook-secret');
app.post('/webhooks/resend', { bodyLimit: 65536 }, async (request, reply) => {
  const raw = request.body as Buffer;
  const isBuffer = Buffer.isBuffer(raw);
  const sigHeader = String(request.headers['x-spike-signature'] ?? '');
  const expected = createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
  const given = Buffer.from(sigHeader, 'utf8');
  const want = Buffer.from(expected, 'utf8');
  const valid = given.length === want.length && timingSafeEqual(given, want);
  // Riparsare e riserializzare il body DEVE rompere la firma: e' il test 17.
  const reparsed = JSON.stringify(JSON.parse(raw.toString('utf8')));
  const reparsedSig = createHmac('sha256', WEBHOOK_SECRET).update(reparsed).digest('hex');
  return reply.send({ isBuffer, valid, rawEqualsReparsed: expected === reparsedSig });
});

// Rotta con JSON Schema, per la regressione CVE-2026-33806
app.post(
  '/spike/schema',
  { schema: { body: { type: 'object', required: ['n'], properties: { n: { type: 'integer' } }, additionalProperties: false } } },
  async (_req, reply) => reply.send({ ok: true }),
);

async function main() {
  await app.ready();

  // (b) nessun parser globale che rompa better-auth
  const signUp = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3998' },
    payload: { email: 'spike5@metamc.it', password: 'password-di-spike-lunghissima', name: 'Spike Cinque' },
  });
  check('(a) sign-up attraverso il ponte Fastify -> better-auth', signUp.statusCode === 200, `status=${signUp.statusCode} ${signUp.body.slice(0, 80)}`);

  const signIn = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3998' },
    payload: { email: 'spike5@metamc.it', password: 'password-di-spike-lunghissima' },
  });
  check('(a) sign-in attraverso il ponte', signIn.statusCode === 200, `status=${signIn.statusCode}`);
  const setCookie = signIn.headers['set-cookie'];
  check(
    '(b) il Set-Cookie __Host- sopravvive al ponte Fastify',
    String(setCookie).includes('__Host-metamc_session='),
    String(setCookie).split(';')[0],
  );

  // (c) raw body del webhook
  const payload = JSON.stringify({ type: 'email.delivered', data: { email_id: 'abc' } });
  const sig = createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');
  const wh = await app.inject({
    method: 'POST',
    url: '/webhooks/resend',
    headers: { 'content-type': 'application/json', 'x-spike-signature': sig },
    payload,
  });
  const whBody = wh.json() as { isBuffer: boolean; valid: boolean; rawEqualsReparsed: boolean };
  check('(c) il webhook riceve un Buffer grezzo, non un oggetto', whBody.isBuffer === true, JSON.stringify(whBody));
  check('(c) la firma sul raw body verifica', whBody.valid === true);

  // stesso payload ma con spazi: riparsare cambia i byte -> firma rotta (test 17)
  const spaced = '{ "type": "email.delivered",  "data": { "email_id": "abc" } }';
  const spacedSig = createHmac('sha256', WEBHOOK_SECRET).update(spaced).digest('hex');
  const wh2 = await app.inject({
    method: 'POST',
    url: '/webhooks/resend',
    headers: { 'content-type': 'application/json', 'x-spike-signature': spacedSig },
    payload: spaced,
  });
  const wh2Body = wh2.json() as { valid: boolean; rawEqualsReparsed: boolean };
  check('(c) firma valida sul raw anche con spaziatura non canonica', wh2Body.valid === true);
  check(
    '(c) TEST 17: riparsare il body ROMPE la firma (il raw e` davvero necessario)',
    wh2Body.rawEqualsReparsed === false,
    `rawEqualsReparsed=${wh2Body.rawEqualsReparsed}`,
  );

  // (d) bodyLimit per-rotta
  const big = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3998' },
    payload: { email: 'spike5@metamc.it', password: 'x'.repeat(8000) },
  });
  check('(d) bodyLimit 4 KB su /api/auth/* (SEC-29)', big.statusCode === 413, `status=${big.statusCode}`);

  // (e) CVE-2026-33806
  const bad = await app.inject({
    method: 'POST',
    url: '/spike/schema',
    headers: { 'content-type': ' application/json' },
    payload: JSON.stringify({ n: 'non-un-intero', extra: true }),
  });
  check(
    '(e) CVE-2026-33806: Content-Type con spazio iniziale NON salta lo schema',
    bad.statusCode === 400 || bad.statusCode === 415,
    `status=${bad.statusCode} ${bad.body.slice(0, 60)}`,
  );

  await app.close();

  const failed = results.filter(([, ok]) => !ok);
  console.log('\n---');
  console.log(
    failed.length === 0
      ? 'SPIKE-5 SUPERATO -> ponte Fastify/better-auth e parser raw del webhook confermati.'
      : `SPIKE-5: ${failed.length} check non superati -> vedi righe FAIL.`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('SPIKE-5 ERRORE NON GESTITO:', err);
  process.exit(2);
});
