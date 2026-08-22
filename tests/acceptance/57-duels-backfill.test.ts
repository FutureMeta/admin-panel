// L'importazione dello storico, e soprattutto la sua VERIFICA.
//
// QUI IL TEST PIU' IMPORTANTE NON E' CHE IMPORTI: e' che se ne accorga quando
// non ha importato bene. Un backfill che raddoppia i conteggi produce un
// grafico perfettamente disegnato che dice il doppio del vero, e nessun
// vincolo del database se ne accorge — un conteggio doppio e' un conteggio
// valido. L'unica difesa e' il confronto con la sorgente, quindi sotto ci sono
// due prove che quel confronto ACCUSA: una sui conteggi delle partite, una
// sull'aggregato giornaliero dei voti.
//
// La seconda cosa che si prova e' che si fermi PRIMA. Le partizioni dei mesi
// passati o ci sono o non ci sono: se non ci sono, morire al centesimo lotto
// significa lasciare mezza storia dentro e nessun modo di sapere quale meta'.

import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createKysely, createPool, type Database } from '#src/db/pool.ts';
import { missingPartitions, PartitionsMissing, runDuelsBackfill } from '#src/duels/backfill.ts';
import { WatermarkMoved } from '#src/duels/ingest.ts';
import type { DuelsMysql } from '#src/duels/mysql.ts';
import { fakeDuelsMysql } from '#tests/support/duels-mysql.ts';
import { connect, createTestDatabase, type TestDatabase } from '#tests/support/postgres.ts';

let testDb: TestDatabase;
let pool: pg.Pool;
let db: Database;
let sql: pg.Client;

beforeAll(async () => {
  testDb = await createTestDatabase('duelsbfl');
  pool = createPool({
    connectionString: testDb.ingestUrl,
    max: 4,
    applicationName: 'metamc-test-duelsbfl',
    connectionTimeoutMillis: 20_000,
    statementTimeout: '60s',
    searchPath: 'stats, public',
  });
  db = createKysely(pool);
  sql = await connect(testDb.migrateUrl, 'metamc-test-duelsbfl-sql');
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

const MODES = [
  { id: 1, name: 'classic', display_name: 'Classic', ranking: 'RANKED', type: 'DUEL', color: '#d34545' },
];
const MAPS = [{ id: 10, name: 'arena', display_name: 'Arena', type: 'CLASSIC' }];

/** Tre partite: due a marzo — cioe' nel passato — e una di agosto. */
const MATCHES = [
  { id: 1, created_at: '2026-03-09 10:05:00', type: 'DUEL', context: 'NORMAL', mode_id: 1, map_id: 10 },
  { id: 2, created_at: '2026-03-09 10:41:00', type: 'DUEL', context: 'NORMAL', mode_id: 1, map_id: 10 },
  { id: 3, created_at: '2026-08-20 11:02:00', type: 'DUEL', context: 'NORMAL', mode_id: 1, map_id: 10 },
];

const RATINGS = [
  {
    id: '1',
    created_at: '2026-03-09 10:10:00',
    match_hex: 'a'.repeat(32),
    player_id: 7,
    mode_id: 1,
    rating: 5,
    comment: 'bella partita',
    dialog: null,
    player_uuid: null,
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

const TUTTO = { modes: MODES, maps: MAPS, matches: MATCHES, ratings: RATINGS };

async function one<T>(query: string): Promise<T> {
  const res = await sql.query(query);
  return Object.values(res.rows[0] as Record<string, unknown>)[0] as T;
}

describe('lo storico entra, e alla fine si conta', () => {
  it('importa tutto e i conti con la sorgente tornano', async () => {
    const report = await runDuelsBackfill(db, fakeDuelsMysql(TUTTO));

    expect(report.ok).toBe(true);
    expect(report.matches).toMatchObject({ source: 3, stored: 3, ok: true });
    expect(report.ratings).toMatchObject({ source: 2, stored: 2, discarded: 0, ok: true });
    expect(report.days).toMatchObject({ stored: 2, expected: 2, ok: true });
    expect(report.modes).toBe(1);
  });

  it('i lotti si vedono passare, uno per volta', async () => {
    // Il registro di avanzamento e` la cosa che rende sopportabile un'ora di
    // importazione: senza, l'unico modo di sapere se sta procedendo o se e`
    // bloccata sarebbe interrogare il database da un'altra parte.
    const visti: string[] = [];
    await runDuelsBackfill(db, fakeDuelsMysql(TUTTO), {
      onProgress: (p) => visti.push(`${p.source}:${p.read}`),
    });
    expect(visti).toEqual(['match:3', 'rating:2']);
  });

  it('rilanciarlo non raddoppia niente', async () => {
    const my = fakeDuelsMysql(TUTTO);
    await runDuelsBackfill(db, my);
    const secondo = await runDuelsBackfill(db, my);

    expect(secondo.ok).toBe(true);
    expect(secondo.matches.stored).toBe(3);
    expect(await one<string>(`SELECT sum(matches)::text FROM stats.duels_match_hour`)).toBe('3');
  });

  it('riprende da dove era arrivato, non da capo', async () => {
    // Interrotto a meta`: la sorgente ne aveva due, poi ne arriva una terza.
    await runDuelsBackfill(db, fakeDuelsMysql({ ...TUTTO, matches: MATCHES.slice(0, 2) }));
    const ripreso = await runDuelsBackfill(db, fakeDuelsMysql(TUTTO));

    expect(ripreso.resumedFrom.match).toBe('2');
    expect(ripreso.matches).toMatchObject({ source: 3, stored: 3, ok: true });
  });
});

describe('la verifica ACCUSA, altrimenti non serve a niente', () => {
  it('se su PostgreSQL ce n`e` piu` che alla sorgente, lo dice', async () => {
    // E` esattamente cio' che succede se il backfill gira due volte su un
    // intervallo gia` importato: l'upsert delle partite e` additivo. Il
    // conteggio resta valido, il grafico resta bello, e l'unico modo di
    // accorgersene e` chiedere alla sorgente quante ce n'erano.
    await runDuelsBackfill(db, fakeDuelsMysql(TUTTO));
    await sql.query(`UPDATE stats.duels_match_hour SET matches = matches + 5`);

    const report = await runDuelsBackfill(db, fakeDuelsMysql(TUTTO));

    expect(report.ok).toBe(false);
    expect(report.matches.ok).toBe(false);
    expect(report.matches.stored).toBeGreaterThan(report.matches.source);
  });

  it('se l`aggregato giornaliero non torna con le righe, lo dice', async () => {
    // L'aggregato dei voti e` RICALCOLATO, non sommato: e` la scelta giusta,
    // ma significa che se un giorno non venisse ricalcolato nessuno se ne
    // accorgerebbe — le schermate leggono l'aggregato, non le righe.
    await runDuelsBackfill(db, fakeDuelsMysql(TUTTO));
    await sql.query(`DELETE FROM stats.duels_rating_day`);

    const report = await runDuelsBackfill(db, fakeDuelsMysql(TUTTO));

    expect(report.ok).toBe(false);
    expect(report.days).toMatchObject({ stored: 0, expected: 2, ok: false });
  });

  it('una riga scartata SPIEGA la differenza invece di sembrare un buco', async () => {
    // Senza il termine «scartate», uno scarto legittimo e un'importazione
    // monca si presenterebbero identici: due numeri diversi e nessuna causa.
    const rotta = [{ ...RATINGS[0], match_hex: 'non-esadecimale' }, RATINGS[1]];
    const report = await runDuelsBackfill(db, fakeDuelsMysql({ ...TUTTO, ratings: rotta }));

    expect(report.ratings).toMatchObject({ source: 2, stored: 1, discarded: 1, ok: true });
    expect(report.ok).toBe(true);
  });
});

describe('le partizioni si controllano PRIMA di importare', () => {
  it('un mese senza partizione ferma tutto sulla soglia', async () => {
    // Novembre 2025 e` fuori da qualunque orizzonte: la 016 crea lo storico da
    // gennaio 2026, `ensure_partitions` copre da un mese fa in avanti.
    const vecchie = [
      { id: 1, created_at: '2025-11-15 10:00:00', type: 'DUEL', context: 'NORMAL', mode_id: 1, map_id: 10 },
    ];

    await expect(runDuelsBackfill(db, fakeDuelsMysql({ ...TUTTO, matches: vecchie }))).rejects.toThrow(
      PartitionsMissing,
    );

    // E si e` fermato PRIMA: niente cataloghi, niente watermark mosso.
    expect(await one<string>(`SELECT count(*)::text FROM stats.duels_mode`)).toBe('0');
    expect(
      await one<string>(`SELECT last_id::text FROM stats.duels_ingest_state WHERE source = 'match'`),
    ).toBe('0');
  });

  it('per lo storico vero non manca niente', async () => {
    // Il verso opposto: un controllo che segnalasse sempre un buco fermerebbe
    // ogni importazione, e il test qui sopra da solo non lo distinguerebbe.
    const buchi = await missingPartitions(
      db,
      'duels_match_hour',
      '2026-03-09 10:05:00Z',
      '2026-08-20 11:02:00Z',
    );
    expect(buchi).toEqual([]);
  });
});

describe('un secondo scrittore ferma il backfill, non lo fa sbagliare', () => {
  it('il conflitto ESCE, invece di essere assorbito come nel giro periodico', async () => {
    // Nel ciclo da trenta secondi un conflitto e` una condizione da
    // registrare e superare: il giro dopo riparte. Qui no: se il pannello sta
    // ingerendo mentre si importa lo storico, la cosa da fare e` fermarsi e
    // dirlo, perche' chi ha lanciato il comando e` davanti allo schermo.
    const base = fakeDuelsMysql(TUTTO);
    let interfered = false;
    const conteso: DuelsMysql = {
      cap: base.cap,
      close: base.close,
      rows: async <T>(query: string, params: unknown[] = []): Promise<T[]> => {
        const out = await base.rows<T>(query, params);
        if (query.includes('id > ?') && query.includes('duels_match_statistics') && !interfered) {
          interfered = true;
          await sql.query(`UPDATE stats.duels_ingest_state SET last_id = 99 WHERE source = 'match'`);
        }
        return out;
      },
    };

    await expect(runDuelsBackfill(db, conteso)).rejects.toThrow(WatermarkMoved);
    expect(await one<string>(`SELECT COALESCE(sum(matches), 0)::text FROM stats.duels_match_hour`)).toBe('0');
  });
});
