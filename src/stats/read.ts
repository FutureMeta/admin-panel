// Costruzione del payload delle statistiche. Fase 2, passo 4.
//
// UNA SCANSIONE PER WIDGET, tagliata in JS. Il costo di una scansione su
// `rollup_1h` per novanta giorni e' lo stesso che si voglia una modalita' o
// venti: e' lo stesso intervallo di indice. Si paga una volta.
//
// I CONFINI DEL PERIODO si calcolano su GIORNI CIVILI di Roma, mai con
// `- interval '30 days'` su un timestamptz: nei periodi che attraversano un
// cambio ora le due cose differiscono di un'ora e il confronto scivola di un
// bucket. E il giorno in corso si esclude da ENTRAMBI i lati — se no il
// periodo corrente contiene un giorno parziale e il precedente no, quindi ogni
// somma risulta piu' bassa nel corrente, ogni giorno, per costruzione.

import { sql } from 'kysely';
import type { Database } from '#src/db/pool.ts';
import {
  CONTRACT_VERSION,
  type Kpi,
  type ModePayload,
  NOT_COLLECTED_COUNTRY,
  type OverviewPayload,
  type Range,
  round1,
} from './contract.ts';

const ROME = 'Europe/Rome';

type Plan = {
  /** La tabella da cui si legge. */
  source: '5m' | '1h' | '1d';
  /** Quante ore per punto quando si ri-bucketizza il livello orario. */
  hoursPerBucket?: number;
  /** Etichetta del bucket in secondi. Per `1y` e' nominale: un giorno non dura sempre 86400. */
  bucketSec: number;
  /** Ampiezza del periodo. In giorni civili, tranne il 24h. */
  days?: number;
  hours?: number;
};

/**
 * Mappatura range -> livello, scelta per tenere i punti fra 168 e 365.
 *
 * Un grafico e' largo circa mille pixel: piu' punti che pixel sono byte
 * buttati, e non aggiungono una sola informazione visibile.
 */
const PLAN: Record<Range, Plan> = {
  '24h': { source: '5m', bucketSec: 300, hours: 24 },
  '7d': { source: '1h', hoursPerBucket: 1, bucketSec: 3_600, days: 7 },
  '30d': { source: '1h', hoursPerBucket: 2, bucketSec: 7_200, days: 30 },
  '90d': { source: '1h', hoursPerBucket: 6, bucketSec: 21_600, days: 90 },
  '1y': { source: '1d', bucketSec: 86_400, days: 365 },
};

export type Window = { prevFrom: Date; curFrom: Date; curTo: Date };

/** La mezzanotte di Roma del giorno che contiene `at`, come istante. */
function romeMidnight(at: Date): Date {
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: ROME,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
  // Si ricava l'offset misurandolo, invece di assumerlo: due volte l'anno
  // sbaglierebbe di un'ora, e sarebbe proprio nei giorni in cui conta.
  const guess = new Date(`${day}T00:00:00Z`);
  const local = new Date(guess.toLocaleString('en-US', { timeZone: ROME }));
  const utc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(guess.getTime() + (utc.getTime() - local.getTime()));
}

/** Sposta di N giorni CIVILI, che non e' la stessa cosa di N per 86400. */
function shiftDays(midnight: Date, days: number): Date {
  const iso = new Intl.DateTimeFormat('en-CA', {
    timeZone: ROME,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(midnight);
  const shifted = new Date(`${iso}T12:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return romeMidnight(shifted);
}

/**
 * La finestra corrente e quella precedente, della STESSA lunghezza.
 *
 * Sono la stessa lunghezza in giorni civili, non in secondi: due periodi che
 * attraversano un cambio ora hanno un'ora di differenza, ed e' giusto cosi'
 * — il confronto e' fra un mese e un mese, non fra 720 ore e 720 ore.
 */
export function windowOf(range: Range, now: Date): Window {
  const plan = PLAN[range];
  if (plan.hours !== undefined) {
    // Il 24h non si appoggia ai giorni: e' una finestra scorrevole allineata
    // al bucket, e il periodo precedente sono le 24 ore prima.
    const step = plan.bucketSec * 1_000;
    const curTo = new Date(Math.floor(now.getTime() / step) * step);
    const span = plan.hours * 3_600_000;
    return {
      curTo,
      curFrom: new Date(curTo.getTime() - span),
      prevFrom: new Date(curTo.getTime() - 2 * span),
    };
  }
  const days = plan.days as number;
  const curTo = romeMidnight(now); // oggi si esclude: e' un giorno parziale
  const curFrom = shiftDays(curTo, -days);
  return { curTo, curFrom, prevFrom: shiftDays(curFrom, -days) };
}

type SeriesRow = {
  cur: boolean;
  t: string;
  mode_key: string;
  player_seconds: string;
  players_max: number | null;
  covered_s: number;
  samples: number;
};

async function seriesRows(db: Database, range: Range, w: Window): Promise<SeriesRow[]> {
  const plan = PLAN[range];

  if (plan.source === '5m') {
    const res = await sql<SeriesRow>`
      WITH src AS (
        SELECT bucket, mode_key, player_seconds, covered_s, samples, players_max,
               (bucket >= ${w.curFrom}) AS cur
          FROM stats.v_online_5m
         WHERE bucket >= ${w.prevFrom} AND bucket < ${w.curTo}
      ),
      cov AS (SELECT cur, bucket, covered_s, samples FROM src WHERE mode_key = '__network__')
      SELECT s.cur, extract(epoch FROM s.bucket)::bigint::text AS t, s.mode_key,
             sum(s.player_seconds)::bigint::text AS player_seconds,
             max(s.players_max) AS players_max, c.covered_s, c.samples
        FROM src s
        JOIN cov c ON c.cur = s.cur AND c.bucket = s.bucket
       GROUP BY 1, 2, 3, c.covered_s, c.samples
       ORDER BY 1, 2
    `.execute(db);
    return res.rows;
  }

  if (plan.source === '1h') {
    const hours = plan.hoursPerBucket as number;
    const res = await sql<SeriesRow>`
      WITH src AS (
        -- date_trunc a TRE argomenti, mai date_bin: date_bin ha un'origine
        -- assoluta e non e' consapevole del cambio ora.
        SELECT date_trunc('day', bucket, ${ROME})
                 + make_interval(hours =>
                     (extract(hour FROM bucket AT TIME ZONE ${ROME})::int / ${hours}) * ${hours}) AS t,
               mode_key, player_seconds, covered_s, samples, players_max,
               (bucket >= ${w.curFrom}) AS cur
          FROM stats.v_online_1h
         WHERE bucket >= ${w.prevFrom} AND bucket < ${w.curTo}
      ),
      -- IL DENOMINATORE VIENE DALLA RIGA DI RETE. Sommarlo per modalita'
      -- darebbe il tempo in cui quella modalita' era aperta.
      cov AS (
        SELECT cur, t, sum(covered_s)::int AS covered_s, sum(samples)::int AS samples
          FROM src WHERE mode_key = '__network__' GROUP BY 1, 2
      )
      SELECT s.cur, extract(epoch FROM s.t)::bigint::text AS t, s.mode_key,
             sum(s.player_seconds)::bigint::text AS player_seconds,
             max(s.players_max) AS players_max, c.covered_s, c.samples
        FROM src s
        JOIN cov c ON c.cur = s.cur AND c.t = s.t
       GROUP BY 1, 2, 3, c.covered_s, c.samples
       ORDER BY 1, 2
    `.execute(db);
    return res.rows;
  }

  const res = await sql<SeriesRow>`
    WITH src AS (
      SELECT day, mode_key, player_seconds, covered_s, samples, players_max,
             (day >= ${w.curFrom}) AS cur
        FROM stats.v_online_1d
       WHERE day >= ${w.prevFrom} AND day < ${w.curTo}
    ),
    cov AS (SELECT cur, day, covered_s, samples FROM src WHERE mode_key = '__network__')
    SELECT s.cur,
           extract(epoch FROM (s.day::timestamp AT TIME ZONE ${ROME}))::bigint::text AS t,
           s.mode_key,
           sum(s.player_seconds)::bigint::text AS player_seconds,
           max(s.players_max) AS players_max, c.covered_s, c.samples
      FROM src s
      JOIN cov c ON c.cur = s.cur AND c.day = s.day
     GROUP BY 1, 2, 3, c.covered_s, c.samples
     ORDER BY 1, 2
  `.execute(db);
  return res.rows;
}

/**
 * La heatmap 7x24, dalla sola riga di rete.
 *
 * TRE array e mai la media gia' divisa. Nei giorni di cambio ora una cella
 * locale ha zero occorrenze (l'ora saltata di marzo) o due (l'ora ripetuta di
 * ottobre): con la sola media quella cella mente e nessuno puo' accorgersene
 * guardandola — ed e' l'unica cella che qualcuno controllera' a mano.
 */
async function heatmapRows(
  db: Database,
  w: Window,
): Promise<Array<{ cell: number; v: string; w: string; n: number }>> {
  const res = await sql<{ cell: number; v: string; w: string; n: number }>`
    SELECT (extract(isodow FROM bucket AT TIME ZONE ${ROME})::int - 1) * 24
             + extract(hour FROM bucket AT TIME ZONE ${ROME})::int AS cell,
           sum(player_seconds)::bigint::text AS v,
           sum(covered_s)::bigint::text      AS w,
           count(*)::int                     AS n
      FROM stats.v_online_1h
     WHERE bucket >= ${w.curFrom} AND bucket < ${w.curTo} AND server_id = 0
     GROUP BY cell
  `.execute(db);
  return res.rows;
}

/**
 * Il NUMERATORE della heatmap per ogni modalita', in una scansione sola.
 *
 * Il denominatore non c'e' apposta: e' quello di rete, lo stesso per tutte. Se
 * ogni modalita' avesse il proprio, la cella delle 03:00 di una modalita'
 * aperta solo di notte segnerebbe lo stesso colore del picco serale della
 * rete, e la heatmap smetterebbe di rispondere alla domanda che le si fa
 * («quando c'e' gente») per rispondere a «quando era aperta».
 */
async function heatmapModeRows(
  db: Database,
  w: Window,
): Promise<Array<{ cell: number; mode_key: string; v: string }>> {
  const res = await sql<{ cell: number; mode_key: string; v: string }>`
    SELECT (extract(isodow FROM bucket AT TIME ZONE ${ROME})::int - 1) * 24
             + extract(hour FROM bucket AT TIME ZONE ${ROME})::int AS cell,
           mode_key,
           sum(player_seconds)::bigint::text AS v
      FROM stats.v_online_1h
     WHERE bucket >= ${w.curFrom} AND bucket < ${w.curTo} AND server_id <> 0
     GROUP BY cell, mode_key
  `.execute(db);
  return res.rows;
}

/**
 * Gli unici giornalieri PER MODALITA', da `mode_day_unique`.
 *
 * Non si derivano dai rollup: gli unici non sono additivi, quindi «unici di
 * duels» non e' la somma degli unici dei suoi server. Quella tabella esiste
 * solo per questo, ed e' derivata e ricostruibile — la fonte resta
 * `player_day_server`, chiavata sul server, che non invecchia quando la
 * classificazione cambia.
 */
async function uniquesByModeRows(
  db: Database,
  to: Date,
): Promise<Array<{ day: string; mode_key: string; uniques: number; final: boolean }>> {
  const res = await sql<{ t: string; mode_key: string; uniques: number; final: boolean }>`
    SELECT extract(epoch FROM (u.day::timestamp AT TIME ZONE ${ROME}))::bigint::text AS t,
           m.mode_key, u.uniques, u.final
      FROM stats.mode_day_unique u
      JOIN stats.mode m USING (mode_id)
     WHERE u.day >= (stats.civil_day(${to}) - ${UNIQUES_DAYS * 2}::int)
       AND u.day <= stats.civil_day(${to})
     ORDER BY u.day
  `.execute(db);
  return res.rows.map((r) => ({
    day: r.t,
    mode_key: r.mode_key,
    uniques: Number(r.uniques),
    final: r.final,
  }));
}

/**
 * I giocatori distinti del periodo, per modalita', in una scansione sola.
 *
 * Chi ha giocato a due modalita' conta una volta in CIASCUNA e una volta sola
 * nel totale di rete: e' per questo che il totale non e' la somma di queste
 * righe, e non deve mai essere presentato come se lo fosse.
 */
async function distinctPlayersByMode(db: Database, from: Date, to: Date): Promise<Map<string, number>> {
  const res = await sql<{ mode_key: string; n: string }>`
    SELECT sm.mode_key, count(DISTINCT pds.player_id)::bigint::text AS n
      FROM stats.player_day_server pds
      JOIN stats.v_server_mode sm USING (server_id)
     WHERE pds.day >= stats.civil_day(${from}) AND pds.day < stats.civil_day(${to})
     GROUP BY sm.mode_key
  `.execute(db);
  return new Map(res.rows.map((r) => [r.mode_key, Number(r.n)]));
}

/** Le cadenze presenti nel periodo: due periodi con cadenze diverse non sono confrontabili sul massimo. */
async function deltasIn(db: Database, w: Window): Promise<number[]> {
  const res = await sql<{ delta_s: number }>`
    SELECT DISTINCT delta_s FROM stats.v_cadence
     WHERE tick_at >= GREATEST(${w.curFrom}::timestamptz, now() - interval '90 days')
       AND tick_at < ${w.curTo}
     ORDER BY 1
  `.execute(db);
  return res.rows.map((r) => Number(r.delta_s));
}

/** Quanti giorni copre il grafico degli unici, indipendentemente dal range. */
const UNIQUES_DAYS = 30;

/**
 * Gli unici giornalieri, esatti.
 *
 * Vengono dalla riga di RETE, che ha un conteggio proprio: sommare gli unici
 * delle modalita' conterebbe due volte chi ha giocato a due modalita', e con
 * 2,2 modalita' medie a testa cinquemila persone diventerebbero undicimila —
 * un numero che cresce con la rotazione fra modalita' invece che con le
 * persone.
 *
 * `final` viaggia con ogni punto: un giorno gia' chiuso non cambiera' piu', il
 * giorno vivo si', e la UI deve poterli distinguere invece di far sembrare
 * definitivo un numero che sta ancora salendo.
 */
async function uniquesRows(
  db: Database,
  to: Date,
): Promise<Array<{ day: string; uniques: number; final: boolean }>> {
  const res = await sql<{ t: string; uniques: number; final: boolean }>`
    SELECT extract(epoch FROM (day::timestamp AT TIME ZONE ${ROME}))::bigint::text AS t,
           uniques, final
      FROM stats.v_online_1d
     WHERE mode_key = '__network__'
       AND day >= (stats.civil_day(${to}) - ${UNIQUES_DAYS * 2}::int)
       AND day <= stats.civil_day(${to})
     ORDER BY day
  `.execute(db);
  return res.rows.map((r) => ({ day: r.t, uniques: Number(r.uniques), final: r.final }));
}

/**
 * I giocatori DISTINTI del periodo. Non la somma degli unici giornalieri.
 *
 * Chi ha giocato in tre giorni diversi conta una volta: la metrica e'
 * «giocatori», non «giocatori-giorno», e le due differiscono di un fattore che
 * cresce con la lunghezza del periodo.
 */
async function distinctPlayers(db: Database, from: Date, to: Date): Promise<number | null> {
  const res = await sql<{ n: string }>`
    SELECT count(DISTINCT player_id)::bigint::text AS n
      FROM stats.player_day
     WHERE day >= stats.civil_day(${from}) AND day < stats.civil_day(${to})
  `.execute(db);
  const n = res.rows[0]?.n;
  return n === undefined ? null : Number(n);
}

/**
 * La mappa: unici del periodo per paese, di rete e per modalita'.
 *
 * E' LA FONTE ANCHE DI , e non e' un dettaglio implementativo:
 * e' l'invariante I5. Se la mappa contasse una cosa e il KPI un'altra, si
 * finirebbe con «37.800 italiani» accanto a «5.000 giocatori» sullo stesso
 * schermo, con scritto «giocatori» in entrambe le legende. Qui la CTE `ranged`
 * produce UNA riga per giocatore, e sia la somma delle barre sia il conteggio
 * degli unici escono da quella: possono solo essere uguali.
 *
 * UN GIOCATORE, UN PAESE. Chi ha giocato in giorni diversi da paesi diversi
 * conta una volta sola: la metrica e' «giocatori unici», non «giocatori-giorno»
 * — e una mappa costruita sui campioni misurerebbe QUANTO la gente sta online,
 * non DA DOVE viene, premiando meccanicamente il fuso orario di casa.
 *
 * `'XX'` e' una barra, MAI uno scarto. Un secchiello `XX` che cresce e' il
 * primo sintomo che il campo `ip` ha cambiato semantica; scartandolo, la mappa
 * continuerebbe a sembrare corretta mentre misura un terzo dei giocatori.
 */
async function geoRows(
  db: Database,
  from: Date,
  to: Date,
): Promise<Array<{ mode_key: string; cc: string | null; uniques: number }>> {
  const res = await sql<{ mode_key: string; cc: string | null; uniques: string }>`
    WITH ranged AS (
      SELECT DISTINCT ON (d.player_id)
             d.player_id,
             d.country AS cc
        FROM stats.player_day d
       WHERE d.day >= stats.civil_day(${from}) AND d.day < stats.civil_day(${to})
       -- Prima un paese NOTO, poi il giorno piu' recente. L'ordine conta: con
       -- il solo day DESC, un giocatore visto ieri in un giorno in cui la
       -- geolocalizzazione era spenta diventerebbe «non determinato» pur
       -- avendo un paese noto la settimana prima.
       ORDER BY d.player_id, (d.country IS NULL), d.day DESC
    ),
    per_mode AS (
      SELECT DISTINCT sm.mode_key, pds.player_id
        FROM stats.player_day_server pds
        JOIN stats.v_server_mode sm USING (server_id)
       WHERE pds.day >= stats.civil_day(${from}) AND pds.day < stats.civil_day(${to})
    )
    SELECT '__network__' AS mode_key, r.cc, count(*)::bigint::text AS uniques
      FROM ranged r GROUP BY 1, 2
    UNION ALL
    SELECT m.mode_key, r.cc, count(*)::bigint::text AS uniques
      FROM per_mode m JOIN ranged r USING (player_id) GROUP BY 1, 2
  `.execute(db);
  return res.rows.map((r) => ({ mode_key: r.mode_key, cc: r.cc, uniques: Number(r.uniques) }));
}

async function modeLabels(db: Database): Promise<Map<string, { label: string; order: number }>> {
  const res = await sql<{ mode_key: string; display_name: string; sort_order: number }>`
    SELECT DISTINCT mode_key, display_name, sort_order FROM stats.v_server_mode
  `.execute(db);
  return new Map(res.rows.map((r) => [r.mode_key, { label: r.display_name, order: Number(r.sort_order) }]));
}

type Bucket = {
  t: number;
  coveredS: number;
  byMode: Map<string, number>;
  networkSeconds: number;
  peak: number | null;
};

function collect(rows: SeriesRow[], cur: boolean): Bucket[] {
  const byT = new Map<number, Bucket>();
  for (const r of rows) {
    if (r.cur !== cur) continue;
    const t = Number(r.t);
    let b = byT.get(t);
    if (!b) {
      b = { t, coveredS: Number(r.covered_s), byMode: new Map(), networkSeconds: 0, peak: null };
      byT.set(t, b);
    }
    const seconds = Number(r.player_seconds);
    if (r.mode_key === '__network__') {
      b.networkSeconds = seconds;
      b.peak = r.players_max === null ? null : Number(r.players_max);
    } else {
      b.byMode.set(r.mode_key, (b.byMode.get(r.mode_key) ?? 0) + seconds);
    }
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

/**
 * La griglia dei punti, senza buchi.
 *
 * `t` e' regolare per costruzione: dove non c'e' un bucket il VALORE e' null,
 * non il punto a mancare. Una serie con l'asse dei tempi bucato costringe il
 * client a indovinare, e indovinare qui significa interpolare.
 */
function grid(from: Date, to: Date, bucketSec: number): number[] {
  const step = bucketSec * 1_000;
  const out: number[] = [];
  for (let t = from.getTime(); t < to.getTime(); t += step) out.push(Math.floor(t / 1_000));
  return out;
}

/** Le componenti dell'ora locale, forzate a 00-23: `hour12: false` da' «24» a mezzanotte. */
const ROME_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: ROME,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
});

/** La cella 7x24 di un istante: `(isodow - 1) * 24 + ora`, come in SQL. */
function cellOf(epochSec: number): number {
  const p = Object.fromEntries(
    ROME_PARTS.formatToParts(new Date(epochSec * 1_000)).map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  const d = new Date(
    Date.UTC(Number(p['year']), Number(p['month']) - 1, Number(p['day']), Number(p['hour'])),
  );
  const isodow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  return (isodow - 1) * 24 + d.getUTCHours();
}

/**
 * Quante volte ogni cella ricorre NEL PERIODO.
 *
 * Si cammina di un'ora UTC per volta, e non e' un dettaglio: cosi' l'ora
 * saltata di marzo esce con zero occorrenze e quella ripetuta di ottobre con
 * due, che e' la verita'. Al massimo 8.760 giri sull'anno, una volta per
 * payload.
 */
function nominalCells(from: Date, to: Date): number[] {
  const out = new Array<number>(168).fill(0);
  for (let t = from.getTime(); t < to.getTime(); t += 3_600_000) {
    const c = cellOf(Math.floor(t / 1_000));
    out[c] = (out[c] ?? 0) + 1;
  }
  return out;
}

/**
 * I KPI del periodo.
 *
 * `avg` NON e' `player_seconds / covered_s` sul periodo intero. I buchi non
 * sono mai indipendenti dall'ora del giorno — si fa deploy la sera, il Redis
 * di gioco soffre al picco — quindi tre serate perse in un mese abbassano la
 * media dell'8-10% con una copertura complessiva del 98,8%. E nessuno guarda
 * con sospetto un 98,8%.
 *
 * Si normalizza sul profilo orario: ogni cella (giorno-settimana, ora) pesa
 * per quante volte ricorre nel periodo, non per quanto e' stata osservata.
 * Cosi' una serata mancante non sposta la media: abbassa `coverage`, che e' il
 * posto giusto in cui farlo vedere.
 */
/**
 * @param numerator I secondi-giocatore da mediare. Per una modalita' sono i
 *   suoi, per la rete quelli della riga di rete. Il DENOMINATORE non e' mai
 *   parametrico: viene sempre dalla riga di rete, o `evento_1` — aperta cinque
 *   minuti al giorno con duecento giocatori — riporterebbe media 200 e
 *   batterebbe `duels` aperta ventiquattr'ore con 150.
 * @param hasPeak Falso per le modalita': il massimo non si decompone (vedi
 *   `ModePayload`). Un limite inferiore etichettato «picco» e' una bugia
 *   plausibile, che e' la specie peggiore.
 */
function kpiOf(
  buckets: Bucket[],
  from: Date,
  to: Date,
  bucketSec: number,
  numerator: (b: Bucket) => number = (b) => b.networkSeconds,
  hasPeak = true,
): Kpi {
  const nominalS = (to.getTime() - from.getTime()) / 1_000;
  const coveredS = buckets.reduce((a, b) => a + b.coveredS, 0);

  let peak: number | null = null;
  let peakAt: number | null = null;
  let peakCoverage = 0;
  if (hasPeak) {
    for (const b of buckets) {
      if (b.peak === null) continue;
      if (peak === null || b.peak > peak) {
        peak = b.peak;
        peakAt = b.t;
        // Il massimo non viaggia mai da solo: senza la copertura del suo
        // bucket, un picco misurato su due tick su dieci sembra un picco vero.
        peakCoverage = Math.min(1, b.coveredS / bucketSec);
      }
    }
  }

  const num = new Array<number>(168).fill(0);
  const den = new Array<number>(168).fill(0);
  for (const b of buckets) {
    if (b.coveredS <= 0) continue;
    const c = cellOf(b.t);
    num[c] = (num[c] ?? 0) + numerator(b);
    den[c] = (den[c] ?? 0) + b.coveredS;
  }

  const nominal = nominalCells(from, to);
  let weighted = 0;
  let weights = 0;
  for (let c = 0; c < 168; c += 1) {
    const d = den[c] ?? 0;
    const occ = nominal[c] ?? 0;
    if (d <= 0 || occ <= 0) continue;
    weighted += occ * ((num[c] ?? 0) / d);
    weights += occ;
  }

  return {
    avg: weights > 0 ? round1(weighted / weights) : null,
    peak,
    peakAt,
    peakCoverage: Math.round(peakCoverage * 100) / 100,
    uniques: null, // passo 6
    coverage: nominalS > 0 ? Math.min(1, Math.round((coveredS / nominalS) * 100) / 100) : 0,
  };
}

export type BuildResult = { payload: OverviewPayload; queryMs: number };

/** La panoramica piu' i payload di ogni modalita', dalla STESSA scansione. */
export type AllBuild = {
  overview: OverviewPayload;
  perMode: Map<string, ModePayload>;
  queryMs: number;
};

/**
 * Costruisce la panoramica.
 *
 * Resta come porta d'ingresso di chi vuole solo quella — la rotta e i test —
 * ma dietro c'e' `buildAll`: una scansione su `rollup_1h` per novanta giorni
 * costa lo stesso che si voglia una modalita' o venti, perche' e' lo stesso
 * intervallo di indice. Costruire i payload per modalita' a parte
 * significherebbe pagare N volte la stessa lettura.
 */
export async function buildOverview(db: Database, range: Range, now = new Date()): Promise<BuildResult> {
  const all = await buildAll(db, range, now);
  return { payload: all.overview, queryMs: all.queryMs };
}

export async function buildAll(db: Database, range: Range, now = new Date()): Promise<AllBuild> {
  const plan = PLAN[range];
  const w = windowOf(range, now);

  const t0 = Date.now();
  const [
    rows,
    heat,
    heatByMode,
    deltas,
    labels,
    daily,
    dailyByMode,
    distinctBefore,
    distinctModeBefore,
    geo,
  ] = await Promise.all([
    seriesRows(db, range, w),
    heatmapRows(db, w),
    heatmapModeRows(db, w),
    deltasIn(db, w),
    modeLabels(db),
    uniquesRows(db, w.curTo),
    uniquesByModeRows(db, w.curTo),
    distinctPlayers(db, w.prevFrom, w.curFrom),
    distinctPlayersByMode(db, w.prevFrom, w.curFrom),
    geoRows(db, w.curFrom, w.curTo),
  ]);
  const queryMs = Date.now() - t0;

  const cur = collect(rows, true);
  const prev = collect(rows, false);

  const modes = [...new Set(rows.map((r) => r.mode_key))]
    .filter((m) => m !== '__network__')
    .sort((a, b) => {
      const oa = labels.get(a)?.order ?? 999;
      const ob = labels.get(b)?.order ?? 999;
      return oa === ob ? a.localeCompare(b) : oa - ob;
    });

  const axis = grid(w.curFrom, w.curTo, plan.bucketSec);
  const prevAxis = grid(w.prevFrom, w.curFrom, plan.bucketSec);
  const byT = new Map(cur.map((b) => [b.t, b]));
  const prevByT = new Map(prev.map((b) => [b.t, b]));

  const series: Record<string, (number | null)[]> = {};
  for (const m of modes) series[m] = [];
  const total: (number | null)[] = [];
  const peakLine: (number | null)[] = [];
  const coverage: number[] = [];

  for (const t of axis) {
    const b = byT.get(t);
    // Il buco e' un valore: `null` significa «non rilevato», e non si
    // interpola mai fra due punti separati da un null.
    const covered = b?.coveredS ?? 0;
    total.push(b && covered > 0 ? round1(b.networkSeconds / covered) : null);
    peakLine.push(b?.peak ?? null);
    coverage.push(round1(Math.min(1, covered / plan.bucketSec) * 100) / 100);
    for (const m of modes) {
      const s = b?.byMode.get(m);
      series[m]?.push(b && covered > 0 ? round1((s ?? 0) / covered) : null);
    }
  }

  const prevTotal: (number | null)[] = [];
  const prevCoverage: number[] = [];
  for (const t of prevAxis) {
    const b = prevByT.get(t);
    const covered = b?.coveredS ?? 0;
    prevTotal.push(b && covered > 0 ? round1(b.networkSeconds / covered) : null);
    prevCoverage.push(round1(Math.min(1, covered / plan.bucketSec) * 100) / 100);
  }

  const v = new Array<number>(168).fill(0);
  const wArr = new Array<number>(168).fill(0);
  const nArr = new Array<number>(168).fill(0);
  for (const h of heat) {
    v[h.cell] = Number(h.v);
    wArr[h.cell] = Number(h.w);
    nArr[h.cell] = h.n;
  }

  // La mappa, tagliata per modalita' dalla stessa lettura.
  //
  // `geo: null` quando la geolocalizzazione non e' attiva — cioe' quando
  // NESSUNA riga del periodo porta un paese. L'interfaccia nasconde il widget
  // invece di disegnare una mappa vuota, che sarebbe indistinguibile da «non
  // viene nessuno da nessuna parte».
  //
  // Se invece e' attiva e non risolve, le barre esistono e sono tutte `XX`:
  // quello e' un DATO, ed e' il primo sintomo che il campo `ip` ha cambiato
  // significato. Nasconderlo sarebbe nascondere proprio il guasto.
  // GLI UNICI DEL PERIODO CORRENTE ESCONO DA QUI, non da una seconda query.
  //
  // E' cio' che rende I5 vera per COSTRUZIONE invece che per fortuna. Con due
  // query separate i due numeri girerebbero su connessioni diverse e quindi su
  // snapshot MVCC diversi: basta che una riga di `player_day` venga committata
  // fra l'una e l'altra — e a mezzanotte succede, quando il versamento dei
  // secondi crea le righe del giorno nuovo — perche' la somma delle barre non
  // torni con il KPI e `assertPayload` rifiuti l'INTERO payload. Raro,
  // notturno, e indistinguibile da un difetto vero.
  const uniquesOf = (modeKey: string): number =>
    geo.filter((g) => g.mode_key === modeKey).reduce((a, g) => a + g.uniques, 0);

  const geoActive = geo.some((g) => g.cc !== null);
  const geoByMode = new Map<string, Array<{ cc: string; v: number }>>();
  if (geoActive) {
    for (const g of geo) {
      const list = geoByMode.get(g.mode_key) ?? [];
      list.push({ cc: g.cc ?? NOT_COLLECTED_COUNTRY, v: g.uniques });
      geoByMode.set(g.mode_key, list);
    }
    for (const list of geoByMode.values()) list.sort((a, b) => b.v - a.v || a.cc.localeCompare(b.cc));
  }
  const geoOf = (modeKey: string): OverviewPayload['geo'] => {
    const list = geoByMode.get(modeKey);
    if (!list || list.length === 0) return null;
    return {
      cc: list.map((x) => x.cc),
      v: list.map((x) => x.v),
      asOf: Math.floor(now.getTime() / 1_000),
      // Contata adesso e sulla stessa popolazione del KPI, non ripresa da un
      // aggregato notturno: e' cio' che rende I5 vera per costruzione invece
      // che per fortuna.
      exact: true,
    };
  };

  const kpi = kpiOf(cur, w.curFrom, w.curTo, plan.bucketSec);
  const kpiPrev = kpiOf(prev, w.prevFrom, w.curFrom, plan.bucketSec);
  kpi.uniques = uniquesOf('__network__');
  kpiPrev.uniques = distinctBefore;

  // Il grafico degli unici mostra gli ultimi trenta giorni e li confronta con
  // i trenta precedenti, qualunque sia il range scelto: e' una domanda sulle
  // PERSONE, che si muove su scala di giorni, non sulla finestra del grafico
  // dell'online.
  const recent = daily.slice(-UNIQUES_DAYS);
  const earlier = daily.slice(0, Math.max(0, daily.length - UNIQUES_DAYS)).slice(-UNIQUES_DAYS);

  const payload: OverviewPayload = {
    v: CONTRACT_VERSION,
    range,
    tz: ROME,
    bucketSec: plan.bucketSec,
    generatedAt: Math.floor(now.getTime() / 1_000),
    closedThrough: Math.floor(w.curTo.getTime() / 1_000),
    liveTail: false,
    deltas,
    modes,
    labels: Object.fromEntries(modes.map((m) => [m, labels.get(m)?.label ?? m])),
    online: { t: axis, total, peak: peakLine, series, coverage },
    prev: { t: prevAxis, total: prevTotal, coverage: prevCoverage },
    kpi,
    kpiPrev,
    // Un confronto fra due periodi con coperture diverse e' il modo garantito
    // di produrre un delta falso, ed e' lo scenario piu' probabile in cui il
    // pannello mente a chi lo paga.
    comparable: Math.abs(kpi.coverage - kpiPrev.coverage) <= 0.02,
    heatmap: { v, w: wArr, n: nArr },
    uniques: {
      t: recent.map((d) => Number(d.day)),
      v: recent.map((d) => d.uniques),
      // Allineata per POSIZIONE, non per data: il punto i del periodo
      // precedente sta sotto il punto i di questo.
      prev: recent.map((_, i) => earlier[i]?.uniques ?? null),
      final: recent.map((d) => d.final),
    },
    geo: geoOf('__network__'),
  };

  // ---------------------------------------------------------------------
  // I payload per modalita', dagli STESSI array. Niente qui tocca il
  // database: la scansione e' gia' stata pagata sopra.
  // ---------------------------------------------------------------------

  const heatModeCells = new Map<string, number[]>();
  for (const h of heatByMode) {
    let arr = heatModeCells.get(h.mode_key);
    if (!arr) {
      arr = new Array<number>(168).fill(0);
      heatModeCells.set(h.mode_key, arr);
    }
    arr[h.cell] = Number(h.v);
  }

  const dailyModeIndex = new Map<string, Map<number, { uniques: number; final: boolean }>>();
  for (const d of dailyByMode) {
    let byDay = dailyModeIndex.get(d.mode_key);
    if (!byDay) {
      byDay = new Map();
      dailyModeIndex.set(d.mode_key, byDay);
    }
    byDay.set(Number(d.day), { uniques: d.uniques, final: d.final });
  }

  const perMode = new Map<string, ModePayload>();
  for (const m of modes) {
    const line = series[m] ?? [];
    const prevLine = prevAxis.map((t) => {
      const b = prevByT.get(t);
      const covered = b?.coveredS ?? 0;
      return b && covered > 0 ? round1((b.byMode.get(m) ?? 0) / covered) : null;
    });

    const kpiMode = kpiOf(cur, w.curFrom, w.curTo, plan.bucketSec, (b) => b.byMode.get(m) ?? 0, false);
    const kpiModePrev = kpiOf(
      prev,
      w.prevFrom,
      w.curFrom,
      plan.bucketSec,
      (b) => b.byMode.get(m) ?? 0,
      false,
    );
    kpiMode.uniques = uniquesOf(m);
    kpiModePrev.uniques = distinctModeBefore.get(m) ?? null;

    const byDay = dailyModeIndex.get(m);
    const modeHeat = heatModeCells.get(m) ?? new Array<number>(168).fill(0);

    perMode.set(m, {
      ...payload,
      mode: m,
      modes: [m],
      labels: { [m]: labels.get(m)?.label ?? m },
      // `total` E' la riga della modalita', non quella di rete: in questo
      // payload la domanda e' «quanti su duels», e mostrare il totale di rete
      // sotto l'etichetta di una modalita' sarebbe il disallineamento che il
      // §6.8 esiste per intercettare.
      online: { t: axis, total: line, peak: axis.map(() => null), series: { [m]: line }, coverage },
      prev: { t: prevAxis, total: prevLine, coverage: prevCoverage },
      kpi: kpiMode,
      kpiPrev: kpiModePrev,
      // La copertura e' quella del ciclo di raccolta, la stessa per tutti:
      // percio' la confrontabilita' non cambia da modalita' a modalita'.
      comparable: payload.comparable,
      // Denominatore e occorrenze restano quelli di RETE (vedi
      // `heatmapModeRows`): cambia solo il numeratore.
      heatmap: { v: modeHeat, w: wArr, n: nArr },
      uniques: {
        t: recent.map((d) => Number(d.day)),
        v: recent.map((d) => byDay?.get(Number(d.day))?.uniques ?? null),
        prev: recent.map((_, i) => {
          const day = earlier[i];
          return day ? (byDay?.get(Number(day.day))?.uniques ?? null) : null;
        }),
        final: recent.map((d) => byDay?.get(Number(d.day))?.final ?? false),
      },
      geo: geoOf(m),
    });
  }

  return { overview: payload, perMode, queryMs };
}
