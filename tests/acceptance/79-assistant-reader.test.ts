// Le letture dell'assistente contro il database vero.
//
// PERCHE' ESISTE, con una precisione che vale la pena scrivere. I payload
// delle statistiche e dei duels vivono in cache COMPRESSI in brotli: le rotte
// li rispediscono cosi' come sono — decomprimere per far ricomprimere a valle
// sarebbe pagare due volte — quindi nessuna rotta li legge mai davvero.
//
// L'assistente invece li legge, ed e' il primo pezzo del pannello a farlo.
// Prendere `env.body` e darlo a `JSON.parse` sembra giusto guardandolo, non
// produce nessun errore di compilazione, e fallisce alla prima domanda vera
// con «Unexpected token» su un carattere qualunque.
//
// Con lo schema vuoto i numeri sono tutti nulli, e va benissimo: quello che si
// sta provando e' che il giro andata-e-ritorno arrivi a un oggetto.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AssistantData } from '#src/assistant/reader.ts';
import {
  readDuelsSummary,
  readNetworkCountries,
  readNetworkTrend,
  readOnlineNow,
} from '#src/assistant/reader.ts';
import { createKysely, createPool, type Database } from '#src/db/pool.ts';
import { PgDuelsProvider } from '#src/duels/pg.ts';
import { StatsCache } from '#src/stats/cache.ts';
import { connect, createTestDatabase, type TestDatabase } from '#tests/support/postgres.ts';
import { type RedisHarness, startRedis } from '#tests/support/redis.ts';

let db: TestDatabase;
let statsDb: Database;
let redis: RedisHarness;
let sql: import('pg').Client;
let data: AssistantData;

beforeAll(async () => {
  db = await createTestDatabase('assistant-reader');
  redis = await startRedis();
  statsDb = createKysely(
    createPool({
      connectionString: db.statsUrl,
      max: 4,
      applicationName: 'metamc-test-assistant-read',
      statementTimeout: '20s',
      searchPath: 'stats, public',
    }),
  );
  data = {
    panelDb: null,
    statsDb,
    duels: new PgDuelsProvider(statsDb),
    cache: new StatsCache({ redis: redis.client() }),
  };
}, 120_000);

afterAll(async () => {
  await sql?.end().catch(() => undefined);
  await statsDb?.destroy().catch(() => undefined);
  await redis?.stop();
  await db?.drop();
});

describe('i payload in cache si LEGGONO, non si rispediscono', () => {
  it('gli online arrivano come oggetto, non come byte compressi', async () => {
    const online = await readOnlineNow(data);
    // Schema vuoto: nessun ciclo di campionamento, quindi nessun numero vivo.
    // Cio' che conta e' che si sia arrivati fin qui.
    expect(online.live).toBeNull();
    // La definizione viaggia col numero: «online» qui non e' ovvio, ed e'
    // strutturalmente piu' alto del conteggio del proxy.
    expect(online.note).toContain('Redis di gioco');
  });

  it('e l`andamento pure', async () => {
    const trend = await readNetworkTrend(data, '24h', null);
    expect(trend.range).toBe('24h');
    expect(trend.mode).toBeNull();
    expect(trend.coverage).toBe(0);
    expect(Array.isArray(trend.topModes)).toBe(true);
  });

  it('e i duels', async () => {
    const duels = await readDuelsSummary(data, '7d', new Date('2026-08-23T12:00:00Z'));
    expect(duels.range).toBe('7d');
    expect(duels.matches).toBe(0);
    // La heatmap ha sempre 168 celle; con zero partite non ce n'e' nessuna da
    // nominare, e «le ore di punta» e' un elenco vuoto invece di tre zeri.
    expect(duels.busiest).toEqual([]);
  });

  it('la seconda lettura passa dalla cache e da` lo stesso oggetto', async () => {
    // La prima ha costruito e compresso; questa decomprime cio' che ha
    // scritto la prima. E' il giro in cui il difetto si manifesta.
    const uno = await readNetworkTrend(data, '24h', null);
    const due = await readNetworkTrend(data, '24h', null);
    expect(due).toEqual(uno);
  });
});

describe('la provenienza geografica: conta PERSONE, e i due segnaposto non sono paesi', () => {
  // IL BUCO CHE QUESTO TEST CHIUDE. I dati geografici erano nel payload da
  // mesi — la panoramica ci disegna la mappa — e nessuno dei tool
  // dell'assistente li esponeva. Chiedendole «quanti iracheni giocano»,
  // Svetlana non aveva nessuna strada per rispondere, e non era un permesso
  // mancante ne' una sorgente spenta: semplicemente non c'era la porta.
  // IL PERIODO E' IL 7g e non il 24h: le prove qui sopra hanno gia' riscaldato
  // la cache del 24h PRIMA del seed, e il payload in cache e' quello di allora.
  // Non e' un difetto della cache — e' cio' che deve fare — ma dentro un file
  // di test e' una trappola che costa mezz'ora la prima volta.
  beforeAll(async () => {
    sql = await connect(db.migrateUrl, 'metamc-test-reader-sql');
    const today = 'stats.civil_day(now())';
    await sql.query(
      `INSERT INTO stats.player_day (day, player_id, first_seen_at, last_seen_at, country)
       SELECT ${today}, g, now(), now(),
              CASE WHEN g <= 5 THEN 'IT' WHEN g <= 8 THEN 'IQ' WHEN g = 9 THEN 'XX' ELSE NULL END
         FROM generate_series(1, 10) g`,
    );
    // La spia della geolocalizzazione e' dell'INGESTIONE, non dei dati: dice
    // «la funzione sta girando adesso», non «ci sono paesi in tabella». Sono
    // due domande diverse, e la seconda si legge dall'elenco. Qui si accende
    // perche' la fixture rappresenti un'installazione con la geo attiva.
    await sql.query('UPDATE stats.ingest_state SET geo_enabled = true WHERE id = 1');
  });

  it('l`Iraq si conta, e i codici sono quelli ISO', async () => {
    const geo = await readNetworkCountries(data, '7d', null, 60);
    expect(geo.enabled).toBe(true);
    const byCc = Object.fromEntries(geo.countries.map((c) => [c.cc, c.players]));
    expect(byCc['IT']).toBe(5);
    expect(byCc['IQ']).toBe(3);
  });

  it('e i due segnaposto viaggiano dichiarati, non mescolati ai paesi', async () => {
    const geo = await readNetworkCountries(data, '7d', null, 60);
    // `XX` e' un indirizzo non risolto, `--` e' un giocatore visto quando la
    // geolocalizzazione era spenta. Riportarli come paesi sarebbe inventare
    // due nazioni; toglierli in silenzio farebbe un totale che non torna.
    expect(geo.legend).toEqual({ unresolved: 'XX', notCollected: '--' });
    expect(byCcOf(geo)['XX']).toBe(1);
    expect(byCcOf(geo)['--']).toBe(1);
    // Il totale li comprende: e' il denominatore vero delle percentuali.
    expect(geo.total).toBe(10);
  });

  it('il taglio non cambia il totale', async () => {
    // Un taglio che riduce anche il denominatore trasforma ogni percentuale
    // in una percentuale di qualcos'altro.
    const geo = await readNetworkCountries(data, '7d', null, 1);
    expect(geo.countries).toHaveLength(1);
    expect(geo.total).toBe(10);
    expect(geo.others).toEqual({ countries: 3, players: 5 });
  });
});

function byCcOf(geo: { countries: Array<{ cc: string; players: number }> }): Record<string, number> {
  return Object.fromEntries(geo.countries.map((c) => [c.cc, c.players]));
}

describe('senza le sorgenti, le letture lo dicono invece di rompersi', () => {
  const spento: () => AssistantData = () => ({
    panelDb: null,
    statsDb: null,
    duels: null,
    cache: new StatsCache({ redis: redis.client() }),
  });

  it('gli online', async () => {
    await expect(readOnlineNow(spento())).rejects.toMatchObject({ what: 'statistiche' });
  });

  it('i duels', async () => {
    await expect(readDuelsSummary(spento(), '7d', new Date())).rejects.toMatchObject({
      what: 'duels',
    });
  });
});
