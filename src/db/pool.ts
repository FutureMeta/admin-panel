// Pool Postgres. §5.3, §16.2
//
// Il pool e' INIETTATO ovunque, mai importato come singleton globale: in
// fase 2 si aggiunge `statsPool` (max 8-10, statement_timeout 10s, ruolo di
// sola lettura) senza toccare una riga del codice di fase 1.

import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { DB } from './types.ts';

export type PoolOptions = {
  connectionString: string;
  max?: number;
  applicationName?: string;
  /** §5.3: 2s per il pool applicativo, 10s per quello statistiche in fase 2. */
  statementTimeout?: string;
  /**
   * Lo schema di default della connessione.
   *
   * I ruoli della fase 2 ce l'hanno gia' impostato con `ALTER ROLE ... SET`,
   * ma quello vale al login e questo hook lo sovrascriverebbe: un pool che
   * imposta `auth, public` su una connessione di `metamc_ingest` annulla in
   * silenzio la configurazione del ruolo. Meglio dirlo che ereditarlo per
   * caso.
   */
  searchPath?: string;
};

/**
 * I timeout si impostano nell'hook `connect` del pool, non con una query per
 * transazione: sono proprieta' della connessione, e pagarli a ogni richiesta
 * sarebbe un round trip regalato.
 */
export function createPool(opts: PoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 6,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: opts.applicationName ?? 'metamc-admin',
  });

  const statementTimeout = opts.statementTimeout ?? '2s';
  const searchPath = opts.searchPath ?? 'auth, public';
  pool.on('connect', (client) => {
    void client.query(
      // TIME ZONE FISSATO, e non e' ridondanza. §7.8
      //
      // Tutte le query che dipendono dal fuso lo scrivono esplicitamente
      // (`AT TIME ZONE 'Europe/Rome'`, `date_trunc(..., 'Europe/Rome')`), ma un
      // `::date` o un `extract` dimenticato seguirebbe il DEFAULT DEL SERVER —
      // che su questa macchina di sviluppo e' Europe/Rome e in un container
      // e' quasi sempre UTC. Un difetto del genere non si vede qui e compare
      // in produzione, spostato di un'ora, due volte l'anno.
      `SET search_path = ${searchPath};
       SET TIME ZONE 'Europe/Rome';
       SET statement_timeout = '${statementTimeout}';
       SET idle_in_transaction_session_timeout = '10s';
       SET lock_timeout = '2s';`,
    );
  });

  // Un errore su una connessione idle non deve abbattere il processo: pg lo
  // emette sul pool e senza listener diventa un unhandled error.
  pool.on('error', (err) => {
    console.error('[pg] errore su connessione idle:', err.message);
  });

  return pool;
}

export function createKysely(pool: pg.Pool): Kysely<DB> {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}

export type Database = Kysely<DB>;
