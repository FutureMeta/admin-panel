// Le rotte di «Lingue».
//
// CINQUE ROTTE, TUTTE DEL PANNELLO. Non ce n'e' una per i server di gioco,
// e non e' una mancanza: i server parlano col database di Metaverse, non con
// noi. Ci scrivono i testi del jar all'avvio e ne rileggono l'impronta ogni
// minuto. Il pannello scrive nello stesso posto, e loro se ne accorgono da
// soli. Nessuna riga di Java cambia.
//
// I TRE LIVELLI:
//
//   1  legge i testi
//   2  li modifica — e arrivano in gioco entro un minuto, senza bozza
//   3  gestisce le lingue: ne crea, le accende per i giocatori, le riordina
//
// LA CONVALIDA E' LA STESSA DEL BROWSER. `validateMiniMessage` gira mentre si
// scrive e di nuovo qui: la prima per dire «non si puo' salvare» prima di
// premere, la seconda perche' un client non e' un controllo. Un testo che il
// gioco scarterebbe non entra nel database — arrivarci e scoprirlo in chat e'
// esattamente cio' che il pannello sostituisce.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '#src/app-context.ts';
import { AUDIT_ACTIONS } from '#src/audit/actions.ts';
import { writeAudit } from '#src/audit/log.ts';
import { require as requireLevel } from '#src/authz/can.ts';
import type { DuelsMysql } from '#src/duels/mysql.ts';
import {
  createLanguage,
  LanguageExists,
  moveLanguage,
  readBundleKeys,
  readOverview,
  setValue,
  UnknownBundle,
  UnknownKey,
  UnknownLanguage,
  updateLanguage,
} from '#src/lang/store.ts';
import { validateMiniMessage } from '#web/lib/minimessage.ts';
import { requireAuth } from '../guards.ts';
import { actorOf, auditActorOf, auditContextOf, requestIps } from '../request-context.ts';

/** Un testo di gioco: una riga di chat, una lore, una scoreboard. 4 kB bastano. */
const MAX_VALUE = 4096;

const nsQuery = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    required: ['ns'],
    properties: { ns: { type: 'string', minLength: 3, maxLength: 64 } },
  },
} as const;

const valueBody = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['ns', 'key', 'code', 'value'],
    properties: {
      ns: { type: 'string', minLength: 3, maxLength: 64 },
      key: { type: 'string', minLength: 1, maxLength: 255 },
      code: { type: 'string', minLength: 2, maxLength: 16 },
      value: { type: 'string', maxLength: MAX_VALUE },
    },
  },
} as const;

const languageBody = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['code', 'display'],
    properties: {
      code: { type: 'string', pattern: '^[a-z]{2}$' },
      display: { type: 'string', minLength: 1, maxLength: 255 },
    },
  },
} as const;

const languagePatch = {
  params: {
    type: 'object',
    additionalProperties: false,
    required: ['code'],
    properties: { code: { type: 'string', minLength: 2, maxLength: 16 } },
  },
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      display: { type: 'string', minLength: 1, maxLength: 255 },
      active: { type: 'boolean' },
      move: { type: 'string', enum: ['up', 'down'] },
    },
  },
} as const;

/**
 * Il testo e' scrivibile? Vuoto e MiniMessage rotto sono le due risposte «no»,
 * e si spiegano in modo diverso: la prima ha un rimedio preciso — `<reset>` —
 * la seconda indica dove.
 */
function refuse(reply: FastifyReply, value: string): FastifyReply | null {
  if (value.trim() === '') {
    return reply.code(400).send({
      error: 'testo vuoto',
      detail: 'un testo vuoto non si salva: per un messaggio senza contenuto scrivi <reset>',
    });
  }
  const issues = validateMiniMessage(value);
  if (issues.length > 0) {
    return reply.code(400).send({
      error: 'MiniMessage non valido',
      detail: 'il server scarterebbe questo testo',
      issues,
    });
  }
  return null;
}

export async function registerLangRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  /**
   * Senza `METAVERSE_MYSQL_URL` la sezione non esiste, e lo dice.
   *
   * 503 e non 404: la rotta c'e', e' l'installazione che non ha la connessione
   * al database di Metaverse. Un 404 manderebbe a cercare un errore di
   * instradamento.
   */
  const gameDb = (reply: FastifyReply): DuelsMysql | null => {
    if (ctx.metaverseMysql) return ctx.metaverseMysql;
    reply.code(503).send({
      error: 'lingue non disponibili',
      detail: 'manca METAVERSE_MYSQL_URL: il pannello non ha una connessione al database di Metaverse',
    });
    return null;
  };

  /**
   * A registro, dopo che la scrittura e' riuscita. Un guasto qui non fa
   * fallire la richiesta — il dato e' gia' salvato — ma lascia una riga di
   * errore forte: per questi valori il registro e' l'unico storico, e un
   * testo cambiato senza traccia e' un testo di cui nessuno sapra' piu'
   * com'era.
   */
  const audit = (
    request: FastifyRequest,
    actor: ReturnType<typeof actorOf>,
    action: (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS],
    target: { type: string; label: string },
    meta: Record<string, unknown>,
  ): Promise<void> =>
    writeAudit(ctx.db, {
      action,
      outcome: 'success',
      actor: auditActorOf(actor),
      request: auditContextOf(request, requestIps(request)),
      moduleKey: 'lingue',
      targetType: target.type,
      targetId: null,
      targetLabel: target.label,
      meta,
    }).catch((err) => {
      ctx.logger.error({ err, action, target: target.label }, 'modifica NON registrata');
    });

  app.get('/api/lang', { preHandler: [requireAuth(ctx)] }, async (request, reply) => {
    requireLevel(actorOf(request), 'lingue', 1);
    const db = gameDb(reply);
    if (db === null) return reply;
    reply.header('Cache-Control', 'private, no-store');
    return readOverview(db);
  });

  app.get('/api/lang/keys', { schema: nsQuery, preHandler: [requireAuth(ctx)] }, async (request, reply) => {
    requireLevel(actorOf(request), 'lingue', 1);
    const db = gameDb(reply);
    if (db === null) return reply;
    const { ns } = request.query as { ns: string };
    reply.header('Cache-Control', 'private, no-store');
    try {
      return await readBundleKeys(db, ns);
    } catch (err) {
      if (err instanceof UnknownBundle)
        return reply.code(404).send({ error: 'bundle sconosciuto', detail: ns });
      throw err;
    }
  });

  app.put(
    '/api/lang/value',
    { schema: valueBody, preHandler: [requireAuth(ctx)] },
    async (request, reply) => {
      const actor = actorOf(request);
      requireLevel(actor, 'lingue', 2);
      const db = gameDb(reply);
      if (db === null) return reply;
      const body = request.body as { ns: string; key: string; code: string; value: string };

      const refused = refuse(reply, body.value);
      if (refused !== null) return refused;

      let before: string | null;
      try {
        before = (await setValue(db, { ...body, author: actor.actorEmail })).before;
      } catch (err) {
        if (err instanceof UnknownBundle || err instanceof UnknownKey) {
          return reply.code(404).send({ error: 'chiave sconosciuta', detail: `${body.ns} ${body.key}` });
        }
        if (err instanceof UnknownLanguage) {
          return reply.code(404).send({ error: 'lingua sconosciuta', detail: body.code });
        }
        throw err;
      }

      await audit(
        request,
        actor,
        AUDIT_ACTIONS.langValueSet,
        { type: 'lang_value', label: `${body.ns} ${body.key} [${body.code}]` },
        { ns: body.ns, key: body.key, code: body.code, before, after: body.value },
      );

      return { ok: true };
    },
  );

  app.post(
    '/api/lang/language',
    { schema: languageBody, preHandler: [requireAuth(ctx)] },
    async (request, reply) => {
      const actor = actorOf(request);
      requireLevel(actor, 'lingue', 3);
      const db = gameDb(reply);
      if (db === null) return reply;
      const body = request.body as { code: string; display: string };

      const refused = refuse(reply, body.display);
      if (refused !== null) return refused;

      let language: Awaited<ReturnType<typeof createLanguage>>;
      try {
        language = await createLanguage(db, { ...body, author: actor.actorEmail });
      } catch (err) {
        if (err instanceof LanguageExists) {
          return reply.code(409).send({ error: 'lingua già presente', detail: body.code });
        }
        throw err;
      }

      await audit(
        request,
        actor,
        AUDIT_ACTIONS.langLanguageCreated,
        { type: 'lang_language', label: body.code },
        body,
      );

      return reply.code(201).send(language);
    },
  );

  app.patch(
    '/api/lang/language/:code',
    { schema: languagePatch, preHandler: [requireAuth(ctx)] },
    async (request, reply) => {
      const actor = actorOf(request);
      requireLevel(actor, 'lingue', 3);
      const db = gameDb(reply);
      if (db === null) return reply;
      const { code } = request.params as { code: string };
      const body = request.body as { display?: string; active?: boolean; move?: 'up' | 'down' };

      if (body.display !== undefined) {
        const refused = refuse(reply, body.display);
        if (refused !== null) return refused;
      }

      try {
        if (body.move !== undefined) await moveLanguage(db, code, body.move);
        const patch = {
          ...(body.display === undefined ? {} : { display: body.display }),
          ...(body.active === undefined ? {} : { active: body.active }),
        };
        const language = await updateLanguage(db, code, patch);

        await audit(
          request,
          actor,
          AUDIT_ACTIONS.langLanguageChanged,
          { type: 'lang_language', label: code },
          { code, ...body },
        );

        return language;
      } catch (err) {
        if (err instanceof UnknownLanguage) {
          return reply.code(404).send({ error: 'lingua sconosciuta', detail: code });
        }
        throw err;
      }
    },
  );
}
