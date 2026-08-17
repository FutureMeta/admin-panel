// Servizio dei file statici prodotti dal build: `/assets/*` e `/fonts/*`. §2
//
// Registrata SEMPRE, anche in produzione.
//
// Prima era attiva solo fuori produzione, perche' il disegno dava per scontato
// nginx davanti al processo. Ma quell'assunzione non e' una regola di
// sicurezza: e' una topologia. In un contenitore esposto dietro un tunnel o un
// proxy che inoltra tutto, nginx non c'e', e il risultato era una pagina
// bianca senza un errore da nessuna parte — il browser scaricava index.html,
// chiedeva il JavaScript e prendeva 404.
//
// Quando nginx c'e' davvero, questa rotta non viene mai raggiunta: i due
// `location` di deploy/nginx.conf intercettano quei percorsi prima. Averla non
// costa nulla e toglie di mezzo un modo di rompersi in silenzio.
//
// Non si usa `@fastify/static`. Il motivo del divieto (§2) e' che tre advisory
// del 2026 su quel pacchetto sono bypass di guardie via path non canonici, e
// il modo di non averli e' non avere path traversal affatto: qui il nome del
// file e' validato contro `^[A-Za-z0-9._-]+$` PRIMA di toccare il filesystem,
// quindi non esiste un input che possa contenere `..`, `/`, `\`, `%2e%2e` o
// un byte nullo. Nessun `join` con dati del client, nessuna risoluzione di
// symlink, nessuna negoziazione di contenuto.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

const DIST = new URL('../../dist/', import.meta.url);

/**
 * Le sole cartelle servibili. La chiave e' anche il prefisso della rotta.
 *
 * `immutable` vale solo dove il nome porta l'hash del contenuto: `/assets/`
 * lo ha (lo impone vite.config.ts), `/fonts/` no — quei nomi cambiano solo se
 * cambia il prototipo, quindi una settimana e nessuna promessa di eternita'.
 */
const DIRS: Record<string, { path: string; maxAge: number; immutable: boolean }> = {
  assets: { path: fileURLToPath(new URL('assets/', DIST)), maxAge: 31_536_000, immutable: true },
  fonts: { path: fileURLToPath(new URL('fonts/', DIST)), maxAge: 604_800, immutable: false },
};

/** Un nome di file, non un percorso. Tutto il resto e' 404. */
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

export function registerStaticAssets(app: FastifyInstance, production: boolean): void {
  const cache = new Map<string, Buffer>();

  for (const [prefix, dir] of Object.entries(DIRS)) {
    app.get(`/${prefix}/:name`, async (request, reply) => {
      const { name } = request.params as { name: string };

      if (!SAFE_NAME.test(name)) {
        request.log.warn({ name }, 'nome di asset non canonico rifiutato');
        return reply.code(404).send({ error: 'not_found' });
      }

      const dot = name.lastIndexOf('.');
      const type = dot > 0 ? CONTENT_TYPES[name.slice(dot)] : undefined;
      if (!type) return reply.code(404).send({ error: 'not_found' });

      const key = `${prefix}/${name}`;
      let body = cache.get(key);
      if (!body) {
        try {
          // `join` con un nome gia' validato: non c'e' input che possa uscire
          // dalla cartella.
          body = readFileSync(join(dir.path, name));
          cache.set(key, body);
        } catch {
          return reply.code(404).send({ error: 'not_found' });
        }
      }

      reply.header('Content-Type', type);
      // In sviluppo NON si cacha: il file cambia a ogni build e il nome no,
      // finche' si lavora con `vite dev`.
      reply.header(
        'Cache-Control',
        production ? `public, max-age=${dir.maxAge}${dir.immutable ? ', immutable' : ''}` : 'no-store',
      );
      reply.header('X-Content-Type-Options', 'nosniff');
      return reply.send(body);
    });
  }
}
