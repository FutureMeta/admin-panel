// Le rotte di «Lingue», da capo a fondo: sessione, livelli, convalida,
// registro, e il MariaDB di Metaverse al posto del quale c'e' il finto.
//
// I LIVELLI SONO LA COSA PIU' FACILE DA SBAGLIARE IN SILENZIO. Un moderatore
// (1) che potesse scrivere un testo lo farebbe arrivare in gioco entro un
// minuto senza che nessuno lo riveda; un dev (2) che potesse accendere una
// lingua la mostrerebbe a tutti i giocatori. I tre attori qui sotto esistono
// per quello.

import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loginAs, seedUser } from '#tests/support/actors.ts';
import { startTestApp, type TestApp } from '#tests/support/app.ts';
import {
  type FakeMetaverseMysql,
  fakeMetaverseMysql,
  publish,
  seededState,
} from '#tests/support/metaverse-mysql.ts';

let t: TestApp;
let my: FakeMetaverseMysql;
let capo: Awaited<ReturnType<typeof loginAs>>;
let sviluppatore: Awaited<ReturnType<typeof loginAs>>;
let moderatore: Awaited<ReturnType<typeof loginAs>>;

beforeAll(async () => {
  t = await startTestApp({ label: 'lang-routes' });
  capo = await loginAs(t, await seedUser(t, { email: 'capo-lang@metamc.it', roleKey: 'admin' }));
  sviluppatore = await loginAs(t, await seedUser(t, { email: 'dev-lang@metamc.it', roleKey: 'dev' }));
  moderatore = await loginAs(t, await seedUser(t, { email: 'mod-lang@metamc.it', roleKey: 'moderatore' }));
}, 180_000);

afterAll(async () => {
  await t?.close();
});

beforeEach(() => {
  const state = seededState();
  publish(state, 'duels.uhc', {
    en: {
      'event.countdown': '<gray>%host% starts the event in <white>%time%',
      'event.full': '<red>The event is full',
    },
    it: { 'event.full': '<red>L’evento è pieno' },
  });
  my = fakeMetaverseMysql(state);
  // Il contesto porta il database di Metaverse: nei test lo si sostituisce,
  // ed e' l'unico modo — non esiste un MariaDB nella suite.
  (t.ctx as { metaverseMysql: unknown }).metaverseMysql = my;
});

async function auditRows(action: string): Promise<Array<{ meta: Record<string, unknown> }>> {
  const res = await sql<{ meta: Record<string, unknown> }>`
    SELECT meta FROM audit.audit_log WHERE action = ${action} ORDER BY id
  `.execute(t.ctx.db);
  return res.rows;
}

describe('senza connessione a Metaverse', () => {
  it('risponde 503 e dice quale variabile manca, non 404', async () => {
    (t.ctx as { metaverseMysql: unknown }).metaverseMysql = null;
    const res = await t.app.inject({ method: 'GET', url: '/api/lang', headers: capo.cookieOnly() });
    expect(res.statusCode).toBe(503);
    expect(res.json().detail).toContain('METAVERSE_MYSQL_URL');
  });
});

describe('leggere e` di livello 1', () => {
  it('senza sessione niente', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/lang' })).statusCode).toBe(401);
  });

  it('la panoramica: lingue, bundle e quante chiavi hanno un testo', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/lang', headers: moderatore.cookieOnly() });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.json()).toEqual({
      languages: [
        { code: 'en', display: '<white>English', position: 0, active: true },
        { code: 'it', display: '<white>Italiano', position: 1, active: true },
      ],
      bundles: [{ ns: 'duels.uhc', owner: 'duels', bundle: 'uhc', keys: 2, done: { en: 2, it: 1 } }],
      pending: false,
    });
  });

  it('le chiavi di un bundle, e 404 per un bundle che non c`e`', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/lang/keys?ns=duels.uhc',
      headers: moderatore.cookieOnly(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().keys.map((k: { key: string }) => k.key)).toEqual(['event.countdown', 'event.full']);

    const missing = await t.app.inject({
      method: 'GET',
      url: '/api/lang/keys?ns=duels.nope',
      headers: moderatore.cookieOnly(),
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe('modificare un testo e` di livello 2', () => {
  const body = {
    ns: 'duels.uhc',
    key: 'event.countdown',
    code: 'it',
    value: '<gray>%host% avvia l’evento tra <white>%time%',
  };

  it('chi legge soltanto non scrive', async () => {
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/lang/value',
      headers: moderatore.headers(),
      payload: body,
    });
    expect(res.statusCode).toBe(403);
    expect(my.state.messages.some((r) => r.locale === 'it' && r.message_key === 'event.countdown')).toBe(
      false,
    );
  });

  it('chi ha il 2 scrive: custom nel database, prima e dopo a registro', async () => {
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/lang/value',
      headers: sviluppatore.headers(),
      payload: body,
    });
    expect(res.statusCode).toBe(200);

    expect(
      my.state.messages.find((r) => r.locale === 'it' && r.message_key === 'event.countdown'),
    ).toMatchObject({
      shipped: null,
      custom: body.value,
      version: 1,
    });
    expect((await auditRows('lang.value.set')).at(-1)?.meta).toEqual({
      ns: 'duels.uhc',
      key: 'event.countdown',
      code: 'it',
      before: null,
      after: body.value,
    });

    // E la panoramica lo dice: e' in arrivo.
    const overview = await t.app.inject({ method: 'GET', url: '/api/lang', headers: capo.cookieOnly() });
    expect(overview.json().pending).toBe(true);
  });

  it('un testo vuoto e` rifiutato, e il rifiuto suggerisce <reset>', async () => {
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/lang/value',
      headers: capo.headers(),
      payload: { ...body, value: '   ' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain('<reset>');
  });

  it('un MiniMessage rotto e` rifiutato con i problemi, e non entra', async () => {
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/lang/value',
      headers: capo.headers(),
      payload: { ...body, value: '<gray>ciao <bold' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues.length).toBeGreaterThan(0);
    expect(my.state.messages.some((r) => r.locale === 'it' && r.message_key === 'event.countdown')).toBe(
      false,
    );
  });

  it('una chiave o una lingua che non esistono sono 404', async () => {
    const key = await t.app.inject({
      method: 'PUT',
      url: '/api/lang/value',
      headers: capo.headers(),
      payload: { ...body, key: 'event.fulll' },
    });
    expect(key.statusCode).toBe(404);
    const lang = await t.app.inject({
      method: 'PUT',
      url: '/api/lang/value',
      headers: capo.headers(),
      payload: { ...body, code: 'xx' },
    });
    expect(lang.statusCode).toBe(404);
  });
});

describe('gestire le lingue e` di livello 3', () => {
  it('un dev non crea lingue', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/lang/language',
      headers: sviluppatore.headers(),
      payload: { code: 'es', display: '<white>Español' },
    });
    expect(res.statusCode).toBe(403);
    expect(my.state.languages).toHaveLength(2);
  });

  it('nasce spenta, in fondo, e va a registro', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/lang/language',
      headers: capo.headers(),
      payload: { code: 'es', display: '<white>Español' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ code: 'es', display: '<white>Español', position: 2, active: false });
    expect((await auditRows('lang.language.create')).at(-1)?.meta).toEqual({
      code: 'es',
      display: '<white>Español',
    });

    const again = await t.app.inject({
      method: 'POST',
      url: '/api/lang/language',
      headers: capo.headers(),
      payload: { code: 'es', display: '<white>Español' },
    });
    expect(again.statusCode).toBe(409);
  });

  it('il codice sono due lettere minuscole, e il nome un MiniMessage valido', async () => {
    for (const payload of [
      { code: 'ES', display: 'Español' },
      { code: 'es', display: '<nope>Español' },
      { code: 'es', display: ' ' },
    ]) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/lang/language',
        headers: capo.headers(),
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
    expect(my.state.languages).toHaveLength(2);
  });

  it('accendere, rinominare e spostare', async () => {
    await t.app.inject({
      method: 'POST',
      url: '/api/lang/language',
      headers: capo.headers(),
      payload: { code: 'es', display: '<white>Español' },
    });

    const on = await t.app.inject({
      method: 'PATCH',
      url: '/api/lang/language/es',
      headers: capo.headers(),
      payload: { active: true, display: '<yellow>Español' },
    });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({ code: 'es', active: true, display: '<yellow>Español' });

    const up = await t.app.inject({
      method: 'PATCH',
      url: '/api/lang/language/es',
      headers: capo.headers(),
      payload: { move: 'up' },
    });
    expect(up.statusCode).toBe(200);
    const overview = await t.app.inject({ method: 'GET', url: '/api/lang', headers: capo.cookieOnly() });
    expect(overview.json().languages.map((l: { code: string }) => l.code)).toEqual(['en', 'es', 'it']);
    expect((await auditRows('lang.language.change')).at(-1)?.meta).toEqual({ code: 'es', move: 'up' });

    const denied = await t.app.inject({
      method: 'PATCH',
      url: '/api/lang/language/es',
      headers: sviluppatore.headers(),
      payload: { active: false },
    });
    // 404 e non 403: su una rotta con un id, un rifiuto e' un «non c'e'» (SEC-31).
    expect(denied.statusCode).toBe(404);

    const missing = await t.app.inject({
      method: 'PATCH',
      url: '/api/lang/language/xx',
      headers: capo.headers(),
      payload: { active: true },
    });
    expect(missing.statusCode).toBe(404);
  });
});
