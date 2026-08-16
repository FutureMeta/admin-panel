# §17.6 — immagine di produzione.
#
# Base `-slim`, che è Debian con glibc: NON Alpine. @node-rs/argon2 pubblica
# prebuild per `linux-x64-gnu` e `linux-arm64-gnu` (verificato dallo SPIKE-4);
# su musl il modulo verrebbe compilato al volo o non caricherebbe affatto, e
# l'hashing delle password è l'ultima cosa che si vuole scoprire rotta al
# primo login in produzione.
#
# Tag di patch ESPLICITO: mai `24`, mai `lts`. Un tag mobile rende
# irriproducibile un'immagine che regge l'autenticazione di tutto lo staff.

# ---------------------------------------------------------------------------
# 1. Dipendenze di build (incluse le dev: servono a Vite e a tsc)
# ---------------------------------------------------------------------------
FROM node:24.19.0-slim AS deps
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.22.0 --activate

COPY package.json pnpm-lock.yaml .npmrc ./
# --ignore-scripts: nessun pacchetto esegue codice durante l'installazione.
# I prebuild nativi arrivano come optionalDependencies, non da uno script.
RUN pnpm install --frozen-lockfile --ignore-scripts

# ---------------------------------------------------------------------------
# 2. Build del frontend
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY . .
RUN pnpm run build:web
# Il segnaposto del nonce DEVE sopravvivere al build: senza, la CSP con nonce
# non ha effetto e la pagina resta bianca. Meglio scoprirlo qui che in
# produzione, ed è anche cio' che prepareIndexHtml() verifica all'avvio.
# Il controllo e' sul TAG, non sulla presenza della stringa nel file: Vite
# riscrive i tag che emette, e un attributo scritto a mano in index.html va
# perso. Cercare solo '__CSP_NONCE__' passerebbe anche se il segnaposto fosse
# rimasto in un commento — e la pagina resterebbe bianca con strict-dynamic.
RUN grep -qE '<script[^>]*nonce="__CSP_NONCE__"' dist/index.html

# ---------------------------------------------------------------------------
# 3. Dipendenze di sola produzione
# ---------------------------------------------------------------------------
FROM node:24.19.0-slim AS prod-deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.22.0 --activate
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# ---------------------------------------------------------------------------
# 4. Runtime
# ---------------------------------------------------------------------------
FROM node:24.19.0-slim AS runtime
WORKDIR /app

# Utente non-root. L'immagine node lo fornisce già: non se ne crea un altro.
USER node

ENV NODE_ENV=production
# §5.1 — mai il default 4. Il threadpool è condiviso da Argon2, fs, dns e
# zlib, ed è la risorsa più contesa del sistema. Il valore va allineato ai
# core reali del VPS: si sovrascrive al deploy.
ENV UV_THREADPOOL_SIZE=8

COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node migrations ./migrations

EXPOSE 3000

# La sonda di liveness non tocca né il database né il threadpool: risponde
# anche mentre il processo drena, ed è esattamente cio' che serve perché
# l'orchestratore non uccida un processo che sta ancora servendo richieste.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Nessun build step per il server: Node 24 esegue TypeScript con il type
# stripping nativo. `tsc` fa solo il controllo dei tipi, in CI.
CMD ["node", "src/server/main.ts"]
