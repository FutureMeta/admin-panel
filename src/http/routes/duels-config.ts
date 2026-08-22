// Le rotte di Modes e Maps: le uniche del pannello che scrivono nel gioco.
//
// DUE MODULI PROPRI, `duels_modes` e `duels_maps`, e tre livelli distinti: 1
// apre e legge, 2 salva, 3 elimina. Prima bastava `duels` a 3, cioe' un livello
// alto su un modulo che nella matrice si chiama «Trends»: chi concedeva
// «Gestione su Trends» stava concedendo di cambiare le regole del gioco, e la
// matrice non lo diceva da nessuna parte. Un permesso che non compare e' un
// permesso che nessuno revoca.
//
// La voce di menu compare solo a chi ha il livello, ma la voce di menu e'
// cortesia; il controllo e' qui.
//
// NIENTE CACHE. Sono le uniche schermate del modulo in cui si MODIFICA quello
// che si legge: servire trenta secondi di ritardo vorrebbe dire salvare sopra
// uno stato che non e' piu' quello. `no-store`, e ogni salvataggio rilegge.
//
// IL SALVATAGGIO NON RAGGIUNGE I SERVER ACCESI, e la risposta lo dice. I server
// tengono modalita' e mappe in una cache in memoria caricata una volta
// all'avvio: finche' non riavviano continuano con la configurazione vecchia.
// Tacerlo produrrebbe la peggiore delle esperienze — una modifica che risulta
// salvata, e' salvata, e in gioco non succede niente.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '#src/app-context.ts';
import { AUDIT_ACTIONS } from '#src/audit/actions.ts';
import { writeAudit } from '#src/audit/log.ts';
import { require as requireLevel } from '#src/authz/can.ts';
import {
  type ConfigChange,
  deleteMap,
  deleteMode,
  InvalidValue,
  isNoOp,
  listMaps,
  listModes,
  mapDetail,
  missingPrivilege,
  modeDetail,
  NotFound,
  saveMap,
  saveMode,
  vocabulary,
} from '#src/duels/config.ts';
import type { DuelsMysql } from '#src/duels/mysql.ts';
import { requireAuth } from '../guards.ts';
import { actorOf, auditActorOf, auditContextOf, requestIps } from '../request-context.ts';

/**
 * La frase che accompagna ogni salvataggio.
 *
 * Sta in una costante perche' deve essere la STESSA su modalita' e mappe: due
 * formulazioni diverse per lo stesso fatto si leggono come due fatti diversi.
 */
const RELOAD_NOTE = 'Salvato. I server gia` accesi la useranno dal prossimo riavvio.';

const settingsBody = {
  type: 'object',
  additionalProperties: { type: 'string', maxLength: 64 },
} as const;

const modeBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    displayName: { type: 'string', minLength: 1, maxLength: 255 },
    type: { type: 'string', maxLength: 50 },
    ranking: { type: 'string', maxLength: 50 },
    settings: settingsBody,
  },
} as const;

const mapBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    displayName: { type: 'string', minLength: 1, maxLength: 255 },
    type: { type: 'string', maxLength: 50 },
    context: { type: 'string', maxLength: 50 },
    settings: settingsBody,
    modeIds: { type: 'array', items: { type: 'integer' }, maxItems: 200 },
    eventTypes: { type: 'array', items: { type: 'string', maxLength: 50 }, maxItems: 200 },
  },
} as const;

const idParams = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;

export function registerDuelsConfigRoutes(app: FastifyInstance, ctx: AppContext): void {
  /**
   * Senza `DUELS_MYSQL_URL` la schermata non esiste, e lo dice.
   *
   * 503 e non 404: la rotta c'e', e' l'installazione che non ha la connessione
   * al gioco. Un 404 manderebbe a cercare un errore di instradamento.
   */
  const gameDb = (reply: FastifyReply): DuelsMysql | null => {
    if (ctx.duelsMysql) return ctx.duelsMysql;
    reply.code(503).send({
      error: 'configurazione duels non disponibile',
      detail: 'manca DUELS_MYSQL_URL: il pannello non ha una connessione al database del gioco',
    });
    return null;
  };

  // TRE LIVELLI DISTINTI, ed e il vocabolario del pannello applicato a queste
  // due schermate: 1 apre e legge, 2 salva, 3 elimina. L eliminazione sta un
  // gradino sopra perche e la sola cosa irreversibile qui dentro — togliere
  // una modalita porta via a cascata i suoi settings, i suoi kit e i preferiti
  // dei giocatori che la puntano.
  const canRead = (request: FastifyRequest, module: 'duels_modes' | 'duels_maps') =>
    requireLevel(actorOf(request), module, 1);
  const canWrite = (request: FastifyRequest, module: 'duels_modes' | 'duels_maps') =>
    requireLevel(actorOf(request), module, 2);
  const canDelete = (request: FastifyRequest, module: 'duels_modes' | 'duels_maps') =>
    requireLevel(actorOf(request), module, 3);

  const record = async (
    request: FastifyRequest,
    module: 'duels_modes' | 'duels_maps',
    action: string,
    targetType: string,
    targetId: string,
    targetLabel: string,
    meta: Record<string, unknown>,
  ): Promise<void> => {
    // SI ASPETTA, e un fallimento NON fa fallire la richiesta. La scrittura sul
    // gioco e' gia' avvenuta e vive in un altro database: dire «non salvato»
    // sarebbe falso. Resta una riga di errore forte, perche' una modifica alla
    // configurazione del gioco senza traccia e' esattamente cio' che il
    // registro esiste per impedire.
    await writeAudit(ctx.db, {
      action: action as never,
      outcome: 'success',
      actor: auditActorOf(actorOf(request)),
      request: auditContextOf(request, requestIps(request)),
      moduleKey: module,
      targetType,
      targetId,
      targetLabel,
      meta,
    }).catch((err) => {
      ctx.logger.error({ err, action, targetId }, 'modifica alla configurazione duels NON registrata');
    });
  };

  /** I piani, in una forma che si legge nel registro fra sei mesi. */
  const metaOf = (change: ConfigChange): Record<string, unknown> => ({
    campi: change.fields,
    settingsScritti: change.settings.upserts,
    settingsRimossi: change.settings.deletes,
    ...(change.modes ? { modalitaAggiunte: change.modes.add, modalitaTolte: change.modes.remove } : {}),
    ...(change.events ? { eventiAggiunti: change.events.add, eventiTolti: change.events.remove } : {}),
  });

  const failed = (request: FastifyRequest, reply: FastifyReply, err: unknown): FastifyReply => {
    const missing = missingPrivilege(err);
    if (missing) {
      // NON E' UN 500. Il codice ha fatto la cosa giusta e il database del gioco
      // ha risposto che quell'utente non puo': un «errore non gestito» manda a
      // cercare un difetto nel pannello, mentre quello che manca e' una GRANT.
      // Sono due cose che si sistemano in due posti diversi, e la risposta deve
      // dire in quale.
      //
      // 503 e non 403: il 403 e' la risposta a «TU non puoi», e qui la persona
      // ha tutti i permessi del pannello — e' il pannello a non averli sul
      // database del gioco.
      request.log.warn(
        { err, privilege: missing.privilege, table: missing.table },
        'privilegio mancante sul database del gioco: la configurazione non e` scrivibile',
      );
      return reply.code(503).send({
        error: 'privilegi mancanti',
        code: 'privilegi_mancanti',
        detail: `Al pannello manca il privilegio ${missing.privilege} sulla tabella ${missing.table}.`,
      });
    }
    if (err instanceof NotFound) {
      // 404 e non un salvataggio a vuoto: qualcuno ha eliminato la riga mentre
      // questa scheda era aperta, ed e' un fatto da dire.
      return reply.code(404).send({ error: 'non trovato', detail: err.message });
    }
    if (err instanceof InvalidValue) {
      return reply.code(400).send({ error: 'valore non ammesso', detail: err.message });
    }
    throw err;
  };

  // --- lettura ---------------------------------------------------------------

  app.get('/api/duels/config/vocabulary', { preHandler: [requireAuth(ctx)] }, async (request, reply) => {
    canRead(request, 'duels_modes');
    const my = gameDb(reply);
    if (!my) return reply;
    return reply.send(await vocabulary(my));
  });

  app.get('/api/duels/config/modes', { preHandler: [requireAuth(ctx)] }, async (request, reply) => {
    canRead(request, 'duels_modes');
    const my = gameDb(reply);
    if (!my) return reply;
    return reply.send({ modes: await listModes(my) });
  });

  app.get(
    '/api/duels/config/modes/:id',
    { schema: { params: idParams }, preHandler: [requireAuth(ctx)] },
    async (request, reply) => {
      canRead(request, 'duels_modes');
      const my = gameDb(reply);
      if (!my) return reply;
      const { id } = request.params as { id: number };
      const detail = await modeDetail(my, id);
      if (!detail) return reply.code(404).send({ error: 'modalita` non trovata' });
      return reply.send(detail);
    },
  );

  app.get('/api/duels/config/maps', { preHandler: [requireAuth(ctx)] }, async (request, reply) => {
    canRead(request, 'duels_maps');
    const my = gameDb(reply);
    if (!my) return reply;
    return reply.send({ maps: await listMaps(my) });
  });

  app.get(
    '/api/duels/config/maps/:id',
    { schema: { params: idParams }, preHandler: [requireAuth(ctx)] },
    async (request, reply) => {
      canRead(request, 'duels_maps');
      const my = gameDb(reply);
      if (!my) return reply;
      const { id } = request.params as { id: number };
      const detail = await mapDetail(my, id);
      if (!detail) return reply.code(404).send({ error: 'mappa non trovata' });
      return reply.send(detail);
    },
  );

  // --- scrittura -------------------------------------------------------------

  app.patch(
    '/api/duels/config/modes/:id',
    { schema: { params: idParams, body: modeBody }, preHandler: [requireAuth(ctx)] },
    async (request, reply) => {
      canWrite(request, 'duels_modes');
      const my = gameDb(reply);
      if (!my) return reply;
      const { id } = request.params as { id: number };

      try {
        const change = await saveMode(my, id, request.body as Parameters<typeof saveMode>[2]);
        const detail = await modeDetail(my, id);

        // NIENTE RIGA DI REGISTRO PER UNA MODIFICA CHE NON HA MODIFICATO
        // NIENTE. Succede piu' spesso di quanto sembri — si apre, si tocca, si
        // rimette com'era, si salva — e riempire il registro di righe vuote e'
        // il modo piu' rapido di renderlo inservibile.
        if (!isNoOp(change)) {
          await record(
            request,
            'duels_modes',
            AUDIT_ACTIONS.duelsModeUpdated,
            'duels_mode',
            String(id),
            detail?.mode.name ?? String(id),
            metaOf(change),
          );
        }
        return reply.send({ ...detail, note: RELOAD_NOTE, changed: !isNoOp(change) });
      } catch (err) {
        return failed(request, reply, err);
      }
    },
  );

  app.delete(
    '/api/duels/config/modes/:id',
    { schema: { params: idParams }, preHandler: [requireAuth(ctx)] },
    async (request, reply) => {
      canDelete(request, 'duels_modes');
      const my = gameDb(reply);
      if (!my) return reply;
      const { id } = request.params as { id: number };

      try {
        const name = await deleteMode(my, id);
        await record(request, 'duels_modes', AUDIT_ACTIONS.duelsModeDeleted, 'duels_mode', String(id), name, {
          cascata: 'settings, kit e preferiti dei giocatori',
        });
        return reply.send({ deleted: name, note: RELOAD_NOTE });
      } catch (err) {
        return failed(request, reply, err);
      }
    },
  );

  app.patch(
    '/api/duels/config/maps/:id',
    { schema: { params: idParams, body: mapBody }, preHandler: [requireAuth(ctx)] },
    async (request, reply) => {
      canWrite(request, 'duels_maps');
      const my = gameDb(reply);
      if (!my) return reply;
      const { id } = request.params as { id: number };

      try {
        const change = await saveMap(my, id, request.body as Parameters<typeof saveMap>[2]);
        const detail = await mapDetail(my, id);

        if (!isNoOp(change)) {
          await record(
            request,
            'duels_maps',
            AUDIT_ACTIONS.duelsMapUpdated,
            'duels_map',
            String(id),
            detail?.map.name ?? String(id),
            metaOf(change),
          );
        }
        return reply.send({ ...detail, note: RELOAD_NOTE, changed: !isNoOp(change) });
      } catch (err) {
        return failed(request, reply, err);
      }
    },
  );

  app.delete(
    '/api/duels/config/maps/:id',
    { schema: { params: idParams }, preHandler: [requireAuth(ctx)] },
    async (request, reply) => {
      canDelete(request, 'duels_maps');
      const my = gameDb(reply);
      if (!my) return reply;
      const { id } = request.params as { id: number };

      try {
        const name = await deleteMap(my, id);
        await record(request, 'duels_maps', AUDIT_ACTIONS.duelsMapDeleted, 'duels_map', String(id), name, {
          cascata: 'modalita`, event type, settings, aree, location e team',
          mondo: 'non toccato',
        });
        return reply.send({ deleted: name, note: RELOAD_NOTE });
      } catch (err) {
        return failed(request, reply, err);
      }
    },
  );
}
