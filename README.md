# MetaMC Admin — fase 1

Pannello di amministrazione interno per il network Minecraft MetaMC.
10-50 utenti di staff, accesso solo su invito, nessuna registrazione pubblica.

**Perimetro di questa fase**: inviti, login, 2FA, sessioni, RBAC per modulo,
audit log, e le schermate che servono a usarli. Le statistiche di gioco sono
fase 2 e qui non ci sono.

Il progetto è normato da [`docs/stack-decisions.md`](docs/stack-decisions.md).
Quel documento decide; questo repository lo implementa e, dove ha trovato un
errore, lo dice.

---

## Partire

```bash
pnpm install --frozen-lockfile
cp .env.example .env       # e riempilo
pnpm run migrate           # con DATABASE_MIGRATE_URL
pnpm run bootstrap:owner owner@metamc.it "Nome Cognome"
pnpm run build:web
pnpm start
```

In sviluppo, due processi:

```bash
pnpm dev        # API su :3000
pnpm run dev:web  # frontend su :5173, con proxy verso :3000
```

Il proxy serve a tenere tutto sulla stessa origine: i cookie sono `__Host-` e
`SameSite=Strict`, e da due origini diverse il login non funzionerebbe in
locale per un motivo che non c'entra col codice.

---

## Verificare

```bash
pnpm run check      # guardie + identificatori + dipendenze + tipi + lint
pnpm test           # i 17 test di accettazione del §14
pnpm run build:web  # build del frontend, col controllo del nonce CSP in coda
```

**Non c'è CI.** Il progetto non ha GitHub Actions, quindi questi comandi vanno
lanciati a mano prima di ogni push. L'unica cosa che il workflow faceva e che
oggi non fa più nessuno è la scansione della supply chain: vale la pena
eseguirla quando si tocca il lockfile.

```bash
pnpm audit --audit-level=high
pnpm dlx osv-scanner@1.9.0 --lockfile=./pnpm-lock.yaml
```

I test hanno bisogno di un PostgreSQL raggiungibile; in locale va bene un
cluster effimero:

```bash
initdb -D /tmp/pgdata -U postgres -A trust
pg_ctl -D /tmp/pgdata -o "-p 55432" start
```

Redis è opzionale in locale: senza `TEST_REDIS_URL` la suite avvia un server
RESP2 minimale in-process. Vedi D-08 in
[`docs/security/deviations.md`](docs/security/deviations.md) per cosa cambia.

---

## Com'è fatto

```
src/
  authz/       l'UNICO posto che decide. can(actor, module, level)
  auth/        Argon2 con pepper e semaforo, TOTP anti-replay, recovery code, HIBP
  audit/       scrittura in transazione, sanitizzazione, verifica della catena
  assistant/   Svetlana: cinque tool in sola lettura, con il permesso dentro
  http/        server Fastify, middleware del §9, rotte
  invites/     ciclo di vita dell'invito
  db/          pool iniettato, interfaccia Kysely scritta a mano
migrations/    forward-only, una per passo
scripts/       migrate, bootstrap-owner, job, guardie che fermano la build
tests/         i 17 test di accettazione, con Postgres vero
web/           frontend Vite + React
```

Tre cose che vale la pena sapere prima di leggere il codice:

**L'autorizzazione non legge mai `session.user`.** È uno snapshot fatto al
login: non riflette né ban né declassamenti. Si legge `authz:{userId}` da
Redis, ricostruita da Postgres su miss. `pnpm run check` fallisce se un
confronto su ruoli compare fuori da `src/authz/`.

**L'INSERT nell'audit è l'ultima istruzione prima del COMMIT**, nella stessa
transazione della modifica di stato. Non è affidato alla disciplina:
`securityTransaction()` apre la transazione, esegue il lavoro e scrive l'audit
dopo — un chiamante non ha modo di invertire l'ordine restando dentro
l'helper.

**Nessuno concede ciò che non ha, e nessuno tocca chi lo domina.** Sono due
query SQL sulla vista `effective_permissions`, eseguite server-side a ogni
operazione che tocca un altro utente. Il client non le ricalcola: riceve
`canManage` e disegna.

---

## Documenti

| File | Cosa contiene |
|---|---|
| [`docs/stack-decisions.md`](docs/stack-decisions.md) | il documento normativo |
| [`docs/spike-outcomes.md`](docs/spike-outcomes.md) | i 5 spike del §15, con l'esito e il ramo preso |
| [`docs/runbook.md`](docs/runbook.md) | primo avvio, segreti, backup, manutenzione, break-glass |
| [`docs/svetlana.md`](docs/svetlana.md) | l'assistente: cosa legge, il modello di sicurezza, i costi, **e le due decisioni che servono al committente prima di accenderlo** |
| [`docs/security/deviations.md`](docs/security/deviations.md) | 8 deviazioni, con motivo e data di rientro |
| [`docs/security/asvs.md`](docs/security/asvs.md) | mappatura ASVS 5.0 L2 |
| [`docs/deps-policy.md`](docs/deps-policy.md) | aggiornamenti, bus factor, floor verificati |

---

## Cosa NON è qui, di proposito

**Predisposto e vuoto** (§16): schema `stats`, tabella
`auth.webauthn_credential`, interfaccia `CacheService` con la sola
implementazione passthrough, `proxy_buffering off` sulla futura rotta SSE,
`AbortSignal` propagato a ogni handler.

**Non installato** (§4), ognuno con la sua soglia di rientro: bentocache,
OpenTelemetry, msgpackr, TimescaleDB, pg_cron, PgBouncer, seconda istanza
Redis, uPlot, ECharts, d3-geo, react-compiler, `@fastify/static`,
`@fastify/csrf-protection`, `@fastify/rate-limit`, `otpauth`, e il plugin
`admin` di better-auth.

Quest'ultimo merita una riga: non registrarlo elimina in un colpo
l'impersonation, la doppia fonte di verità sui permessi, il ruolo `admin` con
controllo totale di default, e un'intera classe di advisory. RBAC, ban e revoca
delle sessioni altrui sono implementati sulle nostre tabelle.
