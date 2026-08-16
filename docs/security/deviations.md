# Deviazioni documentate

Richiesto letteralmente da ASVS 7.1.1 e dalle note del capitolo V6: una
deviazione non documentata è un difetto; una deviazione documentata, motivata e
con una data di rientro è una decisione.

Ognuna riporta: da cosa devia, perché, cosa la compensa, quando rientra.

---

## D-01 — TOTP window = 1 (contro ASVS 6.5.5)

**Da cosa devia.** ASVS 5.0 §6.5.5 tollera finestre più ampie per assorbire lo
skew degli orologi.

**Cosa facciamo.** `window = 1`: tre step da 30 secondi, 90 secondi totali.

**Perché.** NIST SP 800-63B §3.1.4.1 pone il limite a due minuti. Window 2
sarebbe 150 secondi, cioè sopra quel limite. La finestra più stretta riduce
anche la superficie del replay.

**Cosa la compensa.** NTP configurato e monitorato sul server, con allarme se
lo skew supera 5 secondi: con window=1 il margine è 30 secondi per lato, quindi
un allarme a 5 secondi lascia sei volte il margine necessario.

**Rientro.** Nessuno previsto: è una deviazione verso il *più stretto*.

---

## D-02 — Argon2id m=19456 (contro RFC 9106 SECOND RECOMMENDED)

**Da cosa devia.** RFC 9106 raccomanda in seconda istanza m=65536 (64 MiB).

**Cosa facciamo.** m=19456 (19 MiB), t=2, p=1 — il floor OWASP — più un pepper
di 32 byte derivato da HKDF e un semaforo sugli hash concorrenti.

**Perché.** 64 MiB × N login concorrenti su un threadpool libuv condiviso è un
DoS a costo zero: bastano poche richieste per saturare la memoria e i thread
che servono anche `fs` e `dns`. Con 12 hash in volo a m=65536 servirebbero
768 MiB del solo Argon2.

**Cosa la compensa.** Il moltiplicatore di sicurezza in questo sistema non è la
memoria per hash: è il 2FA obbligatorio (nessun accesso sotto aal=2), il rate
limiting composto in AND, e il controllo HIBP fail-closed sulle password nuove.
Una password rubata senza il secondo fattore non apre nulla.

**Misura.** Sulla macchina di sviluppo: p50 8,4 ms. Sul VPS attendersi 3-6×.
**La misura sul VPS di produzione è obbligatoria prima del go-live** (§5.2):
target singolo hash < 100 ms, login p95 < 400 ms.

**Rientro.** Si rivaluta quando il VPS ha memoria e core in eccesso rispetto al
picco misurato, non prima.

---

## D-03 — Nessun fattore phishing-resistant in fase 1

**Da cosa devia.** NIST SP 800-63B-4 §2.3.2 richiede almeno un'opzione
phishing-resistant ad AAL2. TOTP non lo è: un sito di phishing convincente
raccoglie il codice e lo rigioca entro i 30 secondi.

**Cosa facciamo.** In fase 1 il secondo fattore è solo TOTP, e anche lo step-up
passa da TOTP.

**Perché.** La passkey tocca cinque sottosistemi (enrollment, login, step-up,
recovery, offboarding) già in consegna in questa fase. Aggiungerla ora
significa consegnare male sei cose invece che bene cinque.

**Cosa la compensa.** Anti-replay TOTP con doppia guardia (Redis + colonna
durevole), window stretta, rate limit con backoff esponenziale, e il controllo
`Origin` + `Sec-Fetch-Site` che rende inefficace il phishing da un dominio
diverso *per le richieste autenticate* — non per la raccolta delle credenziali,
che resta il buco.

**Rientro.** Fase 1.5, **entro 60 giorni dal go-live**: passkey obbligatoria
per chiunque abbia livello 3 su almeno un modulo. La tabella
`auth.webauthn_credential` è già creata e vuota, quindi è una migration
additiva. Floor `@simplewebauthn/server >= 13.3.2`.

---

## D-04 — `style-src 'self' 'unsafe-inline'`

**Da cosa devia.** Una CSP rigorosa non ammette stile inline.

**Cosa facciamo.** `script-src` usa nonce + `strict-dynamic` senza
`unsafe-inline`; `style-src` ammette `'unsafe-inline'`.

**Perché.** React e le primitive Radix iniettano stile inline, e il pannello
usa `style={{...}}` in modo diffuso per consumare i token. Un nonce per ogni
blocco di stile richiederebbe di rinunciare a entrambi.

**Cosa la compensa.** L'XSS via CSS è molto più debole di quello via script:
non esegue codice, e i vettori di esfiltrazione via CSS sono già chiusi da
`connect-src 'self'`, `img-src 'self' data:` e `font-src 'self'`. Il divieto
assoluto di `innerHTML` (SEC-35, imposto da una guardia che fallisce la build)
chiude la via d'ingresso principale.

**Rientro.** Quando il pannello avrà un foglio di stile statico e nessuno stile
inline generato a runtime. Non è previsto in fase 1.5.

---

## D-05 — Step-up con TOTP invece che con passkey

Conseguenza diretta di D-03: rientra con quella, stessa data.

Nota su cosa lo step-up protegge davvero anche così: SEC-36 esiste perché un
XSS che ruba una sessione **non possa promuoversi in silenzio**. Contro quel
modello di minaccia il TOTP funziona, perché l'attaccante non ha il segreto.
Contro il phishing no, ed è D-03.

---

## D-06 — `useSecureCookies: false` in better-auth

**Non è una deviazione di sicurezza: è il contrario**, ed è qui perché la riga
letta da sola sembra un downgrade.

`useSecureCookies: true` antepone `__Secure-` al nome del cookie **già
prefissato**, producendo `__Secure-__Host-metamc_session`: un doppio prefisso
invalido, che il browser tratta come un `__Secure-` qualunque. La garanzia di
`__Host-` (nessun `Domain`, `Path=/` obbligatorio, non scrivibile da un
sottodominio) sparirebbe in silenzio, e il login continuerebbe a funzionare.

L'attributo `Secure` viene messo esplicitamente in
`advanced.cookies.session_token.attributes`. Verificato dallo SPIKE-2, e la
verifica in DevTools dopo il deploy resta obbligatoria (§8.2).

---

## D-07 — PostgreSQL 18.4 in sviluppo locale invece di 18.6

**Solo ambiente di sviluppo.** Il floor 18.6 vale in CI (container
`postgres:18.6`) e in produzione. La macchina di sviluppo su cui è stata
scritta la fase 1 aveva la 18.4 installata e nessun container runtime.

**Perché conta.** Le 18.x precedenti alla 18.6 hanno 28 CVE pubblicati il
2026-08-13, diverse RCE con CVSS 8.8. Un ambiente di sviluppo non espone quelle
superfici, ma l'ambiente di test dovrebbe girare sulla stessa minor della
produzione per non nascondere differenze di comportamento.

**Rientro.** Immediato appena esiste un container runtime sulla macchina di
sviluppo. La CI usa già la 18.6.

---

## D-08 — Rate limiter su store in memoria nei test locali

**Solo ambiente di test locale**, quando `TEST_REDIS_URL` non è impostata.

`rate-limiter-flexible` su Redis gira uno script Lua via `EVAL`. Il server
RESP2 minimale usato in assenza di un container runtime non implementa `EVAL`,
e implementarlo richiederebbe un interprete Lua — cioè una seconda
implementazione da mantenere.

Nel fallback i test di rate limit usano `RateLimiterMemory`, che è un backend
di prima classe della stessa libreria: cambia dove sta il contatore, non la
politica sotto test.

**In CI la variabile è impostata** e i test girano sul backend Redis vero, con
lo script Lua, esattamente come in produzione.
