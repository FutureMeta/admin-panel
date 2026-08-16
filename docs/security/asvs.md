# Mappatura ASVS 5.0 — Livello 2

§17.8. **L2, non L3**: L3 è dimensionato per sistemi che gestiscono dati di
terzi ad alto valore o vite umane. Questo è uno strumento interno per 10-50
persone; L3 aggiungerebbe costo senza aggiungere difesa contro il modello di
minaccia reale, che è: credenziali rubate, un insider che escala, un
sottodominio compromesso.

Capitoli coperti: **V2, V3, V6, V7, V8, V11, V13, V14, V16**.

Legenda: ✅ implementato · ⚠️ deviazione documentata · ⏳ fase 1.5

---

## V2 — Validazione, sanitizzazione, codifica

| Requisito | Stato | Dove |
|---|---|---|
| Validazione al confine, schema dichiarativo | ✅ | JSON Schema + AJV su ogni rotta. Zod solo per env e webhook, dopo la verifica della firma |
| La validazione non è l'unico enforcement | ✅ | SEC-38: `roleId`, `moduleKey` e `level` rivalidati nell'handler contro la fonte di verità |
| Nessun input in un identificatore SQL | ✅ | SEC-37: i filtri dell'audit sono una allowlist enumerata; il client manda una chiave, non un nome di colonna |
| Output encoding contestuale | ✅ | SEC-35: divieto assoluto di `innerHTML`, imposto da una guardia che fallisce la build. Il jsonb dell'audit passa da `JSON.stringify` dentro un `<pre>` |
| Sanitizzazione dei log | ✅ | §10: CR/LF e caratteri di controllo rimossi prima dell'INSERT di audit |

## V3 — Sessione

| Requisito | Stato | Dove |
|---|---|---|
| Token opaco, generato dal server | ✅ | better-auth, 32 byte da Web Crypto |
| Rotazione a ogni cambio di privilegio | ✅ | SEC-06, test 8: token nuovo dopo il 2FA e dopo l'enrollment |
| Timeout assoluto **e** di inattività | ✅ | SEC-05: 8h su `absolute_expires_at` (mai prorogata) + 30 min su `updatedAt` |
| Revoca puntuale e globale | ✅ | `sessrev:{id}` in Redis + `sessions_valid_from` sulla riga utente |
| Attributi del cookie | ✅ | SEC-04: `__Host-`, `Secure`, `HttpOnly`, `SameSite=Strict`, nessun `Domain`. Verificato dallo SPIKE-2 |
| Nessuna copia dello stato nel token | ✅ | SEC-02: `aal`, scadenze e permessi si leggono da Postgres, non dal blob di sessione |

## V6 — Autenticazione

| Requisito | Stato | Dove |
|---|---|---|
| Password ≥ 12 caratteri, nessuna regola di composizione | ✅ | §8.6. NIST SHALL NOT su composizione, rotazione, hint e domande segrete |
| Confronto con password violate | ✅ | HIBP con k-anonymity, `Add-Padding: true`, timeout 2s, **fail-closed** con voce di audit |
| Hashing moderno con salt | ⚠️ | Argon2id m=19456 (floor OWASP) + pepper da HKDF. **D-02** |
| MFA obbligatoria | ✅ | `twoFactorEnabled` è il gate hard: sotto aal=2 non si accede a nulla |
| Anti-replay OTP | ✅ | SEC-11, test 7. Doppia guardia: Redis + `last_totp_step` durevole |
| Finestra OTP | ⚠️ | window=1, 90s. **D-01** (deviazione verso il più stretto) |
| Fattore phishing-resistant | ⏳ | **D-03**, fase 1.5 entro 60 giorni. Tabella già creata |
| Recovery con entropia adeguata | ✅ | SEC-13: 128 bit, sopra la soglia dei 112 bit di NIST §3.1.2.2 |
| Nessun bypass del secondo fattore | ✅ | SEC-14, test 14: le rotte backup-code del plugin rispondono 404. Il reset password non emette sessione |
| Rate limiting e lockout | ✅ | SEC-24…27: limiti in AND per IP, account e rotta, con backoff esponenziale sul 2FA |
| Nessun oracolo di enumerazione | ✅ | SEC-30, test 15: hash-esca con parametri identici, latenza indistinguibile su 100 campioni per lato |

## V7 — Autorizzazione

| Requisito | Stato | Dove |
|---|---|---|
| Enforcement server-side, punto unico | ✅ | `can()` in `src/authz/`. Guardia di CI che fallisce la build sui confronti altrove |
| Deny by default | ✅ | Un utente senza ruoli ha 0 su tutti i moduli; `requireAuth` rifiuta prima dell'handler |
| Nessuna escalation orizzontale | ✅ | SEC-08, test 6: dominanza attore→bersaglio su ogni modulo |
| Nessuna escalation verticale | ✅ | SEC-07, test 5: concedibilità. Nessuno concede ciò che non ha |
| Nessun oracolo 403-vs-404 | ✅ | SEC-31, test 9: parametrico sulle 11 rotte con `:id` |
| Ri-autenticazione per operazioni sensibili | ⚠️ | Step-up TOTP entro 10 minuti, elenco chiuso. **D-05** |

## V8 — Autorizzazione a livello di dato

| Requisito | Stato | Dove |
|---|---|---|
| Privilegi DB minimi | ✅ | `metamc_app` non ha DDL; sull'audit ha solo INSERT e SELECT |
| Privilegi per colonna dove serve | ✅ | SEC-42: `metamc_app` non può aggiornare `secret` né `userId` su `auth."twoFactor"` |
| Segregazione dei ruoli DB | ✅ | `metamc_migrate` possiede il DDL, credenziali solo in CI |

## V11 — Crittografia

| Requisito | Stato | Dove |
|---|---|---|
| Una radice, chiavi derivate per scopo | ✅ | SEC-39: un solo `MASTER_KEY`, HKDF con `info` distinto |
| Versionamento delle chiavi dal primo schema | ✅ | SEC-40: `pepper_version` sulla riga utente, `key_version` nei ciphertext |
| Confronti a tempo costante | ✅ | `timingSafeEqual` su token CSRF e digest dei recovery code |
| Nessun segreto nel database | ✅ | SEC-41. Token e recovery code solo come SHA-256 |
| CSPRNG | ✅ | `crypto.randomBytes` per token di invito (256 bit), recovery code (128 bit), nonce CSP (128 bit) |

## V13 — API e servizi

| Requisito | Stato | Dove |
|---|---|---|
| Limiti sulla dimensione del body | ✅ | SEC-29: 64 KB globale, 4 KB su `/api/auth/*` |
| Metodi HTTP corretti | ✅ | SEC-18: nessuna rotta di scrittura in GET. Verificato all'avvio, non a runtime |
| Verifica dei webhook in ingresso | ✅ | SEC-19, test 17: firma Svix sul **raw body** + dedupe su `svix-id` |
| Nessuna azione di dominio da un webhook | ✅ | Il webhook Resend è osservativo: un servizio terzo non cambia lo stato del pannello |

## V14 — Configurazione

| Requisito | Stato | Dove |
|---|---|---|
| Dipendenze pinnate, lockfile committato | ✅ | Versioni esatte, verificato da una regola di CI |
| Superficie minima | ✅ | §4: nove componenti non installati, ognuno con la soglia di rientro |
| Nessuno script post-install | ✅ | `--ignore-scripts` in CI e nel Dockerfile |
| Container non-root, base pinnata | ✅ | `node:24.19.0-slim`, utente `node` |
| Nessun dettaglio interno negli errori | ✅ | Il gestore d'errore non espone stack, messaggi o nomi di tabella. Le sonde non dicono versioni né host |
| Segreti fuori dal codice | ✅ | Env validata al boot; il messaggio d'errore riporta il nome, mai il valore |

## V16 — Logging

| Requisito | Stato | Dove |
|---|---|---|
| Log degli eventi di sicurezza | ✅ | §10: catalogo chiuso di azioni, con la distinzione fra eventi di sicurezza (in transazione) e osservativi |
| Integrità del log | ✅ | SEC-47, test 1 e 2: privilegi + trigger + catena hash + verifica che restituisce 500 + ancoraggio esterno |
| Nessun dato sensibile nei log | ✅ | SEC-43: `redact` di pino configurato prima della prima riga. Mai OTP, segreti TOTP, recovery code o token |
| Identità dell'attore al momento del fatto | ✅ | §10: `actor_email`, `actor_display_name`, `target_label` denormalizzati |
| Tracciabilità della sorgente | ✅ | SEC-23: due IP registrati, con annotazione automatica quando divergono |

---

## Requisiti L2 non coperti, e perché

- **V4 (cifratura dei dati a riposo oltre i segreti)** — il database contiene
  email e nomi dello staff. Non ci sono dati di terzi, dati di pagamento né
  categorie particolari. La cifratura a riposo è delegata al volume del VPS.
- **V5 (file e risorse)** — il pannello non accetta upload in fase 1. Se in
  fase 2 servisse, V5 va riaperto per intero.
- **V9, V10, V12, V15** — riguardano comunicazione, business logic,
  configurazione di terze parti e dati sensibili in modi che questa fase non
  tocca. Vanno rivalutati quando la fase 2 introduce le statistiche di gioco,
  che portano dentro dati di giocatori — cioè di terzi.
