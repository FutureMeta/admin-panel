# Prompt per Claude Code — MetaMC Admin, Fase 1

> Copia tutto dal blocco `<contesto>` in giù e incollalo in Claude Code, aperto sulla cartella `admin-panel`.

---

<contesto>
Costruisci la fase 1 del pannello di amministrazione di **MetaMC**, un network Minecraft italiano.
È uno strumento interno per lo staff (owner, admin, dev, moderatori): 10-50 utenti, accesso solo su invito, nessuna registrazione pubblica.

Il perimetro della fase 1 è: **inviti, login, 2FA, sessioni, RBAC per modulo, audit log**, più le schermate che servono a usarli. Le statistiche di gioco (grafici, heatmap, mappa geografica) sono fase 2 e **non** vanno costruite ora.

Esiste già un pannello legacy con query lente. Non va portato avanti né migrato in questa fase: serve saperlo solo perché la fase 2 dovrà risolvere quel problema, e alcune scelte di fase 1 esistono per non precluderlo.

Lo stato attuale della cartella: `logo.png`, il prototipo di design `MetaMC Admin - standalone.html`, `design/tokens.css`, `docs/`. Nessun codice, nessun repository git — inizializzalo tu.
</contesto>

<documenti_normativi>
**`docs/stack-decisions.md` è vincolante.** È il risultato di una ricerca su otto dimensioni dello stack (verificata online ad agosto 2026) passata al vaglio di tre revisori adversariali — performance, sicurezza, maturità — che hanno prodotto 25 verdetti bloccanti. Ogni scelta contenuta lì è già stata attaccata e difesa.

Leggilo per intero prima di scrivere codice. Contiene, in forma già decisa:
- lo stack completo con versioni pinnate e stato di verifica (§3)
- lo schema dati integrale: DDL, indici, vincoli, trigger, ruoli Postgres, GRANT/REVOKE (§6)
- il modello RBAC con le query di dominanza e concedibilità (§7)
- i cicli di vita di invito, sessione, TOTP, recovery code, step-up, reset password, reset 2FA, cambio email, offboarding (§8)
- l'algoritmo normativo del middleware di autorizzazione e le chiavi Valkey (§9)
- 48 requisiti di sicurezza numerati `SEC-01`…`SEC-48`, ognuno con la sua contromisura concreta (§11)
- 17 test di accettazione obbligatori (§14)
- 5 spike bloccanti da eseguire prima del codice applicativo (§15)
- l'ordine di implementazione in 15 passi (§18)

Non riprogettare ciò che è già deciso lì. Se trovi un errore vero, dillo in una frase, proponi la correzione e procedi — non riaprire il dibattito su una scelta solo perché ne preferiresti un'altra.

Gli altri riferimenti:
- **`design/tokens.css`** — token di colore, tipografia, spacing, raggi, elevazioni, motion, tema scuro e chiaro. È la fonte di verità visiva: consuma sempre `var(--nome)`, non scrivere mai un colore letterale in un componente.
- **`MetaMC Admin - standalone.html`** — prototipo ad alta fedeltà. Per la fase 1 servono le schermate Login, Invito, App shell, Utenti & Ruoli, Registro attività, e gli stati di sistema. Aprilo e replicane la resa; le schermate di statistiche ignorale.
- **`logo.png`** — esagono nero con la M bicolore. Arancio `#DB6E19`, blu `#2478A1`.
</documenti_normativi>

<prima_di_iniziare>
Due cose vengono prima della prima riga di codice applicativo.

**1. Le sei domande del §1.** Sono decisioni del committente o vincoli infrastrutturali che non puoi dedurre dal codice: hosting e versione esatta di Postgres, immagine container glibc, numero minimo di owner, sottodominio di invio email, sottodomini di terzi su `metamc.it`, baseline del pannello legacy. Falle tutte insieme in un solo messaggio, all'inizio, e aspetta le risposte prima di fissare Dockerfile e configurazione. Nel frattempo puoi già iniziare gli spike e le migration, che non dipendono da quelle risposte.

**2. I cinque spike del §15.** Timebox complessivo un giorno. Ognuno ha un esito binario e un piano B già deciso nel documento. Non scrivere codice applicativo prima di conoscerne l'esito: SPIKE-1 in particolare decide se il TOTP passa dal plugin `twoFactor` di better-auth o da `otpauth`, e quella scelta cambia una tabella dello schema.

Riporta l'esito di ogni spike in una riga: superato o fallito, e quale ramo prendi.
</prima_di_iniziare>

<verifica_delle_versioni>
Oggi è agosto 2026 e il tuo knowledge cutoff è precedente. Il documento marca ogni versione con **[V]** (verificata contro fonte primaria durante la revisione) o **[R]** (da risolvere al momento dell'installazione).

Regole non negoziabili:
- Ogni versione **[R]** va risolta con `pnpm view <pkg> version` prima di scriverla nel manifest.
- Tutte le versioni si pinnano **esatte**: niente `^`, niente `~`.
- **Nessun floor di versione entra in `package.json` o nel Dockerfile sulla base di un CVE che non hai risolto** con una chiamata a `cveawg.mitre.org/api/cve/<ID>` o `api.osv.dev/v1/vulns/<GHSA>`. Tre dei diciassette identificativi citati nella ricerca originale erano inventati e sono stati scoperti proprio così: il §12 elenca quali. Se un CVE citato nel documento non risponde, segnalalo e non usarlo come motivazione.
- Prima di congelare il lockfile, esegui **una volta** `pnpm install --strict-peer-dependencies` e leggi ogni warning di peer: è il modo in cui è emerso il conflitto ioredis 5 contro 6.
</verifica_delle_versioni>

<come_lavorare>
Segui l'ordine del §18. È costruito perché ogni passo renda verde un gruppo di test prima che il successivo ci si appoggi sopra.

**I test di accettazione del §14 si scrivono prima del codice che li fa passare**, e devono fallire per il motivo giusto prima di essere risolti. Sono diciassette e sono la parte del lavoro che non va sacrificata: verificano proprietà di sicurezza che non si vedono guardando il codice — che un utente bannato cada entro un secondo, che lo stesso codice TOTP non passi due volte, che due accettazioni concorrenti dello stesso invito non creino due utenti, che il login su email inesistente e su password errata abbiano latenza indistinguibile.

L'infrastruttura di test è un container **PostgreSQL effimero con le migration reali** più un Valkey effimero. Non pglite: servono ruoli, GRANT/REVOKE, partizionamento e trigger.

Migration forward-only, una per passo, ognuna preceduta da `SET lock_timeout` e `SET statement_timeout` come da §17.3.

Cita il codice `SEC-xx` nel messaggio di commit e nel nome del test quando implementi una contromisura. Serve a rendere tracciabile la copertura del §11.

Git: inizializza il repository, lavora su un branch, commit piccoli e coerenti. Non fare push da nessuna parte senza che te lo chieda.
</come_lavorare>

<regole_di_sicurezza>
Il §11 non è una checklist da spuntare a fine lavoro: è il progetto. Le regole che si perdono più facilmente durante l'implementazione, e che quindi ripeto qui:

- **L'autorizzazione non legge mai `session.user`.** È uno snapshot e non riflette ban né declassamenti. Si legge `authz:{userId}` (SEC-02).
- **Un unico punto di enforcement**: l'helper `can(actor, module, level)` in `src/authz/`. Aggiungi la regola di CI del §7 che fallisce la build se un confronto su ruoli compare fuori da quel modulo.
- **Nessuno concede ciò che non ha** (SEC-07) e **nessuna operazione su un altro utente senza controllo di dominanza** (SEC-08). Sono due query SQL già scritte nel §7.
- **L'INSERT nell'audit log è l'ultima istruzione prima del COMMIT**, nella stessa transazione della modifica di stato per gli eventi di sicurezza. Nessuna chiamata di rete esterna dentro quella transazione (§10).
- **Nessun parametro di redirect accettato dal client** in tutta la fase 1 (SEC-20).
- **Divieto assoluto di `innerHTML` e `dangerouslySetInnerHTML`**, imposto da una regola Biome che fallisce la build (SEC-35). Vale soprattutto per la tabella audit, che renderizza user agent e payload jsonb controllati da terzi.
- **Il rate limit si consuma prima di qualsiasi chiamata ad Argon2**, incluso il percorso utente-inesistente (SEC-25).

Se durante l'implementazione trovi un buco che il documento non copre, fermati un momento, dillo, e proponi la contromisura prima di proseguire.
</regole_di_sicurezza>

<frontend>
Vite + React + TanStack Router/Query, versioni al §3.7. Niente librerie di grafici: sono fase 2.

Le schermate di fase 1 sono login, accettazione invito con enrollment TOTP e recovery code, app shell con sidebar e command palette, gestione utenti e ruoli con la matrice dei permessi, registro attività con tabella virtualizzata e paginazione keyset, più gli stati 401/403/404/manutenzione/feed disconnesso.

Consuma i token di `design/tokens.css`. La sidebar mostra **solo** i moduli a cui l'utente ha accesso: nessuna voce disabilitata o con il lucchetto, perché l'elenco stesso dei moduli è informazione.

`index.html` è una rotta Fastify dinamica che inietta il nonce CSP, tenuta in memoria come coppia di stringhe pre-splittate. Gli asset con hash li serve nginx. Non installare `@fastify/static` (§2).
</frontend>

<comunicazione>
Prima della prima chiamata a uno strumento, di' in una frase cosa stai per fare. Durante il lavoro, aggiorna solo quando trovi qualcosa di importante o cambi direzione. Quando finisci un passo del §18, apri con l'esito: cosa funziona e quali test sono verdi, il dettaglio dopo.

Le risposte restino asciutte. Il valore sta nel codice e nei test, non nella descrizione di ciò che hai scritto.
</comunicazione>

<scope>
Consegna la fase 1 per intero, al livello di profondità del documento. Non costruire nulla della fase 2: lo schema `stats` si crea vuoto, l'interfaccia `CacheService` si crea con la sola implementazione passthrough, la tabella `webauthn_credential` si crea vuota. Il §16 elenca esattamente cosa predisporre senza implementare, e il §4 cosa non installare affatto con la relativa soglia di rientro.

Le decisioni di routine prendile da solo. Fermati a chiedere solo quando due letture ragionevoli della stessa richiesta porterebbero a lavori diversi. Finisci ogni passo che inizi: se qualcosa si rivela bloccato, completa tutto il resto e dichiara esplicitamente cosa hai lasciato indietro e perché.
</scope>

<delega>
Delega a un subagente solo per lavori grandi e davvero indipendenti — per esempio un'indagine su più file, o due sottosistemi senza punti di contatto. Non delegare ciò che finisci da solo in qualche chiamata, e non usare subagenti per ricontrollare il tuo lavoro. Se ne basta uno, usane uno.
</delega>
