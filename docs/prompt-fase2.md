# Prompt per Claude Code — MetaMC Admin, Fase 2

> Copia dal blocco `<contesto>` in giù e incollalo in Claude Code, aperto sulla cartella `admin-panel`.

---

<contesto>
Il pannello MetaMC è in produzione con la fase 1 completa: inviti, login, 2FA, sessioni, RBAC per modulo, audit log. La fase 2 è **il tracker statistico del network**, cioè la ragione per cui il pannello esiste.

Il perimetro: raccogliere i dati di presenza dal Redis del gioco, costruirne lo storico, esporlo alle due schermate già disegnate (Panoramica network e Dettaglio modalità), e permettere di configurare dal pannello quali server seguire e come raggrupparli.

Esiste un pannello legacy — `duels-dashboard`, fuori da questo repository — che fa qualcosa di simile ed è lento. Non va migrato né riusato: serve solo sapere che il difetto da non ripetere è il suo.
</contesto>

<documento_normativo>
**`docs/architettura-fase2.md` è vincolante.** Nasce da quattro progettisti in parallelo, due revisori adversariali — uno sulla correttezza dei numeri, uno sulla scala — e una sintesi che ha riconciliato i conflitti. Contiene 32 decisioni motivate, il DDL completo, il progetto del poller, la catena di rollup, il contratto degli endpoint, la strategia di cache, la geolocalizzazione e gli invarianti da verificare in continuo.

Leggilo per intero prima di scrivere codice. Le decisioni sono già state attaccate e difese: non riaprirle. Se trovi un errore vero, dillo in una frase, proponi la correzione e procedi.

Restano validi anche `docs/stack-decisions.md` (fase 1) e `design/tokens.css`.
</documento_normativo>

<emendamenti>
Cinque punti sono stati decisi **dopo** che il documento è stato scritto, in conversazione col committente. Dove divergono, **vincono questi**.

**E1 — Vocabolario, fissato.**
- **server** = la singola istanza Minecraft, come compare nel campo `server` dell'hash Redis: `survival1`, `duels_3`, `sandbox7`.
- **modalità** = il raggruppamento che l'operatore crea nel pannello, con nome, colore e filtro.

Vale in ogni tabella, endpoint, componente e messaggio. Il documento in qualche punto li usa al contrario: correggi.

**E2 — I campioni si salvano per SERVER, non per modalità.**
Il documento definisce `stats.sample_mode (tick_at, mode_id, players, ...)`, cioè risolve la modalità al momento della scrittura. Va cambiato in `stats.sample_server (tick_at, server_id, players, ...)`, e lo stesso vale per `rollup_5m`: la chiave è il server. La modalità si risolve **in lettura**, applicando la configurazione corrente.

La ragione è E4: se i filtri si possono cambiare dal pannello, verranno cambiati. Con la modalità cotta dentro i dati, ogni correzione varrebbe solo da oggi in avanti e lascerebbe lo storico attribuito con la regola vecchia. Salvando per server, spostare un server da una modalità all'altra, unire due modalità o correggere un filtro **ricalcola anche il passato**.

Costo: circa 57.600 righe grezze al giorno invece di 23.000, e 5.760 righe di rollup 5m invece di 2.300. Su tabelle partizionate è irrilevante, ed è il prezzo dell'unica proprietà che rende la configurazione davvero configurabile.

I livelli superiori (`rollup_1h`, `rollup_1d`) possono restare per modalità **solo se** ricalcolabili dal 5m per server; se questo complica, restano per server anche loro.

**E3 — Il filtro è strutturato, niente regex.**
Una modalità raccoglie i suoi server in uno di due modi, come nel mockup (`frontend/metamc-shared.js`, blocco `serverModes`):
- **Elenco server** — lista esplicita di nomi, mostrati come chip.
- **Pattern sul nome** — una stringa più un operatore fra `inizia_con`, `contiene`, `finisce_con`.

Niente espressioni regolari: un matcher strutturato si salva come dato, non può esplodere in backtracking e non richiede di eseguire input dell'utente nel ciclo del poller. `stats.mode_alias` passa quindi da `match_kind IN ('server','prefix')` a `('server','prefix','contains','suffix')`.

Due requisiti che il mockup già mostra: quando si salva un filtro, il pannello **mostra in anteprima quali server matcherebbero** fra quelli visti di recente, con i giocatori attuali; e serve una regola deterministica di priorità quando due modalità matchano lo stesso server, con l'avviso esplicito del conflitto. Un server che non matcha nessuna modalità finisce nella sentinella `__unknown__` già prevista dal documento.

La risoluzione `server → modalità` si calcola una volta per nome di server distinto e si tiene in memoria: sono una ventina, non uno per giocatore.

**E4 — Le modalità sono un modulo del pannello.**
Creazione, modifica, ordine, visibilità, colore e filtro si gestiscono da interfaccia. Il documento le prevede già come dato (`stats.mode.created_by = 'operator'`, `in_breakdown`, `hidden`, `sort_order`): va costruita la parte che le amministra.

Nessun seed di modalità nella migration: il dizionario nasce vuoto e lo riempie l'operatore.

Permesso: livello `gestione` sul modulo `statistiche`, già seminato in fase 1. Ogni modifica va nel registro attività con il prima e il dopo — cambiare un filtro cambia i numeri riportati, e deve restare tracciabile chi e quando.

**E5 — Colori da tavolozza curata.**
I venti colori sono già definiti in `frontend/metamc-shared.js` (`newModeColors`). Due correzioni misurate:
- `#1F6E95` sta a **2,99:1** sul fondo delle card, sotto il minimo di 3:1 per gli oggetti grafici. Va tolto o schiarito. È lo stesso colore che aveva già fallito nella palette precedente.
- La distanza minima di luminanza fra due colori della tavolozza è 0,0018 (`#9B8FD9` contro `#B884D4`): indistinguibili in scala di grigi. Non è un problema della tavolozza ma della scelta, quindi quando si assegna un colore a una modalità il pannello **avvisa** se è troppo vicino a quello di un'altra modalità attiva. Avviso, non divieto.

I token `--viz-vanilla-war`, `--viz-survival`, `--viz-towny`, `--viz-oasis` in `design/tokens.css` vanno rimossi: il colore ora è un attributo della modalità, non una costante.
</emendamenti>

<postgresql_17>
**La produzione gira su PostgreSQL 17, non sulla 18.** Il documento di architettura è stato scritto assumendo la 18.6 della fase 1, e il suo DDL va riletto riga per riga contro la 17.

Non è un'ipotesi. Il minimo era già stato abbassato dalla 18 alla 17, `uuidv7()` era stato riscritto in PL/pgSQL, ma lo schema non era stato riletto cercando altre funzioni della stessa generazione: `min(bytea)` è rimasta dentro `audit.verify_chain` ed è esplosa **in produzione il 2026-08-20**, quando il job di verifica ha girato per la prima volta. L'ha corretta la migration 010.

La trappola che l'ha resa invisibile: **PL/pgSQL analizza le istruzioni SQL alla prima esecuzione, non alla creazione.** Una funzione si crea senza errori su entrambe le versioni e fallisce solo quando qualcuno la chiama — settimane dopo, per esempio al primo rollup notturno.

Due obblighi:
1. Ogni funzione, aggregato e operatore usato nella migration va verificato disponibile in PostgreSQL 17.
2. Ogni funzione PL/pgSQL scritta va **eseguita almeno una volta** nei test, non solo creata. Una migration che applica pulita non prova niente.

Verifica la versione reale con `SHOW server_version` prima di scrivere il DDL, e se differisce da quanto qui sopra, dillo e fermati su quel punto.
</postgresql_17>

<fatti_accertati>
Verificati sull'istanza reale. Non rifare queste indagini.

- **`DBSIZE` = 2667** chiavi in tutta l'istanza. Con oltre mille giocatori online le chiavi giocatore sono circa metà del keyspace, quindi lo `SCAN` attraversa poco più di due chiavi per giocatore trovato: ~3 round trip con `COUNT 1000`. Niente notifiche keyspace, niente indice mantenuto a parte, niente riconciliazione periodica.
- **TTL della chiave giocatore: ~100 secondi**, rinnovato dal plugin anche a ogni trasferimento fra server. Nessun fantasma permanente.
- **Oltre 1000 giocatori contemporanei sono la norma.** Il cap `MAX_PLAYERS = 1000` del pannello legacy è un difetto attivo, non un limite teorico.
- **Il campo `ip` è quello del giocatore, non del proxy.** Misurato: 813 giocatori, 799 IP distinti, 5 proxy. Il passo zero obbligatorio della sezione 8 del documento **è già stato eseguito e superato**: non ripeterlo, la geolocalizzazione si può fare.
- **I server reali** visti in un campione: `auth_1`, `copiasurvival`, `duels_1..6`, `duels_event_2`, `duels_lobby_1..2`, `ffa_1..3`, `lobby_1..3`, `metasmp`, `sandbox7`, `survival`. Circa venti nomi distinti. La convenzione è `{famiglia}_{numero}` per le istanze multiple e nome nudo per quelle singole, ma **non dedurre niente da questa convenzione**: il raggruppamento lo decide l'operatore con E3.
- **Un server vuoto è invisibile**: senza giocatori non ha chiavi. È il motivo per cui il documento distingue strutturalmente «zero online» da «non ho raccolto», e per cui una modalità configurata e senza giocatori deve produrre uno zero esplicito, non un buco.
- Towny, Oasis e Vanilla War, che compaiono sul sito pubblico, **non esistono**: erano mockup.
- Il committente non modificherà il plugin Minecraft e non va chiesto nulla a chi lo mantiene. Si legge quello che c'è.
</fatti_accertati>

<vincoli_di_produzione>
- Migration 001-010 sono applicate: **non si modificano mai.** La fase 2 è la `011`. Verifica con `pnpm run migrate:status` prima di scegliere il numero.
- Non cambiare la derivazione delle chiavi in `src/crypto/keys.ts`: la stringa `info` *è* la chiave.
- L'audit log è append-only con catena hash: non si riscrive il passato.
- Non puntare i test contro il database di produzione.
- `pnpm run check` deve restare verde.
- Nomi in inglese nel codice e nei commit, testo dell'interfaccia in italiano.
- Il poller gira nello stesso processo del pannello: connessione Redis dedicata con timeout propri, pool Postgres di sola lettura separato, e compressione fuori dal threadpool che usa Argon2. Un Redis di gioco lento non deve poter rallentare un login.
</vincoli_di_produzione>

<perimetro>
Dentro: schema `stats`, poller, sessioni e unici, catena di rollup, endpoint, cache, geolocalizzazione, gli invarianti sui numeri, il modulo di gestione delle modalità, e le due schermate del design — Panoramica network e Dettaglio modalità.

Fuori, e va lasciato fuori: qualunque modulo nuovo oltre a quello delle modalità; l'anti-alt; il dettaglio regionale; SSE. La sezione 9 del documento elenca ciò che è dichiarato fuori scopo per iscritto: rispettalo.
</perimetro>

<metodo>
Segui l'ordine di implementazione della sezione 9. Il passo zero del documento è in gran parte già chiuso da `<fatti_accertati>`: esegui solo ciò che resta davvero aperto.

Gli **invarianti sui numeri** si scrivono insieme al codice che verificano, non dopo. Sono il cuore della fase 2: un pannello di statistiche che produce numeri plausibili e falsi è peggio di uno rotto, perché il committente li confronterà mese su mese. Le tre trappole già identificate — il denominatore delle medie preso dalle righe della modalità invece che dal registro dei cicli, l'attribuzione dei secondi di sessione all'ultima modalità toccata, e l'interpolazione dei buchi — sono documentate con la loro correzione: non reintrodurle.

Un commit per passo. `pnpm run check` verde prima di ogni commit. Non fare push, non toccare la produzione.

Se scopri che uno degli emendamenti o dei fatti accertati è sbagliato, dillo con la prova e fermati su quel punto invece di implementare la correzione di un problema inesistente.
</metodo>

<comunicazione>
Prima della prima chiamata a uno strumento, una frase su cosa stai per fare. Poi aggiornamenti solo quando chiudi un passo o cambi direzione. Chiudendo, apri con l'esito: cosa funziona, quali invarianti sono verdi, cosa resta aperto.

Risposte asciutte: il valore è nel codice.
</comunicazione>

<scope>
Consegna il perimetro per intero, al livello di profondità del documento. Non allargare ad altri moduli, non rifattorizzare la fase 1 se non dove un emendamento lo impone, non aggiungere dipendenze oltre quelle che il documento giustifica.

Le decisioni di routine prendile da solo. Fermati a chiedere solo quando due letture ragionevoli della stessa richiesta porterebbero a lavori diversi. Se una parte si rivela bloccata, completa tutto il resto e dichiara esplicitamente cosa hai lasciato indietro e perché.
</scope>
