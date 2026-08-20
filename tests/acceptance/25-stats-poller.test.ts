// Il ciclo di campionamento. Fase 2, passo 2 — e il suo cancello.
//
// COSA DEVE REGGERE, e perche' sono queste tre cose e non altre.
//
// I1 — il totale di rete e' la somma dei server. Se si rompe, il breakdown non
// chiude sul totale, e il primo che se ne accorge «aggiusta» normalizzando le
// percentuali: cioe' spalma i giocatori in transito sulle modalita', e da
// quel momento la torta e' plausibile e falsa.
//
// I7 — gli slot si distinguono per NATURA. Riga assente = il poller non stava
// girando; `failed` = girava e Redis non c'era; `skipped` = girava e lo slot
// e' passato mentre era occupato; `ok` con players a zero = la rete era
// davvero vuota. Sono quattro cose diverse e devono restare quattro, perche'
// chi non lo sa «aggiusta» il caso mancante scrivendo zeri — e uno zero al
// posto di un buco trasforma un guasto in un evento di business.
//
// I8 — niente valori fuori scala: nessuno zero nel grezzo, `delta_s` dentro i
// limiti, nessun conteggio negativo. Sono i vincoli che rendono la convenzione
// sparsa un fatto del database invece di un accordo verbale.
//
// Tutti i test girano contro Postgres vero e un server RESP2 vero: il poller
// non sa di essere sotto test, e nessuna delle sue assunzioni sul protocollo
// e' sostituita da un finto compiacente.

import { Redis } from 'ioredis';
import type pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createKysely, createPool, type Database } from '#src/db/pool.ts';
import { createGameRedis } from '#src/stats/game-redis.ts';
import { StatsPoller } from '#src/stats/poller.ts';
import { MiniRedis } from '#tests/support/mini-redis.ts';
import { connect, createTestDatabase, type TestDatabase } from '#tests/support/postgres.ts';

const PATTERN = 'metaverse:player:*';
/** La cadenza nominale della migration 011. I tick cadono sui suoi multipli. */
const ALIGN = 30_000;

let testDb: TestDatabase;
let pool: pg.Pool;
let db: Database;
let mini: MiniRedis;
let seed: Redis;
let game: Redis;
let sql: pg.Client;

/**
 * Un logger vero, muto.
 *
 * Non un finto con quattro funzioni vuote: pino ha un livello `silent` e
 * usarlo significa che il poller riceve esattamente l'oggetto che ricevera' in
 * produzione. Un finto qui nasconderebbe il giorno in cui il codice chiama un
 * metodo che il finto non ha.
 */
const silent = pino({ level: 'silent' });

beforeAll(async () => {
  testDb = await createTestDatabase('poller');
  pool = createPool({
    connectionString: testDb.ingestUrl,
    max: 2,
    applicationName: 'metamc-test-ingest',
    statementTimeout: '5s',
    searchPath: 'stats, public',
  });
  db = createKysely(pool);
  sql = await connect(testDb.migrateUrl, 'metamc-test-poller-sql');

  mini = new MiniRedis();
  await mini.start();
  seed = new Redis(mini.url, { enableAutoPipelining: false });
  game = createGameRedis(mini.url, 'test');
}, 180_000);

afterAll(async () => {
  game?.disconnect();
  await seed?.quit().catch(() => undefined);
  await mini?.stop().catch(() => undefined);
  await sql?.end().catch(() => undefined);
  await db?.destroy().catch(() => undefined);
  await testDb?.drop();
});

beforeEach(async () => {
  await seed.flushdb();
  await sql.query(`
    DELETE FROM stats.sample_server;
    DELETE FROM stats.poll_cycle;
    DELETE FROM stats.server WHERE server_id > 1;
    UPDATE stats.ingest_state
       SET last_tick_at = NULL, last_ok_tick_at = NULL, last_tick_players = NULL,
           nominal_delta_s = 30, max_delta_s = 60
     WHERE id = 1;`);
});

type Seed = { id: number; server?: string; connectionMs?: number; key?: string };

async function online(players: Seed[]): Promise<void> {
  for (const p of players) {
    const hash: Record<string, string> = { identifier: String(p.id) };
    if (p.server !== undefined) hash['server'] = p.server;
    if (p.connectionMs !== undefined) hash['connection-time'] = String(p.connectionMs);
    await seed.hset(`metaverse:player:${p.key ?? `Player${p.id}`}`, hash);
  }
}

async function poller(): Promise<StatsPoller> {
  const p = new StatsPoller({ db, redis: game, logger: silent, pattern: PATTERN });
  await p.start();
  return p;
}

/** Il tick allineato che `runOnce(now)` produrra' per quell'istante. */
const slot = (now: number) => new Date(Math.floor(now / ALIGN) * ALIGN);

async function cycleAt(at: Date): Promise<Record<string, unknown> | undefined> {
  const res = await sql.query('SELECT * FROM stats.poll_cycle WHERE tick_at = $1', [at]);
  return res.rows[0] as Record<string, unknown> | undefined;
}

async function samplesAt(at: Date): Promise<Array<{ server_id: number; players: number }>> {
  const res = await sql.query(
    `SELECT s.server_id, s.players FROM stats.sample_server s
      WHERE s.tick_at = $1 ORDER BY s.server_id`,
    [at],
  );
  return res.rows as Array<{ server_id: number; players: number }>;
}

describe('un ciclo normale', () => {
  it('scrive il registro e una riga per server, e i due numeri tornano (I1)', async () => {
    const now = Date.now();
    await online([
      { id: 101, server: 'duels_6', connectionMs: now - 5_000 },
      { id: 102, server: 'duels_6', connectionMs: now - 60_000 },
      { id: 103, server: 'survival', connectionMs: now - 900_000 },
    ]);

    const at = slot(now);
    await (await poller()).runOnce(now);

    const cycle = await cycleAt(at);
    expect(cycle?.['status']).toBe('ok');
    expect(Number(cycle?.['players'])).toBe(3);

    const samples = await samplesAt(at);
    // I1: il totale di rete NON e' derivato dalla somma — e' memorizzato a
    // parte — ma deve coincidere con essa, e questo lo verifica.
    expect(samples.reduce((n, r) => n + Number(r.players), 0)).toBe(3);
    expect(samples).toHaveLength(2);
  });

  it('un server mai visto entra nel dizionario da solo', async () => {
    // Un server nuovo non deve far fallire un ciclo: e' successo alle 3 del
    // mattino a chiunque abbia legato l'ingest a un elenco fisso.
    await online([{ id: 201, server: 'sandbox7', connectionMs: Date.now() }]);
    await (await poller()).runOnce();

    const res = await sql.query(
      `SELECT server_key, created_by FROM stats.server WHERE server_key = 'sandbox7'`,
    );
    expect(res.rows[0]).toMatchObject({ server_key: 'sandbox7', created_by: 'ingest' });
  });

  it('chi non ha un server finisce sul transito, non sparisce', async () => {
    // Se sparisse, il totale non tornerebbe con la somma dei server e I1
    // salterebbe — cioe' il breakdown smetterebbe di chiudere a 100%.
    const now = Date.now();
    await online([
      { id: 301, server: 'lobby_1', connectionMs: now },
      { id: 302, connectionMs: now },
    ]);
    const at = slot(now);
    await (await poller()).runOnce(now);

    const samples = await samplesAt(at);
    expect(samples.find((r) => Number(r.server_id) === 1)?.players).toBe(1);
    expect(samples.reduce((n, r) => n + Number(r.players), 0)).toBe(2);
  });

  it('un rename conta una volta sola', async () => {
    // La chiave e' per username: un rename ne lascia due vive fino alla
    // scadenza del TTL. Contarle entrambe gonfierebbe il totale per sempre, e
    // le sessioni direbbero un altro numero sulla stessa schermata.
    const now = Date.now();
    // I due server sono DIVERSI di proposito: contare una volta sola non
    // basta, serve che vinca la chiave piu' recente. Con la vecchia, il
    // giocatore risulterebbe sul server di novanta secondi fa — un
    // breakdown sbagliato che nessun conteggio totale rivelerebbe.
    // La VECCHIA si semina per prima, ed e' deliberato: e' l'unico ordine in
    // cui «vince la piu' recente» e «vince la prima che capita» danno
    // risultati diversi. Con l'ordine comodo il test passerebbe anche con la
    // regola sbagliata, cioe' non proverebbe niente.
    await online([
      { id: 401, server: 'duels_1', connectionMs: now - 90_000, key: 'NomeVecchio' },
      { id: 401, server: 'ffa_1', connectionMs: now - 1_000, key: 'NomeNuovo' },
    ]);
    const at = slot(now);
    await (await poller()).runOnce(now);

    const cycle = await cycleAt(at);
    expect(Number(cycle?.['players'])).toBe(1);
    // La sonda che rende il problema visibile: i duplicati si ricavano per
    // sottrazione, keys_read - keys_skipped - players. Perche' quel conto
    // dica la verita', keys_skipped deve contare SOLO le chiavi che non
    // hanno prodotto un'identita'.
    expect(Number(cycle?.['keys_read'])).toBe(2);
    expect(Number(cycle?.['keys_skipped'])).toBe(0);

    // E sul server GIUSTO: quello della chiave nuova.
    const suFfa = await sql.query(
      `SELECT s.players FROM stats.sample_server s
         JOIN stats.server v ON v.server_id = s.server_id
        WHERE s.tick_at = $1 AND v.server_key = 'ffa_1'`,
      [at],
    );
    expect(Number(suFfa.rows[0]?.players)).toBe(1);
  });

  it('una chiave malformata si conta e non ferma il ciclo', async () => {
    const now = Date.now();
    await online([{ id: 501, server: 'ffa_1', connectionMs: now }]);
    await seed.hset('metaverse:player:Rotto', { username: 'Rotto' });
    const at = slot(now);
    await (await poller()).runOnce(now);

    const cycle = await cycleAt(at);
    expect(cycle?.['status']).toBe('ok');
    expect(Number(cycle?.['keys_skipped'])).toBe(1);
    expect(Number(cycle?.['players'])).toBe(1);
  });
});

describe('i quattro stati di uno slot restano quattro (I7)', () => {
  it('rete davvero vuota: ok con players a zero e nessuna riga nel grezzo', async () => {
    // E' il terzo stato, e va distinto dal buco. Uno zero scritto al posto di
    // un buco falsa ogni media a valle, per sempre e in modo plausibile.
    const now = Date.now();
    const at = slot(now);
    await (await poller()).runOnce(now);

    const cycle = await cycleAt(at);
    expect(cycle?.['status']).toBe('ok');
    expect(Number(cycle?.['players'])).toBe(0);
    expect(await samplesAt(at)).toHaveLength(0);
  });

  it('Redis irraggiungibile: failed, senza copertura e senza righe', async () => {
    const dead = new Redis('redis://127.0.0.1:1', {
      enableAutoPipelining: false,
      maxRetriesPerRequest: 0,
      connectTimeout: 500,
      commandTimeout: 500,
      retryStrategy: () => null,
      lazyConnect: true,
    });
    dead.on('error', () => undefined);
    const p = new StatsPoller({ db, redis: dead, logger: silent, pattern: PATTERN });
    await p.start(); // i parametri arrivano da Postgres, che c'e'

    const now = Date.now();
    const at = slot(now);
    const res = await p.runOnce(now);
    dead.disconnect();

    expect(res['status']).toBe('failed');
    const cycle = await cycleAt(at);
    expect(cycle?.['status']).toBe('failed');
    // Un ciclo fallito non copre NIENTE: se dichiarasse una copertura,
    // accrediterebbe alla media del tempo che nessuno ha osservato.
    expect(cycle?.['delta_s']).toBeNull();
    expect(cycle?.['players']).toBeNull();
    expect(cycle?.['error_kind']).not.toBeNull();
    expect(await samplesAt(at)).toHaveLength(0);
  });

  it('uno slot passato mentre il ciclo precedente era occupato risulta skipped', async () => {
    // Senza questa riga quello slot sarebbe indistinguibile da «il poller non
    // stava girando», e l'invariante che conta i buchi lo sommerebbe ai
    // guasti di Postgres.
    const p = await poller();
    const base = Math.floor(Date.now() / ALIGN) * ALIGN;
    await p.runOnce(base);
    // Due slot dopo: quello in mezzo non e' mai stato tentato da noi.
    await p.runOnce(base + 2 * ALIGN);

    const mancante = await cycleAt(new Date(base + ALIGN));
    expect(mancante?.['status']).toBe('skipped');
    expect(mancante?.['delta_s']).toBeNull();
  });
});

describe('la copertura e` misurata, mai una costante (I8)', () => {
  it('il primo ciclo usa la cadenza nominale', async () => {
    const now = Date.now();
    const at = slot(now);
    await (await poller()).runOnce(now);
    expect(Number((await cycleAt(at))?.['delta_s'])).toBe(30);
  });

  it('il secondo ciclo misura il tempo davvero trascorso', async () => {
    const p = await poller();
    const base = Math.floor(Date.now() / ALIGN) * ALIGN;
    await p.runOnce(base);
    await p.runOnce(base + ALIGN);
    expect(Number((await cycleAt(new Date(base + ALIGN)))?.['delta_s'])).toBe(30);
  });

  it('dopo un fermo lungo la copertura si TAGLIA, non si accredita', async () => {
    // E' la differenza fra «tenere l'ultimo valore per un tick saltato» e
    // «accreditare mezz'ora di buco a un singolo campione». Il tempo oltre il
    // taglio resta scoperto, ed e' la verita'.
    const p = await poller();
    const base = Math.floor(Date.now() / ALIGN) * ALIGN;
    await p.runOnce(base);
    await p.runOnce(base + 30 * ALIGN); // quindici minuti dopo

    const delta = Number((await cycleAt(new Date(base + 30 * ALIGN)))?.['delta_s']);
    expect(delta).toBe(60); // max_delta_s, non 900
  });
});

describe('lo skew si misura su chi e` appena entrato, non su tutti', () => {
  it('al primo ciclo tace, perche` li` sarebbe l`eta` delle sessioni', async () => {
    const now = Date.now();
    await online([{ id: 601, server: 'duels_2', connectionMs: now - 3_600_000 }]);
    const at = slot(now);
    await (await poller()).runOnce(now);
    expect((await cycleAt(at))?.['skew_s']).toBeNull();
  });

  it('poi guarda solo i nuovi arrivati', async () => {
    const p = await poller();
    const base = Math.floor(Date.now() / ALIGN) * ALIGN;
    // Un veterano connesso da un'ora: se entrasse nel calcolo, la mediana
    // direbbe -3600 e qualcuno leggerebbe «orologio indietro di un'ora».
    await online([{ id: 701, server: 'duels_3', connectionMs: base - 3_600_000 }]);
    await p.runOnce(base);

    await online([{ id: 702, server: 'duels_3', connectionMs: base + ALIGN - 2_000 }]);
    await p.runOnce(base + ALIGN);

    const skew = Number((await cycleAt(new Date(base + ALIGN)))?.['skew_s']);
    expect(Math.abs(skew)).toBeLessThan(10);
  });
});

describe('i vincoli del database reggono cio` che il codice promette', () => {
  it('nel grezzo non finisce mai uno zero, e mai la riga di rete', async () => {
    const now = Date.now();
    await online([{ id: 801, server: 'limbo', connectionMs: now }]);
    await (await poller()).runOnce(now);

    const res = await sql.query(
      `SELECT count(*) FILTER (WHERE players <= 0) AS zeri,
              count(*) FILTER (WHERE server_id = 0) AS rete,
              count(*) FILTER (WHERE delta_s NOT BETWEEN 1 AND 300) AS delta_fuori_scala
         FROM stats.sample_server`,
    );
    expect(res.rows[0]).toMatchObject({ zeri: '0', rete: '0', delta_fuori_scala: '0' });
  });

  it('lo stato del campionamento avanza in modo da distinguere il ritardo', async () => {
    // `last_tick_at` avanza sempre («stavo girando»), `last_ok_tick_at` solo
    // sui cicli riusciti. La differenza fra i due E' il ritardo della
    // raccolta, ed e' la metrica che resta bassa solo se si sta raccogliendo
    // davvero — non se il processo e' semplicemente vivo.
    const now = Date.now();
    await online([{ id: 901, server: 'auth_1', connectionMs: now }]);
    const at = slot(now);
    await (await poller()).runOnce(now);

    const res = await sql.query(
      'SELECT last_tick_at, last_ok_tick_at, last_tick_players FROM stats.ingest_state WHERE id = 1',
    );
    expect(res.rows[0]).toMatchObject({ last_tick_at: at, last_ok_tick_at: at });
    expect(Number((res.rows[0] as { last_tick_players: number }).last_tick_players)).toBe(1);
  });
});
