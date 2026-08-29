// Le rotte di «Duels · Configurazioni».
//
// DUE PUBBLICI, E NON SI SOMIGLIANO. Sei rotte parlano con il pannello e
// vogliono una sessione; una parla con i server di gioco e vuole un token.
// Stanno nello stesso file perche' leggono le stesse tabelle, e sono separate
// da una riga in testa a ciascuna — la sessione non apre il bundle, e il token
// non apre nient'altro.
//
// I TRE LIVELLI SONO TRE DECISIONI DIVERSE, e questo e' l'unico posto dove si
// vedono tutte e tre in fila:
//
//   1  guarda i file
//   2  scrive una bozza — non tocca il gioco
//   3  PUBBLICA, e il cambiamento arriva ai server al loro prossimo avvio
//
// Il salto che conta e' fra 2 e 3. Sono la stessa persona che scrive e la
// stessa schermata che mostra, ma sono due responsabilita' diverse, e su una
// chiave sola sarebbero diventate la stessa.

import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppContext } from '#src/app-context.ts';
import { AUDIT_ACTIONS } from '#src/audit/actions.ts';
import { writeAudit } from '#src/audit/log.ts';
import { require as requireLevel } from '#src/authz/can.ts';
import {
  CONFIG_MODULES,
  createConfigPath,
  ForbiddenPath,
  isConfigModule,
  isConfigPath,
  listConfigFiles,
  PathExists,
  publishConfigDrafts,
  readConfigBundle,
  readConfigFile,
  saveConfigDraft,
  setConfigLinks,
  UnknownPath,
} from '#src/duels/config-store.ts';
import { requireAuth } from '../guards.ts';
import { actorOf, auditActorOf, auditContextOf, requestIps } from '../request-context.ts';

/**
 * Il tetto su un contenuto. 512 kB.
 *
 * Il file piu' grosso del plugin oggi sta sotto i 60 kB, quindi il tetto e'
 * largo dieci volte cio' che serve — ed e' comunque un tetto, perche' senza,
 * una richiesta sola potrebbe piantare in memoria quanto vuole.
 */
const MAX_CONTENT = 512 * 1024;

const pathQuery = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: { path: { type: 'string', minLength: 1, maxLength: 240 } },
  },
} as const;

const createBody = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['path', 'modules'],
    properties: {
      path: { type: 'string', minLength: 1, maxLength: 240 },
      modules: {
        type: 'array',
        maxItems: CONFIG_MODULES.length,
        items: { type: 'string', minLength: 1, maxLength: 40 },
      },
    },
  },
} as const;

const draftBody = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['versionId', 'content'],
    properties: {
      versionId: { type: 'integer' },
      content: { type: 'string', maxLength: MAX_CONTENT },
    },
  },
} as const;

const linksBody = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['path', 'modules', 'split', 'keepVersionId'],
    properties: {
      path: { type: 'string', minLength: 1, maxLength: 240 },
      modules: {
        type: 'array',
        maxItems: CONFIG_MODULES.length,
        items: { type: 'string', minLength: 1, maxLength: 40 },
      },
      split: { type: 'boolean' },
      keepVersionId: { type: 'integer' },
    },
  },
} as const;

const bundleQuery = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    required: ['module'],
    properties: { module: { type: 'string', minLength: 1, maxLength: 40 } },
  },
} as const;

function badPath(reply: FastifyReply, path: string): FastifyReply {
  return reply.code(400).send({
    error: 'percorso non valido',
    detail: `«${path}» non è un percorso di configurazione: serve un percorso relativo che finisce in .yml`,
  });
}

function badModules(reply: FastifyReply): FastifyReply {
  return reply.code(400).send({
    error: 'modulo sconosciuto',
    detail: `i moduli ammessi sono: ${CONFIG_MODULES.join(', ')}`,
  });
}

/**
 * Confronto del token a tempo costante.
 *
 * `timingSafeEqual` vuole due buffer della stessa lunghezza e altrimenti
 * solleva: la lunghezza si confronta prima, e questo la rivela. Non e' un
 * problema — la lunghezza di un segreto non e' il segreto — mentre confrontarlo
 * con `===` rivelerebbe da quale carattere in poi differisce.
 */
function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function registerDuelsConfigFileRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // -------------------------------------------------------------------------
  // Il pannello. Sessione, e un livello per ogni verbo.
  // -------------------------------------------------------------------------

  app.get('/api/duels/config', { preHandler: [requireAuth(ctx)] }, async (request, reply) => {
    requireLevel(actorOf(request), 'duels_config', 1);
    reply.header('Cache-Control', 'private, no-store');
    return { modules: CONFIG_MODULES, files: await listConfigFiles(ctx.db) };
  });

  app.get(
    '/api/duels/config/file',
    { schema: pathQuery, preHandler: [requireAuth(ctx)] },
    async (request, reply) => {
      requireLevel(actorOf(request), 'duels_config', 1);
      const { path } = request.query as { path: string };
      reply.header('Cache-Control', 'private, no-store');
      try {
        return await readConfigFile(ctx.db, path);
      } catch (err) {
        if (err instanceof UnknownPath) {
          return reply.code(404).send({ error: 'percorso sconosciuto', detail: path });
        }
        throw err;
      }
    },
  );

  app.post(
    '/api/duels/config/path',
    { schema: createBody, preHandler: [requireAuth(ctx)] },
    async (request, reply) => {
      const actor = actorOf(request);
      requireLevel(actor, 'duels_config', 2);

      const body = request.body as { path: string; modules: string[] };
      if (!isConfigPath(body.path)) return badPath(reply, body.path);
      if (!body.modules.every(isConfigModule)) return badModules(reply);

      try {
        await createConfigPath(ctx.db, {
          path: body.path,
          modules: body.modules,
          author: actor.actorEmail,
        });
      } catch (err) {
        // 403 e non 400: il percorso e' scritto benissimo, e' la richiesta che
        // non si fa. Chi legge il log deve poter distinguere «hai sbagliato a
        // scrivere» da «no».
        if (err instanceof ForbiddenPath) {
          return reply.code(403).send({
            error: 'percorso non gestibile',
            detail: 'contiene segreti o serve a caricare il plugin: non passa dal pannello',
          });
        }
        if (err instanceof PathExists) {
          return reply.code(409).send({ error: 'percorso già presente', detail: body.path });
        }
        throw err;
      }
      return reply.code(201).send({ path: body.path });
    },
  );

  app.put(
    '/api/duels/config/draft',
    { schema: draftBody, preHandler: [requireAuth(ctx)] },
    async (request, reply) => {
      const actor = actorOf(request);
      requireLevel(actor, 'duels_config', 2);
      const body = request.body as { versionId: number; content: string };
      // NON si registra sul registro attivita': una bozza non tocca il gioco, e
      // una riga per ogni salvataggio riempirebbe il registro proprio dove
      // serve leggerlo. Cio' che finisce a registro e' la pubblicazione.
      await saveConfigDraft(ctx.db, { ...body, author: actor.actorEmail });
      return { ok: true };
    },
  );

  app.put(
    '/api/duels/config/links',
    { schema: linksBody, preHandler: [requireAuth(ctx)] },
    async (request, reply) => {
      const actor = actorOf(request);
      requireLevel(actor, 'duels_config', 2);
      const body = request.body as {
        path: string;
        modules: string[];
        split: boolean;
        keepVersionId: number;
      };
      if (!body.modules.every(isConfigModule)) return badModules(reply);

      try {
        await setConfigLinks(ctx.db, { ...body, author: actor.actorEmail });
      } catch (err) {
        if (err instanceof UnknownPath) {
          return reply.code(404).send({ error: 'percorso sconosciuto', detail: body.path });
        }
        throw err;
      }
      return { ok: true };
    },
  );

  app.post('/api/duels/config/publish', { preHandler: [requireAuth(ctx)] }, async (request) => {
    const actor = actorOf(request);
    // TRE, ed e' l'unica rotta di questa schermata che lo chiede. Da qui in poi
    // il cambiamento e' in produzione.
    requireLevel(actor, 'duels_config', 3);

    const summary = await publishConfigDrafts(ctx.db, actor.actorEmail);

    // Si aspetta, e un guasto non fa fallire la richiesta: la pubblicazione e'
    // gia' avvenuta, e dire «non pubblicato» sarebbe falso. Resta una riga di
    // errore forte — una modifica alla configurazione del gioco senza traccia
    // e' esattamente cio' che il registro esiste per impedire.
    await writeAudit(ctx.db, {
      action: AUDIT_ACTIONS.duelsConfigPublished,
      outcome: 'success',
      actor: auditActorOf(actor),
      request: auditContextOf(request, requestIps(request)),
      moduleKey: 'duels_config',
      targetType: 'duels_config',
      targetId: null,
      targetLabel: `${summary.files} file`,
      meta: { file: summary.files, moduli: summary.modules },
    }).catch((err) => {
      ctx.logger.error({ err, files: summary.files }, 'pubblicazione configurazioni NON registrata');
    });

    return summary;
  });

  // -------------------------------------------------------------------------
  // I server di gioco. Token, nessuna sessione, sola lettura.
  // -------------------------------------------------------------------------

  app.get('/api/duels/config/bundle', { schema: bundleQuery }, async (request, reply) => {
    const expected = ctx.env.DUELS_CONFIG_TOKEN;
    if (!expected) {
      return reply.code(503).send({
        error: 'non disponibile',
        detail: 'DUELS_CONFIG_TOKEN non è configurato su questa installazione',
      });
    }

    const given = request.headers['x-duels-token'];
    if (typeof given !== 'string' || !tokenMatches(given, expected)) {
      // 401 nudo: nessun dettaglio su cosa manchi. Un messaggio che distingua
      // «token assente» da «token sbagliato» e' un aiuto a chi prova.
      return reply.code(401).send({ error: 'non autorizzato' });
    }

    const { module } = request.query as { module: string };
    if (!isConfigModule(module)) return badModules(reply);

    const bundle = await readConfigBundle(ctx.db, module);

    // L'ETag e' l'impronta del contenuto: un server che riavvia con lo stesso
    // bundle riceve 304 e non ritrasferisce niente. E' la ragione per cui
    // l'impronta si calcola sui dati e non su un contatore.
    const etag = `"${bundle.version}"`;
    reply.header('Cache-Control', 'private, no-store').header('ETag', etag);
    if (request.headers['if-none-match'] === etag) return reply.code(304).send();
    return bundle;
  });
}
