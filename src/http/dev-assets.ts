// Servizio degli asset per lo SVILUPPO LOCALE. §2
//
// In produzione `/assets/*` lo serve nginx e questa rotta non esiste: la
// registrazione è gated su NODE_ENV !== 'production'. Serve solo perché su
// una macchina di sviluppo, senza nginx davanti, il pannello caricherebbe una
// pagina bianca.
//
// Non si usa `@fastify/static`. Il motivo del divieto (§2) è che tre advisory
// del 2026 su quel pacchetto sono bypass di guardie via path non canonici, e
// il modo di non averli è non avere path traversal affatto: qui il nome del
// file è validato contro `^[A-Za-z0-9._-]+$` PRIMA di toccare il filesystem,
// quindi non esiste un input che possa contenere `..`, `/`, `\`, `%2e%2e` o
// un byte nullo. Nessun `join` con dati del client, nessuna risoluzione di
// symlink, nessuna negoziazione di contenuto.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

const ASSETS_DIR = fileURLToPath(new URL('../../dist/assets/', import.meta.url));

/** Un nome di file, non un percorso. Tutto il resto è 404. */
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

export function registerDevAssets(app: FastifyInstance): void {
  const cache = new Map<string, Buffer>();

  app.get('/assets/:name', async (request, reply) => {
    const { name } = request.params as { name: string };

    if (!SAFE_NAME.test(name)) {
      request.log.warn({ name }, 'nome di asset non canonico rifiutato');
      return reply.code(404).send({ error: 'not_found' });
    }

    const dot = name.lastIndexOf('.');
    const type = dot > 0 ? CONTENT_TYPES[name.slice(dot)] : undefined;
    if (!type) return reply.code(404).send({ error: 'not_found' });

    let body = cache.get(name);
    if (!body) {
      try {
        // `join` con un nome gia' validato: non c'e' input che possa uscire
        // dalla cartella.
        body = readFileSync(join(ASSETS_DIR, name));
        cache.set(name, body);
      } catch {
        return reply.code(404).send({ error: 'not_found' });
      }
    }

    reply.header('Content-Type', type);
    // In sviluppo NON si cacha: il file cambia a ogni build. In produzione
    // nginx mette `immutable`, ed è sicuro perché il nome contiene l'hash.
    reply.header('Cache-Control', 'no-store');
    return reply.send(body);
  });
}
