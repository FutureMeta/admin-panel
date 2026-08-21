// Quanto costa costruire un payload ALLA SCALA DELLA RETE VERA.
//
// PERCHE' ESISTE. In produzione il giro di warm misurava 7,9 s e il log diceva
// solo il totale: 30g, 90g e 1y costavano ~2,4 s ciascuno, identici, pur
// leggendo sorgenti diverse e finestre lunghe dodici volte tanto. Con due
// giorni di storico leggono le stesse righe, quindi il volume non poteva
// essere la causa — ma per affermarlo serviva un metro.
//
// Questo file e' il metro: diciannove server, due giorni di 5m/1h/1d,
// diecimila righe in player_day, ventimila in player_day_server, cinquemila
// cicli di poll. Qui il payload si costruisce in meno di cento millisecondi.
//
// I SERVER PARTONO DA server_id 100, non da 2. La prima versione di questo
// seme riempiva `player_day_server` con `WHERE server_id IN (2, 3)` e
// inseriva ZERO righe: la tabella che la meta' «per modalita'» di `geoRows`
// scandisce non era nella misura, e la misura diceva lo stesso che andava
// tutto bene. Un seme che sbaglia in silenzio non falsifica il test — lo
// rende d'accordo con qualunque cosa. Si semina per chiave, non per id.
//
// LA SOGLIA E' LARGA DI PROPOSITO. Non misura la macchina, sorveglia gli
// ordini di grandezza: una regressione che porti un range da 60 ms a un
// secondo e' un difetto, venti millisecondi in piu' sono il rumore di un
// portatile. Una soglia stretta qui produrrebbe rossi che nessuno crede, e un
// test a cui non si crede e' peggio di un test assente.

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKysely, createPool, type Database } from '#src/db/pool.ts';
import { buildAll } from '#src/stats/read.ts';
import { connect, createTestDatabase, type TestDatabase } from '#tests/support/postgres.ts';

let testDb: TestDatabase;
let pool: pg.Pool;
let db: Database;
let sql: pg.Client;
/** Un istante fisso: due letture diverse dell'orologio sposterebbero le finestre. */
const FIXED_NOW = new Date();
const SERVERS = Array.from({ length: 19 }, (_, i) => `srv_${i + 1}`);

beforeAll(async () => {
  testDb = await createTestDatabase('scala');
  pool = createPool({
    connectionString: testDb.statsUrl,
    max: 8,
    applicationName: 'metamc-test-scala',
    connectionTimeoutMillis: 20_000,
    statementTimeout: '60s',
    searchPath: 'stats, public',
  });
  db = createKysely(pool);
  sql = await connect(testDb.migrateUrl, 'metamc-test-scala-sql');
  await sql.query('INSERT INTO stats.server (server_key) SELECT unnest($1::text[])', [SERVERS]);
  await sql.query(
    `INSERT INTO stats.mode (mode_key, display_name) VALUES ('duels','Duels'),('lobby','Lobby')`,
  );
  await sql.query(`INSERT INTO stats.mode_alias (match_kind, match_value, mode_id)
     SELECT 'server', 'srv_1', mode_id FROM stats.mode WHERE mode_key='duels'`);
  await sql.query(`INSERT INTO stats.mode_alias (match_kind, match_value, mode_id)
     SELECT 'server', 'srv_2', mode_id FROM stats.mode WHERE mode_key='lobby'`);

  // Due giorni: 5m, 1h, 1d — come la produzione.
  await sql.query(`INSERT INTO stats.poll_cycle (tick_at, run_id, delta_s, players, status)
     SELECT g, gen_random_uuid(), 30, 700, 'ok' FROM generate_series(now() - interval '2 days', now(), interval '30 seconds') g`);
  await sql.query(`INSERT INTO stats.rollup_5m (bucket, server_id, samples, covered_s, player_seconds, players_max, players_max_at)
     SELECT g, v.server_id, 10, 300, 35*300, 40, g FROM generate_series(date_trunc('hour', now()) - interval '2 days',
       date_trunc('hour', now()), interval '5 minutes') g CROSS JOIN stats.server v WHERE v.server_id > 1`);
  await sql.query(`INSERT INTO stats.rollup_5m (bucket, server_id, samples, covered_s, player_seconds, players_max, players_max_at)
     SELECT g, 0, 10, 300, 19*35*300, 824, g FROM generate_series(date_trunc('hour', now()) - interval '2 days',
       date_trunc('hour', now()), interval '5 minutes') g`);
  await sql.query(`INSERT INTO stats.rollup_1h (bucket, server_id, samples, covered_s, player_seconds, players_max, players_max_at)
     SELECT g, v.server_id, 120, 3600, 35*3600, 40, g FROM generate_series(date_trunc('hour', now()) - interval '2 days',
       date_trunc('hour', now()) - interval '1 hour', interval '1 hour') g CROSS JOIN stats.server v WHERE v.server_id > 1`);
  await sql.query(`INSERT INTO stats.rollup_1h (bucket, server_id, samples, covered_s, player_seconds, players_max, players_max_at)
     SELECT g, 0, 120, 3600, 19*35*3600, 824, g FROM generate_series(date_trunc('hour', now()) - interval '2 days',
       date_trunc('hour', now()) - interval '1 hour', interval '1 hour') g`);
  await sql.query(`INSERT INTO stats.rollup_1d (day, server_id, samples, covered_s, expected_s, player_seconds, players_max, players_max_at)
     SELECT stats.civil_day(bucket), server_id, sum(samples)::int, sum(covered_s)::int,
            stats.day_seconds(stats.civil_day(bucket)), sum(player_seconds), max(players_max), max(players_max_at)
       FROM stats.rollup_1h GROUP BY 1,2 ON CONFLICT DO NOTHING`);
  // 5000 giocatori al giorno, su due giorni, ciascuno su due server.
  //
  // IL PAESE VA SEMINATO, altrimenti le mappe escono nulle da entrambe le
  // parti e il confronto fra «con» e «senza» passa senza confrontare niente.
  await sql.query(`INSERT INTO stats.player_day (day, player_id, country, seconds_online, sessions, first_seen_at, last_seen_at)
     SELECT d::date, n, (ARRAY['IT','FR','DE','MA','RO'])[1 + (n % 5)], 3600, 2, now(), now()
       FROM generate_series(stats.civil_day(now()) - 1, stats.civil_day(now()), interval '1 day') d,
            generate_series(1, 5000) n`);
  await sql.query(`INSERT INTO stats.player_day_server (day, player_id, server_id)
     SELECT p.day, p.player_id, v.server_id
       FROM stats.player_day p CROSS JOIN stats.server v WHERE v.server_key IN ('srv_1', 'srv_2')`);
  await sql.query(
    'ANALYZE stats.player_day; ANALYZE stats.player_day_server; ANALYZE stats.rollup_1h; ANALYZE stats.rollup_5m; ANALYZE stats.poll_cycle;',
  );
}, 600_000);

afterAll(async () => {
  await sql?.end().catch(() => undefined);
  await db?.destroy().catch(() => undefined);
  await testDb?.drop();
});

describe('alla scala della rete vera, un payload costa poco', () => {
  it('nessun range sfora il mezzo secondo', async () => {
    for (const r of ['24h', '7d', '30d', '90d', '1y'] as const) {
      await buildAll(db, r, undefined, []); // la prima paga la cache fredda
      const t0 = Date.now();
      const built = await buildAll(db, r, undefined, []);
      const ms = Date.now() - t0;
      // Il nome della query piu' cara sta nel messaggio: quando questo test
      // fallira', dira' gia' dove guardare invece di dire solo «troppo lento».
      expect(ms, `${r}: ${JSON.stringify(built.slowest)}`).toBeLessThan(500);
    }
  }, 600_000);

  it("e la ripartizione per query e' disponibile, non da ricavare", async () => {
    // E' cio' che mancava: tredici query in parallelo dietro un solo numero.
    // Scoprire quale costasse voleva dire strumentare a mano e rimettere in
    // produzione — un giro di rilascio per una domanda a cui il codice puo'
    // rispondere da solo.
    const built = await buildAll(db, '90d', undefined, []);
    expect(Object.keys(built.slowest)).toHaveLength(3);
    for (const v of Object.values(built.slowest)) expect(v).toBeGreaterThanOrEqual(0);
  }, 600_000);
});

describe('la provenienza per modalita` ha il suo cancello, come le altre', () => {
  it('senza modalita` richieste, il payload di rete e` identico', async () => {
    // LA CONDIZIONE DI SICUREZZA: saltare il pezzo per modalita` non deve
    // cambiare di una virgola cio` che la panoramica mostra. Se un giorno lo
    // cambiasse, la mappa direbbe due cose diverse a seconda di cosa qualcun
    // altro ha guardato di recente.
    const senza = await buildAll(db, '30d', FIXED_NOW, []);
    const con = await buildAll(db, '30d', FIXED_NOW);
    // Prima che siano uguali: che ci siano. Due mappe nulle sono uguali fra
    // loro e non dimostrano niente.
    expect(senza.overview.geo?.cc.length).toBeGreaterThan(0);
    expect(senza.overview.geo).toEqual(con.overview.geo);
  }, 600_000);

  it('e con una modalita` richiesta la sua provenienza c`e` ancora', async () => {
    // Il cancello non deve spegnere la funzione: chi apre il dettaglio di una
    // modalita` deve continuare a vedere la sua mappa.
    const con = await buildAll(db, '30d', FIXED_NOW, ['duels']);
    expect(con.perMode.get('duels')?.geo).not.toBeNull();
  }, 600_000);
});

describe('chiedere UNA modalita` non cambia cosa dice il suo payload', () => {
  it('duels e` identica chiesta da sola o insieme alle altre', async () => {
    // LA CONDIZIONE DI SICUREZZA DEL RESTRINGIMENTO.
    //
    // Le query per modalita' ora filtrano sull'elenco richiesto invece di
    // calcolarle tutte: in produzione ne servivano UNDICI per servirne una,
    // e il giro di warm era risalito da 846 ms a 8 secondi appena qualcuno
    // apriva un dettaglio. Il guadagno non si vede a questa scala — due
    // modalita` e ventimila righe — e non lo si finge qui.
    //
    // Quello che si prova e` che il filtro non tocchi il risultato: se lo
    // toccasse, la stessa modalita` direbbe due cose a seconda di chi altro
    // e` stato guardato di recente, che e` la peggiore forma di dipendenza
    // possibile fra due schermate.
    const sola = await buildAll(db, '30d', FIXED_NOW, ['duels']);
    const tutte = await buildAll(db, '30d', FIXED_NOW);

    expect(sola.perMode.get('duels')).toEqual(tutte.perMode.get('duels'));
  }, 600_000);

  it('e la panoramica non cambia in nessuno dei due casi', async () => {
    const sola = await buildAll(db, '30d', FIXED_NOW, ['duels']);
    const nessuna = await buildAll(db, '30d', FIXED_NOW, []);
    expect(sola.overview).toEqual(nessuna.overview);
  }, 600_000);
});
