# Esiti degli spike bloccanti (§15) — 16 agosto 2026

Ogni spike e' riproducibile: `node spikes/spike-N-*.ts`. Girano tutti sull'adapter
`memory` di better-auth, perche' verificano comportamento di libreria, non persistenza.

| Spike | Esito | Ramo preso |
|---|---|---|
| SPIKE-1 — hook del plugin `twoFactor` | **superato** | Plugin `twoFactor` registrato. Guardia anti-replay negli hook `before`/`after`. `otpauth` **non** installato, `auth."twoFactor"` resta la tabella. |
| SPIKE-2 — cookie `__Host-` | **superato, con una condizione** | Cookie gestito da better-auth. Obbligatorio `advanced.useSecureCookies: false`. |
| SPIKE-3 — plugin `haveibeenpwned` | **fallito su (c)** | Plugin **non** registrato: client HIBP nostro (§8.6). |
| SPIKE-4 — prebuild `@node-rs/argon2` 2.1.0 | **superato** | Pin `2.1.0` confermato. |
| SPIKE-5 — body parsing better-auth su Fastify | **superato** | Ponte Fastify→better-auth confermato, parser raw dedicato ai webhook. |

---

## SPIKE-1 — Hook del plugin `twoFactor` — SUPERATO

Verificato su `better-auth@1.6.29`:

- **(a)** un `hooks.before` costruito con `createAuthMiddleware` intercetta
  `ctx.path === '/two-factor/verify-totp'`, vede `ctx.body` (`{ code: "836470" }`)
  e puo' rifiutare lanciando `APIError`. La richiesta non arriva all'handler.
- **(b)** un `hooks.after` sullo stesso path viene invocato dopo una verifica
  riuscita e `ctx.context.returned` e' popolato con la risposta.

**Conseguenza per SEC-11**: la guardia anti-replay TOTP e' implementabile
esattamente come descritta nel §11 — `before` legge `code`, deriva lo step da
`Date.now()`, rifiuta se `totp:used:{userId}:{step}` esiste o se
`step <= last_totp_step`; `after` marca i tre step della finestra e alza
`last_totp_step`.

**Osservazione aggiuntiva, rilevante per SEC-06**: `verifyTOTP` restituisce un
`token` **nuovo**. La rotazione della sessione dopo il 2FA e' quindi gia' nel
comportamento della libreria; il test 8 la verifica comunque, perche' e' una
proprieta' nostra e non deve dipendere da un dettaglio implementativo altrui.

**Osservazione aggiuntiva, rilevante per SEC-14**: `enableTwoFactor` restituisce
10 `backupCodes` del plugin. Vanno neutralizzati come previsto: rotte bloccate a
404 e colonna sovrascritta con byte casuali subito dopo l'enrollment.

---

## SPIKE-2 — Cookie `__Host-` — SUPERATO, con una condizione non ovvia

Il primo tentativo e' **fallito**, e il modo in cui e' fallito e' il risultato utile:

```
advanced: { useSecureCookies: true, cookies: { session_token: { name: '__Host-metamc_session' } } }
  ->  Set-Cookie: __Secure-__Host-metamc_session=...
```

`useSecureCookies: true` antepone `__Secure-` al nome **gia' prefissato**,
producendo un doppio prefisso invalido. Il browser tratterebbe il cookie come un
`__Secure-` qualunque e la garanzia di `__Host-` (nessun `Domain`, `Path=/`
obbligatorio, non scrivibile da un sottodominio) sparirebbe in silenzio — che e'
esattamente il fallimento "il login non funziona a caso" temuto dal §8.2, in
versione peggiore perche' il login funziona e la protezione no.

Configurazione corretta, verificata:

```
advanced: {
  useSecureCookies: false,          // NON e' un downgrade: Secure lo mettiamo negli attributi
  cookies: { session_token: {
    name: '__Host-metamc_session',
    attributes: { path: '/', secure: true, httpOnly: true, sameSite: 'strict' },
  } },
}
```

Set-Cookie ottenuto:

```
__Host-metamc_session=...; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Strict
```

Tutti i controlli SEC-04 passano: prefisso corretto, `Path=/`, `Secure`,
`HttpOnly`, `SameSite=Strict`, **nessun** `Domain`, **nessun** `Partitioned`.

`Max-Age` di default e' 7 giorni: va portato a 8h con `session.expiresIn`, e in
ogni caso il tetto vero e' la colonna `absolute_expires_at` (SEC-05), che non
dipende dal cookie.

La verifica manuale in DevTools dopo il deploy resta obbligatoria (§8.2): questo
spike prova cosa genera la libreria, non cosa sopravvive a nginx.

---

## SPIKE-3 — Plugin `haveibeenpwned` — FALLITO sul requisito (c)

| Requisito | Esito |
|---|---|
| (a) k-anonymity: solo 5 caratteri di prefisso sul filo | passato — `GET /range/50CAD`, il suffisso non compare mai |
| (b) header `Add-Padding: true` | passato — inviato letteralmente |
| (c) **timeout configurabile** | **fallito** |
| (d) fail-closed su errore di rete | passato — ogni errore diventa `INTERNAL_SERVER_ERROR` |

Il sorgente di `better-auth/plugins/haveibeenpwned` chiama:

```js
betterFetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
  headers: { "Add-Padding": "true", "User-Agent": "BetterAuth Password Checker" }
})
```

Nessun `timeout`, nessun `signal`, e le opzioni del plugin (`paths`, `enabled`,
`customPasswordCompromisedMessage`) non ne espongono uno. Il timeout di 2 s
richiesto dal §8.6 **non e' impostabile**.

Si prende il piano B del §15: **client HIBP nostro** — `fetch` globale con
`Agent` keep-alive, timeout 2 s, `Add-Padding: true`, fail-closed. Il plugin non
viene registrato.

Due ragioni indipendenti confermano che il piano B era comunque la scelta giusta:

1. Il §8.6 richiede che il fallimento HIBP produca **una voce nell'audit log**.
   Il plugin lancia un `APIError` e non ha accesso al nostro contesto di audit:
   non potrebbe scriverla.
2. Il plugin si aggancia avvolgendo `ctx.password.hash`, cioe' esegue una
   **chiamata di rete esterna dentro il percorso di hashing**. Se quel percorso
   finisse dentro una transazione che scrive audit, violerebbe la regola non
   negoziabile del §10. Con un client nostro il controllo HIBP resta dove deve
   stare: prima di aprire la transazione.

---

## SPIKE-4 — `@node-rs/argon2` 2.1.0 — SUPERATO

Prebuild dichiarati (13 in totale). Presenti entrambe le coppie glibc che servono
all'immagine `-slim` del §17.6:

- `@node-rs/argon2-linux-x64-gnu@2.1.0`
- `@node-rs/argon2-linux-arm64-gnu@2.1.0`

Nessun fallback a `2.0.2`, nessun ricorso a `crypto.argon2` nativo.

Funzionalita' verificate a `m=19456, t=2, p=1, outputLen=32`:

- PHC string prodotta: `$argon2id$v=19$m=19456,t=2,p=1$...`
- `secret` (pepper) esposto e **realmente in gioco**: `verify` con un pepper
  diverso restituisce `false`.

**Errore del documento**: il §3.3 afferma che il modulo "restituisce PHC string
con `needsRehash`". `needsRehash` **non e' esportato** da `@node-rs/argon2@2.1.0`.
Export reali: `hash, hashRaw, hashSync, hashRawSync, verify, verifySync,
Algorithm, Version, HashTask, RawHashTask, VerifyTask`.
Sostituto adottato: i parametri si leggono dalla PHC string con una regex e si
confrontano con quelli correnti; la rotazione del pepper e' gia' governata dalla
colonna `pepper_version` (SEC-40), che e' il trigger piu' affidabile dei due.

Nota di integrazione: il modulo e' **CommonJS**. In un progetto `"type": "module"`
va importato come default (`import argon2 from '@node-rs/argon2'`), non con named
import.

Costo misurato **su questa macchina di sviluppo** (win32-x64), non sul VPS:

```
p50 = 8,4 ms   p95 = 9,8 ms   (12 campioni)
12 hash concorrenti con UV_THREADPOOL_SIZE=4: 55 ms totali
picco RAM stimato a 12 hash in volo: 228 MiB di solo Argon2
```

La misura sul VPS di produzione resta **obbligatoria prima del go-live** (§5.2).
Il numero locale conferma solo che i parametri sono sani, non che il target
`login p95 < 400 ms` sia raggiunto in produzione.

---

## SPIKE-5 — Body parsing di better-auth su Fastify — SUPERATO

Server Fastify reale, handler better-auth montato su `/api/auth/*`, verificato
con `app.inject`:

- **(a)** `sign-up` e `sign-in` passano attraverso il ponte
  (`JSON.stringify(request.body)` → `new Request(...)` → `auth.handler`).
- **(b)** il `Set-Cookie` `__Host-metamc_session` sopravvive intatto al ponte:
  gli header della `Response` vanno ricopiati uno a uno sulla reply.
- **(c)** un `addContentTypeParser('application/json', { parseAs: 'buffer' })`
  che ramifica sull'url consegna al webhook il **Buffer grezzo** e a tutte le
  altre rotte l'oggetto parsato. La firma HMAC calcolata sul raw verifica.
- **(c) / test 17** — con un body dalla spaziatura non canonica, la firma sul raw
  e' valida mentre la firma ricalcolata dopo `JSON.parse` + `JSON.stringify`
  **non lo e'**. Il raw body e' quindi davvero necessario, e il test 17 ha un
  motivo reale di esistere.
- **(d)** `bodyLimit: 4096` sulla rotta `/api/auth/*` restituisce **413** su un
  payload da 8 KB (SEC-29).
- **(e)** regressione CVE-2026-33806: `Content-Type: " application/json"` con
  spazio iniziale su una rotta con JSON Schema restituisce **400
  FST_ERR_VALIDATION**, non un bypass. Il floor `fastify >= 5.8.5` e' rispettato
  dal pin `5.12.0`.
