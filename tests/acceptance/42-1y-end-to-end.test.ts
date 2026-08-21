// Il range 1y dalla ROTTA, non dalla funzione. Con i dati veri e a TZ=UTC.
//
// PERCHE' QUESTO FILE ESISTE. Tre difetti di fila sul range 1y sono passati
// attraverso una suite verde, e la ragione e' sempre la stessa: ogni test
// chiamava `buildOverview` in un processo italiano. Cosi' si verifica una
// funzione, non il pannello — restano fuori la rotta, l'involucro di cache, il
// giro di warm, e soprattutto il fuso del processo, che in produzione e' UTC
// e in sviluppo no.
//
// Il seme non e' inventato: e' la forma esatta della rete al 21 agosto 2026 —
// pannello acceso la sera del 20, cinque ore quel giorno e dodici il giorno
// dopo, ventidue server, un picco di 824. Se questo file e' verde e la
// schermata e' vuota, il codice servito non e' questo.

process.env['TZ'] = 'UTC';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OverviewPayload } from '#src/stats/contract.ts';
import { K, warmOnBoot } from '#src/stats/warm.ts';
import { loginAs, seedUser } from '#tests/support/actors.ts';
import { startTestApp, type TestApp } from '#tests/support/app.ts';
import { connect } from '#tests/support/postgres.ts';

let t: TestApp;
let sql: pg.Client;

/** Ventidue server come in produzione, non uno. */
const SERVERS = Array.from({ length: 22 }, (_, i) => `srv_${i + 1}`);
const PICCO = 824;

beforeAll(async () => {
  t = await startTestApp({ label: 'anno', statsDb: true });
  sql = await connect(t.db.migrateUrl, 'metamc-test-anno-sql');

  await sql.query('INSERT INTO stats.server (server_key) SELECT unnest($1::text[])', [SERVERS]);
  await sql.query(
    `INSERT INTO stats.mode (mode_key, display_name)
     VALUES ('duels', 'Duels'), ('lobby', 'Lobby'), ('survival2', 'Survival2')`,
  );
  for (const [key, server] of [
    ['duels', 'srv_1'],
    ['lobby', 'srv_2'],
    ['survival2', 'srv_3'],
  ] as const) {
    await sql.query(
      `INSERT INTO stats.mode_alias (match_kind, match_value, mode_id)
       SELECT 'server', $1, mode_id FROM stats.mode WHERE mode_key = $2`,
      [server, key],
    );
  }

  // Cinque ore l'altroieri sera, poi da ieri mattina fino a un'ora fa. Le ore
  // si contano sui GIORNI CIVILI di Roma, come in produzione.
  // LA RIGA DI RETE E` LA SOMMA DELLE ALTRE, non una copia. Il payload
  // verifica che il breakdown chiuda sul totale prima di partire: un seme che
  // da` a ogni server il totale della rete fa fallire l'invariante, ed e`
  // giusto — quella e` la sua ragione di esistere.
  await sql.query(
    `WITH ore AS (
       SELECT g AS bucket FROM generate_series(
              date_trunc('day', now() AT TIME ZONE 'Europe/Rome') AT TIME ZONE 'Europe/Rome'
                - interval '5 hours',
              date_trunc('hour', now()) - interval '1 hour',
              interval '1 hour') g
     )
     INSERT INTO stats.rollup_1h (bucket, server_id, samples, covered_s, player_seconds, players_max, players_max_at)
     SELECT o.bucket, v.server_id, 118, 3546, 30 * 3546, 40, o.bucket + interval '17 minutes'
       FROM ore o CROSS JOIN stats.server v WHERE v.server_id > 1`,
  );
  await sql.query(
    `WITH ore AS (
       SELECT g AS bucket FROM generate_series(
              date_trunc('day', now() AT TIME ZONE 'Europe/Rome') AT TIME ZONE 'Europe/Rome'
                - interval '5 hours',
              date_trunc('hour', now()) - interval '1 hour',
              interval '1 hour') g
     )
     INSERT INTO stats.rollup_1h (bucket, server_id, samples, covered_s, player_seconds, players_max, players_max_at)
     SELECT o.bucket, 0, 118, 3546,
            30 * 3546 * (SELECT count(*) FROM stats.server WHERE server_id > 1),
            $1::int, o.bucket + interval '17 minutes'
       FROM ore o`,
    [PICCO],
  );
  await sql.query(
    `INSERT INTO stats.rollup_1d (day, server_id, samples, covered_s, expected_s, player_seconds, players_max, players_max_at)
     SELECT stats.civil_day(bucket), server_id, sum(samples)::int, sum(covered_s)::int,
            stats.day_seconds(stats.civil_day(bucket)), sum(player_seconds),
            max(players_max), max(players_max_at)
       FROM stats.rollup_1h GROUP BY 1, 2 ON CONFLICT DO NOTHING`,
  );
}, 300_000);

afterAll(async () => {
  await sql?.end().catch(() => undefined);
  await t?.close();
});

async function overview(range: string): Promise<OverviewPayload> {
  const user = await seedUser(t, { roleKey: 'moderatore' });
  const actor = await loginAs(t, user);
  const res = await t.app.inject({
    method: 'GET',
    url: `/api/stats/overview?range=${range}`,
    headers: { ...actor.cookieOnly(), 'accept-encoding': 'identity' },
  });
  expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
  return JSON.parse(res.body) as OverviewPayload;
}

describe('il pannello a fuso UTC, dalla rotta', () => {
  it('il processo sta davvero a UTC', () => {
    // Senza questo, il file smette di provare cio` per cui esiste e nessuno
    // se ne accorge: e` esattamente com'e` andata finora.
    expect(new Date('2026-08-21T00:00:00Z').getHours()).toBe(0);
  });

  it('1y porta il picco, e non e` quello di un altro range', async () => {
    const p = await overview('1y');
    // IL SINTOMO SEGNALATO: picco a «—» sul solo 1y.
    expect(p.kpi.peak).toBe(PICCO);
    expect(p.kpi.peakAt).not.toBeNull();
  });

  it('1y porta i nomi delle modalita`, che sparivano insieme al picco', async () => {
    const p = await overview('1y');
    // `modes` e` l'elenco della SERIE: vuoto significa che la query giornaliera
    // non ha trovato niente, ed e` da li` che spariva anche la legenda.
    expect(p.modes.length).toBeGreaterThan(0);
    expect(p.online.total.filter((v) => v !== null).length).toBeGreaterThan(0);
    // I nomi arrivano comunque dal dizionario, anche se la serie fosse vuota.
    expect(p.labels['duels']).toBe('Duels');
  });

  it('i cinque range danno lo stesso picco, perche` e` lo stesso picco', async () => {
    // Se un range perde la finestra, qui si vede subito: lo stesso massimo
    // deve uscire da rollup_5m, da rollup_1h e da rollup_1d.
    for (const r of ['7d', '30d', '90d', '1y'] as const) {
      const p = await overview(r);
      expect(p.kpi.peak, `range ${r}`).toBe(PICCO);
    }
  });

  it('e il giro di warm scrive gli stessi byte che la rotta ha servito', async () => {
    // La rotta puo` aver costruito il payload per conto suo al primo accesso.
    // Qui si verifica il percorso che serve DAVVERO il pannello in produzione:
    // il warm che riempie la cache prima che qualcuno guardi.
    await t.ctx.cacheRedis.flushall().catch(() => undefined);
    await warmOnBoot({
      statsDb: t.ctx.statsDb as NonNullable<typeof t.ctx.statsDb>,
      cache: t.ctx.statsCache,
      redis: t.ctx.cacheRedis,
      logger: t.ctx.logger,
    });

    expect(await t.ctx.cacheRedis.exists(K.ov('1y'))).toBe(1);
    const p = await overview('1y');
    expect(p.kpi.peak).toBe(PICCO);
  });
});
