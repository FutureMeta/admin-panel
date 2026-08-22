# Prompt per Claude Code — modulo Duels

> Copia dal blocco `<contesto>` in giù e incollalo in Claude Code, aperto sulla cartella `admin-panel`.

---

<contesto>
Il pannello MetaMC è in produzione con la fase 1 (auth, RBAC, audit) e la fase 2 (statistiche di rete) complete. Va aggiunta una categoria **Duels** con tre sottovoci: **Trends**, **Ratings** e **Configuration**.

Trends e Ratings replicano due schermate del pannello legacy `C:/Users/fiore/Desktop/Progetti/duels-dashboard`, riadattate al design system del pannello nuovo. Configuration per ora resta vuota: solo rotta, permesso e stato vuoto.

Il legacy è un pannello pubblico Next.js che legge da MySQL ed è **molto lento**. È la ragione per cui questo modulo si rifà invece di riusarlo: l'informazione va replicata, l'architettura no.
</contesto>

<documento_normativo>
**`docs/spec-modulo-duels.md` è vincolante.** Nasce da quattro analisti che hanno letto il pannello legacy riga per riga, un revisore che ha attaccato il porting, e una sintesi. Contiene i 22 widget descritti in modo da poterli ricostruire senza riaprire il legacy: contratto delle rotte, calcolo esatto di ogni metrica, filtri, stati, e il DDL di destinazione.

Leggilo per intero prima di scrivere codice. In particolare la sezione 6, «Cosa NON replicare», che elenca i difetti del legacy da non ereditare.

Restano validi `docs/stack-decisions.md` (fase 1), `docs/architettura-fase2.md` (fase 2) e `design/tokens.css`.

**I tre mockup vanno seguiti alla perfezione:**

- `frontend/9-duels-trends.dc.html`
- `frontend/10-duels-ratings.dc.html`
- `frontend/11-duels-configurazione.dc.html`

Aprili e replicali: impaginazione, gerarchia, spaziature, copy dei titoli e dei sottotitoli, tipi di grafico, tabelle, stati. Non reinterpretarli e non «migliorarli».

**Regola di precedenza, quando mockup e specifica divergono:**

| ambito | comanda |
|---|---|
| aspetto, disposizione, testo dell'interfaccia, struttura della schermata | **il mockup** |
| da dove viene il dato, come si calcola, contratto delle rotte, filtri e loro semantica | **la specifica** |

Il mockup dice come si vede, la specifica dice cosa c'è dentro. Se il mockup mostra un numero che la specifica non sa produrre, non inventarlo: segnalalo.

Due cose che i mockup hanno già deciso e che valgono più di quanto sembri. Il sottotitolo di Ratings è «Feedback dei giocatori a fine partita»: è la formulazione giusta e toglie di mezzo l'equivoco con i sistemi di abilità — mantienila. E Configuration ha già il suo stato vuoto scritto, «Qui arriveranno i parametri di configurazione di Duels: code, matchmaking, mappe attive e limiti di partita»: quella è la copia definitiva, non un segnaposto da riscrivere.
</documento_normativo>

<la_decisione_gia_presa>
I dati storici dei duels stanno **in MySQL, non in Redis**. La specifica lo dimostra endpoint per endpoint: su 8 rotte delle due schermate, zero sono servibili da Redis. Il Redis del gioco ha `duels:servers:*`, `duels:match:*` e le code, ma è stato vivo — partite in corso, non storia. E non si può nemmeno ricostruire la storia campionandolo: un poller a 30 secondi non vede una partita da 20, e l'errore dipende dalla durata, cioè proprio dalla variabile che distingue le modalità.

**Si adotta l'opzione (b) della specifica: ETL da MySQL verso PostgreSQL**, non la connessione diretta in lettura. Il MySQL è raggiungibile — sta sulla stessa macchina — ma un job che pre-aggrega batte la lettura diretta per tre ragioni concrete:

1. **È la cache più forte possibile.** Una partita conclusa il 15 agosto non cambierà mai. Aggregata una volta per ora e per giorno, qualunque intervallo diventa una somma su poche centinaia di righe locali. La lentezza del legacy sparisce alla radice invece di essere nascosta da un TTL.
2. **Fa sparire la macchina di fuso orario del legacy**, che inlinea un offset dentro le stringhe SQL e rende i predicati non indicizzabili. Il pannello nuovo ha già `stats.civil_day()` e `stats.day_seconds()` come uniche funzioni autorizzate a nominare il fuso.
3. **I conteggi di partite sono additivi**, quindi ricadono esattamente nella regola dei rollup già in vigore: solo interi additivi, gerarchia esatta e non approssimata.

Costruisci comunque il **port** che la specifica propone — `DuelsProvider` con implementazione su Postgres come predefinita e la variante MySQL diretta dietro una variabile d'ambiente. Rotte, contratto, cache e interfaccia non devono sapere quale delle due è attiva.
</la_decisione_gia_presa>

<schema_di_origine_accertato>
Le domande aperte della sezione 7 della specifica **sono state risolte** interrogando il MySQL di produzione il 22 agosto 2026. Questi sono fatti verificati: non riverificarli, e dove contraddicono la specifica **vincono loro**.

**`duels_mode` — schema post-migrazione.** `ranking varchar(50) NOT NULL DEFAULT 'UNRANKED'` è una **colonna a sé**, e anche `type varchar(50) NOT NULL DEFAULT 'DUEL'` lo è. Il legacy supportava a runtime entrambi gli schemi (pre e post migrazione): quel doppio percorso **non va portato**. L'ETL legge le due colonne direttamente. `id int`, AUTO_INCREMENT a 86, quindi `smallint` basta e avanza per `mode_id`.

**`duels_userdata.username` esiste**, `varchar(32)`, con indice UNIQUE. Il ripiego su `duels_replay_participants` **non serve e non funzionerebbe comunque**: quella tabella è vuota, zero righe. Il `NAME_LATERAL` del legacy stava materializzando due volte per richiesta una tabella senza dati.
Due dettagli che contano: `username` è **NULLABLE**, quindi «Valutazioni recenti» deve reggere un nome assente senza rompersi — mostra l'uuid o un segnaposto, non una riga vuota. Ed è UNIQUE, quindi al cambio nome il vecchio valore va liberato prima: aspettati dei NULL transitori, non trattarli come errore.

**`duels_match_statistics.created_at` non è mai NULL.** Su 2.491.686 righe, **zero** senza ora. Lo storico va dal **2026-03-09 al 2026-08-22**, cioè 166 giorni.
Conseguenza diretta: **la tabella `stats.duels_match_day_untimed` non va creata**, e con lei sparisce tutto il percorso a grano giornaliero della sezione 6.4 della specifica. Un grano solo, orario. La heatmap è valida su tutto lo storico e non ha buchi sistematici. Non reintrodurre `COALESCE(created_at, date)`: non serve più a niente.

**Volumi — il backfill è una passeggiata.**

| tabella | righe | dati | indici |
|---|---:|---:|---:|
| `duels_match_statistics` | ~2.483.000 | 126 MB | 140 MB |
| `duels_match_ratings` | ~15.600 | 3 MB | 2 MB |
| `duels_replay_participants` | **0** | — | — |

Circa 250 lotti da 10.000 per le partite, e le valutazioni entrano in un lotto solo. Tienilo comunque ripartibile — costa poco — ma non serve un piano di ripresa elaborato.

**`duels_match_ratings` — il DDL reale.** `id bigint AUTO_INCREMENT` come PK, quindi il watermark sull'id è la scelta giusta e confermata. `created_at timestamp NOT NULL` ma **non indicizzato da solo** (compare solo come seconda colonna di `idx_player`): il ripescaggio per finestra temporale non è praticabile, e a 15.000 righe non serve.
Esiste `CONSTRAINT chk_rating CHECK (rating BETWEEN 1 AND 5)`: i voti fuori scala **non possono esistere**. Cade quindi la contromisura della specifica su scarto e conteggio dei fuori scala, e la somma delle cinque barre torna sempre col totale. Una guardia leggera resta sensata, un contatore da mostrare no.
La colonna `dialog text` esiste davvero. `player_id` ha una FK verso `duels_userdata` con `ON DELETE CASCADE`: se un giocatore viene cancellato, le sue valutazioni spariscono dall'origine — quindi il nostro storico può contenere righe che alla fonte non ci sono più, e va bene così, ma non allarmarti se un controllo di riconciliazione trova un disallineamento in quel verso.

**Un fatto sulla densità dei dati che riguarda il disegno, non l'ETL.** Le valutazioni sono 15.592 su 2.483.497 partite: lo **0,63%**, circa 94 al giorno su tutto il network. Filtrate per modalità — e ce ne sono fino a 85 — molti giorni avranno zero, uno o due voti. Il riquadro «Andamento voto medio» calcolato su campioni così piccoli produce una linea che sobbalza per ragioni statistiche, non reali.
Serve quindi una soglia minima di campioni sotto la quale il punto non si disegna o si marca come inaffidabile — il legacy aveva già un `BEST_MODE_MIN_RATINGS = 5` per una ragione analoga. E la media va sempre accompagnata dal numero di voti su cui è calcolata: una media di 4,8 su tre voti e una su trecento non sono la stessa informazione.

**`dialog` — contratto accertato.** È un array JSON di turni `{role, content}`, senza timestamp e senza id: esiste solo l'ordine. I ruoli osservati sono `bot` e `player`. Esempio reale:

```json
[{"role":"bot","content":"That's rough, sorry to hear it went badly. What specifically went wrong in that match, type 'cancel' to leave."},
 {"role":"player","content":"ahh server"}]
```

È un follow-up automatico: dopo la valutazione un bot chiede cosa non ha funzionato e il giocatore risponde. Quindi `dialog` è popolato **solo su una parte** delle valutazioni — quelle in cui il bot ha ingaggiato e il giocatore ha risposto — e la riga espandibile va progettata sapendo che nella maggior parte dei casi non c'è niente da espandere.

Quattro conseguenze per l'implementazione:

- **I turni `player` sono testo scritto da un utente**, esattamente come `comment`. Vale il divieto assoluto di `innerHTML` e `dangerouslySetInnerHTML` già imposto dalla regola Biome che fa fallire la build. Non è teoria: qui è testo arbitrario di terze parti renderizzato dentro il pannello di amministrazione.
- **Sono dati personali** e seguono la stessa retention di `comment`: la decisione va presa una volta per entrambi, non due.
- **Il contenuto è in inglese** mentre l'interfaccia è in italiano. È dato, non copy: si mostra così com'è, non si traduce. Ma le etichette intorno — chi parla, quando è iniziato lo scambio — restano italiane.
- **Il parsing va difensivo.** In MySQL la colonna è `text` senza vincoli: JSON malformato, ruoli inattesi o campi mancanti non devono far fallire il lotto dell'ETL. Si salva il valore grezzo o si lascia nullo, si conta l'occorrenza, e si va avanti.

Visivamente è una piccola trascrizione di chat: turni del bot e del giocatore distinguibili a colpo d'occhio, nell'ordine in cui compaiono. Nessun orario da mostrare, perché non c'è.
</schema_di_origine_accertato>

<la_cadenza>
**Il ciclo di ingestione è di 30 secondi, non i 5 minuti che indica la sezione 1.4 della specifica.** Questo punto la sovrascrive.

La ragione è la coerenza: tutto il resto del pannello si aggiorna a 30 secondi, e una schermata che va a un ritmo diverso costringe chi guarda a ricordarsene. Il costo è trascurabile perché il ciclo non aggrega niente sullo storico — fa `WHERE id > watermark` sulla chiave primaria e si porta indietro le poche partite concluse nell'intervallo. È una lettura indicizzata, non una scansione.

Tre cose che a 30 secondi diventano obbligatorie:

- **Guardia contro la sovrapposizione.** Un ciclo non parte se il precedente non è finito. Dopo un'interruzione il recupero è grande e sforerebbe l'intervallo: senza guardia i cicli si accavallano e raddoppiano il lavoro.
- **Budget per ciclo.** Un ciclo ingerisce al massimo N righe e poi si ferma, lasciando il resto al successivo. Dopo un fermo di ore il recupero avviene in qualche minuto di cicli consecutivi, non in una singola corsa che blocca tutto.
- **Il backfill iniziale resta un'altra cosa.** `scripts/duels-backfill.ts` è un batch a sé, con i suoi lotti e la sua ripresa: non gira mai sulla cadenza dei 30 secondi.

**Le due cadenze non si sommano.** Il payload del giorno in corso lo ricostruisce **lo stesso ciclo** che ha appena ingerito, non un timer parallelo: finita l'ingestione si ricalcola la fetta viva e si riscrive in Valkey. Se cache e job avessero orologi separati, la latenza visibile sarebbe la somma dei due, ed è l'errore da non fare.

Anche il terzo orologio, quello del browser, va legato allo stesso ritmo — altrimenti una scheda lasciata aperta mostra dati vecchi mentre il server ne ha di freschi. E la schermata dichiara l'età del dato, come fa la panoramica di rete: senza, chi guarda non distingue «non è cambiato niente» da «è fermo».
</la_cadenza>

<la_cache>
È il punto su cui il committente ha insistito, quindi non è un dettaglio implementativo: è il motivo del modulo.

Tre livelli, dal più forte al più debole.

**1. La pre-aggregazione.** Le tabelle `stats.duels_*` tengono le partite già contate per ora e per giorno. Nessuna schermata interroga mai le righe grezze delle partite: il grezzo sta in MySQL e lo tocca solo il job.

**2. Il confine fra storia e presente.** I giorni chiusi sono immutabili: si calcolano una volta e restano validi per sempre. Solo il giorno in corso si ricalcola. È la stessa distinzione della fase 2 e va implementata con la stessa disciplina — una risposta che mescola giorni chiusi e giorno vivo deve dichiarare qual è la parte che cambia.

**3. Il payload già pronto.** Come in fase 2: un worker produce la risposta serializzata e compressa, la mette in Valkey, e la rotta la rispedisce senza toccare Postgres. Riusa `CacheService`, non scrivere un secondo meccanismo accanto.

Attenzione a un errore che il legacy fa e che è facile riprodurre: **la cache chiavata sull'intervallo scelto dall'utente non funziona.** Gli intervalli sono combinatori e li sceglie chi guarda, quindi ogni apertura è quasi sempre una cache fredda — nel legacy il TTL è 20 secondi e in pratica non fa mai hit. La cache va tenuta sui **giorni**, che sono finiti e non cambiano, e l'intervallo si compone sommandoli.

L'altro errore da non ripetere: Trends nel legacy spara quattro aggregazioni indipendenti per apertura di pagina. Vale la regola già in vigore, **una schermata = una richiesta**.
</la_cache>

<vincoli_di_produzione>
- **PostgreSQL 17, non 18.** È già costato un guasto in produzione: `min(bytea)` è una funzione della 18, è passata la creazione della migration e ha fallito settimane dopo, alla prima esecuzione del job. PL/pgSQL analizza le istruzioni SQL alla **prima esecuzione**, non alla creazione. Quindi: ogni funzione usata va verificata disponibile sulla 17, e ogni funzione PL/pgSQL scritta va **eseguita almeno una volta nei test**. Una migration che applica pulita non prova niente.
- Le migration fino alla `014` sono applicate: non si modificano mai. Verifica il primo numero libero con `pnpm run migrate:status`.
- Le tabelle nuove vanno **nello schema `stats` con prefisso `duels_`**, non in uno schema nuovo: `stats.ensure_partitions` ha lo schema cablato nel `format()`, e stando dentro `stats` si ereditano registro delle partizioni, retention per DROP, ruoli e GRANT.
- I moduli RBAC si aggiungono **con una migration**: `metamc_app` non ha INSERT su `auth.modules`.
- Non puntare i test contro i database di produzione, né Postgres né MySQL.
- `pnpm run check` verde prima di ogni commit. Nomi in inglese nel codice e nei commit, interfaccia in italiano.
- Il job ETL non deve poter rallentare il pannello: connessione MySQL dedicata con timeout propri, lotti piccoli, e nessuna condivisione di pool con l'autenticazione.
</vincoli_di_produzione>

<perimetro>
**Trends** — selettore di intervallo che comanda l'intera schermata, andamento delle partite nel tempo, mappa di attività 7×24, modalità più giocate con filtro Ranked/Unranked/Tutte, mappe più giocate.

**Ratings** — selettore di modalità, riepilogo delle valutazioni, distribuzione dei voti, andamento del voto nel tempo, valutazioni recenti.

Una precisazione che la specifica mette in apertura della sezione 3 e che vale la pena non perdere: **«Ratings» non è un sistema di abilità tipo Elo.** Sono i voti da 1 a 5 stelle che i giocatori lasciano a fine partita, con commento facoltativo. Chi legge la voce in sidebar penserà ad altro: scegli l'etichetta italiana di conseguenza.

**Configuration** — solo scheletro: rotta, voce in sidebar, permesso, stato vuoto che dice cosa ci sarà. Non inventare funzioni: la specifica elenca due letture possibili di cosa debba contenere, e la scelta non è stata fatta.

**Permessi**: due moduli distinti, `duels` e `duels_feedback`, come argomenta la sezione 5. Le partite sono numeri aggregati, le valutazioni sono nomi di persone e testo libero, e non è detto che chi guarda i grafici debba leggere i commenti.

Fuori perimetro: le altre pagine del legacy (`/live`, `/replays`, `/wiki`, la home), la moderazione dei commenti, e qualunque scrittura verso il database del gioco.
</perimetro>

<metodo>
Ordine: passo zero → migration dei moduli RBAC → migration delle tabelle → job ETL con backfill → provider e rotte → cache → schermate.

Il backfill dello storico è la parte che può andare storta in silenzio: falla ripartibile, con un registro di avanzamento, e verifica il totale importato contro un `COUNT(*)` sulla sorgente prima di dichiararla finita.

Un commit per passo, `pnpm run check` verde prima di ognuno. Non fare push, non toccare la produzione.

Se scopri che un punto della specifica è sbagliato — è stata scritta leggendo il legacy, non il database di produzione — dillo con la prova e fermati su quel punto invece di implementare la correzione di un problema inesistente.
</metodo>

<comunicazione>
Prima della prima chiamata a uno strumento, una frase su cosa stai per fare. Poi aggiornamenti solo quando chiudi un passo o cambi direzione. Chiudendo, apri con l'esito: cosa funziona e cosa resta aperto.

Risposte asciutte: il valore è nel codice.
</comunicazione>

<scope>
Consegna le tre voci al livello di profondità della specifica. Non allargare ad altre pagine del legacy, non aggiungere dipendenze oltre quelle che la specifica giustifica, non rifattorizzare le fasi 1 e 2.

Le decisioni di routine prendile da solo. Fermati a chiedere solo quando due letture ragionevoli porterebbero a lavori diversi. Se una parte si rivela bloccata — tipicamente per una risposta mancante del passo zero — completa tutto il resto e dichiara esplicitamente cosa hai lasciato indietro e perché.
</scope>
