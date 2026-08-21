// Il DIZIONARIO e` lo stesso in ogni payload, e non e` un dettaglio.
//
// COSA CI POGGIA SOPRA. Nel dettaglio di una modalita`, cambiando modalita` il
// payload nuovo non e` ancora arrivato: l'unico in mano parla di quella di
// prima. L'intestazione — nome, colore, scheda evidenziata — viene disegnata
// LO STESSO, subito, leggendo dal dizionario di quel payload vecchio la voce
// della modalita` appena chiesta. E` corretto solo perche' il dizionario e`
// completo e uguale ovunque.
//
// SE QUESTA PROPRIETA' CADESSE — perche' un giorno qualcuno restringe le
// etichette alla modalita` richiesta, che sembra un'ottimizzazione ovvia — non
// si romperebbe niente in modo rumoroso. L'intestazione mostrerebbe `duels`
// invece di «Duels» e un pallino grigio invece del colore scelto, per la
// frazione di secondo del caricamento. Nessun errore, nessun test rosso
// altrove: solo il pannello che per un istante sembra non sapere cosa sta
// guardando. E` il motivo per cui il controllo sta qui e non nel componente.

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKysely, createPool, type Database } from '#src/db/pool.ts';
import { buildAll } from '#src/stats/read.ts';
import { connect, createTestDatabase, type TestDatabase } from '#tests/support/postgres.ts';

let testDb: TestDatabase;
let pool: pg.Pool;
let db: Database;
let sql: pg.Client;

beforeAll(async () => {
  testDb = await createTestDatabase('dizionario');
  pool = createPool({
    connectionString: testDb.statsUrl,
    max: 4,
    applicationName: 'metamc-test-dizionario',
    connectionTimeoutMillis: 20_000,
    statementTimeout: '30s',
    searchPath: 'stats, public',
  });
  db = createKysely(pool);
  sql = await connect(testDb.migrateUrl, 'metamc-test-dizionario-sql');

  await sql.query(`
    DELETE FROM stats.rollup_5m; DELETE FROM stats.rollup_1h; DELETE FROM stats.rollup_1d;
    DELETE FROM stats.mode_alias; DELETE FROM stats.mode;
    DELETE FROM stats.server WHERE server_id > 1;`);

  // Tre modalita` distinguibili fra loro: una con colore scelto, una nascosta,
  // una fuori dalla ripartizione. Se il dizionario venisse filtrato, ognuna
  // sparirebbe da un payload diverso.
  await sql.query(`
    INSERT INTO stats.server (server_key) VALUES ('duels_1'), ('towny_1'), ('lobby_1');
    INSERT INTO stats.mode (mode_key, display_name, color, hidden, in_breakdown, sort_order) VALUES
      ('duels', 'Duels', '#e8663f', false, true,  10),
      ('towny', 'Towny', NULL,      true,  true,  20),
      ('lobby', 'Lobby', '#4f8cf5', false, false, 30);
    INSERT INTO stats.mode_alias (match_kind, match_value, mode_id)
      SELECT 'server', m.mode_key || '_1', m.mode_id FROM stats.mode m;`);

  // Un'ora di storico per tutti, piu` la riga di rete: senza, alcune query
  // tornano vuote e il confronto fra payload non proverebbe niente.
  await sql.query(
    `INSERT INTO stats.rollup_1h (bucket, server_id, samples, covered_s, player_seconds, players_max, players_max_at)
     SELECT g, v.server_id, 120, 3600, 50 * 3600, 60, g
       FROM generate_series(date_trunc('hour', now()) - interval '2 days',
                            date_trunc('hour', now()) - interval '1 hour', interval '1 hour') g
       CROSS JOIN stats.server v WHERE v.server_id > 1`,
  );
  await sql.query(
    `INSERT INTO stats.rollup_1h (bucket, server_id, samples, covered_s, player_seconds, players_max, players_max_at)
     SELECT g, 0, 120, 3600, 150 * 3600, 180, g
       FROM generate_series(date_trunc('hour', now()) - interval '2 days',
                            date_trunc('hour', now()) - interval '1 hour', interval '1 hour') g`,
  );
}, 180_000);

afterAll(async () => {
  await sql?.end().catch(() => undefined);
  await db?.destroy().catch(() => undefined);
  await testDb?.drop();
});

/** Le sole parti che l'intestazione legge, isolate dal resto del payload. */
function dictionaryOf(p: { labels: Record<string, string>; colors: Record<string, string> }) {
  return { labels: p.labels, colors: p.colors };
}

describe('ogni payload porta il dizionario intero', () => {
  it('il payload di una modalita` conosce anche le ALTRE', async () => {
    // E` la riga che fa funzionare il cambio di modalita`: stando su duels si
    // sa gia` come si chiama e di che colore e` towny, quindi la scheda
    // cliccata si illumina subito col nome giusto invece di aspettare.
    const built = await buildAll(db, '7d', undefined, ['duels']);
    const duels = built.perMode.get('duels');

    expect(duels?.labels).toMatchObject({ duels: 'Duels', towny: 'Towny', lobby: 'Lobby' });
    expect(duels?.colors['towny']).toBeUndefined(); // colore non scelto: lo decide la posizione
    expect(duels?.colors['lobby']).toBe('#4f8cf5');
  });

  it('due modalita` diverse danno lo STESSO dizionario', async () => {
    const built = await buildAll(db, '7d', undefined, ['duels', 'towny']);
    const duels = built.perMode.get('duels');
    const towny = built.perMode.get('towny');

    expect(duels && dictionaryOf(duels)).toEqual(towny && dictionaryOf(towny));
  });

  it('e non cambia col PERIODO', async () => {
    // L'altro modo di rompere l'intestazione: un dizionario costruito dalle
    // righe del periodo invece che dalla tabella delle modalita`. Su 24h le
    // modalita` spente da un giorno sparirebbero dalla barra, che cambierebbe
    // forma sotto il dito a ogni cambio di periodo.
    const [breve, lungo] = await Promise.all([
      buildAll(db, '24h', undefined, ['duels']),
      buildAll(db, '1y', undefined, ['duels']),
    ]);

    const a = breve.perMode.get('duels');
    const b = lungo.perMode.get('duels');
    expect(a && dictionaryOf(a)).toEqual(b && dictionaryOf(b));
  });

  it('l`ordine delle voci e` quello dichiarato, non quello del database', async () => {
    // Il colore di ripiego si assegna per POSIZIONE nel dizionario. Se
    // l'ordine dipendesse dal piano di esecuzione, towny cambierebbe colore
    // fra un payload e l'altro — e il cambio di modalita` lampeggerebbe.
    //
    // `__transit__` c'e` e ci deve essere: e` una serie visibile nel grafico,
    // il giocatore osservato senza un campo `server`. A tenerlo fuori dalla
    // barra delle schede — dove non e` una destinazione — e` il filtro sul
    // prefisso `__`, non una sua assenza dal dizionario.
    const built = await buildAll(db, '7d', undefined, ['duels', 'lobby']);
    const ordine = (m: string) => Object.keys(built.perMode.get(m)?.labels ?? {});
    const atteso = ['duels', 'towny', 'lobby', '__transit__'];

    expect(ordine('duels')).toEqual(atteso);
    expect(ordine('lobby')).toEqual(atteso);
  });

  it('anche le modalita` nascoste stanno nel dizionario, con il loro flag', async () => {
    // Nascosta vuol dire spenta nel grafico, non assente dall'anagrafica:
    // aprendone il dettaglio l'intestazione deve saperne il nome.
    const built = await buildAll(db, '7d', undefined, ['towny']);
    const towny = built.perMode.get('towny');

    expect(towny?.labels['towny']).toBe('Towny');
    expect(towny?.hidden).toContain('towny');
    expect(towny?.outOfBreakdown).toContain('lobby');
  });
});
