// Le rotte di Modes e Maps: le uniche del pannello che scrivono nel gioco.
//
// QUI SI PROVANO LE COSE CHE NON SI VEDONO. Che il permesso sia quello alto e
// non quello con cui si guardano i grafici; che una modifica finisca nel
// registro e una non-modifica no; che un salvataggio a meta' non lasci meta'
// delle righe scritte. Nessuna di queste, sbagliata, produce un errore visibile
// il giorno in cui viene introdotta.

import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loginAs, seedUser } from '#tests/support/actors.ts';
import { startTestApp, type TestApp } from '#tests/support/app.ts';
import {
  type ConfigState,
  type FakeConfigMysql,
  fakeConfigMysql,
} from '#tests/support/duels-config-mysql.ts';

let t: TestApp;
let my: FakeConfigMysql;

// DUE ATTORI, CREATI UNA VOLTA SOLA. Un login per test farebbe scattare il
// limitatore dei tentativi, e la suite fallirebbe per un motivo che non sta
// verificando.
let capo: Awaited<ReturnType<typeof loginAs>>;
let sviluppatore: Awaited<ReturnType<typeof loginAs>>;

const SEED = (): Partial<ConfigState> => ({
  modes: [
    { id: 1, name: 'bedwars', display_name: 'BedWars', type: 'DUEL', ranking: 'RANKED' },
    { id: 2, name: 'sumo', display_name: 'Sumo', type: 'FFA', ranking: 'UNRANKED' },
  ],
  modeSettings: [{ mode_id: 1, type: 'MOB_TIMER', value: '30' }],
  maps: [{ id: 10, name: 'arena', display_name: 'Arena', type: 'DUEL', context: 'NORMAL', enabled: 1 }],
  mapModes: [{ map_id: 10, mode_id: 1 }],
  mapEvents: [{ map_id: 10, event_type: 'UHC' }],
});

beforeAll(async () => {
  t = await startTestApp({ label: 'duels-config' });
  capo = await loginAs(t, await seedUser(t, { email: 'capo-config@metamc.it', roleKey: 'admin' }));
  sviluppatore = await loginAs(t, await seedUser(t, { email: 'dev-config@metamc.it', roleKey: 'dev' }));
}, 180_000);

afterAll(async () => {
  await t?.close();
});

beforeEach(() => {
  my = fakeConfigMysql(SEED());
  // Il contesto porta il database del gioco: nei test lo si sostituisce, ed e'
  // l'unico modo — non esiste un MySQL nella suite.
  (t.ctx as { duelsMysql: unknown }).duelsMysql = my;
});

async function auditRows(action: string): Promise<number> {
  const res = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM audit.audit_log WHERE action = ${action}
  `.execute(t.ctx.db);
  return Number(res.rows[0]?.n ?? '0');
}

describe('chi puo` entrare', () => {
  it('serve il livello 3 su `duels`, non quello con cui si guardano i grafici', async () => {
    // E' la distinzione della specifica: 1 apre l'andamento, 3 cambia le
    // regole con cui si gioca. Un controllo a 1 non fallirebbe mai in modo
    // visibile — darebbe soltanto a piu' persone il potere di cambiare il
    // gioco.
    const actor = sviluppatore;

    const res = await t.app.inject({
      method: 'GET',
      url: '/api/duels/config/modes',
      headers: actor.cookieOnly(),
    });
    expect(res.statusCode).toBe(403);
  });

  it('senza connessione al gioco risponde 503, non 404', async () => {
    // La rotta c'e'; e' l'installazione a non avere `DUELS_MYSQL_URL`. Un 404
    // manderebbe a cercare un errore di instradamento che non esiste.
    (t.ctx as { duelsMysql: unknown }).duelsMysql = null;
    const actor = capo;

    const res = await t.app.inject({
      method: 'GET',
      url: '/api/duels/config/modes',
      headers: actor.cookieOnly(),
    });
    expect(res.statusCode).toBe(503);
  });
});

describe('leggere', () => {
  it('l`elenco porta quanti settings ogni modalita` ha personalizzato', async () => {
    const actor = capo;
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/duels/config/modes',
      headers: actor.cookieOnly(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { modes: Array<{ name: string; overrides: number }> };
    expect(body.modes.find((m) => m.name === 'bedwars')?.overrides).toBe(1);
    expect(body.modes.find((m) => m.name === 'sumo')?.overrides).toBe(0);
  });

  it('il dettaglio porta SOLO le righe che ci sono', async () => {
    // Le altre valgono il default del registro, e mandarle tutte e quarantotto
    // renderebbe impossibile distinguere «personalizzato a 3» da «vale 3».
    const actor = capo;
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/duels/config/modes/1',
      headers: actor.cookieOnly(),
    });

    const body = res.json() as { settings: Array<{ key: string }> };
    expect(body.settings).toEqual([{ key: 'MOB_TIMER', value: '30' }]);
  });

  it('il vocabolario porta i quarantotto settings con i loro default', async () => {
    const actor = capo;
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/duels/config/vocabulary',
      headers: actor.cookieOnly(),
    });

    const body = res.json() as { modeSettings: unknown[]; eventTypes: string[] };
    expect(body.modeSettings).toHaveLength(48);
    // L'elenco dichiarato e' unito a quello osservato: `UHC` c'e' in entrambi.
    expect(body.eventTypes).toContain('UHC');
    expect(body.eventTypes).toContain('CRYSTAL_ROYALE');
  });
});

describe('salvare', () => {
  it('cambia i campi e scrive un setting', async () => {
    const actor = capo;
    const res = await t.app.inject({
      method: 'PATCH',
      url: '/api/duels/config/modes/1',
      headers: actor.headers(),
      payload: { displayName: 'Bed Wars', settings: { PLACE_BLOCKS: '1' } },
    });

    expect(res.statusCode).toBe(200);
    expect(my.state.modes[0]?.display_name).toBe('Bed Wars');
    expect(my.state.modeSettings).toContainEqual({ mode_id: 1, type: 'PLACE_BLOCKS', value: '1' });
  });

  it('riportare un setting al default CANCELLA la riga', async () => {
    // `MOB_TIMER` vale 10 di default e nel finto vale 30. Rimetterlo a 10 non
    // deve scrivere «10»: deve togliere la riga, o la modalita' smette di
    // seguire il plugin il giorno che quel default cambia.
    const actor = capo;
    const res = await t.app.inject({
      method: 'PATCH',
      url: '/api/duels/config/modes/1',
      headers: actor.headers(),
      payload: { settings: { MOB_TIMER: '10' } },
    });
    expect(res.statusCode, res.body).toBe(200);

    expect(my.state.modeSettings).toEqual([]);
    expect(my.log.some((q) => q.startsWith('DELETE FROM duels_mode_setting'))).toBe(true);
    expect(my.log.some((q) => q.startsWith('INSERT INTO duels_mode_setting'))).toBe(false);
  });

  it('un valore non ammesso e` 400, e non tocca niente', async () => {
    // `Enum.valueOf` e' case-sensitive e lancia: `hard` non e' `HARD`. Il posto
    // in cui accorgersene e' questo, non l'avvio di un server.
    const actor = capo;
    const res = await t.app.inject({
      method: 'PATCH',
      url: '/api/duels/config/modes/1',
      headers: actor.headers(),
      payload: { settings: { DIFFICULTY: 'hard' } },
    });

    expect(res.statusCode).toBe(400);
    expect(my.state.modeSettings).toEqual([{ mode_id: 1, type: 'MOB_TIMER', value: '30' }]);
  });

  it('un tipo non ammesso sulla colonna e` 400', async () => {
    const actor = capo;
    const res = await t.app.inject({
      method: 'PATCH',
      url: '/api/duels/config/modes/1',
      headers: actor.headers(),
      payload: { type: 'EVENT' },
    });

    // `EVENT` sembra plausibile e non esiste: `ModeType` ha solo DUEL e FFA —
    // il contesto e' della MAPPA.
    expect(res.statusCode).toBe(400);
    expect(my.state.modes[0]?.type).toBe('DUEL');
  });

  it('una modalita` sparita nel frattempo e` 404, non un salvataggio a vuoto', async () => {
    const actor = capo;
    const res = await t.app.inject({
      method: 'PATCH',
      url: '/api/duels/config/modes/999',
      headers: actor.headers(),
      payload: { displayName: 'Fantasma' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('la risposta dice che i server accesi non la vedono ancora', async () => {
    // Senza questa frase la modifica risulta salvata, e' salvata, e in gioco
    // non succede niente finche' qualcuno non riavvia.
    const actor = capo;
    const res = await t.app.inject({
      method: 'PATCH',
      url: '/api/duels/config/modes/1',
      headers: actor.headers(),
      payload: { displayName: 'Bed Wars' },
    });
    expect((res.json() as { note: string }).note).toMatch(/riavvio/);
  });
});

describe('il registro', () => {
  it('una modifica lascia una riga con il piano', async () => {
    const before = await auditRows('duels.mode.update');
    const actor = capo;
    await t.app.inject({
      method: 'PATCH',
      url: '/api/duels/config/modes/1',
      headers: actor.headers(),
      payload: { displayName: 'Bed Wars' },
    });
    expect(await auditRows('duels.mode.update')).toBe(before + 1);
  });

  it('una NON modifica non lascia niente', async () => {
    // Si apre, si tocca, si rimette com'era, si salva: succede spesso, e una
    // riga per ognuna renderebbe il registro inservibile proprio dove serve.
    const before = await auditRows('duels.mode.update');
    const actor = capo;
    const res = await t.app.inject({
      method: 'PATCH',
      url: '/api/duels/config/modes/1',
      headers: actor.headers(),
      payload: { displayName: 'BedWars', settings: { MOB_TIMER: '30' } },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { changed: boolean }).changed).toBe(false);
    expect(await auditRows('duels.mode.update')).toBe(before);
  });
});

describe('le mappe', () => {
  it('modalita` ed event type si aggiornano per differenza', async () => {
    const actor = capo;
    const res = await t.app.inject({
      method: 'PATCH',
      url: '/api/duels/config/maps/10',
      headers: actor.headers(),
      payload: { modeIds: [1, 2], eventTypes: ['UHC', 'PILLARS'] },
    });

    expect(res.statusCode).toBe(200);
    expect(my.state.mapModes).toEqual([
      { map_id: 10, mode_id: 1 },
      { map_id: 10, mode_id: 2 },
    ]);
    // `UHC` c'era gia': non si toglie e non si rimette. Cancellare e riscrivere
    // aprirebbe una finestra in cui le cascate vedono lo stato vuoto.
    expect(my.log.some((q) => q.startsWith('DELETE FROM duels_map_event_type'))).toBe(false);
    expect(my.state.mapEvents).toContainEqual({ map_id: 10, event_type: 'PILLARS' });
  });

  it('un salvataggio che fallisce a meta` non lascia niente', async () => {
    // E' la ragione per cui esiste `tx`: cambiare una mappa tocca quattro
    // tabelle, e a meta' strada il gioco resterebbe in uno stato che nessuno
    // ha chiesto.
    const actor = capo;
    my.breakOn('INSERT INTO duels_map_event_type');

    const res = await t.app.inject({
      method: 'PATCH',
      url: '/api/duels/config/maps/10',
      headers: actor.headers(),
      payload: { displayName: 'Arena Nuova', modeIds: [1, 2], eventTypes: ['UHC', 'PILLARS'] },
    });

    expect(res.statusCode).toBe(500);
    expect(my.state.maps[0]?.display_name).toBe('Arena');
    expect(my.state.mapModes).toEqual([{ map_id: 10, mode_id: 1 }]);
  });

  it('eliminare una mappa porta via le sue righe figlie', async () => {
    const actor = capo;
    const res = await t.app.inject({
      method: 'DELETE',
      url: '/api/duels/config/maps/10',
      headers: actor.headers(),
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(my.state.maps).toEqual([]);
    expect(my.state.mapModes).toEqual([]);
    expect(my.state.mapEvents).toEqual([]);
  });
});
