// Registro attivita'. §6.7, SEC-37
//
// Paginazione KEYSET, non OFFSET: `WHERE (occurred_at, id) < ($1, $2)` usa la
// chiave primaria e costa lo stesso alla pagina 1 e alla pagina 900. Con
// OFFSET, la pagina 900 costerebbe la scansione delle 45.000 righe che la
// precedono, ed e' esattamente il problema che il pannello legacy ha.
//
// SEC-37 — nessun input utente entra mai in un identificatore. I campi
// filtrabili sono una ALLOWLIST enumerata server-side; il client manda una
// chiave di quella lista, non un nome di colonna.

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '#src/app-context.ts';
import { verifyPartition } from '#src/audit/integrity.ts';
import { require as requireLevel } from '#src/authz/can.ts';
import { BadRequest } from '../errors.ts';
import { requireAuth } from '../guards.ts';
import { actorOf } from '../request-context.ts';

/**
 * SEC-37 — allowlist dei filtri. Il client puo' nominare SOLO queste chiavi,
 * e ognuna e' mappata a una colonna scritta qui dentro, mai composta.
 */
const FILTERABLE = {
  actor: 'actor_user_id',
  module: 'module_key',
  action: 'action',
  outcome: 'outcome',
  targetType: 'target_type',
  target: 'target_id',
} as const;

type FilterKey = keyof typeof FILTERABLE;

const listSchema = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      // Cursore keyset: entrambi o nessuno.
      beforeOccurredAt: { type: 'string', format: 'date-time' },
      beforeId: { type: 'string', maxLength: 32 },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
      actor: { type: 'string', maxLength: 64 },
      module: { type: 'string', maxLength: 32 },
      action: { type: 'string', maxLength: 96 },
      outcome: { type: 'string', enum: ['success', 'failure', 'denied'] },
      targetType: { type: 'string', maxLength: 48 },
      target: { type: 'string', maxLength: 128 },
      from: { type: 'string', format: 'date-time' },
      to: { type: 'string', format: 'date-time' },
    },
  },
} as const;

export async function registerAuditRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/audit', { schema: listSchema, preHandler: [requireAuth(ctx)] }, async (request, reply) => {
    requireLevel(actorOf(request), 'audit', 1);
    const q = request.query as Record<string, string | number | undefined>;
    const limit = typeof q.limit === 'number' ? q.limit : 50;

    let query = ctx.db
      .selectFrom('audit.audit_log')
      .select([
        'id',
        'occurred_at',
        'actor_user_id',
        'actor_email',
        'actor_display_name',
        'actor_ip',
        'actor_socket_ip',
        'actor_user_agent',
        'action',
        'module_key',
        'target_type',
        'target_id',
        'target_label',
        'outcome',
        'before',
        'after',
        'meta',
      ])
      .orderBy('occurred_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1);

    // Cursore keyset. La tupla si confronta come tupla: `(occurred_at, id) <
    // ($1, $2)`. Confrontare solo occurred_at perderebbe righe con lo stesso
    // timestamp al microsecondo, che con un audit ad alta frequenza capita.
    if (typeof q.beforeOccurredAt === 'string' && typeof q.beforeId === 'string') {
      const at = new Date(q.beforeOccurredAt);
      if (Number.isNaN(at.getTime())) throw new BadRequest('CURSORE_NON_VALIDO');
      query = query.where((eb) =>
        eb.or([
          eb('occurred_at', '<', at),
          eb.and([eb('occurred_at', '=', at), eb('id', '<', q.beforeId as string)]),
        ]),
      );
    }

    for (const key of Object.keys(FILTERABLE) as FilterKey[]) {
      const value = q[key];
      if (typeof value === 'string' && value.length > 0) {
        // La colonna viene from FILTERABLE, cioe' from una costante di questo
        // file. Il valore e' un parametro. Nessuna concatenazione.
        query = query.where(FILTERABLE[key], '=', value);
      }
    }

    if (typeof q.from === 'string') query = query.where('occurred_at', '>=', new Date(q.from));
    if (typeof q.to === 'string') query = query.where('occurred_at', '<=', new Date(q.to));

    const rows = await query.execute();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);

    return reply.send({
      entries: page.map((r) => ({
        id: String(r.id),
        occurredAt: r.occurred_at,
        actor: {
          userId: r.actor_user_id,
          // DENORMALIZZATI: com'era l'identita' AL MOMENTO DEL FATTO. Se
          // l'utente e' stato cancellato o ha cambiato email, il registro
          // riporta comunque chi era allora.
          email: r.actor_email,
          name: r.actor_display_name,
          ip: r.actor_ip,
          socketIp: r.actor_socket_ip,
          userAgent: r.actor_user_agent,
        },
        action: r.action,
        moduleKey: r.module_key,
        target: { type: r.target_type, id: r.target_id, label: r.target_label },
        outcome: r.outcome,
        before: r.before,
        after: r.after,
        meta: r.meta,
      })),
      nextCursor:
        hasMore && last
          ? { beforeOccurredAt: (last.occurred_at as Date).toISOString(), beforeId: String(last.id) }
          : null,
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/audit/actions — vocabolario per i filtri della UI.
  //
  // Serve dal catalogo in codice, non from un DISTINCT sulla tabella piu' grande
  // del sistema: un DISTINCT su audit_log e' una scansione completa mascherata
  // from menu to tendina.
  // -------------------------------------------------------------------------
  app.get('/api/audit/actions', { preHandler: [requireAuth(ctx)] }, async (request, reply) => {
    requireLevel(actorOf(request), 'audit', 1);
    const { AUDIT_ACTIONS } = await import('#src/audit/actions.ts');
    const modules = await ctx.db
      .selectFrom('auth.modules')
      .select(['key', 'name'])
      .orderBy('sort_order')
      .execute();
    return reply.send({ actions: Object.values(AUDIT_ACTIONS).sort(), modules });
  });

  // -------------------------------------------------------------------------
  // GET /api/audit/integrity — la stessa verifica dell'endpoint interno, ma
  // esposta a chi ha `audit:3`: e' l'informazione che rende il registro
  // credibile, e chi lo consulta deve poterla vedere senza chiedere ai sistemi.
  // -------------------------------------------------------------------------
  app.get('/api/audit/integrity', { preHandler: [requireAuth(ctx)] }, async (request, reply) => {
    requireLevel(actorOf(request), 'audit', 3);
    const now = new Date();
    const key = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const verdict = await verifyPartition(ctx.db, key);
    return reply.send({
      partition: verdict.partitionKey,
      ok: verdict.ok,
      rows: verdict.rowsChecked,
      detail: verdict.detail,
    });
  });
}
