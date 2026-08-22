// L'ingestione dei duels: dal MySQL del gioco a `stats.duels_*`.
//
// PERCHE' UN ETL E NON UNA LETTURA DIRETTA. Una partita conclusa il 15 agosto
// non cambiera' mai. Aggregata una volta per ora, qualunque intervallo diventa
// una somma su poche centinaia di righe locali — e la lentezza del pannello
// legacy sparisce alla radice invece di essere nascosta da un TTL. Con la
// lettura diretta si porterebbe dentro anche la sua macchina di fuso orario,
// che inlinea un offset nella stringa SQL e rende i predicati inutilizzabili
// da qualunque indice.
//
// WATERMARK SULL'ID, e non e' una scelta fra due. Nessuna delle due tabelle
// sorgente indicizza `created_at` da sola: `duels_match_statistics` ha
// `date`, `mode_id`, `type`, `context`; `duels_match_ratings` ha
// `(player_id, created_at)` e `(mode_id, rating)`. Un recupero per finestra
// temporale sarebbe una scansione. `WHERE id > ?` sulla chiave primaria e'
// una lettura indicizzata, ed e' cio' che rende sostenibile un ciclo da
// trenta secondi.
//
// DUE CICLI DELLO STESSO PROCESSO non si accavallano: `startJob` ripianifica
// DOPO che il giro e' finito (jobs/scheduler.ts:139), nemmeno dopo un fermo
// lungo. Cio' che serve li' e' il BUDGET: un ciclo ingerisce finche' ha tempo
// e lascia il resto al successivo, cosi' il recupero dopo un'interruzione
// avviene in qualche minuto di cicli consecutivi e non in una corsa unica che
// tiene occupato il database del gioco.
//
// DUE PROCESSI DIVERSI invece si accavallano eccome — il backfill si lancia a
// mano, e il pannello nel frattempo e' acceso — e per quelli la guardia c'e':
// il watermark si scrive solo se vale ancora quello da cui il lotto e'
// partito. Vedi `WatermarkMoved`.

import { sql } from 'kysely';
import type { Database } from '#src/db/pool.ts';
import { type DuelsMysql, parseDialog, uuidFromHex, uuidOrNull } from './mysql.ts';

/** Righe lette per volta. Il valore della specifica, e regge i volumi veri. */
export const BATCH = 10_000;

/**
 * Quanto puo' durare la parte di ingestione di un ciclo.
 *
 * Cinque secondi su trenta. Non e' una stima del lavoro normale — a regime un
 * ciclo vede qualche decina di partite e finisce in millisecondi — ma il tetto
 * del RECUPERO: dopo un fermo di ore l'arretrato si smaltisce a lotti su cicli
 * consecutivi, lasciando il database del gioco libero fra l'uno e l'altro.
 */
export const BUDGET_MS = 5_000;

export type IngestResult = {
  matches: number;
  ratings: number;
  modes: number;
  maps: number;
  degraded: number;
  behind: boolean;
  contended: boolean;
  ms: number;
};

/**
 * Un altro ingeritore ha mosso il watermark mentre questo leggeva il lotto.
 *
 * SUCCEDE PER DAVVERO: il backfill si lancia a mano, e il modo naturale di
 * lanciarlo e' contro il database di produzione mentre il pannello e' acceso e
 * il suo giro da trenta secondi sta girando. Se i due lavorassero insieme
 * leggerebbero lo stesso watermark e ingerirebbero lo stesso lotto due volte:
 * l'upsert delle partite e' additivo, quindi i conteggi RADDOPPIEREBBERO senza
 * che niente fallisca. Un numero doppio e' un numero valido.
 *
 * La guardia e' un confronto-e-scambio sul watermark: si aggiorna solo se vale
 * ancora quello che si era letto. Se non vale piu', la transazione intera
 * torna indietro — conteggi compresi — e il giro si ferma dicendo perche'.
 */
export class WatermarkMoved extends Error {
  readonly source: string;

  constructor(source: string) {
    super(`watermark '${source}' mosso da un altro ingeritore: lotto annullato.`);
    this.name = 'WatermarkMoved';
    this.source = source;
  }
}

type MatchRow = {
  id: number;
  created_at: string;
  type: string;
  context: string;
  mode_id: number;
  map_id: number;
};

type RatingRow = {
  id: string;
  created_at: string;
  match_hex: string | null;
  player_id: number;
  mode_id: number | null;
  rating: number;
  comment: string | null;
  dialog: string | null;
  player_uuid: string | null;
  player_name: string | null;
};

type ModeRow = {
  id: number;
  name: string | null;
  display_name: string | null;
  ranking: string | null;
  type: string | null;
};

type MapRow = { id: number; name: string | null; display_name: string | null; type: string | null };

/** Il watermark di una sorgente, letto per il giro. */
export async function watermarkOf(db: Database, source: string): Promise<bigint> {
  const res = await sql<{ last_id: string }>`
    SELECT last_id::text FROM stats.duels_ingest_state WHERE source = ${source}
  `.execute(db);
  return BigInt(res.rows[0]?.last_id ?? '0');
}

/**
 * I cataloghi, per intero a ogni giro.
 *
 * Sono poche decine di righe e non hanno un watermark: una modalita' puo'
 * cambiare nome o colore senza che il suo id si muova, e un watermark non lo
 * vedrebbe mai. Costa due SELECT su tabelle minuscole.
 *
 * `ranking` e `mode_type` si leggono DIRETTAMENTE: in produzione `duels_mode`
 * e' post-migrazione e le due colonne esistono entrambe, NOT NULL con default.
 * Il doppio percorso a runtime del legacy — che sceglieva fra `m.ranking` e
 * `m.type` interrogando INFORMATION_SCHEMA e teneva l'esito in una Map senza
 * scadenza — non entra qui: dopo una migrazione del gioco avrebbe continuato
 * con la forma vecchia fino al riavvio del processo.
 */
export async function syncCatalogs(db: Database, my: DuelsMysql): Promise<{ modes: number; maps: number }> {
  // NIENTE `color`: quella colonna all'origine NON ESISTE — verificato in
  // produzione il 22 agosto 2026, errno 1054 su `duels_mode`. La colonna
  // `stats.duels_mode.color` resta, vuota: e' NOSTRA, e il giorno in cui la
  // schermata di configurazione lascera' scegliere un colore per modalita' e'
  // li' che finira'. Finche' e' NULL le schermate ripiegano su una posizione
  // stabile nel dizionario, che e' gia' il comportamento del resto del
  // pannello.
  const modes = await my.rows<ModeRow>(`SELECT id, name, display_name, ranking, type FROM duels_mode`);
  const maps = await my.rows<MapRow>(`SELECT id, name, display_name, type FROM duels_map`);

  if (modes.length > 0) {
    await sql`
      INSERT INTO stats.duels_mode (mode_id, name, display_name, ranking, mode_type, seen_at)
      SELECT * FROM unnest(
        ${modes.map((m) => m.id)}::smallint[],
        ${modes.map((m) => m.name ?? String(m.id))}::text[],
        ${modes.map((m) => m.display_name ?? m.name ?? String(m.id))}::text[],
        ${modes.map((m) => m.ranking ?? 'UNRANKED')}::text[],
        ${modes.map((m) => m.type ?? 'DUEL')}::text[]
      ) AS c(mode_id, name, display_name, ranking, mode_type)
      CROSS JOIN LATERAL (SELECT now() AS seen_at) t
      ON CONFLICT (mode_id) DO UPDATE SET
        name = EXCLUDED.name, display_name = EXCLUDED.display_name,
        ranking = EXCLUDED.ranking, mode_type = EXCLUDED.mode_type,
        -- Il colore NON si tocca: non viene dalla sorgente, quindi un giro di
        -- ingestione non deve poterlo cancellare. Il giorno in cui la
        -- configurazione lo lascera' scegliere, sopravvivera' ai giri.
        seen_at = EXCLUDED.seen_at
    `.execute(db);
  }

  if (maps.length > 0) {
    await sql`
      INSERT INTO stats.duels_map (map_id, name, display_name, map_type, seen_at)
      SELECT * FROM unnest(
        ${maps.map((m) => m.id)}::integer[],
        ${maps.map((m) => m.name)}::text[],
        ${maps.map((m) => m.display_name)}::text[],
        ${maps.map((m) => m.type)}::text[]
      ) AS c(map_id, name, display_name, map_type)
      CROSS JOIN LATERAL (SELECT now() AS seen_at) t
      ON CONFLICT (map_id) DO UPDATE SET
        name = EXCLUDED.name, display_name = EXCLUDED.display_name,
        map_type = EXCLUDED.map_type, seen_at = EXCLUDED.seen_at
    `.execute(db);
  }

  return { modes: modes.length, maps: maps.length };
}

/**
 * Un lotto di partite: si leggono, si contano in memoria, si sommano.
 *
 * L'AGGREGAZIONE STA IN NODE e non in una `GROUP BY` sul MySQL, per una
 * ragione sola: il gruppo deve essere calcolato sull'ORA UTC, e chiederlo al
 * database del gioco significherebbe o una espressione sul predicato — che
 * toglie l'indice — o fidarsi del suo fuso di sessione. Contare diecimila
 * righe in memoria costa niente e non chiede niente a nessuno.
 *
 * L'upsert e' ADDITIVO (`matches = matches + EXCLUDED.matches`), quindi un
 * lotto ripetuto raddoppierebbe i conteggi: e' l'unico caso da proteggere, e
 * lo protegge il fatto che il watermark si aggiorna NELLA STESSA TRANSAZIONE.
 * O si scrivono entrambi o nessuno dei due.
 */
export async function ingestMatchBatch(
  db: Database,
  my: DuelsMysql,
  from: bigint,
): Promise<{ read: number; lastId: bigint }> {
  const rows = await my.rows<MatchRow>(
    `SELECT id, created_at, type, context, mode_id, map_id
       FROM duels_match_statistics
      WHERE id > ?
      ORDER BY id
      LIMIT ?`,
    [from.toString(), BATCH],
  );
  if (rows.length === 0) return { read: 0, lastId: from };

  const counts = new Map<
    string,
    { bucket: string; mode: number; map: number; type: string; ctx: string; n: number }
  >();
  let lastId = from;
  for (const r of rows) {
    const id = BigInt(r.id);
    if (id > lastId) lastId = id;
    // `created_at` arriva come stringa (dateStrings), gia' in UTC per la
    // sessione: si tronca all'ora senza passare da un `Date` di JavaScript,
    // che sarebbe interpretato nel fuso del processo.
    const bucket = `${r.created_at.slice(0, 13)}:00:00Z`;
    const key = `${bucket}|${r.mode_id}|${r.map_id}|${r.type}|${r.context}`;
    const found = counts.get(key);
    if (found) found.n += 1;
    else counts.set(key, { bucket, mode: r.mode_id, map: r.map_id, type: r.type, ctx: r.context, n: 1 });
  }

  const agg = [...counts.values()];
  await db.transaction().execute(async (tx) => {
    await sql`
      INSERT INTO stats.duels_match_hour (bucket_at, mode_id, map_id, match_type, context, matches)
      SELECT * FROM unnest(
        ${agg.map((a) => a.bucket)}::timestamptz[],
        ${agg.map((a) => a.mode)}::smallint[],
        ${agg.map((a) => a.map)}::integer[],
        ${agg.map((a) => a.type)}::text[],
        ${agg.map((a) => a.ctx)}::text[],
        ${agg.map((a) => a.n)}::integer[]
      ) AS b(bucket_at, mode_id, map_id, match_type, context, matches)
      ON CONFLICT (bucket_at, mode_id, map_id, match_type, context)
        DO UPDATE SET matches = stats.duels_match_hour.matches + EXCLUDED.matches
    `.execute(tx);

    const bumped = await sql<{ last_id: string }>`
      UPDATE stats.duels_ingest_state
         SET last_id = ${lastId.toString()}::bigint, last_run_at = now(),
             since_day = LEAST(since_day, ${agg[0]?.bucket ?? null}::timestamptz::date)
       WHERE source = 'match'
         -- Confronto-e-scambio: vale solo se il watermark e' ancora quello da
         -- cui questo lotto e' partito. Altrimenti c'e' un secondo ingeritore
         -- e i conteggi appena sommati sono un doppione: si torna indietro.
         AND last_id = ${from.toString()}::bigint
      RETURNING last_id::text
    `.execute(tx);
    if (bumped.rows.length !== 1) throw new WatermarkMoved('match');
  });

  return { read: rows.length, lastId };
}

/**
 * Un lotto di valutazioni. Sono poche — 15.600 in tutto lo storico — quindi
 * entrano in un lotto solo, ma il codice e' lo stesso del backfill.
 *
 * IL NOME SI RISOLVE QUI, UNA VOLTA. E' il join che il legacy paga a ogni
 * richiesta, due volte, per mostrare quindici righe. `player_name` puo' essere
 * NULL e non e' un guasto: `duels_userdata.username` e' UNIQUE, quindi un
 * cambio nome deve liberare il vecchio valore prima di scrivere il nuovo — i
 * NULL transitori sono normali.
 */
export async function ingestRatingBatch(
  db: Database,
  my: DuelsMysql,
  from: bigint,
): Promise<{ read: number; lastId: bigint; degraded: number; discarded: number }> {
  const rows = await my.rows<RatingRow>(
    `SELECT r.id, r.created_at, HEX(r.match_id) AS match_hex, r.player_id, r.mode_id,
            r.rating, r.comment, r.dialog, u.uuid AS player_uuid, u.username AS player_name
       FROM duels_match_ratings r
       LEFT JOIN duels_userdata u ON u.id = r.player_id
      WHERE r.id > ?
      ORDER BY r.id
      LIMIT ?`,
    [from.toString(), BATCH],
  );
  if (rows.length === 0) return { read: 0, lastId: from, degraded: 0, discarded: 0 };

  let lastId = from;
  let degraded = 0;
  const days = new Set<string>();
  const parsed = rows.map((r) => {
    const id = BigInt(r.id);
    if (id > lastId) lastId = id;
    const dialog = parseDialog(r.dialog);
    if (dialog.degraded) degraded += 1;
    days.add(r.created_at.slice(0, 10));
    return {
      id: r.id,
      createdAt: r.created_at,
      matchId: uuidFromHex(r.match_hex),
      playerId: r.player_id,
      playerUuid: uuidOrNull(r.player_uuid),
      playerName: r.player_name,
      modeId: r.mode_id,
      rating: r.rating,
      comment: r.comment,
      dialog: dialog.turns === null ? null : JSON.stringify(dialog.turns),
    };
  });

  // `match_id` e' NOT NULL: una riga con un identificativo illeggibile non si
  // scrive, ma non ferma il lotto. E' l'unico scarto possibile, ed e' contato
  // A PARTE: la verifica del backfill confronta il numero di righe scritte con
  // il COUNT(*) della sorgente, e senza sapere quante ne sono state scartate
  // uno scarto legittimo sarebbe indistinguibile da un'importazione monca.
  const writable = parsed.filter((p) => p.matchId !== null);
  const discarded = parsed.length - writable.length;
  degraded += discarded;

  await db.transaction().execute(async (tx) => {
    if (writable.length > 0) {
      await sql`
        INSERT INTO stats.duels_rating
          (rating_id, created_at, match_id, player_id, player_uuid, player_name, mode_id, rating, comment, dialog)
        SELECT * FROM unnest(
          ${writable.map((p) => p.id)}::bigint[],
          ${writable.map((p) => p.createdAt)}::timestamptz[],
          ${writable.map((p) => p.matchId)}::uuid[],
          ${writable.map((p) => p.playerId)}::integer[],
          ${writable.map((p) => p.playerUuid)}::uuid[],
          ${writable.map((p) => p.playerName)}::text[],
          ${writable.map((p) => p.modeId)}::smallint[],
          ${writable.map((p) => p.rating)}::smallint[],
          ${writable.map((p) => p.comment)}::text[],
          ${writable.map((p) => p.dialog)}::jsonb[]
        ) AS r(rating_id, created_at, match_id, player_id, player_uuid, player_name, mode_id, rating, comment, dialog)
        -- Rieseguire un lotto non deve duplicare: la chiave e' (created_at,
        -- rating_id) e il contenuto di una valutazione non cambia mai.
        ON CONFLICT (created_at, rating_id) DO NOTHING
      `.execute(tx);
    }

    await recomputeRatingDays(tx, [...days]);

    const bumped = await sql<{ last_id: string }>`
      UPDATE stats.duels_ingest_state
         SET last_id = ${lastId.toString()}::bigint, last_run_at = now(),
             degraded = degraded + ${degraded},
             since_day = LEAST(since_day, ${[...days].sort()[0] ?? null}::date)
       WHERE source = 'rating'
         -- Come per le partite. Qui l'inserimento e' idempotente e non
         -- raddoppierebbe, ma il contatore delle righe degradate e' additivo:
         -- due ingeritori insieme lo gonfierebbero, ed e' l'unico numero che
         -- dice se ci si puo' fidare del resto.
         AND last_id = ${from.toString()}::bigint
      RETURNING last_id::text
    `.execute(tx);
    if (bumped.rows.length !== 1) throw new WatermarkMoved('rating');
  });

  return { read: rows.length, lastId, degraded, discarded };
}

/**
 * Ricalcola l'aggregato giornaliero dei voti per i giorni toccati.
 *
 * SI RICALCOLA, non si somma. L'inserimento delle valutazioni e' idempotente
 * (`ON CONFLICT DO NOTHING`), quindi un lotto ripetuto non aggiunge righe: se
 * questo aggregato fosse additivo, invece, il ripasso le conterebbe due volte.
 * Ricalcolare un giorno costa una scansione su poche decine di righe.
 */
async function recomputeRatingDays(db: Database, days: string[]): Promise<void> {
  if (days.length === 0) return;
  await sql`
    INSERT INTO stats.duels_rating_day
      (day, mode_id, n, sum_rating, with_comment, r1, r2, r3, r4, r5)
    SELECT stats.civil_day(created_at) AS day,
           COALESCE(mode_id, -1)       AS mode_id,
           count(*)::int,
           sum(rating)::int,
           -- «Con commento» guarda SOLO la colonna comment: una valutazione
           -- con la sola conversazione e il commento vuoto non conta. E' il
           -- criterio del legacy, ed e' quello giusto: il seguito automatico
           -- non e' una cosa che il giocatore ha scelto di scrivere.
           count(*) FILTER (WHERE comment IS NOT NULL AND comment <> '')::int,
           count(*) FILTER (WHERE rating = 1)::int,
           count(*) FILTER (WHERE rating = 2)::int,
           count(*) FILTER (WHERE rating = 3)::int,
           count(*) FILTER (WHERE rating = 4)::int,
           count(*) FILTER (WHERE rating = 5)::int
      FROM stats.duels_rating
     WHERE stats.civil_day(created_at) = ANY(${days}::date[])
     GROUP BY 1, 2
    ON CONFLICT (day, mode_id) DO UPDATE SET
      n = EXCLUDED.n, sum_rating = EXCLUDED.sum_rating,
      with_comment = EXCLUDED.with_comment,
      r1 = EXCLUDED.r1, r2 = EXCLUDED.r2, r3 = EXCLUDED.r3,
      r4 = EXCLUDED.r4, r5 = EXCLUDED.r5
  `.execute(db);
}

/**
 * Un giro completo: cataloghi, poi partite e valutazioni finche' c'e' budget.
 *
 * `behind` dice che il budget e' finito prima dell'arretrato. E' il segnale
 * che il recupero e' in corso: si vede nel log e non e' un errore.
 *
 * `contended` dice che un altro ingeritore — il backfill, quasi sempre — sta
 * lavorando sulle stesse tabelle. Nemmeno questo e' un errore: il lotto
 * contestato e' tornato indietro intero e il giro dopo riparte da dove l'altro
 * e' arrivato. Se resta acceso a lungo senza che nessuno abbia lanciato niente,
 * allora si', c'e' un secondo pannello vivo che non dovrebbe esserci.
 */
export async function runDuelsIngest(
  db: Database,
  my: DuelsMysql,
  budgetMs = BUDGET_MS,
): Promise<IngestResult> {
  const started = Date.now();
  const catalogs = await syncCatalogs(db, my);

  let matches = 0;
  let ratings = 0;
  let degraded = 0;
  let behind = false;
  let contended = false;

  // Il conflitto ferma il giro, non lo fa fallire: il lotto contestato e' gia'
  // tornato indietro per intero, e il ciclo successivo ripartira' dal
  // watermark che l'altro ha lasciato. Riprovare subito significherebbe fare a
  // gara con lui.
  try {
    let matchAt = await watermarkOf(db, 'match');
    for (;;) {
      if (Date.now() - started > budgetMs) {
        behind = true;
        break;
      }
      const batch = await ingestMatchBatch(db, my, matchAt);
      matches += batch.read;
      matchAt = batch.lastId;
      if (batch.read < BATCH) break;
    }

    let ratingAt = await watermarkOf(db, 'rating');
    for (;;) {
      if (Date.now() - started > budgetMs) {
        behind = true;
        break;
      }
      const batch = await ingestRatingBatch(db, my, ratingAt);
      ratings += batch.read;
      degraded += batch.degraded;
      ratingAt = batch.lastId;
      if (batch.read < BATCH) break;
    }
  } catch (err) {
    if (!(err instanceof WatermarkMoved)) throw err;
    contended = true;
  }

  await sql`
    UPDATE stats.duels_ingest_state SET last_run_at = now() WHERE source = 'catalog'
  `.execute(db);

  return {
    matches,
    ratings,
    modes: catalogs.modes,
    maps: catalogs.maps,
    degraded,
    behind,
    contended,
    ms: Date.now() - started,
  };
}
