// L'importazione dello storico: 166 giorni di partite, in una volta sola.
//
// NON E' IL GIRO DA TRENTA SECONDI, ed e' un file a parte proprio per questo.
// Il ciclo del pannello ha un budget di cinque secondi e lascia l'arretrato al
// ciclo dopo; qui non c'e' un ciclo dopo. Si legge finche' c'e' da leggere,
// duecentocinquanta lotti circa, e poi si VERIFICA.
//
// LA VERIFICA E' IL PUNTO. Un backfill e' la cosa che puo' andare storta in
// silenzio per eccellenza: si interrompe a meta', qualcuno lo rilancia, i
// conteggi si sommano una seconda volta e il risultato e' un grafico
// perfettamente disegnato che dice il doppio del vero. Nessun vincolo se ne
// accorge — un conteggio doppio e' un conteggio valido — e nessuno se ne
// accorge guardandolo, perche' il numero giusto non lo si sa a memoria.
//
// Quindi il numero giusto si va a chiedere alla sorgente: alla fine si
// confronta cio' che c'e' su PostgreSQL con un COUNT(*) sul MySQL, e finche'
// i due non coincidono l'importazione NON e' finita. E' l'unica affermazione
// che questo file fa senza fidarsi di se stesso.
//
// RIPARTIBILE SENZA STATO PROPRIO. Il registro di avanzamento e' il watermark
// in `stats.duels_ingest_state`, lo stesso che usa il giro da trenta secondi:
// un backfill interrotto riprende dall'ultimo lotto scritto, e — meglio
// ancora — se qualcuno accende il pannello a meta' importazione, il pannello
// prosegue da li' invece di ricominciare. Due registri separati avrebbero
// significato due verita' sullo stesso fatto.

import { type RawBuilder, sql } from 'kysely';
import type { Database } from '#src/db/pool.ts';
import { BATCH, ingestMatchBatch, ingestRatingBatch, syncCatalogs, watermarkOf } from './ingest.ts';
import type { DuelsMysql } from './mysql.ts';

/** Un lotto appena finito, per chi vuole stamparlo mentre scorre. */
export type BackfillProgress = {
  source: 'match' | 'rating';
  batch: number;
  read: number;
  total: number;
  lastId: string;
  ms: number;
};

/** Il confronto fra cio' che c'e' e cio' che ci dovrebbe essere. */
export type BackfillCheck = {
  /** Righe alla sorgente, fino al watermark raggiunto. */
  source: number;
  /** Righe (o partite contate) su PostgreSQL. */
  stored: number;
  /** Righe scartate in questo giro, che spiegano una differenza. */
  discarded: number;
  ok: boolean;
};

export type BackfillReport = {
  resumedFrom: { match: string; rating: string };
  modes: number;
  maps: number;
  matches: BackfillCheck;
  ratings: BackfillCheck;
  /** L'aggregato giornaliero dei voti, che deve tornare con le righe. */
  days: { stored: number; expected: number; ok: boolean };
  ms: number;
  ok: boolean;
};

/** Mesi senza partizione: il backfill si ferma PRIMA, non a meta'. */
export class PartitionsMissing extends Error {
  readonly table: string;
  readonly months: string[];

  constructor(table: string, months: string[]) {
    super(
      `stats.${table}: mancano le partizioni ${months.join(', ')}. ` +
        'Applicare la migration 016, che crea lo storico da gennaio 2026, prima di importare.',
    );
    this.name = 'PartitionsMissing';
    this.table = table;
    this.months = months;
  }
}

/**
 * L'intervallo di date che la sorgente copre davvero.
 *
 * MIN e MAX per intero, non la prima e l'ultima riga per id. Costa una
 * scansione su due milioni e mezzo di righe, una volta sola, ed e' il prezzo
 * per non supporre che l'ordine degli id sia l'ordine del tempo: basta una
 * riga retrodatata perche' la supposizione sia falsa, e la si scoprirebbe
 * come una partizione mancante a meta' importazione.
 */
async function sourceSpan(my: DuelsMysql, table: string): Promise<{ first: string; last: string } | null> {
  const rows = await my.rows<{ first: string | null; last: string | null }>(
    `SELECT MIN(created_at) AS first, MAX(created_at) AS last FROM ${table}`,
  );
  const span = rows[0];
  if (!span?.first || !span.last) return null;
  // La 'Z' non e' un vezzo. Le date arrivano come STRINGA — la connessione ha
  // `dateStrings` e `timezone: 'Z'`, quindi quella stringa e' ora UTC senza
  // dirlo — e PostgreSQL, se la riceve nuda, la interpreta nel fuso della
  // SESSIONE. Da Roma il primo marzo alle 00:30 diventerebbe il 28 febbraio,
  // e il controllo cercherebbe la partizione del mese sbagliato: mancante
  // quella giusta, si importerebbe lo stesso e si morirebbe a meta'. E' la
  // stessa ragione per cui l'ingestione scrive `slice(0, 13) + ':00:00Z'`.
  return { first: `${span.first}Z`, last: `${span.last}Z` };
}

/**
 * I mesi, nell'intervallo, per cui non esiste una partizione.
 *
 * Si guarda il NOME, che e' la forma che `stats.ensure_partitions` genera e
 * che la 016 replica per lo storico. `to_regclass` su un nome inesistente
 * restituisce NULL invece di sollevare: e' il modo di chiederlo senza provare
 * a scriverci dentro.
 */
export async function missingPartitions(
  db: Database,
  table: string,
  first: string,
  last: string,
): Promise<string[]> {
  const res = await sql<{ month: string }>`
    SELECT to_char(m, 'YYYY_MM') AS month
      FROM generate_series(
             date_trunc('month', ${first}::timestamptz AT TIME ZONE 'UTC'),
             date_trunc('month', ${last}::timestamptz AT TIME ZONE 'UTC'),
             interval '1 month') g(m)
     WHERE to_regclass('stats.' || quote_ident(${table} || '_' || to_char(m, 'YYYY_MM'))) IS NULL
     ORDER BY 1
  `.execute(db);
  return res.rows.map((r) => r.month);
}

/** Un conteggio dal MySQL, che con `bigNumberStrings` arriva come stringa. */
async function countAtSource(my: DuelsMysql, table: string, upTo: bigint): Promise<number> {
  const rows = await my.rows<{ n: string | number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE id <= ?`, [
    upTo.toString(),
  ]);
  return Number(rows[0]?.n ?? 0);
}

/** Un conteggio da PostgreSQL: `::bigint` torna come stringa, non come numero. */
async function countHere(db: Database, query: RawBuilder<{ n: string }>): Promise<number> {
  const res = await query.execute(db);
  return Number(res.rows[0]?.n ?? 0);
}

/**
 * Importa tutto lo storico e poi lo conta.
 *
 * Se un altro ingeritore sta lavorando — il giro da trenta secondi del
 * pannello, di solito — il primo lotto in conflitto solleva `WatermarkMoved` e
 * l'eccezione ESCE DA QUI invece di essere assorbita: durante un backfill un
 * secondo scrittore non e' una condizione da tollerare in silenzio, e' la cosa
 * da fermare.
 */
export async function runDuelsBackfill(
  db: Database,
  my: DuelsMysql,
  opts: { onProgress?: (p: BackfillProgress) => void } = {},
): Promise<BackfillReport> {
  const started = Date.now();
  const onProgress = opts.onProgress ?? (() => undefined);

  // 1. Le partizioni, PRIMA di leggere una riga.
  const matchSpan = await sourceSpan(my, 'duels_match_statistics');
  if (matchSpan) {
    const gaps = await missingPartitions(db, 'duels_match_hour', matchSpan.first, matchSpan.last);
    if (gaps.length > 0) throw new PartitionsMissing('duels_match_hour', gaps);
  }
  const ratingSpan = await sourceSpan(my, 'duels_match_ratings');
  if (ratingSpan) {
    const gaps = await missingPartitions(db, 'duels_rating', ratingSpan.first, ratingSpan.last);
    if (gaps.length > 0) throw new PartitionsMissing('duels_rating', gaps);
  }

  // 2. I cataloghi: le schermate mostrano nomi, non identificativi.
  const catalogs = await syncCatalogs(db, my);

  // 3. Le partite, a lotti, senza budget: qui non c'e' un ciclo successivo.
  let matchAt = await watermarkOf(db, 'match');
  const resumedFrom = { match: matchAt.toString(), rating: '0' };
  let matches = 0;
  for (let batch = 1; ; batch += 1) {
    const at = Date.now();
    const done = await ingestMatchBatch(db, my, matchAt);
    matches += done.read;
    matchAt = done.lastId;
    if (done.read > 0) {
      onProgress({
        source: 'match',
        batch,
        read: done.read,
        total: matches,
        lastId: matchAt.toString(),
        ms: Date.now() - at,
      });
    }
    if (done.read < BATCH) break;
  }

  // 4. Le valutazioni. Sono poche, ma il codice e' lo stesso.
  let ratingAt = await watermarkOf(db, 'rating');
  resumedFrom.rating = ratingAt.toString();
  let ratings = 0;
  let discarded = 0;
  for (let batch = 1; ; batch += 1) {
    const at = Date.now();
    const done = await ingestRatingBatch(db, my, ratingAt);
    ratings += done.read;
    discarded += done.discarded;
    ratingAt = done.lastId;
    if (done.read > 0) {
      onProgress({
        source: 'rating',
        batch,
        read: done.read,
        total: ratings,
        lastId: ratingAt.toString(),
        ms: Date.now() - at,
      });
    }
    if (done.read < BATCH) break;
  }

  // 5. LA VERIFICA. Si confronta col watermark RAGGIUNTO, non con un tetto
  //    preso all'inizio: mentre l'importazione girava sono arrivate partite
  //    nuove, e contarle alla sorgente ma non qui darebbe un falso allarme
  //    ogni volta. `id <= watermark` e' esattamente l'insieme che si doveva
  //    importare, e non si muove piu'.
  const matchSource = await countAtSource(my, 'duels_match_statistics', matchAt);
  const matchStored = await countHere(
    db,
    sql<{ n: string }>`SELECT COALESCE(sum(matches), 0)::bigint AS n FROM stats.duels_match_hour`,
  );
  const ratingSource = await countAtSource(my, 'duels_match_ratings', ratingAt);
  const ratingStored = await countHere(
    db,
    sql<{ n: string }>`SELECT count(*)::bigint AS n FROM stats.duels_rating`,
  );
  const daysStored = await countHere(
    db,
    sql<{ n: string }>`SELECT COALESCE(sum(n), 0)::bigint AS n FROM stats.duels_rating_day`,
  );

  const matchesCheck: BackfillCheck = {
    source: matchSource,
    stored: matchStored,
    discarded: 0,
    ok: matchSource === matchStored,
  };
  const ratingsCheck: BackfillCheck = {
    source: ratingSource,
    stored: ratingStored,
    discarded,
    // Una riga scartata spiega una differenza di uno, e va detto quante:
    // senza il termine, uno scarto legittimo e un'importazione monca si
    // presenterebbero identici.
    ok: ratingSource === ratingStored + discarded,
  };
  // L'aggregato giornaliero e' ricalcolato, non sommato: se il ricalcolo
  // saltasse un giorno la somma non tornerebbe, ed e' l'unico modo di
  // accorgersene senza aprire le schermate e fidarsi dell'occhio.
  const daysCheck = { stored: daysStored, expected: ratingStored, ok: daysStored === ratingStored };

  return {
    resumedFrom,
    modes: catalogs.modes,
    maps: catalogs.maps,
    matches: matchesCheck,
    ratings: ratingsCheck,
    days: daysCheck,
    ms: Date.now() - started,
    ok: matchesCheck.ok && ratingsCheck.ok && daysCheck.ok,
  };
}
