// §14 test 15 — login su email INESISTENTE e su password ERRATA hanno latenza
//               indistinguibile. Test statistico, 100 campioni per lato.
//               SEC-25, SEC-30
// §14 test 16 — 50 login falliti/secondo: le rotte statiche e /health/live
//               restano reattive. E' il test che scopre la saturazione del
//               threadpool.  SEC-28
//
// Il test 15 e' l'unico della lista che non ha una risposta binaria: misura
// una distribuzione. La soglia va scelta in modo che un oracolo REALE la
// superi e il rumore no.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedUser } from '#tests/support/actors.ts';
import { sameOriginHeaders, startTestApp, type TestApp } from '#tests/support/app.ts';

let t: TestApp;
const PASSWORD = 'password-di-test-lunghissima';

beforeAll(async () => {
  t = await startTestApp({ label: 'timing' });
  await seedUser(t, { email: 'esiste@metamc.it', password: PASSWORD, roleKey: 'moderatore' });
}, 180_000);

afterAll(async () => {
  await t?.close();
});

async function tempoDiLogin(email: string, password: string): Promise<number> {
  const t0 = process.hrtime.bigint();
  await t.app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: sameOriginHeaders(),
    payload: { email, password },
  });
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

function mediana(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2 : (s[mid] ?? 0);
}

function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;
}

describe('SEC-30 / test 15 — nessun oracolo di timing sul login', () => {
  it('email inesistente e password errata: latenza indistinguibile su 100 campioni per lato', async () => {
    // Il rate limit deve restare fuori dai piedi: qui si misura il COSTO
    // del percorso, non la barriera. Con il limite attivo i campioni
    // finirebbero tutti a "429 immediato" e la misura non direbbe nulla.
    const inesistenti: number[] = [];
    const errate: number[] = [];

    // Riscaldamento: le prime chiamate pagano la compilazione JIT e la
    // prima connessione del pool, e falserebbero la coda della
    // distribuzione da un lato solo.
    for (let i = 0; i < 10; i += 1) {
      await tempoDiLogin(`riscaldamento-${i}@metamc.it`, PASSWORD);
      await tempoDiLogin('esiste@metamc.it', 'password-sbagliata-ma-lunga');
      await t.ctx.rateLimit.reward('loginIp', '127.0.0.1');
      await t.ctx.rateLimit.reward('loginGlobal', 'rotta');
    }

    // Alternati, non in blocco: se il sistema rallentasse nel tempo (cache
    // che si scalda, GC), misurare prima 100 di un tipo e poi 100
    // dell'altro attribuirebbe quella deriva alla differenza fra i due.
    for (let i = 0; i < 100; i += 1) {
      inesistenti.push(await tempoDiLogin(`inesistente-${i}@metamc.it`, PASSWORD));
      errate.push(await tempoDiLogin('esiste@metamc.it', `sbagliata-ma-lunga-${i}`));
      await t.ctx.rateLimit.reward('loginIp', '127.0.0.1');
      await t.ctx.rateLimit.reward('loginAccount', 'esiste@metamc.it');
      await t.ctx.rateLimit.reward('loginGlobal', 'rotta');
    }

    const mA = mediana(inesistenti);
    const mB = mediana(errate);
    const p95A = percentile(inesistenti, 0.95);
    const p95B = percentile(errate, 0.95);

    console.log(
      `  inesistente: mediana ${mA.toFixed(1)}ms p95 ${p95A.toFixed(1)}ms | ` +
        `password errata: mediana ${mB.toFixed(1)}ms p95 ${p95B.toFixed(1)}ms`,
    );

    // Il criterio e' il RAPPORTO fra le mediane, non la differenza assoluta:
    // su macchine diverse i tempi cambiano di un ordine di grandezza, il
    // rapporto no. Senza hash-esca il percorso "utente inesistente" salterebbe
    // Argon2 del tutto e il rapporto sarebbe di molte volte, non del 40%.
    const rapporto = Math.max(mA, mB) / Math.min(mA, mB);
    expect(rapporto).toBeLessThan(1.4);

    // Anche la coda deve somigliarsi: un oracolo si puo' nascondere nel p95.
    expect(Math.max(p95A, p95B) / Math.min(p95A, p95B)).toBeLessThan(2);
  }, 120_000);

  it('entrambi i percorsi rispondono con lo STESSO status e lo stesso corpo', async () => {
    await t.ctx.rateLimit.reward('loginIp', '127.0.0.1');
    const inesistente = await t.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: sameOriginHeaders(),
      payload: { email: 'proprio-non-esiste@metamc.it', password: PASSWORD },
    });
    const errata = await t.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: sameOriginHeaders(),
      payload: { email: 'esiste@metamc.it', password: 'sbagliatissima-e-lunga' },
    });
    expect(inesistente.statusCode).toBe(errata.statusCode);
    expect(inesistente.body).toBe(errata.body);
  });

  it('SEC-25 — il rate limit si consuma anche sul percorso utente-inesistente', async () => {
    await t.ctx.rateLimit.reward('loginIp', '127.0.0.1');
    const prima = await t.ctx.rateLimit.peek('loginIp', '127.0.0.1');
    await t.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: sameOriginHeaders(),
      payload: { email: 'nessuno-qui@metamc.it', password: PASSWORD },
    });
    const dopo = await t.ctx.rateLimit.peek('loginIp', '127.0.0.1');
    // Se il limite si consumasse solo per gli utenti esistenti, il costo
    // della richiesta direbbe quali email sono registrate.
    expect(dopo?.consumed ?? 0).toBeGreaterThan(prima?.consumed ?? 0);
  });

  it('SEC-25 — anche il limite PER ACCOUNT si consuma su un account inesistente', async () => {
    const email = 'account-fantasma@metamc.it';
    await t.ctx.rateLimit.reward('loginAccount', email);
    await t.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: sameOriginHeaders(),
      payload: { email, password: PASSWORD },
    });
    const dopo = await t.ctx.rateLimit.peek('loginAccount', email);
    expect(dopo?.consumed ?? 0).toBeGreaterThan(0);
  });
});

describe('SEC-28 / test 16 — saturazione del threadpool', () => {
  it('sotto una raffica di login falliti, /health/live resta reattivo', async () => {
    const RAFFICA = 60;

    // La raffica parte e NON viene attesa: il punto e' misurare la salute
    // del processo MENTRE il threadpool e' sotto pressione.
    const raffica = Promise.all(
      Array.from({ length: RAFFICA }, (_, i) =>
        t.app
          .inject({
            method: 'POST',
            url: '/api/auth/sign-in/email',
            headers: sameOriginHeaders(),
            payload: { email: `raffica-${i}@metamc.it`, password: `qualunque-cosa-lunga-${i}` },
          })
          .catch(() => undefined),
      ),
    );

    const latenze: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const t0 = process.hrtime.bigint();
      const res = await t.app.inject({ method: 'GET', url: '/health/live' });
      latenze.push(Number(process.hrtime.bigint() - t0) / 1e6);
      expect(res.statusCode).toBe(200);
    }

    const esiti = await raffica;
    const p95 = percentile(latenze, 0.95);
    const semaforo = t.ctx.semaphore.stats;

    console.log(
      `  /health/live sotto raffica: p95 ${p95.toFixed(1)}ms | ` +
        `semaforo: picco ${semaforo.peak}/${semaforo.limit}, rifiutati ${semaforo.rejected}`,
    );

    // /health/live non tocca ne' il database ne' il threadpool: deve
    // rispondere comunque. Se non lo facesse, il processo sarebbe gia'
    // ingolfato e nessuna sonda direbbe perche'.
    expect(p95).toBeLessThan(250);

    // Il semaforo non ha mai superato il tetto: e' il suo lavoro.
    expect(semaforo.peak).toBeLessThanOrEqual(semaforo.limit);

    // Le richieste in eccesso ricevono 429 (limite) o 503 (semaforo), mai
    // un 500 e mai un blocco.
    const statuses = new Set(esiti.map((r) => r?.statusCode));
    for (const s of statuses) {
      expect([401, 400, 429, 503]).toContain(s);
    }
  }, 120_000);

  it('il semaforo espone le metriche su /internal/metrics', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/internal/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('metamc_argon2_in_flight');
    expect(res.body).toContain('metamc_argon2_limit');
    expect(res.body).toContain('metamc_argon2_peak');
    expect(res.body).toContain('metamc_pg_pool_total');
  });

  it('/health/live risponde 200 ANCHE durante lo shutdown, /health/ready no', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);

    t.ctx.shuttingDown.value = true;
    try {
      // live resta 200: se rispondesse 503 in drenaggio, l'orchestratore
      // ucciderebbe il processo mentre serve ancora le richieste in corso.
      expect((await t.app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
      // ready va a 503 SUBITO, cosi' il load balancer smette di mandare
      // traffico prima che il drenaggio cominci davvero.
      expect((await t.app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(503);
    } finally {
      t.ctx.shuttingDown.value = false;
    }
  });

  it('le sonde non rivelano nulla dell`interno', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/health/ready' });
    const body = res.body.toLowerCase();
    for (const parola of ['postgres', 'redis', 'version', 'host', 'port', 'stack']) {
      expect(body).not.toContain(parola);
    }
  });
});
