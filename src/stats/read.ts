// Costruzione del payload delle statistiche. Fase 2, passo 4.
//
// UNA SCANSIONE PER WIDGET, tagliata in JS. Il costo di una scansione su
// `rollup_1h` per novanta giorni e' lo stesso che si voglia una modalita' o
// venti: e' lo stesso intervallo di indice. Si paga una volta.
//
// I CONFINI DEL PERIODO si calcolano su GIORNI CIVILI di Roma, mai con
// `- interval '30 days'` su un timestamptz: nei periodi che attraversano un
// cambio ora le due cose differiscono di un'ora e il grafico scivola di un
// bucket.
//
// IL SELETTORE IN ALTO GOVERNA TUTTA LA PAGINA: andamento, heatmap, unici e
// mappa leggono la stessa finestra. Un widget che ignora il selettore e'
// peggio di un widget assente, perche' chi guarda non ha modo di sapere che
// quel riquadro sta rispondendo a un'altra domanda.

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

export type Window = { curFrom: Date; curTo: Date };

/**
 * I formattatori si costruiscono UNA VOLTA.
 *
 * `new Intl.DateTimeFormat(...)` dentro una funzione chiamata in ciclo e' la
 * spesa nascosta piu' cara di questo file: costruirne uno costa piu' che
 * usarlo. L'asse di un anno ne creava 730.
 */
const ROME_YMD = new Intl.DateTimeFormat('en-CA', {
  timeZone: ROME,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const ROME_FULL = new Intl.DateTimeFormat('en-CA', {
  timeZone: ROME,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** Lo scarto fra Roma e UTC a un dato istante, in millisecondi. */
function romeOffset(at: Date): number {
  const p = Object.fromEntries(ROME_FULL.formatToParts(at).map((x) => [x.type, x.value])) as Record<
    string,
    string
  >;
  const asUtc = Date.UTC(
    Number(p['year']),
    Number(p['month']) - 1,
    Number(p['day']),
    Number(p['hour']),
    Number(p['minute']),
    Number(p['second']),
  );
  return asUtc - at.getTime();
}

/**
 * La mezzanotte di Roma del giorno che contiene `at`, come istante.
 *
 * L'OFFSET SI MISURA, non si assume: due volte l'anno una costante
 * sbaglierebbe di un'ora, e sarebbe proprio nei giorni in cui conta. Si misura
 * due volte perche' la prima stima usa l'offset dell'istante sbagliato: presa
 * la mezzanotte come se fosse UTC, in ottobre cade dentro il fuso vecchio.
 * La seconda passata parte da un istante gia' quasi giusto e conferma.
 *
 * Prima lo scarto si ricavava da due `toLocaleString`, che costano ~170 µs a
 * chiamata: l'asse dell'1y ne faceva 730 e ci metteva 93 ms, ogni minuto, per
 * un risultato identico. Ora sono due `formatToParts` su formattatori gia'
 * costruiti, ~12 µs in tutto.
 */
function romeMidnight(at: Date): Date {
  const [y, m, d] = ROME_YMD.format(at).split('-').map(Number) as [number, number, number];
  const naive = Date.UTC(y, m - 1, d);
  const first = naive - romeOffset(new Date(naive));
  const second = naive - romeOffset(new Date(first));
  return new Date(second);
}

/**
 * Sposta di N giorni CIVILI, che non e' la stessa cosa di N per 86400.
 *
 * Mezzogiorno come appiglio non e' un dettaglio: e' l'ora piu' lontana da
 * entrambi i cambi, quindi sommare giorni li' non puo' mai far scivolare la
 * data. Poi si torna alla mezzanotte del giorno cosi' raggiunto.
 */
function shiftDays(midnight: Date, days: number): Date {
  const [y, m, d] = ROME_YMD.format(midnight).split('-').map(Number) as [number, number, number];
  return romeMidnight(new Date(Date.UTC(y, m - 1, d + days, 12)));
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
    return { curTo, curFrom: new Date(curTo.getTime() - span) };
  }
  const days = plan.days as number;
  const curTo = romeMidnight(now); // oggi si esclude: e' un giorno parziale
  return { curTo, curFrom: shiftDays(curTo, -days) };
}

type SeriesRow = {
  t: string;
  mode_key: string;
  player_seconds: string;
  players_max: number | null;
  /** L'istante VERO del massimo, non l'inizio del bucket che lo contiene. */
  players_max_at: Date | null;
  covered_s: number;
  samples: number;
};

async function seriesRows(db: Database, range: Range, w: Window): Promise<SeriesRow[]> {
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
async function heatmapRows(
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
async function heatmapModeRows(
  db: Database,
  from: Date,
  to: Date,
): Promise<Array<{ cell: number; mode_key: string; v: string }>> {
  const res = await sql<{ cell: number; mode_key: string; v: string }>`
    SELECT (extract(isodow FROM bucket AT TIME ZONE ${ROME})::int - 1) * 24
             + extract(hour FROM bucket AT TIME ZONE ${ROME})::int AS cell,
           mode_key,
           sum(player_seconds)::bigint::text AS v
      FROM stats.v_online_1h
     WHERE bucket >= ${from} AND bucket < ${to} AND server_id <> 0
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
  days: number,
): Promise<Array<{ day: string; mode_key: string; uniques: number; final: boolean }>> {
  const res = await sql<{ t: string; mode_key: string; uniques: number; final: boolean }>`
    SELECT extract(epoch FROM (u.day::timestamp AT TIME ZONE ${ROME}))::bigint::text AS t,
           m.mode_key, u.uniques, u.final
      FROM stats.mode_day_unique u
      JOIN stats.mode m USING (mode_id)
     WHERE u.day >= (stats.civil_day(${to}) - ${days}::int)
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

/**
 * Quanti giorni civili copre il range, per i widget che ragionano a giorni.
 *
 * IL SELETTORE IN ALTO GOVERNA TUTTA LA PAGINA. Prima il grafico degli unici
 * stava fisso a trenta giorni «qualunque sia il range scelto»: una scelta
 * difendibile in astratto — le persone si muovono su scala di giorni — e
 * sbagliata in pratica, perche' chi clicca «7g» si aspetta che la pagina
 * risponda, non che tre widget su quattro lo ignorino.
 *
 * Il 24h vale un giorno civile: un grafico a barre giornaliere su ventiquattro
 * ore ha una barra sola, ed e' la conseguenza onesta di quella scelta.
 */
function daysOf(range: Range): number {
  const plan = PLAN[range];
  return plan.days ?? 1;
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
async function uniquesRows(
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
  now: Date,
): Promise<Array<{ mode_key: string; cc: string | null; uniques: number }>> {
  const res = await sql<{ mode_key: string; cc: string | null; uniques: string }>`
    WITH ranged AS (
      -- DISTINCT ON perche' su piu' giorni un giocatore ha piu' righe, e la
      -- domanda e' «quante PERSONE», non «quante presenze giornaliere».
      SELECT DISTINCT ON (d.player_id) d.player_id, d.country AS cc
        FROM stats.player_day d
       WHERE d.day >= stats.civil_day(${from}) AND d.day <= stats.civil_day(${now})
       -- Prima un paese NOTO, poi il giorno piu' recente: chi e' stato visto
       -- oggi in un momento in cui la geolocalizzazione era spenta non deve
       -- perdere il paese che aveva ieri.
       ORDER BY d.player_id, (d.country IS NULL), d.day DESC
    ),
    per_mode AS (
      SELECT DISTINCT sm.mode_key, pds.player_id
        FROM stats.player_day_server pds
        JOIN stats.v_server_mode sm USING (server_id)
       WHERE pds.day >= stats.civil_day(${from}) AND pds.day <= stats.civil_day(${now})
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
async function networkFacts(db: Database): Promise<NetworkFacts> {
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
 */
async function currentMix(db: Database): Promise<{ at: number; byMode: Record<string, number> } | null> {
  const res = await sql<{ mode_key: string; players: number | null; at: string }>`
    WITH latest AS (
      SELECT max(bucket) AS b FROM stats.v_online_5m
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
async function liveDayUniques(db: Database, now: Date): Promise<number | null> {
  const res = await sql<{ n: string }>`
    SELECT count(*)::bigint::text AS n
      FROM stats.player_day
     WHERE day = stats.civil_day(${now})
  `.execute(db);
  const n = res.rows[0]?.n;
  return n === undefined ? null : Number(n);
}

async function modeLabels(
  db: Database,
): Promise<Map<string, { label: string; order: number; color: string | null }>> {
  const res = await sql<{
    mode_key: string;
    display_name: string;
    sort_order: number;
    color: string | null;
  }>`
    -- L'ORDINE E' PARTE DEL DATO, non una comodita'. Le modalita' senza
    -- colore proprio lo prendono dalla loro POSIZIONE in questo elenco: senza
    -- ORDER BY, PostgreSQL non promette nulla sull'ordine di un DISTINCT, e
    -- due esecuzioni identiche potrebbero ricolorare la schermata.
    SELECT DISTINCT mode_key, display_name, sort_order, color FROM stats.v_server_mode
     ORDER BY sort_order, mode_key
  `.execute(db);
  return new Map(
    res.rows.map((r) => [r.mode_key, { label: r.display_name, order: Number(r.sort_order), color: r.color }]),
  );
}

type ModeDictionary = Map<string, { label: string; order: number; color: string | null }>;

/**
 * I nomi di TUTTE le modalita' conosciute, non solo di quelle nel range.
 *
 * Il ritaglio sul range e' il difetto: su un periodo il cui storico non esiste
 * ancora l'elenco e' vuoto, la schermata ripiega sulla chiave grezza, e si
 * legge «arena» minuscolo dove ovunque altrove c'e' «Arena». Sembra un
 * problema di dati e invece e' una proiezione fatta nel posto sbagliato.
 *
 * `__transit__` e `__unknown__` CI SONO, perche' sono serie visibili: la torta
 * deve chiudere sul totale, e senza di loro il primo che se ne accorge
 * normalizza le percentuali — cioe' spalma i non classificati sulle modalita'
 * vere. `v_server_mode` gli da' gia' un nome («In transito», «Non
 * classificata»), che e' esattamente quello che qui serve.
 *
 * `__network__` no: e' il totale, non una modalita'. Nessun riquadro lo
 * disegna come serie, e lasciarlo in elenco sposterebbe di un posto i colori
 * di ripiego, che si scelgono per posizione.
 */
function dictionaryLabels(dict: ModeDictionary): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, v] of dict) if (key !== '__network__') out[key] = v.label;
  return out;
}

/**
 * I colori scelti dall'operatore, per chiave.
 *
 * Solo quelli davvero impostati: una modalita' senza colore non entra, e la
 * schermata ripiega. Riempire qui i buchi con un colore inventato farebbe
 * sembrare deciso cio' che non lo e', e nessuno andrebbe piu' a impostarlo.
 */
function dictionaryColors(dict: ModeDictionary): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, v] of dict) if (v.color) out[key] = v.color;
  return out;
}

type Bucket = {
  t: number;
  /** L'istante del massimo dentro questo bucket, dal grezzo. */
  peakAt: number | null;
  coveredS: number;
  byMode: Map<string, number>;
  networkSeconds: number;
  peak: number | null;
};

function collect(rows: SeriesRow[]): Bucket[] {
  const byT = new Map<number, Bucket>();
  for (const r of rows) {
    const t = Number(r.t);
    let b = byT.get(t);
    if (!b) {
      b = {
        t,
        peakAt: null,
        coveredS: Number(r.covered_s),
        byMode: new Map(),
        networkSeconds: 0,
        peak: null,
      };
      byT.set(t, b);
    }
    const seconds = Number(r.player_seconds);
    if (r.mode_key === '__network__') {
      b.networkSeconds = seconds;
      b.peak = r.players_max === null ? null : Number(r.players_max);
      b.peakAt = r.players_max_at ? Math.floor(r.players_max_at.getTime() / 1_000) : null;
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

/**
 * L'asse dei tempi, ANCORATO ALLE MEZZANOTTI CIVILI.
 *
 * IL DIFETTO CHE QUESTA FUNZIONE ESISTE PER TOGLIERE. L'asse si costruiva a
 * passi fissi di `bucketSec` secondi dall'inizio della finestra, mentre le
 * chiavi che tornano da SQL sono ancorate alla mezzanotte civile di Roma
 * (`date_trunc('day', bucket, 'Europe/Rome')`). Le due cose coincidono finche'
 * i giorni durano tutti 86400 secondi. L'ultima domenica di ottobre ne dura
 * 90000: da li' in poi la griglia e' sfasata di un'ora rispetto ai dati,
 * `byT.get(t)` non trova piu' niente, e ogni serie diventa `null`.
 *
 * NON E' UN BUCO NEI DATI, ed e' questo che lo rendeva cattivo: le righe
 * c'erano tutte e venivano scartate nell'ultimo passaggio in JS. Con copertura
 * piena seminata su un anno, i punti che trovavano il loro dato erano 88 su
 * 365. Si vedeva come un range lungo vuoto mentre i corti funzionavano — cioe'
 * come un problema di raccolta, che manda a guardare dalla parte sbagliata.
 *
 * Il 24h non passa di qui: la sua finestra e' assoluta e allineata al bucket
 * da cinque minuti, e le sue chiavi sono istanti assoluti. Li' il passo fisso
 * e' la regola giusta, non una semplificazione.
 *
 * Per gli altri, ogni giorno civile porta `24 / hoursPerBucket` punti, a
 * scarti ASSOLUTI dalla sua mezzanotte — che e' esattamente come SQL li
 * costruisce. Il conto per giorno non cambia nei giorni storti: in quello di
 * 25 ore due ore locali finiscono nello stesso punto, in quello di 23 un
 * punto resta senza dato, ed e' giusto che si veda vuoto perche' quell'ora
 * non e' esistita.
 */
function axisOf(range: Range, w: Window): number[] {
  const plan = PLAN[range];
  if (plan.source === '5m') return grid(w.curFrom, w.curTo, plan.bucketSec);

  const out: number[] = [];
  if (plan.source === '1d') {
    for (let day = w.curFrom; day.getTime() < w.curTo.getTime(); day = shiftDays(day, 1)) {
      out.push(Math.floor(day.getTime() / 1_000));
    }
    return out;
  }

  // SI CAMMINA SULLE ORE VERE E SI PRENDE LA PRIMA DI OGNI BLOCCO LOCALE.
  //
  // Non «mezzanotte piu' k volte il passo»: quel conto assume che il giorno
  // abbia 24 ore. Camminando invece sulle ore realmente esistenti e cambiando
  // punto quando cambia il blocco locale, il giorno di 23 ore ne produce uno
  // in meno e quello di 25 uno di piu' dove l'ora si ripete — che e'
  // esattamente cio' che la query raggruppa, e per la stessa ragione.
  const hours = plan.hoursPerBucket as number;
  let block = -1;
  let day = -1;
  for (let t = w.curFrom.getTime(); t < w.curTo.getTime(); t += 3_600_000) {
    const p = romeParts(new Date(t));
    const b = Math.floor(p.hour / hours) * hours;
    if (b !== block || p.day !== day) {
      out.push(Math.floor(t / 1_000));
      block = b;
      day = p.day;
    }
  }
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

/** Giorno e ora LOCALI di un istante. Serve a camminare sull'orologio di Roma. */
function romeParts(at: Date): { day: number; hour: number } {
  const p = Object.fromEntries(ROME_PARTS.formatToParts(at).map((x) => [x.type, x.value])) as Record<
    string,
    string
  >;
  return { day: Number(p['day']), hour: Number(p['hour']) };
}

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
        // L'ISTANTE VERO, non l'inizio del bucket che lo contiene. Con bucket
        // da sei ore (range 90g) l'inizio dista fino a sei ore dal massimo, e
        // lo stesso picco risultava «alle 18:00» su 90g e «alle 20:00» su 7g:
        // due risposte diverse alla stessa domanda, e per accorgersi che non
        // erano in disaccordo bisognava sapere quanto e' largo un bucket.
        peakAt = b.peakAt ?? b.t;
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
  // Nessun payload per modalita': questa funzione ne butterebbe via ventuno.
  const all = await buildAll(db, range, now, []);
  return { payload: all.overview, queryMs: all.queryMs };
}

export async function buildAll(
  db: Database,
  range: Range,
  now = new Date(),
  wanted?: readonly string[],
): Promise<AllBuild> {
  const plan = PLAN[range];
  const w = windowOf(range, now);

  // QUALI PAYLOAD PER MODALITA' SERVONO DAVVERO. Non e' un'ottimizzazione
  // marginale: le tre query per modalita' sono le piu' care del lotto —
  // `heatmapModeRows` da sola misura 1,7 s sul range 90g contro i 25 ms
  // della sua gemella di rete — e la panoramica non ne usa nemmeno una riga.
  // Pagarle sempre significava che aprire il pannello sul 90g costava
  // ventuno heatmap che nessuno avrebbe guardato, e che il range lungo era
  // troppo caro per essere riscaldato spesso: e' da li' che nasceva il
  // sintomo visibile, cioe' 24h fresco e 90g fermo a un quarto d'ora prima.
  //
  // `undefined` significa «tutte», che e' il comportamento di prima.
  const want = wanted ? new Set(wanted) : null;
  const anyMode = want === null || want.size > 0;

  const t0 = Date.now();
  const [
    rows,
    heat,
    heatByMode,
    deltas,
    labels,
    daily,
    dailyByMode,
    distinctNow,
    distinctModeNow,
    geo,
    facts,
    current,
    liveUniques,
  ] = await Promise.all([
    seriesRows(db, range, w),
    heatmapRows(db, w.curFrom, now),
    anyMode ? heatmapModeRows(db, w.curFrom, now) : [],
    deltasIn(db, w),
    modeLabels(db),
    uniquesRows(db, now, daysOf(range)),
    anyMode ? uniquesByModeRows(db, now, daysOf(range)) : [],
    distinctPlayers(db, w.curFrom, w.curTo),
    anyMode ? distinctPlayersByMode(db, w.curFrom, w.curTo) : new Map<string, number>(),
    geoRows(db, w.curFrom, now),
    networkFacts(db),
    currentMix(db),
    liveDayUniques(db, now),
  ]);
  const queryMs = Date.now() - t0;

  const cur = collect(rows);

  const modes = [...new Set(rows.map((r) => r.mode_key))]
    .filter((m) => m !== '__network__')
    .sort((a, b) => {
      const oa = labels.get(a)?.order ?? 999;
      const ob = labels.get(b)?.order ?? 999;
      return oa === ob ? a.localeCompare(b) : oa - ob;
    });

  const axis = axisOf(range, w);
  const byT = new Map(cur.map((b) => [b.t, b]));

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
  // LA MAPPA E IL KPI DEGLI UNICI ORA MISURANO PERIODI DIVERSI, e va detto
  // perche' e' una scelta e non una svista.
  //
  // La mappa guarda il giorno in corso (il design: «Giocatori unici oggi»);
  // `kpi.uniques` guarda il periodo del range ed esclude apposta il giorno
  // parziale, o il confronto con il periodo precedente sarebbe truccato. Sono
  // due domande diverse — «da dove viene la gente adesso» e «quante persone in
  // questo mese» — e le loro etichette lo dicono.
  //
  // Il difetto che questa separazione TOGLIE: finche' i due numeri dovevano
  // coincidere, bastava una riga di `player_day` committata fra le due query —
  // e a mezzanotte succede — perche' `assertPayload` rifiutasse l'intero
  // payload per un disaccordo che non era un difetto.
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
      // L'istante a cui la mappa si riferisce. Il giorno civile in corso NON
      // e' finito: questi numeri crescono durante la giornata, ed e' voluto.
      asOf: Math.floor(now.getTime() / 1_000),
      // Contata adesso su `player_day`, non ripresa da un aggregato notturno.
      exact: true,
    };
  };

  // I giocatori di una modalita' sono un SOTTOINSIEME di quelli della rete.
  //
  // E' l'unica relazione che le due mappe devono rispettare, e si rompe in un
  // modo preciso: se il join per modalita' duplicasse una riga — un giocatore
  // su due server della stessa modalita' — quella modalita' conterebbe piu'
  // persone della rete intera. Un numero piu' grande del totale non ha
  // sintomi finche' qualcuno non li mette accanto.
  const networkTotal = (geoByMode.get('__network__') ?? []).reduce((a, x) => a + x.v, 0);
  for (const [key, list] of geoByMode) {
    if (key === '__network__') continue;
    const total = list.reduce((a, x) => a + x.v, 0);
    if (total > networkTotal) {
      throw new Error(
        `payload delle statistiche non valido: la modalita\` ${key} ha ${total} giocatori sulla mappa, la rete ne ha ${networkTotal}`,
      );
    }
  }

  const kpi = kpiOf(cur, w.curFrom, w.curTo, plan.bucketSec);
  kpi.uniques = distinctNow;

  // Il grafico degli unici mostra gli ultimi trenta giorni e li confronta con
  // i trenta precedenti, qualunque sia il range scelto: e' una domanda sulle
  // PERSONE, che si muove su scala di giorni, non sulla finestra del grafico
  // dell'online.
  // L'ASSE DEI GIORNI E' UNA GRIGLIA, come quello dei grafici a linea.
  //
  // Disegnando solo i giorni tornati dalla query, un giorno senza riga fa
  // FINIRE la serie invece di lasciare un buco — ed e' il caso normale del
  // giorno in corso: la riga giornaliera nasce quando il primo bucket orario
  // viene aggregato, quindi a mezzanotte e mezza non c'e' ancora. Il grafico
  // sembrava fermo a ieri, e non c'era modo di distinguerlo da un guasto del
  // campionamento.
  //
  // Il buco e' un valore: qui vale `null`, e la barra semplicemente non si
  // disegna.
  const dayAxis: number[] = [];
  {
    let d = shiftDays(romeMidnight(now), -daysOf(range));
    const last = romeMidnight(now);
    while (d.getTime() <= last.getTime()) {
      dayAxis.push(Math.floor(d.getTime() / 1_000));
      d = shiftDays(d, 1);
    }
  }
  const dailyByDay = new Map(daily.map((d) => [Number(d.day), d]));

  // Il giorno in corso viene dalla FONTE, non dal rollup: quest'ultimo lo
  // conosce solo dopo che la prima ora e' chiusa, e fino ad allora oggi
  // sarebbe un buco. Sovrascrive anche quando il rollup ce l'ha, perche' la
  // fonte e' comunque piu' avanti di un quarto d'ora.
  const todayKey = Math.floor(romeMidnight(now).getTime() / 1_000);
  if (liveUniques !== null) {
    dailyByDay.set(todayKey, { day: String(todayKey), uniques: liveUniques, final: false });
  }
  const recent = dayAxis.map((t) => dailyByDay.get(t) ?? null);

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
    labels: dictionaryLabels(labels),
    colors: dictionaryColors(labels),
    online: { t: axis, total, peak: peakLine, series, coverage },
    kpi,
    heatmap: { v, w: wArr, n: nArr },
    uniques: {
      t: dayAxis,
      v: recent.map((d) => d?.uniques ?? null),
      final: recent.map((d) => d?.final ?? false),
    },
    current,
    geo: geoOf('__network__'),
    geoEnabled: facts.geoEnabled,
    record: facts.record,
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
    if (want && !want.has(m)) continue;
    const line = series[m] ?? [];
    const kpiMode = kpiOf(cur, w.curFrom, w.curTo, plan.bucketSec, (b) => b.byMode.get(m) ?? 0, false);
    kpiMode.uniques = distinctModeNow.get(m) ?? null;

    const byDay = dailyModeIndex.get(m);
    const modeHeat = heatModeCells.get(m) ?? new Array<number>(168).fill(0);

    perMode.set(m, {
      ...payload,
      mode: m,
      modes: [m],
      labels: dictionaryLabels(labels),
      colors: dictionaryColors(labels),
      // `total` E' la riga della modalita', non quella di rete: in questo
      // payload la domanda e' «quanti su duels», e mostrare il totale di rete
      // sotto l'etichetta di una modalita' sarebbe il disallineamento che il
      // §6.8 esiste per intercettare.
      online: { t: axis, total: line, peak: axis.map(() => null), series: { [m]: line }, coverage },
      kpi: kpiMode,
      // Denominatore e occorrenze restano quelli di RETE (vedi
      // `heatmapModeRows`): cambia solo il numeratore.
      heatmap: { v: modeHeat, w: wArr, n: nArr },
      uniques: {
        t: dayAxis,
        v: dayAxis.map((t) => byDay?.get(t)?.uniques ?? null),
        final: dayAxis.map((t) => byDay?.get(t)?.final ?? false),
      },
      // La distribuzione e' un riquadro della sola panoramica: nel payload
      // di una modalita' non ha senso, e un oggetto con una voce sola
      // sarebbe un invito a disegnarlo.
      current: null,
      geo: geoOf(m),
      geoEnabled: facts.geoEnabled,
      // Il record e' della RETE, non della modalita': per una modalita' il
      // massimo non si decompone (vedi ModePayload), quindi qui e' nullo.
      record: null,
    });
  }

  return { overview: payload, perMode, queryMs };
}
