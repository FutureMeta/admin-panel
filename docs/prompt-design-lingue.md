# Prompt per Claude Design — sezione «Lingue» (i18n)

> Copia dal blocco `<contesto>` in giù e incollalo in Claude Design, nel progetto che ha già tutti i mockup del pannello.

---

<contesto>
Aggiungi al pannello MetaMC una sezione **Lingue**: la piattaforma di traduzione interna con cui lo staff legge e corregge i testi che i giocatori vedono in gioco. Sostituisce un comando da console (`/langadmin key set …`) che oggi è l'unico modo per farlo.

Hai già tutto il pannello: app shell (mockup 3), design system (mockup 0), e soprattutto **Duels · Configurazioni (mockup 14)**, che contiene un editor di testo con markup MiniMessage — la stessa sintassi che qui è il cuore di tutto. Riusa quelle scelte, non ricominciare.

Chi lo usa: tre-quattro persone dello staff, desktop, per sessioni lunghe. Il lavoro tipico è **scorrere centinaia di stringhe e correggerne alcune senza rompere i tag**. Densità e velocità di lettura contano più di qualunque altra cosa; un tag `<gradient>` non chiuso deve saltare all'occhio prima del salvataggio, non dopo.
</contesto>

<il_modello>
Quattro concetti, da capire prima di disegnare.

**Bundle.** Un gruppo di testi con un nome a due parti, `proprietario.bundle`: `duels.lobby`, `duels.uhc`, `metaverse.party`. Sono circa 18 per il plugin duels più una decina di Metaverse. Vanno da ~20 a ~110 chiavi ciascuno; in tutto ~700 chiavi in inglese, moltiplicate per le lingue.

**Chiave.** Un identificatore puntato, raggruppabile ad albero: `match.starting-title`, `inventory.settings.back.name`, `scoreboard.default.lines`. Le chiavi le creano i plugin, **mai il pannello**: qui si traduce e si sovrascrive ciò che esiste.

**Un valore per chiave.** Ogni chiave, per ogni lingua, ha **un solo testo**, scritto e modificato dallo staff. Non esiste una colonna col default del plugin: i file `en.yml`/`it.yml` dentro il jar sono un backup d'emergenza che il plugin usa solo se il database non risponde, e il pannello non li vede. Non c'è quindi nessun «torna al default»: c'è il valore, e si modifica.

**Lingue.** Di serie `en` e `it`. Una lingua può essere attiva o no per i giocatori, ha un nome visualizzato (in MiniMessage, es. `<white>Italiano`), un'icona e una posizione nel menu in gioco.

**L'inglese è la lingua di riferimento.** Tre cose si misurano contro di lui: il completamento di ogni altra lingua (`en` è per definizione al 100%), la validazione dei placeholder (una traduzione deve avere gli stessi `%…%` dell'inglese), e il fallback — se un testo manca in `it`, il giocatore vede l'inglese, quindi «non tradotto» non è un errore ma uno stato da rendere visibile. Nella modalità traduzione l'inglese sta a sinistra ed è il testo *da cui* si parte.

Riferimento **non** significa sola lettura: anche il testo `en` è un valore come gli altri e lo staff può modificarlo. Nella modalità traduzione sta a sinistra perché è il testo *da cui* si parte, non perché sia intoccabile.

**Propagazione.** I server ricaricano i testi ogni ~60 secondi. Una modifica dal pannello si vede in gioco entro un minuto, non subito: la UI deve dirlo con onestà, non fingere l'istantaneo.
</il_modello>

<i_testi>
Cosa contengono i valori, perché il disegno dipende da questo:

- **MiniMessage** — `<gradient:#FF4A4A:#FF2121>`, `<bold>`, `<#FCA800>`, `<gray>`, e tag interattivi come `<hover:show_text:'…'>` e `<click:run_command:'/event join'>`.
- **Placeholder** — `%player%`, `%time%`, `%host%`, sostituiti a runtime. Non sono MiniMessage: sono un'altra cosa e vanno resi in modo distinguibile.
- **Multi-riga** — un singolo valore può avere più righe: così si scrivono le righe di una scoreboard o la lore di un oggetto.

Dove finiscono in gioco: messaggi in chat, titoli a schermo, **nomi e lore degli oggetti nelle GUI**, **titoli e righe delle scoreboard**, annunci Discord. Un'anteprima che somigli al gioco vale molto — e vale di più se sa che una riga di scoreboard e una riga di chat non si vedono allo stesso modo.
</i_testi>

<sorgente_e_reso>
Questa è la domanda di design che ti chiedo di risolvere esplicitamente e in modo coerente in tutta la sezione: **come si mostrano il sorgente con i tag e il testo reso**.

Il vincolo: si modifica sempre il **sorgente**. Un testo reso non è editabile in modo sicuro — non si può ricostruire un `<gradient>` da un colore visto a schermo.

La convenzione già presa nel mockup 14, da mantenere: nel sorgente **i tag sono tutti dello stesso grigio** (`--yml-tag`), e **il colore ce l'ha il testo che vestono** — `<red>Errore</red>` mostra il tag in grigio e la parola in rosso. Così sorgente e resa convivono nella stessa riga senza contendersi l'occhio, e chi legge vede subito sia la struttura sia il risultato. Un tag non chiuso o malformato si segnala lì, inline, con lo stile d'errore del pannello.

Sopra a questo, proponi un'**anteprima «come in gioco»**: il testo puramente reso, senza tag, dentro una cornice che ricorda il contesto — una riga di chat, la lore di un oggetto, una sidebar di scoreboard, un titolo. I placeholder nell'anteprima si sostituiscono con valori d'esempio (`%player%` → `Steve`, `%time%` → `30s`) ma restano riconoscibili come tali. I tag `hover` e `click` nell'anteprima diventano un'affordance — sottolineatura o simile — con il testo dell'hover in un tooltip.

Decidi quando l'anteprima è sempre visibile e quando è a richiesta, e tienilo uguale ovunque. Chiedo una sola cosa: che chi guarda una stringa non debba mai chiedersi «questo è quello che scrivo o quello che vede il giocatore?».
</sorgente_e_reso>

<schermate>
Cinque artboard, tutti dentro l'app shell, con «Lingue» come voce nuova in sidebar.

**1. Panoramica bundle** — la home della sezione.
Una riga di KPI (bundle totali, chiavi totali, chiavi modificate di recente, problemi aperti) e sotto l'elenco dei bundle. Per ogni bundle: namespace, numero di chiavi, **completamento per lingua** come barre affiancate (`it 84%`, `es 12%`), problemi. Le lingue in colonna, i bundle in riga: è una griglia di completamento, e deve permettere di vedere in un colpo d'occhio *dove* manca lavoro. Raggruppa per proprietario (`duels`, `metaverse`). Filtri: proprietario, lingua, solo con problemi.

**2. Esplora chiavi** — dentro un bundle.
A sinistra l'albero dei prefissi (`inventory` › `settings` › `back`), a destra la lista delle chiavi del ramo selezionato, densa, una riga per chiave: chiave in monospace, valore inglese reso-in-riga (troncato), stato per lingua come pallini o chip (tradotta / mancante / problema). Ricerca per chiave e per contenuto. Filtri: non tradotte, problemi di placeholder, MiniMessage non valido. Deve reggere 110 chiavi senza scroll infinito o paginazione: è l'ordine di grandezza reale.

**3. Editor di una chiave** — la schermata centrale.
La chiave in testa, con il percorso e il bundle. Sotto, **le lingue una accanto all'altra**, e per ognuna un solo campo editabile. Azioni: salva, annulla. Un pannello laterale con: anteprima come in gioco, avvisi di validazione, e **storico** delle versioni — `v3 · 12/09 14:32 · Vally90 · valore modificato`, `v2 · 04/09 09:10 · Psicosi · valore modificato`. L'autore oggi non è nel database: il pannello lo aggiungerà, quindi disegnalo.

**4. Modalità traduzione** — il flusso.
Inglese a sinistra, fisso, in sola lettura, con i placeholder evidenziati. Lingua di destinazione a destra, editabile. Si avanza chiave per chiave: precedente / successiva, «salta le già tradotte», contatore `38 / 110`, e una scorciatoia da tastiera per salvare-e-avanzare. Chi traduce non deve mai staccare le mani dalla tastiera. Il confronto dei placeholder è vivo: se a destra manca `%time%` che c'è a sinistra, lo si vede prima di salvare.

**5. Lingue e propagazione** — le impostazioni.
Elenco delle lingue: codice, nome visualizzato (reso, perché è MiniMessage), icona, attiva sì/no, posizione con riordino. Aggiungi lingua. E un blocco **stato di propagazione**: ultimo aggiornamento visto dai server, «in gioco tra ~40s» dopo un salvataggio, pulsante «Forza ricarica».

Lo stato di propagazione va anche **fuori** da questa schermata: dopo ogni salvataggio, in qualunque punto della sezione, un indicatore discreto dice che la modifica non è ancora arrivata in gioco. Sparisce quando arriva.
</schermate>

<stati>
Mostrali dove contano, non tutti ovunque.

- **Vuoto**: nessun bundle — «Nessun server si è ancora avviato con questo plugin». È l'unico caso: i bundle compaiono da soli al primo avvio.
- **Caricamento**: skeleton sulla lista chiavi, non spinner.
- **Errore**: banner non bloccante con riprova, come nel resto del pannello.
- **Validazione**, tre casi distinti, ognuno con la sua spiegazione: MiniMessage non valido (tag non chiuso, attributo sbagliato) — il server lo scarterebbe; placeholder che differiscono dall'inglese — `it` ha `%player%` ma manca `%time%`; valore vuoto — non ammesso, va scritto `<reset>`. Il salvataggio resta possibile? Decidilo e sii coerente: il server applica le regole comunque, quindi il pannello avvisa prima e mostra il rifiuto dopo.
- **Modifica non salvata**: indicatore sulla chiave e avviso se si cambia chiave o schermata.
- **Propagazione in attesa**: il conto alla rovescia di cui sopra.
- **Lingua disattivata**: visibile nell'elenco ma marcata; i suoi testi restano modificabili.
</stati>

<dati_esempio>
Usa questi, sono reali.

Bundle: `duels.lobby` (110 chiavi), `duels.game` (96), `duels.uhc` (41), `duels.crystal-royale` (38), `duels.event` (52), `metaverse.party` (27), `metaverse.core` (64).

Completamento: `en` sempre 100% (è il riferimento); `it` fra 70% e 100% a seconda del bundle; una terza lingua `es` appena iniziata, 8-15%, per mostrare lo stato basso.

Chiavi: `match.starting-title`, `match.starting-subtitle`, `inventory.settings.title`, `inventory.settings.back.name`, `inventory.settings.back.lore`, `scoreboard.default.title`, `scoreboard.default.lines`, `event.join.broadcast`, `event.countdown`.

Testi:

```
match.starting-title (en)
<gradient:#FF4A4A:#FF2121><bold>UHC</bold></gradient> <gray>starts in <white>%time%</white>

match.starting-title (it)
<gradient:#FF4A4A:#FF2121><bold>UHC</bold></gradient> <gray>inizia tra <white>%time%</white>

event.join.broadcast (en)
<#FCA800>%host%</#FCA800> <gray>has opened an event. <click:run_command:'/event join'><hover:show_text:'Click to join'><yellow><underlined>Join now</underlined></yellow></hover></click>

scoreboard.default.lines (en) — multi-riga
<gray>Mode: <white>%mode%
<gray>Map: <white>%map%

<gray>Players: <white>%players%
<gray>Time: <white>%time%
```

Un caso con problema di placeholder: `event.countdown` in `it` ha `%time%` ma non `%host%`, che l'inglese ha.
Un caso con MiniMessage rotto: `inventory.settings.back.lore` in `es` con un `<gradient:#…` mai chiuso.
Una chiave modificata due volte da persone diverse, per lo storico.

Nomi dello staff nello storico: quelli già usati nel resto dei mockup (`Vally90`, `Psicosi`).
</dati_esempio>

<cosa_non_fare>
- Niente creazione di chiavi: nascono dai plugin.
- Niente pulsante «traduci automaticamente»: non è nel perimetro e cambierebbe il senso della sezione.
- Niente modifica in massa: si edita una chiave alla volta, il rischio di rompere i tag è già abbastanza alto.
- Niente WYSIWYG: si modifica il sorgente, l'anteprima è a lato.
- Niente paginazione sulle chiavi di un bundle: sono al massimo poco più di cento.
</cosa_non_fare>

<consegna>
Cinque artboard come sopra, nello stesso formato degli altri mockup del progetto, numerati da **15** in avanti (`15-lingue-panoramica`, `15-lingue-esplora`, …). Desktop 1440. Token del design system, nessun colore letterale — per i tag MiniMessage il grigio già definito, per i testi resi il colore che il tag significa.

In chiusura, in poche righe: la scelta fatta su sorgente e reso, e perché.
</consegna>
