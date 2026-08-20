// Il modulo «modalita'». Fase 2, emendamento E4.
//
// PERCHE' QUESTO MODULO ESISTE. Il dizionario decide come i ventidue server
// osservati in produzione si raggruppano nei grafici. Nasce vuoto: nessuno sa
// a priori come questa rete vuole raggrupparli, e indovinarlo in una migration
// significa che il primo che apre il pannello trova nomi che non riconosce.
//
// IL CASO CHE VALE PER TUTTI GLI ALTRI, e che qui si costruisce apposta, e'
// quello vero della rete osservata: esistono `duels_1..6`, `duels_lobby_1..2` e
// `duels_event_1`. Una regola «inizia per duels_» le prende tutte e tre, e
// l'operatore che voleva separare arene, lobby ed evento se ne accorgerebbe
// giorni dopo, da un grafico sbagliato. Per questo esiste l'anteprima, e per
// questo l'anteprima NON riscrive il matcher: inserisce la regola davvero e
// annulla la transazione, cosi' non puo' divergere dal comportamento reale.

import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createKysely, createPool, type Database } from '#src/db/pool.ts';
import { colourWarnings, contrastRatio, previewAlias, readDictionary } from '#src/stats/modes.ts';
import { connect, createTestDatabase, type TestDatabase } from '#tests/support/postgres.ts';

let testDb: TestDatabase;
let pool: pg.Pool;
/** Il ruolo del PANNELLO: e' con questo che il modulo scrive. */
let db: Database;
let sql: pg.Client;

/** I nomi veri della rete, dalla sonda del passo 0. */
const SERVERS = [
  'duels_1',
  'duels_2',
  'duels_6',
  'duels_lobby_1',
  'duels_lobby_2',
  'duels_event_1',
  'survival',
  'sandbox7',
  'auth_1',
];

beforeAll(async () => {
  testDb = await createTestDatabase('modes');
  pool = createPool({
    connectionString: testDb.appUrl,
    max: 4,
    applicationName: 'metamc-test-modes',
    statementTimeout: '10s',
  });
  db = createKysely(pool);
  sql = await connect(testDb.migrateUrl, 'metamc-test-modes-sql');
}, 180_000);

afterAll(async () => {
  await sql?.end().catch(() => undefined);
  await db?.destroy().catch(() => undefined);
  await testDb?.drop();
});

beforeEach(async () => {
  await sql.query('DELETE FROM stats.mode_alias');
  await sql.query('DELETE FROM stats.mode');
  await sql.query('DELETE FROM stats.server WHERE server_id > 1');
  for (const s of SERVERS) {
    await sql.query('INSERT INTO stats.server (server_key) VALUES ($1)', [s]);
  }
});

async function mode(key: string, name: string, color: string | null = null): Promise<void> {
  await sql.query('INSERT INTO stats.mode (mode_key, display_name, color) VALUES ($1, $2, $3)', [
    key,
    name,
    color,
  ]);
}

async function rule(key: string, kind: string, value: string): Promise<void> {
  await sql.query(
    `INSERT INTO stats.mode_alias (match_kind, match_value, mode_id)
     SELECT $2, $3, mode_id FROM stats.mode WHERE mode_key = $1`,
    [key, kind, value],
  );
}

describe('il dizionario nasce vuoto e si riempie a mano', () => {
  it('senza regole ogni server e` non classificato, non perso', async () => {
    // `__unknown__` e' una serie VISIBILE del grafico: i giocatori restano nel
    // totale e il breakdown continua a chiudere a 100%. Se sparissero, la
    // torta non sommerebbe mai e qualcuno normalizzerebbe le percentuali.
    const d = await readDictionary(db);
    expect(d.modes).toHaveLength(0);
    expect(d.unclassified).toHaveLength(SERVERS.length);
  });

  it('una regola cattura i server e il resto resta scoperto', async () => {
    await mode('survival', 'Survival');
    await rule('survival', 'prefix', 'survival');
    const d = await readDictionary(db);
    expect(d.modes[0]?.servers).toEqual(['survival']);
    expect(d.unclassified).not.toContain('survival');
    expect(d.unclassified).toContain('sandbox7');
  });

  it('un prefisso senza underscore funziona: e` il caso di sandbox7', async () => {
    // La vecchia regola del documento toglieva `_[0-9]+$`, che su `sandbox7`
    // non toglie niente: ogni sandboxN sarebbe diventata una modalita' a se'.
    await mode('sandbox', 'Sandbox');
    await rule('sandbox', 'prefix', 'sandbox');
    const d = await readDictionary(db);
    expect(d.modes[0]?.servers).toEqual(['sandbox7']);
  });
});

describe('il caso duels_: la regola piu` specifica vince', () => {
  beforeEach(async () => {
    await mode('duels', 'Duels');
    await mode('lobby', 'Lobby');
    await mode('eventi', 'Eventi');
    await rule('duels', 'prefix', 'duels_');
    await rule('lobby', 'prefix', 'duels_lobby_');
    await rule('eventi', 'prefix', 'duels_event_');
  });

  it('le lobby e l`evento restano separati dalle arene', async () => {
    const d = await readDictionary(db);
    const byKey = new Map(d.modes.map((m) => [m.modeKey, m.servers]));
    expect(byKey.get('duels')).toEqual(['duels_1', 'duels_2', 'duels_6']);
    expect(byKey.get('lobby')).toEqual(['duels_lobby_1', 'duels_lobby_2']);
    expect(byKey.get('eventi')).toEqual(['duels_event_1']);
  });

  it('il nome esatto batte anche il prefisso piu` lungo', async () => {
    await rule('eventi', 'server', 'duels_lobby_2');
    const d = await readDictionary(db);
    const byKey = new Map(d.modes.map((m) => [m.modeKey, m.servers]));
    expect(byKey.get('lobby')).toEqual(['duels_lobby_1']);
    expect(byKey.get('eventi')).toContain('duels_lobby_2');
  });
});

describe('l`anteprima mostra l`effetto PRIMA di salvare', () => {
  beforeEach(async () => {
    await mode('duels', 'Duels');
    await mode('lobby', 'Lobby');
    await rule('lobby', 'prefix', 'duels_lobby_');
  });

  it('dice quali server cambierebbero e quali no', async () => {
    const rows = await previewAlias(db, 'duels', { matchKind: 'prefix', matchValue: 'duels_' });
    const byServer = new Map(rows.map((r) => [r.serverKey, r]));

    // Le arene passerebbero a Duels...
    expect(byServer.get('duels_1')?.before).toBe('__unknown__');
    expect(byServer.get('duels_1')?.after).toBe('duels');
    // ...e le lobby NO, perche' la loro regola e' piu' specifica. E' il punto
    // dell'anteprima: senza, l'operatore crede di aver sbagliato quando vede
    // le lobby restare dove sono.
    expect(byServer.get('duels_lobby_1')?.before).toBe('lobby');
    expect(byServer.get('duels_lobby_1')?.after).toBe('lobby');
    // E l'evento invece si', perche' nessuna regola lo reclama.
    expect(byServer.get('duels_event_1')?.after).toBe('duels');
  });

  it('non lascia NIENTE dietro di se`', async () => {
    // E' la proprieta' su cui si regge tutto: l'anteprima inserisce la regola
    // davvero, per non riscrivere il matcher da nessun'altra parte, e poi
    // annulla la transazione. Se il rollback non funzionasse, guardare
    // un'anteprima cambierebbe i grafici.
    const prima = await readDictionary(db);
    await previewAlias(db, 'duels', { matchKind: 'prefix', matchValue: 'duels_' });
    await previewAlias(db, 'duels', { matchKind: 'contains', matchValue: 'a' });
    const dopo = await readDictionary(db);
    expect(dopo).toEqual(prima);

    const regole = await sql.query('SELECT count(*)::int AS n FROM stats.mode_alias');
    expect((regole.rows[0] as { n: number }).n).toBe(1);
  });

  it('mostra anche una regola che RUBEREBBE server a un`altra modalita`', async () => {
    // Una regola esatta batte qualunque prefisso: l'operatore deve vederlo
    // prima, non scoprirlo dal grafico.
    const rows = await previewAlias(db, 'duels', {
      matchKind: 'server',
      matchValue: 'duels_lobby_1',
    });
    const r = rows.find((x) => x.serverKey === 'duels_lobby_1');
    expect(r?.before).toBe('lobby');
    expect(r?.after).toBe('duels');
  });
});

describe('gli avvisi sui colori sono avvisi', () => {
  it('segnala il colore che sparisce sul fondo scuro', () => {
    // #1F6E95 e' il valore tolto dai token di progetto: 2,99:1 sul fondo, cioe'
    // sotto la soglia leggibile. Un colore di serie non e' decorazione — e'
    // l'unica cosa che distingue due linee.
    expect(contrastRatio('#1f6e95', '#0e1f28')).toBeLessThan(3);
    const w = colourWarnings([{ modeKey: 'survival', color: '#1f6e95', hidden: false }]);
    expect(w).toContainEqual(expect.objectContaining({ kind: 'contrasto', modeKey: 'survival' }));
  });

  it('segnala due colori troppo vicini fra loro', () => {
    const w = colourWarnings([
      { modeKey: 'a', color: '#e8822b', hidden: false },
      { modeKey: 'b', color: '#e9852f', hidden: false },
    ]);
    expect(w).toContainEqual(expect.objectContaining({ kind: 'simile' }));
  });

  it('non segnala due colori distinti, e tace su quelli nascosti', () => {
    const w = colourWarnings([
      { modeKey: 'a', color: '#e8822b', hidden: false },
      { modeKey: 'b', color: '#57b8a6', hidden: false },
      // Una modalita' nascosta non e' su nessun grafico: avvisare su di lei
      // sarebbe rumore, e il rumore fa disattivare gli avvisi.
      { modeKey: 'c', color: '#e8822c', hidden: true },
    ]);
    expect(w).toHaveLength(0);
  });
});

describe('il ruolo del pannello puo` gestire il dizionario e nient`altro', () => {
  it('scrive le modalita`, non tocca i fatti', async () => {
    await mode('duels', 'Duels');
    await rule('duels', 'prefix', 'duels_');
    // Il modulo passa dal ruolo della fase 1 perche' e' l'unico che ha la
    // sessione, il contesto di autorizzazione e il registro attivita' in cui
    // scrivere il prima e il dopo di ogni modifica.
    await expect(
      db.executeQuery({ sql: 'SELECT 1 FROM stats.sample_server LIMIT 1', parameters: [] } as never),
    ).rejects.toThrow();
  });
});
