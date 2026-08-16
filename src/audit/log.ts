// §10, SEC-48 — scrittura dell'audit log.
//
// La regola non negoziabile e' che per gli eventi di sicurezza l'INSERT sia
// l'ULTIMA istruzione prima del COMMIT, nella stessa transazione della
// modifica di stato, e che quella transazione non contenga I/O di rete
// esterno. Se il lock della catena si serializzasse sulla latenza di Resend o
// di HIBP, ogni azione di ogni admin si accoderebbe dietro un'email.
//
// Qui la regola non e' affidata alla disciplina: `securityTransaction()` apre
// la transazione, esegue il lavoro, e scrive l'audit DOPO — per costruzione.
// Un chiamante non ha modo di invertire l'ordine se non uscendo dall'helper.

import type { Transaction } from 'kysely';
import type { Database } from '#src/db/pool.ts';
import type { DB } from '#src/db/types.ts';
import type { AuditAction } from './actions.ts';
import { LIMITS, sanitizeIp, sanitizeJson, sanitizeText } from './sanitize.ts';

export type AuditActor = {
  userId: string | null;
  email: string | null;
  displayName: string | null;
  sessionId: string | null;
};

/** Contesto di richiesta: sopravvive intatto a tutte le voci di audit di quella richiesta. */
export type AuditRequestContext = {
  requestId: string | null;
  /** SEC-23 — derivato da X-Forwarded-For. Falsificabile se il proxy sbaglia. */
  ip: string | null;
  /** SEC-23 — socket.remoteAddress. NON falsificabile. */
  socketIp: string | null;
  userAgent: string | null;
};

export type AuditEvent = {
  action: AuditAction;
  outcome: 'success' | 'failure' | 'denied';
  actor: AuditActor;
  request: AuditRequestContext;
  moduleKey?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  /** DENORMALIZZATO: com'era il bersaglio AL MOMENTO DEL FATTO. */
  targetLabel?: string | null;
  before?: unknown;
  after?: unknown;
  meta?: unknown;
};

type Executor = Database | Transaction<DB>;

function toRow(event: AuditEvent): Record<string, unknown> {
  const ip = sanitizeIp(event.request.ip);
  const socketIp = sanitizeIp(event.request.socketIp);
  return {
    request_id: event.request.requestId,
    actor_user_id: sanitizeText(event.actor.userId, 64),
    // Denormalizzazione obbligatoria (§10): un registro deve riportare
    // l'identita' al momento del fatto, e questo elimina anche l'N+1 sulla
    // query piu' frequente del pannello.
    actor_email: sanitizeText(event.actor.email, LIMITS.email),
    actor_display_name: sanitizeText(event.actor.displayName, LIMITS.displayName),
    actor_ip: ip,
    actor_socket_ip: socketIp,
    actor_user_agent: sanitizeText(event.request.userAgent, LIMITS.userAgent),
    session_id: sanitizeText(event.actor.sessionId, 128),
    action: event.action,
    module_key: sanitizeText(event.moduleKey, LIMITS.moduleKey),
    target_type: sanitizeText(event.targetType, LIMITS.targetType),
    target_id: sanitizeText(event.targetId, LIMITS.targetId),
    target_label: sanitizeText(event.targetLabel, LIMITS.targetLabel),
    outcome: event.outcome,
    before: event.before === undefined ? null : JSON.stringify(sanitizeJson(event.before)),
    after: event.after === undefined ? null : JSON.stringify(sanitizeJson(event.after)),
    meta: buildMeta(event, ip, socketIp),
  };
}

/**
 * SEC-23 — se i due IP divergono si annota nel meta. La divergenza e' un
 * segnale: o il proxy non sta sovrascrivendo X-Forwarded-For come deve
 * (regola nginx del §2), o qualcuno sta provando a falsificare l'origine.
 */
function buildMeta(event: AuditEvent, ip: string | null, socketIp: string | null): string | null {
  const base = event.meta === undefined ? undefined : (sanitizeJson(event.meta) as Record<string, unknown>);
  const divergent = ip !== null && socketIp !== null && ip !== socketIp;
  if (!divergent && base === undefined) return null;
  const merged: Record<string, unknown> = { ...(base ?? {}) };
  if (divergent) merged.ip_mismatch = true;
  return JSON.stringify(merged);
}

/**
 * Scrive una voce. `prev_hash` e `hash` NON si passano: li calcola il trigger,
 * ed e' l'unico modo perche' la catena resti vera anche per chi scrivesse
 * un INSERT a mano.
 */
export async function writeAudit(exec: Executor, event: AuditEvent): Promise<void> {
  await exec
    .insertInto('audit.audit_log')
    // Il cast e' inevitabile: le colonne calcolate dal trigger sono `never`
    // in scrittura per costruzione (src/db/types.ts), e va bene cosi'.
    .values(toRow(event) as never)
    .execute();
}

export async function writeAuditMany(exec: Executor, events: readonly AuditEvent[]): Promise<void> {
  if (events.length === 0) return;
  await exec
    .insertInto('audit.audit_log')
    .values(events.map(toRow) as never)
    .execute();
}

/**
 * SEC-48 — transazione per eventi di sicurezza.
 *
 * `work` esegue la modifica di stato e restituisce l'evento (o gli eventi) da
 * registrare. L'INSERT avviene DOPO, dentro la stessa transazione, come
 * ultima istruzione prima del COMMIT.
 *
 * `work` NON deve contenere chiamate di rete esterne. Le operazioni che ne
 * hanno bisogno (HIBP, Resend) vanno prima o dopo, e il loro esito entra nel
 * `meta` dell'evento.
 */
export async function securityTransaction<T>(
  db: Database,
  work: (trx: Transaction<DB>) => Promise<{ result: T; events: AuditEvent | AuditEvent[] }>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    const { result, events } = await work(trx);
    await writeAuditMany(trx, Array.isArray(events) ? events : [events]);
    return result;
  });
}
