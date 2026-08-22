// Il collega che non riusciva a entrare, e in incognito si'.
//
// IL SINTOMO. Stesse credenziali, stesso link, stesso browser: "Accesso non
// consentito da questa origine". In una finestra in incognito, con le
// stessissime credenziali, il login passava. Cancellare i cookie sbloccava.
//
// LA CAUSA NON ERA L'ORIGINE. Delle tre difese che rispondono 403 a una
// richiesta che cambia stato, solo SEC-17 guarda i cookie, e SEC-17 si attiva
// SOLO quando la richiesta porta gia' una sessione VALIDA. Quindi:
//
//   1. la persona entra, e la sessione dura quattordici giorni (D-11);
//   2. chiude il browser. Il cookie di sessione resta — ha un Max-Age — ma il
//      cookie CSRF no: senza Max-Age e' un cookie di sessione del BROWSER, e
//      il browser lo butta chiudendosi;
//   3. riapre direttamente sul link del login. Quella pagina non chiama
//      `/api/me` — e' figlia della radice, non della shell — quindi nessuno
//      riemette il cookie CSRF;
//   4. il POST di login porta una sessione valida e nessun token: SEC-17
//      risponde 403, e la schermata attribuisce all'origine un errore che
//      l'origine non ha commesso.
//
// In incognito il passaggio 1 non esiste: niente sessione, SEC-17 non si
// attiva, il login passa. Cancellare i cookie fa la stessa cosa.
//
// ED E' UN VICOLO CIECO. Non c'e' nessuna richiesta che quella persona possa
// fare per uscirne: il login e' bloccato, e finche' non svuota i cookie a
// mano ogni tentativo dara' lo stesso 403. Un controllo che chiude fuori chi
// ha le credenziali giuste non sta proteggendo niente.
//
// LA CORREZIONE. Il cookie CSRF vive quanto la sessione da cui e' derivato.
// Erano due durate diverse per due meta' della stessa cosa, ed e' la
// differenza — non l'una o l'altra — a creare lo stato senza uscita.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loginAs, seedUser } from '#tests/support/actors.ts';
import { cookieFrom, sameOriginHeaders, startTestApp, type TestApp } from '#tests/support/app.ts';

let t: TestApp;

beforeAll(async () => {
  t = await startTestApp({ label: 'login-csrf' });
}, 180_000);

afterAll(async () => {
  await t?.close();
});

/** La riga `Set-Cookie` intera, con i suoi attributi: qui servono quelli. */
function setCookieLine(setCookie: string | string[] | undefined, name: string): string | undefined {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return list.find((c) => c.startsWith(`${name}=`));
}

function maxAgeOf(line: string | undefined): number | undefined {
  const found = /max-age=(-?\d+)/i.exec(line ?? '');
  return found ? Number(found[1]) : undefined;
}

describe('chi ha ancora una sessione aperta riesce comunque a rifare il login', () => {
  it('il cookie sopravvive alla chiusura del browser, quindi il login passa', async () => {
    const user = await seedUser(t, { email: 'collega@metamc.it' });
    const actor = await loginAs(t, user);

    // Il browser si chiude e si riapre. Quello che RIMANE nel barattolo sono
    // i cookie con una scadenza: prima di questa correzione il cookie di
    // sessione ce l'aveva e quello CSRF no, quindi qui sopravviveva mezza
    // coppia. Ora sopravvivono entrambi, ed e' questa la riga che lo dice.
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: actor.headers(),
      payload: { email: user.email, password: user.password },
    });

    expect(res.statusCode).toBe(200);
  });

  it('senza il token SEC-17 rifiuta, ed e` il vicolo cieco che si e` visto', async () => {
    // NON e' un difetto di SEC-17: con una sessione valida e nessun token il
    // rifiuto e' corretto. Il difetto era ARRIVARCI — cioe' che il browser
    // buttasse il token da solo — e ci si arrivava sul login, che e' l'unica
    // richiesta con cui quella persona poteva provare a uscirne.
    //
    // Resta qui perche' se un giorno questo 403 sparisse senza che nessuno
    // l'abbia deciso, sarebbe un controllo caduto in silenzio.
    const user = await seedUser(t, { email: 'senza-token@metamc.it' });
    const actor = await loginAs(t, user);

    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: sameOriginHeaders(actor.cookieOnly()),
      payload: { email: user.email, password: user.password },
    });

    expect(res.statusCode).toBe(403);
  });
  it('e in incognito andava, che e` il confronto che ha fatto scoprire il difetto', async () => {
    const user = await seedUser(t, { email: 'incognito@metamc.it' });
    await loginAs(t, user);

    // Senza NESSUN cookie: la stessa richiesta, dalla stessa origine, con le
    // stesse credenziali. Se questa passa e quella sopra no, la differenza
    // non puo' essere l'origine.
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: sameOriginHeaders(),
      payload: { email: user.email, password: user.password },
    });

    expect(res.statusCode).toBe(200);
  });
});

describe('il cookie CSRF vive quanto la sessione da cui e` derivato', () => {
  it('non e` un cookie che muore chiudendo il browser', async () => {
    const user = await seedUser(t, { email: 'durata@metamc.it' });
    const actor = await loginAs(t, user);

    const me = await t.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: actor.cookieOnly(),
    });
    expect(me.statusCode).toBe(200);

    const line = setCookieLine(me.headers['set-cookie'], '__Host-metamc_csrf');
    expect(line).toBeDefined();
    // SENZA Max-Age il browser lo tratta come cookie di sessione e lo scarta
    // alla chiusura, mentre la sessione vera dura giorni. E' quella
    // differenza a produrre il vicolo cieco.
    expect(maxAgeOf(line)).toBe(t.ctx.env.SESSION_ABSOLUTE_SECONDS);
  });

  it('e resta leggibile da JavaScript e legato a `__Host-`', async () => {
    // Le due proprieta' che il doppio invio firmato richiede, e che una
    // modifica alle opzioni del cookie potrebbe togliere per sbaglio mentre
    // ne aggiunge la durata.
    const user = await seedUser(t, { email: 'attributi@metamc.it' });
    const actor = await loginAs(t, user);

    const me = await t.app.inject({ method: 'GET', url: '/api/me', headers: actor.cookieOnly() });
    const line = setCookieLine(me.headers['set-cookie'], '__Host-metamc_csrf') ?? '';

    expect(line.toLowerCase()).not.toContain('httponly');
    expect(line.toLowerCase()).toContain('secure');
    expect(line.toLowerCase()).toContain('path=/');
    expect(cookieFrom(me.headers['set-cookie'], '__Host-metamc_csrf')).toBeTruthy();
  });
});
