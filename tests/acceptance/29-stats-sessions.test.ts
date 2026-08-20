// Sessioni, presenze giornaliere e unici. Fase 2, passo 6 — e il suo cancello.
//
// LE DUE PROVE DI PROPRIETA' DELLA §9.2 CHE TOCCANO QUI, costruite apposta
// perche' sono gli scenari in cui i difetti si manifestano tutti insieme:
//
//   3. rename, riconnessione e trasferimento di server. Il giocatore deve
//      contare UNA volta; il trasferimento NON deve spezzare la sessione — se
//      la spezzasse, la durata media diventerebbe «quanto si resta su una
//      singola istanza», che non e' la domanda di nessuno — e la
//      riconnessione invece SI'.
//   6. sessione a cavallo della mezzanotte. I secondi si affettano sui due
//      giorni, la sessione si conta una volta sola sul giorno in cui INIZIA,
//      e il giocatore compare negli unici di entrambi.
//
// E l'invariante che il database non puo' imporre:
//
//   I6 — unici(rete) sta fra il massimo e la somma degli unici per modalita'.
//   Derivarli sommando le modalita' farebbe di cinquemila persone undicimila
//   con 2,2 modalita' medie a testa, e quel numero crescerebbe con la
//   rotazione fra modalita' invece che con le persone.

import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createKysely, createPool, type Database } from '#src/db/pool.ts';
import type { OnlinePlayer } from '#src/stats/game-redis.ts';
import { dailyClose } from '#src/stats/rollup.ts';
import { SessionTracker } from '#src/stats/sessions.ts';
import { connect, createTestDatabase, type TestDatabase } from '#tests/support/postgres.ts';

let testDb: TestDatabase;
let pool: pg.Pool;
let db: Database;
let sql: pg.Client;

const ARENA = 'duels_1';
const LOBBY = 'lobby_1';
let serverIds = new Map<string, number>();

beforeAll(async () => {
  testDb = await createTestDatabase('sessions');
  pool = createPool({
    connectionString: testDb.ingestUrl,
    max: 2,
    applicationName: 'metamc-test-sessions',
    statementTimeout: '20s',
    searchPath: 'stats, public',
  });
  db = createKysely(pool);
  sql = await connect(testDb.migrateUrl, 'metamc-test-sessions-sql');
}, 180_000);

afterAll(async () => {
  await sql?.end().catch(() => undefined);
  await db?.destroy().catch(() => undefined);
  await testDb?.drop();
});

beforeEach(async () => {
  await sql.query(`
    DELETE FROM stats.session_open;
    DELETE FROM stats.session;
    DELETE FROM stats.player_day_server;
    DELETE FROM stats.player_day;
    DELETE FROM stats.mode_day_unique;
    DELETE FROM stats.rollup_1d;
    DELETE FROM stats.mode_alias;
    DELETE FROM stats.mode;
    DELETE FROM stats.server WHERE server_id > 1;`);

  const res = await sql.query<{ server_id: number; server_key: string }>(
    'INSERT INTO stats.server (server_key) VALUES ($1), ($2) RETURNING server_id, server_key',
    [ARENA, LOBBY],
  );
  serverIds = new Map(res.rows.map((r) => [r.server_key, Number(r.server_id)]));
});

const idOf = (key: string) => serverIds.get(key);

function online(
  list: Array<{ id: number; server: string; connectionMs: number; country?: string }>,
): Map<number, OnlinePlayer> {
  return new Map(
    list.map((p) => [
      p.id,
      {
        playerId: p.id,
        serverKey: p.server,
        connectionMs: p.connectionMs,
        // `null` = geolocalizzazione spenta, che e` lo stato di questi test
        // tranne dove servono i paesi.
        country: p.country ?? null,
      },
    ]),
  );
}

async function tracker(): Promise<SessionTracker> {
  const t = new SessionTracker();
  await t.load(db, { graceTicks: 3, reaperAfterS: 900 });
  return t;
}

type Row = Record<string, string | number | boolean | null | Date>;
const rows = async (q: string, p: unknown[] = []): Promise<Row[]> => (await sql.query(q, p)).rows as Row[];

describe('una sessione si apre, si conta e si chiude sull`ultima prova', () => {
  it('la prima osservazione apre la sessione e segna il giorno', async () => {
    const t = await tracker();
    const now = new Date();
    const conn = now.getTime() - 60_000;
    await t.observe(db, now, online([{ id: 1, server: ARENA, connectionMs: conn }]), idOf);

    const open = await rows('SELECT player_id, started_at, accounted_through FROM stats.session_open');
    expect(open).toHaveLength(1);
    // `started_at` e' il connection-time GREZZO, non l'istante del tick: e'
    // cio' che rende stabile il confronto «e' la stessa sessione?».
    expect(((open[0] as Row)['started_at'] as Date).getTime()).toBe(conn);

    const day = await rows('SELECT sessions, seconds_online FROM stats.player_day');
    expect(Number(day[0]?.['sessions'])).toBe(1);
    // I secondi arrivano dopo, dalla chiusura: qui e' appena cominciata.
    expect(Number(day[0]?.['seconds_online'])).toBe(0);
  });

  it('sparire dentro la grazia non chiude niente', async () => {
    // La grazia esiste per il tick in cui un trasferimento fa sparire la
    // chiave per un attimo. Chiudere li' spezzerebbe ogni sessione a ogni
    // cambio di server.
    const t = await tracker();
    const base = Date.now();
    const p = online([{ id: 1, server: ARENA, connectionMs: base - 60_000 }]);
    await t.observe(db, new Date(base), p, idOf);
    for (let i = 1; i <= 3; i += 1) {
      await t.observe(db, new Date(base + i * 30_000), new Map(), idOf);
    }
    expect(await rows('SELECT 1 FROM stats.session')).toHaveLength(0);
    expect(t.openCount).toBe(1);
  });

  it('oltre la grazia chiude, e chiude sull`ULTIMA prova, non su adesso', async () => {
    const t = await tracker();
    const base = Date.now();
    const visto = new Date(base);
    await t.observe(db, visto, online([{ id: 1, server: ARENA, connectionMs: base - 60_000 }]), idOf);
    for (let i = 1; i <= 4; i += 1) {
      await t.observe(db, new Date(base + i * 30_000), new Map(), idOf);
    }

    const s = await rows('SELECT ended_at, duration_s, end_reason FROM stats.session');
    expect(s).toHaveLength(1);
    // Con `now()` al posto dell'ultimo tick, ogni durata si gonfierebbe della
    // grazia — due minuti su ogni sessione, per sempre.
    expect(((s[0] as Row)['ended_at'] as Date).getTime()).toBe(visto.getTime());
    expect(Number(s[0]?.['duration_s'])).toBe(60);
    expect(await rows('SELECT 1 FROM stats.session_open')).toHaveLength(0);
  });

  it('il reaper chiude chi nessuno vede piu`, e lo dichiara', async () => {
    const t = await tracker();
    const base = Date.now() - 3_600_000;
    await t.observe(db, new Date(base), online([{ id: 1, server: ARENA, connectionMs: base }]), idOf);
    const closed = await t.reap(db, new Date());
    expect(closed).toBe(1);

    // `end_reason` non e' decorazione: `v_session_observed` filtra su di lui,
    // perche' una durata media che include le sessioni non osservate per
    // intero e' una stima spacciata per misura.
    const s = await rows('SELECT end_reason FROM stats.session');
    expect(s[0]?.['end_reason']).toBe('reaper');
  });
});

describe('prova di proprieta` 3: rename, riconnessione, trasferimento', () => {
  it('il trasferimento fra server NON spezza la sessione', async () => {
    const t = await tracker();
    const base = Date.now();
    const conn = base - 120_000;
    await t.observe(db, new Date(base), online([{ id: 1, server: ARENA, connectionMs: conn }]), idOf);
    await t.observe(
      db,
      new Date(base + 30_000),
      online([{ id: 1, server: LOBBY, connectionMs: conn }]),
      idOf,
    );

    expect(await rows('SELECT 1 FROM stats.session')).toHaveLength(0);
    const open = await rows('SELECT legs, server_id_first, server_id_last FROM stats.session_open');
    expect(Number(open[0]?.['legs'])).toBe(2);
    expect(Number(open[0]?.['server_id_first'])).toBe(serverIds.get(ARENA));

    // E la presenza vale su ENTRAMBI: senza, gli unici della modalita' di
    // destinazione perderebbero chi ci e' arrivato da un'altra.
    const presence = await rows('SELECT server_id FROM stats.player_day_server ORDER BY server_id');
    expect(presence).toHaveLength(2);
  });

  it('la riconnessione INVECE la spezza, e il giorno conta due sessioni', async () => {
    const t = await tracker();
    const base = Date.now();
    await t.observe(
      db,
      new Date(base),
      online([{ id: 1, server: ARENA, connectionMs: base - 120_000 }]),
      idOf,
    );
    // Stesso giocatore, connection-time diverso: e' un login nuovo.
    await t.observe(
      db,
      new Date(base + 30_000),
      online([{ id: 1, server: ARENA, connectionMs: base + 20_000 }]),
      idOf,
    );

    expect(await rows('SELECT 1 FROM stats.session')).toHaveLength(1);
    expect(await rows('SELECT 1 FROM stats.session_open')).toHaveLength(1);
    const day = await rows('SELECT sessions FROM stats.player_day');
    expect(Number(day[0]?.['sessions'])).toBe(2);
  });

  it('un giocatore conta UNA volta negli unici, comunque si muova', async () => {
    const t = await tracker();
    const base = Date.now();
    await t.observe(
      db,
      new Date(base),
      online([{ id: 1, server: ARENA, connectionMs: base - 60_000 }]),
      idOf,
    );
    await t.observe(
      db,
      new Date(base + 30_000),
      online([{ id: 1, server: LOBBY, connectionMs: base - 60_000 }]),
      idOf,
    );
    await t.observe(
      db,
      new Date(base + 60_000),
      online([{ id: 1, server: ARENA, connectionMs: base + 55_000 }]),
      idOf,
    );

    const day = await rows('SELECT count(*)::int AS n FROM stats.player_day');
    expect(day[0]?.['n']).toBe(1);
  });
});

describe('prova di proprieta` 6: la sessione a cavallo della mezzanotte', () => {
  it('i secondi si affettano sui due giorni, la sessione si conta una volta sola', async () => {
    // Mezzanotte di Roma, non UTC: un processo con TZ=UTC affetterebbe due ore
    // piu' tardi e perderebbe sistematicamente la coda notturna.
    const bounds = await rows(
      `SELECT (stats.civil_day(now())::timestamp AT TIME ZONE 'Europe/Rome') - interval '20 minutes' AS prima,
              (stats.civil_day(now())::timestamp AT TIME ZONE 'Europe/Rome') + interval '20 minutes' AS dopo,
              stats.civil_day(now()) - 1 AS ieri, stats.civil_day(now()) AS oggi`,
    );
    const prima = bounds[0]?.['prima'] as Date;
    const dopo = bounds[0]?.['dopo'] as Date;

    const t = await tracker();
    const conn = prima.getTime();
    await t.observe(db, prima, online([{ id: 1, server: ARENA, connectionMs: conn }]), idOf);
    await t.observe(db, dopo, online([{ id: 1, server: ARENA, connectionMs: conn }]), idOf);
    // Sparisce: la sessione si chiude sull'ultima prova, cioe' dopo mezzanotte.
    for (let i = 1; i <= 4; i += 1) {
      await t.observe(db, new Date(dopo.getTime() + i * 30_000), new Map(), idOf);
    }

    const giorni = await rows(
      'SELECT day::text AS day, sessions, seconds_online FROM stats.player_day ORDER BY day',
    );
    expect(giorni).toHaveLength(2);

    // La sessione si conta UNA volta, sul giorno in cui e' iniziata.
    expect(giorni.reduce((n, r) => n + Number(r['sessions']), 0)).toBe(1);
    expect(Number(giorni[0]?.['sessions'])).toBe(1);
    expect(Number(giorni[1]?.['sessions'])).toBe(0);

    // I secondi si dividono: venti minuti prima, venti dopo.
    expect(Number(giorni[0]?.['seconds_online'])).toBe(1200);
    expect(Number(giorni[1]?.['seconds_online'])).toBe(1200);
  });
});

describe('la chiusura giornaliera scrive cio` che non e` additivo', () => {
  beforeEach(async () => {
    await sql.query(
      `INSERT INTO stats.mode (mode_key, display_name) VALUES ('duels','Duels'), ('lobby','Lobby')`,
    );
    for (const [key, server] of [
      ['duels', ARENA],
      ['lobby', LOBBY],
    ] as const) {
      await sql.query(
        `INSERT INTO stats.mode_alias (match_kind, match_value, mode_id)
         SELECT 'server', $1, mode_id FROM stats.mode WHERE mode_key = $2`,
        [server, key],
      );
    }
    // Una riga di rollup su cui la chiusura possa scrivere.
    await sql.query(
      `INSERT INTO stats.rollup_1d (day, server_id, samples, covered_s, expected_s, player_seconds, players_max)
       SELECT stats.civil_day(now()), v.server_id, 1, 60, stats.day_seconds(stats.civil_day(now())), 60, 1
         FROM stats.server v`,
    );
  });

  it('gli unici di rete sono un conteggio PROPRIO, non la somma delle modalita`', async () => {
    const t = await tracker();
    const base = Date.now();
    // Tre giocatori: uno solo in arena, uno solo in lobby, uno in entrambe.
    await t.observe(
      db,
      new Date(base),
      online([
        { id: 1, server: ARENA, connectionMs: base - 60_000 },
        { id: 2, server: LOBBY, connectionMs: base - 60_000 },
        { id: 3, server: ARENA, connectionMs: base - 60_000 },
      ]),
      idOf,
    );
    await t.observe(
      db,
      new Date(base + 30_000),
      online([
        { id: 1, server: ARENA, connectionMs: base - 60_000 },
        { id: 2, server: LOBBY, connectionMs: base - 60_000 },
        { id: 3, server: LOBBY, connectionMs: base - 60_000 },
      ]),
      idOf,
    );

    await dailyClose(db);

    const rete = await rows(
      'SELECT uniques, sessions FROM stats.rollup_1d WHERE server_id = 0 AND day = stats.civil_day(now())',
    );
    const perModalita = await rows(
      'SELECT mode_id, uniques FROM stats.mode_day_unique WHERE day = stats.civil_day(now()) ORDER BY mode_id',
    );

    const rete_n = Number(rete[0]?.['uniques']);
    const valori = perModalita.map((r) => Number(r['uniques']));
    expect(rete_n).toBe(3);
    expect(Number(rete[0]?.['sessions'])).toBe(3);

    // I6: fra il massimo e la somma. La somma qui fa 4 perche' il terzo
    // giocatore e' passato da entrambe: derivare gli unici di rete sommando
    // darebbe 4 persone dove ce ne sono 3.
    expect(rete_n).toBeGreaterThanOrEqual(Math.max(...valori));
    expect(rete_n).toBeLessThanOrEqual(valori.reduce((a, b) => a + b, 0));
    expect(valori.reduce((a, b) => a + b, 0)).toBe(4);
  });

  it('il giorno in corso non e` definitivo, e si riscrive', async () => {
    const t = await tracker();
    const base = Date.now();
    await t.observe(db, new Date(base), online([{ id: 1, server: ARENA, connectionMs: base }]), idOf);
    await dailyClose(db);
    let d = await rows('SELECT uniques, final FROM stats.rollup_1d WHERE server_id = 0');
    expect(Number(d[0]?.['uniques'])).toBe(1);
    // Sta ancora succedendo: dichiararlo definitivo congelerebbe un numero
    // che deve ancora salire.
    expect(d[0]?.['final']).toBe(false);

    await t.observe(
      db,
      new Date(base + 30_000),
      online([{ id: 2, server: ARENA, connectionMs: base + 25_000 }]),
      idOf,
    );
    await dailyClose(db);
    d = await rows('SELECT uniques FROM stats.rollup_1d WHERE server_id = 0');
    expect(Number(d[0]?.['uniques'])).toBe(2);
  });
});

describe('I10 — nessuna durata impossibile', () => {
  it('nessuna sessione negativa, e i motivi di chiusura sono dichiarati', async () => {
    const t = await tracker();
    const base = Date.now();
    await t.observe(
      db,
      new Date(base),
      online([{ id: 1, server: ARENA, connectionMs: base - 60_000 }]),
      idOf,
    );
    // Un connection-time nel futuro remoto: dato sporco, non un fuso.
    await t.observe(
      db,
      new Date(base + 30_000),
      online([{ id: 2, server: ARENA, connectionMs: base + 48 * 3_600_000 }]),
      idOf,
    );
    for (let i = 1; i <= 5; i += 1) {
      await t.observe(db, new Date(base + 60_000 + i * 30_000), new Map(), idOf);
    }

    const brutte = await rows('SELECT count(*)::int AS n FROM stats.session WHERE duration_s < 0');
    expect(brutte[0]?.['n']).toBe(0);
    // Lo scarto impossibile non diventa una sessione lunga due giorni: si
    // ripiega sul tick, che e' l'unico istante di cui abbiamo una prova.
    const lunghe = await rows('SELECT count(*)::int AS n FROM stats.session WHERE duration_s > 86400');
    expect(lunghe[0]?.['n']).toBe(0);
  });
});
