// L'implementazione PostgreSQL della porta. E' quella che gira.
//
// UNA SCANSIONE PER RIQUADRO, e nessuna sui fatti grezzi. Le schermate non
// toccano mai una riga di partita: leggono `duels_match_hour`, che e' gia'
// aggregata per ora, e `duels_rating_day`, che e' gia' aggregata per giorno.
// Novanta giorni di andamento sono una somma su qualche migliaio di righe
// locali — ed e' la ragione per cui esiste l'ETL, non un dettaglio di questa
// implementazione.
//
// LE ETICHETTE LOCALI VENGONO DALLA VISTA, non da qui. `local_dow`,
// `local_hour` e `local_day` sono calcolati in `stats.v_duels_hour` con il
// fuso nominato una volta sola; ricalcolarli in JavaScript significherebbe
// avere due verita' sul giorno civile, e divergerebbero esattamente nei due
// giorni all'anno in cui conta.
//
// IL CURSORE PORTA IL TEMPO COME TESTO A MICROSECONDI. Un `Date` di
// JavaScript arriva ai millisecondi: se `created_at` avesse una parte piu'
// fine, il confronto keyset salterebbe o ripeterebbe una riga al confine
// della pagina — cioe' un difetto che si vede solo sfogliando, e solo a
// volte.

import { sql } from 'kysely';
import type { Database } from '#src/db/pool.ts';
// Lo stesso `romeMidnight` delle statistiche: ce n'e' uno solo apposta.
import { romeMidnight as romeMidnightOf } from '#src/stats/read.ts';
import {
  BEST_RATED_MIN_SAMPLE,
  type DialogTurn,
  DUELS_CONTRACT_VERSION,
  type DuelsBucket,
  type DuelsCombo,
  type DuelsModeScore,
  type DuelsOthers,
  type DuelsRatingRow,
  type DuelsRatings,
  type DuelsRecent,
  type DuelsTrends,
  type DuelsWindow,
  duelsGrid,
  duelsWindowOf,
  p95Of,
  type Range,
  RECENT_PAGE_SIZE,
  TOP_LIMIT,
} from './contract.ts';
import { BadCursor, type DuelsProvider, type RecentQuery } from './provider.ts';

/**
 * La granularita' dell'andamento del voto.
 *
 * Differisce da quella delle partite su `7d`: 168 punti orari su ~94
 * valutazioni al giorno darebbero una media calcolata su zero o un voto per
 * punto, cioe' rumore disegnato come segnale. Il giorno e' la grana giusta,
 * e sul `24h` — dove il giorno darebbe UN punto — si torna all'ora.
 */
const RATING_BUCKET: Record<Range, DuelsBucket> = {
  '24h': 'hour',
  '7d': 'day',
  '30d': 'day',
  '90d': 'day',
  '1y': 'week',
};

/** L'espressione che etichetta un bucket, in epoch secondi. */
function bucketExpr(bucket: DuelsBucket) {
  if (bucket === 'hour') return sql`extract(epoch FROM bucket_at)::bigint`;
  if (bucket === 'day') {
    return sql`extract(epoch FROM (local_day::timestamp AT TIME ZONE 'Europe/Rome'))::bigint`;
  }
  // `date_trunc('week', ...)` su una DATA da' il lunedi', e su una data non
  // esiste il problema dell'ora legale: si sceglie il giorno, poi lo si
  // ancora alla mezzanotte di Roma.
  return sql`extract(epoch FROM (date_trunc('week', local_day)::timestamp AT TIME ZONE 'Europe/Rome'))::bigint`;
}

type SeriesRow = { t: string; match_type: string; context: string; matches: number };
type CellRow = { dow: number; hour: number; matches: number };
type CoverRow = { dow: number; hour: number };
type ModeAggRow = {
  mode_id: number;
  display_name: string;
  ranking: string | null;
  mode_type: string | null;
  color: string | null;
  matches: number;
};
type MapAggRow = { map_id: number; display_name: string | null; map_type: string | null; matches: number };
type RatingDayRow = {
  t: string;
  n: number;
  sum_rating: number;
  with_comment: number;
  r1: number;
  r2: number;
  r3: number;
  r4: number;
  r5: number;
};

export class PgDuelsProvider implements DuelsProvider {
  readonly kind = 'postgres' as const;

  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async modeIds(): Promise<Set<number>> {
    const res = await sql<{ mode_id: number }>`SELECT mode_id FROM stats.v_duels_mode`.execute(this.db);
    return new Set(res.rows.map((r) => r.mode_id));
  }

  /** Il primo giorno che esiste davvero, per la banda «raccolta iniziata il». */
  private async sinceOf(source: 'match' | 'rating'): Promise<string | null> {
    const res = await sql<{ since: string | null }>`
      SELECT to_char(since_day, 'YYYY-MM-DD') AS since
        FROM stats.v_duels_ingest WHERE source = ${source}
    `.execute(this.db);
    return res.rows[0]?.since ?? null;
  }

  async trends(range: Range, now: Date): Promise<DuelsTrends> {
    const w = duelsWindowOf(range, now);
    const grid = duelsGrid(w);
    const index = new Map(grid.map((t, i) => [t, i]));

    const [series, cells, cover, modes, maps, since] = await Promise.all([
      this.seriesRows(w),
      this.heatmapRows(w),
      this.coverageRows(w),
      this.modeRows(w),
      this.mapRows(w),
      this.sinceOf('match'),
    ]);

    // Una serie per combinazione (tipo, contesto) PRESENTE nel periodo. Le
    // combinazioni assenti non si inventano: la tab corrispondente non
    // comparira', ed e' cio' che deve succedere.
    const combos = new Map<string, DuelsCombo>();
    let total = 0;
    for (const row of series) {
      const at = index.get(Number(row.t));
      if (at === undefined) continue; // fuori griglia: non puo' succedere, e se succede non si inventa un punto
      // Il separatore non e' decorativo: senza, ('A','BC') e ('AB','C')
      // sarebbero la stessa chiave, e due combinazioni distinte si
      // sommerebbero in una sola serie.
      const key = `${row.match_type}${row.context}`;
      let combo = combos.get(key);
      if (!combo) {
        combo = { type: row.match_type, context: row.context, v: new Array(grid.length).fill(0) };
        combos.set(key, combo);
      }
      combo.v[at] = (combo.v[at] ?? 0) + row.matches;
      total += row.matches;
    }

    // I bucket precedenti a `since` valgono `null`, non zero: prima di quella
    // data il dato NON ESISTE, e uno zero direbbe «nessuna partita».
    const sinceSec = since ? sinceEpoch(since) : null;
    // E i bucket interamente FUTURI valgono `null` per la stessa ragione: la
    // finestra arriva alla mezzanotte che verra', quindi le ore di oggi che
    // non sono ancora arrivate cadono dentro la griglia. Uno zero direbbe
    // «nessuna partita in quell'ora», che di un'ora non ancora accaduta e'
    // falso — e sull'area si vedrebbe come un crollo fino a fondo scala.
    const nowSec = Math.floor(now.getTime() / 1_000);
    for (const combo of combos.values()) {
      for (let i = 0; i < grid.length; i += 1) {
        const at = grid[i] as number;
        if (at >= nowSec) combo.v[i] = null;
        else if (sinceSec !== null && at < sinceSec) combo.v[i] = null;
      }
    }

    const heat = this.heatmapCells(cells, cover);

    return {
      v: DUELS_CONTRACT_VERSION,
      range,
      bucket: w.bucket,
      t: grid,
      combos: [...combos.values()].sort(
        (a, b) => a.type.localeCompare(b.type) || a.context.localeCompare(b.context),
      ),
      heatmap: { cells: heat, p95: p95Of(heat) },
      // Sempre zero: `created_at` non e' mai NULL all'origine. Resta nel
      // contratto, non nell'interfaccia.
      untimed: 0,
      ...topOf(
        modes.map((m) => ({
          id: m.mode_id,
          name: m.display_name,
          ranking: m.ranking,
          type: m.mode_type,
          color: m.color,
          matches: m.matches,
        })),
        'modes',
      ),
      ...topOf(
        maps.map((m) => ({
          id: m.map_id,
          name: m.display_name,
          type: m.map_type,
          matches: m.matches,
        })),
        'maps',
      ),
      totals: { matches: total },
      since,
      liveTail: w.liveTail,
      builtAt: Date.now(),
    };
  }

  private async seriesRows(w: DuelsWindow): Promise<SeriesRow[]> {
    const res = await sql<SeriesRow>`
      SELECT ${bucketExpr(w.bucket)}::text AS t, match_type, context, sum(matches)::int AS matches
        FROM stats.v_duels_hour
       WHERE bucket_at >= ${w.from} AND bucket_at < ${w.to}
       GROUP BY 1, 2, 3
       ORDER BY 1
    `.execute(this.db);
    return res.rows;
  }

  private async heatmapRows(w: DuelsWindow): Promise<CellRow[]> {
    const res = await sql<CellRow>`
      SELECT local_dow AS dow, local_hour AS hour, sum(matches)::int AS matches
        FROM stats.v_duels_hour
       WHERE bucket_at >= ${w.from} AND bucket_at < ${w.to}
       GROUP BY 1, 2
    `.execute(this.db);
    return res.rows;
  }

  /**
   * Le celle che il periodo COPRE, che non sono sempre tutte e 168.
   *
   * Un periodo di ventiquattro ore tocca ventiquattro coppie (giorno, ora);
   * le altre 144 non sono «zero partite», sono «fuori periodo», e disegnarle
   * come zero direbbe che di domenica alle tre non gioca nessuno quando
   * domenica non e' nemmeno nell'intervallo.
   */
  private async coverageRows(w: DuelsWindow): Promise<CoverRow[]> {
    const res = await sql<CoverRow>`
      SELECT DISTINCT
             (extract(isodow FROM (h AT TIME ZONE 'Europe/Rome'))::int - 1) AS dow,
             extract(hour FROM (h AT TIME ZONE 'Europe/Rome'))::int         AS hour
        FROM generate_series(${w.from}::timestamptz,
                             ${w.to}::timestamptz - interval '1 hour',
                             interval '1 hour') g(h)
    `.execute(this.db);
    return res.rows;
  }

  private heatmapCells(cells: CellRow[], cover: CoverRow[]): (number | null)[] {
    const out: (number | null)[] = new Array(168).fill(null);
    for (const c of cover) out[c.dow * 24 + c.hour] = 0;
    for (const c of cells) out[c.dow * 24 + c.hour] = c.matches;
    return out;
  }

  private async modeRows(w: DuelsWindow): Promise<ModeAggRow[]> {
    // Il conteggio sta DENTRO la derivata: partire dal catalogo e contare per
    // ogni modalita' farebbe scansionare i fatti una volta per modalita'.
    const res = await sql<ModeAggRow>`
      SELECT m.mode_id, m.display_name, m.ranking, m.mode_type, m.color,
             COALESCE(a.matches, 0)::int AS matches
        FROM stats.v_duels_mode m
        LEFT JOIN (
              SELECT mode_id, sum(matches)::int AS matches
                FROM stats.v_duels_hour
               WHERE bucket_at >= ${w.from} AND bucket_at < ${w.to}
               GROUP BY mode_id) a ON a.mode_id = m.mode_id
       ORDER BY COALESCE(a.matches, 0) DESC, m.display_name ASC
    `.execute(this.db);
    return res.rows;
  }

  private async mapRows(w: DuelsWindow): Promise<MapAggRow[]> {
    // Anche le mappe partono dal CATALOGO, come le modalita'. Nel legacy le
    // mappe partivano dai fatti e quelle mai giocate sparivano: due riquadri
    // visivamente gemelli con due semantiche diverse. E l'ordinamento ha il
    // suo pari merito, o le mappe a pari conteggio si riordinano a ogni
    // richiesta e la lista «salta».
    const res = await sql<MapAggRow>`
      SELECT m.map_id, m.display_name, m.map_type, COALESCE(a.matches, 0)::int AS matches
        FROM stats.v_duels_map m
        LEFT JOIN (
              SELECT map_id, sum(matches)::int AS matches
                FROM stats.v_duels_hour
               WHERE bucket_at >= ${w.from} AND bucket_at < ${w.to}
               GROUP BY map_id) a ON a.map_id = m.map_id
       ORDER BY COALESCE(a.matches, 0) DESC, m.display_name ASC NULLS LAST, m.map_id ASC
    `.execute(this.db);
    return res.rows;
  }

  async ratings(range: Range, mode: number | null, now: Date): Promise<DuelsRatings> {
    const w = duelsWindowOf(range, now);
    const bucket = RATING_BUCKET[range];
    const grid = duelsGrid({ ...w, bucket });
    const index = new Map(grid.map((t, i) => [t, i]));

    const [days, scores, since] = await Promise.all([
      range === '24h' ? this.ratingHours(w, mode) : this.ratingDays(w, mode, bucket),
      mode === null ? this.modeScores(w) : Promise.resolve([]),
      this.sinceOf('rating'),
    ]);

    let total = 0;
    let sumRating = 0;
    let withComment = 0;
    const distribution: [number, number, number, number, number] = [0, 0, 0, 0, 0];
    const n: (number | null)[] = new Array(grid.length).fill(0);
    const avg: (number | null)[] = new Array(grid.length).fill(null);
    // Le somme per bucket si accumulano e la media si calcola DOPO: farla
    // scorrere riga per riga significherebbe arrotondare a ogni passo, e su
    // una settimana l'ultimo decimale non tornerebbe con quello dei KPI.
    const sumByBucket = new Array<number>(grid.length).fill(0);

    for (const row of days) {
      total += row.n;
      sumRating += row.sum_rating;
      withComment += row.with_comment;
      distribution[0] += row.r1;
      distribution[1] += row.r2;
      distribution[2] += row.r3;
      distribution[3] += row.r4;
      distribution[4] += row.r5;

      const at = index.get(Number(row.t));
      if (at === undefined) continue;
      n[at] = (n[at] ?? 0) + row.n;
      sumByBucket[at] = (sumByBucket[at] ?? 0) + row.sum_rating;
    }

    // La media di un bucket senza voti resta `null`, non zero: zero
    // significherebbe «hanno votato zero», che sulla scala 1-5 non esiste, e
    // sul grafico sarebbe un crollo a fondo scala invece di un buco.
    for (let i = 0; i < grid.length; i += 1) {
      const count = n[i] ?? 0;
      avg[i] = count > 0 ? round2((sumByBucket[i] as number) / count) : null;
    }

    // I bucket precedenti a `since` sono `null` su ENTRAMBE le serie: un `n`
    // a zero direbbe «nessuno ha votato», e prima di quella data non c'era
    // nemmeno il sondaggio.
    // E lo sono anche i bucket interamente futuri: la finestra arriva alla
    // mezzanotte che verra', quindi contiene ore che non sono ancora accadute.
    const sinceSec = since ? sinceEpoch(since) : null;
    const nowSec = Math.floor(now.getTime() / 1_000);
    for (let i = 0; i < grid.length; i += 1) {
      const at = grid[i] as number;
      if (at >= nowSec || (sinceSec !== null && at < sinceSec)) {
        n[i] = null;
        avg[i] = null;
      }
    }

    return {
      v: DUELS_CONTRACT_VERSION,
      range,
      mode,
      total,
      average: total > 0 ? round2(sumRating / total) : 0,
      withComment,
      distribution,
      trend: { t: grid, avg, n },
      mostRated: mode === null ? pickMostRated(scores) : null,
      bestRated: mode === null ? pickBestRated(scores) : null,
      bestRatedMinSample: BEST_RATED_MIN_SAMPLE,
      since,
      builtAt: Date.now(),
    };
  }

  /** Gli aggregati giornalieri, che e' il caso normale. */
  private async ratingDays(
    w: DuelsWindow,
    mode: number | null,
    bucket: DuelsBucket,
  ): Promise<RatingDayRow[]> {
    const label =
      bucket === 'week'
        ? sql`extract(epoch FROM (date_trunc('week', day)::timestamp AT TIME ZONE 'Europe/Rome'))::bigint`
        : sql`extract(epoch FROM (day::timestamp AT TIME ZONE 'Europe/Rome'))::bigint`;
    const res = await sql<RatingDayRow>`
      SELECT ${label}::text AS t,
             sum(n)::int AS n, sum(sum_rating)::int AS sum_rating,
             sum(with_comment)::int AS with_comment,
             sum(r1)::int AS r1, sum(r2)::int AS r2, sum(r3)::int AS r3,
             sum(r4)::int AS r4, sum(r5)::int AS r5
        FROM stats.v_duels_rating_day
       WHERE day >= stats.civil_day(${w.from}) AND day < stats.civil_day(${w.to})
         AND (${mode}::int IS NULL OR mode_id = ${mode}::int)
       GROUP BY 1
       ORDER BY 1
    `.execute(this.db);
    return res.rows;
  }

  /**
   * Le ventiquattro ore, dalle righe.
   *
   * L'aggregato giornaliero non sa rispondere a «ultime ventiquattro ore»:
   * darebbe uno o due punti e un totale che copre due giorni interi. Le
   * valutazioni sono poche — un centinaio al giorno — quindi per questo range
   * si legge la tabella vera con il predicato esatto della finestra.
   */
  private async ratingHours(w: DuelsWindow, mode: number | null): Promise<RatingDayRow[]> {
    const res = await sql<RatingDayRow>`
      SELECT extract(epoch FROM date_trunc('hour', created_at))::bigint::text AS t,
             count(*)::int AS n, sum(rating)::int AS sum_rating,
             count(*) FILTER (WHERE comment IS NOT NULL AND comment <> '')::int AS with_comment,
             count(*) FILTER (WHERE rating = 1)::int AS r1,
             count(*) FILTER (WHERE rating = 2)::int AS r2,
             count(*) FILTER (WHERE rating = 3)::int AS r3,
             count(*) FILTER (WHERE rating = 4)::int AS r4,
             count(*) FILTER (WHERE rating = 5)::int AS r5
        FROM stats.v_duels_rating
       WHERE created_at >= ${w.from} AND created_at < ${w.to}
         AND (${mode}::int IS NULL OR mode_id = ${mode}::int)
       GROUP BY 1
       ORDER BY 1
    `.execute(this.db);
    return res.rows;
  }

  private async modeScores(w: DuelsWindow): Promise<DuelsModeScore[]> {
    const res = await sql<{ id: number; name: string; count: number; average: string }>`
      SELECT d.mode_id AS id, COALESCE(m.display_name, '#' || d.mode_id) AS name,
             sum(d.n)::int AS count,
             (sum(d.sum_rating)::numeric / NULLIF(sum(d.n), 0))::text AS average
        FROM stats.v_duels_rating_day d
        LEFT JOIN stats.v_duels_mode m ON m.mode_id = d.mode_id
       WHERE d.day >= stats.civil_day(${w.from}) AND d.day < stats.civil_day(${w.to})
         -- Il valore meno uno significa «nessuna modalita'»: non e' una
         -- modalita' e non puo' vincere una classifica di modalita'.
         AND d.mode_id >= 0
       GROUP BY 1, 2
      HAVING sum(d.n) > 0
    `.execute(this.db);
    return res.rows.map((r) => ({
      id: r.id,
      name: r.name,
      count: r.count,
      average: round2(Number(r.average)),
    }));
  }

  async recent(query: RecentQuery): Promise<DuelsRecent> {
    const w = duelsWindowOf(query.range, query.now);
    const cursor = query.cursor === null ? null : decodeCursor(query.cursor);
    const q = query.q?.trim() ? query.q.trim() : null;

    const where = [
      sql`r.created_at >= ${w.from} AND r.created_at < ${w.to}`,
      sql`(${query.mode}::int IS NULL OR r.mode_id = ${query.mode}::int)`,
    ];
    if (query.comment === 'with') where.push(sql`(r.comment IS NOT NULL AND r.comment <> '')`);
    if (query.comment === 'without') where.push(sql`(r.comment IS NULL OR r.comment = '')`);
    if (q !== null) {
      // ILIKE '%q%' usa l'indice GIN trigram: e' la ragione per cui
      // `player_name` e' denormalizzato in ingestione invece di venire da un
      // join, che nel legacy rendeva la ricerca non indicizzabile per
      // costruzione.
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push(sql`(r.player_name ILIKE ${like} OR r.comment ILIKE ${like})`);
    }
    if (cursor !== null) where.push(keysetPredicate(query.sort, cursor));

    const conditions = where.reduce((a, b) => sql`${a} AND ${b}`);
    const order = orderBy(query.sort);

    const [page, total] = await Promise.all([
      sql<{
        id: string;
        at: string;
        cursor_at: string;
        player_name: string | null;
        player_uuid: string | null;
        mode_id: number | null;
        mode_name: string | null;
        rating: number;
        comment: string | null;
        dialog: StoredTurn[] | null;
      }>`
        SELECT r.rating_id::text AS id,
               extract(epoch FROM r.created_at)::bigint::text AS at,
               to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,
               r.player_name, r.player_uuid::text AS player_uuid, r.mode_id,
               m.display_name AS mode_name, r.rating, r.comment, r.dialog
          FROM stats.v_duels_rating r
          LEFT JOIN stats.v_duels_mode m ON m.mode_id = r.mode_id
         WHERE ${conditions}
         ORDER BY ${order}
         LIMIT ${RECENT_PAGE_SIZE + 1}
      `.execute(this.db),
      query.withTotal
        ? sql<{ n: string }>`
            SELECT count(*)::text AS n FROM stats.v_duels_rating r WHERE ${conditions}
          `.execute(this.db)
        : Promise.resolve(null),
    ]);

    // Si legge una riga in piu' del necessario: e' l'unico modo di sapere se
    // c'e' un'altra pagina senza contare tutto.
    const more = page.rows.length > RECENT_PAGE_SIZE;
    const rows = page.rows.slice(0, RECENT_PAGE_SIZE);
    const last = rows.at(-1);

    return {
      v: DUELS_CONTRACT_VERSION,
      rows: rows.map(
        (r): DuelsRatingRow => ({
          id: r.id,
          at: Number(r.at),
          player: r.player_name,
          playerUuid: r.player_uuid,
          mode: r.mode_id,
          modeName: r.mode_name,
          rating: r.rating,
          comment: r.comment,
          dialog: onTheWire(r.dialog),
        }),
      ),
      cursor: more && last ? encodeCursor({ at: last.cursor_at, id: last.id, rating: last.rating }) : null,
      total: total ? Number(total.rows[0]?.n ?? 0) : null,
      pageSize: RECENT_PAGE_SIZE,
    };
  }
}

export type Cursor = { at: string; id: string; rating: number };

/** Opaco per chi lo riceve, non cifrato: non contiene niente di segreto. */
export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (
      typeof parsed.at !== 'string' ||
      typeof parsed.id !== 'string' ||
      typeof parsed.rating !== 'number' ||
      !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(parsed.at) ||
      !/^\d{1,19}$/.test(parsed.id)
    ) {
      throw new BadCursor();
    }
    return { at: parsed.at, id: parsed.id, rating: parsed.rating };
  } catch {
    throw new BadCursor();
  }
}

/**
 * L'ordinamento, e il cursore che gli corrisponde.
 *
 * PAGINAZIONE KEYSET, NON OFFSET. Con `OFFSET` la decima pagina fa scartare
 * al database le 135 righe precedenti a ogni richiesta, e una riga inserita
 * nel frattempo fa ricomparire un elemento gia' visto: e' la stessa lista che
 * «salta» del legacy, ma peggio, perche' li' c'era anche una COUNT(*) per
 * pagina sugli stessi join.
 */
function orderBy(sort: RecentQuery['sort']) {
  if (sort === 'worst') return sql`r.rating ASC, r.created_at DESC, r.rating_id DESC`;
  if (sort === 'best') return sql`r.rating DESC, r.created_at DESC, r.rating_id DESC`;
  return sql`r.created_at DESC, r.rating_id DESC`;
}

function keysetPredicate(sort: RecentQuery['sort'], c: Cursor) {
  const after = sql`(r.created_at, r.rating_id) < (${c.at}::timestamptz, ${c.id}::bigint)`;
  if (sort === 'worst') {
    // `rating` cresce mentre il tempo scende: le due direzioni sono opposte,
    // quindi non esiste un confronto di tupla che le esprima entrambe.
    return sql`(r.rating > ${c.rating}::smallint OR (r.rating = ${c.rating}::smallint AND ${after}))`;
  }
  if (sort === 'best') {
    return sql`(r.rating < ${c.rating}::smallint OR (r.rating = ${c.rating}::smallint AND ${after}))`;
  }
  return after;
}

/**
 * Le prime `TOP_LIMIT` righe, piu' cio' che resta fuori aggregato.
 *
 * Il legacy non tronca affatto, «per far tornare le percentuali»: la risposta
 * non ha tetto e con ottantacinque modalita' cresce con il catalogo. Qui il
 * tetto c'e' e le quote restano corrette perche' il totale si calcola
 * sull'insieme COMPLETO, non sulle righe spedite.
 */
function topOf<T extends { matches: number }>(
  rows: T[],
  what: 'modes',
): { modes: T[]; modesOthers: DuelsOthers };
function topOf<T extends { matches: number }>(
  rows: T[],
  what: 'maps',
): { maps: T[]; mapsOthers: DuelsOthers };
function topOf<T extends { matches: number }>(rows: T[], what: 'modes' | 'maps') {
  const head = rows.slice(0, TOP_LIMIT);
  const tail = rows.slice(TOP_LIMIT);
  const others: DuelsOthers = {
    n: tail.length,
    matches: tail.reduce((a, r) => a + r.matches, 0),
  };
  return what === 'modes' ? { modes: head, modesOthers: others } : { maps: head, mapsOthers: others };
}

function pickMostRated(scores: DuelsModeScore[]): DuelsModeScore | null {
  const sorted = [...scores].sort((a, b) => b.count - a.count || b.average - a.average);
  return sorted[0] ?? null;
}

function pickBestRated(scores: DuelsModeScore[]): DuelsModeScore | null {
  const sorted = scores
    .filter((s) => s.count >= BEST_RATED_MIN_SAMPLE)
    .sort((a, b) => b.average - a.average || b.count - a.count);
  return sorted[0] ?? null;
}

/** La mezzanotte di Roma di 'YYYY-MM-DD', in epoch secondi. */
function sinceEpoch(day: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  // Mezzogiorno come appiglio, poi si torna alla mezzanotte: e' l'ora piu'
  // lontana da entrambi i cambi d'ora.
  const noon = new Date(Date.UTC(y, m - 1, d, 12));
  return Math.floor(romeMidnightOf(noon).getTime() / 1_000);
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** La forma conservata nel `jsonb`: il vocabolario del gioco, com'e' arrivato. */
type StoredTurn = { role: string; content: string };

/**
 * Dal vocabolario del gioco a quello del pannello, al confine.
 *
 * `role` diventa `speaker` e `content` diventa `text`: nel pannello «role»
 * significa il ruolo di un utente, e una guardia di build vieta di leggerlo
 * proprio per questo. Rinominare qui costa una `map` su qualche turno e toglie
 * l'ambiguita' da tutta l'interfaccia.
 */
function onTheWire(stored: StoredTurn[] | null): DialogTurn[] | null {
  if (stored === null) return null;
  return stored.map(({ role, content }) => ({ speaker: role, text: content }));
}
