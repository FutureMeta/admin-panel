// §14 test 9  — per ogni rotta con `:id`, un utente non autorizzato riceve LO
//               STESSO status di un id inesistente.  SEC-31
// §14 test 12 — una POST senza header `Origin` viene rifiutata.  SEC-15
// §14 test 13 — una POST con `Sec-Fetch-Site: same-site` viene rifiutata. SEC-16
//
// Il test 9 e' PARAMETRICO su tutte le rotte con `:id`: enumerarle a mano
// significherebbe dimenticarne una il giorno in cui se ne aggiunge un'altra.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, loginAs, seedUser } from '#tests/support/actors.ts';
import { sameOriginHeaders, startTestApp, TEST_ORIGIN, type TestApp } from '#tests/support/app.ts';

let t: TestApp;
/**
 * Attore SENZA alcun ruolo: 0 su tutti i moduli.
 *
 * E' il "non autorizzato" del test 9. Un moderatore non andrebbe bene su
 * `GET /api/users/:id`, perche' ha `utenti:1` ed e' quindi autorizzato a
 * leggere: il confronto misurerebbe una differenza legittima e il test
 * fallirebbe per il motivo sbagliato.
 */
let debole: Actor;
/** Moderatore: autorizzato a leggere, non a scrivere. Serve al caso del ban. */
let moderatore: Actor;
/** Owner: serve a dimostrare che il 404 del debole non e` una rotta rotta. */
let forte: Actor;
let bersaglio: string;

beforeAll(async () => {
  t = await startTestApp({ label: 'hard' });
  debole = await loginAs(t, await seedUser(t));
  moderatore = await loginAs(t, await seedUser(t, { roleKey: 'moderatore' }));
  forte = await loginAs(t, await seedUser(t, { roleKey: 'owner' }));
  const vittima = await seedUser(t, { roleKey: 'admin' });
  bersaglio = vittima.id;
}, 180_000);

afterAll(async () => {
  await t?.close();
});

/**
 * Tutte le rotte registrate che contengono un parametro di path.
 *
 * Si leggono dall'inventario che il server popola con l'hook onRoute, non da
 * printRoutes(): quello disegna un albero in cui i prefissi stanno su righe
 * separate, e ricomporli a mano produce path come "/:id" — che non esistono,
 * rispondono 404 in ogni caso, e farebbero passare il test verificando
 * l'insieme vuoto.
 */
function routesWithId(): Array<{ method: string; url: string }> {
  return t.app.registeredRoutes.filter((r) => r.url.includes(':'));
}

describe('SEC-31 / test 9 — nessun oracolo 403-vs-404', () => {
  it('esistono rotte con :id da verificare', () => {
    const routes = routesWithId();
    // Se questo fallisce, la raccolta delle rotte e' rotta e il test
    // parametrico verificherebbe l'insieme vuoto — cioe' niente.
    expect(routes.length).toBeGreaterThanOrEqual(8);
  });

  it('utente non autorizzato e id inesistente danno lo STESSO status, rotta per rotta', async () => {
    const routes = routesWithId();
    const discrepanze: string[] = [];

    for (const route of routes) {
      const method = route.method as 'GET' | 'POST' | 'PUT' | 'DELETE';
      if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) continue;

      const url = (id: string) => route.url.replace(/:[A-Za-z]+/g, id);
      const payload =
        method === 'GET' || method === 'DELETE'
          ? undefined
          : { reason: 'test', roleId: 1, moduleKey: 'audit', level: 1, entries: [] };

      const inesistente = await t.app.inject({
        method,
        url: url(randomUUID().replace(/-/g, '')),
        headers: debole.headers(),
        ...(payload ? { payload } : {}),
      });
      const nonAutorizzato = await t.app.inject({
        method,
        url: url(bersaglio),
        headers: debole.headers(),
        ...(payload ? { payload } : {}),
      });

      // 401 non conta: quella e' assenza di sessione, non un oracolo.
      if (inesistente.statusCode === 401 || nonAutorizzato.statusCode === 401) continue;

      if (inesistente.statusCode !== nonAutorizzato.statusCode) {
        discrepanze.push(
          `${method} ${route.url}: id inesistente -> ${inesistente.statusCode}, ` +
            `non autorizzato -> ${nonAutorizzato.statusCode}`,
        );
      }
    }

    expect(discrepanze).toEqual([]);
  });

  it('un moderatore non distingue un utente esistente da uno inventato', async () => {
    // Il moderatore PUO` leggere (utenti:1) ma non bannare (serve utenti:3):
    // e' il caso realistico in cui l'oracolo si annida.
    const esistente = await t.app.inject({
      method: 'POST',
      url: `/api/users/${bersaglio}/ban`,
      headers: moderatore.headers(),
      payload: { reason: 'tentativo' },
    });
    const inventato = await t.app.inject({
      method: 'POST',
      url: `/api/users/${randomUUID().replace(/-/g, '')}/ban`,
      headers: moderatore.headers(),
      payload: { reason: 'tentativo' },
    });
    expect(esistente.statusCode).toBe(inventato.statusCode);
    expect(esistente.body).toBe(inventato.body);
  });

  it('un admin non distingue un OWNER che non domina da un id inventato', async () => {
    // SEC-08 + SEC-31 insieme: l'admin non domina l'owner, e la risposta e'
    // la stessa di un utente che non esiste. Sapere "quello c'e', ma non
    // puoi toccarlo" e' gia' informazione.
    const admin = await loginAs(t, await seedUser(t, { roleKey: 'admin' }));
    const ownerId = forte.userId;

    const suOwner = await t.app.inject({
      method: 'POST',
      url: `/api/users/${ownerId}/ban`,
      headers: admin.headers(),
      payload: { reason: 'tentativo' },
    });
    const suInventato = await t.app.inject({
      method: 'POST',
      url: `/api/users/${randomUUID().replace(/-/g, '')}/ban`,
      headers: admin.headers(),
      payload: { reason: 'tentativo' },
    });
    expect(suOwner.statusCode).toBe(404);
    expect(suOwner.statusCode).toBe(suInventato.statusCode);
    expect(suOwner.body).toBe(suInventato.body);
  });

  it('un owner invece ci arriva: il 404 non e` una rotta rotta', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/users/${bersaglio}`,
      headers: forte.headers(),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('SEC-15 / test 12 — Origin', () => {
  it('POST senza header Origin -> 403', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/session/logout-all',
      headers: {
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        cookie: `__Host-metamc_session=${debole.sessionCookie}`,
        'x-csrf-token': debole.csrf,
      },
      payload: {},
    });
    // Fail-closed anche quando l'header e' ASSENTE: un Origin mancante su una
    // richiesta che cambia stato e' il caso che il controllo esiste per
    // intercettare, ed e' quel che produce un form cross-site classico.
    expect(res.statusCode).toBe(403);
  });

  it('POST con Origin di un altro sito -> 403', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/session/logout-all',
      headers: debole.headers({ origin: 'https://malevolo.example' }),
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST con Origin di un SOTTODOMINIO -> 403', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/session/logout-all',
      headers: debole.headers({ origin: `https://forum.${new URL(TEST_ORIGIN).host}` }),
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET senza Origin passa: i metodi sicuri non sono soggetti al controllo', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: `__Host-metamc_session=${debole.sessionCookie}` },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('SEC-16 / test 13 — Sec-Fetch-Site', () => {
  it('POST con Sec-Fetch-Site: same-site -> 403', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/session/logout-all',
      headers: debole.headers({ 'sec-fetch-site': 'same-site' }),
      payload: {},
    });
    // Si rifiuta anche `same-site`, non solo `cross-site`: il punto e' proprio
    // escludere i sottodomini fratelli, che `same-site` include.
    expect(res.statusCode).toBe(403);
  });

  it('POST con Sec-Fetch-Site: cross-site -> 403', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/session/logout-all',
      headers: debole.headers({ 'sec-fetch-site': 'cross-site' }),
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST senza Sec-Fetch-Site -> 403', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/session/logout-all',
      headers: {
        origin: TEST_ORIGIN,
        'content-type': 'application/json',
        cookie: `__Host-metamc_session=${debole.sessionCookie}`,
        'x-csrf-token': debole.csrf,
      },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('SEC-17 — signed double-submit', () => {
  it('POST senza header X-CSRF-Token -> 403', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/session/logout-all',
      headers: sameOriginHeaders({ cookie: `__Host-metamc_session=${debole.sessionCookie}` }),
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST con un token CSRF di UN`ALTRA sessione -> 403', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/session/logout-all',
      headers: sameOriginHeaders({
        cookie: `__Host-metamc_session=${debole.sessionCookie}`,
        // E' il caso del sottodominio che scrive cookie: puo' scegliere il
        // valore del cookie CSRF, ma non puo' produrre un HMAC valido per
        // l'id di sessione della vittima, che non conosce.
        'x-csrf-token': forte.csrf,
      }),
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST con un token CSRF inventato -> 403', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/session/logout-all',
      headers: sameOriginHeaders({
        cookie: `__Host-metamc_session=${debole.sessionCookie}`,
        'x-csrf-token': 'token-inventato-di-lunghezza-simile-abcdefgh',
      }),
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('SEC-33 / SEC-34 — CSP e header di sicurezza', () => {
  it('index.html esce con un nonce diverso a ogni richiesta', async () => {
    const a = await t.app.inject({ method: 'GET', url: '/' });
    const b = await t.app.inject({ method: 'GET', url: '/' });
    const csp = (r: typeof a) => String(r.headers['content-security-policy'] ?? '');
    const nonceOf = (s: string) => /'nonce-([^']+)'/.exec(s)?.[1];

    expect(a.statusCode).toBe(200);
    expect(nonceOf(csp(a))).toBeDefined();
    expect(nonceOf(csp(a))).not.toBe(nonceOf(csp(b)));
    // Il nonce nella CSP e' lo stesso che finisce nell'HTML: se divergessero,
    // lo script non partirebbe e la pagina resterebbe bianca.
    expect(a.body).toContain(`nonce="${nonceOf(csp(a))}"`);
  });

  it('la CSP contiene le direttive di SEC-33', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/' });
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("'strict-dynamic'");
  });

  it('le risposte autenticate escono con Cache-Control: private, no-store e Vary: Cookie', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: `__Host-metamc_session=${debole.sessionCookie}` },
    });
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers.vary).toContain('Cookie');
  });
});

describe('SEC-29 — bodyLimit', () => {
  it('un body sopra i 4 KB su /api/auth/* -> 413', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: sameOriginHeaders(),
      payload: { email: 'x@metamc.it', password: 'x'.repeat(8000) },
    });
    expect(res.statusCode).toBe(413);
  });
});
