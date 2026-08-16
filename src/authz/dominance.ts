// §7 — dominanza attore→bersaglio e concedibilita' di un ruolo.
//
// Sono le due query che impediscono l'escalation di privilegio, e stanno qui
// dentro perche' sono decisioni di autorizzazione: `can()` da solo non basta.
//
// SEC-07 — nessuno concede cio' che non ha.
// SEC-08 — nessuna operazione su un altro utente senza dominanza. Un admin
//          non puo' declassare ne' bannare un owner.
//
// Entrambe girano SERVER-SIDE, sulla vista effective_permissions, e non sui
// permessi che l'attore porta in sessione: quelli sono una copia, e una copia
// e' sempre di un istante fa.

import { sql } from 'kysely';
import type { Database } from '#src/db/pool.ts';

/**
 * `true` se l'attore domina il bersaglio su OGNI modulo.
 *
 * L'attore domina se non esiste un modulo su cui il bersaglio ha piu' di lui.
 * Un attore che non ha alcuna riga nella vista (utente inesistente) non domina
 * nessuno con permessi, perche' il LEFT JOIN produce NULL e il confronto
 * `t.level > a.level` con COALESCE a 0 e' vero per ogni livello positivo.
 */
export async function dominates(db: Database, actorId: string, targetId: string): Promise<boolean> {
  const res = await sql<{ ok: boolean }>`
    SELECT NOT EXISTS (
      SELECT 1
      FROM auth.effective_permissions t
      LEFT JOIN auth.effective_permissions a
        ON a.module_id = t.module_id AND a.user_id = ${actorId}
      WHERE t.user_id = ${targetId} AND t.level > COALESCE(a.level, 0)
    ) AS ok
  `.execute(db);
  return res.rows[0]?.ok === true;
}

/**
 * `true` se l'attore puo' concedere quel ruolo: il ruolo non deve dare, su
 * alcun modulo, un livello superiore a quello effettivo dell'attore.
 *
 * Usata dall'invito (§8.1) e dall'assegnazione di ruolo (§8, RBAC).
 */
export async function canGrantRole(db: Database, actorId: string, roleId: number): Promise<boolean> {
  const res = await sql<{ ok: boolean }>`
    SELECT NOT EXISTS (
      SELECT 1 FROM auth.role_permissions rp
      LEFT JOIN auth.effective_permissions a
        ON a.module_id = rp.module_id AND a.user_id = ${actorId}
      WHERE rp.role_id = ${roleId} AND rp.level > COALESCE(a.level, 0)
    ) AS ok
  `.execute(db);
  return res.rows[0]?.ok === true;
}

/**
 * `true` se l'attore puo' concedere quel livello su quel modulo come override
 * individuale. Stessa regola, applicata a una singola casella della matrice.
 */
export async function canGrantLevel(
  db: Database,
  actorId: string,
  moduleId: number,
  level: number,
): Promise<boolean> {
  const res = await sql<{ ok: boolean }>`
    SELECT COALESCE(
      (SELECT a.level FROM auth.effective_permissions a
        WHERE a.user_id = ${actorId} AND a.module_id = ${moduleId}), 0) >= ${level} AS ok
  `.execute(db);
  return res.rows[0]?.ok === true;
}

/** I ruoli che l'attore puo' effettivamente concedere. Alimenta la UI dell'invito. */
export async function grantableRoles(
  db: Database,
  actorId: string,
): Promise<Array<{ id: number; key: string; name: string }>> {
  const res = await sql<{ id: number; key: string; name: string }>`
    SELECT r.id, r.key, r.name
    FROM auth.roles r
    -- SEC-09: un ruolo di sistema non e' assegnabile ne' via invito ne' via UI.
    WHERE r.is_system = false
      AND NOT EXISTS (
        SELECT 1 FROM auth.role_permissions rp
        LEFT JOIN auth.effective_permissions a
          ON a.module_id = rp.module_id AND a.user_id = ${actorId}
        WHERE rp.role_id = r.id AND rp.level > COALESCE(a.level, 0)
      )
    ORDER BY r.sort_order, r.key
  `.execute(db);
  return res.rows;
}

/** Il ruolo esiste ed e' di sistema? SEC-09, rivalidato nell'handler (SEC-38). */
export async function isSystemRole(db: Database, roleId: number): Promise<boolean> {
  const row = await db
    .selectFrom('auth.roles')
    .select('is_system')
    .where('id', '=', roleId)
    .executeTakeFirst();
  return row?.is_system === true;
}
