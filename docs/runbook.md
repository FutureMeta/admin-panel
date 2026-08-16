# Runbook — MetaMC Admin, fase 1

Quello che serve per portare il sistema in produzione e tenercelo. §17.

---

## 1. Prerequisiti

| Componente | Versione | Nota |
|---|---|---|
| VPS | Debian | confermato dal committente |
| Node.js | `24.19.0` | il Dockerfile lo pinna; mai il tag `24` né `lts` |
| PostgreSQL | `18.6` | **floor duro**: le 18.x precedenti hanno 28 CVE del 2026-08-13, diverse RCE CVSS 8.8 |
| Redis | ≥ 7.4 | `maxmemory-policy noeviction`, `appendonly yes`, `requirepass` |
| nginx | qualunque recente | configurazione in `deploy/nginx.conf` |

Sul VPS, PostgreSQL 18.6 si installa dal repository PGDG: quello di Debian è
indietro di una o più minor, e la differenza qui è il floor di sicurezza.

Redis va configurato con `noeviction`: con una policy LRU, sotto pressione di
memoria il server butterebbe via sessioni e chiavi `authz:` **senza dirlo**, e
il sintomo sarebbe "gli utenti vengono buttati fuori a caso".

---

## 2. Primo avvio

```bash
# 1. Ruoli e schema
DATABASE_MIGRATE_URL=postgres://metamc_migrate@host/metamc pnpm run migrate

# 2. Password dei ruoli (le migration li creano SENZA password: con
#    scram-sha-256 un ruolo senza password non si autentica, quindi il
#    default è chiuso)
psql -c "ALTER ROLE metamc_app PASSWORD '...'"
psql -c "ALTER ROLE metamc_migrate PASSWORD '...'"

# 3. Primo owner
DATABASE_MIGRATE_URL=... APP_ORIGIN=https://admin.metamc.it \
  pnpm run bootstrap:owner owner@metamc.it "Nome Cognome"
```

Il comando stampa un link valido **un'ora**. Non è un endpoint e non si può
eseguire due volte: fallisce se esiste già un utente.

**Subito dopo, invita il secondo owner.** La policy è due owner (§1.3), e non è
burocrazia: senza due owner distinti la procedura di reset 2FA a quattro occhi
(§8.8) non esiste, e la prima persona che perde il telefono resta fuori per
sempre.

---

## 3. Variabili d'ambiente

Validate con Zod al boot: il processo non parte con una configurazione
incompleta. Il messaggio d'errore riporta il **nome** della variabile mancante,
mai il valore (SEC-41).

| Variabile | Obbligatoria | Nota |
|---|---|---|
| `APP_ORIGIN` | sì | origine ESATTA, `https://` in produzione. SEC-15 la confronta e basta |
| `TRUST_PROXY_CIDR` | sì | CIDR del proxy, **mai `true`** (SEC-22) |
| `DATABASE_URL` | sì | ruolo `metamc_app` |
| `DATABASE_MIGRATE_URL` | solo in CI | ruolo `metamc_migrate` |
| `REDIS_URL` | sì | con `requirepass` |
| `MASTER_KEY` | sì | 32 byte in esadecimale. Tutte le altre chiavi sono derivate con HKDF |
| `PEPPER_VERSION` | no (1) | SEC-40: la rotazione del pepper passa da qui |
| `UV_THREADPOOL_SIZE` | sì | numero di core REALI, mai il default 4 |
| `RESEND_API_KEY` | sì in prod | senza, gli inviti non partono |
| `RESEND_WEBHOOK_SECRET` | sì in prod | senza, il webhook risponde 503 e non accetta nulla |
| `MAIL_FROM` | no | default `MetaMC Admin <no-reply@metamc.it>` |

`MASTER_KEY` si genera con:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

---

## 4. Email — deliverability

Il committente ha scelto **`no-reply@metamc.it`**, cioè l'apex.

Il §1.4 raccomandava un sottodominio dedicato (`mail.metamc.it`). Il motivo è
uno solo, e vale la pena saperlo: sull'apex la reputazione di invio del
pannello si mescola a quella di qualunque altra cosa parta da `metamc.it`, e
una policy DMARC restrittiva messa per il pannello vincola anche il resto.
**Si procede come richiesto**; se in futuro il dominio dovesse mandare altra
posta, spostare il `From` su un sottodominio è una modifica di una riga più i
record DNS.

Da configurare su `metamc.it`:

- **SPF** — includere Resend nel record esistente, non crearne un secondo: due
  record SPF sullo stesso nome sono un errore di sintassi e fanno fallire la
  valutazione.
- **DKIM** — `resend._domainkey`
- **DMARC** — partire da `p=none`, leggere i report per almeno due settimane,
  poi `quarantine`, poi `reject`. Saltare i passaggi significa scoprire i falsi
  positivi quando la posta è già rifiutata.

Limite Resend: **10 req/s per team**, su tutte le API key insieme — creare più
chiavi non lo aggira. Davanti all'SDK c'è una coda a concorrenza 1 con
spaziatura di 150 ms.

Attenzione a distinguere gli errori: `rate_limit_exceeded` si risolve
aspettando, `daily_quota_exceeded` e `monthly_quota_exceeded` restituiscono
anch'essi 429 ma **non** si risolvono aspettando. Il mailer già li tratta in
modo diverso.

---

## 5. Backup e restore

Il buco più grave sarebbe progettare una catena hash tamper-evident sopra un
database di cui nessuno ha definito il backup.

- **pgBackRest** o il PITR del provider. La partizione **corrente** dell'audit
  log deve essere nel backup: è quella che contiene gli eventi di oggi.
- **Prova di ripristino documentata e datata PRIMA del go-live.** Un backup non
  provato è un'ipotesi.
- Dopo il restore, eseguire `GET /internal/audit-integrity`: se la catena non
  torna, il ripristino ha perso righe.

---

## 6. Ancoraggio esterno dell'audit

Un job giornaliero scrive l'hash di testa di ogni partizione in uno storage
append-only **fuori dal database**: bucket con object-lock, oppure un
repository git separato con commit firmato dal job.

L'email agli owner è una notifica **aggiuntiva, non il meccanismo**: un
controllo che dipende dall'attenzione umana non è un controllo.

`GET /internal/audit-integrity` ricalcola la catena della partizione corrente e
delle due precedenti e restituisce **500** se non torna. Va agganciato allo
stesso alerting che monitora il servizio, non a una dashboard che qualcuno
guarda ogni tanto.

---

## 7. Rotazione dei segreti

| Segreto | Come si ruota | Cosa succede se si sbaglia |
|---|---|---|
| `MASTER_KEY` | tutte le chiavi derivate cambiano insieme: sessioni e token CSRF decadono, gli hash password **no** (dipendono dal pepper, versionato) | senza versioning, tutti fuori |
| pepper Argon2 | si alza `PEPPER_VERSION`; ogni utente viene ri-hashato al login successivo grazie a `pepper_version` sulla sua riga | **cambiarlo senza versioning invalida TUTTI gli hash e impone un reset password globale** |
| chiave TOTP | `key_version` nel prefisso del ciphertext | idem |
| webhook Resend | rigenerare su Resend, aggiornare env, riavviare | il webhook risponde 400 finché non combacia |
| chiave di ancoraggio audit | le firme vecchie restano verificabili con la chiave vecchia: conservarla | ancoraggi passati non più verificabili |

---

## 8. Manutenzione mensile

- **Partizioni dell'audit log.** La migration 001 ne crea 12 in avanti più 2
  indietro. Un job mensile deve chiamare `audit.create_month_partition()` per
  restare avanti. Se le partizioni finiscono, **ogni INSERT di audit fallisce**,
  e siccome l'audit è nella stessa transazione delle modifiche di stato,
  falliscono anche quelle: il pannello si blocca in scrittura. Non è un guasto
  silenzioso, ma è un guasto totale.
- **Retention.** Si pota con `DETACH` + `DROP` di partizione, mai con `DELETE`:
  un DELETE spezzerebbe la catena hash. Prima del DROP, ancorare la testa della
  partizione.
- **Aggiornamenti** (§12): patch di sicurezza entro 72h, minor in finestra
  mensile fissa, major mai senza una settimana di soak e una issue dedicata.
  Cooldown Renovate: 7 giorni sulle release nuove.

---

## 9. Break-glass

Se tutti gli owner sono fuori contemporaneamente:

1. La policy dei due owner con due fattori ciascuno su **dispositivi diversi**
   dovrebbe averlo già impedito.
2. Se fallisce comunque, l'unica via è un intervento diretto sul database
   eseguito da chi ha le credenziali `metamc_migrate`, con **annotazione
   manuale nell'audit log** e **rotazione successiva di tutti i segreti**.
3. **Nessun endpoint automatizza questa procedura, e non va aggiunto.** Un
   endpoint di break-glass è una porta che resta aperta anche quando non serve.

---

## 10. Cosa NON è in fase 1

Predisposto ma vuoto (§16): schema `stats`, tabella `auth.webauthn_credential`,
interfaccia `CacheService` con la sola implementazione passthrough, `proxy_buffering off`
sulla futura rotta SSE, `AbortSignal` propagato a ogni handler.

Non installato (§4), con la soglia di rientro: bentocache, OpenTelemetry,
msgpackr, TimescaleDB, pg_cron, PgBouncer, seconda istanza Redis, uPlot,
ECharts, d3-geo, react-compiler, `@fastify/static`, `@fastify/csrf-protection`,
`@fastify/rate-limit`, `otpauth`, plugin `admin` di better-auth.
