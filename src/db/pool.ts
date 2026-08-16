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
  pool.on('connect', (client) => {
    void client.query(
      `SET search_path = auth, public;
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
