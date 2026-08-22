// I payload delle due schermate duels, nella forma in cui finiranno su uno
// schermo.
//
// LE DATE QUI SONO FISSE E IL TEMPO E' UN PARAMETRO. `trends(range, now)`
// prende l'istante da fuori, quindi non c'e' niente da fingere e niente che
// invecchi: si semina il 24 agosto 2026 — un LUNEDI' — e si chiede il payload
// come se fosse quel giorno. Un test che dipendesse dall'orologio della
// macchina passerebbe oggi e fallirebbe di sabato.
//
// COSA SI ROMPE IN SILENZIO QUI, e sono tre cose:
//
//  1. Lo ZERO AL POSTO DEL BUCO. Un bucket prima dell'inizio della raccolta
//     deve valere `null`: uno zero dice «nessuna partita giocata», cioe'
//     trasforma «non lo sappiamo» in un fatto, e la media a valle e' sbagliata
//     per sempre.
//  2. La HEATMAP CHE RUOTA di una riga. MySQL conta i giorni da lunedi' = 0,
//     PostgreSQL da lunedi' = 1: senza il `- 1` il picco del sabato sera si
//     legge come domenica, e sembra plausibile.
//  3. Il TAGLIO A 25 che porta via il totale. Se le quote si calcolassero
//     sulle righe spedite invece che sull'insieme completo, sommerebbero al
//     100% lo stesso — ma di un insieme diverso da quello che l'utente crede
//     di guardare.

import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createKysely, createPool, type Database } from '#src/db/pool.ts';
import { PgDuelsProvider } from '#src/duels/pg.ts';
import { BadCursor } from '#src/duels/provider.ts';
import { connect, createTestDatabase, type TestDatabase } from '#tests/support/postgres.ts';

let testDb: TestDatabase;
let pool: pg.Pool;
/** Il pool di SOLA LETTURA: e' quello che usera' la rotta. */
let db: Database;
let sql: pg.Client;
let duels: PgDuelsProvider;

/** 2026-08-24 e` un LUNEDI'. Le 12:00 UTC sono le 14:00 a Roma d'estate. */
const LUNEDI = '2026-08-24 12:00:00+00';
/** 2026-08-29 e` un SABATO. Le 20:00 UTC sono le 22:00 a Roma. */
const SABATO = '2026-08-29 20:00:00+00';

/** Meta` pomeriggio di quel lunedi', per la finestra scorrevole del 24h. */
const NOW_24H = new Date('2026-08-24T15:30:00Z');
/** Un istante che tiene dentro tutta la settimana seminata. */
const NOW_7D = new Date('2026-08-30T10:00:00Z');

beforeAll(async () => {
  testDb = await createTestDatabase('duelspay');
  pool = createPool({
    connectionString: testDb.statsUrl,
    max: 4,
    applicationName: 'metamc-test-duelspay',
    connectionTimeoutMillis: 20_000,
    statementTimeout: '10s',
    searchPath: 'stats, public',
  });
  db = createKysely(pool);
  duels = new PgDuelsProvider(db);
  sql = await connect(testDb.migrateUrl, 'metamc-test-duelspay-sql');
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
    UPDATE stats.duels_ingest_state SET since_day = DATE '2026-03-09';`);
});

async function mode(id: number, name: string, ranking = 'RANKED', color: string | null = null) {
  await sql.query(
    `INSERT INTO stats.duels_mode (mode_id, name, display_name, ranking, mode_type, color)
     VALUES ($1, $2, $2, $3, 'DUEL', $4)`,
    [id, name, ranking, color],
  );
}

async function map(id: number, name: string) {
  await sql.query(
    `INSERT INTO stats.duels_map (map_id, name, display_name, map_type) VALUES ($1, $2, $2, 'CLASSIC')`,
    [id, name],
  );
}

async function matches(
  at: string,
  n: number,
  opts: { mode?: number; map?: number; type?: string; context?: string } = {},
) {
  await sql.query(
    `INSERT INTO stats.duels_match_hour (bucket_at, mode_id, map_id, match_type, context, matches)
     VALUES (date_trunc('hour', $1::timestamptz), $2, $3, $4, $5, $6)
     ON CONFLICT (bucket_at, mode_id, map_id, match_type, context)
       DO UPDATE SET matches = stats.duels_match_hour.matches + EXCLUDED.matches`,
    [at, opts.mode ?? 1, opts.map ?? 10, opts.type ?? 'DUEL', opts.context ?? 'NORMAL', n],
  );
}

async function ratingDay(day: string, modeId: number, bars: [number, number, number, number, number]) {
  const n = bars.reduce((a, b) => a + b, 0);
  const sum = bars.reduce((a, b, i) => a + b * (i + 1), 0);
  await sql.query(
    `INSERT INTO stats.duels_rating_day (day, mode_id, n, sum_rating, with_comment, r1, r2, r3, r4, r5)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [day, modeId, n, sum, Math.min(n, 1), ...bars],
  );
}

async function rating(
  id: number,
  at: string,
  score: number,
  opts: { player?: string | null; comment?: string | null; mode?: number } = {},
) {
  await sql.query(
    `INSERT INTO stats.duels_rating
       (rating_id, created_at, match_id, player_id, player_name, mode_id, rating, comment)
     VALUES ($1::bigint, $2::timestamptz, gen_random_uuid(), $3::int, $4, $5, $6, $7)`,
    [
      id,
      at,
      id,
      opts.player === undefined ? 'Vally90' : opts.player,
      opts.mode ?? 1,
      score,
      opts.comment ?? null,
    ],
  );
}

describe('la finestra e la griglia, che decide il server', () => {
  it('il 24h ha 24 punti orari e INCLUDE l`ora in corso', async () => {
    // E` l'unico posto in cui si vede la cadenza da trenta secondi: senza
    // l'ora viva, una partita di cinque minuti fa non comparirebbe da nessuna
    // parte fino allo scoccare dell'ora.
    await mode(1, 'classic');
    await matches(LUNEDI, 3);
    const p = await duels.trends('24h', NOW_24H);

    expect(p.t).toHaveLength(24);
    expect(p.bucket).toBe('hour');
    expect(p.liveTail).toBe(true);
    // L'ultimo bucket e` quello che contiene NOW_24H, non quello prima.
    expect(new Date((p.t.at(-1) as number) * 1000).toISOString()).toBe('2026-08-24T15:00:00.000Z');
  });

  it('il 7d ha 168 punti orari e arriva a OGGI, non a ieri sera', async () => {
    // Prima finiva alla mezzanotte PASSATA, cioe` alle 23 di ieri: e` la prima
    // cosa che si nota aprendo la schermata, e nessuna spiegazione sul giorno
    // parziale regge davanti a quel vuoto. Ora la finestra arriva alla
    // mezzanotte che VERRA', e il parziale si dichiara invece di toglierlo.
    await mode(1, 'classic');
    const p = await duels.trends('7d', NOW_7D);

    expect(p.t).toHaveLength(168);
    expect(p.liveTail).toBe(true);
    // ULTIME 168 ORE, non «gli ultimi sette giorni civili»: alle 10:00 il
    // grafico finisce all'ora delle 10:00, non a mezzanotte di stasera. Con
    // l'allineamento ai giorni, le ore che restavano fino a stanotte erano
    // dentro la griglia ma vuote — mezzo grafico bianco con l'adesso a meta`.
    expect(new Date((p.t.at(-1) as number) * 1000).toISOString()).toBe('2026-08-30T10:00:00.000Z');
  });

  it('nessun periodo finisce nel FUTURO: l`ultimo bucket contiene adesso', async () => {
    // E` l'invariante che rende superfluo annullare i bucket futuri: se non ce
    // ne sono, non c'e' niente da annullare. Se un domani una finestra
    // superasse l'adesso, la coda si riempirebbe di zeri — «nessuna partita»
    // per ore che non sono ancora accadute.
    await mode(1, 'classic');
    const nowSec = Math.floor(NOW_7D.getTime() / 1000);

    for (const range of ['24h', '7d', '30d', '90d', '1y'] as const) {
      const p = await duels.trends(range, NOW_7D);
      const last = p.t.at(-1) as number;
      expect(last, range).toBeLessThanOrEqual(nowSec);
    }
  });

  it('il 30d conta 30 giorni CIVILI, non 720 ore', async () => {
    await mode(1, 'classic');
    const p = await duels.trends('30d', NOW_7D);
    expect(p.t).toHaveLength(30);
    expect(p.bucket).toBe('day');
  });

  it('l`anno sono 52 settimane che partono di LUNEDI`', async () => {
    await mode(1, 'classic');
    const p = await duels.trends('1y', NOW_7D);

    expect(p.t).toHaveLength(52);
    expect(p.bucket).toBe('week');
    for (const t of p.t) {
      // `getUTCDay()` sull'istante di mezzanotte di Roma da` il giorno giusto
      // perche` quell'istante cade nello stesso giorno civile per costruzione.
      const noon = new Date(t * 1000 + 12 * 3_600_000);
      expect(noon.getUTCDay(), new Date(t * 1000).toISOString()).toBe(1);
    }
  });
});

describe('il buco e` un valore, e non e` uno zero', () => {
  it('i bucket precedenti all`inizio della raccolta valgono `null`', async () => {
    // Uno zero direbbe «nessuna partita giocata quel giorno». Prima di quella
    // data non c'era la raccolta, e le due cose non sono la stessa cosa: la
    // seconda e` un fatto, la prima e` la sua assenza.
    await sql.query(`UPDATE stats.duels_ingest_state SET since_day = DATE '2026-08-26'`);
    await mode(1, 'classic');
    await matches('2026-08-27 12:00:00+00', 5);

    const p = await duels.trends('7d', NOW_7D);
    const serie = p.combos[0]?.v as (number | null)[];

    const primo = p.t.findIndex((t) => t * 1000 >= Date.parse('2026-08-26T00:00:00+02:00'));
    expect(
      serie.slice(0, primo).every((v) => v === null),
      'prima della raccolta',
    ).toBe(true);
    expect(
      serie.slice(primo).some((v) => v === 0),
      'dopo la raccolta, un vuoto vero',
    ).toBe(true);
  });

  it('senza `since` non si annulla niente di PASSATO: sono zeri veri', async () => {
    // Il verso opposto. Un annullamento che scattasse sempre svuoterebbe il
    // grafico, e il test qui sopra da solo non lo distinguerebbe.
    await sql.query(`UPDATE stats.duels_ingest_state SET since_day = NULL`);
    await mode(1, 'classic');
    await matches(LUNEDI, 5);

    const p = await duels.trends('7d', NOW_7D);
    const serie = p.combos[0]?.v ?? [];
    const nowSec = Math.floor(NOW_7D.getTime() / 1000);
    const past = serie.filter((_, i) => (p.t[i] as number) < nowSec);

    expect(past).not.toHaveLength(0);
    expect(past.every((v) => v !== null)).toBe(true);
  });
});

describe('le combinazioni di tipo e contesto viaggiano separate', () => {
  it('una serie per combinazione presente, e il totale e` la somma', async () => {
    // Le tab della schermata filtrano in memoria: se le combinazioni fossero
    // gia` sommate qui, cambiare tab richiederebbe una richiesta nuova e una
    // chiave di cache in piu` per ogni combinazione.
    await mode(1, 'classic');
    await matches(LUNEDI, 3, { type: 'DUEL', context: 'NORMAL' });
    await matches(LUNEDI, 2, { type: 'FFA', context: 'EVENT' });

    const p = await duels.trends('7d', NOW_7D);

    expect(p.combos).toHaveLength(2);
    expect(p.combos.map((c) => `${c.type}/${c.context}`)).toEqual(['DUEL/NORMAL', 'FFA/EVENT']);
    expect(p.totals.matches).toBe(5);
  });

  it('una combinazione assente non si inventa', async () => {
    await mode(1, 'classic');
    await matches(LUNEDI, 3, { type: 'DUEL', context: 'NORMAL' });
    const p = await duels.trends('7d', NOW_7D);
    expect(p.combos).toHaveLength(1);
  });
});

describe('la mappa di attivita` non ruota di una riga', () => {
  it('lunedi` alle 14 e` la cella 14, sabato alle 22 e` la cella 6*24+22', async () => {
    await mode(1, 'classic');
    await matches(LUNEDI, 7);
    await matches(SABATO, 4);

    const p = await duels.trends('7d', NOW_7D);

    expect(p.heatmap.cells).toHaveLength(168);
    expect(p.heatmap.cells[0 * 24 + 14], 'lunedi` 14:00').toBe(7);
    expect(p.heatmap.cells[5 * 24 + 22], 'sabato 22:00').toBe(4);
  });

  it('fuori periodo e` `null`, coperto e vuoto e` `0`', async () => {
    // Su ventiquattro ore il periodo tocca ventiquattro coppie (giorno, ora):
    // le altre 144 non sono «zero partite», sono fuori intervallo. Disegnarle
    // come zero direbbe che di domenica alle tre non gioca nessuno quando
    // domenica non e` nemmeno nella finestra.
    await mode(1, 'classic');
    await matches(LUNEDI, 7);

    const p = await duels.trends('24h', NOW_24H);
    const coperte = p.heatmap.cells.filter((c) => c !== null);

    expect(coperte).toHaveLength(24);
    expect(p.heatmap.cells[0 * 24 + 14]).toBe(7);
    expect(p.heatmap.cells[0 * 24 + 13], 'coperta e vuota').toBe(0);
    expect(p.heatmap.cells[3 * 24 + 3], 'fuori periodo').toBeNull();
  });

  it('l`intensita` non si normalizza sul picco anomalo', async () => {
    // Con il massimo assoluto, una cella da mille schiaccia tutte le altre a
    // invisibile: la mappa diventa un puntino luminoso su fondo nero e non
    // dice piu` niente sulle ore normali.
    await mode(1, 'classic');
    for (let h = 0; h < 20; h += 1) {
      await matches(`2026-08-24 ${String(h).padStart(2, '0')}:00:00+00`, 10);
    }
    await matches('2026-08-25 09:00:00+00', 1000);

    const p = await duels.trends('7d', NOW_7D);
    expect(p.heatmap.p95).toBeLessThan(1000);
    expect(p.heatmap.p95).toBeGreaterThan(0);
  });
});

describe('le classifiche partono dal catalogo e hanno un tetto', () => {
  it('le modalita` mai giocate restano, a zero', async () => {
    await mode(1, 'classic');
    await mode(2, 'sumo');
    await matches(LUNEDI, 4, { mode: 1 });

    const p = await duels.trends('7d', NOW_7D);
    expect(p.modes.map((m) => [m.name, m.matches])).toEqual([
      ['classic', 4],
      ['sumo', 0],
    ]);
  });

  it('le mappe si comportano come le modalita`, non come nel legacy', async () => {
    // Nel legacy le modalita` partivano dal catalogo e le mappe dai fatti:
    // due riquadri visivamente gemelli con due semantiche diverse.
    await mode(1, 'classic');
    await map(10, 'arena');
    await map(11, 'castle');
    await matches(LUNEDI, 4, { map: 10 });

    const p = await duels.trends('7d', NOW_7D);
    expect(p.maps.map((m) => [m.name, m.matches])).toEqual([
      ['arena', 4],
      ['castle', 0],
    ]);
  });

  it('oltre venticinque righe si taglia, e «Altre» porta cio` che resta', async () => {
    // Il totale si calcola sull'insieme COMPLETO: se venisse dalle righe
    // spedite, le quote sommerebbero al 100% di un insieme diverso da quello
    // che l'utente crede di guardare.
    for (let i = 1; i <= 30; i += 1) {
      await mode(i, `m${String(i).padStart(2, '0')}`);
      await matches(LUNEDI, 31 - i, { mode: i });
    }

    const p = await duels.trends('7d', NOW_7D);

    expect(p.modes).toHaveLength(25);
    expect(p.modesOthers.n).toBe(5);
    // Le cinque tagliate sono quelle con 5, 4, 3, 2, 1 partite.
    expect(p.modesOthers.matches).toBe(15);
    expect(p.totals.matches).toBe(p.modes.reduce((a, m) => a + m.matches, 0) + p.modesOthers.matches);
  });
});

describe('le valutazioni seguono il periodo del guscio', () => {
  it('KPI, distribuzione e andamento dallo stesso aggregato', async () => {
    await mode(1, 'classic');
    await ratingDay('2026-08-25', 1, [0, 0, 1, 2, 1]);
    await ratingDay('2026-08-26', 1, [1, 0, 0, 0, 0]);

    const p = await duels.ratings('7d', null, NOW_7D);

    expect(p.total).toBe(5);
    // (3 + 4 + 4 + 5 + 1) / 5
    expect(p.average).toBe(3.4);
    expect(p.distribution).toEqual([1, 0, 1, 2, 1]);
    expect(p.trend.t).toHaveLength(7);
  });

  it('un giorno senza voti e` `null`, non una media a zero', async () => {
    // Zero sulla scala 1-5 non esiste: sul grafico sarebbe un crollo a fondo
    // scala invece di un buco, e tre giorni di buco diventerebbero un tonfo.
    await mode(1, 'classic');
    await ratingDay('2026-08-25', 1, [0, 0, 0, 0, 2]);

    const p = await duels.ratings('7d', null, NOW_7D);
    const conVoti = p.trend.avg.filter((v) => v !== null);

    expect(conVoti).toEqual([5]);
    expect(p.trend.avg.filter((v) => v === null).length).toBe(6);
  });

  it('la distribuzione ha SEMPRE cinque elementi, anche a zero voti', async () => {
    const p = await duels.ratings('7d', null, NOW_7D);
    expect(p.distribution).toEqual([0, 0, 0, 0, 0]);
    expect(p.total).toBe(0);
    expect(p.average).toBe(0);
  });

  it('«meglio votata» rispetta la soglia, «piu` votata» no', async () => {
    // La soglia e` l'unica regola di significativita` della pagina e nel
    // legacy non e` mai mostrata: una modalita` con un voto solo da 5 stelle
    // vincerebbe su una con quattrocento voti da 4,8.
    await mode(1, 'classic');
    await mode(2, 'sumo');
    await ratingDay('2026-08-25', 1, [0, 0, 0, 8, 2]); // 10 voti, media 4,2
    await ratingDay('2026-08-25', 2, [0, 0, 0, 0, 1]); // 1 voto, media 5

    const p = await duels.ratings('7d', null, NOW_7D);

    expect(p.mostRated?.id).toBe(1);
    expect(p.bestRated?.id, 'un voto solo non vince').toBe(1);
    expect(p.bestRatedMinSample).toBe(5);
  });

  it('a modalita` singola le due classifiche spariscono', async () => {
    await mode(1, 'classic');
    await ratingDay('2026-08-25', 1, [0, 0, 0, 1, 1]);
    const p = await duels.ratings('7d', 1, NOW_7D);
    expect(p.mostRated).toBeNull();
    expect(p.bestRated).toBeNull();
    expect(p.total).toBe(2);
  });

  it('sul 24h si leggono le righe vere, non l`aggregato giornaliero', async () => {
    // L'aggregato per giorno non sa rispondere a «ultime ventiquattro ore»:
    // darebbe un punto solo e un totale che copre due giorni interi.
    await mode(1, 'classic');
    await rating(1, '2026-08-24 09:10:00+00', 5);
    await rating(2, '2026-08-24 14:20:00+00', 3);
    // Fuori finestra: ventisei ore prima.
    await rating(3, '2026-08-23 13:00:00+00', 1);

    const p = await duels.ratings('24h', null, NOW_24H);

    expect(p.total).toBe(2);
    expect(p.average).toBe(4);
    expect(p.trend.t).toHaveLength(24);
  });
});

describe('la lista sfoglia con il keyset, e non salta niente', () => {
  beforeEach(async () => {
    await mode(1, 'classic');
    for (let i = 1; i <= 20; i += 1) {
      await rating(i, `2026-08-24 ${String(i % 24).padStart(2, '0')}:00:00+00`, ((i - 1) % 5) + 1, {
        player: i === 7 ? 'Cercami' : `Tizio${i}`,
        comment: i % 2 === 0 ? `commento ${i}` : null,
      });
    }
  });

  it('due pagine non condividono nemmeno una riga', async () => {
    const base = { range: '7d', mode: null, q: null, comment: 'all', sort: 'recent', now: NOW_7D } as const;
    const uno = await duels.recent({ ...base, cursor: null, withTotal: true });
    expect(uno.rows).toHaveLength(15);
    expect(uno.total).toBe(20);
    expect(uno.cursor).not.toBeNull();

    const due = await duels.recent({ ...base, cursor: uno.cursor, withTotal: false });
    expect(due.rows).toHaveLength(5);
    expect(due.total, 'non si riconta a ogni pagina').toBeNull();
    expect(due.cursor, 'finita').toBeNull();

    const visti = new Set([...uno.rows, ...due.rows].map((r) => r.id));
    expect(visti.size, 'venti righe distinte').toBe(20);
  });

  it('«peggiori prima» ordina per voto crescente, e il cursore lo segue', async () => {
    const base = { range: '7d', mode: null, q: null, comment: 'all', sort: 'worst', now: NOW_7D } as const;
    const uno = await duels.recent({ ...base, cursor: null, withTotal: true });
    const due = await duels.recent({ ...base, cursor: uno.cursor, withTotal: false });
    const voti = [...uno.rows, ...due.rows].map((r) => r.rating);

    expect(voti[0]).toBe(1);
    expect(voti.at(-1)).toBe(5);
    expect(
      [...voti].sort((a, b) => a - b),
      'gia` ordinati',
    ).toEqual(voti);
  });

  it('la ricerca guarda il nome E il commento', async () => {
    const base = { range: '7d', mode: null, comment: 'all', sort: 'recent', now: NOW_7D } as const;
    const perNome = await duels.recent({ ...base, q: 'cercam', cursor: null, withTotal: true });
    expect(perNome.rows.map((r) => r.player)).toEqual(['Cercami']);

    const perCommento = await duels.recent({ ...base, q: 'commento 4', cursor: null, withTotal: true });
    expect(perCommento.rows).toHaveLength(1);
  });

  it('il filtro commento e il suo complemento coprono tutto', async () => {
    const base = { range: '7d', mode: null, q: null, sort: 'recent', now: NOW_7D, cursor: null } as const;
    const con = await duels.recent({ ...base, comment: 'with', withTotal: true });
    const senza = await duels.recent({ ...base, comment: 'without', withTotal: true });
    expect((con.total ?? 0) + (senza.total ?? 0)).toBe(20);
  });

  it('un cursore alterato e` un errore, non la prima pagina', async () => {
    // Ricominciare da capo in silenzio fa sfogliare in tondo senza che
    // nessuno capisca perche` la lista non finisce mai.
    const base = { range: '7d', mode: null, q: null, comment: 'all', sort: 'recent', now: NOW_7D } as const;
    await expect(duels.recent({ ...base, cursor: 'non-e-un-cursore', withTotal: false })).rejects.toThrow(
      BadCursor,
    );
  });
});
