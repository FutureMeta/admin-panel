-- ============================================================================
-- Migration 011 — schema `stats` (fase 2, statistiche del network MetaMC).
-- Ruolo esecutore: metamc_migrate.
--
-- PAVIMENTO DI VERSIONE: PostgreSQL 17. Niente min/max(bytea), niente
-- uuidv7(), niente casefold(), niente array_sort/array_reverse, niente
-- NOT ENFORCED, niente WITHOUT OVERLAPS, niente colonne generate VIRTUAL.
-- La guardia che lo impone e' scripts/check-pg17.ts, dentro `pnpm run check`.
-- Una migration che applica pulita su 18 non prova niente sulla 17: PL/pgSQL
-- analizza l'SQL alla PRIMA ESECUZIONE, quindi ogni funzione scritta qui va
-- anche ESEGUITA nei test, non solo creata.
--
-- REGOLE PORTANTI, valide per tutto il file:
--   1. Il grano grezzo e' (tick, SERVER), mai (tick, giocatore) e mai
--      (tick, modalita'). La modalita' si risolve IN LETTURA: riclassificare
--      un server e' una riga di dizionario, non un ricalcolo dello storico.
--   2. Il DENOMINATORE di ogni media viene da stats.poll_cycle, mai dalle
--      righe del server. `covered_s` e' replicato uguale su tutte le righe
--      dello stesso bucket proprio perche' non lo si ricavi per errore.
--   3. Nei rollup si memorizzano solo interi ADDITIVI: la gerarchia
--      5m -> 1h -> 1d e' esatta, non approssimata. Nessuna colonna `avg`.
--   4. `delta_s` sta su ogni riga grezza: la cadenza non e' mai una costante
--      di query e cambiarla non reinterpreta lo storico.
--   5. I confini di partizione sono UTC (SET TimeZone nelle funzioni);
--      il GIORNO CIVILE dei dati e' sempre Europe/Rome (stats.civil_day).
--   6. I job li tiene l'applicazione. Niente pg_cron, niente cron esterno.
-- ============================================================================
-- La transazione la apre il runner (scripts/migrate.ts), come per le 001-010:
-- un BEGIN qui dentro chiuderebbe la transazione PRIMA che il runner scriva
-- la riga in schema_migration.
SET LOCAL lock_timeout      = '3s';
SET LOCAL statement_timeout = '120s';

CREATE SCHEMA IF NOT EXISTS stats AUTHORIZATION metamc_migrate;
REVOKE ALL ON SCHEMA stats FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 0. RUOLI — RICHIESTI, NON CREATI QUI.
--
--    `metamc_migrate` non ha CREATEROLE, quindi un CREATE ROLE in questo file
--    fallisce con «permission denied to create role» nel momento peggiore:
--    durante il rilascio, a meta' migration. Lo stesso vale per GRANT di
--    appartenenza e per ALTER ROLE ... SET, che sono operazioni di CLUSTER e
--    non di schema.
--
--    I ruoli si creano una volta sola da un superuser, con
--    `node scripts/create-stats-roles.ts`, per la stessa ragione per cui la
--    fase 1 tiene le password fuori dalle migration: niente credenziali e
--    niente operazioni di cluster in un file committato.
--
--    Se mancano, la migration si ferma QUI e dice cosa eseguire. Saltare i
--    GRANT con un NOTICE sarebbe peggio: lo schema risulterebbe applicato e i
--    privilegi assenti, cioe' un guasto che si scopre al primo ciclo del
--    poller, in produzione, come un permission denied dentro un job.
-- ---------------------------------------------------------------------------
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(r, ', ' ORDER BY r) INTO missing
    FROM unnest(ARRAY['metamc_stats_rw', 'metamc_ingest',
                      'metamc_rollup',   'metamc_stats']) AS r
   WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'ruoli della fase 2 mancanti: %', missing
      USING ERRCODE = 'invalid_authorization_specification',
            HINT = 'Eseguire UNA volta come superuser: node scripts/create-stats-roles.ts';
  END IF;
END $$;

-- Nessuno dei ruoli di fase 2 tocca gli schemi di fase 1.
DO $$
BEGIN
  IF to_regnamespace('auth')  IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON SCHEMA auth  FROM metamc_stats_rw, metamc_stats';
  END IF;
  IF to_regnamespace('audit') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON SCHEMA audit FROM metamc_stats_rw, metamc_stats';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. TIPI
-- ---------------------------------------------------------------------------
-- 'partial'/'failed'/'skipped' NON portano informazione negativa: non
-- chiudono sessioni, non contano zeri, non entrano nei rollup. La regola e'
-- strutturale (i rollup filtrano status = 'ok'), non una if sparsa nel codice.
--   ok      : campione completo, copre delta_s secondi
--   partial : ha letto solo una parte dell'insieme online (conteggi bassi)
--   failed  : il poller girava, il Redis di gioco non c'era
--   skipped : il timer e' scattato mentre il ciclo precedente era in corso
CREATE TYPE stats.cycle_status AS ENUM ('ok', 'partial', 'failed', 'skipped');

-- 'quit'   : sparito dal campione dopo la grazia, chiusura osservata
-- 'gap'    : il pannello era fermo fra l'ultima osservazione e il riavvio
-- 'reaper' : non piu' visto per N minuti senza un quit osservato
-- 'skew'   : connection-time incoerente con l'orologio del pannello
CREATE TYPE stats.session_end AS ENUM ('quit', 'gap', 'reaper', 'skew');

-- 'XX' = non determinato. E' un valore legittimo e va MOSTRATO nella legenda:
-- un secchiello XX che cresce e' il primo sintomo che il campo `ip` ha
-- cambiato semantica, e scartandolo la mappa continuerebbe a sembrare
-- corretta mentre misura un terzo dei giocatori. NULL, invece, significa
-- «geolocalizzazione non attiva»: sono due cose diverse, e per questo le
-- colonne country sono NULLABLE.
CREATE DOMAIN stats.country_code AS char(2) CHECK (VALUE ~ '^[A-Z]{2}$');

-- ---------------------------------------------------------------------------
-- 2. FUSO ORARIO — le uniche due funzioni autorizzate a nominarlo.
--    Ogni altra query usa queste, cosi' Europe/Rome vive in un posto solo.
-- ---------------------------------------------------------------------------
CREATE FUNCTION stats.civil_day(p_ts timestamptz) RETURNS date
LANGUAGE sql STABLE STRICT PARALLEL SAFE AS $$
  SELECT (p_ts AT TIME ZONE 'Europe/Rome')::date
$$;

-- La lunghezza di un giorno NON e' 86400: due volte l'anno vale 82800 e
-- 90000. Con una costante la copertura di quei due giorni esce al 104% e al
-- 96%, e qualcuno perde un pomeriggio a cercare il bug nell'ingest.
CREATE FUNCTION stats.day_seconds(p_day date) RETURNS integer
LANGUAGE sql STABLE STRICT PARALLEL SAFE AS $$
  SELECT extract(epoch FROM (((p_day + 1)::timestamp AT TIME ZONE 'Europe/Rome')
                           - ( p_day     ::timestamp AT TIME ZONE 'Europe/Rome')))::integer
$$;

-- ---------------------------------------------------------------------------
-- 3. DIMENSIONE SERVER — la chiave di TUTTO il grezzo e di tutti i rollup.
--
--    Un server e' la singola istanza Minecraft, cosi' come il Redis di gioco
--    la nomina: `duels_6`, `bedwars_solo_2`, `lobby`. Le righe le crea
--    l'ingest alla prima osservazione: un server nuovo non fa fallire un
--    ciclo e non richiede una migration.
--
--    Due sentinella, e sono sentinella per un motivo strutturale:
--      0 = __network__  non e' un server. Il totale di rete e' l'insieme
--          DEDUPLICATO delle identita' del tick e vive in
--          poll_cycle.players: max() e count(distinct) non si decompongono,
--          quindi il totale si MEMORIZZA e non si deriva. Nel grezzo non
--          compare; nei rollup si', come riga 0, perche' li' serve come
--          numeratore e come denominatore di se stesso.
--      1 = __transit__  il giocatore e' osservato senza campo `server`: sta
--          passando fra due istanze. E' una serie VISIBILE, altrimenti il
--          breakdown non somma al totale e il primo che se ne accorge
--          «aggiusta» normalizzando le percentuali, cioe' spalma i transiti
--          sulle modalita'.
--
--    INVARIANTE I1: poll_cycle.players = somma di sample_server.players
--    (transito incluso) sullo stesso tick `ok`.
-- ---------------------------------------------------------------------------
CREATE TABLE stats.server (
  server_id     smallint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY,
  server_key    text     NOT NULL UNIQUE
                  CHECK (server_key ~ '^[a-z0-9_.:-]{1,64}$'
                         AND server_key = lower(server_key)),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  created_by    text     NOT NULL DEFAULT 'ingest'
                  CHECK (created_by IN ('ingest', 'operator', 'migration'))
);

INSERT INTO stats.server (server_id, server_key, created_by) VALUES
  (0, '__network__', 'migration'),
  (1, '__transit__', 'migration');

-- Senza questo il primo server osservato dall'ingest riceve 1 e collide con
-- la sentinella del transito.
SELECT setval(pg_get_serial_sequence('stats.server', 'server_id'), 100, false);

-- ---------------------------------------------------------------------------
-- 4. DIZIONARIO MODALITA' — un modulo del pannello, non un seed.
--
--    Una modalita' e' il RAGGRUPPAMENTO che l'operatore crea nel pannello:
--    «Bedwars» tiene insieme bedwars_solo_1..4 e bedwars_team_1..2. Il
--    dizionario nasce VUOTO e lo riempie l'operatore; un server che nessuna
--    regola mappa finisce nel secchiello di lettura `__unknown__`, che non e'
--    una riga di questa tabella e non va inventato qui.
--
--    Poiche' il grezzo e' chiavato sul SERVER, riclassificare non tocca lo
--    storico: e' una UPDATE su una riga di stats.mode_alias, e ogni lettura
--    successiva vede subito la nuova ripartizione. E' esattamente il motivo
--    per cui la modalita' non entra nel grezzo.
-- ---------------------------------------------------------------------------
CREATE TABLE stats.mode (
  mode_id      smallint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY,
  mode_key     text     NOT NULL UNIQUE CHECK (mode_key ~ '^[a-z0-9_]{1,32}$'),
  display_name text     NOT NULL CHECK (btrim(display_name) <> ''),
  -- Colore della serie. Validato qui perche' un colore non valido rompe il
  -- grafico e non il database, cioe' si scopre tardi. L'avviso di
  -- somiglianza fra due modalita' attive e' del pannello: e' un AVVISO, non
  -- un divieto.
  color        text     CHECK (color ~ '^#[0-9a-f]{6}$'),
  in_breakdown boolean  NOT NULL DEFAULT true,
  hidden       boolean  NOT NULL DEFAULT false,
  sort_order   smallint NOT NULL DEFAULT 1000,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text     NOT NULL DEFAULT 'operator'
                 CHECK (created_by IN ('operator', 'migration'))
);
-- Nessuna INSERT qui: il dizionario nasce vuoto e lo riempie l'operatore.

-- Il filtro e' STRUTTURATO, niente espressioni regolari: una regexp scritta
-- nel pannello e' input non fidato che gira nel database, e la prima volta
-- che qualcuno salva `(a+)+b` il ciclo di campionamento si ferma.
--
--   'server'   il nome esatto      lobby       -> lobby
--   'prefix'   inizia per          bedwars_    -> bedwars_solo_1
--   'suffix'   finisce per         _duels      -> ranked_duels
--   'contains' contiene            event       -> summer_event_2
--
-- `match_value` e' sempre minuscolo e non vuoto: il confronto e' su
-- lower(btrim(server_key)) e una stringa vuota mapperebbe TUTTO.
CREATE TABLE stats.mode_alias (
  match_kind  text NOT NULL CHECK (match_kind IN ('server', 'prefix', 'suffix', 'contains')),
  match_value text NOT NULL CHECK (match_value = lower(match_value) AND btrim(match_value) <> ''),
  mode_id     smallint NOT NULL REFERENCES stats.mode(mode_id) ON DELETE CASCADE,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_kind, match_value)
);
CREATE INDEX mode_alias_mode_idx ON stats.mode_alias (mode_id);

-- LA definizione di riferimento della risoluzione. NULL = nessuna regola
-- corrisponde, e in lettura diventa `__unknown__`.
--
-- L'ordine e' TOTALE e deterministico, perche' due regole possono
-- corrispondere allo stesso server e «quale vince» non puo' dipendere
-- dall'ordine fisico delle righe:
--   1. tipo:  server esatto > prefisso > suffisso > contiene
--   2. a parita' di tipo, il match_value PIU' LUNGO, cioe' il piu' specifico
--   3. a parita' di lunghezza, l'ordine alfabetico: arbitrario ma stabile.
--
-- Nessuna copia di questa logica altrove: l'ingest scrive server, non
-- modalita', quindi non esiste un secondo matcher che possa divergere in
-- silenzio e materializzare la stessa modalita' in due esemplari.
CREATE FUNCTION stats.resolve_mode_id(p_server_key text) RETURNS smallint
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT a.mode_id
    FROM stats.mode_alias a
   WHERE nullif(btrim(lower(p_server_key)), '') IS NOT NULL
     AND CASE a.match_kind
           WHEN 'server'   THEN btrim(lower(p_server_key)) = a.match_value
           WHEN 'prefix'   THEN starts_with(btrim(lower(p_server_key)), a.match_value)
           WHEN 'suffix'   THEN right(btrim(lower(p_server_key)), length(a.match_value)) = a.match_value
           WHEN 'contains' THEN strpos(btrim(lower(p_server_key)), a.match_value) > 0
         END
   ORDER BY CASE a.match_kind WHEN 'server' THEN 0 WHEN 'prefix' THEN 1
                              WHEN 'suffix' THEN 2 ELSE 3 END,
            length(a.match_value) DESC,
            a.match_value
   LIMIT 1
$$;

-- La mappa server -> modalita' risolta. E' il join che ogni lettura fa, ed e'
-- l'unico posto in cui `__unknown__` e i due sentinella prendono un nome:
-- `mode_id` NULL non arriva mai al client, e una serie senza etichetta non
-- esiste.
CREATE VIEW stats.v_server_mode AS
SELECT s.server_id,
       s.server_key,
       CASE
         WHEN s.server_id = 0 THEN '__network__'
         WHEN s.server_id = 1 THEN '__transit__'
         ELSE coalesce(m.mode_key, '__unknown__')
       END AS mode_key,
       m.mode_id,
       CASE
         WHEN s.server_id = 0 THEN 'Intero network'
         WHEN s.server_id = 1 THEN 'In transito'
         ELSE coalesce(m.display_name, 'Non classificata')
       END AS display_name,
       coalesce(m.sort_order, 998)    AS sort_order,
       coalesce(m.in_breakdown, true) AS in_breakdown,
       coalesce(m.hidden, false)      AS hidden,
       m.color
FROM stats.server s
LEFT JOIN stats.mode m
  ON s.server_id > 1 AND m.mode_id = stats.resolve_mode_id(s.server_key);

COMMENT ON VIEW stats.v_server_mode IS
  'Server -> modalita'', risolta al momento della lettura. Cambiare stats.mode_alias cambia ogni grafico al giro di warm successivo, senza toccare una riga di storico.';

-- ---------------------------------------------------------------------------
-- 5. ANAGRAFICA GIOCATORE. Si riscrive SOLO quando cambia qualcosa:
--    `attrs_digest` e' confrontato in memoria dall'ingest e se coincide non
--    parte nessuna query. `last_seen_at` si aggiorna alla CHIUSURA della
--    sessione, mai a ogni tick.
--
--    player_id = `identifier` di Redis. E' la stessa identita' con cui si
--    deduplica l'insieme online, con cui si contano gli unici e con cui si
--    identifica la sessione: una definizione sola di «un giocatore».
-- ---------------------------------------------------------------------------
CREATE TABLE stats.player (
  player_id      integer PRIMARY KEY,
  uuid           uuid,
  premium_id     uuid,
  xuid           text,
  username       text NOT NULL,
  -- STORED esplicito: una colonna generata virtuale non e' indicizzabile, e
  -- su questa colonna l'indice serve. Esplicito anche perche' il default e'
  -- cambiato fra versioni di PostgreSQL.
  username_lower text GENERATED ALWAYS AS (lower(username)) STORED,
  platform       text CHECK (platform IN ('JAVA', 'BEDROCK', 'UNKNOWN')),
  auth_kind      text,
  last_protocol  smallint,
  client_brand   text,
  -- '2024-07-20 09:46:17.0' cosi' com'e': e' java.sql.Timestamp.toString(),
  -- cioe' l'ora locale della JVM, senza offset. `registered_at` resta NULL
  -- finche' stats.ingest_state.registration_offset_min non e' stato
  -- MISURATO: meglio assente che sbagliato di due ore sul confine del
  -- giorno, che su un'utenza giovane colpisce una fascia oraria tutt'altro
  -- che marginale.
  registered_raw text,
  registered_at  timestamptz,
  first_seen_at  timestamptz NOT NULL,
  last_seen_at   timestamptz NOT NULL,
  -- sha256 dei SOLI campi mutabili memorizzati qui. ATTENZIONE: una colonna
  -- mutabile aggiunta e dimenticata nel digest resta congelata per sempre.
  attrs_digest   bytea NOT NULL,
  anonymized_at  timestamptz,       -- art. 17: si svuota, non si elimina la riga
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Unico parziale: rileva la collisione «stesso identifier, uuid diverso»,
-- che e' l'unico modo in cui l'ipotesi «identifier mai riassegnato» puo'
-- rompersi. Una query, non una sorpresa.
CREATE UNIQUE INDEX player_uuid_key     ON stats.player (uuid) WHERE uuid IS NOT NULL;
CREATE INDEX        player_username_idx ON stats.player (username_lower);

COMMENT ON COLUMN stats.player.player_id IS
  'DATO PERSONALE (identificatore online, art. 4(1) GDPR).';

-- I rename tornano indietro (A -> B -> A): la chiave e' `valid_from`, non il
-- nome, altrimenti il primo periodo si perde. Niente WITHOUT OVERLAPS: non
-- esiste in PostgreSQL 17, e comunque un clock skew farebbe FALLIRE l'ingest
-- invece di segnalare; al suo posto una query di integrita' periodica.
CREATE TABLE stats.player_name (
  player_id  integer     NOT NULL REFERENCES stats.player(player_id) ON DELETE CASCADE,
  username   text        NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_to   timestamptz,
  PRIMARY KEY (player_id, valid_from)
);
CREATE INDEX player_name_lookup_idx ON stats.player_name (lower(username), valid_from DESC);

-- ---------------------------------------------------------------------------
-- 6. REGISTRO DEI CICLI. UNA RIGA PER TICK TENTATO, anche fallito.
--
--    Riga assente               -> il poller non stava girando  ('missing')
--    status <> 'ok'             -> il poller girava, il dato non c'e'
--    status = 'ok', players = 0 -> la rete era DAVVERO vuota
--    status = 'ok', nessuna riga in sample_server per S -> S aveva zero
--
--    Redis giu' un'ora produce 120 righe 'failed'; Postgres giu' un'ora
--    produce 120 righe MANCANTI, perche' non c'e' dove scrivere che non si
--    poteva scrivere. Sono due buchi di natura diversa e la griglia di
--    lettura li distingue: e' voluto, altrimenti qualcuno «aggiusta» il caso
--    mancante scrivendo zeri.
--
--    QUESTA TABELLA E' IL DENOMINATORE DI TUTTE LE MEDIE, e `players` e' il
--    TOTALE DI RETE: identita' distinte del tick, non la somma dei server.
-- ---------------------------------------------------------------------------
CREATE TABLE stats.poll_cycle (
  tick_at         timestamptz NOT NULL,
  run_id          uuid        NOT NULL,  -- cambia a ogni riavvio: individua i riavvii
  status          stats.cycle_status NOT NULL,
  -- Secondi coperti da questo tick: il tempo dall'ultimo tick OK, clampato a
  -- ingest_state.max_delta_s. Il tempo oltre il clamp resta SCOPERTO, ed e'
  -- cosi' che un fermo di tre ore non viene accreditato a un solo campione.
  -- Il 300 e' un limite di sanita', non la cadenza: la cadenza non compare
  -- in nessun vincolo. NULL quando il ciclo non copre nulla, che e' il caso
  -- di ogni stato diverso da 'ok'.
  delta_s         smallint,
  duration_ms     integer,
  -- Identita' DISTINTE (deduplicate per player_id). Non e' la lunghezza
  -- dell'array di chiavi: la chiave e' metaverse:player:{username} e un
  -- rename ne crea una seconda.
  players         integer     CHECK (players >= 0),
  keys_read       integer,              -- chiavi restituite dallo SCAN
  keys_skipped    integer,              -- pattern giusto, schema sbagliato
  -- keys_read - players = duplicati di chiave. E' LA sonda che dice, dai dati
  -- e non da un'ipotesi, se il plugin cancella davvero al quit.
  servers_seen    smallint,
  scan_iterations smallint,
  scan_truncated  boolean     NOT NULL DEFAULT false,
  dbsize          bigint,               -- la curva del costo dello SCAN, prima del guasto
  pttl_min_s      integer,              -- sentinella sul TTL (~100 s atteso): se sparisce,
  pttl_max_s      integer,              -- i fantasmi tornano e va rivista la grazia
  -- Mediana di (connection-time/1000 - tick) sui SOLI giocatori comparsi in
  -- questo tick. In SECONDI, e il nome lo dice. Fuori da quella popolazione
  -- non e' skew: e' l'eta' mediana delle sessioni.
  skew_s          integer,
  skew_rejected   integer     NOT NULL DEFAULT 0,  -- scartati per |skew| > 24h
  servers_players integer,              -- controincrocio con duels:servers:*, parziale
  error_kind      text,
  CONSTRAINT poll_cycle_pk PRIMARY KEY (tick_at),
  -- Un ciclo 'ok' copre del tempo e ha un totale; ogni altro stato non copre
  -- NIENTE. Senza questo vincolo un ciclo fallito con delta_s valorizzato
  -- accrediterebbe alla copertura del tempo che nessuno ha osservato — e con
  -- delta_s NOT NULL, come stava nel materiale di progetto, una riga
  -- 'failed' sarebbe stata semplicemente impossibile da scrivere.
  CONSTRAINT poll_cycle_ok_covers  CHECK ((status = 'ok') = (delta_s IS NOT NULL)),
  CONSTRAINT poll_cycle_delta_sane CHECK (delta_s IS NULL OR delta_s BETWEEN 1 AND 300),
  CONSTRAINT poll_cycle_ok_players CHECK (status <> 'ok' OR players IS NOT NULL),
  CONSTRAINT poll_cycle_blank      CHECK (status =  'ok' OR players IS NULL)
) PARTITION BY RANGE (tick_at);

-- I parametri di storage stanno sulle PARTIZIONI (v. stats.partitioned_table):
-- una tabella partizionata non li accetta, e comunque un ALTER qui non li
-- darebbe alle partizioni create fra sei mesi.

COMMENT ON COLUMN stats.poll_cycle.players IS
  'TOTALE DI RETE del tick: identita'' distinte osservate. Non e'' la somma dei server e non e'' derivabile da essa, perche'' count(distinct) non si decompone. Zero significa rete davvero vuota.';

-- ---------------------------------------------------------------------------
-- 7. IL GRANO GREZZO: una riga per (tick, server). MAI per giocatore, MAI
--    per modalita'.
--
--    CONVENZIONE SPARSA: nessuna riga per (tick, server) dentro un tick `ok`
--    significa ZERO giocatori su quel server. Il CHECK rende impossibile
--    scrivere uno zero, quindi la convenzione non e' un accordo verbale: e'
--    un vincolo del database. Vale SOLO dentro un tick `ok`, e quella regola
--    vive nelle viste — per questo il GRANT di lettura si da' sulle VISTE.
--
--    Il totale di rete NON sta qui: sarebbe l'unica riga legittimamente a
--    zero, e sarebbe anche una somma di righe che non e' una somma. Sta in
--    poll_cycle.players.
--
--    `delta_s` e' denormalizzato dal tick (stesso valore, scritto nella
--    stessa transazione): costa zero byte per allineamento e rende il
--    NUMERATORE calcolabile senza join. Il DENOMINATORE resta poll_cycle.
-- ---------------------------------------------------------------------------
CREATE TABLE stats.sample_server (
  tick_at   timestamptz NOT NULL,
  server_id smallint    NOT NULL REFERENCES stats.server(server_id),
  delta_s   smallint    NOT NULL CHECK (delta_s BETWEEN 1 AND 300),
  players   integer     NOT NULL CHECK (players > 0),
  PRIMARY KEY (tick_at, server_id),
  CONSTRAINT sample_server_no_network CHECK (server_id <> 0)
) PARTITION BY RANGE (tick_at);

-- Append-only: senza questo la visibility map resta indietro e le letture
-- index-only degradano a scansioni dello heap.
-- I parametri di storage stanno sulle PARTIZIONI (v. stats.partitioned_table):
-- una tabella partizionata non li accetta, e comunque un ALTER qui non li
-- darebbe alle partizioni create fra sei mesi.
-- NIENTE BRIN: la PK comincia gia' con il tempo e serve comunque al
-- reinserimento dei tick arrivati in ritardo.

-- ---------------------------------------------------------------------------
-- 8. SESSIONI. Identita' = (player_id, connection-time GREZZO).
--
--    `started_at` e' to_timestamp(connection-time/1000) COSI' COM'E': non
--    viene mai clampato, mai sostituito con l'istante corrente, mai
--    ricalcolato. E' l'unico modo in cui il confronto «e' la stessa
--    sessione?» resta stabile fra due tick anche con l'orologio del gioco
--    fuori fase. Lo skew si misura (poll_cycle.skew_s), si registra alla
--    chiusura (end_reason = 'skew') e oltre le 24 ore fa scartare la riga,
--    ma non tocca l'identita'.
-- ---------------------------------------------------------------------------

-- LA TABELLA CALDA: una riga per giocatore online. E' l'unica HOT-update
-- dello schema. `last_seen_at` si flusha ogni 10 minuti sui soli record
-- sporchi: a ogni tick sarebbero milioni di versioni di riga al giorno su
-- poche migliaia di righe vive. NON UNLOGGED: verrebbe troncata al crash
-- recovery, cioe' esattamente nell'unico momento in cui serve.
CREATE TABLE stats.session_open (
  player_id         integer     PRIMARY KEY,
  started_at        timestamptz NOT NULL,
  last_seen_at      timestamptz NOT NULL,
  -- Il segnalibro dei secondi gia' versati in player_day: si versa da qui in
  -- avanti, MAI dall'inizio, altrimenti ogni versamento periodico conta due
  -- volte il tempo gia' contato.
  accounted_through timestamptz NOT NULL,
  server_id_first   smallint    NOT NULL REFERENCES stats.server(server_id),
  server_id_last    smallint    NOT NULL REFERENCES stats.server(server_id),
  legs              smallint    NOT NULL DEFAULT 1,  -- permanenze contigue: i trasferimenti
  country           stats.country_code,              -- NULL = geolocalizzazione spenta
  platform          text,
  protocol          smallint,
  seen_ticks        integer     NOT NULL DEFAULT 1
) WITH (fillfactor = 70,
        autovacuum_vacuum_scale_factor  = 0.02,
        autovacuum_analyze_scale_factor = 0.05);
CREATE INDEX session_open_stale_idx ON stats.session_open (last_seen_at);

-- LO STORICO FREDDO: append-only, una riga per login chiuso.
-- `ended_at` e' sempre l'ultimo istante per cui esiste una PROVA
-- (last_seen_at), mai now(): altrimenti ogni durata si gonfia della grazia
-- e, dopo un'interruzione, di ore.
-- La chiusura e' un upsert che ESTENDE `ended_at` (GREATEST) invece di un
-- DO NOTHING: sotto guasto il reaper puo' aver gia' chiuso la sessione, e
-- con DO NOTHING la seconda meta' sparirebbe senza traccia.
CREATE TABLE stats.session (
  started_at      timestamptz NOT NULL,
  player_id       integer     NOT NULL,
  ended_at        timestamptz NOT NULL,
  duration_s      integer GENERATED ALWAYS AS
                    (GREATEST(0, extract(epoch FROM (ended_at - started_at))::integer)) STORED,
  seen_ticks      integer     NOT NULL DEFAULT 1,
  server_id_first smallint    NOT NULL,
  server_id_last  smallint    NOT NULL,
  legs            smallint    NOT NULL DEFAULT 1,
  country         stats.country_code,
  platform        text,
  protocol        smallint,
  end_reason      stats.session_end NOT NULL,
  skew_s          integer,
  PRIMARY KEY (started_at, player_id)
) PARTITION BY RANGE (started_at);
-- Niente FK su server_id_*: sono descrittivi e una FK su tabella partizionata
-- crea un vincolo per partizione a ogni ATTACH, per una garanzia che qui non
-- serve (le righe di stats.server non si cancellano).

-- I parametri di storage stanno sulle PARTIZIONI (v. stats.partitioned_table):
-- una tabella partizionata non li accetta, e comunque un ALTER qui non li
-- darebbe alle partizioni create fra sei mesi.

-- QUI il BRIN e' giusto, e SOLO qui:
--   * su `started_at` sarebbe ridondante (c'e' gia' la PK in testa);
--   * su `ended_at` no: le righe entrano in ordine di CHIUSURA, quindi
--     `ended_at` e' correlato con l'ordine fisico mentre `started_at` no —
--     una sessione da 12 ore si chiude in mezzo a quelle da 2 minuti, ed e'
--     esattamente per quegli outlier che serve minmax_multi. L'opclass va
--     scritta a mano: il default di brin su timestamptz e'
--     timestamptz_minmax_ops, cioe' proprio quello che gli outlier rovinano.
--   * `autosummarize` acceso: senza, sulle partizioni append-only i range
--     restano non riassunti finche' non passa un VACUUM, e un indice
--     presente, valido e ignorato dal pianificatore e' peggio di un indice
--     assente.
CREATE INDEX session_ended_brin ON stats.session
  USING brin (ended_at timestamptz_minmax_multi_ops)
  WITH (pages_per_range = 32, autosummarize = on);
CREATE INDEX session_player_idx ON stats.session (player_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- 9. UNICI ESATTI. Niente HyperLogLog: l'utenza sta in una scala in cui il
--    conteggio esatto costa poco, e «circa 4.980 unici» non e' un numero che
--    si possa mettere accanto a un confronto mese su mese.
--
--    `day` e' il giorno civile Europe/Rome, calcolato SEMPRE da
--    stats.civil_day sul tick corrente: nessun timer, nessun azzeramento a
--    mezzanotte, nessuna dipendenza dal TZ del processo — i container girano
--    con TZ=UTC e perderebbero ogni notte la coda fra le 00:00 e le 02:00 di
--    Roma, un errore stabile del 2-5%, quindi invisibile nel confronto mese
--    su mese, e sbagliato per sempre.
--
--    Si scrive UNA VOLTA per giocatore per giorno, non a ogni tick, e alla
--    PRIMA osservazione del giorno: cosi' l'unico e' esatto anche per chi la
--    sessione non la chiude mai, e gli unici del giorno vivo non perdono
--    tutti i giocatori ancora connessi.
--
--    `country` = prima osservazione del giorno, mai riscritto: e' la regola
--    deterministica senza la quale l'UPSERT balla a ogni ciclo per chi sta
--    su rete mobile e salta di PoP.
-- ---------------------------------------------------------------------------
CREATE TABLE stats.player_day (
  day            date        NOT NULL,
  player_id      integer     NOT NULL,
  first_seen_at  timestamptz NOT NULL,
  last_seen_at   timestamptz NOT NULL,
  seconds_online integer     NOT NULL DEFAULT 0,  -- affettati a mezzanotte locale
  sessions       smallint    NOT NULL DEFAULT 0,  -- contate sul giorno in cui INIZIANO
  country        stats.country_code,              -- NULL = geolocalizzazione spenta
  PRIMARY KEY (day, player_id)
) PARTITION BY RANGE (day);
-- I parametri di storage stanno sulle PARTIZIONI (v. stats.partitioned_table):
-- una tabella partizionata non li accetta, e comunque un ALTER qui non li
-- darebbe alle partizioni create fra sei mesi.

-- Serve al DISTINCT ON (player_id) ... ORDER BY player_id, day DESC della
-- mappa: unici del periodo attribuiti al paese del giorno piu' recente.
-- E' l'UNICA definizione della metrica geografica, e vale l'invariante
-- somma(mappa) = unici(periodo), verificato da stats.integrity_check.
CREATE INDEX player_day_player_idx  ON stats.player_day (player_id, day DESC);
CREATE INDEX player_day_country_idx ON stats.player_day (day, country);

COMMENT ON TABLE stats.player_day IS
  'DATO PERSONALE: player_id + giorno + paese. Retention 730 giorni, cancellazione per DROP di partizione. L''indirizzo IP non entra mai in questo schema, in nessuna forma.';

-- Solo PRESENZA, e chiavata sul SERVER come tutto il resto: gli unici per
-- modalita' si contano in lettura sull'insieme dei server della modalita'.
-- Niente `seconds_online`, niente `sessions`: attribuire i secondi di una
-- sessione all'ultimo server produce la classifica di cio' che si tocca per
-- ultimo prima di sloggare. I minuti per modalita' escono esatti da
-- player_seconds sui campioni, e devono uscire da li' e basta.
CREATE TABLE stats.player_day_server (
  day       date     NOT NULL,
  server_id smallint NOT NULL REFERENCES stats.server(server_id),
  player_id integer  NOT NULL,
  PRIMARY KEY (day, server_id, player_id)
) PARTITION BY RANGE (day);
-- I parametri di storage stanno sulle PARTIZIONI (v. stats.partitioned_table):
-- una tabella partizionata non li accetta, e comunque un ALTER qui non li
-- darebbe alle partizioni create fra sei mesi.

-- ---------------------------------------------------------------------------
-- 10. ROLLUP. Solo interi ADDITIVI: la gerarchia 5m -> 1h -> 1d e' ESATTA.
--
--     covered_s e samples vengono da poll_cycle e sono IDENTICI su tutte le
--     righe dello stesso bucket. player_seconds viene dalle righe del server.
--     La media e' player_seconds / covered_s: un server aperto 5 minuti su
--     60 con 200 giocatori esce a 16,7 e non a 200. Il denominatore di una
--     media non puo' MAI venire dalle stesse righe del numeratore.
--
--     Nessuna colonna `avg real`: sum(real) accumula in float4 e sommare
--     8.760 valori per il range annuale perde cifre visibili a occhio. La
--     media si calcola in lettura, in float8.
--
--     players_max sopravvive al downsampling — con la sola media il record
--     di giocatori contemporanei evaporerebbe — e viaggia SEMPRE con
--     players_max_at. Niente players_min: con la convenzione sparsa il
--     minimo sulle sole righe esistenti non e' mai 0, quindi mentirebbe.
--
--     La riga server_id = 0 e' il TOTALE DI RETE e viene da poll_cycle.
-- ---------------------------------------------------------------------------
CREATE TABLE stats.rollup_5m (
  bucket         timestamptz NOT NULL,
  server_id      smallint    NOT NULL REFERENCES stats.server(server_id),
  samples        smallint    NOT NULL CHECK (samples >= 0),
  covered_s      integer     NOT NULL CHECK (covered_s >= 0),
  player_seconds bigint      NOT NULL CHECK (player_seconds >= 0),
  players_max    integer     NOT NULL CHECK (players_max >= 0),
  players_max_at timestamptz,
  PRIMARY KEY (bucket, server_id)
) PARTITION BY RANGE (bucket);
-- I parametri di storage stanno sulle PARTIZIONI (v. stats.partitioned_table):
-- una tabella partizionata non li accetta, e comunque un ALTER qui non li
-- darebbe alle partizioni create fra sei mesi.

-- NON partizionata: poche centinaia di righe al giorno. Partizionarla
-- aggiungerebbe tempo di pianificazione a ogni query per non risparmiare
-- niente.
CREATE TABLE stats.rollup_1h (
  bucket         timestamptz NOT NULL,
  server_id      smallint    NOT NULL REFERENCES stats.server(server_id),
  samples        integer     NOT NULL CHECK (samples >= 0),
  covered_s      integer     NOT NULL CHECK (covered_s >= 0),
  player_seconds bigint      NOT NULL CHECK (player_seconds >= 0),
  players_max    integer     NOT NULL CHECK (players_max >= 0),
  players_max_at timestamptz,
  PRIMARY KEY (bucket, server_id)
);
-- Due domande, due indici: «tutti i server su un range» (panoramica, la PK) e
-- «un server su un range lungo» (dettaglio modalita').
CREATE INDEX rollup_1h_server_idx ON stats.rollup_1h (server_id, bucket);

-- La tabella che da sola serve la vista a 1 anno di OGNI widget.
-- `day` e' il giorno civile di Roma. `expected_s` NON e' 86400 e non e' una
-- costante: se lo fosse, i due giorni di cambio ora uscirebbero al 104% e al
-- 96% di copertura.
CREATE TABLE stats.rollup_1d (
  day             date     NOT NULL,
  server_id       smallint NOT NULL REFERENCES stats.server(server_id),
  samples         integer  NOT NULL CHECK (samples >= 0),
  covered_s       integer  NOT NULL CHECK (covered_s >= 0),
  expected_s      integer  NOT NULL CHECK (expected_s IN (82800, 86400, 90000)),
  player_seconds  bigint   NOT NULL CHECK (player_seconds >= 0),
  players_max     integer  NOT NULL CHECK (players_max >= 0),
  players_max_at  timestamptz,
  uniques         integer  NOT NULL DEFAULT 0 CHECK (uniques >= 0),
  sessions        integer  NOT NULL DEFAULT 0 CHECK (sessions >= 0),
  session_seconds bigint   NOT NULL DEFAULT 0 CHECK (session_seconds >= 0),
  -- Un giorno chiuso non si riscrive: `final` lo dichiara, `rebuilt_at`
  -- traccia ogni ricalcolo. Un numero che il committente ha gia' letto e
  -- annotato non puo' cambiare in silenzio.
  final           boolean  NOT NULL DEFAULT false,
  rebuilt_at      timestamptz,
  PRIMARY KEY (day, server_id),
  -- Le sessioni non sono attribuibili a un server senza mentire: una
  -- sessione attraversa piu' server. Esistono solo sulla riga di rete, e il
  -- database lo impone invece di sperarlo.
  CONSTRAINT rollup_1d_sessions_network_only
    CHECK (server_id = 0 OR (sessions = 0 AND session_seconds = 0))
);
CREATE INDEX rollup_1d_server_idx ON stats.rollup_1d (server_id, day);

-- Unici giornalieri PER MODALITA'. E' l'unico aggregato chiavato sulla
-- modalita', e c'e' una ragione precisa per cui esiste: gli unici non sono
-- additivi, quindi «unici di Bedwars» non e' la somma degli unici dei suoi
-- server e non e' calcolabile in lettura da rollup_1d. Va contato con un
-- count(distinct) su player_day_server, che su un anno e' troppo caro per un
-- giro di warm.
--
-- E' DERIVATO e RICOSTRUIBILE: quando l'operatore cambia il dizionario, le
-- righe non ancora `final` si ricalcolano e quelle `final` si ricalcolano
-- registrando `rebuilt_at`. Non e' mai una fonte: la fonte e'
-- player_day_server, che e' chiavata sul server e quindi non invecchia
-- quando la classificazione cambia.
CREATE TABLE stats.mode_day_unique (
  day         date     NOT NULL,
  mode_id     smallint NOT NULL REFERENCES stats.mode(mode_id) ON DELETE CASCADE,
  uniques     integer  NOT NULL CHECK (uniques >= 0),
  final       boolean  NOT NULL DEFAULT false,
  computed_at timestamptz NOT NULL DEFAULT now(),
  rebuilt_at  timestamptz,
  PRIMARY KEY (day, mode_id)
);

-- ---------------------------------------------------------------------------
-- 11. VISTE DI LETTURA. Il ruolo di sola lettura riceve il GRANT QUI, non
--     sulle tabelle: la regola «assenza = zero solo dentro un tick coperto»
--     non deve essere aggirabile, e una media non deve mai poter uscire da
--     una divisione per un denominatore preso dalle righe sbagliate.
--
--     covered_s puo' superare di un delta il nominale sul bordo del bucket
--     (un tick appartiene per intero al bucket in cui cade): la copertura e'
--     quindi tagliata a 1.0 qui, una volta sola.
--
--     Le viste portano gia' il join a v_server_mode: chi legge vede la
--     modalita' risolta ADESSO, che e' il punto di tutto questo disegno.
-- ---------------------------------------------------------------------------
CREATE VIEW stats.v_online_5m AS
SELECT r.bucket, r.server_id, sm.server_key, sm.mode_key, sm.display_name,
       (r.player_seconds::float8 / nullif(r.covered_s, 0))    AS players_avg,
       CASE WHEN r.covered_s > 0 THEN r.players_max END       AS players_max,
       r.players_max_at,
       r.player_seconds, r.covered_s, r.samples,
       LEAST(1.0::float8, r.covered_s::float8 / 300)          AS coverage
FROM stats.rollup_5m r
JOIN stats.v_server_mode sm USING (server_id);

CREATE VIEW stats.v_online_1h AS
SELECT r.bucket, r.server_id, sm.server_key, sm.mode_key, sm.display_name,
       (r.player_seconds::float8 / nullif(r.covered_s, 0))    AS players_avg,
       CASE WHEN r.covered_s > 0 THEN r.players_max END       AS players_max,
       r.players_max_at,
       r.player_seconds, r.covered_s, r.samples,
       LEAST(1.0::float8, r.covered_s::float8 / 3600)         AS coverage,
       -- Etichette locali calcolate QUI e solo qui. La heatmap 7x24 raggruppa
       -- su queste e la media pesata divide per i secondi REALMENTE coperti:
       -- l'ora saltata non produce bucket (cella scoperta), l'ora ripetuta ne
       -- produce due che si sommano. Nessun caso speciale, e mai un `/ 7`.
       extract(isodow FROM (r.bucket AT TIME ZONE 'Europe/Rome'))::smallint AS local_dow,
       extract(hour   FROM (r.bucket AT TIME ZONE 'Europe/Rome'))::smallint AS local_hour
FROM stats.rollup_1h r
JOIN stats.v_server_mode sm USING (server_id);

CREATE VIEW stats.v_online_1d AS
SELECT r.day, r.server_id, sm.server_key, sm.mode_key, sm.display_name,
       (r.player_seconds::float8 / nullif(r.covered_s, 0))    AS players_avg,
       CASE WHEN r.covered_s > 0 THEN r.players_max END       AS players_max,
       r.players_max_at,
       r.player_seconds, r.covered_s, r.samples, r.expected_s,
       LEAST(1.0::float8, r.covered_s::float8 / r.expected_s) AS coverage,
       r.uniques, r.sessions, r.session_seconds, r.final
FROM stats.rollup_1d r
JOIN stats.v_server_mode sm USING (server_id);

-- Durata media ONESTA: esclude cio' che non abbiamo osservato per intero.
-- Una query di durata che non filtra end_reason restituisce un numero
-- sbagliato, quindi il filtro sta nella vista e non nella buona volonta'.
CREATE VIEW stats.v_session_observed AS
SELECT * FROM stats.session WHERE end_reason = 'quit';

COMMENT ON VIEW stats.v_online_1h IS
  'Fonte unica dei range 7g/30g/90g e della heatmap. players_avg e'' NULL dove non e'' stato osservato nulla: mai zero, e mai interpolato fra due punti separati da un NULL.';

-- ---------------------------------------------------------------------------
-- 12. STATO DEI JOB. Il `FOR UPDATE` sulla riga di livello E' il lock: due
--     istanze si serializzerebbero da sole, senza advisory lock — che
--     nessuno eserciterebbe finche' l'istanza applicativa e' una sola.
-- ---------------------------------------------------------------------------
CREATE TABLE stats.rollup_state (
  level          text PRIMARY KEY CHECK (level IN ('5m', '1h', '1d', 'daily_close')),
  watermark      timestamptz NOT NULL,
  -- Quanti bucket mancano al presente. Il giro ne processa al massimo
  -- max_buckets e riporta behind_buckets > 0 finche' e' indietro: un
  -- arretrato di 30 giorni non deve MAI diventare un singolo statement, che
  -- verrebbe ucciso dallo statement_timeout, ritentato ogni 15 s per sempre,
  -- e lascerebbe il watermark fermo. Stallo permanente, grafici vuoti, e un
  -- log che dice soltanto «rollup fallito».
  behind_buckets integer     NOT NULL DEFAULT 0,
  max_buckets    integer     NOT NULL DEFAULT 288 CHECK (max_buckets > 0),
  rows_written   integer     NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
-- Watermark a now(), MAI a epoch 0: un reseed a zero scandirebbe dall'inizio
-- dei tempi al primo giro.
INSERT INTO stats.rollup_state (level, watermark) VALUES
  ('5m',          date_trunc('hour', now())),
  ('1h',          date_trunc('hour', now())),
  ('1d',          date_trunc('day',  now())),
  ('daily_close', date_trunc('day',  now()));

CREATE TABLE stats.ingest_state (
  id                      smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_tick_at            timestamptz,
  last_ok_tick_at         timestamptz,
  last_tick_players       integer,
  nominal_delta_s         smallint NOT NULL DEFAULT 30 CHECK (nominal_delta_s BETWEEN 5 AND 120),
  -- Oltre questo, il tempo NON e' coperto: e' la differenza fra «tenere
  -- l'ultimo valore per un tick saltato» e «accreditare tre ore di buco a un
  -- singolo campione».
  max_delta_s             smallint NOT NULL DEFAULT 60 CHECK (max_delta_s BETWEEN 5 AND 300),
  grace_ticks             smallint NOT NULL DEFAULT 3,
  reaper_after_s          integer  NOT NULL DEFAULT 900,
  -- NULL = offset di registrationDate non ancora misurato: finche' e' NULL,
  -- stats.player.registered_at resta NULL e non ci si fa aritmetica.
  registration_offset_min smallint,
  -- NULL = la sonda «il campo ip e' del giocatore o del proxy?» non e' stata
  -- eseguita, quindi la geolocalizzazione e' SPENTA e le colonne country
  -- restano NULL. Una mappa costruita sull'IP del proxy farebbe collassare
  -- tutti i giocatori su pochi indirizzi, in modo perfettamente plausibile.
  geo_enabled             boolean,
  -- Prima di questo istante non esiste storico: qualunque metrica «prima
  -- volta» va etichettata come tale in interfaccia.
  history_start_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ingest_delta_order CHECK (max_delta_s >= nominal_delta_s)
);
INSERT INTO stats.ingest_state (id) VALUES (1);

-- Gli invarianti girano come JOB e lasciano una riga. Tutti i modi in cui
-- questo sistema puo' mentire falliscono in silenzio e in modo plausibile:
-- nessuno solleva un'eccezione, nessuno rompe un grafico.
-- Controlli previsti (uno per `name`):
--   network_equals_servers : poll_cycle.players = somma sample_server del tick
--   uniques_bounds         : max(unici per modalita') <= unici(rete) <= somma
--   max_hierarchy          : players_max(1d) = max dei players_max(1h) del giorno
--   geo_sum_equals_uniques : somma della mappa = unici del periodo
--   delta_agreement        : sample_server.delta_s = poll_cycle.delta_s
--   covered_uniform        : covered_s identico fra i server dello stesso bucket
--   rollup_vs_raw          : 1h ricalcolato dal grezzo = 1h memorizzato
--   ticks_missing_24h      : tick mai tentati nelle ultime 24 ore
CREATE TABLE stats.integrity_check (
  run_at   timestamptz NOT NULL DEFAULT now(),
  name     text        NOT NULL,
  failures bigint      NOT NULL,
  detail   jsonb,
  PRIMARY KEY (run_at, name)
);
CREATE INDEX integrity_check_name_idx ON stats.integrity_check (name, run_at DESC);

-- ---------------------------------------------------------------------------
-- 13. PARTIZIONI. Anche il ciclo di vita e' fatto di RIGHE: cambiare la
--     retention e' una UPDATE, aggiungere una tabella partizionata e' una
--     INSERT, e non c'e' modo di aggiungerne una dimenticando il job che ne
--     crea le partizioni — il guasto documentato nella migration 009.
--
--     `keep_days` di sample_server NON e' una scelta di spazio: e' per
--     quanti giorni indietro si potra' ancora RICALCOLARE un rollup
--     sbagliato. Va posta al committente in questi termini, perche' cosi'
--     la risposta cambia.
-- ---------------------------------------------------------------------------
CREATE TABLE stats.partitioned_table (
  table_name  text PRIMARY KEY,
  granularity text    NOT NULL CHECK (granularity IN ('day', 'month')),
  -- Il pavimento sta QUI, come vincolo, non come argomento che il chiamante
  -- puo' scegliere.
  keep_days   integer NOT NULL CHECK (keep_days >= 7),
  -- Parametri di storage della PARTIZIONE. Una tabella partizionata non li
  -- accetta («cannot specify storage parameters for a partitioned table») e
  -- un ALTER sulle foglie esistenti non toccherebbe quelle create domani:
  -- l'unico posto in cui vivono davvero e' la CREATE della partizione.
  --
  -- Il valore finisce in una EXECUTE, quindi il CHECK non e' cosmetico: e'
  -- la sola cosa che sta fra questa colonna e un'iniezione di DDL. Scrive
  -- solo metamc_migrate, ma il vincolo non dipende da chi scrive.
  partition_options text CHECK (partition_options ~ '^[a-z_]+=[0-9a-z._]+(, ?[a-z_]+=[0-9a-z._]+)*$')
);
-- Tutte append-only: senza autovacuum_vacuum_insert_scale_factor basso la
-- visibility map resta indietro e le letture index-only degradano a
-- scansioni dello heap — cioe' il grafico rallenta man mano che i dati
-- crescono, che e' il modo peggiore in cui possa rallentare.
INSERT INTO stats.partitioned_table
  (table_name, granularity, keep_days, partition_options) VALUES
  ('sample_server',     'day',    30, 'autovacuum_vacuum_insert_scale_factor=0.02'),
  ('poll_cycle',        'month',  90, 'autovacuum_vacuum_insert_scale_factor=0.02'),
  ('rollup_5m',         'month', 400, 'autovacuum_vacuum_insert_scale_factor=0.02'),
  ('session',           'month', 730, 'autovacuum_vacuum_insert_scale_factor=0.02'),
  ('player_day',        'month', 730, 'autovacuum_vacuum_insert_scale_factor=0.02'),
  ('player_day_server', 'month', 400, 'autovacuum_vacuum_insert_scale_factor=0.02');

-- `SET TimeZone = 'UTC'` a livello di funzione: su una chiave timestamptz i
-- letterali di FOR VALUES vengono castati con il TimeZone DELLA SESSIONE, e
-- la stessa funzione chiamata da due client con fusi diversi creerebbe
-- partizioni con confini diversi — guasto che si scopre mesi dopo come un
-- CREATE fallito per sovrapposizione.
CREATE FUNCTION stats.ensure_partitions(p_ahead_days integer DEFAULT 4,
                                        p_ahead_months integer DEFAULT 2)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET TimeZone = 'UTC'
AS $$
DECLARE r record; g record; lo date; hi date; part text; made integer := 0;
BEGIN
  IF p_ahead_days   NOT BETWEEN 0 AND 31 THEN
    RAISE EXCEPTION 'orizzonte giorni fuori scala: %', p_ahead_days
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_ahead_months NOT BETWEEN 0 AND 24 THEN
    RAISE EXCEPTION 'orizzonte mesi fuori scala: %', p_ahead_months
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  FOR r IN SELECT * FROM stats.partitioned_table ORDER BY table_name LOOP
    FOR g IN
      SELECT s::date AS d FROM generate_series(
        CASE r.granularity WHEN 'day' THEN current_date - 1
             ELSE (date_trunc('month', current_date) - interval '1 month')::date END,
        CASE r.granularity WHEN 'day' THEN current_date + p_ahead_days
             ELSE (date_trunc('month', current_date)
                   + make_interval(months => p_ahead_months))::date END,
        CASE r.granularity WHEN 'day' THEN interval '1 day' ELSE interval '1 month' END) s
    LOOP
      IF r.granularity = 'day' THEN
        lo := g.d; hi := g.d + 1;
        part := format('%s_%s', r.table_name, to_char(lo, 'YYYY_MM_DD'));
      ELSE
        lo := date_trunc('month', g.d)::date;
        hi := (date_trunc('month', g.d) + interval '1 month')::date;
        part := format('%s_%s', r.table_name, to_char(lo, 'YYYY_MM'));
      END IF;

      CONTINUE WHEN EXISTS (SELECT 1 FROM pg_class c
                            JOIN pg_namespace n ON n.oid = c.relnamespace
                            WHERE n.nspname = 'stats' AND c.relname = part);

      EXECUTE format('CREATE TABLE stats.%I PARTITION OF stats.%I FOR VALUES FROM (%L) TO (%L)%s',
                     part, r.table_name, lo, hi,
                     CASE WHEN r.partition_options IS NULL THEN ''
                          ELSE ' WITH (' || r.partition_options || ')' END);
      made := made + 1;
    END LOOP;
  END LOOP;
  RETURN made;
END $$;
-- NESSUN GRANT sulle partizioni: per un accesso attraverso la tabella padre
-- Postgres controlla la ACL del SOLO padre. Concederle direttamente
-- aggirerebbe le viste, che sono il punto in cui vive la semantica.

-- La potatura ricava il periodo dal NOME, che e' generato da
-- ensure_partitions e ha quindi forma nota; il join su pg_inherits
-- garantisce comunque che si stia toccando solo una partizione di una
-- tabella REGISTRATA.
CREATE FUNCTION stats.drop_expired_partitions() RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET TimeZone = 'UTC'
AS $$
DECLARE r record; upper_bound date; dropped text[] := '{}';
BEGIN
  FOR r IN
    SELECT c.relname AS part, p.keep_days,
           substring(c.relname from '([0-9]{4}_[0-9]{2}(_[0-9]{2})?)$') AS stamp
    FROM stats.partitioned_table p
    JOIN pg_class     parent ON parent.relname = p.table_name
    JOIN pg_namespace n      ON n.oid = parent.relnamespace AND n.nspname = 'stats'
    JOIN pg_inherits  i      ON i.inhparent = parent.oid
    JOIN pg_class     c      ON c.oid = i.inhrelid
  LOOP
    CONTINUE WHEN r.stamp IS NULL;
    upper_bound := CASE WHEN length(r.stamp) = 10
      THEN to_date(r.stamp, 'YYYY_MM_DD') + 1
      ELSE (to_date(r.stamp, 'YYYY_MM') + interval '1 month')::date END;
    -- Si elimina solo se la partizione e' INTERAMENTE fuori finestra.
    CONTINUE WHEN upper_bound > current_date - r.keep_days;
    EXECUTE format('DROP TABLE stats.%I', r.part);
    dropped := dropped || r.part;
  END LOOP;
  RETURN dropped;
END $$;

REVOKE ALL ON FUNCTION stats.ensure_partitions(integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION stats.drop_expired_partitions()           FROM PUBLIC;
GRANT EXECUTE ON FUNCTION stats.ensure_partitions(integer, integer) TO metamc_stats_rw;
GRANT EXECUTE ON FUNCTION stats.drop_expired_partitions()           TO metamc_stats_rw;

-- ---------------------------------------------------------------------------
-- 14. PRIVILEGI.
--     Scrittura: solo il gruppo. Nessun DELETE (la retention e' un DROP di
--     partizione) tranne su session_open, dove una sessione che si chiude
--     deve sparire. Nessun TRUNCATE, mai.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA stats TO metamc_stats_rw, metamc_stats;

GRANT SELECT, INSERT, UPDATE ON ALL TABLES    IN SCHEMA stats TO metamc_stats_rw;
GRANT USAGE, SELECT          ON ALL SEQUENCES IN SCHEMA stats TO metamc_stats_rw;
GRANT DELETE ON stats.session_open TO metamc_stats_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE metamc_migrate IN SCHEMA stats
  GRANT SELECT, INSERT, UPDATE ON TABLES TO metamc_stats_rw;

-- Lettura: le VISTE, il dizionario, e le tabelle di fatto che i KPI di
-- sessione e la mappa devono per forza toccare. MAI sample_server, MAI
-- poll_cycle, MAI i rollup nudi: chi leggesse le tabelle disegnerebbe zeri
-- al posto dei buchi e medie con il denominatore sbagliato.
GRANT SELECT ON stats.v_online_5m, stats.v_online_1h, stats.v_online_1d,
                stats.v_server_mode, stats.v_session_observed, stats.session,
                stats.player_day, stats.player_day_server,
                stats.server, stats.mode, stats.mode_alias,
                stats.mode_day_unique, stats.ingest_state
  TO metamc_stats;
ALTER DEFAULT PRIVILEGES FOR ROLE metamc_migrate IN SCHEMA stats
  GRANT SELECT ON TABLES TO metamc_stats;

-- Il modulo «modalita'» e' del pannello, e il pannello parla al database con
-- il ruolo della fase 1: e' l'unico che ha gia' la sessione, il contesto di
-- autorizzazione e il registro attivita' in cui scrivere il prima e il dopo
-- di ogni modifica. Nessun accesso ai fatti: solo al dizionario.
GRANT USAGE ON SCHEMA stats TO metamc_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON stats.mode, stats.mode_alias TO metamc_app;
GRANT SELECT ON stats.server, stats.v_server_mode TO metamc_app;
DO $$
BEGIN
  EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO metamc_app',
                 pg_get_serial_sequence('stats.mode', 'mode_id'));
END $$;

-- ---------------------------------------------------------------------------
-- 15. Prime partizioni, cosi' le tabelle sono usabili al primo tick.
--     Partizione mancante = SQLSTATE 23514 e OGNI ciclo fallisce da
--     mezzanotte in poi: il grafico diventa bianco e la causa non e' nel
--     codice del grafico. La creazione va rifatta all'avvio E in un job
--     periodico, e l'INSERT deve ritentare UNA volta dopo aver chiamato
--     ensure_partitions.
-- ---------------------------------------------------------------------------
SELECT stats.ensure_partitions();
