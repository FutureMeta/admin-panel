// Passo 5 — il giro di warm e le due rotte. §7.3, §7.4, §6.2.
//
// IL CANCELLO DEL PASSO E' QUI: `singleflight_joined` diverso da zero dopo che
// una chiave fredda e' stata colpita in parallelo, e l'eta' della chiave sotto
// controllo. Il resto della suite verifica le cose che, se sbagliate, non
// danno sintomi:
//
//   * l'hot-set e' UNO PER RANGE. Con uno solo globale, una dashboard aperta
//     sul 24h occuperebbe stabilmente i primi venti posti e i payload per
//     modalita' dei range lunghi non verrebbero scaldati mai;
//   * il payload per modalita' NON porta un picco, perche' il massimo non si
//     decompone. Un limite inferiore etichettato «picco» e' una bugia
//     plausibile;
//   * due ruoli diversi ricevono BYTE IDENTICI (I13). E' il prezzo della
//     deroga del §9: se un giorno il payload variasse per ruolo, questo test
//     fallisce prima della fuga.

import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { StatsCache } from '#src/stats/cache.ts';
import type { ModePayload, OverviewPayload } from '#src/stats/contract.ts';
import { K, markHot, warmOnBoot, warmRange } from '#src/stats/warm.ts';
import { loginAs, seedUser } from '#tests/support/actors.ts';
import { startTestApp, type TestApp } from '#tests/support/app.ts';
import { connect } from '#tests/support/postgres.ts';

let t: TestApp;
let sql: pg.Client;

const ARENA = 'duels_1';
const EVENTO = 'evento_1';

/** Le dipendenze del giro, prese dal contesto vero e non da un finto. */
function deps() {
  const statsDb = t.ctx.statsDb;
  if (!statsDb) throw new Error('il pool di lettura non e` configurato');
  return { statsDb, cache: t.ctx.statsCache, redis: t.ctx.cacheRedis, logger: t.ctx.logger };
}

beforeAll(async () => {
  t = await startTestApp({ label: 'warm', statsDb: true });
  sql = await connect(t.db.migrateUrl, 'metamc-test-warm-sql');
}, 180_000);

afterAll(async () => {
  await sql?.end().catch(() => undefined);
  await t?.close();
});

beforeEach(async () => {
  await sql.query(`
    DELETE FROM stats.rollup_1d; DELETE FROM stats.rollup_1h; DELETE FROM stats.rollup_5m;
    DELETE FROM stats.mode_alias; DELETE FROM stats.mode;
    DELETE FROM stats.server WHERE server_id > 1;`);
  await t.ctx.cacheRedis.flushall().catch(() => undefined);

  await sql.query('INSERT INTO stats.server (server_key) VALUES ($1), ($2)', [ARENA, EVENTO]);
  await sql.query(
    `INSERT INTO stats.mode (mode_key, display_name) VALUES ('arena', 'Arena'), ('eventi', 'Eventi')`,
  );
  for (const [key, server] of [
    ['arena', ARENA],
    ['eventi', EVENTO],
  ] as const) {
    await sql.query(
      `INSERT INTO stats.mode_alias (match_kind, match_value, mode_id)
       SELECT 'server', $1, mode_id FROM stats.mode WHERE mode_key = $2`,
      [server, key],
    );
  }

  // Dieci giorni orari: l'arena c'e' sempre con 150, l'evento solo a
  // mezzogiorno con 200. Dove non c'era nessuno non si scrive la riga.
  await sql.query(
    `WITH h AS (
       SELECT g AS bucket, extract(hour FROM g AT TIME ZONE 'Europe/Rome')::int AS ora
         FROM generate_series(date_trunc('hour', now()) - interval '10 days',
                              date_trunc('hour', now()) - interval '1 hour',
                              interval '1 hour') g
     )
     INSERT INTO stats.rollup_1h
       (bucket, server_id, samples, covered_s, player_seconds, players_max, players_max_at)
     SELECT h.bucket, v.server_id, 120, 3600,
            CASE v.server_id
              WHEN 0 THEN (150 + CASE WHEN h.ora = 12 THEN 200 ELSE 0 END) * 3600
              ELSE CASE WHEN v.server_key = $1 THEN 150 * 3600
                        ELSE CASE WHEN h.ora = 12 THEN 200 * 3600 ELSE 0 END END
            END,
            CASE v.server_id
              WHEN 0 THEN 150 + CASE WHEN h.ora = 12 THEN 200 ELSE 0 END
              ELSE CASE WHEN v.server_key = $1 THEN 150 ELSE CASE WHEN h.ora = 12 THEN 200 ELSE 0 END END
            END,
            h.bucket
       FROM h CROSS JOIN stats.server v
      WHERE v.server_id = 0 OR v.server_key IN ($1, $2)
        AND NOT (v.server_key = $2 AND h.ora <> 12)`,
    [ARENA, EVENTO],
  );
  await sql.query(
    `INSERT INTO stats.rollup_1d
       (day, server_id, samples, covered_s, expected_s, player_seconds, players_max, players_max_at)
     SELECT stats.civil_day(bucket), server_id, sum(samples)::int, sum(covered_s)::int,
            stats.day_seconds(stats.civil_day(bucket)), sum(player_seconds),
            max(players_max), max(players_max_at)
       FROM stats.rollup_1h GROUP BY 1, 2
     ON CONFLICT DO NOTHING`,
  );
});

describe('il giro di warm', () => {
  it('scalda la panoramica, e la richiesta successiva non ricostruisce', async () => {
    const result = await warmRange(deps(), '7d');
    expect(result.payloads).toBe(1); // nessuna modalita` ancora guardata
    expect(await t.ctx.cacheRedis.exists(K.ov('7d'))).toBe(1);

    const before = t.ctx.statsCache.metrics.misses;
    const user = await seedUser(t, { roleKey: 'moderatore' });
    const actor = await loginAs(t, user);
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/stats/overview?range=7d',
      headers: actor.cookieOnly(),
    });

    expect(res.statusCode).toBe(200);
    // Nessun miss in piu': i byte c'erano gia`.
    expect(t.ctx.statsCache.metrics.misses).toBe(before);
    expect(t.ctx.statsCache.metrics.hits).toBeGreaterThan(0);
  });

  it("l'hot-set e` per range: guardare una modalita` nel 7g non la scalda nel 30g", async () => {
    markHot(t.ctx.cacheRedis, '7d', 'arena');
    // `markHot` non e` atteso di proposito: chi legge non deve aspettare una
    // scrittura di servizio. Qui pero` il test deve vederla atterrata.
    await t.ctx.cacheRedis.zadd(K.hot('7d'), Date.now(), 'arena');

    await warmRange(deps(), '7d');
    await warmRange(deps(), '30d');

    // I due range leggono gli stessi dati: l'unica differenza e` l'hot-set.
    expect(await t.ctx.cacheRedis.exists(K.md('arena', '7d'))).toBe(1);
    // Se l'hot-set fosse globale, anche questa varrebbe 1, e i range lunghi
    // verrebbero scaldati da chi ha guardato tutt'altro.
    expect(await t.ctx.cacheRedis.exists(K.md('arena', '30d'))).toBe(0);
  });

  it('sotto pressione le modalita` si rimandano, la panoramica no', async () => {
    await t.ctx.cacheRedis.zadd(K.hot('7d'), Date.now(), 'arena');
    await t.ctx.cacheRedis.zadd(K.hot('7d'), Date.now(), 'eventi');

    const strained = new StatsCache({ redis: t.ctx.cacheRedis, pressure: () => true });
    const result = await warmRange({ ...deps(), cache: strained }, '7d');

    // La panoramica si costruisce comunque: e` la schermata che qualcuno
    // aprira` davvero per prima.
    expect(result.payloads).toBe(1);
    expect(result.deferred).toBe(2);
    expect(await t.ctx.cacheRedis.exists(K.md('arena', '7d'))).toBe(0);
  });

  it('warmOnBoot riempie tutti e cinque i range', async () => {
    await warmOnBoot(deps());
    for (const range of ['24h', '7d', '30d', '90d', '1y'] as const) {
      expect(await t.ctx.cacheRedis.exists(K.ov(range)), `range ${range}`).toBe(1);
    }
    // Cinque chiavi, cinque eta` sorvegliate.
    expect(t.ctx.statsCache.ages().length).toBeGreaterThanOrEqual(5);
  });

  it('il cancello: venti richieste su una chiave fredda costruiscono UNA volta', async () => {
    const user = await seedUser(t, { roleKey: 'moderatore' });
    const actor = await loginAs(t, user);
    const before = t.ctx.statsCache.metrics.singleflightJoined;

    const all = await Promise.all(
      Array.from({ length: 20 }, () =>
        t.app.inject({
          method: 'GET',
          url: '/api/stats/overview?range=30d',
          headers: actor.cookieOnly(),
        }),
      ),
    );

    for (const res of all) expect(res.statusCode).toBe(200);
    // Sempre zero significherebbe che il percorso pigro non e` mai stato
    // esercitato, cioe` che nessuno lo ha verificato.
    expect(t.ctx.statsCache.metrics.singleflightJoined).toBeGreaterThan(before);
    const etags = new Set(all.map((r) => r.headers.etag));
    expect(etags.size).toBe(1);
  });
});

describe('le due rotte', () => {
  it('un ETag ripresentato vale un 304, e il payload non riparte', async () => {
    const user = await seedUser(t, { roleKey: 'moderatore' });
    const actor = await loginAs(t, user);

    const first = await t.app.inject({
      method: 'GET',
      url: '/api/stats/overview?range=7d',
      headers: actor.cookieOnly(),
    });
    expect(first.statusCode).toBe(200);
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^"[0-9a-f]{24}"$/);

    const second = await t.app.inject({
      method: 'GET',
      url: '/api/stats/overview?range=7d',
      headers: { ...actor.cookieOnly(), 'if-none-match': etag },
    });
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe('');
  });

  it('chi dichiara br riceve i byte come stanno in cache', async () => {
    const user = await seedUser(t, { roleKey: 'moderatore' });
    const actor = await loginAs(t, user);

    const res = await t.app.inject({
      method: 'GET',
      url: '/api/stats/overview?range=7d',
      headers: { ...actor.cookieOnly(), 'accept-encoding': 'gzip, deflate, br' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBe('br');
    const { brotliDecompressSync } = await import('node:zlib');
    const payload = JSON.parse(brotliDecompressSync(res.rawPayload).toString('utf8')) as OverviewPayload;
    expect(payload.v).toBe(2);
    expect(payload.modes).toContain('arena');
  });

  it('chi non dichiara br riceve JSON leggibile, non byte compressi', async () => {
    const user = await seedUser(t, { roleKey: 'moderatore' });
    const actor = await loginAs(t, user);

    const res = await t.app.inject({
      method: 'GET',
      url: '/api/stats/overview?range=7d',
      headers: { ...actor.cookieOnly(), 'accept-encoding': 'identity' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect((res.json() as OverviewPayload).v).toBe(2);
  });

  it('una modalita` che non esiste e` un 404, mai un payload vuoto', async () => {
    const user = await seedUser(t, { roleKey: 'moderatore' });
    const actor = await loginAs(t, user);

    const res = await t.app.inject({
      method: 'GET',
      url: '/api/stats/mode?mode=inventata&range=7d',
      headers: actor.cookieOnly(),
    });

    // Un payload vuoto l'interfaccia lo disegnerebbe come «zero giocatori»:
    // una bugia al posto di un errore.
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('modalita') });
  });

  it('il payload di una modalita` porta una serie sola e NESSUN picco', async () => {
    const user = await seedUser(t, { roleKey: 'moderatore' });
    const actor = await loginAs(t, user);

    const res = await t.app.inject({
      method: 'GET',
      url: '/api/stats/mode?mode=arena&range=7d',
      headers: { ...actor.cookieOnly(), 'accept-encoding': 'identity' },
    });

    expect(res.statusCode).toBe(200);
    const payload = res.json() as ModePayload;
    expect(payload.mode).toBe('arena');
    expect(payload.modes).toEqual(['arena']);
    expect(Object.keys(payload.online.series)).toEqual(['arena']);

    // IL PICCO NON C'E', e non e` una funzione mancante: `players_max` e`
    // memorizzato per server e il massimo di una somma non si ricostruisce da
    // massimi presi separatamente. Un limite inferiore chiamato «picco»
    // sarebbe una bugia plausibile.
    expect(payload.online.peak.every((v) => v === null)).toBe(true);
    expect(payload.kpi.peak).toBeNull();
    expect(payload.kpiPrev.peak).toBeNull();

    // La media invece c'e` ed e` quella dell'arena, non quella di rete.
    expect(payload.kpi.avg).toBeCloseTo(150, 0);
  });

  it('la modalita` guardata finisce nell`hot-set del suo range', async () => {
    const user = await seedUser(t, { roleKey: 'moderatore' });
    const actor = await loginAs(t, user);

    await t.app.inject({
      method: 'GET',
      url: '/api/stats/mode?mode=eventi&range=30d',
      headers: actor.cookieOnly(),
    });

    // Si scalda cio` che qualcuno ha GUARDATO, non «le tre con piu` giocatori».
    const hot = await t.ctx.cacheRedis.zrevrange(K.hot('30d'), 0, 19);
    expect(hot).toContain('eventi');
    expect(await t.ctx.cacheRedis.zrevrange(K.hot('7d'), 0, 19)).not.toContain('eventi');
  });

  it('I13 — due ruoli diversi ricevono byte IDENTICI', async () => {
    const mod = await loginAs(t, await seedUser(t, { roleKey: 'moderatore' }));
    const admin = await loginAs(t, await seedUser(t, { roleKey: 'admin' }));

    const get = (actor: typeof mod) =>
      t.app.inject({
        method: 'GET',
        url: '/api/stats/overview?range=7d',
        headers: { ...actor.cookieOnly(), 'accept-encoding': 'br' },
      });

    const a = await get(mod);
    const b = await get(admin);

    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    // E` il prezzo della deroga del §9: una chiave di cache per ruolo
    // moltiplicherebbe lo spazio delle chiavi per il numero dei ruoli. Se un
    // giorno il payload dovesse variare per ruolo, si scopre QUI.
    expect(a.headers.etag).toBe(b.headers.etag);
    expect(b.rawPayload.equals(a.rawPayload)).toBe(true);
  });
});
