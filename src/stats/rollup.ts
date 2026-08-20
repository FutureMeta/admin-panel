// La catena di rollup 5m -> 1h -> 1d. Fase 2, passo 3.
//
// IL PUNTO IN CUI QUASI TUTTI SBAGLIANO, e va detto prima del codice perche'
// il codice qui sotto e' costruito attorno a questo.
//
// Il DENOMINATORE di una media non puo' mai venire dalle stesse righe del
// numeratore. La convenzione sparsa — nessuna riga per (bucket, server)
// significa zero giocatori — e' giusta per lo spazio ed e' una trappola per le
// medie: le righe di un server esistono solo per i bucket in cui aveva
// giocatori, quindi sommare i suoi `covered_s` divide per il tempo in cui quel
// server era APERTO, non per il tempo del periodo.
//
// Concretamente: un evento aperto cinque minuti al giorno con 200 giocatori
// riporterebbe media 200 sull'ora e 200 sul giorno, e risulterebbe la modalita'
// piu' popolosa della rete. Il numero e' perfettamente plausibile e
// completamente falso.
//
// Quindi, senza eccezioni: `covered_s` e `samples` di OGNI riga vengono dalla
// riga di rete (`server_id = 0`), che esiste per ogni bucket coperto perche'
// nasce dal registro dei cicli e non dal grezzo. Sono identici per tutti i
// server dello stesso bucket, e denormalizzati apposta — cosi' la somma
// gerarchica resta esatta senza join e nessuno puo' ricavarli per sbaglio
// dalle righe sbagliate.
//
// Il resto sono interi ADDITIVI e basta: la gerarchia e' esatta, non
// approssimata, e nessuno puo' ottenere due medie diverse per lo stesso
// periodo su due schermate. Nessuna colonna `avg`: `sum(real)` accumula in
// float4 e sommare 8.760 valori per il range annuale perde cifre visibili a
// occhio.

import { sql } from 'kysely';
import type { Database } from '#src/db/pool.ts';

export type RollupLevel = '5m' | '1h' | '1d';

export type RollupResult = {
  level: RollupLevel;
  from: Date;
  to: Date;
  rowsWritten: number;
  /** Bucket ancora da recuperare. Finche' e' > 0 il giro va rilanciato subito. */
  behindBuckets: number;
  caughtUp: boolean;
};

/**
 * Il passo della SORGENTE di ogni livello, in millisecondi.
 *
 * Per `1d` e' un'ora e non un giorno: il livello giornaliero consuma bucket
 * orari, e il watermark misura la posizione nel flusso di origine.
 */
const SOURCE_STRIDE_MS: Record<RollupLevel, number> = {
  '5m': 300_000,
  '1h': 3_600_000,
  '1d': 3_600_000,
};

/**
 * Quanto si torna indietro a ogni giro.
 *
 * Due bucket, per assorbire i tick arrivati in ritardo senza ricalcolare
 * storico. L'upsert e' TOTALE, quindi rifare un bucket non produce mai un
 * doppio conteggio: e' quella proprieta' che rende il lookback gratuito.
 */
const LOOKBACK_BUCKETS = 2;

type StateRow = { watermark: Date; max_buckets: number };

async function lockState(db: Database, level: RollupLevel): Promise<StateRow> {
  // `FOR UPDATE` sulla riga di livello E' il lock del job. Con una sola
  // istanza applicativa un advisory lock difenderebbe da una concorrenza che
  // per costruzione non esiste — e un lock che nessuno esercita e' codice che
  // nessuno verifica.
  const res = await sql<StateRow>`
    SELECT watermark, max_buckets FROM stats.rollup_state
     WHERE level = ${level} FOR UPDATE
  `.execute(db);
  const row = res.rows[0];
  if (!row) throw new Error(`stats.rollup_state senza riga per il livello ${level}`);
  return row;
}

/**
 * La finestra da elaborare in questo giro.
 *
 * IL CATCH-UP E' LIMITATO, e non e' cautela: senza, il primo giro dopo un
 * fermo di trenta giorni aggrega quasi due milioni di righe in un solo
 * statement, viene ucciso dallo `statement_timeout`, ritentato ogni quindici
 * secondi, e il watermark non avanza MAI. Stallo permanente, grafici vuoti, e
 * un log che dice soltanto «rollup fallito».
 */
function windowOf(state: StateRow, level: RollupLevel, now: number): { from: Date; to: Date } {
  const stride = SOURCE_STRIDE_MS[level];
  const lo = state.watermark.getTime();
  // Il bucket in corso si esclude: sta ancora riempiendosi, e rientrera' al
  // giro successivo attraverso il lookback.
  const closed = Math.floor(now / stride) * stride;
  const to = Math.min(closed, lo + state.max_buckets * stride);
  return {
    from: new Date(Math.min(lo, to) - LOOKBACK_BUCKETS * stride),
    to: new Date(Math.max(lo, to)),
  };
}

/** Un giro su un livello. Idempotente: rieseguirlo non cambia niente. */
export async function runRollup(db: Database, level: RollupLevel, now = Date.now()): Promise<RollupResult> {
  return db.transaction().execute(async (tx) => {
    const state = await lockState(tx, level);
    const { from, to } = windowOf(state, level, now);

    const rowsWritten = to.getTime() <= state.watermark.getTime() ? 0 : await aggregate(tx, level, from, to);

    const stride = SOURCE_STRIDE_MS[level];
    const closed = Math.floor(now / stride) * stride;
    const behindBuckets = Math.max(0, Math.round((closed - to.getTime()) / stride));

    await sql`
      UPDATE stats.rollup_state
         SET watermark = ${to}, rows_written = ${rowsWritten},
             behind_buckets = ${behindBuckets}, updated_at = now()
       WHERE level = ${level}
    `.execute(tx);

    return { level, from, to, rowsWritten, behindBuckets, caughtUp: behindBuckets === 0 };
  });
}

async function aggregate(db: Database, level: RollupLevel, from: Date, to: Date): Promise<number> {
  if (level === '5m') return rollup5m(db, from, to);
  if (level === '1h') return rollup1h(db, from, to);
  return rollup1d(db, from, to);
}

/**
 * 5m dal grezzo.
 *
 * Due sorgenti, e la distinzione e' strutturale: la riga di rete
 * (`server_id = 0`) viene dal REGISTRO DEI CICLI, dove `players` e' l'insieme
 * deduplicato delle identita'; le righe per server vengono dal grezzo. Il
 * totale di rete non e' la somma dei server e non lo si ricava da essa —
 * `max()` e `count(distinct)` non si decompongono — quindi si memorizza.
 */
async function rollup5m(db: Database, from: Date, to: Date): Promise<number> {
  const res = await sql`
    WITH cov AS (
      SELECT date_bin('5 minutes', c.tick_at, 'epoch'::timestamptz) AS bucket,
             sum(c.delta_s)::int AS covered_s,
             count(*)::int       AS samples
        FROM stats.poll_cycle c
       WHERE c.tick_at >= ${from} AND c.tick_at < ${to} AND c.status = 'ok'
       GROUP BY 1
    ),
    net AS (
      SELECT date_bin('5 minutes', c.tick_at, 'epoch'::timestamptz) AS bucket,
             0::smallint                        AS server_id,
             sum(c.players::bigint * c.delta_s) AS player_seconds,
             max(c.players)                     AS players_max,
             (array_agg(c.tick_at ORDER BY c.players DESC, c.tick_at))[1] AS players_max_at
        FROM stats.poll_cycle c
       WHERE c.tick_at >= ${from} AND c.tick_at < ${to} AND c.status = 'ok'
       GROUP BY 1
    ),
    srv AS (
      SELECT date_bin('5 minutes', s.tick_at, 'epoch'::timestamptz) AS bucket,
             s.server_id,
             sum(s.players::bigint * s.delta_s) AS player_seconds,
             max(s.players)                     AS players_max,
             (array_agg(s.tick_at ORDER BY s.players DESC, s.tick_at))[1] AS players_max_at
        FROM stats.sample_server s
        -- Solo i tick con stato ok: un ciclo parziale o fallito non porta
        -- informazione negativa e non deve entrare in nessuna media.
        JOIN stats.poll_cycle c ON c.tick_at = s.tick_at AND c.status = 'ok'
       WHERE s.tick_at >= ${from} AND s.tick_at < ${to}
       GROUP BY 1, 2
    )
    INSERT INTO stats.rollup_5m
      (bucket, server_id, samples, covered_s, player_seconds, players_max, players_max_at)
    SELECT n.bucket, n.server_id, cov.samples, cov.covered_s,
           n.player_seconds, n.players_max, n.players_max_at
      FROM (SELECT * FROM net UNION ALL SELECT * FROM srv) n
      JOIN cov ON cov.bucket = n.bucket
    -- Upsert TOTALE: rieseguire un giro non produce mai un doppio conteggio,
    -- ed e' cio' che rende il lookback e il ricalcolo sicuri.
    ON CONFLICT (bucket, server_id) DO UPDATE SET
      samples = EXCLUDED.samples, covered_s = EXCLUDED.covered_s,
      player_seconds = EXCLUDED.player_seconds,
      players_max = EXCLUDED.players_max, players_max_at = EXCLUDED.players_max_at
  `.execute(db);
  return Number(res.numAffectedRows ?? 0);
}

/**
 * 1h da 5m. Somme pure: il grezzo non si tocca piu'.
 *
 * `covered_s` e `samples` dell'ora vengono dalla RIGA DI RETE dei bucket da
 * cinque minuti, non dalle righe del server. Sommarli per server darebbe il
 * tempo in cui quel server era aperto — che e' il difetto descritto in testa
 * a questo file, e che qui si materializzerebbe in silenzio perche' un server
 * vuoto in un bucket semplicemente non ha la riga.
 */
async function rollup1h(db: Database, from: Date, to: Date): Promise<number> {
  const res = await sql`
    WITH cov AS (
      SELECT date_bin('1 hour', bucket, 'epoch'::timestamptz) AS h,
             sum(covered_s)::int AS covered_s,
             sum(samples)::int   AS samples
        FROM stats.rollup_5m
       WHERE bucket >= ${from} AND bucket < ${to} AND server_id = 0
       GROUP BY 1
    ),
    agg AS (
      SELECT date_bin('1 hour', bucket, 'epoch'::timestamptz) AS h, server_id,
             sum(player_seconds) AS player_seconds,
             max(players_max)    AS players_max,
             (array_agg(players_max_at ORDER BY players_max DESC, bucket))[1] AS players_max_at
        FROM stats.rollup_5m
       WHERE bucket >= ${from} AND bucket < ${to}
       GROUP BY 1, 2
    )
    INSERT INTO stats.rollup_1h
      (bucket, server_id, samples, covered_s, player_seconds, players_max, players_max_at)
    SELECT agg.h, agg.server_id, cov.samples, cov.covered_s,
           agg.player_seconds, agg.players_max, agg.players_max_at
      FROM agg JOIN cov ON cov.h = agg.h
    ON CONFLICT (bucket, server_id) DO UPDATE SET
      samples = EXCLUDED.samples, covered_s = EXCLUDED.covered_s,
      player_seconds = EXCLUDED.player_seconds,
      players_max = EXCLUDED.players_max, players_max_at = EXCLUDED.players_max_at
  `.execute(db);
  return Number(res.numAffectedRows ?? 0);
}

/**
 * 1d da 1h, sul giorno civile di Roma.
 *
 * MAI `date_bin` per il livello giornaliero: ha un'origine assoluta e produce
 * giorni UTC. Il giorno di Roma e' `stats.civil_day`, e usare l'altro farebbe
 * scivolare ogni bucket di una o due ore rendendo la heatmap sbagliata in modo
 * credibile — cioe' nel modo peggiore.
 *
 * `expected_s` viene da `stats.day_seconds` e non e' 86400: due volte l'anno
 * vale 82.800 e 90.000. Con una costante la copertura di quei due giorni
 * esce al 104% e al 96%, e qualcuno perde un pomeriggio a cercare il bug
 * nell'ingest.
 */
async function rollup1d(db: Database, from: Date, to: Date): Promise<number> {
  const res = await sql`
    WITH cov AS (
      SELECT stats.civil_day(bucket) AS day,
             sum(covered_s)::int AS covered_s,
             sum(samples)::int   AS samples
        FROM stats.rollup_1h
       WHERE bucket >= ${from} AND bucket < ${to} AND server_id = 0
       GROUP BY 1
    ),
    agg AS (
      SELECT stats.civil_day(bucket) AS day, server_id,
             sum(player_seconds) AS player_seconds,
             max(players_max)    AS players_max,
             (array_agg(players_max_at ORDER BY players_max DESC, bucket))[1] AS players_max_at
        FROM stats.rollup_1h
       WHERE bucket >= ${from} AND bucket < ${to}
       GROUP BY 1, 2
    )
    INSERT INTO stats.rollup_1d
      (day, server_id, samples, covered_s, expected_s, player_seconds, players_max, players_max_at)
    SELECT agg.day, agg.server_id, cov.samples, cov.covered_s, stats.day_seconds(agg.day),
           agg.player_seconds, agg.players_max, agg.players_max_at
      FROM agg JOIN cov ON cov.day = agg.day
    ON CONFLICT (day, server_id) DO UPDATE SET
      samples = EXCLUDED.samples, covered_s = EXCLUDED.covered_s,
      expected_s = EXCLUDED.expected_s,
      player_seconds = EXCLUDED.player_seconds,
      players_max = EXCLUDED.players_max, players_max_at = EXCLUDED.players_max_at
    -- Le colonne NON additive (uniques, sessions, session_seconds) le scrive
    -- la chiusura giornaliera e questo giro non le tocca: azzerarle qui le
    -- cancellerebbe a ogni passaggio del lookback.
    --
    -- E un giorno dichiarato FINALE non si riscrive affatto. Un numero che il
    -- committente ha gia' letto e annotato non puo' cambiare in silenzio.
      WHERE stats.rollup_1d.final = false
  `.execute(db);
  return Number(res.numAffectedRows ?? 0);
}

/**
 * Riporta indietro il watermark di un livello, per ricalcolare.
 *
 * Non ricalcola da se': rimette il segnalibro e lascia che il catch-up
 * limitato risalga un pezzo alla volta. E' la sola via sicura, perche' un
 * ricalcolo di trenta giorni in un solo statement e' esattamente cio' che il
 * limite esiste per impedire.
 */
export async function rewind(db: Database, level: RollupLevel, to: Date): Promise<void> {
  await sql`
    UPDATE stats.rollup_state
       SET watermark = ${to}, behind_buckets = 0, updated_at = now()
     WHERE level = ${level} AND watermark > ${to}
  `.execute(db);
}
