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
import {
  createExecutionCap,
  type DuelsMysql,
  missingSourceColumns,
  SOURCE_COLUMNS,
} from '#src/duels/mysql.ts';
import { fakeDuelsMysql } from '#tests/support/duels-mysql.ts';
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

/** Il MySQL finto vive in `tests/support`: lo condivide con il backfill. */
const fakeMysql = fakeDuelsMysql;

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
  it('modalita` e mappe entrano, e il colore resta vuoto', async () => {
    // IL COLORE NON VIENE DALLA SORGENTE. `duels_mode` all'origine non ha
    // quella colonna — verificato in produzione il 22 agosto 2026, errno 1054
    // — e la colonna su PostgreSQL resta perche` e` nostra: ci finira` la
    // scelta fatta dalla configurazione. Finche` e` nulla le schermate
    // ripiegano su una posizione stabile nel dizionario.
    const res = await runDuelsIngest(db, fakeMysql({ modes: MODES, maps: MAPS }));
    expect(res.modes).toBe(2);

    const rows = await sql.query<{ mode_id: number; color: string | null; ranking: string }>(
      `SELECT mode_id, color, ranking FROM stats.duels_mode ORDER BY mode_id`,
    );
    expect(rows.rows).toEqual([
      { mode_id: 1, color: null, ranking: 'RANKED' },
      { mode_id: 2, color: null, ranking: 'UNRANKED' },
    ]);
  });

  it('un colore gia` scelto SOPRAVVIVE al giro successivo', async () => {
    // Il difetto opposto, e sarebbe silenzioso: se l'upsert scrivesse anche il
    // colore, ogni ciclo da trenta secondi cancellerebbe la scelta fatta dalla
    // configurazione, e chi l'ha fatta la vedrebbe sparire senza capire
    // perche`.
    await runDuelsIngest(db, fakeMysql({ modes: MODES }));
    await sql.query(`UPDATE stats.duels_mode SET color = '#d34545' WHERE mode_id = 1`);
    await runDuelsIngest(db, fakeMysql({ modes: MODES }));

    expect(await one<string>(`SELECT color FROM stats.duels_mode WHERE mode_id = 1`)).toBe('#d34545');
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

describe('due ingeritori insieme non raddoppiano niente', () => {
  it('se il watermark si muove sotto i piedi, il lotto torna INDIETRO INTERO', async () => {
    // La scena vera: il backfill si lancia a mano, e il modo naturale di
    // lanciarlo e` contro la produzione mentre il pannello e` acceso. I due
    // leggerebbero lo stesso watermark, ingerirebbero lo stesso lotto, e
    // l'upsert additivo raddoppierebbe i conteggi senza che niente fallisca.
    //
    // Qui l'interferenza e` simulata dove accade davvero: mentre la lettura
    // del MySQL e` in corso, cioe` fra il momento in cui si legge il
    // watermark e il momento in cui lo si riscrive.
    const base = fakeMysql({ modes: MODES, maps: MAPS, matches: MATCHES });
    let interfered = false;
    const conteso: DuelsMysql = {
      cap: base.cap,
      close: base.close,
      rows: async <T>(query: string, params: unknown[] = []): Promise<T[]> => {
        const out = await base.rows<T>(query, params);
        if (query.includes('duels_match_statistics') && !interfered) {
          interfered = true;
          await sql.query(`UPDATE stats.duels_ingest_state SET last_id = 99 WHERE source = 'match'`);
        }
        return out;
      },
    };

    const res = await runDuelsIngest(db, conteso);

    expect(res.contended, 'il giro deve DIRE che c`era un altro').toBe(true);
    expect(res.matches).toBe(0);
    // Nessuna partita scritta: la transazione e` tornata indietro con dentro
    // sia i conteggi sia il watermark.
    expect(await one<string>(`SELECT COALESCE(sum(matches), 0)::text FROM stats.duels_match_hour`)).toBe('0');
    // E il watermark dell'altro e` rimasto il suo, non e` stato sovrascritto.
    expect(
      await one<string>(`SELECT last_id::text FROM stats.duels_ingest_state WHERE source = 'match'`),
    ).toBe('99');
  });

  it('senza interferenza il giro finisce come sempre', async () => {
    // Il verso opposto della stessa guardia: un confronto-e-scambio che
    // fallisse sempre sarebbe un pannello che non ingerisce mai, e il test
    // qui sopra da solo non lo distinguerebbe.
    const res = await runDuelsIngest(db, fakeMysql({ modes: MODES, maps: MAPS, matches: MATCHES }));
    expect(res.contended).toBe(false);
    expect(res.matches).toBe(3);
  });
});

describe('il tetto di esecuzione ha due nomi su due database diversi', () => {
  /** L'errore che MariaDB restituisce per una variabile che non conosce. */
  function unknownVariable(): Error & { errno: number } {
    const err = new Error("Unknown system variable 'max_execution_time'") as Error & { errno: number };
    err.errno = 1193;
    return err;
  }

  it('su MySQL si usa `max_execution_time`, in millisecondi', async () => {
    const seen: string[] = [];
    const cap = createExecutionCap(10_000);
    await cap.apply(async (s) => void seen.push(s));

    expect(cap.kind()).toBe('mysql');
    expect(seen).toEqual(['SET SESSION max_execution_time = 10000']);
  });

  it('su MariaDB si ripiega su `max_statement_time`, in SECONDI', async () => {
    // COSTATO UN GUASTO IN PRODUZIONE: il database del gioco e` MariaDB, e
    // l'errno 1193 arrivava prima di ogni singola query — quindi l'ingestione
    // non ne ha eseguita nemmeno una. E i secondi non sono un dettaglio:
    // passare 10000 a MariaDB vorrebbe dire un tetto di due ore e quaranta,
    // cioe` nessun tetto.
    const seen: string[] = [];
    const cap = createExecutionCap(10_000);
    await cap.apply(async (s) => {
      seen.push(s);
      if (s.includes('max_execution_time')) throw unknownVariable();
    });

    expect(cap.kind()).toBe('mariadb');
    expect(seen.at(-1)).toBe('SET SESSION max_statement_time = 10');
  });

  it('il dialetto si ricorda: non si ritenta a ogni query', async () => {
    const seen: string[] = [];
    const cap = createExecutionCap(10_000);
    const query = async (s: string) => {
      seen.push(s);
      if (s.includes('max_execution_time')) throw unknownVariable();
    };
    await cap.apply(query);
    seen.length = 0;
    await cap.apply(query);

    expect(seen).toEqual(['SET SESSION max_statement_time = 10']);
  });

  it('senza nessuna delle due si continua, ma si sa di essere senza tetto', async () => {
    // Il giro deve andare avanti: rinunciare a leggere perche` il server non
    // ha un tetto sarebbe peggio. Ma `none` e` un degrado, e il keeper lo
    // registra come avviso invece che come «tutto bene».
    const cap = createExecutionCap(10_000);
    await cap.apply(async () => {
      throw unknownVariable();
    });
    expect(cap.kind()).toBe('none');
  });

  it('un errore che NON e` «variabile sconosciuta» non si assorbe', async () => {
    // Una connessione caduta a meta` non deve diventare «questo server non ha
    // il tetto»: sarebbe una diagnosi sbagliata che si porta dietro per tutta
    // la vita del processo.
    const cap = createExecutionCap(10_000);
    await expect(
      cap.apply(async () => {
        throw new Error('connessione persa');
      }),
    ).rejects.toThrow(/connessione persa/);
    expect(cap.kind()).toBe('unknown');
  });
});

describe('cosa manca alla sorgente si chiede una volta, all`avvio', () => {
  const TUTTE = Object.entries(SOURCE_COLUMNS).flatMap(([t, cols]) => cols.map((c) => ({ t, c })));

  it('con la sorgente allineata non manca niente', async () => {
    expect(await missingSourceColumns(fakeMysql({ columns: TUTTE }))).toEqual([]);
  });

  it('una colonna assente si nomina, non si indovina', async () => {
    // E` cosi` che sono usciti `max_execution_time` e `duels_mode.color`: uno
    // per riavvio, ognuno dopo un deploy. Chiederle tutte insieme costa una
    // query e toglie il giro di scoperte.
    const senza = TUTTE.filter((x) => !(x.t === 'duels_userdata' && x.c === 'username'));
    expect(await missingSourceColumns(fakeMysql({ columns: senza }))).toEqual(['duels_userdata.username']);
  });

  it('una tabella assente si segnala per INTERA, non colonna per colonna', async () => {
    // Sei righe identiche non si leggono; una riga che dice «tabella assente»
    // si` — ed e` un guasto diverso, che si risolve in un altro modo.
    const senza = TUTTE.filter((x) => x.t !== 'duels_map');
    expect(await missingSourceColumns(fakeMysql({ columns: senza }))).toEqual(['duels_map: tabella assente']);
  });

  it('il maiuscolo di MariaDB non conta come una colonna diversa', async () => {
    const urlate = TUTTE.map((x) => ({ t: x.t.toUpperCase(), c: x.c.toUpperCase() }));
    expect(await missingSourceColumns(fakeMysql({ columns: urlate }))).toEqual([]);
  });
});
