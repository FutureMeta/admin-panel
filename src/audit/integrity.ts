// §10 — verifica di integrita' e ancoraggio esterno.
//
// La verifica gira in Postgres (audit.verify_chain), non qui: reimplementare
// la canonicalizzazione in TypeScript creerebbe una seconda fonte di verita',
// e la prima divergenza fra le due sarebbe un falso positivo o — peggio — un
// falso negativo.

import { createHmac } from 'node:crypto';
import { sql } from 'kysely';
import type { Database } from '#src/db/pool.ts';

export type PartitionVerdict = {
  partitionKey: string;
  ok: boolean;
  rowsChecked: number;
  badId: string | null;
  detail: string | null;
};

/** 'YYYYMM' per una data, in UTC come il trigger. */
export function partitionKeyOf(date: Date): string {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Le chiavi della partizione corrente e delle N precedenti. */
export function recentPartitionKeys(now: Date, previous = 2): string[] {
  const keys: string[] = [];
  for (let i = 0; i <= previous; i += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    keys.push(partitionKeyOf(d));
  }
  return keys;
}

export async function verifyPartition(db: Database, partitionKey: string): Promise<PartitionVerdict> {
  const res = await sql<{
    ok: boolean;
    rows_checked: string;
    bad_id: string | null;
    detail: string | null;
  }>`SELECT * FROM audit.verify_chain(${partitionKey})`.execute(db);

  const row = res.rows[0];
  if (!row) {
    return { partitionKey, ok: false, rowsChecked: 0, badId: null, detail: 'verify_chain non ha risposto' };
  }
  return {
    partitionKey,
    ok: row.ok,
    rowsChecked: Number(row.rows_checked),
    badId: row.bad_id,
    detail: row.detail,
  };
}

/**
 * §10 — endpoint GET /internal/audit-integrity: ricalcola la catena della
 * partizione corrente e delle due precedenti e restituisce 500 se non torna.
 */
export async function verifyRecent(db: Database, now = new Date()): Promise<PartitionVerdict[]> {
  const keys = recentPartitionKeys(now, 2);
  return Promise.all(keys.map((k) => verifyPartition(db, k)));
}

export type Anchor = {
  partitionKey: string;
  headHash: string;
  rowCount: number;
  anchoredAt: string;
  signature: string;
};

/**
 * §10 — ancoraggio esterno.
 *
 * Un job giornaliero scrive l'hash di testa di ogni partizione in uno storage
 * append-only FUORI dal database. L'email agli owner e' una notifica
 * aggiuntiva, non il meccanismo: un controllo che dipende dall'attenzione
 * umana non e' un controllo.
 *
 * Qui si produce il documento firmato; dove depositarlo (bucket con
 * object-lock, repository git separato) e' una scelta di infrastruttura e sta
 * nel runbook, non nel codice applicativo.
 */
export async function buildAnchors(db: Database, key: Buffer, now = new Date()): Promise<Anchor[]> {
  const rows = await db
    .selectFrom('audit.chain_head')
    .select(['partition_key', 'head_hash', 'row_count'])
    .orderBy('partition_key')
    .execute();

  const anchoredAt = now.toISOString();
  return rows.map((r) => {
    const headHash = Buffer.from(r.head_hash).toString('hex');
    const payload = `${r.partition_key}|${headHash}|${r.row_count}|${anchoredAt}`;
    return {
      partitionKey: r.partition_key,
      headHash,
      rowCount: Number(r.row_count),
      anchoredAt,
      signature: createHmac('sha256', key).update(payload).digest('hex'),
    };
  });
}

export async function markAnchored(
  db: Database,
  partitionKeys: readonly string[],
  now = new Date(),
): Promise<void> {
  if (partitionKeys.length === 0) return;
  await db
    .updateTable('audit.chain_head')
    .set({ anchored_at: now })
    .where('partition_key', 'in', [...partitionKeys])
    .execute();
}
