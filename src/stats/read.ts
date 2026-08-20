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
import { CONTRACT_VERSION, type Kpi, type OverviewPayload, type Range, round1 } from './contract.ts';

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
function kpiOf(buckets: Bucket[], from: Date, to: Date, bucketSec: number): Kpi {
  const nominalS = (to.getTime() - from.getTime()) / 1_000;
  const coveredS = buckets.reduce((a, b) => a + b.coveredS, 0);

  let peak: number | null = null;
  let peakAt: number | null = null;
  let peakCoverage = 0;
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

  const num = new Array<number>(168).fill(0);
  const den = new Array<number>(168).fill(0);
  for (const b of buckets) {
    if (b.coveredS <= 0) continue;
    const c = cellOf(b.t);
    num[c] = (num[c] ?? 0) + b.networkSeconds;
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

/** Costruisce la panoramica. Nessuna cache: quella e' il passo 5. */
export async function buildOverview(db: Database, range: Range, now = new Date()): Promise<BuildResult> {
  const plan = PLAN[range];
  const w = windowOf(range, now);

  const t0 = Date.now();
  const [rows, heat, deltas, labels] = await Promise.all([
    seriesRows(db, range, w),
    heatmapRows(db, w),
    deltasIn(db, w),
    modeLabels(db),
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

  const kpi = kpiOf(cur, w.curFrom, w.curTo, plan.bucketSec);
  const kpiPrev = kpiOf(prev, w.prevFrom, w.curFrom, plan.bucketSec);

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
    uniques: { t: [], v: [], prev: [], final: [] }, // passo 6
    geo: null, // passo 7
  };

  return { payload, queryMs };
}
