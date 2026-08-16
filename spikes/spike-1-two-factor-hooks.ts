// SPIKE-1 (§15) — Hook del plugin twoFactor di better-auth.
//
// Esito binario da verificare:
//   (a) un `hooks.before` su /two-factor/verify-totp puo' RIFIUTARE la richiesta
//   (b) un `hooks.after` VEDE l'esito positivo e permette di calcolare/persistere
//       lo step consumato
//
// Se fallisce: non registrare il plugin twoFactor, implementare TOTP su
// otpauth 9.5.1 con tabella auth.user_totp al posto di auth."twoFactor".
//
// Gira sull'adapter memory: lo spike verifica il comportamento degli hook,
// non la persistenza.

import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { twoFactor } from 'better-auth/plugins/two-factor';
import { currentStep, secretFromOtpauthUri, totpAt } from './lib/totp.ts';

const results: Array<[string, boolean, string]> = [];
function check(name: string, ok: boolean, detail = '') {
  results.push([name, ok, detail]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// Stato osservato dagli hook, per capire cosa vedono davvero.
let rejectNextVerify = false;
const beforeSaw: Array<{ path: string; body: unknown }> = [];
const afterSaw: Array<{ path: string; status: number | undefined; returned: unknown }> = [];

// memoryAdapter richiede che i modelli esistano gia' come array.
const db: Record<string, unknown[]> = {
  user: [],
  session: [],
  account: [],
  verification: [],
  twoFactor: [],
};

const auth = betterAuth({
  baseURL: 'http://localhost:3999',
  secret: 'spike-secret-che-non-va-mai-in-produzione-0123456789',
  database: memoryAdapter(db),
  emailAndPassword: { enabled: true, requireEmailVerification: false },
  plugins: [twoFactor({ issuer: 'MetaMC Admin', skipVerificationOnEnable: false })],
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === '/two-factor/verify-totp') {
        beforeSaw.push({ path: ctx.path, body: ctx.body });
        if (rejectNextVerify) {
          throw new APIError('TOO_MANY_REQUESTS', {
            message: 'SPIKE1_BEFORE_HOOK_REJECT',
            code: 'SPIKE1_BEFORE_HOOK_REJECT',
          });
        }
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path === '/two-factor/verify-totp') {
        const returned = ctx.context.returned as { status?: number } | undefined;
        afterSaw.push({
          path: ctx.path,
          status:
            returned && typeof returned === 'object' && 'status' in returned
              ? (returned as { status?: number }).status
              : 200,
          returned,
        });
      }
    }),
  },
});

const EMAIL = 'spike1@metamc.it';
const PASSWORD = 'password-di-spike-lunghissima';

async function main() {
  // 1. utente + sessione
  const signUp = await auth.api.signUpEmail({
    body: { email: EMAIL, password: PASSWORD, name: 'Spike Uno' },
    returnHeaders: true,
  });
  const cookie = signUp.headers.get('set-cookie') ?? '';
  check('signUpEmail emette una sessione', cookie.length > 0);

  const headers = new Headers({ cookie: cookie.split(';')[0] });

  // 2. enable 2FA -> ottieni totpURI
  const enabled = (await auth.api.enableTwoFactor({
    body: { password: PASSWORD },
    headers,
  })) as { totpURI?: string; backupCodes?: string[] };

  check('enableTwoFactor restituisce un totpURI', typeof enabled.totpURI === 'string', enabled.totpURI?.slice(0, 40));
  check(
    'enableTwoFactor restituisce backupCodes del plugin (da neutralizzare, SEC-14)',
    Array.isArray(enabled.backupCodes),
    `n=${enabled.backupCodes?.length ?? 0}`,
  );

  const secret = secretFromOtpauthUri(enabled.totpURI as string);
  const step = currentStep();
  const code = totpAt(secret, step);

  // 3. (a) il before hook deve poter RIFIUTARE
  rejectNextVerify = true;
  let rejected = false;
  let rejectionDetail = '';
  try {
    await auth.api.verifyTOTP({ body: { code }, headers });
  } catch (err) {
    rejected = true;
    rejectionDetail =
      err instanceof APIError
        ? `${err.status} ${(err.body as { code?: string } | undefined)?.code ?? ''}`
        : String(err).slice(0, 60);
  }
  check('(a) hooks.before puo` rifiutare /two-factor/verify-totp', rejected, rejectionDetail);
  check('(a) il before hook ha visto il path e il body', beforeSaw.length === 1, JSON.stringify(beforeSaw[0]?.body));

  // 4. (b) il verify che passa deve essere visto dall'after hook
  rejectNextVerify = false;
  const freshStep = currentStep();
  const freshCode = totpAt(secret, freshStep);
  let verifyOk = false;
  let verifyDetail = '';
  try {
    const res = await auth.api.verifyTOTP({ body: { code: freshCode }, headers, returnHeaders: true });
    verifyOk = true;
    verifyDetail = JSON.stringify(res.response).slice(0, 120);
  } catch (err) {
    verifyDetail = err instanceof APIError ? `${err.status} ${err.message}` : String(err).slice(0, 120);
  }
  check('verifyTOTP con codice valido riesce', verifyOk, verifyDetail);
  check(
    '(b) hooks.after vede la verifica riuscita (ctx.context.returned popolato)',
    afterSaw.length >= 1 && afterSaw.at(-1)?.returned !== undefined,
    `after invocato ${afterSaw.length} volte`,
  );
  check(
    '(b) lo step consumato e` calcolabile nell`after hook dal body della richiesta',
    beforeSaw.length >= 1,
    `step=${freshStep} ricavabile da Date.now() nell'hook`,
  );

  // 5. Il before hook riceve il body PRIMA dell'handler: e' il punto in cui si
  //    puo' rifiutare uno step gia' consumato (SEC-11).
  const lastBody = beforeSaw.at(-1)?.body as { code?: string } | undefined;
  check(
    'SEC-11: il before hook legge `code` e puo` derivarne lo step',
    typeof lastBody?.code === 'string' && lastBody.code.length === 6,
    `code visto = ${lastBody?.code}`,
  );

  const failed = results.filter(([, ok]) => !ok);
  console.log('\n---');
  console.log(
    failed.length === 0
      ? 'SPIKE-1 SUPERATO -> si registra il plugin twoFactor, la guardia anti-replay va negli hook before/after.'
      : `SPIKE-1 FALLITO (${failed.length} check) -> piano B: otpauth 9.5.1 + tabella auth.user_totp.`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('SPIKE-1 ERRORE NON GESTITO:', err);
  process.exit(2);
});
