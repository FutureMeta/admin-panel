// Il modulo «modalita'» del pannello. Fase 2, emendamento E4.
//
// PERMESSO: `statistiche` a livello 3 (gestione) per ogni modifica, livello 1
// per la sola lettura. Non e' zelo: il dizionario decide come si raggruppano i
// server in OGNI grafico, quindi cambiarlo cambia tutti i numeri per modalita'
// a partire dal giro successivo. Chi puo' guardare i grafici non deve poterli
// ridefinire.
//
// OGNI MODIFICA VA NEL REGISTRO con il prima e il dopo. Un grafico che cambia
// forma senza che nessuno sappia dire perche' e' peggio di un grafico assente:
// il secondo lo si va a cercare, il primo lo si crede.

import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import type { AppContext } from '#src/app-context.ts';
import { AUDIT_ACTIONS } from '#src/audit/actions.ts';
import { securityTransaction } from '#src/audit/log.ts';
import { require as requireLevel } from '#src/authz/can.ts';
import { BadRequest, NotFound } from '#src/http/errors.ts';
import { type Alias, MATCH_KINDS, type MatchKind, previewAlias, readDictionary } from '#src/stats/modes.ts';
import { requireAuth } from '../guards.ts';
import { actorOf, auditActorOf, auditContextOf, requestIps } from '../request-context.ts';

const MODULE = 'statistiche';
/** Il livello che il §7 chiama «gestione». */
const MANAGE = 3;

/**
 * Le chiavi che il livello di lettura si riserva.
 *
 * `__network__` e `__transit__` sono sentinella dei SERVER, `__unknown__` e'
 * il secchiello di chi nessuna regola cattura. Nessuno dei tre e' una
 * modalita', e lasciar creare una modalita' con uno di quei nomi la
 * mimetizzerebbe fra i sentinella: il grafico mostrerebbe due serie con la
 * stessa etichetta e nessuna delle due sarebbe quella attesa.
 */
const RESERVED = new Set(['__network__', '__transit__', '__unknown__']);

const MODE_KEY = /^[a-z0-9_]{1,32}$/;
const COLOR = /^#[0-9a-f]{6}$/;

const aliasSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['matchKind', 'matchValue'],
  properties: {
    matchKind: { type: 'string', enum: [...MATCH_KINDS] },
    matchValue: { type: 'string', minLength: 1, maxLength: 64 },
  },
} as const;

const keyParams = {
  type: 'object',
  additionalProperties: false,
  required: ['key'],
  properties: { key: { type: 'string', maxLength: 32 } },
} as const;

function assertModeKey(key: string): void {
  if (!MODE_KEY.test(key)) throw new BadRequest('CHIAVE_NON_VALIDA');
  if (RESERVED.has(key)) throw new BadRequest('CHIAVE_RISERVATA');
}

function normalizeAlias(a: Alias): Alias {
  const matchValue = a.matchValue.trim().toLowerCase();
  if (matchValue === '') throw new BadRequest('REGOLA_VUOTA');
  // Una regola vuota catturerebbe TUTTO: il database la rifiuta comunque, ma
  // qui il messaggio dice cosa e' successo invece di uno SQLSTATE.
  return { matchKind: a.matchKind as MatchKind, matchValue };
}

type ModeRow = {
  mode_id: number;
  mode_key: string;
  display_name: string;
  color: string | null;
  in_breakdown: boolean;
  hidden: boolean;
  sort_order: number;
};

async function modeByKey(ctx: AppContext, key: string): Promise<ModeRow> {
  const res = await sql<ModeRow>`
    SELECT mode_id, mode_key, display_name, color, in_breakdown, hidden, sort_order
      FROM stats.mode WHERE mode_key = ${key}
  `.execute(ctx.db);
  const row = res.rows[0];
  if (!row) throw new NotFound();
  return row;
}

async function aliasesOf(ctx: AppContext, modeId: number): Promise<Alias[]> {
  const res = await sql<{ match_kind: MatchKind; match_value: string }>`
    SELECT match_kind, match_value FROM stats.mode_alias
     WHERE mode_id = ${modeId} ORDER BY match_kind, match_value
  `.execute(ctx.db);
  return res.rows.map((r) => ({ matchKind: r.match_kind, matchValue: r.match_value }));
}

export async function registerStatsModeRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // --- lettura --------------------------------------------------------------
  app.get('/api/stats/modes', { preHandler: [requireAuth(ctx)] }, async (request, reply) => {
    requireLevel(actorOf(request), MODULE, 1);
    return reply.send(await readDictionary(ctx.db));
  });

  // --- creazione ------------------------------------------------------------
  app.post(
    '/api/stats/modes',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['modeKey', 'displayName'],
          properties: {
            modeKey: { type: 'string', maxLength: 32 },
            displayName: { type: 'string', minLength: 1, maxLength: 64 },
            color: { type: 'string', maxLength: 7 },
            sortOrder: { type: 'integer', minimum: 0, maximum: 990 },
          },
        },
      },
      preHandler: [requireAuth(ctx)],
    },
    async (request, reply) => {
      const actor = actorOf(request);
      requireLevel(actor, MODULE, MANAGE);
      const ips = requestIps(request);
      const b = request.body as {
        modeKey: string;
        displayName: string;
        color?: string;
        sortOrder?: number;
      };
      assertModeKey(b.modeKey);
      if (b.color !== undefined && !COLOR.test(b.color)) throw new BadRequest('COLORE_NON_VALIDO');

      const created = await securityTransaction(ctx.db, async (trx) => {
        const res = await sql<{ mode_id: number }>`
          INSERT INTO stats.mode (mode_key, display_name, color, sort_order)
          VALUES (${b.modeKey}, ${b.displayName.trim()}, ${b.color ?? null},
                  ${b.sortOrder ?? 1000})
          ON CONFLICT (mode_key) DO NOTHING
          RETURNING mode_id
        `.execute(trx);
        const row = res.rows[0];
        if (!row) throw new BadRequest('CHIAVE_GIA_USATA');
        return {
          result: Number(row.mode_id),
          events: {
            action: AUDIT_ACTIONS.statsModeCreated,
            outcome: 'success' as const,
            actor: auditActorOf(actor),
            request: auditContextOf(request, ips),
            moduleKey: MODULE,
            targetType: 'stats_mode',
            targetId: b.modeKey,
            targetLabel: b.displayName,
            // Una modalita' nasce senza regole: non cattura ancora niente, e
            // il grafico non cambia finche' non gliene si da' una.
            before: null,
            after: {
              modeKey: b.modeKey,
              displayName: b.displayName,
              color: b.color ?? null,
              sortOrder: b.sortOrder ?? 1000,
            },
          },
        };
      });
      return reply.code(201).send({ modeId: created });
    },
  );

  // --- modifica -------------------------------------------------------------
  app.patch(
    '/api/stats/modes/:key',
    {
      schema: {
        params: keyParams,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            displayName: { type: 'string', minLength: 1, maxLength: 64 },
            color: { type: ['string', 'null'], maxLength: 7 },
            sortOrder: { type: 'integer', minimum: 0, maximum: 990 },
            inBreakdown: { type: 'boolean' },
            hidden: { type: 'boolean' },
          },
        },
      },
      preHandler: [requireAuth(ctx)],
    },
    async (request, reply) => {
      const actor = actorOf(request);
      requireLevel(actor, MODULE, MANAGE);
      const ips = requestIps(request);
      const { key } = request.params as { key: string };
      const b = request.body as {
        displayName?: string;
        color?: string | null;
        sortOrder?: number;
        inBreakdown?: boolean;
        hidden?: boolean;
      };
      if (b.color !== undefined && b.color !== null && !COLOR.test(b.color)) {
        throw new BadRequest('COLORE_NON_VALIDO');
      }
      const before = await modeByKey(ctx, key);

      await securityTransaction(ctx.db, async (trx) => {
        await sql`
          UPDATE stats.mode SET
            display_name = COALESCE(${b.displayName?.trim() ?? null}, display_name),
            color        = ${b.color === undefined ? sql`color` : b.color},
            sort_order   = COALESCE(${b.sortOrder ?? null}, sort_order),
            in_breakdown = COALESCE(${b.inBreakdown ?? null}, in_breakdown),
            hidden       = COALESCE(${b.hidden ?? null}, hidden),
            updated_at   = now()
          WHERE mode_key = ${key}
        `.execute(trx);
        return {
          result: null,
          events: {
            action: AUDIT_ACTIONS.statsModeUpdated,
            outcome: 'success' as const,
            actor: auditActorOf(actor),
            request: auditContextOf(request, ips),
            moduleKey: MODULE,
            targetType: 'stats_mode',
            targetId: key,
            targetLabel: b.displayName ?? before.display_name,
            before: {
              displayName: before.display_name,
              color: before.color,
              sortOrder: before.sort_order,
              inBreakdown: before.in_breakdown,
              hidden: before.hidden,
            },
            after: b,
          },
        };
      });
      return reply.send({ ok: true });
    },
  );

  // --- eliminazione ---------------------------------------------------------
  app.delete(
    '/api/stats/modes/:key',
    { schema: { params: keyParams }, preHandler: [requireAuth(ctx)] },
    async (request, reply) => {
      const actor = actorOf(request);
      requireLevel(actor, MODULE, MANAGE);
      const ips = requestIps(request);
      const { key } = request.params as { key: string };
      const before = await modeByKey(ctx, key);
      const rules = await aliasesOf(ctx, Number(before.mode_id));

      await securityTransaction(ctx.db, async (trx) => {
        // Le regole cadono con la modalita' (ON DELETE CASCADE). I server che
        // catturava tornano in `__unknown__`, che e' una serie visibile: non
        // spariscono dal totale, cambiano etichetta.
        await sql`DELETE FROM stats.mode WHERE mode_key = ${key}`.execute(trx);
        return {
          result: null,
          events: {
            action: AUDIT_ACTIONS.statsModeDeleted,
            outcome: 'success' as const,
            actor: auditActorOf(actor),
            request: auditContextOf(request, ips),
            moduleKey: MODULE,
            targetType: 'stats_mode',
            targetId: key,
            targetLabel: before.display_name,
            before: { modalita: before.display_name, regole: rules },
            after: null,
          },
        };
      });
      return reply.send({ ok: true });
    },
  );

  // --- regole ---------------------------------------------------------------
  app.put(
    '/api/stats/modes/:key/aliases',
    {
      schema: {
        params: keyParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['aliases'],
          properties: { aliases: { type: 'array', maxItems: 64, items: aliasSchema } },
        },
      },
      preHandler: [requireAuth(ctx)],
    },
    async (request, reply) => {
      const actor = actorOf(request);
      requireLevel(actor, MODULE, MANAGE);
      const ips = requestIps(request);
      const { key } = request.params as { key: string };
      const mode = await modeByKey(ctx, key);
      const wanted = (request.body as { aliases: Alias[] }).aliases.map(normalizeAlias);
      const before = await aliasesOf(ctx, Number(mode.mode_id));

      await securityTransaction(ctx.db, async (trx) => {
        await sql`DELETE FROM stats.mode_alias WHERE mode_id = ${mode.mode_id}`.execute(trx);
        for (const a of wanted) {
          // Una regola gia' usata da un'altra modalita' passa a questa: e' una
          // riassegnazione esplicita, e il registro ne conserva il prima.
          await sql`
            INSERT INTO stats.mode_alias (match_kind, match_value, mode_id)
            VALUES (${a.matchKind}, ${a.matchValue}, ${mode.mode_id})
            ON CONFLICT (match_kind, match_value) DO UPDATE SET mode_id = EXCLUDED.mode_id
          `.execute(trx);
        }
        return {
          result: null,
          events: {
            action: AUDIT_ACTIONS.statsModeAliasesChanged,
            outcome: 'success' as const,
            actor: auditActorOf(actor),
            request: auditContextOf(request, ips),
            moduleKey: MODULE,
            targetType: 'stats_mode',
            targetId: key,
            targetLabel: mode.display_name,
            before: { regole: before },
            after: { regole: wanted },
          },
        };
      });
      return reply.send({ ok: true });
    },
  );

  // --- anteprima ------------------------------------------------------------
  app.post(
    '/api/stats/modes/:key/preview',
    {
      schema: { params: keyParams, body: aliasSchema },
      preHandler: [requireAuth(ctx)],
    },
    async (request, reply) => {
      const actor = actorOf(request);
      requireLevel(actor, MODULE, MANAGE);
      const { key } = request.params as { key: string };
      await modeByKey(ctx, key); // 404 se non esiste, prima di toccare altro
      const alias = normalizeAlias(request.body as Alias);

      // POST e non GET: l'anteprima INSERISCE davvero la regola e poi annulla
      // la transazione, per non riscrivere il matcher da nessun'altra parte.
      // Una GET che apre una transazione in scrittura violerebbe la guardia
      // sui GET che cambiano stato, e avrebbe ragione lei.
      const rows = await previewAlias(ctx.db, key, alias);
      const cambiati = rows.filter((r) => r.before !== r.after);
      return reply.send({
        alias,
        // Solo cio' che CAMBIA: un elenco di ventidue server di cui venti
        // identici nasconde i due che contano.
        changes: cambiati,
        captured: rows.filter((r) => r.after === key).length,
        // I server che la regola tocca ma che restano a un'altra modalita':
        // e' il caso di `duels_` contro `duels_lobby_`, dove vince la regola
        // piu' specifica. Va mostrato, o l'operatore crede di aver sbagliato.
        unchanged: rows.length - cambiati.length,
      });
    },
  );
}
