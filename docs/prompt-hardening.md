# Prompt — interventi post-audit su MetaMC Admin (sistema in produzione)

> Copia dal blocco `<contesto>` in giù e incollalo nella sessione Claude Code che sta lavorando al codice.

---

<contesto>
Il pannello MetaMC è **in produzione**. Un audit di conformità al documento normativo `docs/stack-decisions.md` ha prodotto cinque interventi concordati con il committente, elencati sotto in ordine di priorità. Il rapporto completo è in `docs/audit-fase1.md`.

Le altre voci del rapporto **non** sono in perimetro: il committente ha già deciso su backup (ne esiste già uno), click tracking (disattivo di default su Resend) ed esecuzione della suite. Non riaprirle.

Correzione al rapporto, già verificata nel codice: il rilievo su `key_version` (SEC-40) partiva da un presupposto sbagliato. In `src/` non esiste codice di cifratura — il segreto TOTP lo cifra better-auth con la propria chiave. Non c'è alcun testo cifrato nostro da versionare. Di quel rilievo resta valido solo l'intervento 4.
</contesto>

<vincoli_di_produzione>
Il sistema gira e ha utenti reali. Da questo discendono vincoli che valgono per ogni intervento:

- **Le migration 001-009 sono applicate: non modificarle mai.** Servisse un cambiamento di schema, è una nuova migration `010_*`. Nessuno dei cinque interventi dovrebbe richiederne una: verificalo prima di scriverla.
- **Non cambiare la derivazione delle chiavi esistenti.** In `src/crypto/keys.ts` la stringa `info` di ogni chiave *è* la chiave: toccare `argon2-pepper-v1` invaliderebbe tutte le password, toccare `better-auth-secret` invaliderebbe tutte le sessioni e renderebbe indecifrabili i segreti TOTP.
- **L'audit log è append-only e a catena hash: non si riscrive il passato.** Dove un valore va rinominato, è un cambiamento in avanti, e le righe già scritte restano com'erano.
- Non puntare i test contro il database di produzione.
- `pnpm run check` deve restare verde: guardie, identificatori, dipendenze pinnate, typecheck, Biome.
- Nomi in inglese nel codice e nei commit, testo dell'interfaccia in italiano.
</vincoli_di_produzione>

<interventi>

## 1 — Schedulare `anchor`, `cleanup`, `verify` (priorità massima)

`scripts/maintenance.ts` espone quattro comandi (`anchor`, `partitions`, `cleanup`, `verify`), ma l'unico che gira da solo è `partitions`, che si autoschedula in `src/audit/partitions.ts:95`. Gli altri tre non li lancia nessuno: in produzione, adesso, l'ancoraggio esterno della catena audit non viene mai scritto, inviti e sessioni scaduti non vengono mai ripuliti, e l'integrità non viene mai verificata.

La catena hash è corretta. Quello che manca è la parte che la rende utile.

Segui il modello già scelto per le partizioni — **è l'applicazione che tiene i propri job, niente cron esterno** — e applicalo agli altri tre. L'istanza è una sola (§1.2 del documento normativo), quindi non serve elezione del leader; se in futuro diventassero due, il punto in cui aggiungere un lock va segnato con un commento, non implementato ora.

Cadenze da §10 e §17: ancoraggio giornaliero, verifica dell'integrità giornaliera, pulizia con la frequenza che il codice di `cleanup` rende sensata — decidila leggendo cosa fa, e motivala in una riga di commento.

Il fallimento di un job non deve abbattere il processo: va loggato con `pino` a livello error ed esposto in `/internal/metrics`. Se `verify` trova la catena rotta, è la condizione più grave che il sistema possa rilevare: trattala come tale.

L'ancoraggio oggi scrive un file locale. **Non cambiare la destinazione**: portarlo fuori dalla macchina è una decisione infrastrutturale del committente. Rendi il percorso configurabile se non lo è già, e segnala a fine lavoro, in una riga, che la copia off-machine resta aperta.

## 2 — Rate limit sulle tre rotte di hashing scoperte (SEC-25)

In `src/http/routes/auth.ts`, `HASHING_PATHS` (riga ~27) elenca cinque rotte che finiscono in Argon2, ma il consumo dei limitatori è dentro `if (LOGIN_PATHS.has(subPath))` (riga ~83), e `LOGIN_PATHS` ne contiene tre. Restano scoperte:

- `/change-password`
- `/two-factor/enable`
- `/two-factor/disable`

Sono raggiungibili adesso e arrivano all'hash senza consumare nulla.

Una differenza rispetto al login cambia la chiave del limitatore: queste tre rotte sono **autenticate**. Il soggetto da limitare è l'utente della sessione, non solo l'IP — chi ha rubato una sessione cambia IP a piacere. Componi per utente **e** per IP.

Nello stesso intervento: `apiIp` è dichiarato in `src/ratelimit/limiter.ts:60` e non consumato da nessuna rotta. Era il tetto globale del SEC-26, cioè l'unica difesa contro IP falsificati. Collegalo alle rotte autenticate.

Vale sempre la regola del SEC-25: il token si consuma **prima** di qualunque chiamata ad Argon2.

## 3 — Interfaccia per cambiare ruolo a un utente

Il backend è completo e corretto: `POST /api/users/:id/roles` (`src/http/routes/users.ts:241`), `DELETE /api/users/:id/roles/:roleId` (`:307`), `PUT /api/users/:id/permissions` (`:347`). Il frontend non ne chiama nessuna — la mutation generica in `web/src/routes/users.tsx:402` manda solo a `ban`, `unban`, `revoke-sessions`, `offboard`, `delete`.

Conseguenza operativa: oggi promuovere qualcuno o togliergli un modulo si fa solo dal database.

Nel pannello di dettaglio utente servono: assegnazione e rimozione di un ruolo, e modifica dell'override individuale per modulo — che è **solo in aumento**, nessuna semantica di deny (§7).

`GET /api/users/grantable-roles` è già interrogata in `users.tsx:623` e la risposta non viene usata: è esattamente l'elenco da mostrare. Il client non ricalcola i permessi — riceve dal server ciò che può fare e disegna.

Cura gli errori che il server già distingue: il rifiuto per concedibilità (nessuno concede ciò che non ha, SEC-07) e quello per dominanza (nessuno tocca chi lo domina, SEC-08) devono produrre due messaggi diversi e comprensibili, non un errore generico.

Visivamente: token da `design/tokens.css`, coerenza con il pannello esistente, nessun colore letterale.

Nota: `src/http/routes/users.ts:238` porta ancora un commento che cita lo step-up del §8.5, rimosso con la deviazione D-09. Correggilo mentre sei lì.

## 4 — Far leggere `pepper_version`

`docs/runbook.md` promette che, ruotato il pepper, gli hash si aggiornano al login successivo. Non succede: `PEPPER_VERSION` è validata in `src/config/env.ts:44` e non letta da nessuna riga, e `needsRehash()` in `src/auth/password.ts:62` non ha chiamanti. La colonna `pepper_version` esiste già sulla riga utente (migration 002), quindi **non serve una migration**.

Da implementare: la verifica della password usa il pepper corrispondente al `pepper_version` di *quell'utente*; se quella versione non è la corrente, dopo una verifica riuscita l'hash viene rigenerato con il pepper corrente e la colonna aggiornata.

Il vincolo che rende la cosa delicata in produzione: **il pepper della versione 1 deve restare esattamente quello che è oggi**, cioè `HKDF(MASTER_KEY, info='argon2-pepper-v1')`. Le versioni successive aggiungono un `info` nuovo, non sostituiscono quello esistente. Se dopo l'intervento un utente esistente non riesce più ad autenticarsi, l'intervento è sbagliato.

Il ri-hash avviene dentro il percorso di login, quindi passa dal semaforo Argon2 come tutto il resto: non deve poter raddoppiare gli hash in volo.

## 5 — Pulizia di ciò che mente

Piccoli, ma ognuno induce in errore chi legge il codice dopo.

- `src/email/mailer.ts:92` passa `tags: [{name:'click_tracking', value:'disabled'}]`. I tag di Resend sono metadata: quella riga non disattiva niente. Il click tracking è un'impostazione di dominio ed è già disattivo di default. Togli la riga; se serve, lascia un commento che dica dove sta davvero l'impostazione.
- `.env:24` contiene ancora `STEP_UP_SECONDS=600`, rimosso da Zod e da `.env.example` ma non dal file che `--env-file` carica davvero.
- `src/http/server.ts:238` registra la challenge TOTP di login come `AUDIT_ACTIONS.stepUpSucceeded`: nel registro ogni login con 2FA compare come `auth.step_up.success`, non esiste un `auth.2fa.success`, e il filtro del pannello offre `auth.step_up.failure`, che non può esistere. Introduci l'azione corretta **in avanti**; le righe già scritte restano com'erano — la catena hash le rende immutabili per costruzione — quindi il filtro deve continuare a mostrare anche il valore storico, con un'etichetta che non confonda.
- Mentre tocchi il catalogo: `SECURITY_ACTIONS` in `src/audit/actions.ts:85` non è referenziato da nessun file, e `scripts/bootstrap-owner.ts:110` scrive una stringa letterale invece della costante.

</interventi>

<metodo>
Fai i cinque interventi nell'ordine dato: 1 e 2 sono superficie viva, 3 è un buco operativo quotidiano, 4 e 5 sono debito.

Un commit per intervento, con il codice `SEC-xx` citato dove ce n'è uno. `pnpm run check` verde prima di ogni commit.

Dove aggiungi comportamento che il §14 rende verificabile — il rate limit sulle tre rotte, il ri-hash del pepper — aggiungi il test insieme al codice, nello stile di quelli esistenti in `tests/acceptance/`.

Se durante il lavoro scopri che uno dei cinque rilievi è sbagliato come lo era SEC-40, dillo con la prova e fermati su quel punto, invece di implementare la correzione di un problema inesistente.

Non fare push. Non toccare la produzione.
</metodo>

<comunicazione>
Prima della prima chiamata a uno strumento, una frase su cosa stai per fare. Poi aggiornamenti solo quando chiudi un intervento o cambi direzione. Chiudendo, apri con l'esito: cosa è cambiato e cosa resta aperto.

Risposte asciutte: il valore è nel codice.
</comunicazione>

<scope>
Cinque interventi, quelli elencati. Non allargare ad altre voci del rapporto di audit, non rifattorizzare ciò che tocchi solo di passaggio, non aggiungere dipendenze. Le decisioni di routine prendile da solo; fermati a chiedere solo se due letture ragionevoli portano a lavori diversi.
</scope>
