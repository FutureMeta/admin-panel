// SPIKE-2 (§15) — Cookie `__Host-`.
//
// Verificare che `advanced.cookies.session_token.name = '__Host-metamc_session'`
// produca un Set-Cookie reale che:
//   - inizia con `__Host-`
//   - ha Path=/
//   - ha Secure
//   - NON ha Domain
//   - ha SameSite=Strict e HttpOnly (SEC-04)
//
// Se fallisce: gestire il cookie di sessione fuori da better-auth, scrivendolo
// noi nell'hook di risposta.

import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';

const results: Array<[string, boolean, string]> = [];
function check(name: string, ok: boolean, detail = '') {
  results.push([name, ok, detail]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const db: Record<string, unknown[]> = { user: [], session: [], account: [], verification: [] };

const auth = betterAuth({
  baseURL: 'https://admin.metamc.it',
  secret: 'spike-secret-che-non-va-mai-in-produzione-0123456789',
  database: memoryAdapter(db),
  emailAndPassword: { enabled: true, requireEmailVerification: false },
  advanced: {
    // useSecureCookies:true antepone `__Secure-` al nome e produrrebbe
    // `__Secure-__Host-metamc_session`, cioe' un doppio prefisso invalido che
    // distrugge la semantica __Host-. Lo teniamo false e mettiamo `secure: true`
    // negli attributi: il cookie esce comunque Secure.
    useSecureCookies: false,
    // Nessun cookiePrefix: la composizione `${prefix}.${name}` romperebbe __Host-.
    cookies: {
      session_token: {
        name: '__Host-metamc_session',
        attributes: {
          path: '/',
          secure: true,
          httpOnly: true,
          sameSite: 'strict',
        },
      },
    },
  },
});

async function main() {
  const res = await auth.api.signUpEmail({
    body: { email: 'spike2@metamc.it', password: 'password-di-spike-lunghissima', name: 'Spike Due' },
    returnHeaders: true,
  });

  const raw = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];
  const all = raw.filter(Boolean);
  console.log('Set-Cookie grezzi:');
  for (const c of all) console.log('  ', c);
  console.log('');

  const session = all.find((c) => c.startsWith('__Host-metamc_session='));

  check('esiste un Set-Cookie di sessione', all.length > 0, `n=${all.length}`);
  check(
    'il nome del cookie inizia esattamente con `__Host-metamc_session=`',
    session !== undefined,
    session ? session.split('=')[0] : `nomi visti: ${all.map((c) => c.split('=')[0]).join(', ')}`,
  );

  if (session) {
    const attrs = session
      .split(';')
      .slice(1)
      .map((a) => a.trim().toLowerCase());
    check('Path=/', attrs.includes('path=/'), attrs.join(' | '));
    check('Secure', attrs.includes('secure'));
    check('HttpOnly', attrs.includes('httponly'));
    check('SameSite=Strict (SEC-04)', attrs.includes('samesite=strict'));
    check('NESSUN Domain', !attrs.some((a) => a.startsWith('domain=')));
    check('NESSUN Partitioned', !attrs.includes('partitioned'));
  }

  // Controprova: senza override esplicito, che nome esce? Serve a documentare
  // perche' l'override e' obbligatorio.
  const naive = betterAuth({
    baseURL: 'https://admin.metamc.it',
    secret: 'spike-secret-che-non-va-mai-in-produzione-0123456789',
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    advanced: { useSecureCookies: true, cookiePrefix: 'metamc' },
  });
  const naiveRes = await naive.api.signUpEmail({
    body: { email: 'spike2b@metamc.it', password: 'password-di-spike-lunghissima', name: 'Spike Due B' },
    returnHeaders: true,
  });
  const naiveCookies = naiveRes.headers.getSetCookie?.() ?? [];
  console.log('\ncontroprova con cookiePrefix e senza override del nome:');
  for (const c of naiveCookies) console.log('  ', c.split(';')[0]);

  const failed = results.filter(([, ok]) => !ok);
  console.log('\n---');
  console.log(
    failed.length === 0
      ? 'SPIKE-2 SUPERATO -> il cookie di sessione lo gestisce better-auth con advanced.cookies.session_token.'
      : `SPIKE-2 FALLITO (${failed.length} check) -> piano B: cookie di sessione scritto da noi nell'hook di risposta.`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('SPIKE-2 ERRORE NON GESTITO:', err);
  process.exit(2);
});
