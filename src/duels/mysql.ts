// La connessione al MySQL del gioco. Solo il job la usa.
//
// E' L'UNICO PUNTO DEL PANNELLO CHE PARLA CON IL DATABASE DEL GIOCO, ed e'
// voluto: le schermate leggono `stats.duels_*` su Postgres e non sanno che
// questo file esista. Se un giorno il MySQL diventasse irraggiungibile, il
// pannello continuerebbe a disegnare lo storico gia' ingerito e a dire da
// quando e' fermo — invece di svuotarsi.
//
// POOL SEPARATO, e non e' simmetria estetica. Il pool del pannello regge i
// login: una query lenta verso un database altrui che ne occupasse una
// connessione si vedrebbe come un login che non arriva. Due connessioni
// bastano — il giro e' sequenziale — e sono due connessioni tolte a nessuno.
//
// SOLA LETTURA PER CONVENZIONE E PER RUOLO. Qui non c'e' una sola INSERT, e
// l'utente MySQL dovrebbe avere il SELECT sulle sole tabelle che servono. Il
// codice non puo' imporlo: puo' solo non scrivere mai, che e' quello che fa.

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
 * `max_execution_time` e' un tetto lato MySQL sulle SELECT: vale anche se il
 * pannello muore nel frattempo, mentre un timeout lato client lascerebbe la
 * query a girare sul database del gioco. E' la differenza fra rinunciare a un
 * risultato e smettere di pesare su una macchina che non e' nostra.
 */
const MAX_EXECUTION_MS = 10_000;

export type DuelsMysql = {
  /** Una SELECT, con il tetto di esecuzione gia' applicato. */
  rows: <T>(sql: string, params?: unknown[]) => Promise<T[]>;
  close: () => Promise<void>;
};

export function createDuelsMysql(url: string): DuelsMysql {
  const pool = mysql.createPool({
    uri: url,
    // Due: una che lavora e una di riserva. Il giro e' sequenziale.
    connectionLimit: 2,
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

  return {
    rows: async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      const conn = await pool.getConnection();
      try {
        await conn.query(`SET SESSION max_execution_time = ${MAX_EXECUTION_MS}`);
        const [result] = await conn.query(sql, params);
        return result as T[];
      } finally {
        conn.release();
      }
    },
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
