// La connessione al MySQL del gioco.
//
// E' L'UNICO PUNTO DEL PANNELLO CHE PARLA CON IL DATABASE DEL GIOCO, ed e'
// voluto: le schermate delle statistiche leggono `stats.duels_*` su Postgres e
// non sanno che questo file esista. Se un giorno il MySQL diventasse
// irraggiungibile, il pannello continuerebbe a disegnare lo storico gia'
// ingerito e a dire da quando e' fermo — invece di svuotarsi.
//
// POOL SEPARATO da quello del pannello, e non e' simmetria estetica. Il pool
// del pannello regge i login: una query lenta verso un database altrui che ne
// occupasse una connessione si vedrebbe come un login che non arriva.
//
// NON E' PIU' SOLA LETTURA, e questa riga e' cambiata insieme al codice. Fino
// alle schermate Modes e Maps qui non c'era una sola INSERT e il commento lo
// diceva; adesso c'e' `tx`, e un commento che continuasse a promettere sola
// lettura sarebbe la cosa peggiore di tutte — qualcuno lo leggerebbe per
// decidere quali privilegi concedere.
//
// Le due cose che ne conseguono:
//
//   * il pool serve DUE padroni: il job ETL, che gira ogni trenta secondi in
//     lotti sequenziali, e le rotte di configurazione, che rispondono a una
//     persona che sta guardando lo schermo. Due connessioni bastavano al
//     primo da solo; ora sono quattro, perche' un salvataggio non deve mettersi
//     in coda dietro un lotto da diecimila righe;
//   * le scritture stanno TUTTE dentro `tx`. Cambiare una modalita' vuol dire
//     toccare piu' tabelle, e a meta' strada il database del gioco resterebbe
//     in uno stato che nessuno ha mai chiesto.

import mysql from 'mysql2/promise';

/** Le sole tabelle che questo file nomina. Serve a chi concede i privilegi. */
export const SOURCE_TABLES = [
  'duels_match_statistics',
  'duels_match_ratings',
  'duels_mode',
  'duels_map',
  'duels_userdata',
] as const;

/**
 * Quanto puo' durare una lettura prima di essere interrotta DAL SERVER.
 *
 * Un tetto lato server vale anche se il pannello muore nel frattempo, mentre
 * un timeout lato client lascerebbe la query a girare sul database del gioco.
 * E' la differenza fra rinunciare a un risultato e smettere di pesare su una
 * macchina che non e' nostra.
 */
const MAX_EXECUTION_MS = 10_000;

/** SQLSTATE HY000 / errno 1193: la variabile di sessione non esiste. */
const ER_UNKNOWN_SYSTEM_VARIABLE = 1193;

/**
 * Quale variabile impone il tetto, su QUESTO server.
 *
 * - `mysql`: `max_execution_time`, in MILLISECONDI, da MySQL 5.7.8.
 * - `mariadb`: `max_statement_time`, in SECONDI (un double), su MariaDB.
 * - `none`: nessuna delle due. Il tetto lato server non c'e'.
 */
export type CapKind = 'unknown' | 'mysql' | 'mariadb' | 'none';

function isUnknownVariable(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { errno?: number }).errno === ER_UNKNOWN_SYSTEM_VARIABLE
  );
}

/**
 * Il tetto di esecuzione, che ha due nomi diversi su due database diversi.
 *
 * COSTATO UN GUASTO IN PRODUZIONE, il 22 agosto 2026: il database del gioco e'
 * MariaDB, `max_execution_time` non esiste, ed errno 1193 arrivava PRIMA di
 * ogni singola query — quindi l'ingestione non ne ha eseguita nemmeno una. Il
 * log lo diceva («MySQL del gioco NON raggiungibile»), ma la causa era il
 * tetto, non la raggiungibilita'.
 *
 * SI PROVA, NON SI SUPPONE. Chiedere la versione e dedurne il dialetto
 * significherebbe fidarsi di una stringa: qui si prova la prima forma, e se il
 * server risponde «non conosco questa variabile» si prova la seconda. L'esito
 * si ricorda, quindi il costo e' due query in croce all'avvio.
 *
 * E SE NON CE N'E' NESSUNA il giro continua, ma SENZA tetto lato server: e'
 * un degrado da dire forte, perche' significa che una query fuori controllo su
 * una macchina che non e' nostra non ha piu' niente che la fermi.
 */
export function createExecutionCap(ms: number) {
  let kind: CapKind = 'unknown';

  const apply = async (query: (sql: string) => Promise<unknown>): Promise<CapKind> => {
    if (kind === 'none') return kind;

    if (kind === 'unknown') {
      try {
        await query(`SET SESSION max_execution_time = ${Number(ms)}`);
        kind = 'mysql';
        return kind;
      } catch (err) {
        if (!isUnknownVariable(err)) throw err;
      }
      try {
        // MariaDB conta in SECONDI, e accetta i decimali: dieci secondi qui
        // sono `10`, non `10000`. Passare i millisecondi vorrebbe dire un
        // tetto di due ore e quaranta, cioe' nessun tetto.
        await query(`SET SESSION max_statement_time = ${Number(ms) / 1_000}`);
        kind = 'mariadb';
        return kind;
      } catch (err) {
        if (!isUnknownVariable(err)) throw err;
      }
      kind = 'none';
      return kind;
    }

    if (kind === 'mysql') await query(`SET SESSION max_execution_time = ${Number(ms)}`);
    else await query(`SET SESSION max_statement_time = ${Number(ms) / 1_000}`);
    return kind;
  };

  return { apply, kind: () => kind };
}

/**
 * Il tetto del BACKFILL, che e' un'altra cosa.
 *
 * Il giro da trenta secondi legge per chiave primaria e non supera mai il
 * decimo di secondo: dieci secondi la' dentro significano «qualcosa non sta
 * finendo». La verifica finale del backfill invece conta due milioni e mezzo
 * di righe apposta, una volta sola, a mano — e interromperla a dieci secondi
 * vorrebbe dire non poterla fare, cioe' dichiarare finita un'importazione
 * senza averla confrontata con la sorgente.
 */
export const BACKFILL_MAX_EXECUTION_MS = 120_000;

/**
 * Le operazioni disponibili DENTRO una transazione.
 *
 * Vivono su una connessione sola, ed e' il punto: `BEGIN` vale per la
 * connessione, non per il pool. Prendendo query dal pool dentro una
 * transazione si finirebbe a scrivere meta' delle righe fuori da essa — che e'
 * il difetto piu' silenzioso di tutti, perche' funziona sempre finche' il pool
 * ha una connessione libera e sbaglia solo sotto carico.
 */
export type DuelsTx = {
  rows: <T>(sql: string, params?: unknown[]) => Promise<T[]>;
  /** Una scrittura. Restituisce quante righe ha toccato davvero. */
  run: (sql: string, params?: unknown[]) => Promise<{ affectedRows: number }>;
};

export type DuelsMysql = {
  /** Una SELECT, con il tetto di esecuzione gia' applicato. */
  rows: <T>(sql: string, params?: unknown[]) => Promise<T[]>;
  /**
   * Un gruppo di scritture, tutte o nessuna.
   *
   * Se `fn` lancia si fa `ROLLBACK` e l'eccezione prosegue: chi ha chiamato
   * deve sapere che non e' stato fatto niente, e un errore mangiato qui
   * diventerebbe un salvataggio che dice di essere riuscito.
   */
  tx: <T>(fn: (t: DuelsTx) => Promise<T>) => Promise<T>;
  /** Quale tetto e' in vigore. `none` e' un degrado da dire. */
  cap: () => CapKind;
  close: () => Promise<void>;
};

export function createDuelsMysql(url: string, maxExecutionMs = MAX_EXECUTION_MS): DuelsMysql {
  const pool = mysql.createPool({
    uri: url,
    // Quattro. Erano due, quando l'unico cliente era il job e il giro era
    // sequenziale; adesso ci sono anche le rotte di configurazione, e un
    // salvataggio che aspetta la fine di un lotto e' un pulsante che sembra
    // rotto.
    connectionLimit: 4,
    // Non accodare all'infinito: se il pool e' pieno vuol dire che qualcosa
    // non sta finendo, e la coda nasconderebbe il problema allungandolo.
    waitForConnections: true,
    queueLimit: 4,
    connectTimeout: 5_000,
    // I DECIMAL e i BIGINT arrivano come stringhe invece che come `number`.
    // `id` e' BIGINT su `duels_match_ratings`: oltre 2^53 un `number` perde
    // cifre in silenzio, e il watermark comincerebbe a saltare righe.
    decimalNumbers: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    // Le date arrivano come stringhe e le converte chi legge: `mysql2`
    // altrimenti costruisce un `Date` nel fuso del PROCESSO, che e' la stessa
    // classe di difetto per cui il pannello ha `stats.civil_day`.
    dateStrings: true,
    timezone: 'Z',
  });

  const cap = createExecutionCap(maxExecutionMs);

  return {
    rows: async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      const conn = await pool.getConnection();
      try {
        await cap.apply((statement) => conn.query(statement));
        const [result] = await conn.query(sql, params);
        return result as T[];
      } finally {
        conn.release();
      }
    },
    tx: async <T>(fn: (t: DuelsTx) => Promise<T>): Promise<T> => {
      const conn = await pool.getConnection();
      try {
        await cap.apply((statement) => conn.query(statement));
        await conn.beginTransaction();
        try {
          const out = await fn({
            rows: async <R>(sql: string, params: unknown[] = []): Promise<R[]> => {
              const [result] = await conn.query(sql, params);
              return result as R[];
            },
            run: async (sql: string, params: unknown[] = []) => {
              const [result] = await conn.query(sql, params);
              // `affectedRows` e' l'unica risposta alla domanda «la riga
              // c'era?». Un UPDATE che non trova niente riesce senza toccare
              // niente, e senza guardarlo si direbbe «salvato» a chi ha appena
              // modificato una modalita' che qualcun altro ha eliminato.
              return { affectedRows: (result as { affectedRows?: number }).affectedRows ?? 0 };
            },
          });
          await conn.commit();
          return out;
        } catch (err) {
          // Il rollback non deve poter nascondere l'errore vero: se anche lui
          // fallisce — connessione caduta a meta' — quello che si rilancia
          // resta il primo, che e' quello che dice cosa e' successo.
          await conn.rollback().catch(() => undefined);
          throw err;
        }
      } finally {
        conn.release();
      }
    },
    cap: cap.kind,
    close: () => pool.end(),
  };
}

/**
 * Uno uuid con i trattini da un `BINARY(16)` letto come esadecimale.
 *
 * `HEX(match_id)` restituisce 32 caratteri senza separatori; Postgres accetta
 * anche quella forma, ma tenerla normalizzata qui significa che nel database
 * c'e' una rappresentazione sola e che un confronto fatto a mano funziona.
 *
 * Torna `null` invece di lanciare: una riga con un identificativo malformato
 * non deve far cadere un lotto da diecimila.
 */
export function uuidFromHex(hex: string | null | undefined): string | null {
  if (typeof hex !== 'string' || hex.length !== 32 || !/^[0-9a-fA-F]{32}$/.test(hex)) return null;
  const s = hex.toLowerCase();
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** Uno uuid gia' in forma testuale, validato. `null` se non lo e'. */
export function uuidOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s) ? s : null;
}

/** Un turno della conversazione post-valutazione. */
/**
 * Un turno come lo scrive il gioco. Sul filo diventa `{speaker, text}`: vedi
 * `DialogTurn` in `contract.ts`.
 */
export type DialogTurn = { role: string; content: string };

/**
 * Il `dialog`, parsato in modo DIFENSIVO.
 *
 * All'origine e' `text` senza vincoli: il contratto accertato e' un array di
 * `{role, content}` con `role` in `bot` | `player`, senza timestamp e senza
 * id — conta solo l'ordine. Ma «accertato» descrive cio' che c'e' oggi, non
 * cio' che il plugin scrivera' domani.
 *
 * Quindi: quello che non corrisponde torna `null` e viene CONTATO, e la riga
 * si scrive lo stesso. Perdere una valutazione per un seguito malformato
 * sarebbe sproporzionato — e farla sparire in silenzio, come fa il legacy con
 * il suo try/catch nel browser, e' peggio ancora.
 */
export function parseDialog(raw: unknown): { turns: DialogTurn[] | null; degraded: boolean } {
  if (raw === null || raw === undefined || raw === '') return { turns: null, degraded: false };
  if (typeof raw !== 'string') return { turns: null, degraded: true };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { turns: null, degraded: true };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return { turns: null, degraded: true };

  const turns: DialogTurn[] = [];
  for (const turn of parsed) {
    if (typeof turn !== 'object' || turn === null) return { turns: null, degraded: true };
    const { role, content } = turn as { role?: unknown; content?: unknown };
    if (typeof role !== 'string' || typeof content !== 'string') {
      return { turns: null, degraded: true };
    }
    // Un ruolo inatteso NON scarta il dialogo: si trasporta com'e'. Se domani
    // il plugin ne aggiunge uno, la conversazione resta leggibile invece di
    // sparire, e l'interfaccia lo mostrera' come un turno qualunque.
    turns.push({ role, content });
  }
  return { turns, degraded: false };
}

/**
 * Le colonne che l'ETL nomina, tabella per tabella.
 *
 * NON E' `hasColumn` A RUNTIME — quello e' fra le cose da non replicare (§6.7):
 * il legacy interrogava INFORMATION_SCHEMA sul percorso caldo, teneva l'esito
 * in una Map senza scadenza e CAMBIAVA COMPORTAMENTO in base alla risposta,
 * quindi dopo una migrazione del gioco continuava con la forma vecchia fino al
 * riavvio.
 *
 * Qui si fa il contrario: una lettura sola all'avvio, che non cambia niente e
 * si limita a DIRE cosa manca. Serve perche' l'alternativa e' scoprire le
 * colonne una per volta, un deploy per volta — che e' esattamente come sono
 * usciti `max_execution_time` e `duels_mode.color`.
 */
export const SOURCE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  duels_match_statistics: ['id', 'created_at', 'type', 'context', 'mode_id', 'map_id'],
  duels_match_ratings: [
    'id',
    'created_at',
    'match_id',
    'player_id',
    'mode_id',
    'rating',
    'comment',
    'dialog',
  ],
  duels_mode: ['id', 'name', 'display_name', 'ranking', 'type'],
  duels_map: ['id', 'name', 'display_name', 'type'],
  duels_userdata: ['id', 'uuid', 'username'],
};

/**
 * Cio' che manca alla sorgente, in una lista sola.
 *
 * Una tabella assente si segnala per intero invece di elencarne le sei
 * colonne: «duels_map: tabella assente» si legge, sei righe identiche no.
 */
export async function missingSourceColumns(my: DuelsMysql): Promise<string[]> {
  const names = Object.keys(SOURCE_COLUMNS);
  const rows = await my.rows<{ t: string; c: string }>(
    `SELECT table_name AS t, column_name AS c
       FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name IN (${names.map(() => '?').join(', ')})`,
    names,
  );

  const found = new Map<string, Set<string>>();
  for (const row of rows) {
    const table = String(row.t).toLowerCase();
    const set = found.get(table) ?? new Set<string>();
    set.add(String(row.c).toLowerCase());
    found.set(table, set);
  }

  const missing: string[] = [];
  for (const [table, columns] of Object.entries(SOURCE_COLUMNS)) {
    const present = found.get(table);
    if (!present || present.size === 0) {
      missing.push(`${table}: tabella assente`);
      continue;
    }
    for (const column of columns) {
      if (!present.has(column)) missing.push(`${table}.${column}`);
    }
  }
  return missing;
}
