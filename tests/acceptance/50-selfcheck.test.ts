// Gli invarianti che girano come job. Fase 2, §9.1.
//
// QUESTO TEST FA DUE COSE, e la seconda e' l'unica che conta. La prima e'
// eseguire gli otto controlli su dati sani e vederli tacere. La seconda e'
// SPORCARE i dati, uno per volta, e vedere ognuno gridare — perche' un
// invariante che non ha mai fallito e' indistinguibile da uno che non puo'
// fallire, ed e' esattamente il difetto che stiamo cercando di non avere:
// un controllo inerte non da' errore, non fa niente.
//
// PERCHE' ESISTE IL FILE CHE SI PROVA QUI. Questa settimana il rollup
// giornaliero ha scritto la finestra invece del giorno — in produzione, per
// giorni, con la media giornaliera sbagliata di un fattore due e mezzo. Nessun
// test e' diventato rosso. Non c'era niente che guardasse i dati veri.

import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createKysely, createPool, type Database } from '#src/db/pool.ts';
import { CHECK_NAMES, runSelfcheck } from '#src/stats/selfcheck.ts';
import { connect, createTestDatabase, type TestDatabase } from '#tests/support/postgres.ts';

let testDb: TestDatabase;
let pool: pg.Pool;
let db: Database;
let sql: pg.Client;

const SERVERS = ['duels_1', 'duels_2'];

/**
 * Gli id VERI dei due server, riletti a ogni giro.
 *
 * Non si scrivono a mano. `stats.server.server_id` e' una identity: dopo una
 * DELETE la sequenza non torna indietro, quindi `duels_1` non e' 2 al secondo
 * giro — e un id cablato produce una violazione di chiave esterna, oppure,
 * peggio, righe attribuite a un server diverso.
 */
let ids: Record<string, number> = {};

beforeAll(async () => {
  testDb = await createTestDatabase('selfcheck');
  pool = createPool({
    connectionString: testDb.ingestUrl,
    max: 4,
    applicationName: 'metamc-test-selfcheck',
    connectionTimeoutMillis: 20_000,
    statementTimeout: '60s',
    searchPath: 'stats, public',
  });
  db = createKysely(pool);
  sql = await connect(testDb.migrateUrl, 'metamc-test-selfcheck-sql');
}, 180_000);

afterAll(async () => {
  await sql?.end().catch(() => undefined);
  await db?.destroy().catch(() => undefined);
  await testDb?.drop();
});

/**
 * Uno storico SANO di venticinque ore, coerente a ogni livello.
 *
 * Venticinque e non sei: `ticks_missing_24h` cammina una griglia di
 * ventiquattro ore, e uno storico piu' corto le farebbe contare come buchi
 * tutte le ore che precedono la prima riga — il controllo direbbe la verita',
 * e il test starebbe misurando la propria fixture.
 *
 * I numeri sono scelti perche' ogni invariante sia verificabile a mano: due
 * server con 100 e 50 giocatori, la rete a 150, cadenza 30 secondi.
 */
beforeEach(async () => {
  await sql.query(`
    DELETE FROM stats.integrity_check;
    DELETE FROM stats.rollup_5m; DELETE FROM stats.rollup_1h; DELETE FROM stats.rollup_1d;
    DELETE FROM stats.sample_server; DELETE FROM stats.poll_cycle;
    DELETE FROM stats.player_day_server; DELETE FROM stats.player_day;
    DELETE FROM stats.mode_alias; DELETE FROM stats.mode;
    DELETE FROM stats.server WHERE server_id > 1;
    UPDATE stats.ingest_state SET nominal_delta_s = 30 WHERE id = 1;
    -- Il watermark nasce a now(): senza riportarlo indietro, il rollup non
    -- guarderebbe nemmeno una riga di questo storico e i controlli
    -- confronterebbero tabelle vuote: passerebbero senza aver guardato niente,
    -- che e' il modo in cui un controllo diventa inerte.
    UPDATE stats.rollup_state SET watermark = now() - interval '26 hours', max_buckets = 400;`);

  await sql.query('INSERT INTO stats.server (server_key) SELECT unnest($1::text[])', [SERVERS]);
  await sql.query(`INSERT INTO stats.mode (mode_key, display_name) VALUES ('duels', 'Duels')`);
  await sql.query(
    `INSERT INTO stats.mode_alias (match_kind, match_value, mode_id)
     SELECT 'prefix', 'duels_', mode_id FROM stats.mode WHERE mode_key = 'duels'`,
  );

  // I CICLI, sulla griglia dei trenta secondi. La griglia e` il punto: e`
  // quella che `ticks_missing_24h` cammina.
  //
  // UN `run_id` SOLO per tutta la storia, come in un processo che non si e`
  // mai riavviato. Con uno diverso per riga — che e` come questa fixture
  // nasceva — ogni buco sarebbe sembrato un riavvio, e il controllo non
  // avrebbe potuto trovare niente: il test avrebbe misurato la propria
  // fixture invece del codice.
  await sql.query(`
    INSERT INTO stats.poll_cycle (tick_at, run_id, status, delta_s, players, keys_read)
    SELECT g, '00000000-0000-4000-8000-0000000000aa'::uuid, 'ok', 30, 150, 150
      FROM generate_series(
        to_timestamp(floor(extract(epoch FROM now() - interval '25 hours') / 30) * 30),
        to_timestamp(floor(extract(epoch FROM now()) / 30) * 30) - interval '30 seconds',
        interval '30 seconds') g`);

  await sql.query(
    `INSERT INTO stats.sample_server (tick_at, server_id, delta_s, players)
     SELECT c.tick_at, v.server_id, 30,
            CASE v.server_key WHEN 'duels_1' THEN 100 ELSE 50 END
       FROM stats.poll_cycle c CROSS JOIN stats.server v
      WHERE v.server_id > 1`,
  );

  const found = await sql.query<{ server_key: string; server_id: number }>(
    'SELECT server_key, server_id FROM stats.server WHERE server_id > 1',
  );
  ids = Object.fromEntries(found.rows.map((r) => [r.server_key, r.server_id]));
});

/** Il rollup vero, non una copia: i controlli devono vedere cio` che gira. */
async function rollupAll(): Promise<void> {
  const { runRollup } = await import('#src/stats/rollup.ts');
  for (const level of ['5m', '1h', '1d'] as const) {
    // Fino in pari: sei ore sono piu` bucket del tetto di un giro solo.
    for (let i = 0; i < 40; i += 1) {
      const r = await runRollup(db, level);
      if (r.caughtUp) break;
    }
  }
}

async function offendersOf(name: string): Promise<number> {
  const results = await runSelfcheck(db);
  const one = results.find((r) => r.name === name);
  if (!one) throw new Error(`controllo assente: ${name}`);
  return one.failures;
}

describe('gli invarianti girano tutti e tacciono su dati sani', () => {
  it('gli otto controlli del commento della migration ci sono tutti', () => {
    // I nomi non li invento qui: li dichiara la migration 011 sopra
    // `stats.integrity_check`. Se un giorno se ne aggiungesse uno la` senza
    // implementarlo, questo elenco lo direbbe.
    expect([...CHECK_NAMES].sort()).toEqual(
      [
        'covered_uniform',
        'delta_agreement',
        'geo_sum_equals_uniques',
        'max_hierarchy',
        'network_equals_servers',
        'rollup_vs_raw',
        'ticks_missing_24h',
        'uniques_bounds',
      ].sort(),
    );
  });

  it('su storico coerente nessuno trova niente', async () => {
    await rollupAll();
    const results = await runSelfcheck(db);

    for (const r of results) {
      expect(r.failures, `${r.name}: ${JSON.stringify(r.detail)}`).toBe(0);
    }
  });

  it('lascia una riga per controllo ANCHE quando va tutto bene', async () => {
    // Una tabella che si popola solo in caso di guasto non distingue «tutto
    // bene» da «il job e` morto tre settimane fa», e le due situazioni
    // richiedono azioni opposte.
    await rollupAll();
    await runSelfcheck(db);

    const rows = await sql.query<{ name: string; failures: string }>(
      'SELECT name, failures::text FROM stats.integrity_check ORDER BY name',
    );
    expect(rows.rows.map((r) => r.name)).toEqual([...CHECK_NAMES].sort());
    expect(rows.rows.every((r) => r.failures === '0')).toBe(true);
  });
});

describe('ogni invariante grida quando lo si viola', () => {
  it('network_equals_servers: un giocatore che sparisce dalle righe per server', async () => {
    // E` il difetto che fa non chiudere la torta sul totale. Qui si toglie un
    // giocatore da un server senza toccare la riga di rete.
    await sql.query(`
      UPDATE stats.sample_server SET players = players - 7
       WHERE tick_at = (SELECT max(tick_at) FROM stats.sample_server) AND server_id = ${ids['duels_1']}`);

    expect(await offendersOf('network_equals_servers')).toBe(1);
  });

  it('delta_agreement: un tick i cui secondi valgono due cose diverse', async () => {
    await sql.query(`
      UPDATE stats.sample_server SET delta_s = 20
       WHERE tick_at = (SELECT max(tick_at) FROM stats.sample_server) AND server_id = ${ids['duels_1']}`);

    expect(await offendersOf('delta_agreement')).toBe(1);
  });

  it('covered_uniform: un denominatore preso dalle righe del server', async () => {
    // La riscrittura che questo controllo esiste per prendere: `covered_s`
    // diverso fra i server dello stesso bucket significa che il denominatore
    // ha smesso di venire dal registro dei cicli.
    await rollupAll();
    await sql.query(`
      UPDATE stats.rollup_5m SET covered_s = covered_s - 30
       WHERE bucket = (SELECT max(bucket) FROM stats.rollup_5m WHERE bucket < date_bin('5 minutes', now(), 'epoch'::timestamptz))
         AND server_id = ${ids['duels_1']}`);

    expect(await offendersOf('covered_uniform')).toBe(1);
  });

  it('max_hierarchy: il record che cambia a seconda del livello di zoom', async () => {
    await rollupAll();
    // Si sposta il massimo del GIORNO, non delle ore: e` la direzione in cui
    // un rollup gerarchico sbagliato mente davvero.
    const changed = await sql.query(`
      UPDATE stats.rollup_1d SET players_max = players_max + 40
       WHERE day < stats.civil_day(now()) AND server_id = 0`);

    // Lo storico e` di sei ore: se cade tutto dentro oggi non c'e` nessun
    // giorno chiuso da sporcare, e allora si sporca l'ora contro i cinque
    // minuti — l'altro gradino della stessa gerarchia.
    if ((changed.rowCount ?? 0) === 0) {
      await sql.query(`
        UPDATE stats.rollup_1h SET players_max = players_max + 40
         WHERE bucket = (SELECT max(bucket) FROM stats.rollup_1h WHERE bucket < date_bin('1 hour', now(), 'epoch'::timestamptz))
           AND server_id = 0`);
    }

    expect(await offendersOf('max_hierarchy')).toBeGreaterThan(0);
  });

  it('rollup_vs_raw: un`ora aggregata che non torna piu` con il grezzo', async () => {
    // L'unico controllo che rifa` il conto dalla FONTE. E` quello che avrebbe
    // preso il rollup giornaliero che scriveva la finestra invece del giorno.
    await rollupAll();
    await sql.query(`
      UPDATE stats.rollup_1h SET player_seconds = player_seconds / 2
       WHERE bucket = (SELECT max(bucket) FROM stats.rollup_1h WHERE bucket < date_bin('1 hour', now(), 'epoch'::timestamptz))
         AND server_id = 0`);

    expect(await offendersOf('rollup_vs_raw')).toBe(1);
  });

  it('ticks_missing_24h: il poller era in piedi e non ha scritto', async () => {
    // Un buco non e` uno zero. Qui i tre slot spariscono in MEZZO alla storia,
    // fra due cicli dello stesso run: il processo c'era, e quei tre giri non
    // sono arrivati da nessuna parte.
    const before = await offendersOf('ticks_missing_24h');
    await sql.query(`
      DELETE FROM stats.poll_cycle
       WHERE tick_at IN (
         SELECT tick_at FROM stats.poll_cycle
          ORDER BY tick_at DESC OFFSET 100 LIMIT 3)`);

    expect(await offendersOf('ticks_missing_24h')).toBe(before + 3);
  });

  it('ticks_missing_24h: un RIAVVIO non e` una violazione, ma si conta lo stesso', async () => {
    // Il difetto della prima versione: su una giornata con cinque rilasci
    // segnava duecento slot e non poteva tornare a zero. Un allarme sempre
    // acceso e` un allarme spento, e questo controllo esiste proprio per
    // distinguere un buco da uno zero.
    //
    // Il buco a cavallo di due `run_id` e` il processo che non c'era, e chi
    // guarda il processo lo sa gia`. Non e` una violazione — ma gli slot
    // persi restano nella riga, perche` «zero violazioni» non deve leggersi
    // come «non si e` perso niente».
    await sql.query(`
      DELETE FROM stats.poll_cycle
       WHERE tick_at IN (
         SELECT tick_at FROM stats.poll_cycle
          ORDER BY tick_at DESC OFFSET 200 LIMIT 4)`);
    // Tutto cio` che viene DOPO il buco appartiene a un processo nuovo.
    await sql.query(`
      UPDATE stats.poll_cycle SET run_id = '00000000-0000-4000-8000-0000000000bb'::uuid
       WHERE tick_at > (SELECT max(tick_at) FROM stats.poll_cycle
                         WHERE tick_at < (SELECT max(tick_at) - interval '100 minutes'
                                            FROM stats.poll_cycle))`);

    const results = await runSelfcheck(db);
    const ticks = results.find((r) => r.name === 'ticks_missing_24h');

    expect(ticks?.failures).toBe(0);
    expect(JSON.stringify(ticks?.detail)).toContain('slot_mancanti_in_tutto');
    const detail = ticks?.detail as { slot_mancanti_in_tutto?: string | number };
    expect(Number(detail.slot_mancanti_in_tutto)).toBeGreaterThan(0);
  });

  it('uniques_bounds: unici di rete sommati dalle modalita`', async () => {
    // 5 000 persone che diventano 11 000 perche` chi gioca a due modalita` e`
    // stato contato due volte. Qui: la rete dichiara piu` unici della somma
    // di tutte le modalita`, che e` aritmeticamente impossibile.
    const day = 'stats.civil_day(now()) - 1';
    await sql.query(`
      INSERT INTO stats.player_day (day, player_id, first_seen_at, last_seen_at)
      SELECT ${day}, g, now() - interval '1 day', now() - interval '1 day'
        FROM generate_series(1, 10) g`);
    await sql.query(`
      INSERT INTO stats.player_day_server (day, server_id, player_id)
      SELECT ${day}, ${ids['duels_1']}, g FROM generate_series(1, 10) g`);
    await sql.query(`
      INSERT INTO stats.rollup_1d (day, server_id, samples, covered_s, expected_s,
                                   player_seconds, players_max, uniques)
      VALUES (${day}, 0, 100, 86400, 86400, 0, 0, 99)
      ON CONFLICT (day, server_id) DO UPDATE SET uniques = 99`);

    expect(await offendersOf('uniques_bounds')).toBe(1);
  });

  it('geo_sum_equals_uniques: la mappa e gli unici su due popolazioni diverse', async () => {
    // Il giocatore c'e` nell'anagrafica del giorno — quindi nella mappa — e
    // non nelle presenze per server, quindi non negli unici per modalita`.
    // Due numeri sullo stesso schermo che contano insiemi di persone diversi,
    // ed e` la forma in cui questo difetto si presenta davvero: nessuno dei
    // due e` assurdo da solo.
    await sql.query(`
      INSERT INTO stats.player_day (day, player_id, first_seen_at, last_seen_at, country)
      VALUES (stats.civil_day(now()) - 1, 4242, now(), now(), 'IT')`);

    expect(await offendersOf('geo_sum_equals_uniques')).toBe(1);
  });

  it('geo_sum_equals_uniques: e tace quando le due fonti concordano', async () => {
    // Lo stesso giocatore in due giorni, con due paesi diversi e su server
    // diversi: e` un giocatore che ha viaggiato, non un difetto. La mappa lo
    // attribuisce una volta sola e le due popolazioni restano uguali.
    await sql.query(`
      INSERT INTO stats.player_day (day, player_id, first_seen_at, last_seen_at, country)
      VALUES (stats.civil_day(now()) - 1, 1, now(), now(), 'IT'),
             (stats.civil_day(now()) - 2, 1, now(), now(), 'FR')`);
    await sql.query(`
      INSERT INTO stats.player_day_server (day, server_id, player_id)
      VALUES (stats.civil_day(now()) - 1, ${ids['duels_1']}, 1),
             (stats.civil_day(now()) - 2, ${ids['duels_2']}, 1)`);

    expect(await offendersOf('geo_sum_equals_uniques')).toBe(0);
  });

  it('un controllo che non si puo` ESEGUIRE non e` un controllo passato', async () => {
    // Il silenzio qui sarebbe indistinguibile dal successo, che e` la forma
    // esatta del difetto che questo file esiste per non avere. Si toglie il
    // permesso di leggere una tabella e si verifica che il giro lo dica
    // invece di contare zero.
    await sql.query('REVOKE SELECT ON stats.poll_cycle FROM metamc_stats_rw, metamc_ingest');
    try {
      const results = await runSelfcheck(db);
      const rotto = results.find((r) => r.name === 'network_equals_servers');
      expect(rotto?.failures).toBe(-1);
      expect(JSON.stringify(rotto?.detail)).toContain('poll_cycle');
    } finally {
      await sql.query('GRANT SELECT ON stats.poll_cycle TO metamc_stats_rw');
    }
  });
});
