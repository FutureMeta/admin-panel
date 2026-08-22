// La cache dei duels: chi scrive i payload, quando, e quando NON li riscrive.
//
// IL TERZO LIVELLO. Il primo e' la pre-aggregazione (le schermate non toccano
// una riga di partita), il secondo e' il confine fra il giorno vivo e quelli
// chiusi, il terzo e' il payload gia' pronto su Valkey. Qui si prova il terzo,
// e soprattutto la regola che lo governa.
//
// LA REGOLA E' «SOLO SE QUALCOSA E' CAMBIATO». `builtAt` sta dentro il
// payload, quindi ricostruirne uno identico ne cambia i byte, quindi ne cambia
// l'ETag, quindi ogni schermata aperta riscarica tutto invece di ricevere un
// 304. In una notte senza partite il ciclo gira millesettecentoventi volte:
// ricostruire ogni volta vorrebbe dire millesettecentoventi payload nuovi per
// zero informazioni nuove. Il test sotto pretende che il secondo giro a vuoto
// non tocchi niente.
//
// E NON C'E' UN TIMER «duels-warm». La fetta viva la scrive lo stesso ciclo
// che ingerisce; i quattro periodi chiusi salgono sul giro di warm che
// esisteva gia'. Tre sveglie che si incrociano vorrebbero dire un payload a
// volte piu' vecchio dell'ultima ingestione, senza che nessuno sappia di
// quanto.

import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DK, duelsQuality } from '#src/duels/contract.ts';
import { startDuelsIngest } from '#src/duels/keeper.ts';
import { type DuelsWarmDeps, markDuelsHot, warmDuelsAllClosed, warmDuelsLive } from '#src/duels/warm.ts';
import { decode } from '#src/stats/cache.ts';
import { loginAs, seedUser } from '#tests/support/actors.ts';
import { startTestApp, type TestApp } from '#tests/support/app.ts';
import { fakeDuelsMysql } from '#tests/support/duels-mysql.ts';
import { connect } from '#tests/support/postgres.ts';

let t: TestApp;
let sql: pg.Client;
let warm: DuelsWarmDeps;

beforeAll(async () => {
  t = await startTestApp({ label: 'duelsch', statsDb: true });
  sql = await connect(t.db.migrateUrl, 'metamc-test-duelsch-sql');
  const provider = t.ctx.duels;
  if (!provider) throw new Error('il provider duels dovrebbe esserci con statsDb');
  warm = { provider, cache: t.ctx.statsCache, redis: t.ctx.cacheRedis, logger: t.ctx.logger };
}, 300_000);

afterAll(async () => {
  await sql?.end().catch(() => undefined);
  await t?.close();
});

beforeEach(async () => {
  await sql.query(`
    DELETE FROM stats.duels_rating_day; DELETE FROM stats.duels_rating;
    DELETE FROM stats.duels_match_hour; DELETE FROM stats.duels_mode;
    UPDATE stats.duels_ingest_state SET last_id = 0, since_day = NULL, degraded = 0;`);
  // Le chiavi di ieri non devono sopravvivere a un test: il giorno civile e`
  // dentro la chiave, ma dentro una suite il giorno non cambia.
  for (const key of await t.ctx.cacheRedis.keys('duels:*')) {
    await t.ctx.cacheRedis.del(key);
  }
});

/** Un istante recente, nella forma in cui il MySQL lo restituisce. */
function pocoFa(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString().slice(0, 19).replace('T', ' ');
}

async function etagOf(key: string): Promise<string | null> {
  const raw = await t.ctx.cacheRedis.getBuffer(key);
  return decode(raw)?.etag ?? null;
}

async function seedMatches(n: number) {
  await sql.query(
    `INSERT INTO stats.duels_mode (mode_id, name, display_name, ranking, mode_type)
     VALUES (1, 'classic', 'Classic', 'RANKED', 'DUEL') ON CONFLICT DO NOTHING`,
  );
  await sql.query(
    `INSERT INTO stats.duels_match_hour (bucket_at, mode_id, map_id, match_type, context, matches)
     VALUES (date_trunc('hour', now()), 1, 10, 'DUEL', 'NORMAL', $1)
     ON CONFLICT (bucket_at, mode_id, map_id, match_type, context)
       DO UPDATE SET matches = stats.duels_match_hour.matches + EXCLUDED.matches`,
    [n],
  );
}

describe('la fetta viva la scrive chi ingerisce', () => {
  it('dopo il riscaldamento la chiave del 24h esiste', async () => {
    await seedMatches(5);
    const res = await warmDuelsLive(warm);

    expect(res.payloads).toBe(2);
    expect(await etagOf(DK.tr('24h'))).toBeTruthy();
    expect(await etagOf(DK.rt(null, '24h'))).toBeTruthy();
  });

  it('e la rotta la serve SENZA ricostruirla', async () => {
    // La prova che i byte vengono dalla cache e non da una ricostruzione: si
    // scalda, si svuota il database, e si chiede. Se la rotta ricostruisse,
    // risponderebbe zero partite.
    await seedMatches(9);
    await warmDuelsLive(warm);
    await sql.query(`DELETE FROM stats.duels_match_hour`);

    const seeded = await seedUser(t, { roleKey: 'moderatore' });
    const actor = await loginAs(t, seeded);
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/duels/trends?range=24h',
      headers: { ...actor.cookieOnly(), 'accept-encoding': 'identity' },
    });

    expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
    expect(JSON.parse(res.body).totals.matches).toBe(9);
  });

  it('il ciclo di ingestione scalda da solo, senza un timer suo', async () => {
    const ingest = await startDuelsIngest({
      databaseUrl: t.db.ingestUrl,
      mysqlUrl: 'mysql://non-usato',
      mysql: fakeDuelsMysql({
        modes: [{ id: 1, name: 'classic', display_name: 'Classic', ranking: 'RANKED', type: 'DUEL' }],
        matches: [{ id: 1, created_at: pocoFa(10), type: 'DUEL', context: 'NORMAL', mode_id: 1, map_id: 10 }],
      }),
      logger: t.ctx.logger,
      registry: t.ctx.maintenance.registry,
      schedule: false,
      warm,
    });

    try {
      const out = await ingest.runOnce();
      expect(out.partite).toBe(1);
      expect(out.scaldati, 'ha ingerito, quindi ha ricostruito').toBe(2);
      expect(await etagOf(DK.tr('24h'))).toBeTruthy();
    } finally {
      await ingest.stop();
    }
  });

  it('un giro A VUOTO non ricostruisce niente, e l`ETag non si muove', async () => {
    // E` la guardia che tiene in piedi il 304. Senza, ogni schermata aperta
    // riscaricherebbe il payload intero ogni trenta secondi per informazioni
    // identiche.
    const ingest = await startDuelsIngest({
      databaseUrl: t.db.ingestUrl,
      mysqlUrl: 'mysql://non-usato',
      mysql: fakeDuelsMysql({
        modes: [{ id: 1, name: 'classic', display_name: 'Classic', ranking: 'RANKED', type: 'DUEL' }],
        matches: [{ id: 1, created_at: pocoFa(10), type: 'DUEL', context: 'NORMAL', mode_id: 1, map_id: 10 }],
      }),
      logger: t.ctx.logger,
      registry: t.ctx.maintenance.registry,
      schedule: false,
      warm,
    });

    try {
      await ingest.runOnce();
      const primo = await etagOf(DK.tr('24h'));

      const secondo = await ingest.runOnce();
      expect(secondo.partite, 'niente di nuovo alla sorgente').toBe(0);
      expect(secondo.scaldati, 'quindi niente da ricostruire').toBe(0);
      expect(await etagOf(DK.tr('24h')), 'gli stessi byte di prima').toBe(primo);
    } finally {
      await ingest.stop();
    }
  });
});

describe('i periodi chiusi stanno sul giro che esisteva gia`', () => {
  it('si scaldano tutti e quattro, e il 24h non e` fra loro', async () => {
    await seedMatches(3);
    // 2 payload per periodo (tendenze e valutazioni globali) x 4 periodi.
    expect(await warmDuelsAllClosed(warm)).toBe(8);

    for (const range of ['7d', '30d', '90d', '1y'] as const) {
      expect(await etagOf(DK.tr(range)), range).toBeTruthy();
    }
    expect(await etagOf(DK.tr('24h')), 'la fetta viva non e` di questo giro').toBeNull();
  });
});

describe('solo le modalita` guardate entrano nel giro', () => {
  it('una modalita` mai aperta non si costruisce', async () => {
    await seedMatches(3);
    await warmDuelsLive(warm);
    expect(await etagOf(DK.rt(1, '24h'))).toBeNull();
  });

  it('una modalita` aperta di recente si', async () => {
    await seedMatches(3);
    markDuelsHot(t.ctx.cacheRedis, '24h', 1);
    const res = await warmDuelsLive(warm);

    expect(res.payloads).toBe(3);
    expect(await etagOf(DK.rt(1, '24h'))).toBeTruthy();
  });

  it('con il budget a zero si RIMANDA invece di far scivolare il ciclo', async () => {
    // Rimandare costa un'aggregazione alla prossima richiesta di quella
    // modalita`; non rimandare costa il ritardo dell'intero ciclo da trenta
    // secondi, che e` la cosa su cui si appoggia tutto il resto.
    await seedMatches(3);
    markDuelsHot(t.ctx.cacheRedis, '24h', 1);
    const res = await warmDuelsLive({ ...warm, budgetMs: -1 });

    expect(res.deferred).toBe(1);
    expect(res.payloads, 'i due globali si fanno comunque').toBe(2);
    expect(await etagOf(DK.rt(1, '24h'))).toBeNull();
  });
});

describe('la qualita` di compressione la decide il periodo, non chi scrive', () => {
  it('la fetta viva e i periodi chiusi non si comprimono allo stesso modo', async () => {
    // Era deciso in TRE posti che si contraddicevano: la rotta scriveva q11
    // per ogni chiave, il giro della fetta viva q5, e quello dei periodi
    // chiusi q11 per le chiavi globali ma q5 per le modalita` calde —
    // smentendo il proprio commento. La stessa chiave finiva in cache con
    // qualita` diverse a seconda di chi l'aveva scritta per ultimo.
    expect(duelsQuality('24h')).toBe(5);
    for (const range of ['7d', '30d', '90d', '1y'] as const) {
      expect(duelsQuality(range), range).toBe(11);
    }
  });
});
