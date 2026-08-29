// Cancellare un file di configurazione, o una cartella intera.
//
// E' L'UNICA OPERAZIONE DI QUESTA SCHERMATA CHE NON SI PUO' DISFARE. Salvare
// una bozza si riscrive, pubblicare si ripubblica, cambiare i legami si
// ricambia — cancellare no: versioni, legami e cronologia se ne vanno con il
// percorso, e quello che c'era dentro non e' scritto da nessun'altra parte.
//
// Da qui le tre cose che questo file fissa, e che sbagliate non producono
// nessun errore visibile il giorno in cui vengono introdotte:
//
//   1. IL LIVELLO E' 3, quello di «Pubblica», e non il 2 con cui si scrive.
//      Chi ha il 2 puo' riempire di bozze quello che vuole senza che il gioco
//      se ne accorga; qui invece il file esce dal bundle subito.
//   2. UNA CARTELLA NON PORTA VIA I VICINI. `menus` non deve toccare
//      `menus_old/`, e non c'e' nessun modo di accorgersene dal pannello:
//      se ne accorgerebbe un server, riavviando.
//   3. LA RIGA A REGISTRO PORTA I PERCORSI, uno per uno. E' l'unico posto in
//      cui resta scritto cosa e' stato cancellato.

import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createConfigPath, listConfigFiles } from '#src/duels/config-store.ts';
import { loginAs, seedUser } from '#tests/support/actors.ts';
import { startTestApp, type TestApp } from '#tests/support/app.ts';

let t: TestApp;
let capo: Awaited<ReturnType<typeof loginAs>>;
let sviluppatore: Awaited<ReturnType<typeof loginAs>>;

/** Il ramo di prova. `menus_old` esiste apposta: e' il vicino da non toccare. */
const RAMO = ['menus/main.yml', 'menus/duel/arena.yml', 'menus/duel/kit.yml', 'menus_old/main.yml'];

beforeAll(async () => {
  t = await startTestApp({ label: 'duels-cfg-del' });
  // DUE ATTORI, CREATI UNA VOLTA SOLA: un login per test farebbe scattare il
  // limitatore dei tentativi, e la suite fallirebbe per un motivo che non sta
  // verificando.
  capo = await loginAs(t, await seedUser(t, { email: 'capo-del@metamc.it', roleKey: 'admin' }));
  sviluppatore = await loginAs(t, await seedUser(t, { email: 'dev-del@metamc.it', roleKey: 'dev' }));
}, 240_000);

afterAll(async () => {
  await t?.close();
});

beforeEach(async () => {
  // DELETE e non TRUNCATE: `metamc_app` ha i quattro verbi su queste tabelle e
  // non ne e' proprietario, e TRUNCATE vuole la proprieta'. La cascata verso
  // versioni e legami e' la stessa — e' scritta nella migration.
  await sql`DELETE FROM stats.duels_config_path`.execute(t.ctx.db);
  for (const path of RAMO) {
    await createConfigPath(t.ctx.db, { path, modules: ['lobby', 'ffa'], author: 'import@metamc.it' });
  }
});

function del(actor: Awaited<ReturnType<typeof loginAs>>, path: string, folder = false) {
  return t.app.inject({
    method: 'DELETE',
    url: `/api/duels/config/path?path=${encodeURIComponent(path)}&folder=${folder}`,
    headers: actor.headers(),
  });
}

async function paths(): Promise<string[]> {
  return (await listConfigFiles(t.ctx.db)).map((f) => f.path);
}

describe('cancellare e` di livello 3, come pubblicare', () => {
  it('chi scrive le bozze non cancella', async () => {
    // `dev` ha 2 su `duels_config` (migration 021): scrive quanto vuole, e non
    // manda niente in produzione — nemmeno togliendo.
    const res = await del(sviluppatore, 'menus/main.yml');
    expect(res.statusCode).toBe(403);
    expect(await paths()).toContain('menus/main.yml');
  });

  it('e chi pubblica si`', async () => {
    const res = await del(capo, 'menus/main.yml');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ paths: ['menus/main.yml'], modules: ['ffa', 'lobby'] });
    expect(await paths()).not.toContain('menus/main.yml');
  });

  it('senza sessione non si passa', async () => {
    // 403 e non 401: una richiesta che cambia stato passa prima dal controllo
    // CSRF, che senza intestazione la ferma li'. Il numero conta meno del
    // fatto che il file sia ancora al suo posto.
    const res = await t.app.inject({
      method: 'DELETE',
      url: '/api/duels/config/path?path=menus/main.yml',
    });
    expect(res.statusCode).toBe(403);
    expect(await paths()).toContain('menus/main.yml');
  });
});

describe('una cartella si porta via i suoi file, e nessun altro', () => {
  it('cancella il sottoalbero e lascia stare il vicino', async () => {
    const res = await del(capo, 'menus', true);
    expect(res.statusCode).toBe(200);
    expect(res.json().paths).toEqual(['menus/duel/arena.yml', 'menus/duel/kit.yml', 'menus/main.yml']);

    const rimasti = await paths();
    expect(rimasti).toEqual(['menus_old/main.yml']);
  });

  it('la radice non e` una cartella cancellabile', async () => {
    // Il prefisso vuoto porterebbe via TUTTO l'albero. Non ci si arriva
    // cliccando — ci si arriva con una richiesta scritta a mano, ed e' l'unico
    // errore di questa schermata che non ha rimedio.
    const res = await t.app.inject({
      method: 'DELETE',
      url: '/api/duels/config/path?path=%2F&folder=true',
      headers: capo.headers(),
    });
    expect(res.statusCode).toBe(400);
    expect(await paths()).toHaveLength(4);
  });

  it('e nemmeno un percorso che risale', async () => {
    const res = await t.app.inject({
      method: 'DELETE',
      url: '/api/duels/config/path?path=..%2F..%2Fetc&folder=true',
      headers: capo.headers(),
    });
    expect(res.statusCode).toBe(400);
    expect(await paths()).toHaveLength(4);
  });

  it('un percorso che non esiste e` 404, non un successo silenzioso', async () => {
    // Rispondere «va bene, zero file» a un percorso scritto male vorrebbe dire
    // credere di aver cancellato qualcosa che e' ancora li'.
    const res = await del(capo, 'menus/inesistente.yml');
    expect(res.statusCode).toBe(404);
  });
});

describe('cio` che e` stato cancellato resta scritto a registro', () => {
  it('la riga porta i percorsi e i moduli, uno per uno', async () => {
    await del(capo, 'menus', true);

    const row = await sql<{ target_label: string; meta: { percorsi: string[]; moduli: string[] } }>`
      SELECT target_label, meta
        FROM audit.audit_log
       WHERE action = 'duels.config.delete'
       ORDER BY id DESC
       LIMIT 1
    `.execute(t.ctx.db);

    const found = row.rows[0];
    expect(found?.target_label).toBe('menus/ — 3 file');
    expect(found?.meta.percorsi).toEqual(['menus/duel/arena.yml', 'menus/duel/kit.yml', 'menus/main.yml']);
    // I MODULI SI LEGGONO PRIMA DI CANCELLARE: dopo, i legami non ci sono piu'
    // e la riga direbbe che quel file non lo riceveva nessuno.
    expect(found?.meta.moduli).toEqual(['ffa', 'lobby']);
  });

  it('un tentativo respinto non lascia una riga di cancellazione', async () => {
    // Il rifiuto ha il suo posto nel registro degli accessi; qui dentro
    // finisce solo cio' che e' successo davvero.
    const before = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM audit.audit_log WHERE action = 'duels.config.delete'
    `.execute(t.ctx.db);
    await del(sviluppatore, 'menus/main.yml');
    const after = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM audit.audit_log WHERE action = 'duels.config.delete'
    `.execute(t.ctx.db);
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });
});
