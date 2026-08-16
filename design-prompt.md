# Prompt per Claude Design — MetaMC Admin Panel

> Copia tutto il blocco qui sotto (da `<contesto>` fino alla fine) e incollalo in Claude Design.
> Allega anche `logo.png`.

---

<contesto>
Sei il lead product designer di un pannello di amministrazione web per **MetaMC**, un network Minecraft italiano (metamc.it, fondato nel 2022, ~4 modalità di gioco attive). Il pannello è uno strumento interno usato quotidianamente da owner, admin, dev e staff per monitorare l'andamento del network e gestire le operazioni.

È un prodotto **data-dense e long-lived**: verrà usato ore al giorno, su schermi grandi, spesso con più widget visibili contemporaneamente. Deve reggere il confronto visivo con Linear, Vercel Analytics, Stripe Dashboard e PlanetScale — non con i tipici pannelli Minecraft.

Il sito pubblico attuale (metamc.it) è datato: bottoni con `box-shadow: 0 6px 0` stile "gaming 2015", Bootstrap 5 di default, gerarchia tipografica piatta. **Erediti solo il brand (colori e logo), non il linguaggio visivo.** L'obiettivo esplicito è un salto di qualità: premium, sobrio, denso di informazione, con la personalità del brand che emerge da accenti mirati e non da decorazione diffusa.
</contesto>

<brand>
Logo allegato: esagono nero con la "M" bicolore (metà blu, metà arancio). Valori campionati dal file:
- Nero logo: `#0E0603`
- Arancio brand: `#DB6E19`
- Blu brand: `#2478A1`

Token colore ufficiali del sito attuale (da rispettare come base, non da copiare pedissequamente):
```
--background: #0E222D   /* blu-petrolio profondo */
--primary:    #0F0704   /* nero caldo */
--secondary:  #0E2F3F   /* petrolio */
--accent:     #DB6E19   /* arancio */
--green:      #22C55E
--red:        #DB3434
```
Font attuale del sito: **Montserrat**.

Tono del brand: tecnico, competitivo, italiano, senza infantilismi. Le modalità si chiamano **Vanilla War**, **Survival**, **Towny**, **Oasis**. Tutta la UI è in **italiano** (label, empty state, messaggi di errore, date in formato IT, fuso `Europe/Rome`).
</brand>

<direzione_visiva>
"Premium" qui significa cose concrete, non decorazione:

- **Dark UI come tema primario.** Fondo profondo e leggermente desaturato (il `#0E222D` del brand è troppo saturo per grandi superfici: usalo come tinta delle superfici, non come base). Costruisci la profondità con 3–4 livelli di superficie e bordi hairline a bassa opacità, non con ombre pesanti.
- **L'arancio `#DB6E19` è raro e prezioso.** Solo azione primaria, stato attivo, serie dati principale, focus ring. Se compare in più di ~5% dei pixel di una schermata, ne stai abusando.
- **Il blu `#2478A1` è la voce secondaria** — nella palette dei grafici va alzato in luminosità (es. `#3FA3D4`) per restare leggibile su fondo scuro.
- **Densità controllata.** Righe compatte, ma spaziatura verticale generosa tra i blocchi. Il ritmo lo dà la scala di spacing, non i separatori: usa spazio bianco prima di aggiungere una linea.
- **Numeri come cittadini di prima classe.** Cifre tabulari ovunque compaiano dati, allineamento a destra nelle tabelle numeriche, unità e delta sempre espliciti.
- **Zero effetti gaming.** Niente glow al neon, niente gradienti viola da SaaS template, niente ombre dure offset, niente emoji come icone, niente skeuomorfismo a blocchi Minecraft. Il riferimento a Minecraft nell'interfaccia si limita agli avatar/skin dei giocatori e al motivo esagonale del logo, usato con parsimonia.
- **Un set di icone unico e coerente** (stile lineare 1.5px, es. Lucide/Phosphor), stessa ottica su tutta l'app.
- **Movimento discreto:** 120–200ms ease-out per hover/stati, ~400ms per l'ingresso dei grafici, nessun bounce.

Consegna anche un **tema chiaro** derivato dagli stessi token (stessa gerarchia, non un semplice invert).
</direzione_visiva>

<design_system>
Definisci per primo il sistema, poi applicalo. Serve:

1. **Token colore** — scala di superfici (base → surface → elevated → overlay), bordi (subtle/strong), testo (primary/secondary/muted/disabled), accento + varianti (hover, pressed, soft-background 10–12%), semantici (success/warning/danger/info) con la loro variante soft, e stati di focus.
2. **Palette per la data-viz** — 6–8 colori categorici distinguibili anche in scala di grigi e con deuteranopia, che partono da arancio e blu brand; più una rampa sequenziale (per heatmap e mappa) e una divergente (per i delta). Documenta quale colore è assegnato a ciascuna delle 4 modalità e mantienilo identico in **tutti** i grafici dell'app.
3. **Tipografia** — Montserrat resta per titoli, numeri KPI grandi e lockup del logo; per il corpo, le tabelle e la UI densa scegli un carattere pensato per l'interfaccia (es. Inter) e un monospace per ID, UUID, IP e comandi. Scala di 8 step con size/line-height/weight/letter-spacing dichiarati.
4. **Spacing** — base 4px, scala esplicita.
5. **Raggi, bordi, elevazioni** — pochi valori, ben motivati.
6. **Inventario componenti** — bottoni (primary/secondary/ghost/danger, 3 taglie, tutti gli stati incluso loading e disabled), input, select, date/range picker, toggle, checkbox, badge di stato, pill, tab, tooltip, dropdown, modal, drawer, toast, tabella dati (header sticky, ordinamento, selezione multipla, paginazione, riga espandibile), card KPI, card grafico, avatar giocatore (skin Minecraft), breadcrumb, command palette, skeleton loader, empty state, banner di errore.
</design_system>

<architettura_prodotto>
Il pannello è **modulare e a inviti**. Nascerà con pochi moduli e ne aggiungeremo molti nel tempo: la navigazione e il sistema di permessi devono essere progettati per scalare a 15–20 moduli senza collassare.

- **Nessuna registrazione.** Si entra solo su invito.
- Ogni utente ha accesso a un sottoinsieme di moduli. **In sidebar compaiono solo i moduli a cui ha accesso** — nessuna voce disabilitata o lucchettata.
- I permessi sono per modulo e per livello (es. `nessuno / lettura / scrittura / gestione`), aggregabili in ruoli riusabili.
- Ogni azione rilevante finisce in un **registro attività** consultabile.
</architettura_prodotto>

<schermate>
Progetta queste schermate in alta fedeltà, in quest'ordine:

**1. Login**
Accesso su invito: email + password, 2FA a 6 cifre come secondo step, "resta connesso". Nessun link di registrazione — al suo posto una riga sobria che spiega che l'accesso è riservato e come richiederlo. Composizione a due pannelli con il lato brand costruito sul motivo esagonale del logo. Includi lo stato di errore (credenziali errate) e quello di account sospeso.

**2. Accettazione invito**
Landing da link email: badge del ruolo assegnato, elenco dei moduli a cui si avrà accesso, impostazione password + attivazione 2FA obbligatoria.

**3. App shell**
Sidebar collassabile con moduli raggruppati per area e ricerca rapida; topbar con selettore periodo globale, selettore modalità (Globale / Vanilla War / Survival / Towny / Oasis), command palette (⌘K), notifiche, menu utente, e un indicatore di stato del network (online/degradato/offline). Mostra sia lo stato esteso che quello collassato.

**4. Panoramica network — la schermata centrale del prodotto**
È il cuore del pannello. Deve contenere:
- **Riga KPI**: giocatori online ora (+ delta vs stessa ora ieri), picco odierno, giocatori unici oggi, tempo medio di sessione, nuovi giocatori oggi, record storico. Ogni KPI con sparkline e delta percentuale colorato.
- **Andamento online nel tempo** — grafico ad area, il widget più grande della pagina. Serie totale + serie per modalità attivabili dalla legenda, marker sul picco, brush per lo zoom, annotazioni per riavvii ed eventi. Range: 24h / 7g / 30g / 90g / personalizzato, con toggle di confronto sul periodo precedente (linea tratteggiata).
- **Distribuzione per modalità** — ripartizione della popolazione corrente con quota % e variazione, affiancata da una tabella per-modalità (online, picco, unici, sessione media).
- **Heatmap di affluenza** — 7 giorni × 24 ore, rampa sequenziale, tooltip con valore e confronto con la media di quella fascia.
- **Giocatori unici giornalieri** — barre con split nuovi / di ritorno e linea di media mobile a 7 giorni.
- **Provenienza geografica** — mappa del mondo a coropleto con classifica dei primi 10 paesi affiancata; siccome l'utenza è prevalentemente italiana, prevedi il drill-down sulle regioni italiane e una scala che non appiattisca tutto il resto del mondo su un solo colore. Filtrabile per modalità come il resto della pagina.
- **Composizione client** — Java vs Bedrock e distribuzione versioni.
- **Retention** D1 / D7 / D30.

Ogni widget ha: titolo, sottotitolo con il periodo, menu (esporta CSV/PNG, apri in dettaglio), stato di caricamento (skeleton), stato vuoto e stato di errore. Mostra almeno un widget in ciascuno di questi stati.

**5. Dettaglio modalità**
Stessa griglia analitica ma focalizzata su una modalità (usa Towny come esempio), con le metriche specifiche del gioco (città/nazioni attive, per Towny) e la classifica dei giocatori per ore giocate.

**6. Utenti & Ruoli**
Tabella degli utenti del pannello (avatar, nome, ruolo, moduli, ultimo accesso, stato) con filtri e azioni di riga. Pannello di dettaglio utente. Editor del ruolo con la **matrice dei permessi**: moduli in riga, livelli in colonna — deve restare leggibile con 20 moduli, quindi progetta raggruppamento e scroll con header sticky. Includi la conferma per le modifiche distruttive e il flusso "invita utente" (drawer: email, ruolo, override sui moduli, scadenza invito).

**7. Registro attività / Pannello admin**
Feed cronologico delle azioni recenti con attore, azione, oggetto, timestamp, IP; filtri per utente / modulo / tipo di azione / intervallo; riga espandibile con il diff prima/dopo; badge per le azioni sensibili. Prevedi anche la vista degli inviti pendenti e delle sessioni attive.

**8. Stati di sistema**
403 "non hai accesso a questo modulo", 404, errore di connessione al feed realtime (banner non bloccante con retry), manutenzione.

**9. Responsive**
Desktop 1440 come riferimento primario, 1280 come minimo denso, poi tablet 768 e mobile 390 per almeno la panoramica e il registro attività — su mobile i grafici vanno ripensati, non compressi.
</schermate>

<regole_dataviz>
- Griglie a `rgba(255,255,255,0.05)`, assi in testo muted, nessun bordo attorno all'area del grafico.
- Un colore = una modalità, sempre lo stesso in tutta l'app.
- Gradienti sotto le aree solo come velatura del colore della serie (opacità max ~15%), mai arcobaleno.
- Tooltip come piccola card con cifre tabulari, unità, timestamp completo e confronto.
- Legende interattive (click per isolare la serie).
- Ogni asse temporale dichiara il fuso (`Europe/Rome`); ogni valore dichiara l'unità.
- Nessun 3D, nessuna torta con più di 5 fette, nessun doppio asse Y.
- Prevedi il caso "dati parziali" (buco nella serie per downtime di raccolta): va mostrato, non interpolato in silenzio.
</regole_dataviz>

<accessibilita>
Contrasto AA sul testo e sui bordi degli elementi interattivi; l'informazione nei grafici non affidata al solo colore (forma del marker, pattern o etichetta diretta); focus ring visibile su ogni elemento raggiungibile da tastiera; target tattili ≥ 40px su mobile; la command palette e le tabelle navigabili da tastiera.
</accessibilita>

<output>
Consegna in questo ordine:
1. I token del design system (colore, tipografia, spacing, raggi, elevazioni, motion) in forma di variabili CSS pronte all'uso, tema scuro e tema chiaro.
2. La palette data-viz con l'assegnazione dei colori alle 4 modalità.
3. Le schermate elencate, in alta fedeltà, con dati realistici e plausibili (nomi giocatori italiani, orari serali di picco, numeri coerenti tra un widget e l'altro — se il totale online è 847, la somma per modalità deve fare 847).
4. Un breve razionale delle scelte non ovvie (max ~200 parole in totale, alla fine).

Testo dell'interfaccia in italiano. Il commento a corredo sia asciutto: il valore sta negli schermi e nei token, non nella descrizione.
</output>

<scope>
Consegna esattamente questo perimetro, per intero. Non aggiungere moduli non richiesti (economia, ticket, ban manager, shop: li progetteremo dopo) e non ridurre il perimetro delle statistiche, che è la parte più importante. Le decisioni di routine prendile da solo. Se ritieni che una scelta qui sopra sia sbagliata o che esista un'alternativa migliore, dillo in una frase e poi procedi come richiesto.
</scope>
