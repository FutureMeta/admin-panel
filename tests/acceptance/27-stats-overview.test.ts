// L'endpoint della panoramica. Fase 2, passo 4 — e il suo cancello.
//
// QUI SI VEDE SE LA CATENA HA SENSO. I passi precedenti producono numeri
// giusti in tabelle che nessuno guarda; questo li mette nella forma in cui
// finiranno su uno schermo, ed e' la forma il punto:
//
//  * il buco e' un `null`, mai uno zero. Uno zero al posto di un buco
//    trasforma un guasto in un evento di business e falsa ogni media a valle,
//    in modo permanente e plausibile;
//  * il breakdown chiude sul totale, perche' `__transit__` e `__unknown__`
//    sono serie visibili. Senza, la torta non somma mai e il primo che se ne
//    accorge normalizza le percentuali — cioe' spalma i non classificati
//    sulle modalita' vere;
//  * gli array paralleli hanno la stessa lunghezza. Un disallineamento di un
//    elemento non solleva niente: il grafico disegna, e mostra numeri
//    corretti sotto l'etichetta sbagliata. E' il difetto peggiore perche' non
//    ha sintomi.
//
// Il cancello del passo 4 e' il range 90g, il piu' pesante, sotto i 500 ms
// senza cache.

import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createKysely, createPool, type Database } from '#src/db/pool.ts';
import { assertPayload } from '#src/stats/contract.ts';
import { buildAll, buildOverview } from '#src/stats/read.ts';
import { connect, createTestDatabase, type TestDatabase } from '#tests/support/postgres.ts';

let testDb: TestDatabase;
let pool: pg.Pool;
/** Il pool di SOLA LETTURA: e' quello che usera' la rotta. */
let db: Database;
let sql: pg.Client;

const ARENA = 'duels_1';
/** Un istante fissato: due `new Date()` diversi sposterebbero gli assi. */
const FIXED_NOW = new Date();
const EVENTO = 'evento_1';

beforeAll(async () => {
  testDb = await createTestDatabase('overview');
  pool = createPool({
    connectionString: testDb.statsUrl,
    // QUATTRO, non otto come in produzione. Su questa macchina Postgres
    // accetta le connessioni UNA ALLA VOLTA, ~750 ms ciascuna (misurato):
    // otto pool aperti insieme da piu` suite parallele sforano qualunque
    // timeout di acquisizione. Le nove query del payload si accodano su
    // quattro connessioni e le riusano, che qui costa meno che aprirne altre.
    max: 4,
    applicationName: 'metamc-test-stats-read',
    connectionTimeoutMillis: 20_000,
    statementTimeout: '10s',
    searchPath: 'stats, public',
  });
  db = createKysely(pool);
  sql = await connect(testDb.migrateUrl, 'metamc-test-overview-sql');
}, 180_000);

afterAll(async () => {
  await sql?.end().catch(() => undefined);
  await db?.destroy().catch(() => undefined);
  await testDb?.drop();
});

beforeEach(async () => {
  await sql.query(`
    DELETE FROM stats.rollup_1d; DELETE FROM stats.rollup_1h; DELETE FROM stats.rollup_5m;
    DELETE FROM stats.mode_alias; DELETE FROM stats.mode;
    DELETE FROM stats.server WHERE server_id > 1;`);
});

/** Due modalita' vere, cosi' le serie hanno un nome e non sono tutte `__unknown__`. */
async function dictionary(): Promise<void> {
  // Uno statement per query: con i parametri `pg` usa il protocollo esteso,
  // che non accetta piu' istruzioni insieme.
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
}

/**
 * N giorni di storico orario.
 *
 * L'arena c'e' a ogni ora con 150 giocatori medi; l'evento solo a mezzogiorno,
 * con 200. Copertura piena, tranne dove `holeHours` dice di saltare — e li'
 * non si scrive NIENTE, che e' come si rappresenta un buco.
 */
async function seedHours(days: number, holeHours: number[] = []): Promise<void> {
  await sql.query(
    `WITH h AS (
       SELECT g AS bucket, extract(hour FROM g AT TIME ZONE 'Europe/Rome')::int AS ora
         FROM generate_series(date_trunc('hour', now()) - make_interval(days => $1::int),
                              date_trunc('hour', now()) - interval '1 hour',
                              interval '1 hour') g
        WHERE extract(hour FROM g AT TIME ZONE 'Europe/Rome')::int <> ALL ($2::int[])
     )
     INSERT INTO stats.rollup_1h
       (bucket, server_id, samples, covered_s, player_seconds, players_max, players_max_at)
     SELECT h.bucket, v.server_id, 120, 3600,
            CASE v.server_id
              WHEN 0 THEN (150 + CASE WHEN h.ora = 12 THEN 200 ELSE 0 END) * 3600
              ELSE CASE WHEN v.server_key = $3 THEN 150 * 3600
                        ELSE CASE WHEN h.ora = 12 THEN 200 * 3600 ELSE 0 END END
            END,
            CASE v.server_id
              WHEN 0 THEN 150 + CASE WHEN h.ora = 12 THEN 200 ELSE 0 END
              ELSE CASE WHEN v.server_key = $3 THEN 150 ELSE CASE WHEN h.ora = 12 THEN 200 ELSE 0 END END
            END,
            h.bucket
       FROM h CROSS JOIN stats.server v
      WHERE v.server_id = 0 OR v.server_key IN ($3, $4)
        -- La convenzione sparsa: dove non c'era nessuno non si scrive la riga.
        AND NOT (v.server_key = $4 AND h.ora <> 12)`,
    [days, holeHours, ARENA, EVENTO],
  );
  // Il livello giornaliero, per il range 1y.
  await sql.query(
    `INSERT INTO stats.rollup_1d
       (day, server_id, samples, covered_s, expected_s, player_seconds, players_max, players_max_at)
     SELECT stats.civil_day(bucket), server_id, sum(samples)::int, sum(covered_s)::int,
            stats.day_seconds(stats.civil_day(bucket)), sum(player_seconds),
            max(players_max), max(players_max_at)
       FROM stats.rollup_1h GROUP BY 1, 2
     ON CONFLICT DO NOTHING`,
  );
}

describe('la forma del payload e` verificata prima di spedirlo', () => {
  beforeEach(async () => {
    await dictionary();
    await seedHours(10);
  });

  it('ogni range produce un payload valido', async () => {
    for (const range of ['24h', '7d', '30d', '90d', '1y'] as const) {
      const { payload } = await buildOverview(db, range);
      expect(() => assertPayload(payload), `range ${range}`).not.toThrow();
      expect(payload.v).toBe(2);
      expect(payload.tz).toBe('Europe/Rome');
      expect(payload.online.total).toHaveLength(payload.online.t.length);
      expect(payload.heatmap.v).toHaveLength(168);
    }
  });

  it('l`asse dei tempi non ha buchi: il buco sta nei VALORI', async () => {
    const { payload } = await buildOverview(db, '7d');
    const t = payload.online.t;
    for (let i = 1; i < t.length; i += 1) {
      expect((t[i] as number) - (t[i - 1] as number)).toBe(payload.bucketSec);
    }
  });

  it('le modalita` hanno un nome, e il totale non e` una di loro', async () => {
    const { payload } = await buildOverview(db, '7d');
    expect(payload.modes).toContain('arena');
    expect(payload.modes).toContain('eventi');
    expect(payload.modes).not.toContain('__network__');
    expect(payload.labels['arena']).toBe('Arena');
    for (const m of payload.modes) expect(payload.online.series[m]).toBeDefined();
  });
});

describe('l`evento intermittente non diventa la modalita` piu` popolosa', () => {
  beforeEach(async () => {
    await dictionary();
    await seedHours(10);
  });

  it('a un`ora su ventiquattro, l`evento vale una frazione dell`arena', async () => {
    // Con il denominatore preso dalle righe dell'evento uscirebbe 200, cioe'
    // sopra l'arena. E' lo stesso difetto del rollup, che qui si
    // ripresenterebbe in lettura se il payload dividesse per la copertura
    // sbagliata.
    const { payload } = await buildOverview(db, '30d');
    const arena = payload.online.series['arena']?.filter((v) => v !== null) ?? [];
    const eventi = payload.online.series['eventi']?.filter((v) => v !== null) ?? [];
    const media = (a: (number | null)[]) =>
      (a.reduce((s, v) => (s as number) + (v ?? 0), 0) as number) / Math.max(1, a.length);

    expect(media(arena)).toBeGreaterThan(media(eventi));
    expect(media(eventi)).toBeLessThan(60);
  });
});

describe('i buchi restano buchi', () => {
  beforeEach(async () => {
    await dictionary();
    // Tre serate perse, come un deploy fatto sempre alla stessa ora.
    await seedHours(10, [20, 21, 22]);
  });

  it('le ore mancanti sono null, non zero', async () => {
    const { payload } = await buildOverview(db, '7d');
    const nulli = payload.online.total.filter((v) => v === null).length;
    const zeri = payload.online.total.filter((v) => v === 0).length;
    expect(nulli).toBeGreaterThan(0);
    expect(zeri).toBe(0);
  });

  it('la copertura racconta il buco, e la media normalizzata non lo subisce', async () => {
    // E' il punto della §6.5: i buchi non sono mai indipendenti dall'ora del
    // giorno. Se la media fosse player_seconds/covered_s sul periodo intero,
    // perdere tre ore SERALI la sposterebbe; normalizzata sul profilo orario,
    // sposta la copertura e non la media.
    const { payload } = await buildOverview(db, '7d');
    expect(payload.kpi.coverage).toBeLessThan(0.9);
    expect(payload.kpi.coverage).toBeGreaterThan(0.8);
    expect(payload.kpi.avg).not.toBeNull();
  });
});

describe('il cancello del passo 4', () => {
  it('il range 90g, il piu` pesante, resta servibile senza cache', async () => {
    await dictionary();
    await seedHours(90);
    // Un giro a vuoto per non misurare la prima pianificazione.
    await buildOverview(db, '90d');
    const t0 = Date.now();
    const { payload, queryMs } = await buildOverview(db, '90d');
    const totalMs = Date.now() - t0;
    assertPayload(payload);

    // Il numero si STAMPA, non solo si asserisce: una soglia dice «passa o
    // no», il numero dice quanto margine e' rimasto, ed e' quello che serve
    // per accorgersi che si sta consumando prima che finisca.
    //
    // Misurato: ~260 ms di query su novanta giorni di storico orario, dentro
    // la suite in parallelo. Il cancello del passo 4 e' 500 ms senza cache.
    console.log(`[90d] query ${queryMs} ms, totale ${totalMs} ms`);
    expect(queryMs).toBeLessThan(500);
    expect(totalMs).toBeLessThan(500);
  });
});

describe('il record di sempre', () => {
  beforeEach(async () => {
    await dictionary();
    await seedHours(10);
  });

  it('e` il massimo di TUTTO lo storico, non della finestra', async () => {
    // Un picco fuori dalla finestra del range: il record deve vederlo lo
    // stesso, perche' «record» non significa «record del periodo scelto».
    await sql.query(
      `UPDATE stats.rollup_1d SET players_max = 4242
         WHERE server_id = 0 AND day = stats.civil_day(now()) - 9`,
    );

    const { payload } = await buildOverview(db, '24h');
    expect(payload.record?.players).toBe(4242);
  });

  it('porta la data da cui si guarda', async () => {
    // Un «record di sempre» calcolato su tre giorni di raccolta e` un record
    // di tre giorni: senza questa data, chi legge non ha modo di saperlo.
    const { payload } = await buildOverview(db, '7d');
    expect(payload.record?.since).toBeGreaterThan(0);
  });

  it('e` nullo quando non c`e` nemmeno un giorno con dati', async () => {
    await sql.query('DELETE FROM stats.rollup_1d');
    const { payload } = await buildOverview(db, '7d');
    // Nullo, non zero: zero direbbe «il record e` zero giocatori».
    expect(payload.record).toBeNull();
  });
});

describe('gli unici seguono il selettore, e il giorno mancante e` un buco', () => {
  beforeEach(async () => {
    await dictionary();
    await seedHours(40);
  });

  it('la finestra e` quella del range, non trenta giorni fissi', async () => {
    const week = await buildOverview(db, '7d');
    const month = await buildOverview(db, '30d');

    // Chi clicca «7g» si aspetta che la pagina risponda: prima questo
    // grafico restava a trenta giorni qualunque cosa si scegliesse.
    expect(week.payload.uniques.t.length).toBeLessThan(month.payload.uniques.t.length);
    expect(week.payload.uniques.t).toHaveLength(8);
    expect(month.payload.uniques.t).toHaveLength(31);
  });

  it("l'asse arriva a OGGI anche se la riga di oggi non esiste ancora", async () => {
    // La riga giornaliera nasce quando il primo bucket orario viene
    // aggregato: a mezzanotte e mezza non c`e` ancora. Disegnando solo i
    // giorni tornati dalla query, il grafico finiva a ieri — e non c`era
    // modo di distinguerlo da un guasto del campionamento.
    await sql.query('DELETE FROM stats.rollup_1d WHERE day = stats.civil_day(now())');

    const { payload } = await buildOverview(db, '7d');
    const t = payload.uniques.t;
    const last = t[t.length - 1] as number;

    // L`ultimo punto E` oggi...
    const today = new Date();
    const romeToday = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Rome',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(today);
    const lastLabel = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Rome',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(last * 1000));
    expect(lastLabel).toBe(romeToday);

    // ...e il suo valore viene dalla FONTE, non dal rollup. Zero qui significa
    // «ho guardato `player_day` e oggi non c'e` ancora nessuno», che e` un
    // fatto: un `null` direbbe «non lo so», e invece lo sappiamo.
    expect(payload.uniques.v[payload.uniques.v.length - 1]).toBe(0);
  });

  it("l'asse dei giorni non salta ne` ripete", async () => {
    const { payload } = await buildOverview(db, '30d');
    const t = payload.uniques.t;
    for (let i = 1; i < t.length; i += 1) {
      const delta = (t[i] as number) - (t[i - 1] as number);
      // 23, 24 o 25 ore: i giorni di cambio ora sono giorni civili come gli
      // altri, e l`asse li deve contenere senza doppioni.
      expect(delta, `punto ${i}`).toBeGreaterThanOrEqual(82_800);
      expect(delta, `punto ${i}`).toBeLessThanOrEqual(90_000);
    }
    expect(new Set(t).size).toBe(t.length);
  });
});

describe('la distribuzione per modalita` NON segue il selettore', () => {
  beforeEach(async () => {
    await dictionary();
    await seedHours(40);
    // Un bucket da cinque minuti recente: e` da li` che esce la popolazione
    // corrente, qualunque periodo sia scelto.
    await sql.query(
      `INSERT INTO stats.rollup_5m
         (bucket, server_id, samples, covered_s, player_seconds, players_max, players_max_at)
       SELECT date_trunc('hour', now()), v.server_id, 10, 300,
              CASE v.server_id WHEN 0 THEN 250 * 300 ELSE 125 * 300 END,
              CASE v.server_id WHEN 0 THEN 250 ELSE 125 END,
              date_trunc('hour', now())
         FROM stats.server v
        WHERE v.server_id = 0 OR v.server_key IN ($1, $2)
       ON CONFLICT DO NOTHING`,
      [ARENA, EVENTO],
    );
  });

  it('e` la stessa per ogni range', async () => {
    const seen: string[] = [];
    for (const range of ['24h', '7d', '30d', '90d', '1y'] as const) {
      const { payload } = await buildOverview(db, range);
      expect(payload.current, `range ${range}`).not.toBeNull();
      seen.push(JSON.stringify(payload.current?.byMode));
    }
    // Prima usciva dall`ultimo punto della serie del range: su un anno era la
    // MEDIA DI UN GIORNO INTERO presentata come popolazione corrente, e
    // cambiava scegliendo un altro periodo.
    expect(new Set(seen).size).toBe(1);
  });

  it('viene dall`ultimo bucket da cinque minuti, non dalla media del periodo', async () => {
    const { payload } = await buildOverview(db, '1y');
    // 125 giocatori per modalita` nel bucket recente, contro i 150/200 medi
    // dello storico orario: se leggesse il periodo, questi numeri sarebbero
    // altri.
    expect(payload.current?.byMode['arena']).toBeCloseTo(125, 0);
  });
});

describe('gli unici di OGGI non aspettano il rollup', () => {
  beforeEach(async () => {
    await dictionary();
    await seedHours(10);
  });

  it('oggi si legge da player_day anche senza riga giornaliera', async () => {
    // La riga di rollup_1d nasce solo dopo che la PRIMA ORA del giorno e'
    // chiusa e aggregata: fra mezzanotte e circa l'1:20 non esiste. Prima
    // di questa correzione il grafico restava senza barra per oggi, e la
    // carta KPI mostrava un trattino, ogni notte.
    await sql.query('DELETE FROM stats.rollup_1d WHERE day = stats.civil_day(now())');
    await sql.query(
      `INSERT INTO stats.player_day (day, player_id, first_seen_at, last_seen_at, sessions)
       SELECT stats.civil_day(now()), g, now(), now(), 1
         FROM generate_series(1, 37) g
       ON CONFLICT DO NOTHING`,
    );

    const { payload } = await buildOverview(db, '7d');
    const last = payload.uniques.v[payload.uniques.v.length - 1];
    expect(last).toBe(37);

    // E non e' definitivo: il giorno sta ancora succedendo.
    expect(payload.uniques.final[payload.uniques.final.length - 1]).toBe(false);
  });

  it('la fonte vince sul rollup, che e` indietro di un quarto d`ora', async () => {
    // La chiusura giornaliera ricopia questo stesso conteggio ogni quindici
    // minuti: nel frattempo la fonte e' avanti, e mostrare il numero vecchio
    // sarebbe una scelta senza vantaggi.
    await sql.query(
      `INSERT INTO stats.player_day (day, player_id, first_seen_at, last_seen_at, sessions)
       SELECT stats.civil_day(now()), g, now(), now(), 1
         FROM generate_series(1, 50) g
       ON CONFLICT DO NOTHING`,
    );
    await sql.query(
      'UPDATE stats.rollup_1d SET uniques = 9 WHERE day = stats.civil_day(now()) AND server_id = 0',
    );

    const { payload } = await buildOverview(db, '7d');
    expect(payload.uniques.v[payload.uniques.v.length - 1]).toBe(50);
  });
});

describe("l'istante del picco non dipende da quanto e` largo un bucket", () => {
  beforeEach(async () => {
    await dictionary();
    await seedHours(40);
    // Un massimo netto, in un istante preciso dentro la sua ora.
    await sql.query(
      `UPDATE stats.rollup_1h
          SET players_max = 4242, players_max_at = bucket + interval '37 minutes'
        WHERE server_id = 0 AND bucket = date_trunc('hour', now()) - interval '30 hours'`,
    );
  });

  it('7g e 90g danno lo stesso valore E lo stesso minuto', async () => {
    const week = await buildOverview(db, '7d');
    const quarter = await buildOverview(db, '90d');

    expect(week.payload.kpi.peak).toBe(4242);
    expect(quarter.payload.kpi.peak).toBe(4242);

    // Prima si mostrava l`INIZIO del bucket: con bucket da un`ora usciva
    // 20:00, con bucket da sei ore 18:00. Due risposte diverse alla stessa
    // domanda, entrambe verificabili solo da chi sapeva quanto e` largo un
    // bucket in quel range.
    expect(quarter.payload.kpi.peakAt).toBe(week.payload.kpi.peakAt);
  });

  it("l'istante e` quello del massimo, non l'inizio dell'ora", async () => {
    const { payload } = await buildOverview(db, '7d');
    const at = payload.kpi.peakAt as number;
    // 37 minuti dopo lo scoccare dell`ora, come seminato.
    expect(new Date(at * 1000).getUTCMinutes()).toBe(37);
  });
});

describe('la panoramica non paga i payload per modalita` che nessuno ha chiesto', () => {
  beforeEach(async () => {
    await dictionary();
    await seedHours(10);
  });

  it('costruisce solo le modalita` richieste', async () => {
    const nessuna = await buildAll(db, '7d', undefined, []);
    const una = await buildAll(db, '7d', undefined, ['arena']);
    const tutte = await buildAll(db, '7d');

    expect(nessuna.perMode.size).toBe(0);
    expect([...una.perMode.keys()]).toEqual(['arena']);
    expect(tutte.perMode.size).toBeGreaterThan(1);
  });

  it('e la panoramica esce IDENTICA nei tre casi', async () => {
    // IL PUNTO DI QUESTO TEST. Saltare le query per modalita` e` lecito
    // solo se la panoramica non ne legge nemmeno una riga: se un giorno
    // ne leggesse una, aprire il pannello e aprire il dettaglio di una
    // modalita` mostrerebbero due panoramiche diverse — e la differenza
    // dipenderebbe da cosa qualcun altro ha guardato di recente.
    const nessuna = await buildAll(db, '90d', FIXED_NOW, []);
    const tutte = await buildAll(db, '90d', FIXED_NOW);
    expect(nessuna.overview).toEqual(tutte.overview);
  });
});

describe('nomi e colori non dipendono dal periodo scelto', () => {
  beforeEach(async () => {
    await dictionary();
    await sql.query("UPDATE stats.mode SET color = '#112233' WHERE mode_key = 'arena'");
    // STORICO ORARIO MA NESSUN ROLLUP GIORNALIERO: e` la situazione di una
    // rete accesa da pochi giorni, dove il range 1y non ha nemmeno un punto.
    await sql.query(
      `INSERT INTO stats.rollup_1h
         (bucket, server_id, samples, covered_s, player_seconds, players_max, players_max_at)
       SELECT g, v.server_id, 120, 3600, 150 * 3600, 150, g
         FROM generate_series(date_trunc('hour', now()) - interval '3 days',
                              date_trunc('hour', now()) - interval '1 hour', interval '1 hour') g
         CROSS JOIN stats.server v
        WHERE v.server_id = 0 OR v.server_key IN ($1, $2)`,
      [ARENA, EVENTO],
    );
  });

  it('un range senza storico porta comunque il dizionario intero', async () => {
    const giorno = await buildOverview(db, '24h');
    const anno = await buildOverview(db, '1y');

    // La premessa del test: sul 1y non c`e` nessuna serie.
    expect(anno.payload.modes).toEqual([]);

    // IL DIFETTO CHE QUESTO TEST FERMA: i nomi venivano ritagliati su
    // `modes`, quindi sul 1y erano vuoti e la schermata ripiegava sulla
    // chiave grezza — «arena» minuscolo dove ovunque altrove c`e` «Arena».
    expect(anno.payload.labels).toEqual(giorno.payload.labels);
    expect(anno.payload.labels.arena).toBe('Arena');
  });

  it('il colore viene dal dizionario, non da una posizione', async () => {
    const giorno = await buildOverview(db, '24h');
    const anno = await buildOverview(db, '1y');

    expect(giorno.payload.colors.arena).toBe('#112233');
    // Lo stesso colore su un range che non conosce quella modalita`: un
    // colore assegnato per indice sulla lista del range qui cambierebbe, e
    // la stessa modalita` avrebbe due colori in due schermate affiancate.
    expect(anno.payload.colors).toEqual(giorno.payload.colors);
  });

  it('i sentinella hanno un nome, il totale non e` una modalita`', async () => {
    // Un server SENZA alias: e` l'unico modo in cui `__unknown__` esiste, ed
    // e` anche l'unico in cui puo` comparire nei dati. Le due condizioni sono
    // la stessa, quindi il nome c'e` sempre quando serve.
    await sql.query('INSERT INTO stats.server (server_key) VALUES ($1)', ['orfano_1']);
    const { payload } = await buildOverview(db, '24h');

    // SERIE VISIBILI, quindi devono avere un nome: la torta chiude sul totale
    // solo se ci sono, e senza nome la schermata mostrerebbe «__transit__».
    expect(payload.labels.__transit__).toBe('In transito');
    expect(payload.labels.__unknown__).toBe('Non classificata');

    // Il totale non e` una modalita`: nessun riquadro lo disegna come serie, e
    // lasciarlo in elenco sposterebbe di un posto i colori di ripiego, che si
    // scelgono per posizione nel dizionario.
    expect(payload.labels.__network__).toBeUndefined();
  });

  it('una modalita` senza colore non ne riceve uno inventato', async () => {
    const { payload } = await buildOverview(db, '24h');
    // Riempire il buco qui farebbe sembrare deciso cio` che non lo e`, e
    // nessuno andrebbe piu` a impostarlo davvero.
    expect(payload.colors.eventi).toBeUndefined();
    expect(payload.labels.eventi).toBe('Eventi');
  });
});

describe('i due interruttori del dizionario hanno un effetto, e nessuno tocca un totale', () => {
  beforeEach(async () => {
    await dictionary();
    await seedHours(10);
  });

  it('prima: nessuno dei due e` acceso, quindi gli elenchi sono vuoti', async () => {
    const { payload } = await buildOverview(db, '7d');
    expect(payload.hidden).toEqual([]);
    expect(payload.outOfBreakdown).toEqual([]);
  });

  it('`hidden` arriva alla schermata', async () => {
    await sql.query("UPDATE stats.mode SET hidden = true WHERE mode_key = 'eventi'");
    const { payload } = await buildOverview(db, '7d');
    expect(payload.hidden).toEqual(['eventi']);
  });

  it('`in_breakdown = false` arriva alla schermata', async () => {
    await sql.query("UPDATE stats.mode SET in_breakdown = false WHERE mode_key = 'eventi'");
    const { payload } = await buildOverview(db, '7d');
    expect(payload.outOfBreakdown).toEqual(['eventi']);
  });

  it('IL VINCOLO: spegnere una modalita` non sposta un solo numero', async () => {
    // Nascondere una serie non deve MAI cambiare un totale, o «nascondi»
    // diventa un altro nome per «falsifica» — e chi guarda non avrebbe modo
    // di accorgersene. La riga di rete e` misurata, non sommata dalle
    // modalita`, quindi il vincolo si puo` davvero rispettare.
    const prima = await buildOverview(db, '7d', FIXED_NOW);
    await sql.query("UPDATE stats.mode SET hidden = true, in_breakdown = false WHERE mode_key = 'eventi'");
    const dopo = await buildOverview(db, '7d', FIXED_NOW);

    expect(dopo.payload.kpi).toEqual(prima.payload.kpi);
    expect(dopo.payload.online.total).toEqual(prima.payload.online.total);
    expect(dopo.payload.online.series).toEqual(prima.payload.online.series);
    expect(dopo.payload.modes).toEqual(prima.payload.modes);
    expect(dopo.payload.heatmap).toEqual(prima.payload.heatmap);
    // Cambia SOLO cio` che la schermata deve sapere per disegnare.
    expect(dopo.payload.hidden).toEqual(['eventi']);
    expect(dopo.payload.outOfBreakdown).toEqual(['eventi']);
  });

  it('il totale di rete non e` una modalita`, quindi non compare in nessuno dei due', async () => {
    // OGGI E` VERO PER COSTRUZIONE, non per il filtro: `v_server_mode` da` a
    // `__network__` il nome da un CASE e i due interruttori dal `coalesce`
    // sul LEFT JOIN, che per la riga di rete non trova niente — quindi
    // `hidden = false` e `in_breakdown = true`. Il filtro esplicito in
    // `dictionaryFlags` e` difensivo e questo test non lo esercita.
    //
    // Serve lo stesso: se un giorno la vista cambiasse e la riga di rete
    // comparisse fra le escluse, i suoi giocatori verrebbero annunciati come
    // «fuori dalla ripartizione» — cioe` il totale contato una seconda volta
    // come se fosse nascosto. Questo test lo intercetta li'.
    const { payload } = await buildOverview(db, '7d');
    expect(payload.outOfBreakdown).not.toContain('__network__');
    expect(payload.hidden).not.toContain('__network__');
  });
});
