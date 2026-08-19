// Avatar Minecraft, serviti dalla nostra origine. §5.1
//
// La rotta e' autenticata: aperta, sarebbe un proxy anonimo verso Mojang
// ospitato a spese nostre e con la nostra reputazione di IP.
//
// Non c'e' controllo di modulo. Il nome di un giocatore e' gia' scritto in
// chiaro accanto alla sua faccia in ogni schermata che quella persona puo'
// vedere: chiedere un permesso in piu' per l'immagine proteggerebbe qualcosa
// che e' gia' visibile.

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '#src/app-context.ts';
import { isMinecraftUsername } from '#src/minecraft/skins.ts';
import { requireAuth } from '../guards.ts';

/**
 * Quanto il browser puo' tenersi la faccia.
 *
 * `private` perche' passa da un proxy condiviso e non e' contenuto pubblico.
 * Un'ora: abbastanza da non ripetere cinquanta richieste a ogni ricarica del
 * registro, abbastanza poco da vedere una skin cambiata in giornata.
 */
const BROWSER_CACHE = 'private, max-age=3600';

export function registerAvatarRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Il suffisso `.png` e' nel percorso e non e' decorazione: rende la URL
  // un'immagine anche per chi la salva o la apre da sola.
  app.get<{ Params: { name: string } }>(
    '/api/avatars/:name.png',
    { preHandler: [requireAuth(ctx)] },
    async (request, reply) => {
      const { name } = request.params;

      // Il controllo sul nome sta qui e anche dentro il client. Non e' una
      // ripetizione inutile: qui evita di svegliare Redis e la rete per una
      // riga del registro con attore `anonimo`, li' e' la garanzia che vale
      // anche se un domani qualcuno chiamasse il client da un altro punto.
      if (!isMinecraftUsername(name)) {
        return reply.code(404).send({ error: 'AVATAR_NON_DISPONIBILE' });
      }

      const result = await ctx.skins.skin(name);

      if (result.status !== 'found') {
        if (result.status === 'unavailable') {
          request.log.warn({ reason: result.reason }, 'skin Minecraft non recuperabile');
        }
        // Anche il guasto risponde 404, non 502: per il browser questa e'
        // un'immagine che non c'e', e il pannello disegna le iniziali. Un 502
        // riempirebbe la console di errori rossi per una faccia mancante.
        return reply
          .code(404)
          .header('cache-control', 'no-store')
          .send({ error: 'AVATAR_NON_DISPONIBILE' });
      }

      return reply
        .header('content-type', 'image/png')
        .header('cache-control', BROWSER_CACHE)
        // La skin arriva da fuori: nessun browser deve provare a indovinare
        // che cosa sia oltre a quello che dichiariamo.
        .header('x-content-type-options', 'nosniff')
        .send(result.bytes);
    },
  );
}
