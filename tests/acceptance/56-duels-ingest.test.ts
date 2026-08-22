// Il job di ingestione dei duels.
//
// IL MYSQL E' FINTO, IL POSTGRES E' VERO. `DuelsMysql` e' una funzione sola —
// `rows(sql, params)` — quindi sostituirla costa niente, e in cambio si
// esercita per intero l'SQL che conta: gli upsert additivi, il watermark che
// vive nella stessa transazione dei conteggi, il ricalcolo dell'aggregato
// giornaliero. Puntare i test al MySQL di produzione sarebbe vietato e
// inutile: quello che puo' rompersi sta da questa parte.
//
// COSA SI ROMPE IN SILENZIO QUI. Un lotto riletto due volte raddoppia i
// conteggi, perche' l'upsert delle partite e' ADDITIVO: e' l'unico modo in cui
// questo job puo' produrre numeri falsi senza fallire. Il watermark scritto
// nella stessa transazione lo impedisce, e sotto c'e' un test che riesegue lo
// stesso lotto e pretende che il totale non si muova.

import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createKysely, createPool, type Database } from '#src/db/pool.ts';
import { runDuelsIngest } from '#src/duels/ingest.ts';
import type { DuelsMysql } from '#src/duels/mysql.ts';
import { connect, createTestDatabase, type TestDatabase } from '#tests/support/postgres.ts';

let testDb: TestDatabase;
let pool: pg.Pool;
let db: Database;
let sql: pg.Client;

beforeAll(async () => {
  testDb = await createTestDatabase('duelsetl');
  pool = createPool({
    connectionString: testDb.ingestUrl,
    max: 4,
    applicationName: 'metamc-test-duelsetl',
    connectionTimeoutMillis: 20_000,
    statementTimeout: '60s',
    searchPath: 'stats, public',
  });
  db = createKysely(pool);
  sql = await connect(testDb.migrateUrl, 'metamc-test-duelsetl-sql');
}, 180_000);

afterAll(async () => {
  await sql?.end().catch(() => undefined);
  await db?.destroy().catch(() => undefined);
  await testDb?.drop();
});

beforeEach(async () => {
  await sql.query(`
    DELETE FROM stats.duels_rating_day; DELETE FROM stats.duels_rating;
    DELETE FROM stats.duels_match_hour;
    DELETE FROM stats.duels_mode; DELETE FROM stats.duels_map;
    UPDATE stats.duels_ingest_state SET last_id = 0, since_day = NULL, degraded = 0;`);
});

/** Il MySQL finto: risponde in base alla tabella nominata dalla query. */
function fakeMysql(source: {
  modes?: unknown[];
  maps?: unknown[];
  matches?: unknown[];
  ratings?: unknown[];
}): DuelsMysql {
  return {
    rows: async <T>(query: string, params: unknown[] = []): Promise<T[]> => {
      if (query.includes('duels_mode')) return (source.modes ?? []) as T[];
      if (query.includes('duels_map')) return (source.maps ?? []) as T[];

      // Le due query a lotti portano `id > ?` e `LIMIT ?`: il finto rispetta
      // entrambi, o il test del budget non proverebbe niente.
      const after = BigInt(String(params[0] ?? '0'));
      const limit = Number(params[1] ?? 10_000);
      const all = (query.includes('duels_match_ratings') ? source.ratings : source.matches) ?? [];
      return all
        .filter((r) => BigInt(String((r as { id: unknown }).id)) > after)
        .sort((a, b) => Number((a as { id: number }).id) - Number((b as { id: number }).id))
        .slice(0, limit) as T[];
    },
    close: async () => undefined,
  };
}

const MODES = [
  { id: 1, name: 'classic', display_name: 'Classic', ranking: 'RANKED', type: 'DUEL', color: '#d34545' },
  { id: 2, name: 'sumo', display_name: 'Sumo', ranking: 'UNRANKED', type: 'DUEL', color: 'ROSSO' },
];
const MAPS = [{ id: 10, name: 'arena', display_name: 'Arena', type: 'CLASSIC' }];

/** Due partite nella stessa ora, una in quella dopo. */
const MATCHES = [
  { id: 1, created_at: '2026-08-20 10:05:00', type: 'DUEL', context: 'NORMAL', mode_id: 1, map_id: 10 },
  { id: 2, created_at: '2026-08-20 10:41:00', type: 'DUEL', context: 'NORMAL', mode_id: 1, map_id: 10 },
  { id: 3, created_at: '2026-08-20 11:02:00', type: 'FFA', context: 'EVENT', mode_id: 2, map_id: 10 },
];

const RATINGS = [
  {
    id: '1',
    created_at: '2026-08-20 10:10:00',
    match_hex: 'a'.repeat(32),
    player_id: 7,
    mode_id: 1,
    rating: 5,
    comment: 'bella partita',
    dialog: '[{"role":"bot","content":"come e` andata?"},{"role":"player","content":"bene"}]',
    player_uuid: '11111111-2222-3333-4444-555555555555',
    player_name: 'Vally90',
  },
  {
    id: '2',
    created_at: '2026-08-20 10:30:00',
    match_hex: 'b'.repeat(32),
    player_id: 8,
    mode_id: 1,
    rating: 2,
    comment: null,
    dialog: null,
    player_uuid: null,
    player_name: null,
  },
];

async function one<T>(query: string): Promise<T> {
  const res = await sql.query(query);
  return Object.values(res.rows[0] as Record<string, unknown>)[0] as T;
}

describe('i cataloghi si replicano interi a ogni giro', () => {
  it('modalita` e mappe entrano, e il colore storto diventa nullo', async () => {
    // Perdere l'intero catalogo per un esadecimale non valido sarebbe
    // sproporzionato: la schermata ha gia` un ripiego per posizione.
    const res = await runDuelsIngest(db, fakeMysql({ modes: MODES, maps: MAPS }));
    expect(res.modes).toBe(2);

    const rows = await sql.query<{ mode_id: number; color: string | null; ranking: string }>(
      `SELECT mode_id, color, ranking FROM stats.duels_mode ORDER BY mode_id`,
    );
    expect(rows.rows).toEqual([
      { mode_id: 1, color: '#d34545', ranking: 'RANKED' },
      { mode_id: 2, color: null, ranking: 'UNRANKED' },
    ]);
  });

  it('un nome cambiato si aggiorna, senza watermark che lo nasconda', async () => {
    // I cataloghi non hanno watermark apposta: una modalita` puo` cambiare
    // nome o colore senza che il suo id si muova, e un watermark non lo
    // vedrebbe mai.
    await runDuelsIngest(db, fakeMysql({ modes: MODES }));
    const renamed = [{ ...MODES[0], display_name: 'Classico' }, MODES[1]];
    await runDuelsIngest(db, fakeMysql({ modes: renamed }));

    expect(await one<string>(`SELECT display_name FROM stats.duels_mode WHERE mode_id = 1`)).toBe('Classico');
  });
});

describe('le partite si contano per ora, e non si contano due volte', () => {
  it('due partite nella stessa ora fanno un bucket da due', async () => {
    const res = await runDuelsIngest(db, fakeMysql({ modes: MODES, maps: MAPS, matches: MATCHES }));
    expect(res.matches).toBe(3);

    const rows = await sql.query<{ ora: string; matches: number }>(
      `SELECT to_char(bucket_at AT TIME ZONE 'UTC', 'HH24:MI') AS ora, matches
         FROM stats.duels_match_hour ORDER BY bucket_at, mode_id`,
    );
    expect(rows.rows).toEqual([
      { ora: '10:00', matches: 2 },
      { ora: '11:00', matches: 1 },
    ]);
  });

  it('RIESEGUIRE il giro non raddoppia niente', async () => {
    // L'UNICO MODO in cui questo job puo` produrre numeri falsi senza fallire.
    // L'upsert e` additivo: se il watermark non fosse scritto nella stessa
    // transazione dei conteggi, un riavvio a meta` lotto conterebbe due volte
    // le stesse partite — e nessun vincolo se ne accorgerebbe, perche' un
    // conteggio doppio e` un conteggio valido.
    const my = fakeMysql({ modes: MODES, maps: MAPS, matches: MATCHES });
    await runDuelsIngest(db, my);
    await runDuelsIngest(db, my);
    await runDuelsIngest(db, my);

    expect(await one<string>(`SELECT sum(matches)::text FROM stats.duels_match_hour`)).toBe('3');
  });

  it('le partite nuove si SOMMANO a quelle gia` contate', async () => {
    // L'altro verso: l'additivita` deve funzionare quando serve davvero, cioe`
    // quando una partita nuova cade in un'ora gia` scritta.
    await runDuelsIngest(db, fakeMysql({ modes: MODES, maps: MAPS, matches: MATCHES }));
    const later = [
      ...MATCHES,
      { id: 4, created_at: '2026-08-20 10:55:00', type: 'DUEL', context: 'NORMAL', mode_id: 1, map_id: 10 },
    ];
    await runDuelsIngest(db, fakeMysql({ modes: MODES, maps: MAPS, matches: later }));

    expect(
      await one<number>(
        `SELECT matches FROM stats.duels_match_hour
          WHERE bucket_at = '2026-08-20 10:00:00+00' AND mode_id = 1`,
      ),
    ).toBe(3);
  });

  it('il watermark avanza fino all`ultimo id letto', async () => {
    await runDuelsIngest(db, fakeMysql({ modes: MODES, matches: MATCHES }));
    expect(
      await one<string>(`SELECT last_id::text FROM stats.duels_ingest_state WHERE source = 'match'`),
    ).toBe('3');
  });

  it('`since_day` dice da quando esiste il dato davvero', async () => {
    // Sostituisce il preset «All time» del legacy, che dietro il pulsante piu`
    // facile da premere metteva `from = 2000-01-01`.
    await runDuelsIngest(db, fakeMysql({ modes: MODES, matches: MATCHES }));
    expect(
      await one<string>(`SELECT since_day::text FROM stats.duels_ingest_state WHERE source = 'match'`),
    ).toBe('2026-08-20');
  });
});

describe('il budget ferma il giro e lo dichiara', () => {
  it('un arretrato grande esce con `behind` invece di correre fino in fondo', async () => {
    // Dopo un fermo di ore il recupero deve avvenire in qualche minuto di
    // cicli consecutivi, non in una corsa unica che tiene occupato il
    // database del gioco. `behind` e` il segnale che il recupero e` in corso:
    // si vede nel log e non e` un errore.
    const many = Array.from({ length: 40_000 }, (_, i) => ({
      id: i + 1,
      created_at: '2026-08-20 10:00:00',
      type: 'DUEL',
      context: 'NORMAL',
      mode_id: 1,
      map_id: 10,
    }));
    const res = await runDuelsIngest(db, fakeMysql({ modes: MODES, matches: many }), 0);

    expect(res.behind).toBe(true);
    expect(res.matches).toBe(0);
  });
});

describe('le valutazioni portano il nome, e l`aggregato torna', () => {
  it('entrano con il nome risolto una volta sola', async () => {
    const res = await runDuelsIngest(db, fakeMysql({ modes: MODES, ratings: RATINGS }));
    expect(res.ratings).toBe(2);

    const rows = await sql.query<{ player_name: string | null; rating: number }>(
      `SELECT player_name, rating FROM stats.duels_rating ORDER BY rating_id`,
    );
    expect(rows.rows).toEqual([
      { player_name: 'Vally90', rating: 5 },
      // NULL non e` un guasto: `username` e` UNIQUE all'origine, quindi un
      // cambio nome deve liberare il vecchio valore prima di scrivere il
      // nuovo, e i NULL transitori sono normali.
      { player_name: null, rating: 2 },
    ]);
  });

  it('l`aggregato giornaliero somma esattamente le cinque barre', async () => {
    await runDuelsIngest(db, fakeMysql({ modes: MODES, ratings: RATINGS }));
    const row = await sql.query<{
      n: number;
      sum_rating: number;
      with_comment: number;
      r2: number;
      r5: number;
    }>(
      `SELECT n, sum_rating, with_comment, r2, r5 FROM stats.duels_rating_day
        WHERE day = '2026-08-20' AND mode_id = 1`,
    );
    expect(row.rows[0]).toEqual({ n: 2, sum_rating: 7, with_comment: 1, r2: 1, r5: 1 });
  });

  it('il ricalcolo NON somma: rieseguire lascia l`aggregato dov`era', async () => {
    // L'inserimento dei voti e` idempotente, quindi l'aggregato va
    // RICALCOLATO e non incrementato: sommandolo, un lotto ripassato
    // conterebbe due volte gli stessi voti.
    const my = fakeMysql({ modes: MODES, ratings: RATINGS });
    await runDuelsIngest(db, my);
    await runDuelsIngest(db, my);

    expect(await one<string>(`SELECT sum(n)::text FROM stats.duels_rating_day`)).toBe('2');
  });

  it('un `dialog` malformato non ferma il lotto: si conta e si prosegue', async () => {
    const rotto = [
      { ...RATINGS[0], id: '9', dialog: '{non json' },
      { ...RATINGS[1], id: '10', dialog: '[{"role":"bot"}]' },
    ];
    const res = await runDuelsIngest(db, fakeMysql({ modes: MODES, ratings: rotto }));

    expect(res.ratings).toBe(2);
    expect(res.degraded).toBe(2);
    expect(await one<string>(`SELECT count(*)::text FROM stats.duels_rating WHERE dialog IS NULL`)).toBe('2');
    expect(
      await one<string>(`SELECT degraded::text FROM stats.duels_ingest_state WHERE source = 'rating'`),
    ).toBe('2');
  });

  it('un `dialog` valido arriva come jsonb, non come stringa', async () => {
    await runDuelsIngest(db, fakeMysql({ modes: MODES, ratings: [RATINGS[0]] }));
    expect(
      await one<string>(
        `SELECT jsonb_array_length(dialog)::text FROM stats.duels_rating WHERE rating_id = 1`,
      ),
    ).toBe('2');
    expect(await one<string>(`SELECT dialog->0->>'role' FROM stats.duels_rating WHERE rating_id = 1`)).toBe(
      'bot',
    );
  });

  it('un identificativo di partita illeggibile scarta la riga, non il lotto', async () => {
    const rotto = [{ ...RATINGS[0], id: '11', match_hex: 'non-esadecimale' }, RATINGS[1]];
    const res = await runDuelsIngest(db, fakeMysql({ modes: MODES, ratings: rotto }));

    expect(res.degraded).toBeGreaterThan(0);
    expect(await one<string>(`SELECT count(*)::text FROM stats.duels_rating`)).toBe('1');
  });
});
