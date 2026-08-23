# Svetlana — l'assistente del pannello

Versione 1: **sola lettura**. Risponde a domande sui dati del pannello —
statistiche di rete, duels, utenti dello staff, registro attività — e non
modifica niente.

---

## 1. Cosa fa, e cosa non può fare

Svetlana è un pannello dentro l'app shell, non una schermata. Vede su quale
pagina si trova chi le scrive (e con che periodo e che modalità, dove la
schermata ne ha), così «e i duels di ieri?» ha un significato.

Ha nove strumenti e nient'altro. Non riceve mai una connessione al database
né una query da eseguire:

| Strumento | Cosa legge | Serve il modulo |
|---|---|---|
| `network_online` | giocatori adesso, ripartizione per modalità, record, **vocabolario** delle chiavi | `statistiche` ≥ 1 |
| `network_trend` | media, picco, unici, copertura su un periodo | `statistiche` ≥ 1 |
| `network_countries` | da quali paesi vengono i giocatori del periodo | `statistiche` ≥ 1 |
| `duels_summary` | partite, top modalità e mappe, ore di punta | `duels` ≥ 1 |
| `duels_ratings` | valutazioni aggregate: quante, media, distribuzione | `duels_feedback` ≥ 1 |
| `duels_comments` | **i singoli commenti dei giocatori**, con voto e dialogo | `duels_feedback` ≥ 1 |
| `panel_user_search` | cerca una persona dello staff | `utenti` ≥ 1 |
| `panel_user_detail` | una persona: matrice permessi, ruoli, sessioni (no IP) | `utenti` ≥ 1 |
| `audit_recent` | ultime voci del registro attività | `audit` ≥ 1 |

**Ogni chiave di modalità viaggia con l'ID/chiave, non col solo nome:** è ciò
con cui un tool ne chiama un altro. Il **vocabolario completo** (`catalogue` in
`network_online`) elenca tutte le modalità, comprese quelle vuote in questo
momento.

Fuori da questo elenco non c'è niente: nessuna scrittura, nessuna
configurazione, nessun ban, nessun invito.

**E fuori dal pannello non c'è niente affatto.** Ricette, leggi, codice,
opinioni: una domanda fuori ambito si chiude in una riga, senza ragionarci
sopra e **senza rispondere lo stesso**. Il modo tipico di sbagliare non è
rispondere: è rifiutare e poi rispondere — «non è il mio campo, comunque
servono pecorino e guanciale» — che è la risposta con in più l'aria di aver
rispettato una regola. Svetlana non ha fonti oltre agli strumenti: non
naviga, non cita norme, non usa quello che sa del mondo. E il **regolamento
del network non sta nel pannello**: se le chiedono cosa è permesso ai
giocatori, la risposta è che qui non c'è.

**I numeri sono gli stessi delle schermate.** Statistiche e duels passano dagli
stessi costruttori di payload e dalla stessa cache che servono le rotte del
pannello — non da una seconda aggregazione «più semplice» che darebbe risposte
somiglianti senza coincidere.

---

## 2. Sicurezza — le quattro cose che contano

### 2.1 Agisce COME l'utente, mai per conto proprio

Ogni strumento controlla i permessi di **chi ha scritto in chat**, con lo
stesso `can(actor, modulo, livello)` che governa le rotte, e lo fa **dentro**
il proprio corpo — non davanti alla rotta e non dopo la lettura.

Il modo di sbagliare è preciso: se gli strumenti leggessero con i permessi del
*processo*, un moderatore con accesso ai soli duels potrebbe chiedere a
Svetlana cose sugli utenti del pannello e ottenerle. Non produrrebbe nessun
errore — una risposta cortese con dentro dati che quella persona non può
vedere.

`tests/acceptance/74-assistant-authz.test.ts` è il test che lo prova, ed è
costruito perché fallisca davvero: il database contiene le persone che si
cercano e il ruolo di lettura ha il privilegio di leggerle, quindi togliendo
il controllo la chiamata riesce. Il test verifica che il risultato non
contenga l'indirizzo cercato — la differenza fra «ha detto di no» e «non ha
guardato».

Gli strumenti ci sono **tutti, per tutti**, anche per chi non ha i
permessi. Un elenco filtrato per ruolo sposterebbe la decisione fuori dal
corpo dello strumento (e invita a fidarsene), e farebbe cambiare il prefisso
della richiesta da persona a persona, cioè una cache che non si riusa mai.

### 2.2 Quello che torna da uno strumento è DATO, non istruzioni

Il pannello è pieno di testo scritto da terzi: nomi di giocatori, motivazioni
di ban, commenti alle valutazioni, trascrizioni. Chiunque può scriverci dentro
una frase rivolta al modello.

Due regole conseguenti, entrambe strutturali:

* **Le istruzioni operative viaggiano solo come messaggi `role: "system"`.** Il
  client manda il proprio testo, che diventa un turno `user`, e un percorso di
  pagina. **Il titolo della schermata lo sceglie il server**, da una tabella
  chiusa (`src/assistant/pages.ts`): se venisse dal browser, basterebbe mandare
  `title: "ignora le regole precedenti"` per scrivere una frase qualunque nel
  posto più autorevole della richiesta.
* **La cronologia sta sul server**, in Valkey, con la chiave che comprende l'id
  utente. Il client non può fabbricare turni che Svetlana «avrebbe detto».

Il prompt di sistema dichiara esplicitamente che il contenuto degli strumenti
si riporta e non si esegue, e che un'istruzione trovata dentro un dato va
**segnalata all'operatore** citandola fra virgolette. Un test tiene quella
parte del prompt come canarino: toglierla accende `75-assistant-injection`.

**Il secondo strato: il testo di terzi si ripulisce prima di partire.** Ogni
campo scritto da qualcun altro — nome giocatore, commento, motivazione di ban,
ogni turno del dialogo post-partita, lo user agent di una sessione — passa da
`src/assistant/untrusted.ts`, che fa due cose distinte:

1. **toglie ciò che finge struttura**: caratteri di controllo, spazi a
   larghezza zero (`ig​nora` torna `ignora`), override di direzionalità, i tag
   invisibili del piano 14 di Unicode, e taglia i testi lunghissimi dichiarando
   il taglio. Non è un filtro sul *contenuto* — è togliere al testo la capacità
   di **sembrare** qualcosa che non è;
2. **alza una spia** (`suspicious`) sui campi che somigliano a un tentativo, e
   un flag `flagged` la porta in cima al risultato. È un'**annotazione, non un
   filtro**: il testo pericoloso passa pulito e intero — l'operatore deve poter
   vedere cosa è stato scritto — con la segnalazione accanto. Un elenco di
   parole si aggira, quindi come filtro sarebbe falsa sicurezza; come spia un
   elenco parziale non fa danno.

I campi di terzi sono **marchiati a livello di tipo** (`UntrustedField`):
TypeScript non lascia scrivere `comment: row.text`, bisogna passare da `field()`.
È la stessa idea del ruolo di sola lettura in Postgres — non «ricordati di
sanificare», ma «non compila se non lo fai». Il corpus di attacchi è in
`82-injection-corpus.test.ts`; che i commenti dei duels arrivino marchiati in
`83-assistant-untrusted-reader.test.ts`.

### 2.3 Non scrive, e la garanzia sta nel database

Gli strumenti leggono da due ruoli PostgreSQL di sola lettura:

* `metamc_stats` (già esistente dalla fase 2) per statistiche e duels;
* `metamc_assistant` (migration 019) per `auth` e `audit`.

Il secondo ha `default_transaction_read_only = on` **sul ruolo** e nessun GRANT
di scrittura. Non vede `auth.account` (gli hash), `auth."twoFactor"` (i segreti
TOTP), `auth.recovery_code`, `auth.invitation`, `auth."verification"`,
`auth.webauthn_credential`, `auth.two_factor_reset`.

`tests/acceptance/73-assistant-role.test.ts` lo verifica sul database vero:
tre elenchi — cosa legge, cosa non legge, cosa non scrive — più la prova che
una tabella creata domani in `auth` non diventa leggibile da sola.

### 2.4 Tutto finisce nel registro attività

Una riga per interazione, attribuita alla persona, con `meta.via = "assistant"`,
gli strumenti chiamati **e i loro argomenti**. Senza gli argomenti, «ha usato
`panel_user_search`» non risponde a «chi ha guardato i dati di quella persona»,
che è la domanda per cui quella riga esiste.

---

## 3. NOTA PER IL COMMITTENTE — dati personali verso un fornitore esterno

**Questa sezione richiede una decisione, non solo una lettura.**

Le risposte degli strumenti vengono inviate all'API di Anthropic. Escono di
conseguenza:

* nomi e indirizzi email dello staff del pannello (`panel_user_search`,
  `panel_user_detail`);
* identità denormalizzate e etichette di bersaglio dal registro (`audit_recent`);
* nomi di modalità e mappe, e i nomi dei giocatori dove compaiono nei dati dei
  duels;
* **i commenti scritti dai giocatori e il dialogo post-partita** (`duels_comments`)
  — è la voce che pesa di più: testo libero di terzi, in quantità. Esce
  ripulito e marchiato (vedi §2.2), ma esce;
* il testo della domanda scritta in chat.

**Non escono in nessun caso** gli indirizzi IP: il registro ne ha due colonne e
la `SELECT` non le nomina; nello schema delle statistiche non ci sono già oggi.
Non escono `before`/`after` delle modifiche registrate, né user agent, né
alcun segreto di autenticazione.

È **minimizzato**: ogni funzione in `src/assistant/reader.ts` seleziona le
colonne che servono alla risposta, non la riga intera. Il file è scritto in
modo che aggiungere una colonna sia un diff che si legge come «esce un dato in
più verso un fornitore esterno».

**Le due cose da decidere:**

1. **La conservazione lato fornitore.** Va stabilito e documentato per quanto
   tempo Anthropic conserva questi dati e sotto quali condizioni contrattuali.
   Finché la decisione non è presa, la scelta prudente è lasciare
   `ANTHROPIC_API_KEY` non impostata: l'assistente resta spento e il resto del
   pannello non cambia.
2. **Il registro dei trattamenti.** Serve una riga che dichiari questo
   trasferimento, con la base giuridica e le categorie di dati sopra.

---

## 4. NOTA PER IL COMMITTENTE — le scritture future, e D-09

In v1 nessuno strumento scrive. Tre cose sono già predisposte perché
aggiungerle non sia una riscrittura:

* ogni strumento **dichiara** se è di lettura o di scrittura (`kind`), nella
  sua definizione e non in una convenzione sul nome;
* uno strumento di scrittura **non si esegue: propone**. La funzione che lo
  eseguirebbe viene sostituita in `sealWrites()`, quindi il corpo vero non è
  raggiungibile attraverso la fabbrica dei tool: non è un controllo che si può
  saltare, è un corpo che non c'è. La proposta esce dal ciclo come evento
  `confirm` del protocollo, e il client la conosce già;
* il registro distingue già l'azione fatta a mano da quella passata
  dall'assistente (`meta.via`).

**Il punto che va rivalutato prima, non dopo.** Lo step-up è stato rimosso con
la deviazione [D-09](security/deviations.md). Quando arriveranno le scritture,
la conferma esplicita dell'operatore sarà **l'unica barriera** fra una sessione
rubata e una modifica ai privilegi — e sarà una conferma che si dà con un clic,
in una chat, dentro la stessa sessione che è stata rubata. Vale la pena
riaprire D-09 prima di quel passo.

---

## 5. Installazione

```bash
# 1. Il ruolo di sola lettura. UNA volta, da un superuser.
#    (--print stampa l'SQL senza eseguirlo, da incollare in psql.)
DATABASE_SUPERUSER_URL=postgres://postgres:...@host:5432/metamc \
  node scripts/create-assistant-role.ts

# 2. La password del ruolo, fuori dal repository.
psql -c "ALTER ROLE metamc_assistant WITH PASSWORD '...'"

# 3. La migration: il modulo RBAC e i GRANT.
pnpm run migrate
```

Poi le variabili d'ambiente:

| Variabile | Default | Cosa fa |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | **assente = assistente spento.** Vive solo nell'ambiente del processo Node e non raggiunge mai il browser |
| `DATABASE_ASSISTANT_URL` | — | il ruolo `metamc_assistant`. Assente: i due strumenti sul pannello dicono «non disponibile», gli altri tre funzionano |
| `ASSISTANT_EFFORT` | `medium` | quanto a fondo pensa (`low`…`max`). Le domande sono per lo più ricerche su dati già aggregati |
| `ASSISTANT_MONTHLY_BUDGET_USD` | `50` | tetto di spesa mensile. `0` = nessun tetto, ed è una scelta esplicita |
| `ASSISTANT_TIMEOUT_MS` | `60000` | timeout verso l'API. Il default dell'SDK sarebbe dieci minuti |

Il permesso: modulo **Svetlana** (`assistente`) nella matrice. `owner` e
`admin` a 3, `dev` e `moderatore` a 1. Il livello utile è **uno solo** — in v1
non c'è niente che 2 o 3 possano concedere in più; il 3 di admin e owner serve
a non rompere la gerarchia di dominanza.

**nginx:** nessuna modifica. La rotta è `POST /api/stream/assistant` e cade nel
blocco `location /api/stream` predisposto in fase 2, con `proxy_buffering off`.
Sotto qualunque altro prefisso la chat resterebbe muta per minuti e poi
arriverebbe tutta insieme.

---

## 6. Costi — cosa guardare

### Il modello, e perché questo

`ASSISTANT_MODEL` e `ASSISTANT_SPEED` stanno in `config.ts`, non nell'ambiente:
cambiarli cambia i prezzi, il comportamento degli strumenti e la validità della
cache, quindi è una modifica che qualcuno rivede.

In vigore: **`claude-sonnet-5` a velocità normale**, 2 $/MTok in ingresso e
10 $/MTok in uscita. Prima era `claude-opus-5` a 5 e 25. Le domande di un
pannello sono ricerche su dati già aggregati, non ragionamenti lunghi: è il
lavoro su cui Sonnet 5 sta nella classe di latenza «veloce» dove Opus 5 sta in
«moderata». Meno attesa e meno spesa, dalla stessa riga.

**Sulla velocità `fast`.** Esiste solo su Opus 5 e Opus 4.8, è in anteprima di
ricerca (l'accesso si chiede), e raddoppia il listino: 10 e 50 $/MTok. Soprattutto,
accelera i token *in uscita* e non il tempo fino alla prima parola — che in una
chat con gli strumenti arriva dopo le letture, cioè proprio la parte che `fast`
non tocca. Per provarla servono due righe in `config.ts`: `claude-opus-5` come
modello e `'fast'` come velocità.

Le combinazioni impossibili **non compilano**. I prezzi stanno dentro la tabella
dei modelli e la coppia modello + velocità li sceglie da sola: `'fast'` con
Sonnet 5 è un errore di tipo, non un 400 scoperto dai log, e cambiare modello
non può lasciare indietro il listino su cui conta il tetto di spesa.

Nella stessa tabella stanno anche i **parametri** che il modello accetta —
`fallbacks` esiste solo dove esiste un classificatore di sicurezza, cioè sui
modelli Opus e Fable — ciascuno insieme all'header beta che lo accompagna.
`runner.ts` li spande senza sceglierli: un parametro scritto a mano lì accanto
sopravviverebbe al cambio di modello, ed è esattamente com'è andata (vedi
§7).

**Su Sonnet 5 il rifiuto non ha rete.** È il primo Sonnet con le salvaguardie
cyber in tempo reale: un rifiuto arriva come 200 con `stop_reason: "refusal"`,
e senza `fallbacks` non c'è nessun ripiego automatico. Il ramo di `runner.ts`
che avvisa l'operatore è quindi l'unica cosa fra un rifiuto e una chat muta.

### I limiti

Una chat con gli strumenti può chiamare l'API più volte per una sola domanda,
quindi il costo non è intuitivo. I limiti sono strutturali:

* **6 iterazioni** per messaggio (`MAX_ITERATIONS`). Se il tetto morde, la
  risposta lo dichiara invece di sembrare completa;
* **30 messaggi/ora per persona**, **300/ora per rotta**, sul rate limiter
  esistente;
* **2000 caratteri** per domanda;
* tetto di spesa mensile, con comportamento definito al superamento: Svetlana
  si spegne con un messaggio chiaro.

In `/internal/metrics`:

```
metamc_assistant_messages_total
metamc_assistant_iterations_total
metamc_assistant_truncated_total
metamc_assistant_over_budget_total
metamc_assistant_tokens_total{kind="input|output|cache_write|cache_read"}
metamc_assistant_tool_calls_total{tool,outcome}
metamc_assistant_spend_usd
metamc_assistant_budget_usd
```

**Il numero da guardare per primo è `tokens_total{kind="cache_read"}`.** Se
resta a zero mentre `input` cresce, qualcosa nel prefisso della richiesta sta
cambiando fra un messaggio e l'altro: la cache non lavora e ogni turno si paga
per intero. È un guasto che non produce nessun errore e nessun sintomo
visibile.

I due punti di cache sono sul prompt di sistema (che copre anche gli
strumenti) e sul turno dell'utente. Il prompt è **congelato** — nessuna data,
nessun nome, nessuna pagina interpolata — e il contesto variabile va **dopo**
la cronologia, come messaggio di sistema in coda. Gli strumenti sono in ordine
alfabetico: riordinarli invalida la cache di ogni conversazione in corso, e un
test lo pinna.

**Due, e restano due.** L'API ne accetta al massimo quattro per richiesta, e il
turno dell'utente finisce nella cronologia *con il marcatore addosso*: al
messaggio dopo ce n'è uno in più, e al quarto sono cinque. **Successo il
2026-08-23**: `A maximum of 4 blocks with cache_control may be provided. Found
5.` — una conversazione che va bene tre volte e poi muore sempre allo stesso
punto. `runner.ts` toglie i marcatori dalla cronologia in **lettura**
(`stripCacheControl`), così guariscono anche le conversazioni già in Valkey. Il
test manda sei messaggi di fila e conta: senza la correzione fa `2, 3, 4, 5, 6,
7`.

---

## 7. Quando non funziona

| Sintomo | Causa probabile |
|---|---|
| 503 `non_configurato` | manca `ANTHROPIC_API_KEY` |
| 503 `tetto_di_spesa` | budget mensile esaurito. `metamc_assistant_spend_usd` lo conferma |
| 429 | limite di frequenza: 30 messaggi/ora per persona |
| «la sorgente … non risulta configurata» | manca `DATABASE_ASSISTANT_URL` o `DATABASE_STATS_URL` |
| «non ha accesso al modulo …» | è un permesso mancante, non un guasto: si concede nella matrice |
| la risposta arriva tutta insieme dopo minuti | la rotta non sta passando dal blocco `location /api/stream` di nginx |
| 400 dall'API su ogni messaggio | uno dei tre parametri che nessun test può verificare davvero: il flag beta `compact-2026-01-12`, `server-side-fallback-2026-07-01`, o `strict: true` sugli schemi. Vedi sotto |
| `cache_read` fermo a zero | qualcosa nel prefisso cambia a ogni messaggio. Vedi §6 |

**Quello che i test non possono provare.** Nessun test parla con l'API: il
client è finto, e ciò che si verifica è la *richiesta che costruiamo*, contro
il contratto documentato. Tre cose si scoprono solo alla prima domanda vera in
un ambiente con una chiave:

* **quali parametri accetta il modello scelto. Successo il 2026-08-23**,
  subito dopo il passaggio a Sonnet 5: `'claude-sonnet-5' does not support the
  `fallbacks` parameter`, 400 su ogni messaggio. `fallbacks` rimedia al rifiuto
  di un classificatore, e il classificatore ce l'hanno solo i modelli Opus e
  Fable — ma nel codice era una riga fissa dentro `runner.ts`, legata a niente,
  ed è sopravvissuta al cambio di modello. Adesso ogni parametro che dipende
  dal modello sta nella tabella `MODELS` insieme al suo header beta, il runner
  li spande senza sceglierli, e un test pretende che nella richiesta non ce ne
  sia neanche uno in più (`MODEL_DEPENDENT`). Resta possibile che un modello
  nuovo rifiuti *un altro* parametro: quello lo dice solo l'API, e il posto
  dove aggiungerlo è quello;
* il flag beta della compattazione (`compact-2026-01-12`), che non dipende dal
  modello — si toglie da `runner.ts` con una riga;
* lo schema dei tool sotto `strict: true`. **Successo il 2026-08-23**: l'API
  ha rifiutato l'intera richiesta con `For 'integer' type, properties maximum,
  minimum are not supported` — `z.int()` emette da solo i limiti dell'intero
  sicuro di JavaScript. Adesso lo schema si normalizza al confine
  (`normaliseSchema` in `tools.ts`) e i limiti sui valori stanno nel codice dei
  tool, dove non si possono aggirare. Resta possibile che l'API rifiuti
  qualche altra parola: l'elenco da allargare è `UNSUPPORTED_BY_STRICT`, e un
  test lo tiene allineato con quello che gli schemi contengono davvero;
* il conto in dollari, che usa i prezzi di listino scritti in `config.ts`: la
  fattura la fa il fornitore, e questa è una stima per fermarsi prima di una
  sorpresa.

Il primo messaggio dopo un rilascio va quindi guardato, non dato per buono.

---

## 8. Dove sta il codice

```
src/assistant/
  config.ts    modello e velocità, tetti, prezzi, conversione dei token
  prompt.ts    il prompt CONGELATO, e il contesto variabile della pagina
  pages.ts     le schermate viste dal server: il titolo non viene dal client
  reader.ts    le letture — tutta la superficie che l'assistente può toccare
  tools.ts     i cinque strumenti, con l'autorizzazione dentro
  runner.ts    il ciclo, lo streaming, il turno in pausa, il tetto
  store.ts     la cronologia in Valkey e il registro della spesa
  metrics.ts   i contatori
  runtime.ts   ciò che si costruisce all'avvio
src/http/routes/assistant.ts   la rotta SSE
web/src/lib/svetlana.ts        lo stream e lo stato della chat, con i test
web/src/components/svetlana.tsx  il pannello, dal mockup
migrations/019_assistant.sql
scripts/create-assistant-role.ts
```
