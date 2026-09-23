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
import { grantOverride } from '#tests/support/fixtures.ts';
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

  it('i tag che il pannello non conosce passano: li risolve il plugin', async () => {
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/lang/value',
      headers: capo.headers(),
      payload: { ...body, value: '<gray>Ciao <player>, sei su <server' },
    });
    expect(res.statusCode).toBe(200);
    expect(
      my.state.messages.find((r) => r.locale === 'it' && r.message_key === 'event.countdown')?.custom,
    ).toBe('<gray>Ciao <player>, sei su <server');
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

  it('un comando di click che il gioco non aveva non entra', async () => {
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/lang/value',
      headers: capo.headers(),
      payload: { ...body, value: "<click:run_command:'/op tizio'>Clicca" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: 'COMANDO_NON_PREVISTO',
      detail: "<click:run_command:'/op tizio'>",
    });
    expect(my.state.messages.some((r) => r.locale === 'it' && r.message_key === 'event.countdown')).toBe(
      false,
    );
  });

  it('un codice con uno spazio in fondo non e` un codice', async () => {
    // Il collation di MariaDB ignora gli spazi in coda: `en ` sarebbe `en`.
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/lang/value',
      headers: capo.headers(),
      payload: { ...body, code: 'it ' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('gestire le lingue e` il livello 3 dell`Elenco', () => {
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

  it('il codice sono due lettere minuscole, e il nome non e` vuoto', async () => {
    for (const payload of [
      { code: 'ES', display: 'Español' },
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

describe('cancellare una lingua', () => {
  const del = (actor: Awaited<ReturnType<typeof loginAs>>, code: string) =>
    t.app.inject({ method: 'DELETE', url: `/api/lang/language/${code}`, headers: actor.headers() });

  it('e` di livello 3 sull`Elenco: un dev vede 404, non 403, e non cancella niente', async () => {
    // SEC-31: su una rotta con un id un rifiuto e' un «non c'e'».
    expect((await del(sviluppatore, 'it')).statusCode).toBe(404);
    expect(my.state.languages).toHaveLength(2);
  });

  it('porta via lingua e testi, e il registro scrive quanti', async () => {
    const res = await del(capo, 'it');
    expect(res.statusCode).toBe(204);
    expect(my.state.languages.map((l) => l.locale)).toEqual(['en']);
    expect(my.state.messages.some((r) => r.locale === 'it')).toBe(false);
    expect(my.state.messages.some((r) => r.locale === 'en')).toBe(true);
    expect((await auditRows('lang.language.delete')).at(-1)?.meta).toEqual({
      code: 'it',
      display: '<white>Italiano',
      texts: 1,
    });
  });

  it('l`inglese no: e` il riferimento', async () => {
    const res = await del(capo, 'en');
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('riferimento');
    expect(my.state.languages).toHaveLength(2);
    // Nemmeno travestito: per MariaDB `en ` e` `en`.
    expect((await del(capo, 'en%20')).statusCode).toBe(400);
    expect(my.state.languages).toHaveLength(2);
  });

  it('una lingua che non c`e` e` 404', async () => {
    expect((await del(capo, 'xx')).statusCode).toBe(404);
  });
});

describe('un modulo per schermata: Bundle e Elenco', () => {
  /** Una persona senza ruoli, con solo il permesso dato qui: nient'altro la fa passare. */
  async function only(grants: Array<['lingue' | 'lingue_elenco', number]>) {
    const user = await seedUser(t);
    for (const [module, level] of grants) await grantOverride(t.ctx.db, user.id, module, level);
    await t.ctx.store.invalidate(user.id);
    return loginAs(t, user);
  }

  const get = (actor: Awaited<ReturnType<typeof loginAs>>, url: string) =>
    t.app.inject({ method: 'GET', url, headers: actor.cookieOnly() });
  const createEs = (actor: Awaited<ReturnType<typeof loginAs>>) =>
    t.app.inject({
      method: 'POST',
      url: '/api/lang/language',
      headers: actor.headers(),
      payload: { code: 'es', display: '<white>Español' },
    });
  const translateIt = (actor: Awaited<ReturnType<typeof loginAs>>) =>
    t.app.inject({
      method: 'PUT',
      url: '/api/lang/value',
      headers: actor.headers(),
      payload: { ns: 'duels.uhc', key: 'event.countdown', code: 'it', value: '<gray>Ciao' },
    });

  it('la migration da` a Elenco lo stesso livello che ogni ruolo aveva su Lingue, e i nomi del menu', async () => {
    const levels = await sql<{ role: string; lingue: number; elenco: number }>`
      SELECT r.key AS role,
             max(rp.level) FILTER (WHERE m.key = 'lingue')        AS lingue,
             max(rp.level) FILTER (WHERE m.key = 'lingue_elenco') AS elenco
        FROM auth.role_permissions rp
        JOIN auth.roles r   ON r.id = rp.role_id
        JOIN auth.modules m ON m.id = rp.module_id
       WHERE m.key IN ('lingue', 'lingue_elenco')
       GROUP BY r.key ORDER BY r.key
    `.execute(t.ctx.db);
    expect(levels.rows).toEqual([
      { role: 'admin', lingue: 3, elenco: 3 },
      { role: 'dev', lingue: 2, elenco: 2 },
      { role: 'moderatore', lingue: 1, elenco: 1 },
      { role: 'owner', lingue: 3, elenco: 3 },
    ]);

    const names = await sql<{ key: string; name: string }>`
      SELECT key, name FROM auth.modules WHERE key LIKE 'lingue%' ORDER BY sort_order
    `.execute(t.ctx.db);
    expect(names.rows).toEqual([
      { key: 'lingue', name: 'Bundle' },
      { key: 'lingue_elenco', name: 'Elenco' },
    ]);
  });

  it('Bundle al massimo traduce, ma non tocca le lingue', async () => {
    const actor = await only([['lingue', 3]]);
    expect((await get(actor, '/api/lang')).statusCode).toBe(200);
    expect((await get(actor, '/api/lang/keys?ns=duels.uhc')).statusCode).toBe(200);
    expect((await translateIt(actor)).statusCode).toBe(200);
    expect((await createEs(actor)).statusCode).toBe(403);
    expect(my.state.languages).toHaveLength(2);
  });

  it('Bundle in sola lettura legge i testi e non li scrive', async () => {
    const actor = await only([['lingue', 1]]);
    expect((await get(actor, '/api/lang/keys?ns=duels.uhc')).statusCode).toBe(200);
    expect((await translateIt(actor)).statusCode).toBe(403);
  });

  it('solo Elenco: vede e gestisce le lingue, ma i testi no', async () => {
    const actor = await only([['lingue_elenco', 3]]);
    expect((await get(actor, '/api/lang')).statusCode).toBe(200);
    expect((await get(actor, '/api/lang/keys?ns=duels.uhc')).statusCode).toBe(403);
    expect((await translateIt(actor)).statusCode).toBe(403);
    expect((await createEs(actor)).statusCode).toBe(201);
  });

  it('senza nessuno dei due, nemmeno la panoramica', async () => {
    const actor = await only([]);
    expect((await get(actor, '/api/lang')).statusCode).toBe(403);
  });
});
