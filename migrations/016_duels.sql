-- ============================================================================
-- Migration 016 — le tabelle del modulo Duels.
--
-- DOVE STANNO E PERCHE'. Nello schema `stats`, con prefisso `duels_`, non in
-- uno schema nuovo: `stats.ensure_partitions` costruisce le partizioni con
-- `format('CREATE TABLE stats.%I PARTITION OF stats.%I ...')` e lo schema e'
-- CABLATO nel format (011_stats.sql:919). Stando dentro `stats` si ereditano
-- gratis il registro delle partizioni, la retention per DROP, i ruoli e i
-- GRANT. Fuori, andrebbe riscritto tutto.
--
-- COSA CI FINISCE DENTRO. Solo aggregati e feedback: le partite grezze
-- restano nel MySQL del gioco e le tocca soltanto il job di ingestione.
-- Nessuna schermata interroga mai una riga di partita.
--
-- IL FUSO NON COMPARE IN NESSUNA COLONNA. Gli istanti sono `timestamptz` in
-- UTC e le etichette locali si calcolano UNA volta nelle viste, come per
-- `v_online_1h`. E' la regola gia' in vigore: `stats.civil_day()` e
-- `stats.day_seconds()` sono le uniche funzioni autorizzate a nominare il
-- fuso (011_stats.sql:107-124). Il pannello legacy fa l'opposto — sonda SQL
-- sul percorso caldo e offset inlineato nella stringa — ed e' la ragione per
-- cui i suoi predicati non usano nessun indice.
-- ============================================================================
SET LOCAL lock_timeout      = '3s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. FATTI: partite per ORA UTC.
--
-- I conteggi di partite sono ADDITIVI, ed e' cio' che permette di tenere il
-- solo grano orario: qualunque periodo piu' lungo e' una somma esatta, non
-- una stima. E' la stessa regola dei rollup della fase 2 — solo interi
-- additivi, gerarchia esatta e non approssimata (011_stats.sql:20-22).
--
-- La chiave porta tipo e contesto perche' le tab della schermata filtrano su
-- quelli SENZA rifare una richiesta: il payload trasporta una serie per
-- combinazione presente, e il client somma quelle che passano il filtro.
-- ---------------------------------------------------------------------------
CREATE TABLE stats.duels_match_hour (
  bucket_at  timestamptz NOT NULL,
  mode_id    smallint    NOT NULL,
  map_id     integer     NOT NULL,
  -- `type` e `context` sono VARCHAR liberi in origine, non enum: in
  -- produzione possono esistere valori che il legacy non contempla e che
  -- finivano indistinti dentro «ALL». Si trasportano come testo per non
  -- perderli.
  match_type text        NOT NULL,
  context    text        NOT NULL,
  matches    integer     NOT NULL CHECK (matches > 0),
  PRIMARY KEY (bucket_at, mode_id, map_id, match_type, context)
) PARTITION BY RANGE (bucket_at);

-- NON ESISTE UN GRANO GIORNALIERO, e non e' una semplificazione: e' un fatto
-- misurato. Su 2.491.686 righe di `duels_match_statistics` in produzione,
-- `created_at` e' NULL **zero volte** — storico dal 9 marzo al 22 agosto 2026,
-- 166 giorni. Non c'e' nessuna partita senza orario da mettere da parte.
--
-- Cade quindi tutto il percorso che la specifica costruisce al §6.4: nessuna
-- tabella a parte per le partite senza orario, nessun campo `untimed` nel
-- payload, nessuna riga d'interfaccia che lo dichiara. E soprattutto niente
-- `COALESCE(created_at, date)`, che nel legacy manda quelle righe tutte nella
-- colonna «00» della mappa di attivita': qui non ci sono righe da mandare da
-- nessuna parte.
--
-- La conseguenza che conta per chi guarda: la mappa di attivita' e' valida su
-- TUTTO lo storico, senza avvertenze e senza un periodo massimo.

-- ---------------------------------------------------------------------------
-- 2. CATALOGHI. Poche decine di righe, replicati per intero a ogni giro.
--
-- LA FORMA DELLA SORGENTE E' ACCERTATA, non piu' da indovinare. In produzione
-- `duels_mode` e' post-migrazione: `ranking varchar(50) NOT NULL DEFAULT
-- 'UNRANKED'` e `type varchar(50) NOT NULL DEFAULT 'DUEL'` sono due colonne
-- distinte. Si leggono direttamente.
--
-- Il legacy sceglieva a runtime fra `m.ranking` e `m.type` interrogando
-- INFORMATION_SCHEMA e memorizzava l'esito in una Map di processo SENZA
-- scadenza — dopo una migrazione del gioco avrebbe continuato con la forma
-- vecchia fino al riavvio. Quel doppio percorso qui non entra: la forma e'
-- una, ed e' scritta.
--
-- Entrambe NOT NULL perche' lo sono all'origine: il filtro
-- Tutte/Ranked/Unranked non ha quindi un ramo «sconosciuto» da disegnare.
--
-- `mode_id` e' smallint: l'AUTO_INCREMENT della sorgente e' a 86. `map_id`
-- resta integer, sotto, perche' di quello non ho un numero — e un id piu'
-- grande di 32767 si manifesterebbe come job fallito, non come colonna
-- stretta.
-- ---------------------------------------------------------------------------
CREATE TABLE stats.duels_mode (
  mode_id      smallint PRIMARY KEY,
  name         text NOT NULL,
  display_name text NOT NULL,
  ranking      text NOT NULL,
  mode_type    text NOT NULL,
  -- Stesso vincolo di `stats.mode.color`: un colore non valido non rompe il
  -- database, rompe il grafico — cioe' si scopre tardi.
  color        text CHECK (color ~ '^#[0-9a-f]{6}$'),
  seen_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stats.duels_map (
  map_id       integer  PRIMARY KEY,
  name         text,
  display_name text,
  map_type     text,
  seen_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 3. FEEDBACK POST-PARTITA. **DATO PERSONALE.**
--
-- Non e' un sistema di abilita': non e' Elo, non e' Glicko, non e' MMR. Sono
-- le stelle da 1 a 5 che il giocatore lascia a fine partita, con un commento
-- facoltativo. In tutta la schermata non esiste aritmetica oltre COUNT, AVG e
-- SUM.
--
-- `rating BETWEEN 1 AND 5` E' GARANTITO ALL'ORIGINE: il DDL del plugin ha
-- `CONSTRAINT chk_rating`, verificato in produzione. Non serve quindi nessuna
-- contromisura di scarto e conteggio in ingestione — i fuori scala non
-- possono esistere. Il vincolo resta comunque qui, dove costa nulla: e' il
-- contratto su cui la UI si appoggia (`colori[r - 1]` va fuori array per 0 o
-- 6), e un vincolo dichiarato due volte non ha mai fatto danno.
--
-- `player_name` e' denormalizzato in ingestione da `duels_userdata.username`
-- (varchar(32), UNIQUE, NULLABILE). E' NULLABILE anche qui, e per una ragione
-- che non e' un guasto: essendo UNIQUE, un cambio nome deve liberare il
-- vecchio valore prima di scrivere il nuovo, quindi i NULL transitori sono
-- normali. La schermata mostra allora lo uuid o un segnaposto — non si rompe
-- e non inventa un nome.
--
-- `duels_replay_participants` non entra da nessuna parte: in produzione ha
-- ZERO righe. Il `NAME_LATERAL` del legacy materializzava due volte per
-- richiesta una tabella senza dati.
--
-- `dialog` e' jsonb VALIDATO LATO SERVER, e il contratto e' accertato: array
-- di turni `{role, content}` con `role` in `bot` | `player`, nessun timestamp
-- e nessun id — conta solo l'ordine. E' un seguito automatico alla
-- valutazione, quindi popolato su una minoranza delle righe.
--
-- Il testo dei turni `player` e' scritto dai giocatori: vale il divieto di
-- `innerHTML` gia' imposto dalla guardia, e la retention e' la stessa di
-- `comment` perche' e' lo stesso genere di dato. Il contenuto e' in inglese
-- mentre l'interfaccia e' in italiano: si mostra com'e', non si traduce.
--
-- All'origine la colonna e' `text` senza vincoli, quindi il parsing e'
-- DIFENSIVO: un JSON malformato o un ruolo inatteso non fanno fallire il
-- lotto, si contano e si prosegue.
-- ---------------------------------------------------------------------------
-- L'IDENTITA' DEL GIOCATORE VIENE DALL'ORIGINE, e l'origine non ha uno uuid
-- su questa riga. Il DDL del plugin dice
--
--     player_id INT NOT NULL,
--     FOREIGN KEY (player_id) REFERENCES duels_userdata(id)
--
-- cioe' un intero, chiave esterna verso l'anagrafica del gioco. Lo uuid sta
-- una tabella piu' in la'. Quindi:
--
--   * `player_id` e' NOT NULL, perche' e' l'unica identita' che il feedback
--     porta davvero con se';
--   * `player_uuid` e' NULLABILE, perche' si risolve con una lettura in piu'
--     e quella lettura puo' non trovare la riga — un giocatore cancellato,
--     un'anagrafica non allineata. Dichiararlo NOT NULL avrebbe fatto fallire
--     l'ingestione su un caso che non e' un errore.
--
-- `match_id` e' `BINARY(16) NOT NULL` all'origine: e' uno uuid in forma
-- binaria e si converte, non si tiene come byte.
CREATE TABLE stats.duels_rating (
  rating_id   bigint      NOT NULL,
  created_at  timestamptz NOT NULL,
  match_id    uuid        NOT NULL,
  player_id   integer     NOT NULL,
  player_uuid uuid,
  player_name text,
  mode_id     smallint,
  -- L'origine ha gia' `CONSTRAINT chk_rating CHECK (rating BETWEEN 1 AND 5)`.
  -- Questo vincolo resta comunque: i CHECK di MySQL sono applicati solo dalla
  -- 8.0.16 in avanti e una tabella creata prima li porta come commento. Un
  -- vincolo che dipende dalla versione del server altrui non e' una garanzia.
  rating      smallint    NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     text,
  dialog      jsonb,
  PRIMARY KEY (created_at, rating_id)
) PARTITION BY RANGE (created_at);

COMMENT ON TABLE stats.duels_rating IS
  'DATO PERSONALE: uuid del giocatore, nome, e testo libero scritto da lui. Retention per DROP di partizione, vedi stats.partitioned_table.';

-- Aggregato additivo dei voti: KPI, distribuzione e andamento si servono da
-- qui senza toccare una riga di feedback. Il legacy fa tre query sequenziali,
-- due delle quali senza filtro temporale, che aggregano TUTTO lo storico ogni
-- sessanta secondi per riempire due riquadri.
--
-- `mode_id = -1` e' la riga «tutte le modalita'» (un feedback senza modalita'
-- risolta). Non e' un id valido, quindi non collide.
CREATE TABLE stats.duels_rating_day (
  day          date     NOT NULL,
  mode_id      smallint NOT NULL DEFAULT -1,
  n            integer  NOT NULL CHECK (n >= 0),
  sum_rating   integer  NOT NULL CHECK (sum_rating >= 0),
  with_comment integer  NOT NULL CHECK (with_comment >= 0),
  r1 integer NOT NULL CHECK (r1 >= 0),
  r2 integer NOT NULL CHECK (r2 >= 0),
  r3 integer NOT NULL CHECK (r3 >= 0),
  r4 integer NOT NULL CHECK (r4 >= 0),
  r5 integer NOT NULL CHECK (r5 >= 0),
  PRIMARY KEY (day, mode_id),
  -- Le cinque barre DEVONO fare il totale. E' l'invariante che rende onesta
  -- la distribuzione: senza, una barra persa in aggregazione non si vedrebbe.
  CONSTRAINT duels_rating_day_bars_sum_to_n CHECK (r1 + r2 + r3 + r4 + r5 = n),
  CONSTRAINT duels_rating_day_comments_within CHECK (with_comment <= n)
);

-- ---------------------------------------------------------------------------
-- 4. STATO DELL'INGESTIONE.
--
-- Watermark sulla chiave primaria della sorgente: `WHERE id > last_id`. E' una
-- lettura indicizzata, non una scansione, ed e' cio' che rende sostenibile un
-- ciclo da trenta secondi.
--
-- `since_day` e' il primo giorno che esiste DAVVERO. Serve alla schermata per
-- dire «raccolta iniziata il ...» invece di disegnare zeri: prima di quella
-- data il dato non c'e', e `0` e `null` non sono la stessa cosa.
-- ---------------------------------------------------------------------------
CREATE TABLE stats.duels_ingest_state (
  source      text PRIMARY KEY CHECK (source IN ('match', 'rating', 'catalog')),
  last_id     bigint NOT NULL DEFAULT 0 CHECK (last_id >= 0),
  last_run_at timestamptz,
  since_day   date,
  -- Righe DEGRADATE in ingestione, contate per poterlo dire. Due generi, e il
  -- secondo non dovrebbe mai accadere: un `dialog` che non e' un array di
  -- turni {role, content} — e la riga si scrive comunque, con `dialog` nullo,
  -- perche' perdere un feedback per un seguito malformato sarebbe
  -- sproporzionato — oppure un `match_id` illeggibile, e allora la riga non si
  -- scrive affatto. Il secondo caso e' impossibile per costruzione (BINARY(16)
  -- NOT NULL: HEX() ne restituisce sempre 32 caratteri esadecimali), quindi se
  -- il contatore sale senza un solo dialogo storto c'e' qualcosa di nuovo
  -- all'origine. Il voto fuori scala non entra qui perche' non puo' esistere:
  -- il vincolo c'e' gia' sul MySQL.
  degraded    bigint NOT NULL DEFAULT 0 CHECK (degraded >= 0)
);

INSERT INTO stats.duels_ingest_state (source) VALUES ('match'), ('rating'), ('catalog');

-- ---------------------------------------------------------------------------
-- 5. PARTIZIONI E RETENTION.
--
-- `duels_match_hour` a 3650 giorni: sono conteggi aggregati, nessun dato
-- personale, e la domanda «com'era due anni fa» ha senso su un gioco.
--
-- `duels_rating` a 730 giorni, **come `stats.player_day`** (011_stats.sql:870),
-- perche' contiene dati personali. E' il valore che la specifica propone e
-- l'unico numero di questa migration che e' una DECISIONE e non una
-- conseguenza: senza un tetto, i commenti dei giocatori resterebbero per
-- sempre. Cambiarlo e' una riga in una migration successiva.
-- ---------------------------------------------------------------------------
INSERT INTO stats.partitioned_table (table_name, granularity, keep_days, partition_options) VALUES
  ('duels_match_hour', 'month', 3650, 'autovacuum_vacuum_insert_scale_factor=0.02'),
  ('duels_rating',     'month',  730, 'autovacuum_vacuum_insert_scale_factor=0.02');

SELECT stats.ensure_partitions();

-- ---------------------------------------------------------------------------
-- 5b. LE PARTIZIONI DEL PASSATO, che `ensure_partitions` non puo' creare.
--
-- `stats.ensure_partitions` guarda AVANTI: dal mese scorso a due mesi avanti
-- (011_stats.sql:900-905). Va bene per un flusso che nasce oggi e cresce in
-- avanti — ed e' il caso di tutte le tabelle della 011, alimentate da un tick
-- che campiona il presente.
--
-- Qui no. Lo storico dei duels comincia il 2026-03-09 e va importato tutto in
-- una volta: senza le partizioni dei mesi passati il backfill morirebbe al
-- primo lotto con SQLSTATE 23514 «no partition of relation found» — e ci
-- morirebbe a meta' importazione, con dentro un pezzo di storia e nessun modo
-- di sapere quale.
--
-- Si parte da GENNAIO 2026, un mese prima della riga piu' vecchia accertata:
-- il margine costa due tabelle vuote e copre un dato retrodatato.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t record; m date; part text; lo text; hi text; made integer := 0;
BEGIN
  FOR t IN SELECT table_name, partition_options FROM stats.partitioned_table
            WHERE table_name IN ('duels_match_hour', 'duels_rating')
            ORDER BY table_name LOOP
    FOR m IN SELECT s::date FROM generate_series(
               date '2026-01-01',
               (date_trunc('month', current_date) - interval '1 month')::date,
               interval '1 month') s LOOP
      part := format('%s_%s', t.table_name, to_char(m, 'YYYY_MM'));
      CONTINUE WHEN to_regclass('stats.' || quote_ident(part)) IS NOT NULL;

      -- I confini si scrivono con l'offset ESPLICITO, non come date nude: su
      -- una chiave timestamptz un letterale senza offset viene interpretato
      -- nel fuso della sessione, e la stessa migration applicata da un client
      -- a Roma e da uno a UTC creerebbe partizioni sfalsate di due ore. E'
      -- la ragione per cui `ensure_partitions` si impone `SET TimeZone`; qui
      -- non c'e' una funzione su cui imporlo, quindi lo dice il letterale.
      lo := to_char(m, 'YYYY-MM-DD') || ' 00:00:00+00';
      hi := to_char((m + interval '1 month')::date, 'YYYY-MM-DD') || ' 00:00:00+00';

      EXECUTE format(
        'CREATE TABLE stats.%I PARTITION OF stats.%I FOR VALUES FROM (%L) TO (%L) WITH (%s)',
        part, t.table_name, lo, hi, t.partition_options);
      made := made + 1;
    END LOOP;
  END LOOP;
  RAISE NOTICE 'partizioni storiche duels create: %', made;
END $$;

-- ---------------------------------------------------------------------------
-- 6. VISTE DI LETTURA, ed e' li' che va il GRANT.
--
-- Nel pannello il ruolo di sola lettura riceve il permesso sulle VISTE, non
-- sulle tabelle (011_stats.sql:987-992). La ragione e' la stessa di allora:
-- chi leggesse le tabelle nude ricaverebbe medie con il denominatore
-- sbagliato e zeri al posto dei buchi.
--
-- LE ETICHETTE LOCALI SI CALCOLANO QUI E SOLO QUI.
--
-- `local_dow` e' 0 = LUNEDI', non 1. MySQL `WEEKDAY()` e' 0=lunedi',
-- PostgreSQL `isodow` e' 1=lunedi': senza il `- 1` la mappa di attivita'
-- ruota di una riga e SEMBRA PLAUSIBILE — nessun test la prende, nessuno se
-- ne accorge guardandola. E' la trappola che la specifica segnala per nome.
--
-- Il giorno di 25 ore (fine ora legale) ha due ore UTC che cadono sulla stessa
-- ora locale: la somma e' corretta cosi' com'e' e non va «aggiustata».
-- ---------------------------------------------------------------------------
CREATE VIEW stats.v_duels_hour AS
SELECT h.bucket_at, h.mode_id, h.map_id, h.match_type, h.context, h.matches,
       (extract(isodow FROM (h.bucket_at AT TIME ZONE 'Europe/Rome'))::smallint - 1) AS local_dow,
       extract(hour FROM (h.bucket_at AT TIME ZONE 'Europe/Rome'))::smallint         AS local_hour,
       stats.civil_day(h.bucket_at) AS local_day
FROM stats.duels_match_hour h;


CREATE VIEW stats.v_duels_mode AS
SELECT mode_id, name, display_name, ranking, mode_type, color FROM stats.duels_mode;

CREATE VIEW stats.v_duels_map AS
SELECT map_id, name, display_name, map_type FROM stats.duels_map;

CREATE VIEW stats.v_duels_rating_day AS
SELECT day, mode_id, n, sum_rating, with_comment, r1, r2, r3, r4, r5
FROM stats.duels_rating_day;

-- La sola vista che espone dati personali. Il GRANT sta comunque qui, e chi la
-- interroga passa da `requireLevel(actor, 'duels_feedback', 1)`: il confine e'
-- nella rotta, questo e' solo il canale.
CREATE VIEW stats.v_duels_rating AS
SELECT rating_id, created_at, match_id, player_id, player_uuid, player_name, mode_id, rating, comment, dialog
FROM stats.duels_rating;

-- `since_day` serve alla schermata per dichiarare da quando esiste il dato.
CREATE VIEW stats.v_duels_ingest AS
SELECT source, last_id, last_run_at, since_day, degraded FROM stats.duels_ingest_state;

-- ---------------------------------------------------------------------------
-- 7. PRIVILEGI. Scrittura al gruppo, lettura SOLO sulle viste.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON
  stats.duels_match_hour, stats.duels_mode,
  stats.duels_map, stats.duels_rating, stats.duels_rating_day,
  stats.duels_ingest_state
  TO metamc_stats_rw;

GRANT SELECT ON
  stats.v_duels_hour, stats.v_duels_mode,
  stats.v_duels_map, stats.v_duels_rating_day, stats.v_duels_rating,
  stats.v_duels_ingest
  TO metamc_stats;

-- ---------------------------------------------------------------------------
-- 8. RICERCA SUI FEEDBACK.
--
-- La lista cerca su nome del giocatore E testo del commento. Nel legacy e'
-- `LIKE '%q%'` su un COALESCE che coinvolge una colonna della derivata: non
-- indicizzabile per costruzione, quindi ogni ricerca e' una scansione.
--
-- `pg_trgm` e' un'estensione FIDATA da PostgreSQL 13: il proprietario del
-- database puo' crearla senza essere superuser. Se questa riga fallisse in
-- produzione, il rimedio e' un `CREATE EXTENSION` fatto da chi amministra il
-- cluster — non un ripiego a LIKE, che rimetterebbe la scansione.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX duels_rating_name_trgm  ON stats.duels_rating USING gin (player_name gin_trgm_ops);
CREATE INDEX duels_rating_comment_trgm ON stats.duels_rating USING gin (comment gin_trgm_ops);

-- Gli indici della lista: uno per ogni ordinamento offerto, perche' la
-- paginazione e' a KEYSET e il cursore e' la tupla dell'ORDER BY. Senza,
-- «Peggiori prima» ordinerebbe con un sort su tutto il periodo.
CREATE INDEX duels_rating_by_score ON stats.duels_rating (rating, created_at DESC, rating_id DESC);
CREATE INDEX duels_rating_by_mode  ON stats.duels_rating (mode_id, created_at DESC, rating_id DESC);

-- ---------------------------------------------------------------------------
-- 9. LA REVOCA CHE SERVE, e la trappola che la rende necessaria.
--
-- La 011 chiude i suoi privilegi con:
--
--     ALTER DEFAULT PRIVILEGES FOR ROLE metamc_migrate IN SCHEMA stats
--       GRANT SELECT ON TABLES TO metamc_stats;      (011_stats.sql:993-994)
--
-- I privilegi predefiniti valgono per gli oggetti creati DOPO quella riga.
-- Le tabelle della 011 nascono prima e restano coperte dal solo GRANT
-- esplicito sulle viste — che e' la regola dichiarata, ed e' vera per loro.
-- Ogni tabella aggiunta a `stats` da qui in avanti, invece, riceve SELECT a
-- `metamc_stats` in automatico e senza che nessuno lo scriva.
--
-- Quindi la regola «il ruolo di sola lettura vede le VISTE, non le tabelle»
-- era gia' inerte per tutto cio' che sarebbe venuto dopo. Non se ne accorge
-- nessuno leggendo: si vede solo provando a interrogare una tabella nuova con
-- quel ruolo e ottenendo una risposta invece di un rifiuto. Il test di questa
-- migration lo fa, ed e' cosi' che e' saltato fuori.
--
-- Qui si revoca. Chi aggiungera' una tabella di fatto in `stats` con la
-- migration 017 dovra' fare lo stesso: il predefinito lavora contro la regola,
-- non a favore.
-- ---------------------------------------------------------------------------
REVOKE ALL ON
  stats.duels_match_hour, stats.duels_mode,
  stats.duels_map, stats.duels_rating, stats.duels_rating_day,
  stats.duels_ingest_state
  FROM metamc_stats;

-- L'origine indicizza `(player_id, created_at)`: si tiene la stessa forma.
-- «Tutti i feedback di questo giocatore» e' la domanda che verra' fatta il
-- giorno in cui qualcuno segnala un commento, ed e' anche il verso in cui si
-- cancella un profilo.
CREATE INDEX duels_rating_by_player ON stats.duels_rating (player_id, created_at DESC);
