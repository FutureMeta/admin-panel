# DOCUMENTO DI DECISIONE TECNICA — MetaMC Admin Panel, FASE 1
**Perimetro: inviti + login + 2FA + sessioni + RBAC + audit log. Data: 16 agosto 2026.**
Questo documento è normativo. Dove dice "obbligatorio" non è negoziabile in fase 1. Dove dice "predisporre" significa creare la struttura senza scriverne l'implementazione.

---

## 0. Decisioni che cambiano rispetto alla ricerca originale

Le tre revisioni hanno smontato punti centrali. Qui il verdetto finale, con la ragione in una riga.

| # | Ricerca originale | Decisione finale | Ragione |
|---|---|---|---|
| 1 | ioredis 6.0.0 | **ioredis 5.11.1** | `@better-auth/redis-storage@1.6.29` dichiara peer `ioredis ^5.0.0`; l'instrumentation OTel dichiara `>=2.0.0 <6` e con la 6 non emette span silenziosamente. |
| 2 | secondaryStorage Redis "quindi revoca immediata" | **secondaryStorage + `storeSessionInDatabase: true` + chiave `authz:{userId}` separata letta a ogni richiesta** | Con secondary storage il blob di sessione contiene uno snapshot dell'utente: ban e declassamento NON si propagano. L'autorizzazione non deve mai leggere `session.user`. |
| 3 | Plugin `admin` di better-auth per RBAC + ban + impersonation | **Plugin `admin` NON registrato.** RBAC, ban, revoca sessioni altrui implementati sulle nostre tabelle | Elimina in un colpo: impersonation (path di takeover), doppia fonte di verità sui permessi, il ruolo `admin` con controllo totale di default, e la classe GHSA-2vg6 (sessioni stale dopo delete). |
| 4 | createAccessControl (codice) + tabelle Postgres (DB) | **Solo tabelle Postgres.** Un unico helper `can()` | Due modelli coesistenti divergono alla prima modifica fatta da una parte sola. |
| 5 | BentoCache L1+L2+bus | **Nessuna libreria di cache in fase 1** | 1 solo processo, nessun dato da cachare oltre sessione e authz (già in Valkey). BentoCache: 0 release in 6 mesi, peer `kysely ^0.27.3` incompatibile con 0.29.5, peer `ioredis ^5.3.2`. |
| 6 | Argon2id m=65536 t=3 | **m=19456, t=2, p=1 (floor OWASP) + pepper + semaforo di concorrenza** | 64 MiB × N login concorrenti su threadpool libuv da 4 thread è un DoS a costo zero; il moltiplicatore di sicurezza qui è il 2FA obbligatorio, non la memoria per hash. |
| 7 | Zod al confine HTTP | **JSON Schema + AJV al confine HTTP**; Zod solo per env e webhook | Fastify valida già con AJV e lo stesso schema alimenta la serializzazione; doppia validazione = doppia fonte di verità. |
| 8 | Tre rate limiter (rate-limiter-flexible + @fastify/rate-limit + interno better-auth) | **Solo rate-limiter-flexible**, `rateLimit.enabled=false` su better-auth | Tre punti di fail-open indipendenti su un endpoint che è la prima barriera davanti ad Argon2. |
| 9 | Backup codes del plugin (`encrypted`) | **Recovery code custom: 128 bit, SHA-256 one-way, tabella dedicata.** Endpoint backup-code del plugin bloccati a livello di rotta | `encrypted` è reversibile: dump DB + segreto = bypass 2FA di tutto lo staff. 10 caratteri sono sotto i 112 bit di NIST §3.1.2.2. |
| 10 | "SPA statica su nginx/CDN, nessun processo Node" vs "index.html da Node per il nonce CSP" | **nginx serve solo `/assets/*` con hash; `index.html` è una rotta Fastify dinamica** | Le due dimensioni si contraddicevano. Il processo Node serve comunque API, SSE (fase 2) e readiness. |
| 11 | @fastify/csrf-protection come "synchronizer token" | **Signed double-submit fatto in casa: `HMAC(k_csrf, session.id)`** | Senza `@fastify/session` (che non usiamo) il plugin degrada al double-submit naive, esplicitamente sconsigliato da OWASP e bypassabile da un sottodominio che scrive cookie. |
| 12 | @tanstack/react-table 9.1.2 | **@tanstack/react-table 8.x** (versione esatta da risolvere) | La linea 9 ha sei settimane; 107 delle 108 release dell'ultimo anno sono degli ultimi 6 mesi. Nessun beneficio per una tabella headless a colonne fisse. |
| 13 | BRIN su `occurred_at` per l'audit log | **B-tree `(occurred_at DESC, id DESC)` + keyset** | La query principale è `ORDER BY occurred_at DESC LIMIT 50`: BRIN non ordina, quindi bitmap scan + sort che cresce con lo storico. BRIN resta corretto per `stats.*` (fase 2). |
| 14 | audit_log non partizionato | **Partizionamento RANGE mensile dal giorno uno** | È l'unica tabella che cresce senza limite e che non si può potare con DELETE (catena hash). Retention = DETACH/DROP di partizione. |
| 15 | Valkey 9.1.1 "chiude CVE-2026-56684/63639" | **Valkey 9.0.5, una sola istanza** | I due CVE citati non esistono al MITRE (404). Caduta la ragione di sicurezza, si sceglie il branch maturo. Una sola istanza perché in fase 1 non c'è cache, solo sessioni e contatori. |
| 16 | Passkey obbligatoria per owner/admin/dev in fase 1 | **Fase 1.5** (tabella creata ora, vuota) | Scope creep su cinque sottosistemi già in consegna. Deviazione da AAL2 phishing-resistant documentata con data di rientro. |
| 17 | otpauth + plugin twoFactor entrambi | **Solo plugin `twoFactor`** + guardia anti-replay nostra (con spike bloccante di verifica) | Due implementazioni dello stesso fattore = due fonti di verità su lockout, replay e recovery. |
| 18 | Benchmark "Fastify 59.603 vs Hono 52.586, +13%" | **Fastify confermato, motivazione riscritta** | Il numero reale di Hono è 57.977 (+2,8%, non +13%) e Fastify è 7° in classifica. A 10-50 utenti il picco è 10-50 req/s: il benchmark è irrilevante. Si tiene Fastify per ecosistema first-party e JSON Schema condiviso validazione/serializzazione. |
| 19 | @react-email/components | **`@react-email/render` in prod, `react-email` solo in devDependencies** | `@react-email/components` è deprecato su npm; il pacchetto unificato ha 22 dipendenze runtime nel percorso critico degli inviti. |
| 20 | Client HIBP scritto a mano | **`better-auth/plugins/haveibeenpwned`** (verificare `Add-Padding` nello spike) | È già dentro il tarball che stiamo installando. |

---

## 1. Presupposti da confermare PRIMA della prima riga di codice

Sono decisioni del committente o dell'infrastruttura. Senza risposta, parti del documento restano indeterminate.

1. **Hosting e immagine container.** Serve: PostgreSQL 18.6 (non 18.x generico), Valkey/Redis raggiungibile in rete locale, immagine Node `-slim` glibc (NON Alpine/musl, per i prebuild di `@node-rs/argon2`). Se è un managed Postgres, verificare che offra già 18.6.
2. **Numero di istanze applicative.** Decisione presa in questo documento: **una sola istanza, nessun `cluster`**. Da questa dipendono cache, lock distribuiti, bus di invalidazione e coerenza L1. Soglia di revisione: si passa a 2+ istanze solo dopo un test di carico che dimostri la saturazione di una.
3. **Numero minimo di owner: due.** Policy non negoziabile, altrimenti la procedura di reset 2FA a quattro occhi e il break-glass non esistono.
4. **Dominio di invio email**: sottodominio dedicato (`mail.metamc.it`), mai l'apex. Serve MX + SPF + DKIM (`resend._domainkey`) + DMARC `p=none` iniziale.
5. **Baseline del pannello legacy** (serve per la fase 2, non per la fase 1, ma va chiesto ora): `EXPLAIN (ANALYZE, BUFFERS)` delle 5-10 query più lente, p50/p95 per schermata, conteggi reali per tabella, frequenza reale degli snapshot, numero di modalità di gioco.
6. **Sottodomini di `metamc.it` gestiti da terzi** (sito, forum, webmap): elencarli. Determinano la severità del rischio CSRF/cookie-injection ed è la ragione per cui SameSite da solo non basta.

---

## 2. Architettura di deploy (fase 1)

```
Internet
  └─ nginx (TLS, HSTS)
       ├─ /assets/*        → file statici con hash nel nome, Cache-Control: public, immutable, max-age=31536000
       ├─ /api/*           → proxy_pass Node
       ├─ /                → proxy_pass Node (index.html generato con nonce CSP, Cache-Control: no-store)
       └─ /webhooks/resend → proxy_pass Node, raw body preservato
Node (1 processo, Fastify) ── pg.Pool (max 6) ──► PostgreSQL 18.6
                           └─ ioredis        ──► Valkey 9.0.5 (1 istanza, noeviction + AOF)
```

Regole nginx obbligatorie:
- `proxy_set_header X-Forwarded-For $remote_addr;` — **sovrascrittura, non append**
- `proxy_set_header X-Real-IP $remote_addr;`
- Rifiuto a monte di URL contenenti `..`, `%2e%2e`, `%2f`, backslash
- `client_max_body_size 64k` sulle rotte `/api/auth/*`
- (predisposto per fase 2) `proxy_buffering off; proxy_read_timeout 300s;` sulla futura rotta SSE

Node: `trustProxy` configurato con il **CIDR esatto del proxy**, mai `true`.

Niente `@fastify/static`: tre advisory 2026 sono bypass di guardie via path non canonici (CVE-2026-15074, CVE-2026-6414, GHSA-8pvw-jcv7-9cmj). Gli asset li serve nginx.

---

## 3. Stack fase 1

Legenda stato: **[V]** = versione verificata contro fonte primaria (registry npm / nodejs.org / postgresql.org) durante la revisione adversariale del 16-08-2026. **[R]** = versione proveniente dalla sola ricerca, **da risolvere e verificare al momento dell'installazione** (`pnpm view <pkg> version`). Tutte le versioni vanno pinnate **esatte** (niente `^`, niente `~`).

### 3.1 Runtime e toolchain

| Pacchetto / componente | Versione | Stato | Ruolo | Motivazione |
|---|---|---|---|---|
| Node.js | `24.19.0` | [V] | Runtime | Unica linea Active LTS ad agosto 2026; entra in Maintenance il 2026-10-20 → matrice CI su 24 e 26 dal primo commit. |
| pnpm | `11.22.0` | [V] | Package manager | `packageManager` in package.json + Corepack. pnpm 12 è in RC: non adottare. |
| typescript | `7.0.2` | [V] | Type check (`tsc --noEmit`) | Solo type checking: la trasformazione la fa il type stripping nativo di Node. TS 7 non ha API programmatica, quindi niente typescript-eslint (usiamo Biome). |
| @biomejs/biome | `2.5.8` | [V] | Lint + format | Un binario, una config. Affiancare `tsc --noEmit` strict perché la copertura type-aware non è ancora pari a typescript-eslint. |
| vitest | `4.1.10` | [V] | Test runner | Peer `vite ^6\|\|^7\|\|^8`, compatibile con vite 8.2.1. |
| json-schema-to-ts | — | [R] | Tipi TS derivati dai JSON Schema (devDep, zero runtime) | Una definizione sola per validazione, serializzazione e tipi. |

Configurazione obbligatoria: `"type": "module"`, `erasableSyntaxOnly: true` in tsconfig, subpath imports `#*` in package.json al posto dei path alias (il type stripping ignora completamente tsconfig.json), `import type` per ogni import di soli tipi, estensioni `.ts` esplicite. Nessun build step server, nessun bundling.

### 3.2 HTTP e sicurezza di trasporto

| Pacchetto | Versione | Stato | Ruolo | Motivazione |
|---|---|---|---|---|
| fastify | `5.12.0` | [V] | Framework HTTP | Floor duro **>= 5.8.5** (CVE-2026-33806: bypass della validazione dello schema del body con uno spazio davanti al Content-Type). Non adottare la 6 (alpha). |
| @fastify/helmet | `13.1.0` | [V] | Header di sicurezza | La CSP di default va **sovrascritta**: usa `script-src 'self'`, non nonce + strict-dynamic. |
| @fastify/cookie | — | [R] | Lettura/scrittura cookie | Necessario per il cookie CSRF; better-auth gestisce il proprio. |
| @fastify/under-pressure | `9.1.0` | [R] | 503 su pressione | Utile ma **cieco sul threadpool libuv**: va affiancato dalla metrica applicativa degli hash in volo. |

**Non installati e perché**: `@fastify/static` (bypass di guardie via path), `@fastify/csrf-protection` (degrada a double-submit naive senza uno store di sessione Fastify), `@fastify/rate-limit` (duplicherebbe rate-limiter-flexible).

### 3.3 Autenticazione

| Pacchetto | Versione | Stato | Ruolo | Motivazione |
|---|---|---|---|---|
| better-auth | `1.6.29` | [V] | Core auth: password, sessioni opache, cookie, 2FA challenge | Floor duro **>= 1.6.11** (GHSA-2vg6-77g8-24mp, CVE-2026-53513, CVE-2026-67336). Plugin registrati: **solo** `two-factor` e `haveibeenpwned`. |
| @better-auth/redis-storage | `1.6.29` | [V] | `secondaryStorage` | Versionato in lockstep con il core; peer `ioredis ^5.0.0`. |
| @node-rs/argon2 | `2.1.0` | [V] | Hashing password (override di `emailAndPassword.password.hash/verify`) | Espone il parametro `secret` (pepper) e restituisce PHC string con `needsRehash`. **Fallback: `2.0.2`** se i prebuild per la coppia arch+libc di produzione non esistono (la 2.1.0 ha 3 giorni dopo 20 mesi di fermo). Alternativa documentata: `crypto.argon2` nativo di Node 24.19.0 (elimina il binario ma costa ~40 righe di serializzazione PHC e confronto timingSafeEqual scritte a mano). |
| rate-limiter-flexible | `11.2.0` | [V] | Unico rate limiter, su Valkey | `RateLimiterUnion` per comporre IP AND account AND rotta; `insuranceLimiter` obbligatorio. |
| otpauth | `9.5.1` | [V] | **NON installato**, solo piano B se lo spike 2FA fallisce | Vedi §15. |

### 3.4 Dati

| Pacchetto / componente | Versione | Stato | Ruolo | Motivazione |
|---|---|---|---|---|
| PostgreSQL | `18.6` | [V] | Unico datastore persistente | Floor duro: le 18.x precedenti hanno 28 CVE (2026-08-13), diverse RCE con CVSS 8.8. `uuidv7()` nativo, skip scan su B-tree multicolonna. |
| kysely | `0.29.5` | [V] | Query builder tipizzato | Floor duro (4 CVE 2026 nella compilazione dei JSON path, l'ultima **tocca anche PostgreSQL** `->$`/`->>$`). È già nell'albero: `@better-auth/core` dichiara peer `kysely ^0.28.5 \|\| ^0.29.0`. |
| pg | `8.23.0` | [V] | Driver + pool | Hook `onConnect` (8.20+) per impostare i timeout di sessione. |
| @types/pg | `8.21.0` | [R] | Tipi | — |
| ioredis | `5.11.1` | [V] | Client Valkey | **Non 6.0.0**: fuori dai peer di redis-storage e dell'instrumentation OTel, e attiva RESP3 di default. |
| Valkey | `9.0.5` | [V] | Sessioni, rate limit, chiave authz, guardia anti-replay TOTP | Branch maturo. Una sola istanza, `maxmemory-policy noeviction`, AOF attivo. |

Migrazioni: **Migrator integrato di Kysely** + uno script `scripts/migrate.ts` nostro. Niente `kysely-ctl`, niente `node-pg-migrate`: una dipendenza in meno. Interfaccia `DB` **scritta a mano** (14 tabelle) — niente `kysely-codegen`.

CLI di generazione schema better-auth: `pnpm dlx auth@1.6.29 generate` con versione **esplicita** (`@better-auth/cli` è bloccato alla 1.4.21 e pinna internamente better-auth 1.4.21). Mai `auth@latest` in CI.

### 3.5 Email

| Pacchetto | Versione | Stato | Ruolo | Motivazione |
|---|---|---|---|---|
| resend | `6.20.0` | [V] | Invio transazionale | Idempotency-Key nativa + `resend.webhooks.verify` integrata (niente `svix` separato). 14 maintainer: il pacchetto più "aziendale" dello stack. |
| @react-email/render | `2.1.0` | [V] | Rendering dei template (prod) | 4 dipendenze contro le 22 del pacchetto unificato. |
| react-email | `6.9.2` | [V] | **devDependency**, solo preview server | `@react-email/components` è deprecato su npm: non importare da lì. |

### 3.6 Osservabilità e validazione

| Pacchetto | Versione | Stato | Ruolo | Motivazione |
|---|---|---|---|---|
| pino | `10.3.1` | [V] | Logging strutturato | Già dipendenza di fastify (`^9.14.0 \|\| ^10.1.0`) → deduplicato. `redact` configurato prima della prima riga di log. |
| pino-http | `11.0.0` | [R] | Log di richiesta | Serializer custom obbligatorio: di default logga l'intero oggetto request. |
| zod | `4.4.3` | [V] | Validazione env al boot e payload webhook dopo la verifica firma | **Non** al confine HTTP. |

**OpenTelemetry: non installato in fase 1.** Motivo: il signal logs è ancora Development, i pacchetti sono 0.x con breaking change a ogni minor, e l'instrumentation ioredis produrrebbe uno span per comando su un sistema da poche decine di req/s. Fase 2, con sampling parent-based al 10% e override always-on sulle rotte statistiche e di login.

### 3.7 Frontend fase 1

| Pacchetto | Versione | Stato | Ruolo |
|---|---|---|---|
| vite | `8.2.1` | [V] | Build (minifier Oxc: **non** impostare `build.minify: 'esbuild'`, fallisce) |
| react / react-dom | `19.2.8` | [V] | UI |
| @tanstack/react-router | `1.170.29` | [V] | Routing type-safe, search params tipizzati |
| @tanstack/react-query | `5.101.4` | [V] | Stato server |
| @tanstack/react-table | `8.x` | [R] | **Non la 9.** Versione 8 più recente da risolvere all'installazione |
| tailwindcss | `4.3.3` | [V] | Stile |
| @radix-ui/react-dialog + dropdown-menu + tooltip | `1.1.x` | [R] | Primitive accessibili. Restare sulle stable 1.1.x, non 1.2.0-rc |

**Non in fase 1**: uPlot, ECharts, d3-geo, topojson, world-atlas, react-compiler, SSE. Vedi §16.

**Rimosso dopo la decisione iniziale**: `@tanstack/react-virtual` (`3.14.9`).
Era li' per la tabella dell'audit, che era uno scorrimento infinito: dopo
qualche «carica altre 50» erano centinaia di righe con i pannelli del diff
dentro. Su richiesta del committente la tabella e' passata a pagine da 50, e a
quel punto la virtualizzazione costava piu' di quanto rendesse — le righe
espandibili vanno rimisurate a mano, e stampa e `Ctrl+F` del browser vedono
solo cio' che e' renderizzato. La soglia oltre la quale conviene sono le
migliaia di righe a schermo. Se torna lo scorrimento infinito, torna anche
lei.

---

## 4. Cosa NON si installa in fase 1, e la soglia di rientro

| Componente | Soglia di rientro |
|---|---|
| bentocache / qualsiasi libreria di cache | Quando esiste un payload da cachare (fase 2) **e** un profilo che mostra il costo. Anche allora: prima ~120 righe su `lru-cache` + `ioredis`, non una libreria dormiente. |
| @opentelemetry/* | Fase 2, insieme ai primi endpoint statistici. |
| msgpackr | Solo se un profilo mostra la serializzazione sopra il 10% del tempo di risposta. |
| TimescaleDB / pg_cron | Oltre 10^8 righe/anno, o quando il refresh dei rollup manuali supera i 30 s. |
| PgBouncer | Solo con più di una istanza applicativa. Minimo 1.25.2. |
| Seconda istanza Valkey (`allkeys-lru`) | Quando nasce la cache di fase 2. Mai far coabitare sessioni e cache con LRU. |
| @simplewebauthn/server + /browser | Fase 1.5 (entro 60 giorni dal go-live). Floor `13.3.2` per il server. |
| @dotenvx/dotenvx | Se il team supera le ~8 persone con accesso ai segreti. Fase 1: `--env-file` in dev, env injection dalla piattaforma in prod. |
| monorepo / pnpm workspaces | Quando il frontend deve condividere tipi generati dai JSON Schema. |

---

## 5. Configurazione runtime

### 5.1 Node

```
UV_THREADPOOL_SIZE=<numero_core_reali>   # mai il default 4
NODE_OPTIONS="--max-old-space-size=<calcolato>"
```

Il threadpool libuv (4 thread di default) è condiviso da: Argon2, `fs`, `dns.lookup`, `zlib`. È la risorsa più contesa dell'intero sistema e nessuna metrica standard la osserva.

**Semaforo Argon2 obbligatorio**: un contatore applicativo limita gli hash in volo a `UV_THREADPOOL_SIZE - 2`. Le richieste eccedenti ricevono `503` con `Retry-After`. Il semaforo si applica **anche al percorso hash-esca** (utente inesistente), altrimenti si ricrea l'oracolo di timing.

RAM di picco da calcolare sul caso ostile: `(hash_concorrenti × 19 MiB) + heap + connessioni pg`. Con m=19456 e 6 hash concorrenti sono ~114 MiB di solo Argon2.

`index.html` con nonce: tenuto in memoria come **coppia di stringhe pre-splittate caricate all'avvio**, mai riletto da disco per richiesta (`fs` = threadpool).

### 5.2 Argon2id

```
memoryCost: 19456   // KiB, floor OWASP
timeCost:   2
parallelism:1
outputLen:  32
secret:     <pepper 32 byte da HKDF(MASTER_KEY, info="argon2-pepper-v1")>
```

Deviazione da RFC 9106 SECOND RECOMMENDED (m=65536) documentata: il moltiplicatore di sicurezza in questo sistema è il 2FA obbligatorio più il rate limiting, e m=65536 su threadpool condiviso è un vettore di DoS. **Misurare il costo reale di un hash sul VPS di produzione prima del go-live** (i 49 ms citati nella ricerca sono su Apple M5 Max; su x86 attendersi 3-6x). Target: singolo hash sotto 100 ms, login p95 sotto 400 ms.

Hash-esca: precomputato all'avvio con **esattamente gli stessi parametri**, verificato a ogni login su email inesistente.

### 5.3 pg.Pool

```js
{ max: 6, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000,
  application_name: 'metamc-admin' }
// hook onConnect:
SET statement_timeout = '2s';
SET idle_in_transaction_session_timeout = '10s';
SET lock_timeout = '2s';
```

Un solo pool in fase 1. Il pool è **iniettato** ovunque, mai importato come singleton globale: in fase 2 si aggiunge `statsPool` (max 8-10, `statement_timeout 10s`, ruolo Postgres di sola lettura) senza toccare il codice di fase 1.

### 5.4 Valkey

```
maxmemory-policy noeviction
appendonly yes
requirepass <da secret manager>
```

Client ioredis: `enableAutoPipelining: true` (fonde nella stessa pipeline tutti i comandi emessi nello stesso tick dell'event loop: sessione + authz + rate limit diventano un round trip). `autoPipeliningIgnoredCommands` per `scan`. Connessione separata e **senza autopipelining** per l'eventuale pub/sub (fase 2).

---

## 6. Schema dati (fase 1, completo)

Tre schemi dal giorno uno: `auth`, `audit`, `stats` (quest'ultimo creato vuoto).

Convenzione: le tabelle generate da better-auth mantengono il naming della libreria (camelCase); le nostre usano snake_case. Documentare la convenzione nel README dello schema.

### 6.1 Ruoli Postgres

```sql
CREATE ROLE metamc_migrate LOGIN PASSWORD '...';   -- possiede il DDL
CREATE ROLE metamc_app     LOGIN PASSWORD '...';   -- runtime applicativo
-- fase 2: CREATE ROLE metamc_stats_ro LOGIN ...;
```

`metamc_app` NON ha DDL. Sull'audit log ha **solo INSERT e SELECT**.

### 6.2 Tabelle better-auth (generate, poi estese)

`auth."user"` — generata da better-auth, estesa con `additionalFields`:

| Colonna | Tipo | Note |
|---|---|---|
| id | text PK | id better-auth (32 char da Web Crypto) |
| name, email, emailVerified, image, createdAt, updatedAt | — | core |
| status | text NOT NULL DEFAULT 'pending_onboarding' | CHECK IN ('pending_onboarding','active','disabled') |
| permissions_version | integer NOT NULL DEFAULT 1 | |
| sessions_valid_from | timestamptz NOT NULL DEFAULT now() | logout globale = `UPDATE ... SET sessions_valid_from = now()` |
| banned | boolean NOT NULL DEFAULT false | |
| ban_reason | text | |
| ban_expires | timestamptz | |
| pepper_version | smallint NOT NULL DEFAULT 1 | rotazione pepper senza reset globale |
| password_updated_at | timestamptz | |
| last_totp_step | bigint NOT NULL DEFAULT 0 | fonte di verità durevole anti-replay |
| invited_by | text REFERENCES auth."user"(id) | |
| invite_id | uuid | |

```sql
CREATE UNIQUE INDEX user_email_lower_idx ON auth."user" (lower(email));
```

`auth."account"` — core better-auth, contiene `password` (PHC string).
`auth."session"` — core, esteso con:

| Colonna | Tipo | Note |
|---|---|---|
| absolute_expires_at | timestamptz NOT NULL | tetto assoluto 8h, mai prorogato |
| authenticated_at | timestamptz NOT NULL | per lo step-up |
| aal | smallint NOT NULL DEFAULT 1 | 1 = solo password, 2 = 2FA completato |
| amr | text[] NOT NULL DEFAULT '{}' | es. `{pwd,totp}` |
| permissions_version | integer NOT NULL | valore visto al login |

```sql
CREATE INDEX session_user_idx     ON auth."session"("userId");
CREATE INDEX session_expires_idx  ON auth."session"("expiresAt");
```

`auth."verification"` — core.
`auth."twoFactor"` — plugin: `id, userId, secret (cifrato), backupCodes`. La colonna `backupCodes` viene **sovrascritta con byte casuali** subito dopo l'enrollment (vedi SEC-14).

### 6.3 RBAC

```sql
CREATE TABLE auth.modules (
  id         smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key        text NOT NULL UNIQUE,
  name       text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0
);
-- seed fase 1:
-- utenti, ruoli, inviti, sessioni, audit, impostazioni, statistiche, server

CREATE TABLE auth.roles (
  id        smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key       text NOT NULL UNIQUE,
  name      text NOT NULL,
  is_system boolean NOT NULL DEFAULT false   -- owner: non modificabile, non assegnabile via invito
);

CREATE TABLE auth.role_permissions (
  role_id   smallint NOT NULL REFERENCES auth.roles(id) ON DELETE CASCADE,
  module_id smallint NOT NULL REFERENCES auth.modules(id) ON DELETE CASCADE,
  level     smallint NOT NULL CHECK (level BETWEEN 0 AND 3),
  PRIMARY KEY (role_id, module_id)
);

CREATE TABLE auth.user_roles (
  user_id    text NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
  role_id    smallint NOT NULL REFERENCES auth.roles(id) ON DELETE RESTRICT,
  granted_by text REFERENCES auth."user"(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE auth.user_permissions (          -- override individuale, SOLO in aumento
  user_id    text NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
  module_id  smallint NOT NULL REFERENCES auth.modules(id) ON DELETE CASCADE,
  level      smallint NOT NULL CHECK (level BETWEEN 0 AND 3),
  granted_by text REFERENCES auth."user"(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, module_id)
);

CREATE VIEW auth.effective_permissions AS
SELECT u.id AS user_id, m.id AS module_id, m.key AS module_key,
       GREATEST(COALESCE(r.lvl, 0), COALESCE(up.level, 0)) AS level
FROM auth."user" u
CROSS JOIN auth.modules m
LEFT JOIN LATERAL (
  SELECT max(rp.level) AS lvl
  FROM auth.user_roles ur
  JOIN auth.role_permissions rp
    ON rp.role_id = ur.role_id AND rp.module_id = m.id
  WHERE ur.user_id = u.id
) r ON true
LEFT JOIN auth.user_permissions up
  ON up.user_id = u.id AND up.module_id = m.id;
```

Trigger di invalidazione su `user_roles`, `user_permissions`, `role_permissions`, e sulle colonne `banned`/`status` di `user`:

```sql
CREATE FUNCTION auth.fn_bump_permissions_version() RETURNS trigger ...
-- incrementa auth."user".permissions_version per gli utenti coinvolti
-- (per role_permissions: tutti gli utenti che hanno quel ruolo)
```

Dopo il COMMIT, l'applicazione aggiorna `authz:{userId}` in Valkey (vedi §9).

### 6.4 Inviti

```sql
CREATE TABLE auth.invitation (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  email_lower     text NOT NULL,
  token_hash      bytea NOT NULL UNIQUE,          -- SHA-256 del token, mai il token
  role_id         smallint NOT NULL REFERENCES auth.roles(id),
  invited_by      text NOT NULL REFERENCES auth."user"(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,           -- created_at + 12h
  consumed_at     timestamptz,
  consumed_user_id text REFERENCES auth."user"(id),
  revoked_at      timestamptz,
  revoked_by      text REFERENCES auth."user"(id),
  resend_message_id text,
  CHECK (consumed_at IS NULL OR revoked_at IS NULL)
);

CREATE UNIQUE INDEX invitation_one_pending_per_email
  ON auth.invitation (email_lower)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;
CREATE INDEX invitation_expiry_idx ON auth.invitation (expires_at)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;
```

### 6.5 Recovery code

```sql
CREATE TABLE auth.recovery_code (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    text NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
  code_hash  bytea NOT NULL,          -- SHA-256 del codice normalizzato
  generation smallint NOT NULL,       -- incrementato a ogni rigenerazione
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at    timestamptz,
  used_ip    inet,
  UNIQUE (user_id, code_hash)
);
CREATE INDEX recovery_code_open_idx ON auth.recovery_code (user_id) WHERE used_at IS NULL;
```

### 6.6 WebAuthn (creata vuota, fase 1.5)

```sql
CREATE TABLE auth.webauthn_credential (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       text NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
  credential_id bytea NOT NULL UNIQUE,
  public_key    bytea NOT NULL,
  sign_count    bigint NOT NULL DEFAULT 0,
  transports    text[],
  aaguid        uuid,
  label         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);
```

### 6.7 Audit log

```sql
CREATE TABLE audit.audit_log (
  id                 bigint GENERATED ALWAYS AS IDENTITY,
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  request_id         uuid,
  actor_user_id      text,                -- nessuna FK: la riga sopravvive alla cancellazione dell'utente
  actor_email        text,                -- DENORMALIZZATO al momento del fatto
  actor_display_name text,                -- DENORMALIZZATO
  actor_ip           inet,                -- derivato da X-Forwarded-For
  actor_socket_ip    inet,                -- socket.remoteAddress, non falsificabile
  actor_user_agent   text,
  session_id         text,
  action             text NOT NULL,       -- es. 'invite.create', 'user.role.grant'
  module_key         text,
  target_type        text,
  target_id          text,
  target_label       text,                -- DENORMALIZZATO
  outcome            text NOT NULL CHECK (outcome IN ('success','failure','denied')),
  before             jsonb,
  after              jsonb,
  meta               jsonb,
  prev_hash          bytea NOT NULL,
  hash               bytea NOT NULL,
  PRIMARY KEY (occurred_at, id)
) PARTITION BY RANGE (occurred_at);

-- partizioni mensili create in anticipo (12 mesi) da una migration + job mensile
CREATE TABLE audit.audit_log_2026_08 PARTITION OF audit.audit_log
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

CREATE INDEX ON audit.audit_log (actor_user_id, occurred_at DESC, id DESC);
CREATE INDEX ON audit.audit_log (module_key, action, occurred_at DESC, id DESC);

CREATE TABLE audit.chain_head (
  partition_key text PRIMARY KEY,     -- 'YYYYMM'
  head_hash     bytea NOT NULL,
  row_count     bigint NOT NULL DEFAULT 0,
  anchored_at   timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
```

Funzione canonica e trigger di catena:

```sql
CREATE FUNCTION audit.canonical(r audit.audit_log) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT concat_ws(U&'\001',
    to_char(r.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US'),
    coalesce(r.actor_user_id,''), coalesce(r.actor_email,''),
    coalesce(host(r.actor_ip),''), coalesce(host(r.actor_socket_ip),''),
    r.action, coalesce(r.module_key,''), coalesce(r.target_type,''),
    coalesce(r.target_id,''), r.outcome,
    coalesce(r.before::text,''), coalesce(r.after::text,''), coalesce(r.meta::text,''))
$$;

CREATE FUNCTION audit.fn_hash_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pk text := to_char(NEW.occurred_at AT TIME ZONE 'UTC','YYYYMM'); prev bytea;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('audit_chain:'||pk, 0));
  SELECT head_hash INTO prev FROM audit.chain_head WHERE partition_key = pk FOR UPDATE;
  IF prev IS NULL THEN
    SELECT head_hash INTO prev FROM audit.chain_head
      WHERE partition_key < pk ORDER BY partition_key DESC LIMIT 1;
    prev := coalesce(prev, decode(repeat('00',32),'hex'));
    INSERT INTO audit.chain_head(partition_key, head_hash) VALUES (pk, prev);
  END IF;
  NEW.prev_hash := prev;
  NEW.hash := sha256(prev || convert_to(audit.canonical(NEW),'UTF8'));
  UPDATE audit.chain_head
     SET head_hash = NEW.hash, row_count = row_count + 1, updated_at = now()
   WHERE partition_key = pk;
  RETURN NEW;
END $$;
CREATE TRIGGER t_hash_chain BEFORE INSERT ON audit.audit_log
  FOR EACH ROW EXECUTE FUNCTION audit.fn_hash_chain();

CREATE FUNCTION audit.fn_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$;
CREATE TRIGGER t_immutable BEFORE UPDATE OR DELETE ON audit.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit.fn_immutable();

REVOKE ALL   ON audit.audit_log FROM metamc_app;
GRANT INSERT, SELECT ON audit.audit_log TO metamc_app;
GRANT SELECT, INSERT, UPDATE ON audit.chain_head TO metamc_app;
```

Paginazione keyset (query principale della UI):

```sql
SELECT ... FROM audit.audit_log
WHERE (occurred_at, id) < ($1, $2)
ORDER BY occurred_at DESC, id DESC
LIMIT 50;
```

`sha256()` è built-in da PG 11: niente pgcrypto.

### 6.8 stats (fase 2, creato vuoto)

```sql
CREATE SCHEMA stats;   -- nessuna tabella in fase 1
```

---

## 7. Modello RBAC

**Livelli**: `0 = nessuno, 1 = lettura, 2 = scrittura, 3 = gestione`. `smallint` con CHECK, **non** quattro booleani, **non** un bitmask (si rompe al modulo 33 e rende l'audit illeggibile). L'ordine totale riduce ogni controllo a `level >= N` e la risoluzione multi-ruolo a `max(level)`.

**Composizione**: `effective = GREATEST(max(livelli dei ruoli), override individuale)`. L'override è **solo in aumento**: nessuna semantica di deny, quindi nessuna precedenza controintuitiva e nessun bug di sicurezza da ordine di valutazione.

**Unico punto di enforcement**: un helper

```ts
can(actor: AuthzContext, module: string, level: 1|2|3): boolean
```

alimentato **esclusivamente** dai permessi effettivi risolti in `AuthzContext`. Regola di CI: `grep` che fallisce la build se compare `session.user.role`, `hasPermission(`, o un confronto diretto su un nome di ruolo fuori dal modulo `src/authz/`.

**Dominanza attore→bersaglio.** Nessuna operazione che tocca un altro utente è autorizzata dal solo `can(actor,'utenti',3)`. Serve anche:

```sql
-- true se l'attore domina il bersaglio su OGNI modulo
SELECT NOT EXISTS (
  SELECT 1
  FROM auth.effective_permissions t
  JOIN auth.effective_permissions a
    ON a.module_id = t.module_id AND a.user_id = $actor
  WHERE t.user_id = $target AND t.level > a.level
);
```

**Concedibilità di un ruolo** (usata da invito e assegnazione ruolo):

```sql
SELECT NOT EXISTS (
  SELECT 1 FROM auth.role_permissions rp
  LEFT JOIN auth.effective_permissions a
    ON a.module_id = rp.module_id AND a.user_id = $actor
  WHERE rp.role_id = $role AND rp.level > COALESCE(a.level, 0)
);
```

Nessuno concede ciò che non ha. Il ruolo `owner` (`is_system = true`) **non è assegnabile via invito né via UI**: si concede solo con la procedura a quattro occhi (§8.8).

**Invalidazione**: `permissions_version` sulla riga utente, incrementato da trigger, replicato in `authz:{userId}` su Valkey. La sessione porta il valore visto al login; se differisce, il middleware ricalcola i permessi da Postgres (~1 ms: `role_permissions` ha ~160 righe e sta in shared_buffers) e riscrive la sessione.

---

## 8. Cicli di vita

### 8.1 Invito

1. `POST /api/invites` — richiede `can(actor,'inviti',2)`, la concedibilità del ruolo (§7), e **step-up** se il ruolo concede livello 3 su almeno un modulo.
2. Rifiuto se: esiste già un utente con quella email (`lower(email)`), esiste già un invito pendente per quella email, l'email coincide con una già collegata all'attore.
3. `token = crypto.randomBytes(32).toString('base64url')` (256 bit). In tabella va **solo** `sha256(token)`.
4. Riga `invitation` con `email_lower`, `role_id`, `invited_by`, `expires_at = now() + 12h`.
   *(Era 72h nella decisione iniziale. Ridotta a 12h su richiesta del
   committente il 2026-08-19: è un restringimento, e la finestra più corta
   riduce il tempo in cui un link finito nella casella sbagliata resta
   spendibile. Il valore vive in `INVITE_TTL_HOURS`, in un posto solo.)*
5. **INSERT nell'audit log nella stessa transazione.** COMMIT.
6. **Fuori dalla transazione**: invio Resend con `Idempotency-Key: invite:{id}:1`, click tracking **disattivato**, link `https://admin.metamc.it/accept?t=<token>`.
7. `GET /accept?t=...` — pagina servita con `Referrer-Policy: no-referrer`, `Cache-Control: no-store`. Il server valida il token e **immediatamente** fa `302` verso `/accept` senza token, avendo scambiato il token con una sessione di onboarding di 15 minuti (aal=0, nessun permesso).
8. `POST /api/invites/accept` — consumo **atomico**:

```sql
UPDATE auth.invitation
   SET consumed_at = now(), consumed_user_id = $2
 WHERE token_hash = $1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now()
RETURNING id, email_lower, role_id, invited_by;
```
Zero righe → risposta **identica** per token inesistente, scaduto, consumato o revocato.
9. Creazione utente nella stessa transazione: email **presa esclusivamente dalla riga invito**, mai dal body. `status='pending_onboarding'`, `emailVerified=true` (aver aperto il link dalla casella È la prova di controllo), `twoFactorEnabled=false`. Ruolo assegnato dalla riga invito.
10. Set password: policy §8.6. Nessuna sessione privilegiata emessa.
11. Enrollment TOTP obbligatorio (§8.3). Solo al completamento: `status='active'`, **nuova sessione con token nuovo** (la sessione di onboarding viene distrutta).
12. Recovery code mostrati **una volta sola**, subito dopo la verifica TOTP.
13. Ogni step scrive audit: `invite.create`, `invite.email_sent`, `invite.opened`, `invite.accepted`, `user.password_set`, `user.2fa_enabled`, `user.recovery_codes_generated`.

Revoca: `POST /api/invites/:id/revoke` → `revoked_at`, audit. Un invito revocato non è più consumabile (la UPDATE atomica lo esclude).

### 8.2 Sessione

- Cookie: `__Host-metamc_session`, `Path=/`, `Secure`, `HttpOnly`, `SameSite=Strict`, **nessun `Domain`**, **nessun `Partitioned`**.
- Nome impostato tramite `advanced.cookies.session_token.name` (better-auth compone `${prefix}.${name}` e la logica di prefisso confligge con `__Host-`).
- **Verifica in DevTools dopo il deploy**: se viene emesso un `Domain`, il browser scarta il cookie in silenzio e il login "non funziona a caso".
- Durata: `absolute_expires_at = now() + 8h` (mai prorogata, colonna nostra), idle 30 min applicato nel middleware su `session.updatedAt`, TTL Redis rinnovato a ogni richiesta.
- `session.cookieCache`: **disattivo**. Non attivare per nessun motivo.
- Rotazione: token nuovo a ogni autenticazione, al completamento del 2FA, al cambio password. Mai riusare la sessione di onboarding.
- Revoca per-sessione: `sessrev:{sessionId}` in Valkey con TTL pari al residuo + delete della riga in Postgres.
- Logout globale / ban: `UPDATE auth."user" SET sessions_valid_from = now()` + aggiornamento di `authz:{userId}`. Il middleware rifiuta ogni sessione con `createdAt < sessions_valid_from`. Questo meccanismo è **nostro** e non dipende dal ciclo di vita interno di better-auth.

### 8.3 2FA (TOTP)

Parametri: SHA-1, 6 cifre, period 30, **window = 1** (3 step = 90 s). Mai window 2 (150 s, sopra il limite dei 2 minuti di NIST §3.1.4.1). Deviazione da ASVS 6.5.5 documentata per iscritto nel repo, come ASVS richiede.

- `issuer: "MetaMC Admin"`.
- `skipVerificationOnEnable: false`: `twoFactorEnabled` resta false finché non arriva un codice valido. Quel flag è il gate hard di accesso al pannello.
- `trustDevice`: **disattivato per tutti**. Ricorda il device 30 giorni rinnovando la finestra a ogni login, cioè fa sparire il secondo fattore.
- OTP via email: **non abilitato**.
- Backup code del plugin: **endpoint bloccati** (§SEC-14), colonna sovrascritta con byte casuali dopo l'enrollment.
- Enrollment mai confermato: job che cancella le righe `twoFactor` di utenti `pending_onboarding` più vecchie di 24h.
- Anti-replay (§SEC-11): guardia Redis + `last_totp_step` monotono in Postgres.
- NTP configurato e monitorato sul server, allarme se lo skew supera 5 s. Con window=1 il margine è 30 s per lato.

### 8.4 Recovery code

- 10 codici, 16 byte (128 bit) da `crypto.randomBytes`, Base32 Crockford (26 caratteri, alfabeto senza I/L/O/U), mostrati in gruppi di 5.
- Storage: `sha256(normalizza(codice))`, confronto con `crypto.timingSafeEqual` sui digest (lunghezza fissa 32 byte, nessuna eccezione possibile).
- 128 bit supera la soglia dei 112 bit di NIST §3.1.2.2 e ASVS 6.5.2: **autorizza SHA-256 al posto di un password hashing scheme**, il che evita 10 esecuzioni Argon2id per tentativo (DoS applicativo banale).
- Consumo atomico: `UPDATE auth.recovery_code SET used_at = now(), used_ip = $3 WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING id`. Zero righe = già speso.
- Rate limit identico a quello del TOTP.
- Email di avviso quando ne restano meno di 3. Rigenerazione: richiede step-up, incrementa `generation`, invalida in blocco i precedenti.

### 8.5 Step-up (ri-autenticazione)

Sessione porta `authenticated_at`, `amr`, `aal`. Un'operazione sensibile richiede un'asserzione TOTP **negli ultimi 10 minuti**, altrimenti challenge esplicita.

Operazioni che richiedono step-up (elenco chiuso, da implementare come lista in codice):
emissione invito che concede livello 3 su almeno un modulo; revoca invito; modifica ruoli o permessi di chiunque; ban/unban; revoca sessioni altrui; disattivazione 2FA; rigenerazione recovery code; cambio email; cambio password; qualunque scrittura sul modulo `impostazioni`.

Lo step-up **non riusa** il token di sessione: alza `authenticated_at` e `amr` sulla riga di sessione esistente solo per le operazioni non-privilegio; per il cambio del livello di privilegio (es. promozione dell'attore stesso — vietata comunque) si emette una sessione nuova.

**Deviazione accettata e documentata**: in fase 1 lo step-up usa TOTP, che non è phishing-resistant. NIST SP 800-63B-4 §2.3.2 richiede almeno un'opzione phishing-resistant ad AAL2. Rientro: fase 1.5, passkey obbligatoria per chi ha livello 3 su almeno un modulo, entro 60 giorni dal go-live. Scritto in `docs/security/deviations.md` con la data.

### 8.6 Password

- Minimo **12** caratteri, massimo 128. Nessuna regola di composizione (NIST SHALL NOT), nessuna rotazione periodica (SHALL NOT), nessun hint, nessuna domanda segreta.
- Normalizzazione NFKC prima dell'hash.
- Controllo HIBP via `better-auth/plugins/haveibeenpwned` (k-anonymity, header `Add-Padding: true` da verificare nello spike). Timeout **2 s**, politica **fail-closed** con messaggio esplicito e voce nell'audit log. Connessione con keep-alive per evitare una `dns.lookup` (threadpool) a ogni chiamata.
- Nota: il minimo di 15 caratteri di NIST vale per le password usate come **singolo fattore**; con 2FA obbligatorio il floor normativo è 8. Scegliamo 12 come scelta di progetto, documentata.

### 8.7 Reset password (progettato per intero, era assente nella ricerca)

1. `POST /api/auth/forgot` — risposta **identica** per email esistente e inesistente. Rate limit per IP **e** per account.
2. Token 256 bit, solo `sha256` in tabella (`auth.verification` di better-auth o tabella dedicata), TTL **30 minuti**, monouso con UPDATE atomica.
3. Pagina di reset: `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, redirect immediato a URL pulito.
4. Impostata la nuova password: **nessuna sessione emessa**. L'utente deve fare login normale e superare comunque il TOTP. Il reset password non bypassa mai il secondo fattore.
5. Al completamento: revoca di **tutte** le sessioni (`sessions_valid_from = now()`), invalidazione di tutti i reset pendenti, email di notifica, audit.

### 8.8 Reset 2FA assistito e break-glass

Vietato: reset 2FA via link email (ASVS 6.3.6), domande segrete (6.4.2), reset da parte di un singolo admin.

Ordine dei rimedi:
1. Recovery code (nessun intervento umano).
2. Secondo fattore alternativo (fase 1.5, passkey).
3. Reset assistito, con **tutti** questi vincoli: approvazione di **due** owner distinti; verifica out-of-band su un canale preesistente e noto (chiamata su Discord con l'account staff conosciuto, non una email arrivata oggi); **ritardo obbligatorio di 24 ore** prima che diventi effettivo; notifica immediata a tutti gli owner all'apertura della richiesta; voce di audit con richiedente, approvatori e canale di verifica.
4. Il reset **cancella i fattori e riporta l'account in `pending_onboarding`**. Non emette mai una sessione, non produce mai un link magico.

Break-glass (tutti gli owner fuori contemporaneamente): policy di due owner con due fattori ciascuno su dispositivi diversi. Se anche questo fallisce, l'unica via è un intervento diretto sul database eseguito da chi ha le credenziali `metamc_migrate`, con annotazione manuale nell'audit log e rotazione successiva di tutti i segreti. Documentare la procedura; non implementare alcun endpoint che la automatizzi.

### 8.9 Cambio email (era assente)

Ri-autenticazione completa → email di conferma al **nuovo** indirizzo (link 24h) **e** email di notifica al **vecchio** con link di annullamento valido 72h → nessun cambio effettivo prima della conferma → revoca di tutte le sessioni al completamento → audit.

### 8.10 Offboarding (operazione unica scriptata)

`POST /api/users/:id/offboard`, richiede `can(actor,'utenti',3)` + dominanza + step-up. In **una transazione**:
1. `banned = true`, `status='disabled'`, `ban_reason`
2. `sessions_valid_from = now()` + delete di tutte le righe `session` dell'utente
3. Revoca di **tutti gli inviti pendenti emessi da quella persona** (il punto che si dimentica sempre a mano)
4. Delete di `user_roles` e `user_permissions`
5. `permissions_version + 1`
6. INSERT audit
Dopo il commit: aggiornamento di `authz:{userId}`, delete delle chiavi di sessione in Valkey, email di notifica agli owner.

---

## 9. Caching e chiavi Valkey

Nessuna libreria di cache. Nessun L1. Nessun bus di invalidazione. Un solo processo.

| Chiave | Contenuto | TTL | Note |
|---|---|---|---|
| `ba:*` | sessioni better-auth (secondaryStorage) | = `expiresIn` | `storeSessionInDatabase: true` obbligatorio |
| `authz:{userId}` | `{pv, banned, banExpires, sessionsValidFrom, status}` | nessuno (ricostruita da PG su miss) | **Non** dentro il blob di sessione |
| `rl:{scope}:{key}` | contatori rate-limiter-flexible | per scope | |
| `totp:used:{userId}:{step}` | `1` | 120 s | `SET ... NX EX 120` |
| `sessrev:{sessionId}` | `1` | residuo sessione | revoca puntuale |
| `swh:{svixId}` | `1` | 24 h | dedupe webhook Resend |

### Middleware di autorizzazione (algoritmo normativo)

```
1. leggi cookie di sessione
2. emetti nello STESSO tick: GET sessione (better-auth) + GET authz:{userId} + consumo rate limit
   -> con enableAutoPipelining diventa 1 round trip
3. se authz manca -> ricostruiscila da Postgres e riscrivila
4. rifiuta con 401 generico se:
   - sessione assente/scaduta
   - session.createdAt < authz.sessionsValidFrom
   - authz.banned && (banExpires is null || banExpires > now)
   - authz.status != 'active'
   - sessrev:{sessionId} esiste
   - session.absolute_expires_at < now
   - now - session.updatedAt > 30 min (idle)
   - session.aal < 2
5. se session.permissions_version != authz.pv:
   - ricalcola i permessi effettivi da Postgres (1 query, ~160 righe)
   - riscrivi la sessione con il nuovo pv
6. costruisci AuthzContext e passalo all'handler
```

**Regola assoluta**: `session.user` non viene mai usato per decisioni di autorizzazione. È uno snapshot.

**Nessuna risposta il cui contenuto dipende dai permessi del chiamante viene mai cachata.** Tutte le risposte JSON autenticate escono con `Cache-Control: private, no-store` e `Vary: Cookie`.

---

## 10. Audit log

Tre livelli, tutti obbligatori.

**Livello 1 — privilegi DB**: `metamc_app` ha solo `INSERT, SELECT` su `audit.audit_log`. Nemmeno una SQL injection riuscita nel percorso applicativo può cancellare la storia.

**Livello 2 — trigger**: `BEFORE UPDATE OR DELETE ... FOR EACH STATEMENT RAISE EXCEPTION`. Difende dall'errore umano (una migration sbagliata, un DELETE senza WHERE), non da un superuser.

**Livello 3 — catena hash per partizione**, con `pg_advisory_xact_lock` (transaction-scoped, quindi già compatibile con un eventuale transaction pooling futuro).

**Regola sulla transazione, non negoziabile**: l'INSERT nell'audit log è l'**ultima istruzione prima del COMMIT**, e nessuna transazione che scrive audit può contenere I/O di rete esterno (Resend, HIBP vanno fuori transazione). Altrimenti il lock della catena si serializza sulla latenza di un servizio terzo e ogni azione di ogni admin si accoda dietro un'email.

**Transazionalità per tipo di evento**:
- Eventi di sicurezza (cambio ruoli/permessi, invito creato/revocato/accettato, ban/unban, revoca sessioni, 2FA attivata/disattivata, recovery code generati/consumati, reset avviato/approvato, cambio email, cambio password): INSERT **nella stessa transazione** della modifica di stato. Mai `hooks.after`, mai `runInBackground`.
- Eventi osservativi (login riuscito, login fallito, challenge 2FA fallita, lockout): `hooks.after` di better-auth va bene.

**Ancoraggio esterno**: un job giornaliero scrive l'hash di testa di ogni partizione in uno storage append-only fuori dal database (bucket con object-lock, oppure un repository git separato con commit firmato dal job). L'email agli owner è una **notifica aggiuntiva, non il meccanismo**: un controllo che dipende dall'attenzione umana non è un controllo.

**Verifica di integrità**: endpoint `GET /internal/audit-integrity` che ricalcola la catena della partizione corrente e delle due precedenti e restituisce **500** se non torna. Agganciato allo stesso alerting che monitora il servizio.

**Sanitizzazione**: ogni valore controllato da un utente che finisce in un campo di audit viene ripulito da CR/LF e dai caratteri delimitatori prima dell'INSERT (log injection).

**Denormalizzazione obbligatoria** di `actor_email`, `actor_display_name`, `target_label`: un registro deve riportare l'identità **al momento del fatto**, e questo elimina anche l'N+1 sulla query più frequente del pannello.

---

## 11. Requisiti di sicurezza (contromisure concrete)

Ogni voce è verificabile. `SEC-xx` va citato nei commit e nei test.

**Sessione e autorizzazione**
- **SEC-01** — `session.storeSessionInDatabase = true`. Con secondary storage il default è `false` e le sessioni esistono solo su Redis.
- **SEC-02** — L'autorizzazione legge `authz:{userId}`, mai `session.user`. Test: utente bannato → 401 alla richiesta successiva entro 1 secondo.
- **SEC-03** — `session.cookieCache` disattivo. `trustDevice` disattivo.
- **SEC-04** — Cookie `__Host-metamc_session`, `SameSite=Strict`, `Secure`, `HttpOnly`, `Path=/`, nessun `Domain`, nessun `Partitioned`. Verifica manuale in DevTools dopo il deploy.
- **SEC-05** — Timeout doppio: assoluto 8h (colonna `absolute_expires_at`, mai prorogata) **e** idle 30 min. ASVS 7.3.1 e 7.3.2 richiedono entrambi.
- **SEC-06** — Token di sessione nuovo dopo il completamento del 2FA e dopo l'enrollment da invito. La sessione di onboarding viene distrutta, non promossa.

**Escalation di privilegio**
- **SEC-07** — Nessun invito e nessuna assegnazione di ruolo può concedere, su alcun modulo, un livello superiore a quello effettivo dell'attore. Query di concedibilità in §7, eseguita server-side. Il tentativo fallito è loggato con severità alta.
- **SEC-08** — Nessuna operazione su un altro utente senza il controllo di dominanza (§7). Un admin non può declassare un owner.
- **SEC-09** — Il ruolo `owner` non è assegnabile via invito né via UI: solo procedura a quattro occhi.
- **SEC-10** — Plugin `admin` di better-auth **non registrato**: nessun endpoint di impersonation esiste. Se in futuro servisse una "vista come", è di sola lettura e ricalcolata lato UI, senza mai emettere una sessione a nome altrui.

**2FA**
- **SEC-11** — Anti-replay TOTP. `before` hook su `/two-factor/verify-totp`: rifiuta se `totp:used:{userId}:{step}` esiste o se `step <= last_totp_step`. `after` hook su esito 200: `SET NX EX 120` sui tre step della finestra e `UPDATE auth."user" SET last_totp_step = $step WHERE id = $1 AND last_totp_step < $step`. NIST §3.1.4.2 è un SHALL.
- **SEC-12** — `window = 1`. Mai 2.
- **SEC-13** — Recovery code custom (128 bit, SHA-256, consumo atomico). Mai `storeBackupCodes: 'encrypted'`.
- **SEC-14** — Rotte `/api/auth/two-factor/verify-backup-code` e `/api/auth/two-factor/generate-backup-codes` **bloccate con 404** da un hook di rotta registrato prima dell'handler better-auth; la colonna `backupCodes` sovrascritta con byte casuali subito dopo l'enrollment. Altrimenti resta un percorso di bypass con storage reversibile.

**CSRF e isolamento**
- **SEC-15** — Hook globale `onRequest`: per ogni metodo diverso da GET/HEAD, rifiuta se `Origin` non è esattamente `https://admin.metamc.it`. **Rifiuta anche se `Origin` è assente** (fail-closed).
- **SEC-16** — Resource Isolation Policy: rifiuta se `Sec-Fetch-Site` non è `same-origin`. Attenzione: si rifiuta anche `same-site`, perché il punto è escludere i sottodomini fratelli di `metamc.it`.
- **SEC-17** — Signed double-submit: cookie `__Host-metamc_csrf` (leggibile da JS, `SameSite=Strict`, `Secure`) contenente `base64url(HMAC-SHA256(k_csrf, session.id))`; il client lo rimanda in `X-CSRF-Token`; il server ricalcola dall'id di sessione e confronta con `timingSafeEqual`. Resistente al sottodominio che scrive cookie, a differenza del double-submit naive.
- **SEC-18** — Nessun endpoint che cambia stato è raggiungibile in GET.
- **SEC-19** — La rotta `/webhooks/resend` è **esclusa** da SEC-15/16/17 (è server-to-server) e protetta invece dalla verifica della firma Svix sul **raw body** + dedupe su `svix-id`.

**Redirect e token in URL**
- **SEC-20** — Nessun parametro `callbackURL`/`next`/`redirect` accettato dal client in tutta la fase 1. Le destinazioni post-login, post-accept, post-enrollment e post-reset sono costanti server-side. (Precedente reale: GHSA-vp58-j275-797x / CVE-2025-71403 su better-auth, bypass di `trustedOrigins` usato per rubare il token di reset.)
- **SEC-21** — Ogni pagina che riceve un token in URL: `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, e redirect immediato a URL pulito dopo lo scambio del token.

**Identità di rete**
- **SEC-22** — nginx **sovrascrive** `X-Forwarded-For`; Fastify `trustProxy` limitato al CIDR del proxy; better-auth `advanced.ipAddress.ipAddressHeaders` con **un solo** header.
- **SEC-23** — L'audit log registra **due** IP: `actor_socket_ip` (non falsificabile) e `actor_ip` (derivato). Allarme se divergono.

**Rate limiting e DoS**
- **SEC-24** — Un solo rate limiter (rate-limiter-flexible su Valkey). `rateLimit.enabled = false` su better-auth.
- **SEC-25** — Il token di rate limit è consumato **prima** di qualsiasi chiamata ad Argon2, incluso il percorso utente-inesistente.
- **SEC-26** — Limiti composti in AND: per IP, per account, per token di invito, **più un tetto globale per rotta** (che è l'unica difesa contro IP falsificati o botnet distribuite). Verifica 2FA: 5 tentativi / 15 min con backoff esponenziale.
- **SEC-27** — `insuranceLimiter` configurato: se Valkey è irraggiungibile il limiter degrada su uno store di riserva, **non** apre il login.
- **SEC-28** — Semaforo sugli hash Argon2 concorrenti + `UV_THREADPOOL_SIZE` esplicito + metrica "hash in volo" esposta come condizione di readiness (`@fastify/under-pressure` è strutturalmente cieco sul threadpool).
- **SEC-29** — `bodyLimit` 64 KB globale, 4 KB sulle rotte `/api/auth/*`.

**Enumeration**
- **SEC-30** — Login: verifica Argon2 contro un hash-esca precomputato con parametri identici quando l'utente non esiste. Messaggi, codici di stato e tempi identici.
- **SEC-31** — Per ogni rotta con `:id`, un utente non autorizzato riceve **lo stesso codice di stato** che riceverebbe per un id inesistente (niente oracolo 403-vs-404).
- **SEC-32** — Consumo invito e reset: risposta identica per token inesistente, scaduto, consumato e revocato.

**XSS**
- **SEC-33** — CSP: `script-src 'nonce-{RANDOM}' 'strict-dynamic'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`. `index.html` servito da Node con nonce per richiesta. La CSP di default di helmet va sovrascritta.
- **SEC-34** — `style-src 'self' 'unsafe-inline'` è il compromesso accettato e documentato (React/librerie iniettano style inline; l'XSS via CSS è molto più debole).
- **SEC-35** — Divieto assoluto di `innerHTML` e `dangerouslySetInnerHTML`, imposto da una regola Biome che **fallisce la build**. Vale in particolare per la tabella audit, che renderizza `user_agent`, `ban_reason` e payload jsonb, cioè stringhe controllate da terzi.
- **SEC-36** — Ogni operazione che modifica privilegi richiede step-up: un XSS non può promuoversi silenziosamente.

**SQL / query builder**
- **SEC-37** — Nessun input utente entra mai in `.key()`, `.at()`, `sql.lit()`, `sql.id()`, `sql.table()`, `sql.ref()` o in qualunque identificatore. I campi JSON filtrabili sono una **allowlist enumerata server-side** e l'input del client è un indice in quella lista. (CVE-2026-44635 tocca anche il dialetto PostgreSQL, non solo MySQL/SQLite.)
- **SEC-38** — La validazione JSON Schema non è mai l'unico enforcement di un invariante di sicurezza: i campi di sicurezza (es. `role_id` di un invito) sono rivalidati nell'handler contro la fonte di verità.

**Crittografia e segreti**
- **SEC-39** — Un solo `MASTER_KEY` di 32 byte in env/secret manager; tutte le chiavi derivate con `crypto.hkdf` con `info` distinto per scopo: `better-auth-secret`, `argon2-pepper-v1`, `csrf-v1`, `audit-anchor-v1`. Mai una chiave sola per tutto.
- **SEC-40** — `pepper_version` sulla riga utente e `key_version` nel prefisso di ogni ciphertext, **dal primo schema**: aggiungerli dopo impone il reset globale che si voleva evitare.
- **SEC-41** — Nessun segreto nel database. `MASTER_KEY` mai nei log, mai nei messaggi d'errore, nella `redact` di pino.
- **SEC-42** — Il ruolo `metamc_app` non ha `UPDATE` diretto su `auth."twoFactor"` fuori dalle funzioni del flusso di enrollment: mitiga l'attacco di sostituzione di record (copiare il proprio segreto TOTP sulla riga dell'owner), che la sola cifratura senza AAD non ferma.

**Logging**
- **SEC-43** — `redact` di pino configurato **prima della prima riga di logging** su: `req.headers.authorization`, `req.headers.cookie`, `res.headers["set-cookie"]`, `password`, `token`, `otp`, `secret`, `apiKey`, `code`. Mai loggare codici OTP, segreti TOTP, recovery code o token di invito, nemmeno in debug.

**Email**
- **SEC-44** — Nessun campo di testo libero nelle email di invito: template fisso, unica variabile il link. I campi interpolati (nome dell'invitante) normalizzati a una allowlist di caratteri **al momento della scrittura in DB**.
- **SEC-45** — Click tracking Resend **disattivato** sui template con token, altrimenti l'URL viene riscritto e il token passa per un redirector terzo.
- **SEC-46** — `Idempotency-Key` **deterministica** derivata dall'evento di dominio (`invite:{inviteId}:{tokenVersion}`), mai un UUID casuale.

**Audit**
- **SEC-47** — `REVOKE UPDATE, DELETE, TRUNCATE` + trigger + catena hash + job di verifica che restituisce 500 + ancoraggio esterno. Tutti e cinque.
- **SEC-48** — INSERT audit nella stessa transazione per gli eventi di sicurezza.

---

## 12. Version floors e supply chain

Floor da fissare nel lockfile e verificare in CI (ognuno chiude un bypass reale):

| Componente | Floor | Bypass chiuso |
|---|---|---|
| Node.js | 24.19.0 | CVE-2026-56846/56848 (HTTP/2), CVE-2026-58043 |
| fastify | 5.8.5 (pin 5.12.0) | CVE-2026-33806 — validazione body saltata con uno spazio nel Content-Type |
| better-auth | 1.6.11 (pin 1.6.29) | GHSA-2vg6-77g8-24mp, CVE-2026-53513, CVE-2026-67336 |
| kysely | 0.28.17 (pin 0.29.5) | CVE-2026-44635 e famiglia — JSON path injection, **anche PostgreSQL** |
| PostgreSQL | 18.6 | 28 CVE del 2026-08-13, diverse RCE CVSS 8.8 |
| @simplewebauthn/server (fase 1.5) | 13.3.2 | pin per prudenza — **nota: GHSA-6hxq-p678-4hr2 citato nella ricerca non esiste** (404 su GitHub Advisories e OSV; OSV riporta 0 advisory per il pacchetto) |
| Valkey | 9.0.5 | **i CVE-2026-56684 e CVE-2026-63639 citati nella ricerca non esistono** (404 su cveawg.mitre.org) |
| PgBouncer (se mai introdotto) | 1.25.2 | CVE-2026-6664/6665/6666/6667 |

**Regola operativa**: nessun numero di versione minimo entra in `package.json` o nel Dockerfile sulla base di un CVE che non è stato risolto con una chiamata a `cveawg.mitre.org/api/cve/<ID>` o `api.osv.dev/v1/vulns/<GHSA>`. Tre dei diciassette identificativi citati nella ricerca erano inventati.

**CI hardening**:
- Lockfile committato; `pnpm install --frozen-lockfile --ignore-scripts`
- **Una volta**, prima di congelare il lockfile: `pnpm install --strict-peer-dependencies` e lettura di **ogni** warning di peer (è il modo in cui si scopre il conflitto ioredis 5/6)
- `pnpm audit --audit-level=high` come gate + `osv-scanner`
- Versioni **esatte**, niente range
- GitHub Actions pinnate per commit SHA, `permissions:` minimo per job
- Renovate/Dependabot su **tutto** lo scope `@better-auth/*`, con cooldown sulle release freschissime
- Regola CI che fallisce se compare in `package.json` un pacchetto `@better-auth/*` fuori dalla allowlist (`better-auth`, `@better-auth/redis-storage`)
- La provenance npm firmata **non basta**: nella campagna ChainDrop le versioni avvelenate avevano provenance valida perché la pipeline stessa era compromessa

**Bus factor da mettere per iscritto** (non è motivo di scarto, è motivo di policy): `helmet` (unico committer), `@simplewebauthn/*` (unico committer), `@node-rs/argon2` (1 release in 12 mesi), `rate-limiter-flexible` (1 maintainer), `better-auth` (1 maintainer npm, 211 release/anno, 13 advisory dal 1 gennaio 2026).

**Policy di aggiornamento con numeri** (da scrivere in `docs/deps-policy.md`):
- patch di sicurezza: applicate entro 72h
- minor: finestra mensile fissa
- major: mai senza una settimana di soak e una issue dedicata
- cooldown Renovate: 7 giorni sulle release nuove

---

## 13. Osservabilità e health

Fase 1 volutamente minimale:
- **pino** con child logger per `requestId` e `actorId`, redaction configurata.
- Un endpoint `GET /internal/metrics` scritto a mano (nessun `prom-client`, fermo alla 15.1.3 del giugno 2024; nessun OTel) che espone: hash Argon2 in volo, hash Argon2 totali, login riusciti/falliti, richieste 401/403, latenza p50/p95 del login, connessioni pg in uso, errori Valkey.
- `GET /health/live` → 200 sempre finché il processo vive, **anche durante lo shutdown**.
- `GET /health/ready` → 503 **immediatamente** su SIGTERM; sonde PG e Valkey con **timeout 1 s**; distingue "degradato" da "non pronto"; include come condizione la metrica hash-in-volo. Nessun dettaglio interno nella risposta (niente versioni, niente host, niente stack).
- `close-with-grace` (versione [R], da risolvere) per SIGTERM/SIGINT + `fastify.close()` per il draining.

---

## 14. Test di accettazione obbligatori (ognuno va fatto fallire prima di implementare il fix)

1. `DELETE FROM audit.audit_log` eseguito dal ruolo `metamc_app` solleva eccezione.
2. Manomettere una riga passata dell'audit (via `metamc_migrate`) fa fallire la verifica della catena.
3. Un utente bannato riceve 401 alla richiesta successiva **entro 1 secondo**.
4. Un declassamento di permesso ha effetto alla richiesta successiva (test su `permissions_version`).
5. Un invito non può concedere, su nessun modulo, un livello superiore a quello dell'invitante.
6. Un admin non può modificare i permessi né bannare un utente che lo domina su almeno un modulo.
7. Lo stesso codice TOTP presentato due volte dentro la finestra è rifiutato la seconda.
8. Il token di sessione **cambia** dopo il completamento del 2FA e dopo l'enrollment da invito.
9. Per ogni rotta con `:id`, una chiamata da utente non autorizzato restituisce lo stesso status di un id inesistente (test parametrico su tutte le rotte).
10. Due accettazioni concorrenti dello stesso invito: una sola riesce.
11. Due consumi concorrenti dello stesso recovery code: uno solo riesce.
12. Una richiesta POST senza header `Origin` viene rifiutata.
13. Una richiesta POST con `Sec-Fetch-Site: same-site` viene rifiutata.
14. `POST /api/auth/two-factor/verify-backup-code` restituisce 404.
15. Login su email inesistente e su password errata hanno latenza indistinguibile (test statistico, 100 campioni per lato).
16. 50 login falliti/secondo: le rotte statiche e `/health/live` restano reattive (è il test che scopre la saturazione del threadpool).
17. La firma del webhook Resend fallisce se il body è stato riparsato.

Infrastruttura di test: container **PostgreSQL 18.6 effimero** con le migration reali (non pglite: servono ruoli, GRANT/REVOKE, partizionamento e trigger) + Valkey effimero.

---

## 15. Spike bloccanti, da eseguire prima di scrivere il codice applicativo

Timebox 1 giorno complessivo. Ognuno ha un esito binario e un piano B già deciso.

**SPIKE-1 (4h) — Hook del plugin twoFactor.** Verificare che (a) un `hooks.before` su `/two-factor/verify-totp` possa rifiutare la richiesta, e (b) un `hooks.after` veda l'esito positivo e permetta di calcolare/persistere lo step consumato.
→ Se fallisce: **non registrare il plugin twoFactor**; implementare TOTP su `otpauth 9.5.1` (enrollment a due fasi con secret PENDING e TTL 15 min, cifratura AES-256-GCM con nonce fresco da 12 byte e **AAD = `${userId}|${keyVersion}`**, lockout in Redis). In quel caso otpauth entra nelle dipendenze e la tabella `auth.user_totp` sostituisce `auth."twoFactor"`.

**SPIKE-2 (1h) — Cookie `__Host-`.** Verificare che `advanced.cookies.session_token.name = '__Host-metamc_session'` produca un `Set-Cookie` reale che inizia con `__Host-`, ha `Path=/`, `Secure`, e **nessun** `Domain`.
→ Se fallisce: gestire il cookie di sessione fuori da better-auth (`advanced.disableCSRFCheck` resta comunque false, e il cookie lo scriviamo noi nell'hook di risposta).

**SPIKE-3 (1h) — Plugin haveibeenpwned.** Verificare che invii l'header `Add-Padding: true` e che il timeout sia configurabile.
→ Se fallisce: client nostro con `fetch` globale + `Agent` keep-alive, timeout 2 s, fail-closed.

**SPIKE-4 (1h) — Prebuild `@node-rs/argon2` 2.1.0** per la coppia arch+libc dell'immagine di produzione, e misura del costo di un hash a m=19456/t=2/p=1 sul VPS reale.
→ Se il prebuild manca: pin `2.0.2`. Se anche quello manca: `crypto.argon2` nativo (verificare che l'immagine sia linkata a OpenSSL 3.2+).

**SPIKE-5 (1h) — Body parsing di better-auth su Fastify.** L'handler serializza `JSON.stringify(request.body)`: verificare che nessun content-type parser custom sia registrato prima e che il webhook Resend abbia un parser dedicato che preserva il buffer grezzo.

---

## 16. Predisposizioni per la fase 2 (creare, non costruire)

Costano meno di un'ora oggi e valgono una riprogettazione domani.

1. **Schema `stats` creato vuoto.** Le tabelle di rollup, il partizionamento RANGE mensile e gli indici BRIN si scrivono in fase 2. BRIN è corretto **lì** (append-only, scansione a intervallo, nessun `ORDER BY ... LIMIT`) e sbagliato sull'audit log.
2. **Pool Postgres iniettato**, mai singleton: in fase 2 si aggiunge `statsPool` con ruolo di sola lettura e `statement_timeout 10s` senza toccare il codice esistente.
3. **`AbortSignal` propagato**: ogni handler riceve già un signal legato a `request.raw.on('close')`. In fase 2 lo si passa a Kysely con strategia `cancel query`, e le aggregazioni orfane non bruciano CPU.
4. **Interfaccia `CacheService`** con cinque metodi (`getOrSet`, `invalidate`, `invalidateTag`, `warm`, `stats`) e una sola implementazione passthrough in fase 1. La cache vera (singleflight + SWR, ~120 righe su `lru-cache` + `ioredis`) si scrive dietro questa interfaccia.
5. **Contratto dati delle API statistiche deciso ora, implementato dopo**: formato **colonnare** `{ t: number[], series: { [mode]: number[] } }`, timestamp interi epoch (mai stringhe ISO), bucketizzazione in `Europe/Rome` con normalizzazione per numero effettivo di occorrenze del bucket (nei giorni di cambio DST un'ora locale ha 0 o 2 occorrenze). È la decisione che determina byte sul filo, costo di serializzazione e lavoro del client.
6. **Una schermata = una richiesta**: il breakdown per ~20 modalità è **un** endpoint, non 20 query.
7. **Gerarchia della fonte di verità dichiarata ora**: Postgres (partizionato + rollup) è la fonte di verità; Valkey conterrà **solo il payload di risposta già serializzato e compresso con Brotli**, prodotto una volta ogni 30 s dal worker. Nessun contatore di dominio duplicato in Redis, salvo la finestra viva del giorno in corso etichettata "in corso" in UI. Gli unici giornalieri si contano con una tabella `(day, player_uuid)` a PK composta, **non** con HyperLogLog: ±0,81% su un numero che l'owner confronta mese su mese non è accettabile quando l'alternativa esatta costa pochi MB.
8. **Tabella `auth.webauthn_credential` già creata** (vuota): la passkey di fase 1.5 è una migration additiva, non una ristrutturazione.
9. **nginx già configurato** con `proxy_buffering off` e `proxy_read_timeout` alzato sulla futura rotta SSE.
10. **Matrice CI su Node 24 e 26 dal primo commit**: la 24 entra in Maintenance il 2026-10-20, nove settimane dopo l'inizio.

Da **non** anticipare in nessun modo: TimescaleDB (licenza TSL, da dichiarare al committente, e molti managed Postgres non la offrono), pg_cron, ClickHouse, seconda istanza Valkey, uPlot/ECharts, TopoJSON (il file `countries-110m.json` pesa 108 kB, quanto l'intero stack viz: va caricato con `import()` dinamico sulla sola rotta mappa), React Compiler (fa passare ogni modulo da Babel e annulla il vantaggio di Rolldown; i grafici vanno tenuti fuori da React con `useRef` + ring buffer, e allora non c'è nulla da memoizzare).

---

## 17. Operatività — cose senza cui non si va in produzione

1. **Backup e restore.** Il buco più grave dell'intera ricerca: si progetta una catena hash tamper-evident sopra un database di cui nessuno ha definito il backup. Serve pgBackRest, wal-g o il PITR del provider, **più una prova di ripristino documentata e datata prima del go-live**. La partizione corrente dell'audit log deve essere nel backup.
2. **Bootstrap del primo owner.** Comando CLI `scripts/bootstrap-owner.ts`, eseguibile una sola volta (fallisce se esiste già un utente), che crea un invito owner con TTL 1h e stampa il link su stdout. Non un endpoint, non un seed committato con credenziali.
3. **Chi esegue le migration**: ruolo `metamc_migrate`, credenziali solo in CI. Ogni migration inizia con `SET lock_timeout = '3s'; SET statement_timeout = '60s';`. `CREATE INDEX CONCURRENTLY` fuori transazione. Forward-only in produzione.
4. **Rotazione dei segreti**: piano scritto per `MASTER_KEY`, pepper Argon2 (`pepper_version`, re-hash al login successivo), chiave di cifratura TOTP (`key_version` nel ciphertext), webhook secret Resend, chiave di ancoraggio audit. Cambiare il pepper senza versioning invalida **tutti** gli hash e impone un reset password globale.
5. **Deliverability**: `mail.metamc.it` con MX + SPF + DKIM + DMARC `p=none` → leggere i report → `quarantine` → `reject`. Coda con concorrenza limitata davanti all'SDK Resend (rate limit **10 req/s per team**, su tutte le API key insieme; creare più chiavi non lo aggira). Distinguere `rate_limit_exceeded` (ritentabile) da `daily_quota_exceeded`/`monthly_quota_exceeded` (che restituiscono anch'essi 429 ma non si risolvono aspettando). Header `User-Agent` sempre presente, altrimenti 403 (errore 1010).
6. **Container**: multi-stage, `pnpm install --frozen-lockfile --prod --ignore-scripts`, utente `node` non-root, base `-slim` o distroless glibc, tag di patch esplicito (`node:24.19.0-slim`, mai `24` né `lts`).
7. **Documento delle deviazioni** (`docs/security/deviations.md`), richiesto letteralmente da ASVS 7.1.1 e dalle note di V6: window TOTP = 1 contro ASVS 6.5.5; Argon2 m=19456 contro RFC 9106 SECOND RECOMMENDED; assenza di fattore phishing-resistant in fase 1 con data di rientro; `style-src 'unsafe-inline'`; step-up con TOTP invece che con passkey.
8. **Mappatura ASVS 5.0 L2** per i capitoli V2, V3, V6, V7, V8, V11, V13, V14, V16. L3 è sovradimensionato per un pannello interno.

---

## 18. Ordine di implementazione consigliato

1. Spike 1-5.
2. Migration 001: schemi, ruoli Postgres, GRANT/REVOKE, `audit_log` partizionato + trigger + `chain_head`. Test 1 e 2 verdi.
3. Migration 002: tabelle better-auth (generate) + additionalFields + indici.
4. Migration 003: RBAC (modules, roles, role_permissions, user_roles, user_permissions, vista, trigger di invalidazione) + seed moduli e ruoli.
5. Migration 004: invitation, recovery_code, webauthn_credential (vuota).
6. Bootstrap owner + login base + middleware di autorizzazione (§9). Test 3, 4, 8, 15.
7. 2FA + recovery code + anti-replay. Test 7, 11, 14.
8. Inviti end-to-end + Resend + webhook. Test 5, 10, 17.
9. RBAC completo: assegnazione ruoli, override, dominanza, step-up. Test 6, 9.
10. Audit log applicativo su tutti gli eventi + endpoint di integrità + ancoraggio. 
11. Hardening trasversale: CSP, CSRF, Fetch Metadata, rate limiting, semaforo Argon2. Test 12, 13, 16.
12. UI: login, enrollment, accept invito, gestione utenti/ruoli, tabella audit virtualizzata con keyset.
13. Offboarding, reset password, cambio email.
14. Test di carico (autocannon/k6) sui tre scenari: 20 login concorrenti, 20 dashboard concorrenti, 50 login falliti/s. Budget: login p95 < 400 ms.
15. Prova di restore documentata. Go-live.