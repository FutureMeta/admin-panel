// Le letture delle statistiche. Una funzione per widget, una scansione per
// funzione; chi le mette insieme e' `read.ts`.

import { sql } from 'kysely';
import type { Database } from '#src/db/pool.ts';
import { PLAN, ROME, type Window } from './calendar.ts';
import { type Range, round1 } from './contract.ts';

export type SeriesRow = {
  t: string;
  mode_key: string;
  player_seconds: string;
  players_max: number | null;
  /** L'istante VERO del massimo, non l'inizio del bucket che lo contiene. */
  players_max_at: Date | null;
  covered_s: number;
  samples: number;
};

export async function seriesRows(db: Database, range: Range, w: Window): Promise<SeriesRow[]> {
  const plan = PLAN[range];

  if (plan.source === '5m') {
    const res = await sql<SeriesRow>`
      WITH src AS (
        SELECT bucket, mode_key, player_seconds, covered_s, samples, players_max, players_max_at
          FROM stats.v_online_5m
         WHERE bucket >= ${w.curFrom} AND bucket < ${w.curTo}
      ),
      cov AS (SELECT bucket, covered_s, samples FROM src WHERE mode_key = '__network__')
      SELECT extract(epoch FROM s.bucket)::bigint::text AS t, s.mode_key,
             sum(s.player_seconds)::bigint::text AS player_seconds,
             max(s.players_max) AS players_max,
             (array_agg(s.players_max_at ORDER BY s.players_max DESC NULLS LAST))[1] AS players_max_at,
             c.covered_s, c.samples
        FROM src s
        JOIN cov c ON c.bucket = s.bucket
       GROUP BY 1, 2, c.covered_s, c.samples
       ORDER BY 1
    `.execute(db);
    return res.rows;
  }

  if (plan.source === '1h') {
    const hours = plan.hoursPerBucket as number;
    const res = await sql<SeriesRow>`
      WITH src AS (
        -- IL BLOCCO E' UNA COPPIA (giorno locale, ora locale di inizio), non
        -- un istante calcolato.
        --
        -- Prima la chiave era una mezzanotte locale piu' n ore ASSOLUTE.
        -- Coincide con l'orologio finche' i giorni durano 24 ore. Il 29 marzo
        -- ne dura 23: mezzanotte piu' 23 ore assolute E' gia' la mezzanotte
        -- del giorno dopo, quindi le 23:00 di domenica e le 00:00 di lunedi'
        -- finivano nello stesso bucket, e un'ora di traffico veniva
        -- attribuita al giorno sbagliato.
        --
        -- Riportare la coppia a un istante con AT TIME ZONE non basta: il 26
        -- ottobre le 02:00 locali esistono DUE volte, e chiedere al fuso
        -- quale sia quell'ora ha due risposte ugualmente vere. Si prende
        -- invece il PRIMO bucket osservato del blocco (min(bucket), sotto):
        -- e' un istante misurato, non dedotto, e l'asse lo puo' ricostruire
        -- camminando sulle stesse ore invece di ricalcolarlo.
        SELECT date_trunc('day', bucket AT TIME ZONE ${ROME}) AS d,
               (extract(hour FROM bucket AT TIME ZONE ${ROME})::int / ${hours}) * ${hours} AS b,
               bucket, mode_key, player_seconds, covered_s, samples, players_max, players_max_at
          FROM stats.v_online_1h
         WHERE bucket >= ${w.curFrom} AND bucket < ${w.curTo}
      ),
      -- IL DENOMINATORE VIENE DALLA RIGA DI RETE. Sommarlo per modalita'
      -- darebbe il tempo in cui quella modalita' era aperta.
      cov AS (
        SELECT d, b, min(bucket) AS t,
               sum(covered_s)::int AS covered_s, sum(samples)::int AS samples
          FROM src WHERE mode_key = '__network__' GROUP BY 1, 2
      )
      SELECT extract(epoch FROM c.t)::bigint::text AS t, s.mode_key,
             sum(s.player_seconds)::bigint::text AS player_seconds,
             max(s.players_max) AS players_max,
             (array_agg(s.players_max_at ORDER BY s.players_max DESC NULLS LAST))[1] AS players_max_at,
             c.covered_s, c.samples
        FROM src s
        JOIN cov c ON c.d = s.d AND c.b = s.b
       GROUP BY c.t, s.mode_key, c.covered_s, c.samples
       ORDER BY 1
    `.execute(db);
    return res.rows;
  }
  const res = await sql<SeriesRow>`
    WITH src AS (
      SELECT day, mode_key, player_seconds, covered_s, samples, players_max, players_max_at
        FROM stats.v_online_1d
      -- stats.civil_day, MAI il parametro nudo, ed e' l'unico punto in cui
      -- questo file lo sbagliava.
      --
      -- La colonna day e' una DATE. Scrivendo day >= $1, PostgreSQL inferisce
      -- $1 come date, e il driver serializza la Date di JavaScript nel fuso
      -- del PROCESSO. Con il pannello in un container a UTC, la mezzanotte
      -- romana del 21 viaggia come 2026-08-20T22:00Z e come data diventa il
      -- 20: la finestra scivola indietro di un giorno e taglia via l'ultimo,
      -- che su un pannello acceso da poco e' l'unico giorno che esista.
      --
      -- Il difetto e' INVISIBILE dove il processo sta a Roma — quindi in ogni
      -- test scritto sulla macchina di chi lo ha scritto — e presente solo in
      -- produzione. Le altre sette query su colonne date passano tutte da
      -- civil_day: questa era l'unica rimasta indietro.
       WHERE day >= stats.civil_day(${w.curFrom}) AND day < stats.civil_day(${w.curTo})
    ),
    cov AS (SELECT day, covered_s, samples FROM src WHERE mode_key = '__network__')
    SELECT
           extract(epoch FROM (s.day::timestamp AT TIME ZONE ${ROME}))::bigint::text AS t,
           s.mode_key,
           sum(s.player_seconds)::bigint::text AS player_seconds,
           max(s.players_max) AS players_max,
           (array_agg(s.players_max_at ORDER BY s.players_max DESC NULLS LAST))[1] AS players_max_at,
           c.covered_s, c.samples
      FROM src s
      JOIN cov c ON c.day = s.day
     GROUP BY 1, 2, c.covered_s, c.samples
     ORDER BY 1
  `.execute(db);
  return res.rows;
}

/**
 * La heatmap 7x24, dalla sola riga di rete.
 *
 * FINO A ORA, non fino alla mezzanotte scorsa. La finestra dei confronti
 * escludeva il giorno in corso per non mettere un periodo parziale contro uno
 * completo; qui non si confronta niente, e quella regola faceva sparire le ore
 * di oggi da tutti i range a giorni.
 *
 * La cella dell'ora IN CORSO resta comunque vuota: i bucket orari nascono
 * quando l'ora e' chiusa, quindi si colora circa cinque minuti dopo lo
 * scoccare dell'ora successiva. Non e' un ritardo che si possa togliere senza
 * inventare una media su un'ora incompleta.
 *
 * TRE array e mai la media gia' divisa. Nei giorni di cambio ora una cella
 * locale ha zero occorrenze (l'ora saltata di marzo) o due (l'ora ripetuta di
 * ottobre): con la sola media quella cella mente e nessuno puo' accorgersene
 * guardandola — ed e' l'unica cella che qualcuno controllera' a mano.
 */
export async function heatmapRows(
  db: Database,
  from: Date,
  to: Date,
): Promise<Array<{ cell: number; v: string; w: string; n: number }>> {
  const res = await sql<{ cell: number; v: string; w: string; n: number }>`
    SELECT (extract(isodow FROM bucket AT TIME ZONE ${ROME})::int - 1) * 24
             + extract(hour FROM bucket AT TIME ZONE ${ROME})::int AS cell,
           sum(player_seconds)::bigint::text AS v,
           sum(covered_s)::bigint::text      AS w,
           count(*)::int                     AS n
      FROM stats.v_online_1h
     WHERE bucket >= ${from} AND bucket < ${to} AND server_id = 0
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
export async function heatmapModeRows(
  db: Database,
  from: Date,
  to: Date,
  only: ModeFilter,
): Promise<Array<{ cell: number; mode_key: string; v: string }>> {
  const res = await sql<{ cell: number; mode_key: string; v: string }>`
    SELECT (extract(isodow FROM bucket AT TIME ZONE ${ROME})::int - 1) * 24
             + extract(hour FROM bucket AT TIME ZONE ${ROME})::int AS cell,
           mode_key,
           sum(player_seconds)::bigint::text AS v
      FROM stats.v_online_1h
     WHERE bucket >= ${from} AND bucket < ${to} AND server_id <> 0
       AND (${sql.lit(only.all)} OR mode_key = ANY(${only.keys}::text[]))
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
export async function uniquesByModeRows(
  db: Database,
  to: Date,
  days: number,
  only: ModeFilter,
): Promise<Array<{ day: string; mode_key: string; uniques: number; final: boolean }>> {
  const res = await sql<{ t: string; mode_key: string; uniques: number; final: boolean }>`
    SELECT extract(epoch FROM (u.day::timestamp AT TIME ZONE ${ROME}))::bigint::text AS t,
           m.mode_key, u.uniques, u.final
      FROM stats.mode_day_unique u
      JOIN stats.mode m USING (mode_id)
     WHERE u.day >= (stats.civil_day(${to}) - ${days}::int)
       AND u.day <= stats.civil_day(${to})
       AND (${sql.lit(only.all)} OR m.mode_key = ANY(${only.keys}::text[]))
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
export async function distinctPlayersByMode(
  db: Database,
  from: Date,
  to: Date,
  only: ModeFilter,
  seen: boolean,
): Promise<Map<string, number>> {
  const res = seen
    ? await sql<{ mode_key: string; n: string }>`
        SELECT sm.mode_key, count(DISTINCT ps.player_id)::bigint::text AS n
          FROM stats.player_server_seen ps
          JOIN stats.v_server_mode sm USING (server_id)
         WHERE ps.last_day >= stats.civil_day(${from})
           AND (${sql.lit(only.all)} OR sm.mode_key = ANY(${only.keys}::text[]))
         GROUP BY sm.mode_key
      `.execute(db)
    : await sql<{ mode_key: string; n: string }>`
        SELECT sm.mode_key, count(DISTINCT pds.player_id)::bigint::text AS n
          FROM stats.player_day_server pds
          JOIN stats.v_server_mode sm USING (server_id)
         WHERE pds.day >= stats.civil_day(${from}) AND pds.day < stats.civil_day(${to})
           AND (${sql.lit(only.all)} OR sm.mode_key = ANY(${only.keys}::text[]))
         GROUP BY sm.mode_key
      `.execute(db);
  return new Map(res.rows.map((r) => [r.mode_key, Number(r.n)]));
}

/**
 * Se `player_seen` e `player_server_seen` possono rispondere al posto dei
 * giorni (migration 025).
 *
 * Dicono «visto dal giorno X in poi», quindi valgono per una finestra che
 * arriva fino a oggi — e solo se dopo oggi non c'e' niente. In produzione e'
 * sempre cosi'; non lo e' per una costruzione con un `now` nel passato su
 * dati che vanno oltre, e li' si torna a contare i giorni: piu' lento, esatto.
 * Due sonde sull'indice, meno di un millisecondo.
 */
export async function seenIsCurrent(db: Database, now: Date): Promise<boolean> {
  const res = await sql<{ ok: boolean }>`
    SELECT NOT EXISTS (SELECT 1 FROM stats.player_day WHERE day > stats.civil_day(${now}))
       AND NOT EXISTS (SELECT 1 FROM stats.player_day_server WHERE day > stats.civil_day(${now})) AS ok
  `.execute(db);
  return res.rows[0]?.ok === true;
}

/** Le cadenze presenti nel periodo: due periodi con cadenze diverse non sono confrontabili sul massimo. */
export async function deltasIn(db: Database, w: Window): Promise<number[]> {
  const res = await sql<{ delta_s: number }>`
    SELECT DISTINCT delta_s FROM stats.v_cadence
     WHERE tick_at >= GREATEST(${w.curFrom}::timestamptz, now() - interval '90 days')
       AND tick_at < ${w.curTo}
     ORDER BY 1
  `.execute(db);
  return res.rows.map((r) => Number(r.delta_s));
}

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
export async function uniquesRows(
  db: Database,
  to: Date,
  days: number,
): Promise<Array<{ day: string; uniques: number; final: boolean }>> {
  const res = await sql<{ t: string; uniques: number; final: boolean }>`
    SELECT extract(epoch FROM (day::timestamp AT TIME ZONE ${ROME}))::bigint::text AS t,
           uniques, final
      FROM stats.v_online_1d
     WHERE mode_key = '__network__'
       AND day >= (stats.civil_day(${to}) - ${days}::int)
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
export async function distinctPlayers(
  db: Database,
  from: Date,
  to: Date,
  seen: boolean,
): Promise<number | null> {
  const res = seen
    ? await sql<{ n: string }>`
        SELECT count(*)::bigint::text AS n FROM stats.player_seen WHERE last_day >= stats.civil_day(${from})
      `.execute(db)
    : await sql<{ n: string }>`
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
/**
 * La provenienza, di rete e — solo se servono — per modalita'.
 *
 * IL PEZZO PER MODALITA' HA UN CANCELLO, come le altre tre query per
 * modalita'. Qui era sfuggito perche' non e' una funzione a parte: sta dentro
 * la stessa query, nella CTE `per_mode`, e da fuori sembrava una query sola.
 *
 * Costava. In produzione questa era LA query del giro di warm: 2,5-3,0 secondi
 * contro numeri a una cifra per tutte le altre dodici, ripetuti su 30g, 90g e
 * 1y — cioe' i 7,9 s del giro erano quasi interamente lei. E il lavoro era
 * buttato: `deferred: 0` e `payloads: 5` dicono cinque panoramiche e zero
 * modalita', perche' nessuno aveva aperto un dettaglio.
 *
 * `sql.lit` e non un parametro: con un literal la condizione e' costante al
 * momento del piano e PostgreSQL pota l'intero ramo, invece di pianificare una
 * scansione che poi salta. Il valore e' un booleano di JavaScript, quindi non
 * c'e' niente da citare.
 */
export async function geoRows(
  db: Database,
  from: Date,
  now: Date,
  only: ModeFilter,
  seen: boolean,
): Promise<Array<{ mode_key: string; cc: string | null; uniques: number }>> {
  // UNA RIGA PER PERSONA, con il suo paese. Prima un paese NOTO, poi il
  // giorno piu' recente: chi e' stato visto oggi in un momento in cui la
  // geolocalizzazione era spenta non deve perdere il paese che aveva ieri.
  //
  // Da `player_seen` la regola e' gia' fatta: l'ultimo paese noto, se cade
  // dentro la finestra. Dai giorni serve il DISTINCT ON, perche' su piu'
  // giorni un giocatore ha piu' righe e la domanda e' «quante PERSONE».
  const ranged = seen
    ? sql`
        SELECT player_id, CASE WHEN country_day >= stats.civil_day(${from}) THEN country END AS cc
          FROM stats.player_seen
         WHERE last_day >= stats.civil_day(${from})`
    : sql`
        SELECT DISTINCT ON (d.player_id) d.player_id, d.country AS cc
          FROM stats.player_day d
         WHERE d.day >= stats.civil_day(${from}) AND d.day <= stats.civil_day(${now})
         ORDER BY d.player_id, (d.country IS NULL), d.day DESC`;
  const played = seen
    ? sql`
        SELECT ps.server_id, ps.player_id FROM stats.player_server_seen ps
         WHERE ps.last_day >= stats.civil_day(${from})`
    : sql`
        SELECT pds.server_id, pds.player_id FROM stats.player_day_server pds
         WHERE pds.day >= stats.civil_day(${from}) AND pds.day <= stats.civil_day(${now})`;
  const res = await sql<{ mode_key: string; cc: string | null; uniques: string }>`
    WITH ranged AS (${ranged}),
    per_mode AS (
      SELECT DISTINCT sm.mode_key, p.player_id
        FROM (${played}) p
        JOIN stats.v_server_mode sm USING (server_id)
       WHERE ${sql.lit(only.wanted)}
         AND (${sql.lit(only.all)} OR sm.mode_key = ANY(${only.keys}::text[]))
    )
    SELECT '__network__' AS mode_key, t.cc, count(*)::bigint::text AS uniques
      FROM ranged t GROUP BY 1, 2
    UNION ALL
    SELECT m.mode_key, t.cc, count(*)::bigint::text AS uniques
      FROM per_mode m JOIN ranged t USING (player_id) GROUP BY 1, 2
  `.execute(db);
  return res.rows.map((r) => ({ mode_key: r.mode_key, cc: r.cc, uniques: Number(r.uniques) }));
}

type NetworkFacts = {
  record: { players: number; at: number | null; since: number } | null;
  geoEnabled: boolean;
};

/**
 * Il record di sempre e lo stato della geolocalizzazione, in una lettura.
 *
 * Il record guarda TUTTO lo storico, non la finestra: e' l'unico numero del
 * payload che ignora il range, perche' «record» non ha altro significato. E
 * viaggia con la data di inizio della raccolta, perche' un record di sempre
 * calcolato su tre giorni di storico e' un record di tre giorni — e chi legge
 * non ha modo di indovinarlo dal numero.
 *
 * `geo_enabled` sta nella stessa riga di `ingest_state`, quindi costa zero e
 * evita al segnaposto della mappa di dire «manca la configurazione» a chi la
 * configurazione ce l'ha.
 */
export async function networkFacts(db: Database): Promise<NetworkFacts> {
  const res = await sql<{
    players: string | null;
    at: Date | null;
    since: Date;
    geo_enabled: boolean | null;
  }>`
    SELECT r.players_max::text AS players,
           r.players_max_at    AS at,
           i.history_start_at  AS since,
           i.geo_enabled
      FROM stats.ingest_state i
      LEFT JOIN LATERAL (
        SELECT players_max, players_max_at
          FROM stats.v_online_1d
         WHERE mode_key = '__network__' AND players_max IS NOT NULL
         ORDER BY players_max DESC, day ASC
         LIMIT 1
      ) r ON TRUE
     WHERE i.id = 1
  `.execute(db);

  const row = res.rows[0];
  if (!row) return { record: null, geoEnabled: false };
  return {
    geoEnabled: row.geo_enabled === true,
    record:
      row.players === null
        ? null
        : {
            players: Number(row.players),
            at: row.at ? Math.floor(row.at.getTime() / 1_000) : null,
            since: Math.floor(row.since.getTime() / 1_000),
          },
  };
}

/**
 * La popolazione dell'ULTIMO bucket da cinque minuti, per modalita'.
 *
 * Sempre da `rollup_5m`, qualunque range sia scelto: e' la definizione piu'
 * vicina a «adesso» che i rollup sappiano dare. Il denominatore resta quello
 * della riga di rete, come ovunque: preso per modalita' darebbe il tempo in
 * cui quella modalita' era aperta, non quello osservato.
 *
 * L'ULTIMO BUCKET SI CHIEDE ALL'INDICE, sulla riga di rete. `max(bucket)`
 * attraverso la vista — che porta il join con `v_server_mode` — leggeva TUTTA
 * `rollup_5m` a ogni costruzione: 45 ms con un mese e mezzo di dati, 160 con
 * un anno, sulla macchina di sviluppo — e la tabella tiene 400 giorni. `ORDER BY bucket DESC LIMIT 1` sulla riga 0
 * scende la chiave primaria dalla fine e si ferma alla prima: 0,2 ms. Ogni
 * bucket con righe di server ha anche la riga di rete, che viene dallo stesso
 * ciclo, quindi il bucket e' lo stesso.
 */
export async function currentMix(
  db: Database,
): Promise<{ at: number; byMode: Record<string, number> } | null> {
  const res = await sql<{ mode_key: string; players: number | null; at: string }>`
    WITH latest AS (
      SELECT bucket AS b FROM stats.v_online_5m WHERE server_id = 0 ORDER BY bucket DESC LIMIT 1
    ),
    src AS (
      SELECT v.mode_key, v.player_seconds, v.covered_s
        FROM stats.v_online_5m v, latest l
       WHERE v.bucket = l.b
    ),
    cov AS (SELECT covered_s FROM src WHERE mode_key = '__network__' LIMIT 1)
    SELECT s.mode_key,
           (sum(s.player_seconds)::float8 / nullif((SELECT covered_s FROM cov), 0)) AS players,
           extract(epoch FROM (SELECT b FROM latest))::bigint::text AS at
      FROM src s
     GROUP BY 1
  `.execute(db);

  const first = res.rows[0];
  if (!first || first.at === null) return null;
  const byMode: Record<string, number> = {};
  for (const r of res.rows) {
    if (r.mode_key === '__network__') continue;
    if (r.players !== null) byMode[r.mode_key] = round1(Number(r.players));
  }
  return { at: Number(first.at), byMode };
}

/**
 * La stessa fotografia, ma spezzata per SERVER dentro ogni modalita'.
 *
 * Serve alla schermata di dettaglio: quasi tutte le modalita' girano su piu'
 * di un server, e «duels ha 286 giocatori» non dice se sono tutti su uno o
 * sparsi su sei. Con un server solo la torta resta comunque — una fetta sola
 * e' un'informazione («questa modalita' sta tutta su `duels_1`»), mentre un
 * riquadro che appare e scompare a seconda dei dati costringe chi guarda a
 * chiedersi se manchi qualcosa.
 *
 * DENOMINATORE DI RETE, come ovunque. Preso dal server darebbe il tempo in cui
 * quel server era acceso, e un server aperto cinque minuti al giorno con 200
 * giocatori scavalcherebbe uno aperto sempre con 150.
 *
 * `server_id <> 0` e non `> 1`: `__transit__` e' un server sentinella, e se
 * qualcuno apre il dettaglio di quella modalita' deve vedere la sua riga
 * invece di una torta vuota.
 */
export async function serverMix(
  db: Database,
): Promise<Map<string, { at: number; byServer: Record<string, number> }>> {
  const res = await sql<{ mode_key: string; server_key: string; players: number | null; at: string }>`
    WITH latest AS (
      SELECT bucket AS b FROM stats.v_online_5m WHERE server_id = 0 ORDER BY bucket DESC LIMIT 1
    ),
    src AS (
      SELECT v.mode_key, v.server_key, v.player_seconds
        FROM stats.v_online_5m v, latest l
       WHERE v.bucket = l.b AND v.server_id <> 0
    ),
    cov AS (
      SELECT v.covered_s
        FROM stats.v_online_5m v, latest l
       WHERE v.bucket = l.b AND v.mode_key = '__network__'
       LIMIT 1
    )
    SELECT s.mode_key, s.server_key,
           (s.player_seconds::float8 / nullif((SELECT covered_s FROM cov), 0)) AS players,
           extract(epoch FROM (SELECT b FROM latest))::bigint::text AS at
      FROM src s
  `.execute(db);

  const out = new Map<string, { at: number; byServer: Record<string, number> }>();
  for (const r of res.rows) {
    if (r.at === null || r.players === null) continue;
    let entry = out.get(r.mode_key);
    if (!entry) {
      entry = { at: Number(r.at), byServer: {} };
      out.set(r.mode_key, entry);
    }
    entry.byServer[r.server_key] = round1(Number(r.players));
  }
  return out;
}

type ServerSeriesRow = { t: string; mode_key: string; server_key: string; player_seconds: string };

/**
 * L'andamento nel tempo SPEZZATO PER SERVER, dentro le modalita' chieste.
 *
 * E' `seriesRows` un gradino piu' giu', ed e' la stessa relazione che la
 * panoramica ha con la rete: li' una riga per il totale e una per ogni
 * modalita', qui una per la modalita' e una per ogni suo server. Chi apre il
 * dettaglio di duels e vede un gradino nella curva vuole sapere se e' calata
 * la modalita' o si e' spento un server, e da una riga sola non si distingue.
 *
 * DIETRO IL CANCELLO, come ogni query per modalita': la panoramica non
 * disegna queste righe e non deve pagarle. Su questa rete sarebbero venti
 * server per ogni bucket del periodo — sull'anno, centinaia di migliaia di
 * righe raggruppate per niente.
 *
 * NESSUN DENOMINATORE QUI DENTRO. La copertura e' quella di RETE, gia' letta
 * da `seriesRows` per lo stesso bucket: rileggerla vorrebbe dire un secondo
 * join per la stessa colonna, e prenderla dal server darebbe il tempo in cui
 * quel server era acceso — un server aperto cinque minuti scavalcherebbe uno
 * aperto sempre. La divisione la fa chi assembla, con l'unico denominatore
 * che esiste.
 *
 * L'ASSE E' QUELLO DELLA RETE anche qui. Sul ramo orario la chiave del blocco
 * e' `min(bucket)` preso dalle righe di rete, non da quelle del server:
 * prendendolo dal server, uno acceso a meta' blocco produrrebbe un `t` che
 * sull'asse non esiste, e la sua riga sparirebbe senza dirlo.
 */
export async function serverSeriesRows(
  db: Database,
  range: Range,
  w: Window,
  only: ModeFilter,
): Promise<ServerSeriesRow[]> {
  const plan = PLAN[range];

  if (plan.source === '5m') {
    const res = await sql<ServerSeriesRow>`
      SELECT extract(epoch FROM bucket)::bigint::text AS t, mode_key, server_key,
             sum(player_seconds)::bigint::text AS player_seconds
        FROM stats.v_online_5m
       WHERE bucket >= ${w.curFrom} AND bucket < ${w.curTo}
         AND server_id <> 0
         AND (${sql.lit(only.all)} OR mode_key = ANY(${only.keys}::text[]))
       GROUP BY 1, 2, 3
       ORDER BY 1
    `.execute(db);
    return res.rows;
  }

  if (plan.source === '1h') {
    const hours = plan.hoursPerBucket as number;
    const res = await sql<ServerSeriesRow>`
      WITH src AS (
        SELECT date_trunc('day', bucket AT TIME ZONE ${ROME}) AS d,
               (extract(hour FROM bucket AT TIME ZONE ${ROME})::int / ${hours}) * ${hours} AS b,
               bucket, mode_key, server_key, server_id, player_seconds
          FROM stats.v_online_1h
         WHERE bucket >= ${w.curFrom} AND bucket < ${w.curTo}
      ),
      cov AS (
        SELECT d, b, min(bucket) AS t FROM src WHERE mode_key = '__network__' GROUP BY 1, 2
      )
      SELECT extract(epoch FROM c.t)::bigint::text AS t, s.mode_key, s.server_key,
             sum(s.player_seconds)::bigint::text AS player_seconds
        FROM src s
        JOIN cov c ON c.d = s.d AND c.b = s.b
       WHERE s.server_id <> 0
         AND (${sql.lit(only.all)} OR s.mode_key = ANY(${only.keys}::text[]))
       GROUP BY 1, 2, 3
       ORDER BY 1
    `.execute(db);
    return res.rows;
  }

  const res = await sql<ServerSeriesRow>`
    SELECT extract(epoch FROM (day::timestamp AT TIME ZONE ${ROME}))::bigint::text AS t,
           mode_key, server_key,
           sum(player_seconds)::bigint::text AS player_seconds
      FROM stats.v_online_1d
     -- stats.civil_day, MAI il parametro nudo: la colonna e' una DATE, e una
     -- Date di JavaScript ci arriverebbe nel fuso del processo.
     WHERE day >= stats.civil_day(${w.curFrom}) AND day < stats.civil_day(${w.curTo})
       AND server_id <> 0
       AND (${sql.lit(only.all)} OR mode_key = ANY(${only.keys}::text[]))
     GROUP BY 1, 2, 3
     ORDER BY 1
  `.execute(db);
  return res.rows;
}

/**
 * Gli unici del giorno IN CORSO, presi da `player_day` invece che dai rollup.
 *
 * PERCHE' NON DAL ROLLUP. `rollup_1d` nasce da `rollup_1h`, che scrive un
 * bucket solo quando l'ora e' CHIUSA: la riga giornaliera di oggi non esiste
 * prima che la prima ora del giorno sia finita e aggregata — fra mezzanotte e
 * circa l'1:20 non c'e' affatto. Il grafico degli unici restava senza barra
 * per oggi, e la carta KPI mostrava un trattino, ogni notte.
 *
 * `player_day` invece ha una riga per (giorno, giocatore) dall'apertura della
 * prima sessione, quindi il numero c'e' entro trenta secondi dalla
 * mezzanotte. E' anche piu' AGGIORNATO del rollup durante il giorno: la
 * chiusura giornaliera ricopia questo stesso conteggio ogni quarto d'ora.
 *
 * Un giorno solo, quindi il costo e' una partizione e un conteggio.
 */
export async function liveDayUniques(db: Database, now: Date): Promise<number | null> {
  const res = await sql<{ n: string }>`
    SELECT count(*)::bigint::text AS n
      FROM stats.player_day
     WHERE day = stats.civil_day(${now})
  `.execute(db);
  const n = res.rows[0]?.n;
  return n === undefined ? null : Number(n);
}

/**
 * Quali modalita' devono davvero entrare nelle query per modalita'.
 *
 * NON BASTA UN BOOLEANO, e questo lo abbiamo imparato in produzione. Il
 * cancello `anyMode` toglieva il lavoro quando nessuno guardava una
 * modalita'; appena la schermata di dettaglio e' esistita, l'hot-set ha smesso
 * di essere vuoto e le query sono tornate tutte — a calcolare UNDICI modalita'
 * per servirne una. Il giro di warm e' risalito da 846 ms a 8 secondi e la
 * rotta del dettaglio rispondeva in 1,2-2,9 s.
 *
 * `all` e' un literal SQL, non un parametro: cosi' la condizione e' costante
 * al momento del piano e PostgreSQL pota il confronto invece di valutarlo per
 * riga.
 */
export type ModeFilter = {
  /** Serve almeno una modalita'? Se no, l'intero ramo non si esegue. */
  wanted: boolean;
  /** Tutte quelle che esistono, senza elenco. */
  all: boolean;
  /** L'elenco, quando non sono tutte. */
  keys: string[];
};

/**
 * IL BUCKET IN CORSO, costruito dalla sorgente piu' fine che ce l'ha.
 *
 * PERCHE' SERVE, e perche' senza di lui la finestra allargata non basta.
 * `runRollup` scrive un bucket solo quando e' COMPLETO piu' cinque minuti di
 * grazia (`SETTLE_MS`), e lo fa apposta: un'ora scritta a meta' verrebbe letta
 * bassa e poi cambierebbe da sola, che e' la cosa che questo schema rifiuta
 * ovunque. Ma la conseguenza e' che il livello orario non conosce l'ora in
 * corso, e quello giornaliero non conosce OGGI fino a domani.
 *
 * Aprire la finestra fino ad adesso, quindi, non basta: l'ultimo punto
 * esisteva sull'asse e restava vuoto. E un punto vuoto il grafico lo disegna
 * come «non rilevato» — che di quell'ora e' falso, perche' rilevata lo e'
 * stata: i tick ci sono, e' l'aggregazione a non essere ancora passata. Sul
 * range 1y era peggio: la colonna di oggi restava vuota SEMPRE, perche'
 * `rollup_1d` la scrive l'indomani.
 *
 * Si legge quindi da `v_online_5m`, che il ciclo aggiorna ogni minuto ed e'
 * fine abbastanza per qualunque bucket. E' la stessa strada che il payload fa
 * gia' per gli unici del giorno in corso (`liveDayUniques`) e per la
 * ripartizione corrente (`currentMix`): il dato vivo viene dal livello sotto.
 *
 * COPERTURA PARZIALE, DICHIARATA. `covered_s` copre solo i minuti gia'
 * passati, quindi `coverage` di quel bucket sta sotto 1 e la media e' quella
 * di cio' che si e' visto finora. E' il numero giusto accompagnato dalla sua
 * incertezza — e il grafico lo tratteggia (`liveTail`), i KPI lo escludono.
 */
export async function liveBucketRows(db: Database, at: number, now: Date): Promise<SeriesRow[]> {
  const res = await sql<SeriesRow>`
    WITH src AS (
      SELECT mode_key, player_seconds, covered_s, samples, players_max, players_max_at
        FROM stats.v_online_5m
       WHERE bucket >= to_timestamp(${at}) AND bucket < ${now}
    ),
    -- IL DENOMINATORE VIENE DALLA RIGA DI RETE, come in tutte le altre query
    -- di questo file: sommarlo per modalita' darebbe il tempo in cui quella
    -- modalita' era aperta, non quello osservato.
    cov AS (
      SELECT coalesce(sum(covered_s), 0)::int AS covered_s,
             coalesce(sum(samples), 0)::int AS samples
        FROM src WHERE mode_key = '__network__'
    )
    SELECT ${at}::bigint::text AS t, s.mode_key,
           sum(s.player_seconds)::bigint::text AS player_seconds,
           max(s.players_max) AS players_max,
           (array_agg(s.players_max_at ORDER BY s.players_max DESC NULLS LAST))[1] AS players_max_at,
           c.covered_s, c.samples
      FROM src s CROSS JOIN cov c
     GROUP BY s.mode_key, c.covered_s, c.samples
  `.execute(db);
  return res.rows;
}

/** Le righe per server dello stesso bucket in corso: senza, la scomposizione del dettaglio si fermerebbe un punto prima del totale. */
export async function liveServerRows(
  db: Database,
  at: number,
  now: Date,
  only: ModeFilter,
): Promise<ServerSeriesRow[]> {
  const res = await sql<ServerSeriesRow>`
    SELECT ${at}::bigint::text AS t, mode_key, server_key,
           sum(player_seconds)::bigint::text AS player_seconds
      FROM stats.v_online_5m
     WHERE bucket >= to_timestamp(${at}) AND bucket < ${now}
       AND server_id <> 0
       AND (${sql.lit(only.all)} OR mode_key = ANY(${only.keys}::text[]))
     GROUP BY 1, 2, 3
  `.execute(db);
  return res.rows;
}
