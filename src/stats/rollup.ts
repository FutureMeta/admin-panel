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

/**
 * I livelli che hanno una riga in `stats.rollup_state`.
 *
 * `daily_close` non e' un livello di aggregazione: non ha bucket e non ha
 * arretrato misurabile in bucket. Condivide il segnalibro e il lock, e basta —
 * per questo sta nel tipo dello STATO e non in quello dei livelli.
 */
type StateLevel = RollupLevel | 'daily_close';

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

/**
 * Quanto si aspetta prima di considerare COMPLETO un bucket della sorgente.
 *
 * NASCE DA UN NUMERO VISTO IN PRODUZIONE. L'invariante `rollup_vs_raw` ha
 * trovato l'ora delle 16:00 con 2 823 090 secondi-giocatore memorizzati contro
 * 3 077 490 ricalcolati dal grezzo: la differenza era 254 400, cioe' con
 * ottocentocinquanta giocatori a tick da trenta secondi ESATTAMENTE un bucket
 * da cinque minuti. Undici su dodici.
 *
 * IL MECCANISMO. I due livelli hanno watermark indipendenti e cadenze diverse
 * — 5m ogni minuto, 1h ogni cinque. Se il giro orario arriva alle 17:00:0x
 * prima che quello dei cinque minuti abbia scritto il bucket delle 16:55,
 * l'ora nasce corta. E resta corta: da li' a fine ora ogni giro orario esce
 * da `idle` (`to <= watermark`) e non tocca niente. Si ripara alle 18:00,
 * quando la finestra avanza e il lookback riscrive l'ora precedente.
 *
 * PERCHE' NON BASTA CHE SI RIPARI. Per un'ora intera i grafici a 7, 30 e 90
 * giorni leggono l'ultima ora chiusa circa l'8% piu' bassa del vero, e poi il
 * numero cambia da solo senza che niente lo dica. E' la cosa che questo schema
 * rifiuta ovunque: un valore letto e annotato non puo' cambiare in silenzio.
 *
 * Cinque minuti bastano con margine: il giro dei 5m esclude il bucket in corso
 * e passa ogni sessanta secondi, quindi il bucket delle 16:55 e' scritto entro
 * le 17:01. Il livello giornaliero ha la stessa grazia per la stessa ragione,
 * un gradino piu' su. Il livello 5m no: la sua sorgente e' il grezzo, che il
 * ciclo scrive nella stessa transazione del tick.
 */
const SETTLE_MS: Record<RollupLevel, number> = {
  '5m': 0,
  '1h': 300_000,
  '1d': 300_000,
};

type StateRow = { watermark: Date; max_buckets: number };

async function lockState(db: Database, level: StateLevel): Promise<StateRow> {
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
  // giro successivo attraverso il lookback. La grazia toglie anche quello
  // appena chiuso ma non ancora COMPLETO nella sorgente.
  const closed = Math.floor((now - SETTLE_MS[level]) / stride) * stride;
  const to = Math.min(closed, lo + state.max_buckets * stride);
  return {
    from: new Date(Math.min(lo, to) - LOOKBACK_BUCKETS * stride),
    to: new Date(Math.max(lo, to)),
  };
}

/** Un giro su un livello. Idempotente: rieseguirlo non cambia niente. */
/**
 * L'ultimo watermark scritto per livello, in millisecondi. Per la metrica.
 *
 * SERVE PERCHE' «IN PARI» NON E' UNA PROVA. `behind_buckets` si calcola da
 * `to`, e `to` non puo' mai stare dietro al watermark: se il watermark finisce
 * nel futuro — un orologio corretto all'indietro, uno snapshot ripristinato —
 * la finestra si chiude su se' stessa, il giro dichiara `caughtUp: true`,
 * `rows_written` conserva l'ultimo valore utile e `updated_at` continua a
 * rinfrescarsi. Il livello e' fermo per sempre e ogni segnale disponibile dice
 * che sta bene.
 *
 * Il watermark nudo invece non mente: fermo o avanti rispetto a `now` sono
 * entrambe cose che si vedono da fuori, e sono le due sole forme dello stallo.
 *
 * Sta in memoria e non si legge dal database perche' il ruolo di sola lettura
 * del pannello non ha accesso a `stats.rollup_state`, e allargarglielo
 * vorrebbe dire una migration per una metrica. Un livello che non compare e'
 * un livello che in questo processo non ha mai girato — che e' esattamente
 * l'altra cosa che si vuole sapere.
 */
const LAST_WATERMARK = new Map<string, number>();

export function rollupWatermarks(): Array<[string, number]> {
  return [...LAST_WATERMARK.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export async function runRollup(db: Database, level: RollupLevel, now = Date.now()): Promise<RollupResult> {
  return db.transaction().execute(async (tx) => {
    const state = await lockState(tx, level);
    const { from, to } = windowOf(state, level, now);

    // Fra un confine di bucket e l'altro non c'e' niente di nuovo da
    // aggregare, e il giro non fa nulla: e' il caso NORMALE, non un guasto.
    const idle = to.getTime() <= state.watermark.getTime();
    const rowsWritten = idle ? 0 : await aggregate(tx, level, from, to);

    const stride = SOURCE_STRIDE_MS[level];
    const closed = Math.floor(now / stride) * stride;
    const behindBuckets = Math.max(0, Math.round((closed - to.getTime()) / stride));

    // `rows_written` conserva l'ultimo giro che ha SCRITTO, non l'ultimo giro.
    //
    // Azzerarlo a ogni passaggio a vuoto faceva leggere zero quasi sempre, e
    // chi apre questa tabella per sapere se il rollup funziona ne concludeva
    // che fosse fermo. Una diagnostica che fa sospettare un guasto inesistente
    // e' peggio di una diagnostica assente: manda a cercare nel posto
    // sbagliato.
    await sql`
      UPDATE stats.rollup_state
         SET watermark = ${to},
             rows_written = ${idle ? sql`rows_written` : rowsWritten},
             behind_buckets = ${behindBuckets}, updated_at = now()
       WHERE level = ${level}
    `.execute(tx);

    LAST_WATERMARK.set(level, to.getTime());
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
    -- LA FINESTRA DICE QUALI GIORNI RIFARE, NON QUANTO DI OGNI GIORNO.
    --
    -- Il livello giornaliero consuma bucket ORARI: il suo watermark cammina di
    -- un'ora e la finestra e' [watermark - 2h, ora chiusa). L'unita' che
    -- scrive pero' e' il GIORNO, che e' piu' grande della finestra — e
    -- l'upsert qui sotto ASSEGNA. Aggregando dentro la finestra, la riga del
    -- giorno finiva per contenere solo le ore dell'ultima passata che lo
    -- sfiorava: due o tre, quelle di sera.
    --
    -- Non si vedeva perche' la media giornaliera e' player_seconds diviso
    -- covered_s, e la finestra stringe numeratore e denominatore INSIEME: il
    -- risultato era la media serale, un numero plausibile e piu' alto del
    -- vero. Poi la chiusura giornaliera alzava final e lo congelava.
    --
    -- Gli altri due livelli non hanno il problema: la loro unita' sta dentro
    -- la finestra. Solo questo ha un'unita' piu' grande del proprio passo.
    WITH giorni AS (
      SELECT DISTINCT stats.civil_day(bucket) AS day
        FROM stats.rollup_1h
       WHERE bucket >= ${from} AND bucket < ${to}
    ),
    ore AS (
      SELECT r.*, stats.civil_day(r.bucket) AS day
        FROM stats.rollup_1h r
        JOIN giorni g ON g.day = stats.civil_day(r.bucket)
    ),
    cov AS (
      SELECT day,
             sum(covered_s)::int AS covered_s,
             sum(samples)::int   AS samples
        FROM ore
       WHERE server_id = 0
       GROUP BY 1
    ),
    agg AS (
      SELECT day, server_id,
             sum(player_seconds) AS player_seconds,
             max(players_max)    AS players_max,
             (array_agg(players_max_at ORDER BY players_max DESC, bucket))[1] AS players_max_at
        FROM ore
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

/**
 * La chiusura giornaliera: unici, sessioni e secondi.
 *
 * SCRIVE CIO' CHE NON E' ADDITIVO, e per questo non puo' venire dal livello
 * sotto. Gli unici non si sommano: «unici di ieri piu' unici di oggi» non e'
 * «unici dei due giorni», perche' chi ha giocato entrambi conta una volta. Il
 * conteggio si fa con un `count(distinct)` sulle presenze, e si fa qui.
 *
 * La riga di rete ha un conteggio PROPRIO, non la somma delle modalita': chi
 * ha giocato a due modalita' comparirebbe due volte. E' l'invariante I6, e il
 * database non puo' imporla — la impone questo codice.
 *
 * Un giorno chiuso si marca `final` e da quel momento non si riscrive: un
 * numero che il committente ha gia' letto e annotato non puo' cambiare in
 * silenzio.
 */
export async function dailyClose(db: Database, now = new Date()): Promise<{ days: number }> {
  return db.transaction().execute(async (tx) => {
    const state = await lockState(tx, 'daily_close');

    const days = await sql<{ day: string; is_today: boolean; rolled_up: boolean }>`
      SELECT g::date::text AS day, (g::date = stats.civil_day(${now})) AS is_today,
             -- IL ROLLUP ORARIO HA GIA' SUPERATO QUESTO GIORNO?
             --
             -- Senza questa domanda, subito dopo mezzanotte questa chiusura
             -- marcava «definitivo» ieri mentre il livello '1d' doveva ancora
             -- consumarne le 22 e le 23 — che il livello '1h' scrive verso le
             -- 00:05. Chi arrivava primo decideva, e da quel momento il
             -- rollup non poteva piu' toccare la riga: un giorno amputato,
             -- congelato per sempre e non riparabile nemmeno riavvolgendo.
             (SELECT s.watermark >= (g::date + 1)::timestamp AT TIME ZONE 'Europe/Rome'
                FROM stats.rollup_state s WHERE s.level = '1d') AS rolled_up
        FROM generate_series(
               LEAST(stats.civil_day(${state.watermark}), stats.civil_day(${now}))::timestamp,
               stats.civil_day(${now})::timestamp,
               interval '1 day') g
       ORDER BY 1
       -- Tetto di sicurezza: dopo un fermo lungo si recupera un pezzo per
       -- volta, come per gli altri livelli.
       LIMIT 31
    `.execute(tx);

    for (const { day, is_today, rolled_up } of days.rows) {
      // Solo i giorni CHIUSI diventano definitivi. Il giorno in corso si
      // riscrive a ogni giro, ed e' giusto: sta ancora succedendo.
      //
      // E solo quelli che il rollup ha finito di aggregare: «definitivo» vuol
      // dire «non cambiera' piu'», e dirlo di un giorno ancora in lavorazione
      // lo blocca a meta'. Se il livello '1d' e' fermo, i giorni restano
      // riscrivibili — che e' un ritardo, mentre l'alternativa e' un numero
      // sbagliato dichiarato definitivo.
      const final = !is_today && rolled_up === true;

      await sql`
        UPDATE stats.rollup_1d d SET
          uniques         = COALESCE(u.n, 0),
          sessions        = COALESCE(p.sessions, 0),
          session_seconds = COALESCE(p.secs, 0),
          final           = ${final},
          rebuilt_at      = CASE WHEN ${final} THEN now() ELSE d.rebuilt_at END
        FROM (SELECT ${day}::date AS day) k
        LEFT JOIN LATERAL (
          SELECT count(*)::int AS n FROM stats.player_day WHERE day = k.day) u ON true
        LEFT JOIN LATERAL (
          SELECT sum(sessions)::int AS sessions, sum(seconds_online)::bigint AS secs
            FROM stats.player_day WHERE day = k.day) p ON true
        WHERE d.day = k.day AND d.server_id = 0 AND d.final = false
      `.execute(tx);

      await sql`
        UPDATE stats.rollup_1d d SET uniques = s.n, final = ${final}
          FROM (SELECT server_id, count(DISTINCT player_id)::int AS n
                  FROM stats.player_day_server WHERE day = ${day}::date
                 GROUP BY server_id) s
         WHERE d.day = ${day}::date AND d.server_id = s.server_id AND d.final = false
      `.execute(tx);

      // Gli unici PER MODALITA' sono derivati e ricostruibili: la fonte e'
      // player_day_server, chiavata sul server, che non invecchia quando
      // l'operatore riclassifica.
      await sql`
        INSERT INTO stats.mode_day_unique AS t (day, mode_id, uniques, final)
        SELECT ${day}::date, m.mode_id, count(DISTINCT ps.player_id)::int, ${final}
          FROM stats.player_day_server ps
          JOIN stats.v_server_mode m ON m.server_id = ps.server_id
         WHERE ps.day = ${day}::date AND m.mode_id IS NOT NULL
         GROUP BY m.mode_id
        ON CONFLICT (day, mode_id) DO UPDATE SET
          uniques = EXCLUDED.uniques, final = EXCLUDED.final, computed_at = now()
        WHERE t.final = false
      `.execute(tx);
    }

    const last = days.rows[days.rows.length - 1];
    if (last) {
      await sql`
        UPDATE stats.rollup_state
           SET watermark = ${last.day}::date::timestamptz, updated_at = now(),
               rows_written = ${days.rows.length}
         WHERE level = 'daily_close'
      `.execute(tx);
      LAST_WATERMARK.set('daily_close', new Date(`${last.day}T00:00:00Z`).getTime());
    }

    return { days: days.rows.length };
  });
}
