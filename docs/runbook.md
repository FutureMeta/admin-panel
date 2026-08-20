# Runbook — MetaMC Admin, fase 1

Quello che serve per portare il sistema in produzione e tenercelo. §17.

---

## 1. Prerequisiti

| Componente | Versione | Nota |
|---|---|---|
| VPS | Debian | confermato dal committente |
| Node.js | `24.19.0` | il Dockerfile lo pinna; mai il tag `24` né `lts` |
| PostgreSQL | `17` o superiore | vedi nota sotto |
| Redis | ≥ 7.4 | `maxmemory-policy noeviction`, `appendonly yes`, `requirepass` |
| nginx | qualunque recente | configurazione in `deploy/nginx.conf` |

**Sulla versione di PostgreSQL.** Il progetto nasceva con la 18.6 come minimo
per due motivi. Il primo era tecnico: la migration 004 usava `uuidv7()`, nativa
solo dalla 18, e su una 17 lo schema si fermava a metà. Quella dipendenza non
c'è più — la funzione è definita dalla migration stessa come `auth.uuidv7()`,
frazione di millisecondo compresa, e si comporta come la nativa (misurato: 500
generazioni su 500 in ordine crescente, identico alla 18).

Il secondo motivo era di sicurezza e riguardava **la linea 18**: le 18.x
precedenti alla 18.6 portano 28 CVE del 2026-08-13, diverse RCE con CVSS 8.8.
Se installi una 18, quel floor resta valido. Sulla linea 17 quelle advisory non
sono state verificate una per una: la regola operativa è tenere aggiornata alla
patch più recente la linea che usi, qualunque sia.

Se scegli la 18, si installa dal repository PGDG: quello di Debian è indietro
di una o più minor.

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
| `AUDIT_ANCHOR_PATH` | no | dove il job `anchor` scrive le teste firmate. Default `./audit-anchor.jsonl` |

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

## 4bis. Avatar Minecraft — traffico in uscita

Le facce degli utenti sono le skin dei loro account Minecraft, e passano dal
**nostro** server: la CSP dichiara `img-src 'self'`, e allargarla a un CDN di
skin gli regalerebbe l'IP di chi guarda e il nome di chi viene guardato, riga
per riga del registro.

Il server deve poter raggiungere in uscita, su HTTPS, tre soli host:

| Host | A cosa serve |
|---|---|
| `api.mojang.com` | nome del giocatore → UUID |
| `sessionserver.mojang.com` | UUID → profilo con la URL della texture |
| `textures.minecraft.net` | i byte della skin |

**Se l'uscita è bloccata non si rompe niente**: il pannello mostra le iniziali
colorate, come faceva prima. Vale la pena saperlo prima di andare a cercare un
guasto che non c'è.

Due limiti da conoscere:

- `sessionserver` accetta **una richiesta al minuto per profilo**. Per questo
  gli esiti stanno in Redis (24 ore i positivi, 6 ore i negativi) e le
  richieste in volo per lo stesso nome vengono unite. Le chiavi sono `mc:`.
- La rotta `/api/avatars/:name.png` è autenticata ma **non ha un limitatore
  suo**. Una sessione rubata potrebbe chiedere molti nomi diversi e far
  superare la quota al nostro IP; l'effetto sarebbe che per qualche minuto le
  facce tornano iniziali. Se un giorno lo staff cresce oltre la dozzina, il
  posto giusto per il limite è il **cache miss**, non la richiesta: la
  navigazione normale non deve pagarlo.

Il nome usato è quello dell'utente nel pannello. Se non rispetta le regole di
Mojang — lettere, cifre e trattino basso, 3-16 caratteri — non parte nessuna
richiesta e restano le iniziali.

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
| pepper Argon2 | si alza `PEPPER_VERSION` e si riavvia. Ogni hash viene rigenerato al login successivo di quella persona, con il pepper vecchio usato per verificare e quello nuovo per riscrivere. **Non togliere l'`info` di una versione precedente**: finche' esiste una riga non ancora migrata, quel pepper serve | **cambiarlo senza versioning invalida TUTTI gli hash e impone un reset password globale** |
| chiave TOTP | `key_version` nel prefisso del ciphertext | idem |
| webhook Resend | rigenerare su Resend, aggiornare env, riavviare | il webhook risponde 400 finché non combacia |
| chiave di ancoraggio audit | le firme vecchie restano verificabili con la chiave vecchia: conservarla | ancoraggi passati non più verificabili |

---

## 8. Manutenzione mensile

- **I quattro lavori periodici — non serve fare niente.** Li tiene
  l'applicazione (`src/jobs/keeper.ts`), partono con il server e si fermano
  con lui. Nessun cron.

  | Job | Cadenza | Cosa succede se non gira |
  |---|---|---|
  | `partitions` | giornaliero | quando le partizioni finiscono, **ogni scrittura del pannello fallisce** |
  | `anchor` | giornaliero | la catena resta verificabile solo contro se stessa: nessuna prova esterna |
  | `verify` | giornaliero | una manomissione del registro passa inosservata |
  | `cleanup` | orario | restano segreti TOTP mai confermati e token scaduti |

  Ognuno riprova prima del solito se fallisce (un'ora, quindici minuti per
  `cleanup`), e un fallimento non abbatte il processo: viene loggato a livello
  `error` con la **conseguenza**, non con «errore».

  **Da agganciare all'alerting**, in ordine di gravità:

  - `metamc_audit_chain_ok` — vale 0 quando la verifica ha trovato una
    partizione che non torna, e **non torna a 1 da sola**. Significa che
    qualcuno ha riscritto il registro passando dal database, cioè aggirando
    ogni difesa dell'applicazione. Nei log è una riga `fatal`. Il pannello
    resta acceso di proposito: un registro compromesso è un fatto
    sull'integrità dei dati, non sulla capacità di servire, e spegnerlo
    toglierebbe la possibilità di leggerlo proprio quando serve.
  - `metamc_job_last_success_timestamp{job="..."}` — se invecchia oltre la
    cadenza, quel lavoro ha smesso di girare.
  - `metamc_job_failures_total{job="..."}` — cresce a ogni giro fallito.

  Per lanciarne uno subito senza aspettare il giro: `node
  scripts/maintenance.ts <anchor|partitions|cleanup|verify>`.

  **L'ancoraggio scrive un file locale** — il percorso è `AUDIT_ANCHOR_PATH`,
  default `./audit-anchor.jsonl`. Portarlo su uno storage append-only fuori da
  questa macchina resta da fare, ed è una decisione infrastrutturale: finché il
  file vive accanto al database, protegge da chi tocca il database ma non da
  chi ha la macchina.

  Perché non un cron: se le partizioni finiscono, **ogni INSERT di audit
  fallisce**, e siccome l'audit sta nella stessa transazione delle modifiche di
  stato falliscono anche quelle — il pannello si blocca in scrittura, tutto
  insieme. Un cron esterno regge finché qualcuno lo configura e finché nessuno
  ricostruisce la macchina dimenticandosene: una dipendenza che non si vede dal
  codice e che si scopre rotta il giorno del guasto. Ora il lavoro vive accanto
  alla cosa che protegge.

  L'applicazione **non** ha privilegi DDL: chiama
  `audit.create_month_partition()`, che dalla migration 009 è `SECURITY
  DEFINER` con `search_path` bloccato, non eseguibile da `PUBLIC` e con un
  orizzonte di [-12, +24] mesi sulle date accettate. Continua a non poter
  cancellare, modificare, staccare o distruggere niente: lo verificano i test
  di `21-partitions-self-service`.
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

### Nessun owner riesce più a entrare

È il caso più comune, e per quello esiste un comando — non un endpoint:

```bash
DATABASE_MIGRATE_URL=... APP_ORIGIN=https://admin.metamc.it node scripts/invite-owner.ts --break-glass nuovo.owner@metamc.it "Nome Cognome"
```

Stampa un link d'invito owner valido **un'ora**, una volta sola.

Pretende `DATABASE_MIGRATE_URL`, ed è quello il confine che lo rende
accettabile: chi ha quelle credenziali possiede già lo schema e potrebbe
inserire la stessa riga a mano, spegnendo il trigger da sé. Il comando non
concede un potere nuovo — evita di sbagliare la query e, soprattutto, scrive
nel registro la voce `system.break_glass_owner_invite`, che una INSERT
scritta a mano non lascerebbe. **Quella voce non va cancellata**: è ciò che
permette a chi legge fra sei mesi di distinguere questo invito da uno
emesso dal pannello. L'invito risulta emesso da un'identità tecnica
«Break-glass», non da una persona, per la stessa ragione.

Si rifiuta di partire senza `--break-glass`, e si ferma con una spiegazione
se per quell'indirizzo esiste già un account o un invito in attesa.

Il comando **non** sblocca un secondo fattore perduto. Il reset del §8.8
vuole un richiedente e due approvatori distinti da lui: per recuperare
l'account di un owner servono tre altri owner. Per quello restano i recovery
code o l'intervento diretto sul database descritto qui sopra.

---

## 10. Cosa NON è in fase 1

Predisposto ma vuoto (§16): schema `stats`, tabella `auth.webauthn_credential`,
interfaccia `CacheService` con la sola implementazione passthrough, `proxy_buffering off`
sulla futura rotta SSE, `AbortSignal` propagato a ogni handler.

Non installato (§4), con la soglia di rientro: bentocache, OpenTelemetry,
msgpackr, TimescaleDB, pg_cron, PgBouncer, seconda istanza Redis, uPlot,
ECharts, d3-geo, react-compiler, `@fastify/static`, `@fastify/csrf-protection`,
`@fastify/rate-limit`, `otpauth`, plugin `admin` di better-auth.
