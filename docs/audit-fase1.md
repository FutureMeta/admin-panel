## 1. Verdetto

**No.** Il codice della fase 1 non è completo: il backend è sostanzialmente finito, il frontend è indietro di tre schermate intere (§8.8, §8.9, §18.12 — 13 rotte pubblicate e mai chiamate), e un requisito di schema (SEC-40, `key_version`) è assente proprio ora che è gratis metterlo.

Dal go-live separano due cose diverse: **~10 interventi di codice**, di cui uno solo davvero bloccante, e **un blocco operativo che nessun agente può chiudere** — non esiste una prova di ripristino eseguita, e il backup stesso non è definito ma solo elencato come alternativa (`docs/runbook.md:169-170`; `deploy/` contiene il solo `nginx.conf`).

---

## 2. Cosa è verificabilmente fatto

Il nucleo di sicurezza regge e l'ho verificato nei file, non nei README. Le nove migration aprono tutte con `SET LOCAL lock_timeout`/`statement_timeout`, `scripts/migrate.ts:87-104` rende le migration forward-only per checksum e `:170-176` rifiuta `metamc_app`. Argon2 (m=19456/t=2/p=1, pepper HKDF 32 byte, semaforo), TOTP window 1 con anti-replay, catena hash dell'audit con partizioni auto-schedulate, cookie `__Host-metamc_session` con Secure/HttpOnly/SameSite=Strict, CSP con nonce + strict-dynamic senza `unsafe-inline` su script-src, CSRF double-submit, blocklist delle rotte better-auth, RBAC per dominanza su moduli con `permissions_version`: tutto presente e conforme. Il bootstrap owner (§17.2) e il break-glass sono il pezzo migliore del repository. Lockfile committato, 39 pacchetti tutti pinnati, guardia verificata a mano (exit 0). Le sei predisposizioni §16 verificabili sono presenti e vuote come prescritto: nessuna è stata implementata per sbaglio.

Sui 48 SEC, 40 sono pieni; le sei predisposizioni §16 verificabili sono corrette; il §17.3 (migration) è conforme riga per riga.

**Avvertenza che pesa su tutto quanto sopra:** la suite non è mai stata eseguita in questo ambiente (nessun Postgres su 127.0.0.1:55432, 160 test saltati). Lo stato "verde" dei 12 test coperti è dedotto dalla lettura, non osservato.

---

## 3. Cosa manca davvero

### (a) Buchi di conformità — codice da scrivere

**Bloccante**

1. **SEC-40 — `key_version` non esiste da nessuna parte.** `grep "key_version" src/ migrations/` → zero occorrenze; c'è solo `pepper_version` su `migrations/002_better_auth.sql:44`. Il §11 impone di metterli «dal primo schema, perché aggiungerli dopo impone il reset globale». Oggi il database è vuoto e costa nulla; dopo il go-live costa il reset del TOTP di tutto lo staff. Corollario: **la rotazione del pepper (§17.4) non è eseguibile** — `PEPPER_VERSION` è validata a `src/config/env.ts:44` e non letta da nessuna riga, l'`info` HKDF è la costante `'argon2-pepper-v1'` (`src/crypto/keys.ts:17`), e `needsRehash()` (`src/auth/password.ts:62`) non ha chiamanti. Alzare `PEPPER_VERSION` oggi non cambia niente e non ri-hasha nessuno, mentre `docs/runbook.md:212` promette il ri-hash al login successivo.

2. **Il frontend è indietro rispetto al backend.** Confronto path eseguito: 21 rotte `/api/` registrate contro 15 raggiunte dal pannello. Mai chiamate: l'intero **§8.8** (reset 2FA a quattro occhi, `/api/two-factor-resets` + approve/execute/cancel), l'intero **§8.9** (cambio email, 3 rotte), le tre rotte di **§18.12** (`POST /api/users/:id/roles`, `DELETE .../roles/:roleId`, `PUT .../permissions`), `/api/account/recovery-codes/{count,regenerate}` (§8.4) e `GET /api/audit/integrity` (§10, che il documento giustifica dicendo che «chi consulta deve poterla vedere»). Non è estetica: `web/src/routes/users.tsx:415` dice all'operatore che «senza due owner il reset a quattro occhi non esiste più», riferendosi a un flusso che dal pannello non si può avviare; e `GET /api/users/grantable-roles` viene interrogata senza alimentare nessuna mutation. Il pannello, oggi, non sa assegnare un ruolo.

**Alta**

3. **SEC-25 parziale.** Verificato di persona in `src/http/routes/auth.ts`: `HASHING_PATHS` ha cinque rotte (:27-33) ma il consumo dei limitatori è dentro `if (LOGIN_PATHS.has(subPath))` (:83-91), e `LOGIN_PATHS` ne ha tre. `/change-password`, `/two-factor/enable` e `/two-factor/disable` arrivano ad Argon2 senza consumare un token.
4. **SEC-45 divergente.** `src/email/mailer.ts:92-95` passa `tags: [{name:'click_tracking', value:'disabled'}]`: i tag Resend sono metadata, il click tracking è un'impostazione **di dominio**. La riga sembra il controllo e non lo è; i token di invito e reset restano riscrivibili da un redirector terzo.
5. **§8.10 — email di offboarding assente.** `offboardingNotice()` esiste già scritta (`src/email/templates/notices.ts:247`) ed è l'unico export del file che nessuno importa; `src/http/routes/users.ts:533-590` non chiama mai `ctx.mailer`. Dimenticanza, non scelta.
6. **SEC-07 parziale.** Il rifiuto di `canGrantRole` scrive audit `denied`/severità alta; il rifiuto di `canGrantLevel` lancia `BadRequest` nudo (`src/http/routes/roles.ts:115-116`, `src/http/routes/users.ts:370-371`): due percorsi su quattro non lasciano traccia.

**Media**

7. **SEC-26** — `apiIp` è dichiarato (`src/ratelimit/limiter.ts:60`) e mai consumato: nessuna rotta autenticata ha un tetto. Invito e reset password compongono IP+account senza tetto globale.
8. **§10 / SEC-48** — `SECURITY_ACTIONS` (`src/audit/actions.ts:85`) non è referenziato da nessun file: la regola «stessa transazione, mai hooks.after» è oggi disciplina personale con accanto una struttura dati che finge di imporla. `lockout` non viene mai scritto (`src/http/errors.ts:86` gestisce RateLimited senza audit) benché il §10 lo elenchi fra gli eventi obbligatori; `bootstrap-owner.ts:110` scrive la stringa letterale invece della costante, aggirando la garanzia per cui il catalogo esiste.
9. **Residui D-09 nel codice.** `src/http/server.ts:238` registra il successo della challenge TOTP di login come `AUDIT_ACTIONS.stepUpSucceeded` → nel registro ogni login 2FA compare come `auth.step_up.success`, non esiste un `auth.2fa.success`, e la tendina di filtro offre `auth.step_up.failure` che non può mai esistere. `STEP_UP_SECONDS=600` è ancora in `.env:24` (tolta da Zod e da `.env.example`, non dal file che `--env-file` carica). La colonna `amr` è scritta in tre punti e non letta da nessuno.
10. **SEC-35** — la regola c'è e passa, ma non fallisce nessuna build: `pnpm run check` non è invocato dal Dockerfile né da un hook git.
11. **Test §14: 5 proprietà su 17 non sono realmente sotto test** — test 4 (nessuna revoca seguita da una richiesta HTTP che risponda 403), test 5 (nessuna POST /api/invites sopra il livello dell'invitante), test 6 (ramo «modificare i permessi» solo a livello di funzione), test 8 seconda metà (rotazione del token dopo l'enrollment da invito mai asserita), test 16 (misura solo `/health/live`, mai le rotte statiche, e ~40 delle 60 richieste sono respinte dal rate limit prima di toccare Argon2). Nessuno di questi è stato indebolito con skip: sono proprietà non scritte.

**Bassa:** `idempotencyKey` con `Date.now()` (`src/http/routes/account.ts:416`); `ip_mismatch` sempre `true` dietro nginx (`deploy/nginx.conf:51`), quindi il segnale non segnala; tre export su cinque orfani in `guards.ts`; `.env`/`.env.example` disallineati su quattro chiavi e `RATE_LIMIT_IN_MEMORY` letta con `process.env` fuori dallo schema Zod.

**Documenti che affermano il falso** (lavoro chiudibile, non operativo): `docs/security/asvs.md:61` attesta lo step-up come controllo attivo e :56/:69/:94 citano la CI come attuatore; D-03 e D-05 descrivono un meccanismo che D-09 ha rimosso; il floor PostgreSQL è 18.6 nel §12 e «17 o superiore» in `docs/runbook.md:13`; il README annuncia 8 deviazioni su 9; `docs/stack-verifications.md` è tracciato e vuoto (3 byte).

### (b) Attività operative — nessun agente le chiude da solo

1. **Prova di restore mai eseguita.** Esiste solo la procedura. Nessun documento con data, esito e verifica della catena audit dopo il ripristino. Questo, da solo, blocca il go-live per esplicita ammissione del runbook.
2. **Backup non definito.** «pgBackRest o il PITR del provider», senza scelta, frequenza, retention, né prova che la partizione corrente dell'audit sia inclusa. Zero artefatti nel repository.
3. **Misura Argon2 sul VPS (D-02)** — dichiarata *obbligatoria prima del go-live* dalla deviazione stessa; esiste solo la misura su win32 con 12 campioni (`docs/spike-outcomes.md:155-165`).
4. **Test di carico (§18.14)** — metà è codice (scrivere i tre scenari, nessun autocannon/k6 nel repository) e metà è esecuzione sul VPS con budget login p95 < 400 ms.
5. **SPF/DKIM/DMARC** — non verificabili dal repository, nessuna evidenza datata, nessuno stato della progressione `p=none → reject`.
6. **Scheduling dei job.** `scripts/maintenance.ts` ha anchor/cleanup/verify e nulla li lancia: `grep setInterval|cron src/` trova solo le partizioni. Il runbook dichiara un job giornaliero che non esiste, e l'ancoraggio scrive un file locale demandando la copia fuori macchina all'operatore.
7. **CI assente.** Non è una mancanza in sé (il README la dichiara), ma è il **presupposto di cinque affermazioni oggi false**: D-07 e D-08 si autolimitano perché «in CI gira il percorso vero», D-04 giustifica `unsafe-inline` con «guardie che fallirebbero la build», §16.10 vuole la matrice Node 24/26, §17.3 vuole le credenziali di migration solo in CI.
8. **Gate supply chain** — `pnpm audit`/`osv-scanner` non sono in `check`, non c'è Renovate né Dependabot, e nulla registra che siano mai stati eseguiti su questo lockfile (better-auth: 1 maintainer, nel percorso di autenticazione).
9. **Verifica cookie in DevTools (SEC-04)** e permessi `/app` nel container (`WORKDIR` creata da root prima di `USER node`, `AUDIT_ANCHOR_PATH` non scrivibile di default).

### (c) NON sono buchi: deviazioni già documentate e implementate come dichiarano

Verificate una per una nel codice, non nel registro: **D-09** (step-up rimosso — rotta assente, `requireStepUp` assente, `STEP_UP_SECONDS` fuori da Zod: il requisito SEC-36 non va contato fra le mancanze), **D-02** (Argon2 sotto il minimo OWASP, parametri esatti a `src/auth/password.ts:26-30`), **D-03** (solo TOTP, niente passkey), **D-04** (`style-src 'unsafe-inline'` con script-src nonce+strict-dynamic), **D-06** (`useSecureCookies:false` con `secure:true` esplicito), **D-08** (fallback `RateLimiterMemory` con insuranceLimiter). Nel loro nucleo tecnico sono tutte fatte come scritte.

Due precisazioni severe, però: **D-04, D-07 e D-08 dichiarano come compensazione un ambiente che non esiste**, quindi la deviazione è documentata ma la sua compensazione no — vanno riscritte o va ripristinata la CI. E **D-01** presenta come già in essere «NTP monitorato con allarme sopra 5 secondi» di cui nel repository non c'è una sola traccia. Infine, la rimozione della CI e la scelta del dominio apex `metamc.it` al posto di `mail.metamc.it` sono raccontate nel README e nel runbook ma **non registrate in `deviations.md`**, cioè fuori dal registro che il §17.7 rende obbligatorio: quelle due sì, sono buchi di processo.

---

## 4. Minimo indispensabile per la produzione

In quest'ordine. I punti marcati **[op]** richiedono un umano con accesso a VPS/DNS/provider.

1. **`key_version` nel prefisso di ogni ciphertext + colonna nello schema**, finché il database è vuoto — oppure decidere di non farlo e registrarlo come deviazione numerata con data di rientro. È l'unica scelta che dopo il go-live diventa irreversibile a costo di un reset TOTP globale.
2. **[op] Scegliere e configurare il backup** (uno, con frequenza e retention scritte), verificando che includa la partizione audit corrente.
3. **[op] Eseguire un restore reale, datarlo, e verificare la catena audit dopo il ripristino** — l'esito va in `docs/stack-verifications.md`, che è vuoto e serve esattamente a questo.
4. **[op] Schedulare `anchor` giornaliero, `cleanup` e `verify`**, e portare l'ancoraggio fuori macchina invece che su file locale con nota all'operatore.
5. **Rate limit sulle tre rotte di hashing scoperte** (`/change-password`, `/two-factor/{enable,disable}`) e consumo di `apiIp` sulle rotte autenticate.
6. **[op] Disattivare il click tracking sul dominio Resend** (impostazione di dominio, non tag) e aggiungere il passo al runbook; rimuovere la riga `tags` che finge di essere il controllo.
7. **Chiudere il divario frontend/backend**: UI per le tre rotte di assegnazione ruoli/permessi (§18.12) e per il reset 2FA a quattro occhi (§8.8). Senza il primo il pannello non fa RBAC; senza il secondo la compensazione che D-09 rivendica non è azionabile. Per §8.9, §8.4 e `/api/audit/integrity`: o UI, o rimozione delle rotte con deviazione registrata.
8. **Scrivere i tre scenari di carico** (20 login concorrenti, 20 dashboard, 50 login falliti/s) **e [op] eseguirli sul VPS** insieme alla misura Argon2 che D-02 dichiara obbligatoria.
9. **[op] SPF/DKIM/DMARC configurati e datati**, e deviazione numerata per il dominio apex; **[op] `pnpm audit` + `osv-scanner` eseguiti e registrati** su questo lockfile.
10. **Email di offboarding** (il template è già scritto), **audit sui rifiuti di `canGrantLevel`**, **`auth.2fa.success` al posto di `auth.step_up.success`** e pulizia del catalogo azioni.
11. **Riallineare i documenti**: deviazione per la rimozione della CI, D-03/D-05 marcate superate da D-09, righe ASVS che attestano controlli inesistenti, floor PostgreSQL coerente fra §12 e runbook, `.env`/`.env.example`, conteggio deviazioni nel README.
12. **Scrivere le cinque proprietà §14 non coperte** (test 4, 5, 6, 8-seconda-metà, 16) — e **[op] eseguire la suite almeno una volta**, che a oggi non è mai successo.

I punti 1-4 sono la soglia. Sotto quella, andare in produzione significa accettare un reset TOTP futuro, un backup che nessuno ha mai provato a riaprire, e un registro audit la cui ancora non viene mai scritta.