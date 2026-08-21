// Gli invarianti che girano come JOB. Fase 2, §9.1.
//
// PERCHE' UN JOB E NON DEI TEST. I test provano il codice su dati che ho
// scelto io. Questi controlli guardano i dati VERI, mentre esistono, e
// cercano la sola classe di difetti che conta qui: quelli che non sollevano
// niente, non rompono nessun grafico e producono un numero plausibile e
// falso.
//
// NON E' UN'IPOTESI. Questa settimana il rollup giornaliero ha scritto la
// FINESTRA invece del giorno intero — 7 200 secondi coperti su 17 730
// osservati — e in produzione. Nessun test e' diventato rosso, nessuna
// pagina si e' rotta: il pannello ha mostrato una media giornaliera
// sbagliata di un fattore due e mezzo, con l'aria di essere esatta. L'ho
// scoperto perche' l'operatore ha incollato in chat il contenuto di due
// righe. `rollup_vs_raw` e `max_hierarchy` lo avrebbero detto entro un'ora.
//
// I NOMI SONO GIA' DECISI: stanno nel commento sopra `stats.integrity_check`
// nella migration 011, uno per controllo, insieme alla tabella che li
// raccoglie. Questo file li implementa e non ne inventa altri.
//
// OGNI CONTROLLO E' DELIMITATO NEL TEMPO. Un invariante che scandisce tutto
// lo storico a ogni ora diventa il costo dominante del database e finisce
// spento — cioe' la forma peggiore di controllo, quella che c'e' nel codice e
// non gira. Le finestre sono scelte perche' un giro orario copra ogni riga
// almeno una volta, con margine.
//
// I MARGINI DEL PRESENTE SI ESCLUDONO SEMPRE. Il giorno in corso, l'ora in
// corso e il bucket in corso sono per costruzione incompleti e in mezzo a una
// riscrittura: confrontarli produce allarmi che si spengono da soli, e un
// allarme che si spegne da solo insegna a ignorarlo.

import { sql } from 'kysely';
import type { Database } from '#src/db/pool.ts';

/** Quante righe colpevoli si conservano per capire cos'e' successo. */
const SAMPLE = 5;

export type CheckOutcome = {
  name: string;
  /** Righe che violano l'invariante nella finestra guardata. */
  failures: number;
  /** Le prime `SAMPLE`, per non dover ricostruire la query a mano. */
  detail: unknown;
  ms: number;
};

type Check = {
  name: string;
  /** Cosa diventa falso sullo schermo quando questo fallisce. */
  consequence: string;
  /** Deve produrre le righe COLPEVOLI: zero righe = invariante rispettata. */
  offenders: ReturnType<typeof sql>;
};

/**
 * I controlli, nell'ordine in cui il commento della migration li elenca.
 *
 * Ognuno e' una query che restituisce le righe SBAGLIATE. Non un booleano e
 * non un conteggio: le righe, perche' «121 violazioni» non si indaga e
 * «bucket 14:35, server duels_2, memorizzato 300, ricalcolato 270» si'.
 */
const CHECKS: Check[] = [
  {
    name: 'network_equals_servers',
    consequence:
      'la torta non somma al totale, e il primo che se ne accorge normalizza le percentuali spalmando i transiti sulle modalita`',
    // `poll_cycle.players` sono identita' DISTINTE; le righe per server
    // contano ognuna i propri. Un giocatore sta su un server solo — chi non
    // ha il campo `server` finisce su `__transit__`, che e' una riga come le
    // altre — quindi le due misure devono coincidere esattamente.
    //
    // Solo i cicli `ok`: gli altri non coprono niente e non hanno righe.
    offenders: sql`
      SELECT c.tick_at, c.players AS rete, coalesce(s.somma, 0) AS server
        FROM stats.poll_cycle c
        LEFT JOIN (
          SELECT tick_at, sum(players)::bigint AS somma
            FROM stats.sample_server
           WHERE tick_at >= now() - interval '24 hours'
           GROUP BY 1
        ) s ON s.tick_at = c.tick_at
       WHERE c.tick_at >= now() - interval '24 hours'
         AND c.status = 'ok'
         AND c.players::bigint IS DISTINCT FROM coalesce(s.somma, 0)
       ORDER BY c.tick_at DESC
    `,
  },
  {
    name: 'delta_agreement',
    consequence:
      'i secondi coperti da un tick valgono due cose diverse a seconda di quale tabella li legge, e le medie per server divergono da quelle di rete',
    offenders: sql`
      SELECT s.tick_at, s.server_id, s.delta_s AS server, c.delta_s AS ciclo
        FROM stats.sample_server s
        JOIN stats.poll_cycle c ON c.tick_at = s.tick_at
       WHERE s.tick_at >= now() - interval '24 hours'
         AND s.delta_s IS DISTINCT FROM c.delta_s
       ORDER BY s.tick_at DESC
    `,
  },
  {
    name: 'covered_uniform',
    consequence:
      'il denominatore torna a venire dalle righe del server, e una modalita` aperta cinque minuti al giorno con 200 giocatori batte una aperta sempre con 150',
    // La migration lo dichiara: `covered_s` e `samples` vengono da
    // `poll_cycle` e sono IDENTICI su tutte le righe dello stesso bucket. E'
    // l'invariante da cui dipende ogni media del pannello.
    offenders: sql`
      SELECT bucket,
             min(covered_s) AS covered_min, max(covered_s) AS covered_max,
             min(samples)   AS samples_min, max(samples)   AS samples_max,
             count(*)       AS righe
        FROM stats.rollup_5m
       WHERE bucket >= now() - interval '24 hours'
         AND bucket <  date_bin('5 minutes', now(), 'epoch'::timestamptz)
       GROUP BY bucket
      HAVING min(covered_s) <> max(covered_s) OR min(samples) <> max(samples)
       ORDER BY bucket DESC
    `,
  },
  {
    name: 'max_hierarchy',
    consequence:
      'il record di giocatori contemporanei diventa un numero diverso a ogni livello di zoom, e nessuno dei tre e` verificabile',
    // DUE LIVELLI, perche' la gerarchia ha due gradini e un errore puo'
    // stare in uno solo. Il giorno in corso e l'ora in corso restano fuori:
    // sono in mezzo alla propria riscrittura.
    offenders: sql`
      SELECT 'giorno' AS livello, d.day::text AS quando, d.server_id,
             d.players_max AS memorizzato, h.massimo AS ricalcolato
        FROM stats.rollup_1d d
        JOIN (
          SELECT stats.civil_day(bucket) AS day, server_id, max(players_max) AS massimo
            FROM stats.rollup_1h
           WHERE bucket >= now() - interval '30 days'
           GROUP BY 1, 2
        ) h ON h.day = d.day AND h.server_id = d.server_id
       WHERE d.day >= stats.civil_day(now() - interval '30 days')
         AND d.day <  stats.civil_day(now())
         AND d.players_max <> h.massimo
      UNION ALL
      SELECT 'ora', to_char(x.bucket, 'YYYY-MM-DD HH24:MI'), x.server_id,
             x.players_max, m.massimo
        FROM stats.rollup_1h x
        JOIN (
          SELECT date_bin('1 hour', bucket, 'epoch'::timestamptz) AS h, server_id,
                 max(players_max) AS massimo
            FROM stats.rollup_5m
           WHERE bucket >= now() - interval '48 hours'
           GROUP BY 1, 2
        ) m ON m.h = x.bucket AND m.server_id = x.server_id
       WHERE x.bucket >= now() - interval '48 hours'
         AND x.bucket <  date_bin('1 hour', now(), 'epoch'::timestamptz)
         AND x.players_max <> m.massimo
    `,
  },
  {
    name: 'rollup_vs_raw',
    consequence:
      'un difetto nel rollup scoperto dopo quarantacinque giorni: i trenta recenti si ricalcolano dal grezzo, i quindici precedenti restano sbagliati PER SEMPRE e nessuna colonna dice che lo sono',
    // L'unico controllo che rifa' il conto dalla FONTE invece di confrontare
    // due derivati fra loro. `player_seconds` e' `sum(players * delta_s)` sui
    // soli cicli `ok`, ed e' questo che si ricostruisce: se il rollup
    // cambiasse formula senza che questa query lo sappia, il controllo
    // griderebbe — ed e' il comportamento giusto, perche' un cambio di
    // formula sullo storico e' esattamente cio' che va notato.
    //
    // Ventisei ore: un giro orario copre ogni ora almeno due volte. Il grezzo
    // ne conserva trenta giorni, ma scandirli tutti ogni ora sarebbe il costo
    // dominante del database.
    offenders: sql`
      WITH ore AS (
        SELECT date_bin('1 hour', c.tick_at, 'epoch'::timestamptz) AS h,
               0::smallint AS server_id,
               sum(c.players::bigint * c.delta_s) AS player_seconds
          FROM stats.poll_cycle c
         WHERE c.tick_at >= now() - interval '26 hours' AND c.status = 'ok'
         GROUP BY 1
        UNION ALL
        SELECT date_bin('1 hour', s.tick_at, 'epoch'::timestamptz), s.server_id,
               sum(s.players::bigint * s.delta_s)
          FROM stats.sample_server s
          JOIN stats.poll_cycle c ON c.tick_at = s.tick_at AND c.status = 'ok'
         WHERE s.tick_at >= now() - interval '26 hours'
         GROUP BY 1, 2
      )
      SELECT to_char(r.bucket, 'YYYY-MM-DD HH24:MI') AS ora, r.server_id,
             r.player_seconds AS memorizzato,
             coalesce(o.player_seconds, 0) AS ricalcolato
        FROM stats.rollup_1h r
        LEFT JOIN ore o ON o.h = r.bucket AND o.server_id = r.server_id
       WHERE r.bucket >= now() - interval '26 hours'
         AND r.bucket <  date_bin('1 hour', now(), 'epoch'::timestamptz)
         AND r.player_seconds IS DISTINCT FROM coalesce(o.player_seconds, 0)
       ORDER BY r.bucket DESC
    `,
  },
  {
    name: 'ticks_missing_24h',
    consequence:
      'un fermo di Postgres produce slot MANCANTI — non c`e` dove scrivere che non si poteva scrivere — e chi non lo sa li «aggiusta» scrivendo zeri, cioe` trasforma un buco in una rete vuota',
    // LA GRIGLIA E' REGOLARE PER COSTRUZIONE: `alignMs` nello scheduler
    // esiste per questo, e senza di esso i tick sbanderebbero e un buco vero
    // non si distinguerebbe da un tick arrivato tardi.
    //
    // La tolleranza e' mezza cadenza: si cerca un ciclo VICINO allo slot, non
    // esattamente sopra, perche' `tick_at` e' l'istante in cui il giro e'
    // partito e non l'orario nominale dello slot.
    offenders: sql`
      WITH cadenza AS (SELECT nominal_delta_s::int AS n FROM stats.ingest_state WHERE id = 1),
      slot AS (
        SELECT g AS atteso
          FROM cadenza,
               generate_series(
                 to_timestamp(floor(extract(epoch FROM now() - interval '24 hours') / cadenza.n) * cadenza.n),
                 -- L'ultimo slot si esclude: potrebbe non essere ancora
                 -- scoccato, e un allarme che compare e sparisce a ogni giro
                 -- insegna a ignorarlo.
                 to_timestamp(floor(extract(epoch FROM now()) / cadenza.n) * cadenza.n) - interval '1 second',
                 make_interval(secs => cadenza.n)
               ) g
      )
      SELECT s.atteso
        FROM slot s, cadenza
       WHERE NOT EXISTS (
         SELECT 1 FROM stats.poll_cycle c
          WHERE c.tick_at >= s.atteso - make_interval(secs => cadenza.n / 2.0)
            AND c.tick_at <  s.atteso + make_interval(secs => cadenza.n / 2.0)
       )
       ORDER BY s.atteso DESC
    `,
  },
  {
    name: 'uniques_bounds',
    consequence:
      'gli unici di rete derivati sommando le modalita`: 5 000 persone diventano 11 000 con 2,2 modalita` a testa, e il numero cresce con la rotazione fra modalita` invece che con le persone',
    // GLI UNICI NON SONO ADDITIVI, ed e' tutto qui. Il totale di rete deve
    // stare fra il massimo di una singola modalita' (nessuna puo' averne piu'
    // della rete) e la somma di tutte (chi gioca a due modalita' e' contato
    // due volte in quella somma, una sola nella rete).
    //
    // Le modalita' si risolvono in lettura da `v_server_mode`, quindi la
    // somma include `__unknown__` e `__transit__`: presi da
    // `mode_day_unique`, che ha una riga solo per le modalita' del
    // dizionario, i giocatori su server non classificati mancherebbero dalla
    // somma e il limite superiore griderebbe senza motivo.
    offenders: sql`
      WITH per_modalita AS (
        SELECT p.day, vm.mode_key, count(DISTINCT p.player_id)::bigint AS unici
          FROM stats.player_day_server p
          JOIN stats.v_server_mode vm ON vm.server_id = p.server_id
         WHERE p.day >= stats.civil_day(now()) - 7 AND p.day < stats.civil_day(now())
         GROUP BY 1, 2
      ),
      limiti AS (
        SELECT day, max(unici) AS minimo, sum(unici) AS massimo FROM per_modalita GROUP BY 1
      )
      SELECT d.day::text AS giorno, d.uniques AS rete, l.minimo, l.massimo
        FROM stats.rollup_1d d
        JOIN limiti l ON l.day = d.day
       WHERE d.server_id = 0
         AND (d.uniques < l.minimo OR d.uniques > l.massimo)
       ORDER BY d.day DESC
    `,
  },
  {
    name: 'geo_sum_equals_uniques',
    consequence:
      'la mappa contata in giocatori-GIORNO (37 800 italiani) accanto al KPI contato in giocatori (5 000), con «giocatori» scritto in entrambe le legende',
    // DUE TABELLE, NON UNA, ed e' tutto il valore di questo controllo.
    //
    // La mappa esce da `player_day` (una riga per giorno e giocatore, con il
    // paese); gli unici per modalita' escono da `player_day_server` (una riga
    // per giorno, server e giocatore). Sono scritte dallo stesso ciclo e
    // devono descrivere la stessa popolazione: ogni giocatore online sta su
    // un server, e chi non ha il campo `server` sta su `__transit__`, che e'
    // un server come gli altri.
    //
    // NON SI CONFRONTA LA MAPPA CON SE STESSA. La versione ovvia di questo
    // controllo — sommare il `DISTINCT ON (player_id)` e confrontarlo con il
    // conteggio dei distinti della stessa tabella — non puo' fallire: sono la
    // stessa quantita' scritta due volte. Sarebbe un controllo inerte, cioe'
    // una riga a zero violazioni per sempre e nessuno che se ne accorge.
    //
    // Che la mappa SPEDITA e il KPI SPEDITO usino la stessa unita' e' I5, e
    // vive in `assertPayload`: si verifica a ogni costruzione, che e' prima e
    // piu' spesso di qui. Quello che `assertPayload` non puo' vedere e' che
    // le due FONTI siano d'accordo, perche' un payload costruito male da
    // entrambe torna coerente con se stesso.
    offenders: sql`
      WITH giorni AS (
        SELECT stats.civil_day(now()) - 7 AS da, stats.civil_day(now()) AS a
      ),
      anagrafica AS (
        SELECT count(DISTINCT player_id) AS n
          FROM stats.player_day, giorni
         WHERE day >= giorni.da AND day < giorni.a
      ),
      presenze AS (
        SELECT count(DISTINCT player_id) AS n
          FROM stats.player_day_server, giorni
         WHERE day >= giorni.da AND day < giorni.a
      )
      SELECT anagrafica.n AS player_day, presenze.n AS player_day_server
        FROM anagrafica, presenze
       WHERE anagrafica.n <> presenze.n
    `,
  },
];

/**
 * L'esito dell'ultimo giro, per la metrica. Vive in memoria: Prometheus
 * raschia questo processo, e leggere la tabella a ogni raschiata
 * significherebbe una query per un numero che il processo ha gia'.
 */
const LAST = new Map<string, number>();
/** Quante volte, da quando gira, un controllo ha trovato qualcosa. */
const SEEN = new Map<string, number>();

export function invariantState(): Array<{ name: string; offenders: number; seen: number }> {
  return CHECKS.map((c) => ({
    name: c.name,
    offenders: LAST.get(c.name) ?? 0,
    seen: SEEN.get(c.name) ?? 0,
  }));
}

/**
 * Un giro completo: esegue gli otto controlli e lascia una riga per ciascuno.
 *
 * SI SCRIVE SEMPRE, anche a zero violazioni. Una tabella che si popola solo
 * quando qualcosa va storto non distingue «tutto bene» da «il job e' morto tre
 * settimane fa», e sono due situazioni che richiedono azioni opposte.
 *
 * UN CONTROLLO CHE ESPLODE NON FERMA GLI ALTRI. Sono indipendenti, e il primo
 * che fallisse per una partizione potata o una query fuori tempo massimo
 * nasconderebbe tutti quelli dopo di lui.
 */
export async function runSelfcheck(db: Database): Promise<CheckOutcome[]> {
  const out: CheckOutcome[] = [];

  for (const check of CHECKS) {
    const t0 = Date.now();
    let failures = 0;
    let detail: unknown = null;

    try {
      const res = await sql<{ failures: string; sample: unknown }>`
        WITH colpevoli AS (${check.offenders}),
        primi AS (SELECT * FROM colpevoli LIMIT ${SAMPLE})
        SELECT (SELECT count(*) FROM colpevoli)::text AS failures,
               (SELECT coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb) FROM primi p) AS sample
      `.execute(db);

      const row = res.rows[0];
      failures = Number(row?.failures ?? 0);
      detail = row?.sample ?? null;
    } catch (err) {
      // Un controllo che non si puo' ESEGUIRE non e' un controllo passato.
      // Si registra come violazione con la ragione dentro: il silenzio qui
      // sarebbe indistinguibile dal successo, che e' il difetto che questo
      // file esiste per non avere.
      failures = -1;
      detail = { errore: err instanceof Error ? err.message : String(err) };
    }

    const ms = Date.now() - t0;
    LAST.set(check.name, failures);
    if (failures !== 0) SEEN.set(check.name, (SEEN.get(check.name) ?? 0) + 1);

    await sql`
      INSERT INTO stats.integrity_check (name, failures, detail)
      VALUES (${check.name}, ${failures}, ${JSON.stringify(detail)}::jsonb)
    `.execute(db);

    out.push({ name: check.name, failures, detail, ms });
  }

  // Novanta giorni di storia: serve a rispondere «da quando?», che e' la
  // prima domanda dopo «cosa». Oltre, sono righe che nessuno leggera'.
  await sql`
    DELETE FROM stats.integrity_check WHERE run_at < now() - interval '90 days'
  `.execute(db);

  return out;
}

/** I nomi dei controlli, per i test e per chi legge la tabella. */
export const CHECK_NAMES: readonly string[] = CHECKS.map((c) => c.name);

/** Cosa diventa falso quando `name` fallisce. Va nella riga di log. */
export function consequenceOf(name: string): string {
  return CHECKS.find((c) => c.name === name)?.consequence ?? 'invariante sconosciuto';
}
