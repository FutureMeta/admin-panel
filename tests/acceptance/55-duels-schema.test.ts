// Lo schema del modulo Duels. Migration 016.
//
// PERCHE' NON BASTA CHE LA MIGRATION APPLICHI PULITA. E' gia' costato un
// guasto in produzione: `min(bytea)` e' una funzione della 18, la migration
// e' passata, e ha fallito settimane dopo alla prima esecuzione del job —
// PL/pgSQL analizza le istruzioni SQL alla prima esecuzione, non alla
// creazione. Quindi qui si ESEGUE: `ensure_partitions` viene chiamata e si
// verifica che abbia creato le partizioni delle due tabelle nuove, i vincoli
// si esercitano invece di leggerli, e le viste si interrogano.

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, createTestDatabase, type TestDatabase } from '#tests/support/postgres.ts';

let testDb: TestDatabase;
let mig: pg.Client;
let ro: pg.Client;

beforeAll(async () => {
  testDb = await createTestDatabase('duelsddl');
  mig = await connect(testDb.migrateUrl, 'metamc-test-duelsddl');
  ro = await connect(testDb.statsUrl, 'metamc-test-duelsddl-ro');
}, 180_000);

afterAll(async () => {
  await ro?.end().catch(() => undefined);
  await mig?.end().catch(() => undefined);
  await testDb?.drop();
});

/** Il primo valore della prima riga, per le asserzioni a un numero solo. */
async function one<T>(client: pg.Client, sql: string, params: unknown[] = []): Promise<T> {
  const res = await client.query(sql, params);
  return Object.values(res.rows[0] as Record<string, unknown>)[0] as T;
}

describe('le partizioni esistono davvero, non solo la dichiarazione', () => {
  it('`ensure_partitions` ha creato le partizioni delle due tabelle nuove', async () => {
    // La 016 la chiama in coda. Se `stats.partitioned_table` non fosse stata
    // popolata, la funzione girerebbe senza errori e senza creare niente: la
    // migration applicherebbe pulita e la prima INSERT fallirebbe con
    // «nessuna partizione trovata», settimane dopo.
    for (const table of ['duels_match_hour', 'duels_rating']) {
      const n = await one<string>(
        mig,
        `SELECT count(*)::text FROM pg_inherits i
           JOIN pg_class p ON p.oid = i.inhparent
          WHERE p.relname = $1`,
        [table],
      );
      expect(Number(n), table).toBeGreaterThan(0);
    }
  });

  it('anche il PASSATO ha le sue partizioni, non solo il presente', async () => {
    // `ensure_partitions` guarda AVANTI: dal mese scorso a due mesi avanti
    // (011_stats.sql:900-905). Basta per tutte le tabelle della 011, che
    // nascono oggi e crescono in avanti; non basta qui, dove lo storico
    // comincia il 2026-03-09 e va importato tutto in una volta.
    //
    // Senza le partizioni dei mesi passati il backfill morirebbe con SQLSTATE
    // 23514 a meta` importazione, con dentro un pezzo di storia e nessun modo
    // di sapere quale. Non e` un guasto silenzioso — e` peggio: e` un guasto
    // rumoroso in un momento in cui la meta` del lavoro e` gia` fatta.
    for (const table of ['duels_match_hour', 'duels_rating']) {
      const missing = await mig.query<{ month: string }>(
        `SELECT to_char(m, 'YYYY_MM') AS month
           FROM generate_series(date '2026-01-01',
                                date_trunc('month', current_date)::date,
                                interval '1 month') g(m)
          WHERE to_regclass('stats.' || $1 || '_' || to_char(m, 'YYYY_MM')) IS NULL
          ORDER BY 1`,
        [table],
      );
      expect(
        missing.rows.map((r) => r.month),
        table,
      ).toEqual([]);
    }
  });

  it('una partita del 9 marzo, la piu` vecchia che esiste, entra davvero', async () => {
    // La data non e` inventata: e` il primo `created_at` di
    // `duels_match_statistics` in produzione, accertato il 22 agosto 2026.
    await mig.query(
      `INSERT INTO stats.duels_match_hour (bucket_at, mode_id, map_id, match_type, context, matches)
       VALUES (timestamptz '2026-03-09 10:00:00+00', 1, 1, 'DUEL', 'NORMAL', 3)`,
    );
    await mig.query(
      `INSERT INTO stats.duels_rating (rating_id, created_at, match_id, player_id, rating)
       VALUES (309, timestamptz '2026-03-09 10:05:00+00', gen_random_uuid(), 7, 5)`,
    );
    expect(
      await one<string>(
        mig,
        `SELECT count(*)::text FROM stats.duels_match_hour
          WHERE bucket_at < timestamptz '2026-04-01 00:00:00+00'`,
      ),
    ).toBe('1');
  });

  it('la retention e` registrata, e quella dei feedback e` 730 giorni', async () => {
    // 730 come `stats.player_day`, perche' contiene dati personali. E` l'unico
    // numero della migration che e` una decisione e non una conseguenza.
    const rows = await mig.query<{ table_name: string; keep_days: number }>(
      `SELECT table_name, keep_days FROM stats.partitioned_table
        WHERE table_name LIKE 'duels%' ORDER BY table_name`,
    );
    expect(rows.rows).toEqual([
      { table_name: 'duels_match_hour', keep_days: 3650 },
      { table_name: 'duels_rating', keep_days: 730 },
    ]);
  });

  it('una riga di partita si scrive, e il conteggio a zero no', async () => {
    await mig.query(
      `INSERT INTO stats.duels_match_hour (bucket_at, mode_id, map_id, match_type, context, matches)
       VALUES (date_trunc('hour', now()), 1, 1, 'DUEL', 'NORMAL', 7)`,
    );
    // Zero partite in un bucket non e` un fatto: e` l'assenza della riga.
    await expect(
      mig.query(
        `INSERT INTO stats.duels_match_hour (bucket_at, mode_id, map_id, match_type, context, matches)
         VALUES (date_trunc('hour', now()), 2, 1, 'DUEL', 'NORMAL', 0)`,
      ),
    ).rejects.toThrow();
  });
});

describe('la mappa di attivita` non ruota di una riga', () => {
  it('`local_dow` vale 0 di LUNEDI`, non 1', async () => {
    // LA TRAPPOLA CHE LA SPECIFICA SEGNALA PER NOME. MySQL `WEEKDAY()` e`
    // 0=lunedi', PostgreSQL `isodow` e` 1=lunedi'. Senza il `- 1` la heatmap
    // ruota di una riga e sembra plausibile: nessun test la prende, nessuno
    // se ne accorge guardandola, e il picco del sabato sera si legge come
    // domenica.
    //
    // 2026-08-24 e` un lunedi'. Le 14:00 a Roma d'estate sono le 12:00 UTC.
    await mig.query(
      `INSERT INTO stats.duels_match_hour (bucket_at, mode_id, map_id, match_type, context, matches)
       VALUES ('2026-08-24 12:00:00+00', 10, 10, 'DUEL', 'NORMAL', 3)`,
    );
    const row = await mig.query<{ local_dow: number; local_hour: number }>(
      `SELECT local_dow, local_hour FROM stats.v_duels_hour WHERE mode_id = 10`,
    );
    expect(row.rows[0]).toEqual({ local_dow: 0, local_hour: 14 });
  });

  it('la domenica e` 6, cioe` l`ultima riga', async () => {
    // 2026-08-30 e` una domenica: con `isodow` sarebbe 7, che uscirebbe dalla
    // griglia a sette righe e farebbe sparire la riga intera.
    await mig.query(
      `INSERT INTO stats.duels_match_hour (bucket_at, mode_id, map_id, match_type, context, matches)
       VALUES ('2026-08-30 12:00:00+00', 11, 10, 'DUEL', 'NORMAL', 3)`,
    );
    expect(await one<number>(mig, `SELECT local_dow FROM stats.v_duels_hour WHERE mode_id = 11`)).toBe(6);
  });

  it('il giorno di 25 ore somma due ore UTC sulla stessa ora locale', async () => {
    // Ultima domenica di ottobre 2026: alle 03:00 locali si torna alle 02:00,
    // quindi le 00:00 e le 01:00 UTC cadono ENTRAMBE sulle 02:00 locali. La
    // somma e` corretta cosi` com'e` e non va «aggiustata».
    await mig.query(
      `INSERT INTO stats.duels_match_hour (bucket_at, mode_id, map_id, match_type, context, matches)
       VALUES ('2026-10-25 00:00:00+00', 12, 10, 'DUEL', 'NORMAL', 4),
              ('2026-10-25 01:00:00+00', 12, 10, 'DUEL', 'NORMAL', 6)`,
    );
    const rows = await mig.query<{ local_hour: number; matches: string }>(
      `SELECT local_hour, sum(matches)::text AS matches FROM stats.v_duels_hour
        WHERE mode_id = 12 GROUP BY local_hour ORDER BY local_hour`,
    );
    expect(rows.rows).toEqual([{ local_hour: 2, matches: '10' }]);
  });
});

describe('gli invarianti dei feedback li impone il database', () => {
  it('un voto fuori dalla scala 1..5 non entra', async () => {
    // La UI lo assume ovunque: `colori[rating - 1]` va fuori array per 0 o 6.
    // L'origine il vincolo ce l'ha — `CONSTRAINT chk_rating` nel DDL del
    // plugin — ma i CHECK di MySQL valgono solo dalla 8.0.16 in avanti e una
    // tabella creata prima li conserva come commento. Un vincolo la cui
    // efficacia dipende dalla versione di un server altrui non e` una
    // garanzia: qui e` nostro.
    for (const bad of [0, 6, -1]) {
      await expect(
        mig.query(
          `INSERT INTO stats.duels_rating (rating_id, created_at, match_id, player_id, rating)
           VALUES ($1, now(), gen_random_uuid(), 1, $2)`,
          [900 + bad, bad],
        ),
        String(bad),
      ).rejects.toThrow();
    }
    await mig.query(
      `INSERT INTO stats.duels_rating (rating_id, created_at, match_id, player_id, rating)
       VALUES (1, now(), gen_random_uuid(), 1, 5)`,
    );
  });

  it('un feedback senza giocatore non si scrive, senza uuid si`', async () => {
    // `player_id` e` l'unica identita` che la riga porta davvero con se`
    // all'origine: e` NOT NULL. Lo uuid si risolve con una lettura in piu` su
    // `duels_userdata`, e quella lettura puo` non trovare la riga — un
    // giocatore cancellato, un'anagrafica non allineata. Se fosse NOT NULL,
    // l'ingestione fallirebbe su un caso che non e` un errore.
    await expect(
      mig.query(
        `INSERT INTO stats.duels_rating (rating_id, created_at, match_id, rating)
         VALUES (2, now(), gen_random_uuid(), 4)`,
      ),
    ).rejects.toThrow();

    await mig.query(
      `INSERT INTO stats.duels_rating (rating_id, created_at, match_id, player_id, rating)
       VALUES (3, now(), gen_random_uuid(), 77, 4)`,
    );
    expect(
      await one<string>(mig, `SELECT count(*)::text FROM stats.duels_rating WHERE player_uuid IS NULL`),
    ).not.toBe('0');
  });

  it('le cinque barre devono fare il totale', async () => {
    // Senza questo vincolo, una barra persa in aggregazione non si vedrebbe:
    // la distribuzione disegnerebbe cinque numeri che non sommano al KPI
    // accanto, e nessuno dei due sarebbe assurdo da solo.
    await mig.query(
      `INSERT INTO stats.duels_rating_day (day, mode_id, n, sum_rating, with_comment, r1, r2, r3, r4, r5)
       VALUES (current_date, 1, 10, 45, 3, 0, 1, 1, 3, 5)`,
    );
    await expect(
      mig.query(
        `INSERT INTO stats.duels_rating_day (day, mode_id, n, sum_rating, with_comment, r1, r2, r3, r4, r5)
         VALUES (current_date, 2, 10, 45, 3, 0, 1, 1, 3, 4)`,
      ),
    ).rejects.toThrow();
  });

  it('i commenti non possono superare le valutazioni', async () => {
    await expect(
      mig.query(
        `INSERT INTO stats.duels_rating_day (day, mode_id, n, sum_rating, with_comment, r1, r2, r3, r4, r5)
         VALUES (current_date, 3, 2, 8, 5, 0, 0, 0, 1, 1)`,
      ),
    ).rejects.toThrow();
  });

  it('una modalita` senza ranking non si scrive', async () => {
    // In produzione `duels_mode.ranking` e `duels_mode.type` sono due colonne
    // distinte, entrambe NOT NULL con default. Replicando qui il NOT NULL, il
    // filtro Tutte/Ranked/Unranked non ha un terzo ramo «sconosciuto» da
    // disegnare — e la UI non deve indovinare cosa farne.
    await expect(
      mig.query(
        `INSERT INTO stats.duels_mode (mode_id, name, display_name, mode_type)
         VALUES (30, 'senza', 'Senza', 'DUEL')`,
      ),
    ).rejects.toThrow();
  });

  it('un colore di modalita` non valido non entra', async () => {
    await mig.query(
      `INSERT INTO stats.duels_mode (mode_id, name, display_name, ranking, mode_type, color)
       VALUES (1, 'classic', 'Classic', 'RANKED', 'DUEL', '#d34545')`,
    );
    await expect(
      mig.query(
        `INSERT INTO stats.duels_mode (mode_id, name, display_name, ranking, mode_type, color)
         VALUES (2, 'sumo', 'Sumo', 'UNRANKED', 'DUEL', 'rosso')`,
      ),
    ).rejects.toThrow();
  });
});

describe('la ricerca ha i suoi indici, e sono usabili', () => {
  it('`pg_trgm` esiste: il ruolo delle migration ha potuto crearla', async () => {
    // Se questa riga fallisse in produzione, il rimedio e` un CREATE EXTENSION
    // fatto da chi amministra il cluster — non un ripiego a LIKE, che
    // rimetterebbe la scansione che l'indice esiste per togliere.
    expect(await one<string>(mig, `SELECT count(*)::text FROM pg_extension WHERE extname = 'pg_trgm'`)).toBe(
      '1',
    );
  });

  it('gli indici trigram e quelli della lista esistono sulla tabella partizionata', async () => {
    const rows = await mig.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'stats' AND tablename = 'duels_rating' ORDER BY indexname`,
    );
    const names = rows.rows.map((r) => r.indexname);
    for (const wanted of [
      'duels_rating_name_trgm',
      'duels_rating_comment_trgm',
      'duels_rating_by_score',
      'duels_rating_by_mode',
      'duels_rating_by_player',
    ]) {
      expect(names, wanted).toContain(wanted);
    }
  });
});

describe('il ruolo di lettura vede le viste e non le tabelle', () => {
  it('legge le viste', async () => {
    for (const view of [
      'v_duels_hour',
      'v_duels_mode',
      'v_duels_map',
      'v_duels_rating_day',
      'v_duels_rating',
      'v_duels_ingest',
    ]) {
      await expect(ro.query(`SELECT 1 FROM stats.${view} LIMIT 1`), view).resolves.toBeDefined();
    }
  });

  it('e non le tabelle di fatto', async () => {
    // Stessa regola della fase 2: chi leggesse le tabelle nude ricaverebbe
    // medie con il denominatore sbagliato e zeri al posto dei buchi.
    for (const table of ['duels_match_hour', 'duels_rating', 'duels_rating_day']) {
      await expect(ro.query(`SELECT 1 FROM stats.${table} LIMIT 1`), table).rejects.toThrow();
    }
  });

  it('e non ci scrive', async () => {
    await expect(
      ro.query(
        `INSERT INTO stats.duels_match_hour (bucket_at, mode_id, map_id, match_type, context, matches)
         VALUES (now(), 99, 99, 'DUEL', 'NORMAL', 1)`,
      ),
    ).rejects.toThrow();
  });
});

describe('lo stato dell`ingestione nasce con le sue tre righe', () => {
  it('match, rating e catalog, tutte a zero', async () => {
    const rows = await mig.query<{ source: string; last_id: string; degraded: string }>(
      `SELECT source, last_id::text, degraded::text FROM stats.duels_ingest_state ORDER BY source`,
    );
    expect(rows.rows).toEqual([
      { source: 'catalog', last_id: '0', degraded: '0' },
      { source: 'match', last_id: '0', degraded: '0' },
      { source: 'rating', last_id: '0', degraded: '0' },
    ]);
  });

  it('una sorgente inventata non si scrive', async () => {
    await expect(
      mig.query(`INSERT INTO stats.duels_ingest_state (source) VALUES ('partite')`),
    ).rejects.toThrow();
  });
});
