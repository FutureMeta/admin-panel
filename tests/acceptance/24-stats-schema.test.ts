// Lo schema `stats` della fase 2: migration 011.
//
// PERCHE' QUESTO TEST ESISTE, e perche' non basta che la migration applichi.
//
// Fase 1 ha gia' prodotto una lezione su questo punto: `verify_chain` usava
// `min(bytea)`, che esiste solo dal PostgreSQL 18. La migration si applicava
// pulita ovunque, i test erano verdi, e il guasto e' comparso in produzione —
// perche' PL/pgSQL analizza l'SQL alla PRIMA ESECUZIONE, non alla CREATE.
// Una funzione creata e mai eseguita non e' stata verificata in nessun senso
// utile della parola. Qui ogni funzione viene ESEGUITA, e ogni vincolo viene
// provato in ENTRAMBI i versi: cio' che deve passare passa, cio' che deve
// fallire fallisce.
//
// Il secondo motivo e' che tutte le trappole di questo schema falliscono in
// silenzio e in modo plausibile. Nessuna solleva un'eccezione, nessuna rompe
// un grafico:
//
//   * un giorno civile calcolato in UTC perde ogni notte la coda fra le 00:00
//     e le 02:00 di Roma. Errore stabile del 2-5%: invisibile nel confronto
//     mese su mese, e sbagliato per sempre;
//   * `expected_s` costante a 86400 fa uscire la copertura al 104% e al 96%
//     nei due giorni di cambio ora, e qualcuno passera' un pomeriggio a
//     cercare il bug nell'ingest;
//   * uno zero scritto al posto di un buco trasforma un guasto in un evento
//     di business, e falsa ogni media a valle in modo permanente;
//   * un ciclo `failed` che non si puo' scrivere fa sparire la differenza fra
//     «Redis era giu'» e «il poller non stava girando».
//
// Nessuna di queste cose la nota chi guarda il pannello. Le nota un vincolo.

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, createTestDatabase, type TestDatabase } from '#tests/support/postgres.ts';

let testDb: TestDatabase;
/** Il ruolo che possiede lo schema: quasi tutte le prove passano da qui. */
let mig: pg.Client;

beforeAll(async () => {
  testDb = await createTestDatabase('stats');
  mig = await connect(testDb.migrateUrl, 'metamc-test-stats');
}, 180_000);

afterAll(async () => {
  await mig?.end().catch(() => undefined);
  await testDb?.drop();
});

/** Il primo valore della prima riga, che e' quasi sempre cio' che serve. */
async function one<T>(client: pg.Client, sql: string, params: unknown[] = []): Promise<T> {
  const res = await client.query(sql, params);
  return Object.values(res.rows[0] as Record<string, unknown>)[0] as T;
}

describe('partizioni: create, idempotenti, e la potatura non tocca la finestra', () => {
  // Cancello del passo 1 (§9.4): senza questo, una partizione mancante fa
  // fallire OGNI ciclo da mezzanotte in poi con SQLSTATE 23514 — il grafico
  // diventa bianco e la causa non e' nel codice del grafico.
  it('la migration ha gia` creato le partizioni, e un secondo giro non ne crea altre', async () => {
    const giorni = await one<string>(
      mig,
      `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'stats' AND c.relname ~ '^sample_server_[0-9]{4}_[0-9]{2}_[0-9]{2}$'`,
    );
    expect(Number(giorni)).toBeGreaterThanOrEqual(6);

    const mesi = await one<string>(
      mig,
      `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'stats' AND c.relname ~ '^session_[0-9]{4}_[0-9]{2}$'`,
    );
    expect(Number(mesi)).toBeGreaterThanOrEqual(4);

    expect(Number(await one(mig, 'SELECT stats.ensure_partitions()'))).toBe(0);
  });

  it('i parametri di storage stanno sulle FOGLIE, non sul padre', async () => {
    // Una tabella partizionata non li accetta («cannot specify storage
    // parameters for a partitioned table»), e un ALTER sulle foglie di oggi
    // non toccherebbe quelle create fra sei mesi: l'unico posto in cui
    // vivono davvero e' la CREATE della partizione.
    const conParametro = await one<string>(
      mig,
      `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'stats' AND c.relname ~ '^sample_server_[0-9]{4}'
          AND c.reloptions @> ARRAY['autovacuum_vacuum_insert_scale_factor=0.02']`,
    );
    expect(Number(conParametro)).toBeGreaterThan(0);
  });

  it('la potatura non elimina niente di quanto e` ancora in finestra', async () => {
    const eliminate = await one<string[]>(mig, 'SELECT stats.drop_expired_partitions()');
    expect(eliminate).toEqual([]);
  });

  it('un orizzonte fuori scala viene rifiutato, non troncato in silenzio', async () => {
    // Un chiamante compromesso non deve poter riempire lo schema di tabelle.
    await expect(mig.query('SELECT stats.ensure_partitions(99, 1)')).rejects.toThrow(
      /orizzonte giorni fuori scala/,
    );
  });
});

describe('il fuso: Europe/Rome vive in due funzioni e da nessun`altra parte', () => {
  it('il giorno civile non e` il giorno UTC', async () => {
    // Alle 22:30 UTC di giugno, a Roma e' gia' il giorno dopo. E' esattamente
    // la coda notturna che un processo con TZ=UTC perderebbe ogni notte.
    const giorno = await one<Date | string>(
      mig,
      `SELECT stats.civil_day('2026-06-14 22:30:00+00'::timestamptz)`,
    );
    expect(String(giorno).slice(0, 10)).toBe('2026-06-15');
  });

  it('un giorno non dura 86400 secondi, due volte l`anno', async () => {
    const secondi = async (g: string) => Number(await one(mig, 'SELECT stats.day_seconds($1)', [g]));
    expect(await secondi('2026-06-15')).toBe(86_400);
    expect(await secondi('2026-03-29')).toBe(82_800); // l'ora che non esiste
    expect(await secondi('2026-10-25')).toBe(90_000); // l'ora che c'e' due volte
  });
});

describe('il dizionario delle modalita`: strutturato, ordinato, deterministico', () => {
  // E' un modulo del pannello e nasce VUOTO: nessun seed nella migration.
  // Il filtro non usa espressioni regolari, perche' una regexp scritta nel
  // pannello e' input non fidato che gira nel database, e la prima volta che
  // qualcuno salva `(a+)+b` il ciclo di campionamento si ferma.
  beforeAll(async () => {
    await mig.query(`
      INSERT INTO stats.mode (mode_key, display_name, color) VALUES
        ('bedwars', 'Bedwars', '#e8822b'), ('eventi', 'Eventi', NULL), ('lobby', 'Lobby', NULL);
      INSERT INTO stats.mode_alias (match_kind, match_value, mode_id)
      SELECT v.k, v.m, s.mode_id
        FROM (VALUES ('prefix','bedwars_','bedwars'),
                     ('prefix','bedwars_solo_','bedwars'),
                     ('server','bedwars_solo_1','lobby'),
                     ('suffix','_duels','eventi'),
                     ('contains','event','eventi')) AS v(k, m, target)
        JOIN stats.mode s ON s.mode_key = v.target;
      INSERT INTO stats.server (server_key) VALUES ('bedwars_solo_2'), ('skywars_3');`);
  });

  it('nasce vuoto: la migration non semina nessuna modalita`', async () => {
    const daMigration = await one<string>(
      mig,
      `SELECT count(*) FROM stats.mode WHERE created_by = 'migration'`,
    );
    expect(Number(daMigration)).toBe(0);
  });

  it('il nome esatto batte il prefisso, anche quando il prefisso e` piu` specifico', async () => {
    // `bedwars_solo_1` ha un prefisso lungo che punta a Bedwars e una regola
    // esatta che punta a Lobby. Senza un ordine TOTALE, quale vince
    // dipenderebbe dall'ordine fisico delle righe.
    const risolta = await one<string>(
      mig,
      `SELECT m.mode_key FROM stats.mode m
        WHERE m.mode_id = stats.resolve_mode_id('bedwars_solo_1')`,
    );
    expect(risolta).toBe('lobby');
  });

  it('prefisso, suffisso e contenuto risolvono nell`ordine dichiarato', async () => {
    const risolvi = (s: string) =>
      one<string | null>(
        mig,
        `SELECT (SELECT mode_key FROM stats.mode WHERE mode_id = stats.resolve_mode_id($1))`,
        [s],
      );
    expect(await risolvi('bedwars_solo_2')).toBe('bedwars');
    expect(await risolvi('ranked_duels')).toBe('eventi');
    expect(await risolvi('summer_event_2')).toBe('eventi');
  });

  it('un server che nessuna regola mappa non fa fallire niente', async () => {
    // NULL, che in lettura diventa `__unknown__`. Mai un errore, mai una
    // modalita' inventata: un ciclo di campionamento non puo' fermarsi
    // perche' e' comparso un server nuovo.
    for (const s of ['skywars_3', '', null]) {
      expect(await one(mig, 'SELECT stats.resolve_mode_id($1)', [s])).toBeNull();
    }
  });

  it('le regexp restano fuori dal database', async () => {
    await expect(
      mig.query(
        `INSERT INTO stats.mode_alias (match_kind, match_value, mode_id)
         SELECT 'regex', 'bed.*', mode_id FROM stats.mode WHERE mode_key = 'bedwars'`,
      ),
    ).rejects.toThrow();
  });

  it('un alias vuoto mapperebbe tutto, quindi non si puo` scrivere', async () => {
    await expect(
      mig.query(
        `INSERT INTO stats.mode_alias (match_kind, match_value, mode_id)
         SELECT 'prefix', '  ', mode_id FROM stats.mode WHERE mode_key = 'bedwars'`,
      ),
    ).rejects.toThrow();
  });

  it('un colore che non e` esadecimale si ferma qui, non nel grafico', async () => {
    await expect(
      mig.query(`INSERT INTO stats.mode (mode_key, display_name, color) VALUES ('x','X','rosso')`),
    ).rejects.toThrow();
  });

  it('i due sentinella e l`ignoto hanno tutti un nome', async () => {
    const modeKeyOf = (column: string, val: string | number) =>
      one<string>(mig, `SELECT mode_key FROM stats.v_server_mode WHERE ${column} = $1`, [val]);
    expect(await modeKeyOf('server_id', 0)).toBe('__network__');
    expect(await modeKeyOf('server_id', 1)).toBe('__transit__');
    expect(await modeKeyOf('server_key', 'skywars_3')).toBe('__unknown__');
    expect(await modeKeyOf('server_key', 'bedwars_solo_2')).toBe('bedwars');
  });
});

describe('il registro dei cicli distingue i buchi, che sono di due nature diverse', () => {
  const RUN = '00000000-0000-4000-8000-000000000001';

  it('un ciclo fallito si puo` scrivere, e non copre niente', async () => {
    // Redis giu' un'ora produce 120 righe `failed`; Postgres giu' un'ora
    // produce 120 righe MANCANTI, perche' non c'e' dove scrivere che non si
    // poteva scrivere. Con `delta_s NOT NULL`, come stava nel materiale di
    // progetto, la prima delle due era impossibile da rappresentare.
    await mig.query(
      `INSERT INTO stats.poll_cycle (tick_at, run_id, status, error_kind)
       VALUES ('2026-08-20 10:00:00+00', $1, 'failed', 'redis_unreachable')`,
      [RUN],
    );
    expect(
      await one(mig, `SELECT delta_s FROM stats.poll_cycle WHERE tick_at = '2026-08-20 10:00:00+00'`),
    ).toBeNull();
  });

  it('un ciclo fallito che dichiara di aver coperto del tempo viene rifiutato', async () => {
    await expect(
      mig.query(
        `INSERT INTO stats.poll_cycle (tick_at, run_id, status, delta_s)
         VALUES ('2026-08-20 10:00:30+00', $1, 'failed', 30)`,
        [RUN],
      ),
    ).rejects.toThrow();
  });

  it('un ciclo ok senza copertura viene rifiutato', async () => {
    // Altrimenti il denominatore di una media verrebbe da nessuna parte.
    await expect(
      mig.query(
        `INSERT INTO stats.poll_cycle (tick_at, run_id, status, players)
         VALUES ('2026-08-20 10:01:00+00', $1, 'ok', 10)`,
        [RUN],
      ),
    ).rejects.toThrow();
  });

  it('«rete davvero vuota» e` un ciclo ok con players a zero', async () => {
    // E' il terzo stato, e va distinto dagli altri due STRUTTURALMENTE:
    // riga assente = il poller non girava; status <> ok = girava e il dato
    // non c'e'; ok con players = 0 = la rete era davvero vuota.
    await mig.query(
      `INSERT INTO stats.poll_cycle (tick_at, run_id, status, delta_s, players)
       VALUES ('2026-08-20 10:01:30+00', $1, 'ok', 30, 0)`,
      [RUN],
    );
    expect(
      Number(await one(mig, `SELECT players FROM stats.poll_cycle WHERE tick_at = '2026-08-20 10:01:30+00'`)),
    ).toBe(0);
  });
});

describe('il grezzo: la convenzione sparsa e` un vincolo, non un accordo verbale', () => {
  const RUN = '00000000-0000-4000-8000-000000000002';

  beforeAll(async () => {
    await mig.query(
      `INSERT INTO stats.poll_cycle (tick_at, run_id, status, delta_s, players)
       VALUES ('2026-08-20 10:02:00+00', $1, 'ok', 30, 7)`,
      [RUN],
    );
  });

  it('un server con giocatori si scrive', async () => {
    await mig.query(
      `INSERT INTO stats.sample_server (tick_at, server_id, delta_s, players)
       SELECT '2026-08-20 10:02:00+00', server_id, 30, 7
         FROM stats.server WHERE server_key = 'bedwars_solo_2'`,
    );
  });

  it('uno zero nel grezzo non si puo` scrivere', async () => {
    // Assenza di riga dentro un tick `ok` significa gia' zero. Poter
    // scrivere anche lo zero esplicito significa due rappresentazioni per lo
    // stesso fatto, e prima o poi una query ne considera una sola.
    await expect(
      mig.query(
        `INSERT INTO stats.sample_server (tick_at, server_id, delta_s, players)
         VALUES ('2026-08-20 10:02:00+00', 1, 30, 0)`,
      ),
    ).rejects.toThrow();
  });

  it('il totale di rete non entra nel grezzo', async () => {
    // Vive in poll_cycle.players: e' l'insieme DEDUPLICATO delle identita' e
    // non e' la somma dei server, perche' count(distinct) non si decompone.
    // Qui sarebbe una seconda verita' sullo stesso numero.
    await expect(
      mig.query(
        `INSERT INTO stats.sample_server (tick_at, server_id, delta_s, players)
         VALUES ('2026-08-20 10:02:00+00', 0, 30, 7)`,
      ),
    ).rejects.toThrow();
  });
});

describe('sessioni e rollup', () => {
  it('la durata e` generata e non puo` essere negativa', async () => {
    await mig.query(
      `INSERT INTO stats.session
         (started_at, player_id, ended_at, server_id_first, server_id_last, end_reason)
       VALUES ('2026-08-20 09:00:00+00', 42, '2026-08-20 09:45:30+00', 1, 1, 'quit')`,
    );
    expect(Number(await one(mig, 'SELECT duration_s FROM stats.session WHERE player_id = 42'))).toBe(2730);
  });

  it('il BRIN su ended_at usa minmax_multi, non il minmax di default', async () => {
    // Le righe entrano in ordine di CHIUSURA: una sessione da 12 ore si
    // chiude in mezzo a quelle da 2 minuti. Con il minmax semplice — che e'
    // il default per timestamptz, quindi cio' che si ottiene scrivendo solo
    // `USING brin (ended_at)` — quegli outlier allargano ogni range e
    // l'indice smette di potare, restando valido e inutile.
    expect(
      await one(
        mig,
        `SELECT o.opcname FROM pg_index i
           JOIN pg_class ic  ON ic.oid = i.indexrelid
           JOIN pg_opclass o ON o.oid  = i.indclass[0]
          WHERE ic.relname = 'session_ended_brin'`,
      ),
    ).toBe('timestamptz_minmax_multi_ops');
  });

  it('le sessioni esistono solo sulla riga di rete', async () => {
    // Una sessione attraversa piu' server: attribuirla a uno vorrebbe dire
    // mentire, quindi il database lo impedisce invece di sperarlo.
    await mig.query(
      `INSERT INTO stats.rollup_1d
         (day, server_id, samples, covered_s, expected_s, player_seconds, players_max, sessions)
       VALUES ('2026-08-20', 0, 2880, 86400, 86400, 100, 7, 31)`,
    );
    await expect(
      mig.query(
        `INSERT INTO stats.rollup_1d
           (day, server_id, samples, covered_s, expected_s, player_seconds, players_max, sessions)
         VALUES ('2026-08-20', 1, 2880, 86400, 86400, 100, 7, 31)`,
      ),
    ).rejects.toThrow();
  });

  it('expected_s ammette solo le tre durate che un giorno civile puo` avere', async () => {
    await expect(
      mig.query(
        `INSERT INTO stats.rollup_1d
           (day, server_id, samples, covered_s, expected_s, player_seconds, players_max)
         VALUES ('2026-03-29', 0, 2760, 82800, 86401, 100, 7)`,
      ),
    ).rejects.toThrow();
  });
});

describe('privilegi: il ruolo di lettura non puo` scrivere nemmeno volendo', () => {
  let lettura: pg.Client;

  beforeAll(async () => {
    lettura = await connect(testDb.statsUrl, 'metamc-test-stats-ro');
  });
  afterAll(async () => {
    await lettura?.end().catch(() => undefined);
  });

  it('e` in sola lettura per impostazione del RUOLO, non del pool', async () => {
    // `default_transaction_read_only` si applica al login: un pool che
    // dimenticasse di impostarlo non aprirebbe comunque una falla.
    expect(await one(lettura, 'SHOW default_transaction_read_only')).toBe('on');
    await expect(
      lettura.query(`INSERT INTO stats.mode (mode_key, display_name) VALUES ('y','Y')`),
    ).rejects.toThrow();
  });

  it('legge le viste, non le tabelle di fatto', async () => {
    // Chi leggesse `sample_server` o i rollup nudi disegnerebbe zeri al posto
    // dei buchi e medie con il denominatore preso dalle righe sbagliate. La
    // semantica vive nelle viste, quindi il GRANT sta li'.
    await expect(lettura.query('SELECT 1 FROM stats.v_online_1h LIMIT 1')).resolves.toBeDefined();
    await expect(lettura.query('SELECT 1 FROM stats.sample_server LIMIT 1')).rejects.toThrow();
    await expect(lettura.query('SELECT 1 FROM stats.poll_cycle LIMIT 1')).rejects.toThrow();
    await expect(lettura.query('SELECT 1 FROM stats.rollup_1h LIMIT 1')).rejects.toThrow();
  });
});

describe('il pannello puo` gestire il dizionario e nient`altro', () => {
  let app: pg.Client;

  beforeAll(async () => {
    app = await connect(testDb.appUrl, 'metamc-test-app');
  });
  afterAll(async () => {
    await app?.end().catch(() => undefined);
  });

  it('crea e modifica modalita` e alias', async () => {
    // E' il modulo «modalita'» (livello `gestione` su `statistiche`): passa
    // dal ruolo della fase 1 perche' e' l'unico che ha la sessione, il
    // contesto di autorizzazione e il registro attivita' in cui scrivere il
    // prima e il dopo di ogni modifica.
    await app.query(`INSERT INTO stats.mode (mode_key, display_name) VALUES ('duels','Duels')`);
    await app.query(`UPDATE stats.mode SET display_name = 'Duels 1v1' WHERE mode_key = 'duels'`);
    await app.query(
      `INSERT INTO stats.mode_alias (match_kind, match_value, mode_id)
       SELECT 'prefix', 'duels_', mode_id FROM stats.mode WHERE mode_key = 'duels'`,
    );
  });

  it('non tocca i fatti', async () => {
    await expect(app.query('SELECT 1 FROM stats.sample_server LIMIT 1')).rejects.toThrow();
    await expect(
      app.query(
        `INSERT INTO stats.poll_cycle (tick_at, run_id, status, delta_s, players)
         VALUES (now(), gen_random_uuid(), 'ok', 30, 1)`,
      ),
    ).rejects.toThrow();
  });
});

describe('il fuso di registrationDate e` un fuso, non un offset (012)', () => {
  // La sonda del passo 0, in produzione ad agosto, ha misurato +120 minuti su
  // 102 campioni recenti. Memorizzare quel 120 e applicarlo per sempre — come
  // prevedeva la 011 con `registration_offset_min` — sbaglierebbe di un'ora
  // OGNI registrazione fatta d'inverno, e sposterebbe di un giorno chiunque si
  // registri fra mezzanotte e l'una. Errore stabile, plausibile, permanente:
  // esattamente la classe contro cui e' costruito il resto dello schema.
  const asUtc = (raw: string) =>
    one<string>(
      mig,
      `SELECT (stats.registered_at_of($1, s.registration_tz) AT TIME ZONE 'UTC')::text
         FROM stats.ingest_state s WHERE s.id = 1`,
      [raw],
    );

  it('il fuso misurato e` memorizzato come nome, non come minuti', async () => {
    expect(await one(mig, 'SELECT registration_tz FROM stats.ingest_state WHERE id = 1')).toBe('Europe/Rome');
  });

  it('la stessa ora di parete cade su due istanti diversi a luglio e a gennaio', async () => {
    // E' LA prova. Con un offset costante questi due sarebbero sfalsati di sei
    // mesi esatti e zero minuti; sono invece sfalsati anche di un'ora.
    expect(await asUtc('2024-07-20 09:46:17.0')).toBe('2024-07-20 07:46:17'); // CEST, +2
    expect(await asUtc('2024-01-20 09:46:17.0')).toBe('2024-01-20 08:46:17'); // CET,  +1
  });

  it('senza dato o senza fuso restituisce NULL invece di indovinare', async () => {
    const call = (raw: string | null, tz: string | null) =>
      one(mig, 'SELECT stats.registered_at_of($1, $2)', [raw, tz]);
    expect(await call(null, 'Europe/Rome')).toBeNull();
    expect(await call('2024-07-20 09:46:17.0', null)).toBeNull();
    expect(await call('', 'Europe/Rome')).toBeNull();
  });

  it('la colonna superata non esiste piu`', async () => {
    // Due sorgenti per lo stesso fatto sono il modo in cui una delle due
    // diventa quella sbagliata senza che nessuno se ne accorga.
    expect(
      Number(
        await one(
          mig,
          `SELECT count(*) FROM information_schema.columns
            WHERE table_schema = 'stats' AND table_name = 'ingest_state'
              AND column_name = 'registration_offset_min'`,
        ),
      ),
    ).toBe(0);
  });

  it('un nome di fuso malformato viene rifiutato', async () => {
    await expect(
      mig.query(`UPDATE stats.ingest_state SET registration_tz = 'non un fuso' WHERE id = 1`),
    ).rejects.toThrow();
  });
});
