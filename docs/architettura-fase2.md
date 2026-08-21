# Architettura fase 2 — tracker statistico MetaMC
**Perimetro: ingestione da Redis, storico, rollup, endpoint, cache, geolocalizzazione.**
Documento normativo. Data: 20 agosto 2026.

Prodotto da 4 progettisti in parallelo, attaccato da 2 revisori adversariali
(correttezza dei numeri, scala) e riconciliato in sintesi. 32 decisioni motivate.

---

# 1. Decisioni

Tutto ciò che non compare in questa tabella resta come nel materiale dei progettisti. Ciò che compare, cambia — e la colonna «al posto di» nomina esplicitamente la variante che viene cancellata, non messa in alternativa.

| # | Decisione | Al posto di | Perché (una riga) |
|---|---|---|---|
| D1 | **SCAN completo del keyspace a ogni ciclo**, `COUNT 1000`, nessun cap sul numero di chiavi, nessun budget di troncamento nel percorso di conteggio | Indice del plugin (scenario A) / indice proprio `mm:online:idx` + pub/sub + riconciliazione adattiva (scenario B) | DBSIZE = 2667 e le chiavi giocatore sono metà del keyspace: lo SCAN attraversa ~2 chiavi per giocatore trovato, ~3 round trip a ciclo. Un indice sarebbe complessità pura. |
| D2 | **Niente notifiche keyspace, niente indice mantenuto in modo incrementale, niente riconciliazione periodica, niente subscriber sui canali `duels:player:*`** | Anti-deriva a tre livelli, `drift_added`/`drift_removed`, cadenza adattiva 2/5/15 min | Sono tutte macchine costruite per un keyspace grande che non esiste. Con lo SCAN per ciclo la deriva non ha dove nascere. |
| D3 | **Nessuna richiesta a chi mantiene il plugin**, nessuna dipendenza da un `metaverse:players:all` | «Chiedere un SET degli online è una riga per lui» | Fuori perimetro per decisione del committente: si legge ciò che c'è. |
| D4 | **Niente rilevamento ghost**: via R1–R4, `fingerprint`, `filter_version`, `ghost_rules`, `ghosts_dropped`, `online_raw` vs `online_counted`, `ghost_flag` | Modalità OSSERVA con quattro regole indipendenti spedite spente | Il TTL esiste (~100 s, rinnovato dal plugin a ogni trasferimento): i fantasmi permanenti non esistono. Restano la sonda PTTL come sentinella e il reaper come rete di sicurezza. |
| D5 | **Cadenza 30 s NOMINALE, `delta_s` misurato su ogni riga**, clamp a `max_delta_s` (default 60 s = 2× nominale); il tempo oltre il clamp resta SCOPERTO | `T = 20` congelato in `CHECK (slot_epoch % 20 = 0)`; `clamp(secondsSince, 1, 3600)` | La cadenza è confermata a 30 s ma non deve stare nel DDL: con `delta_s` per riga, cambiarla non reinterpreta lo storico. Il clamp a 3600 accrediterebbe un'ora di buco come osservata. |
| D6 | **`delta_s` è il tempo dall'ultimo tick `ok`**, non dall'ultimo tick tentato | — | Un tick `failed` non porta informazione: il suo intervallo non può essere accreditato come coperto. |
| D7 | **Una riga in `stats.poll_cycle` per ogni tick TENTATO**, anche fallito → tre stati distinti: riga assente = poller fermo, `failed` = poller vivo e Redis irraggiungibile, `ok` senza righe campione = rete davvero vuota | Dedurre il buco dalla distanza fra i timestamp | Confermato dai revisori: il buco diventa un valore, non un'assenza interpretabile. Cambia solo la chiave: `tick_at timestamptz` invece di `slot_epoch bigint`. |
| D8 | **Il denominatore di ogni media viene SEMPRE dal registro cicli**, mai dalle righe della modalità: `players_avg = player_seconds / covered_s_del_bucket`, con `covered_s` identico su tutte le righe dello stesso bucket | `sum(online_avg*samples_ok)/sum(samples_ok)` e `sum(delta_s)` sulle righe della modalità | È il difetto numerico n.1: una modalità aperta 5 minuti l'ora risulterebbe la più popolosa della rete. Stessa trappola già diagnosticata dalla sezione geo (`seen_polls` vs `poll_hour.polls`) e ripetuta in tutte e tre le catene di rollup. |
| D9 | **Deduplica per `identifier` PRIMA di ogni conteggio**; `players` = cardinalità delle identità distinte, `keys_read` persistito a fianco | `online_raw = rows.length` (conteggio di CHIAVI) | La chiave è `metaverse:player:{username}`: un rename ne crea una seconda. `keys_read - players` è il contatore dei duplicati, cioè la sonda che dice se il plugin cancella al quit. |
| D10 | **Identità di sessione = (`identifier`, `connection-time` GREZZO)**. Il clamp anti-skew non tocca MAI l'identità né la chiave primaria: agisce solo su `ended_at` alla chiusura, con `end_reason = 'skew'` | `normalizeStart()` che restituisce `slot` corrente quando `skew > 60` | Con NTP avanti di 5 minuti quella funzione riapriva ogni sessione a ogni ciclo: durata media 20 s e 4,3 M righe/giorno. L'identità deve venire da un valore che non cambia fra un campionamento e l'altro. |
| D11 | **Righe rifiutate, non clampate**, quando `|skew| > 24h`: il tick resta `ok`, il giocatore non apre sessione, il fatto è contato in `poll_cycle.skew_s` | Clamp silenzioso | Un orologio fuori di un anno cercherebbe una partizione inesistente e farebbe fallire l'intero tick. |
| D12 | **Unici esatti su `stats.player_day (day, player_id integer)`**; la riga di rete è un conteggio suo, mai la somma delle modalità | `daily_unique(day, mode_id, player_uuid)` + `daily_unique_count` | 56 B/riga contro 88, e `identifier` è già la chiave con cui si arriva a tutto il resto. La somma per modalità conta due volte chi ne gioca due. |
| D13 | **`stats.player_day_mode` porta solo la PRESENZA** (nessun `seconds_online`, nessun `sessions`) | `seconds_online` attribuito a `mode_id_last` | Attribuire 3h04 a `duels` perché è l'ultima modalità toccata prima del logout è la classifica di ciò che si tocca per ultimo. I minuti per modalità escono esatti da `player_seconds` sui campioni. |
| D14 | **`sessions` e `session_seconds` esistono solo sulla riga `mode_id = 0`**, imposto da un `CHECK` | Colonne popolate per ogni modalità | Un vincolo del database rende impossibile la stessa attribuzione sbagliata a livello di rollup. |
| D15 | **Il paese vive in UN SOLO posto: `stats.player_day.country`** | `stats.geo_hour` + `stats.poll_hour` + `daily_country`, `country` su `player_session`, `country` su `session` | Tre sedi = tre numeri. La mappa è «unici del periodo, attribuiti al paese del giorno più recente», con l'invariante `sum(mappa) == uniques(periodo)` verificata come job. |
| D16 | **`geo_day`/`daily_country` cancellate**: nessuna tabella che sommi unici-giorno per paese | Rollup geografico per giorno | Sommare unici-giorno su un range dà giocatori-giorno: un numero giusto con il nome sbagliato accanto a un KPI che lo contraddice. |
| D17 | **L'IP non entra in `stats` in nessuna forma**, nemmeno hashato; niente `ip_hash`, niente `sec.player_net` | `ip_hash bytea = HMAC(k_geo, ip)` su `player_session` | L'anti-alt non è un compito del pannello statistiche: tenerlo fuori mantiene la valutazione di soglia DPIA a un criterio solo. |
| D18 | **Tre modalità sentinella: `__network__` (0), `__unknown__` (1), `__transit__` (2)** — i giocatori senza `server` sono una serie VISIBILE | Scarto implicito fra totale e somma del breakdown | Con `__transit__` esplicito vale l'invariante `players(0) = Σ players(mode>0)`, e nessuno «aggiusta» il grafico a torta normalizzando le percentuali. |
| D19 | **`stats.player_day` si scrive UNA volta per giocatore per giorno**; `session_open.last_seen_at` si flusha ogni 10 minuti sui soli `dirty`; niente upsert per giocatore per ciclo | `INSERT ... ON CONFLICT DO UPDATE SET samples = samples + 1` a ogni ciclo (5,76 M/giorno) + heartbeat ogni 60 s (2,88 M/giorno) | Il progetto rifiutava «una riga per giocatore per ciclo» e la rientrava come UPDATE, che è peggio: ~10 M versioni di tupla al giorno e ~1,4 GB di WAL per produrre 6 MB di dati. |
| D20 | **Nei rollup solo INTERI ADDITIVI** (`player_seconds bigint`, `covered_s`, `samples`, `players_max`); nessuna media memorizzata, nessun `real` sommato | `players_avg real` ri-aggregato con `sum(real)` | Le misure additive rendono il rollup gerarchico ESATTO e non approssimato, e non c'è più un posto dove due schermate diano due medie diverse. |
| D21 | **`players_min` cancellato**; `players_max` viaggia sempre con `players_max_at` e con la copertura del bucket | `players_min` a ogni livello | Il minimo richiede il join sulla griglia (assente = 0) e non serve a nessun widget approvato. Il massimo senza copertura e senza cadenza è il numero che il committente confronterà mese su mese sbagliando. |
| D22 | **La linea del grafico è SEMPRE la media**; il massimo è una seconda serie, mai la linea | `series_1m` che restituisce `online_max` come valore della serie | Con il massimo come linea lo stesso istante vale 1.240 a 24h, 1.310 a 30g e 1.480 a 1y: l'utente lo scopre da solo e perde fiducia in tutto il resto. |
| D23 | **Catena a tre livelli 5m → 1h → 1d**, gerarchica; nessun livello a 1 minuto; watermark inizializzato a `now()`, avanzamento a **catch-up limitato** (N bucket per giro) | `online_1m` + watermark seminato a epoch 0 + giro senza tetto | Un watermark a 0 o un arretrato di 30 giorni producono un singolo statement che viene ucciso dallo `statement_timeout`, ritentato per sempre, con il watermark fermo: stallo permanente e grafici vuoti. |
| D24 | **`final boolean` + `rebuilt_at` su `rollup_1d`** | Nessun numero dichiarato definitivo | Un rollup rieseguito non deve poter cambiare in silenzio un numero che il committente ha già letto e annotato. |
| D25 | **Gli invarianti sono un job con esito persistito in `stats.integrity_check`**, non un test una tantum | Nessun invariante verificato in continuo | Tutti i modi in cui questo sistema mente falliscono in silenzio e in modo plausibile: servono asserzioni che girano ogni giorno e lasciano una riga. |
| D26 | **BRIN solo su `stats.session (ended_at)`** (`minmax_multi`, `pages_per_range = 32`, `autosummarize = on`) | BRIN su `sample_mode`, sui rollup, su `player_day`, su `started_at` | Ovunque altrove la PK comincia già con il tempo e serve comunque all'upsert idempotente. Le righe di `session` entrano in ordine di CHIUSURA, non di inizio. |
| D27 | **Tabelle cancellate dal progetto**: `session_leg`, `session_hist_day` + `duration_bucket`, `player_mode_first`, colonne `new_network`/`new_to_mode`, `daily_unique`, `daily_unique_count`, `geo_hour`, `poll_hour`, `daily_country`, `online_5m`/`online_1m`/`online_1h`/`online_1d` (duplicati della catena rollup) | — | Nessun widget del design approvato le legge; sono partizioni, retention, autovacuum e percorsi di rollup non associativi da mantenere per niente. Aggiungerle dopo è una migration additiva. |
| D28 | **Retention posta come FINESTRA DI CORREZIONE**: `sample_mode` 30 giorni = per quanti giorni indietro si può ancora ricalcolare un rollup sbagliato. `player_day`/`session` 730 giorni, coerenti con il registro dei trattamenti | `player_day` a 3650 giorni (241 partizioni totali, contro le 150 dichiarate) | Con questi valori lo schema sta a ~123 partizioni vive, dentro il regime in cui il pruning è gratuito, e la retention non contraddice più il registro. |
| D29 | **Il ciclo di vita delle partizioni è fatto di righe** (`stats.partitioned_table`) + due funzioni `SECURITY DEFINER` con `SET TimeZone = 'UTC'`; i job li tiene l'applicazione, **niente pg_cron, niente cron esterno**; il lock è il `FOR UPDATE` su `stats.rollup_state` | Una funzione per tabella; advisory lock | Cambiare retention è una UPDATE; non c'è modo di aggiungere una tabella partizionata e dimenticare il job. Il `SET TimeZone` elimina i confini di partizione dipendenti dal client. |
| D30 | **Tre ruoli**: gruppo `metamc_stats_rw` che porta i privilegi, due login che lo ereditano (`metamc_ingest` con `statement_timeout = 5s`, `metamc_rollup` con `60s`), e `metamc_stats` di sola lettura (`10s`, `default_transaction_read_only`) | Un solo ruolo di ingest con 5 s condiviso col rollup | Un rollup lungo non deve poter rubare la connessione al ciclo di campionamento, e il timeout deve stare sul RUOLO, non nell'hook del pool. |
| D31 | **`registered_raw text` conservato com'è + `registered_at timestamptz` NULL finché l'offset non è misurato** (`stats.ingest_state.registration_offset_min`) | `registered_at` popolato subito assumendo un fuso | Il campo è `java.sql.Timestamp.toString()`: senza offset, «nuovi di oggi» è sbagliato per chi si registra fra mezzanotte e le 02:00. L'offset si misura confrontandolo con `connection-time` sullo stesso hash. |
| D32 | **`stats.mode` si auto-popola**, prefisso risolto da `stats.resolve_mode_key` (alias esatto → alias di prefisso → regexp → `__unknown__`) | Enum Postgres, colonna `mode` denormalizzata, mappa in TypeScript | Una modalità nuova è una riga, non una migration. La copia TypeScript della regexp esiste per non fare una query per giocatore e va confrontata con quella SQL da un test, altrimenti divergono in silenzio. |

## Risoluzione del conflitto fra i tre schemi

Il materiale conteneva tre migration 011 mutuamente incompatibili. Vince **una** variante per ciascun asse; le altre sono cancellate e non vanno riproposte.

| Asse | Vince | Motivo in una riga |
|---|---|---|
| **Grano grezzo** | `stats.sample_mode (tick_at timestamptz, mode_id, delta_s, players, servers)` — una riga per (tick, modalità), mai per (tick, giocatore) | È l'unica variante che porta `delta_s` per riga: jitter, tick persi, riavvii, cambio di cadenza e DST diventano lo stesso fenomeno e si annullano nel denominatore. Costa zero byte per allineamento. |
| **Registro dei cicli** | `stats.poll_cycle`, una riga per tick tentato, chiave `tick_at timestamptz` | Si tiene la parte migliore della variante A (missing / failed / ok distinti strutturalmente) e si butta `slot_epoch bigint` con `CHECK (% 20 = 0)`, che congelava la cadenza dentro il DDL. |
| **Identità di sessione** | `(player_id, started_at)` dove `player_id` = `identifier` e `started_at` = `connection-time` **grezzo** | `connection-time` è l'unico dato esatto e non cambia fra i campionamenti: chiude da sé il riavvio a metà sessione e spezza correttamente la riconnessione. `identifier` invece di `uuid` perché la deduplica dell'insieme online è per `identifier` (fatto accertato) e le due famiglie di conteggio devono usare la stessa definizione di «un giocatore». |
| **Dizionario modalità** | `stats.mode (mode_id smallint identity, mode_key, display_name, in_breakdown, hidden, sort_order)` + `stats.mode_alias` + `resolve_mode_key()` | È l'unica delle tre che sopporta un prefisso nuovo senza DDL e un prefisso mal troncato senza cambiare funzione. `mode_id = 0` è una riga VERA e memorizzata (il picco e gli unici di rete non si decompongono), `1 = __unknown__`, `2 = __transit__`. |
| **Tabella degli unici** | `stats.player_day (day, player_id)` + `stats.player_day_mode (day, mode_id, player_id)` | Unici esatti su intero, la riga di rete è `count(*)` su `player_day` e non la somma delle modalità. `daily_unique`, `daily_unique_count` e i loro rollup sono cancellati. |
| **Sede del dato geografico** | Colonna `country` su `stats.player_day`, prima osservazione del giorno | Una sede sola, una metrica sola, nessun IP in nessun artefatto persistente. `geo_hour`, `poll_hour`, `daily_country` e `country` su `session` sono cancellati. |
| **Livelli di rollup** | `rollup_5m` (partizionata, mese) → `rollup_1h` (non partizionata) → `rollup_1d` (non partizionata) | Misure additive ⇒ gerarchia esatta; mappatura range→livello: 24h e 7g da 5m, 30g e 90g da 1h, 1y da 1d. Nessun livello a 1 minuto. |

---

# 2. Schema dati — `migrations/011_stats.sql`

Forward-only, eseguita da `metamc_migrate`. Nomi in inglese, testo in italiano, come la 001 e la 009. Nessuna tabella citata e non definita; nessun indice su una colonna che non esiste.

```sql
-- ============================================================================
-- Migration 011 — schema `stats` (fase 2, statistiche del network MetaMC).
-- Postgres 18.6. Ruolo esecutore: metamc_migrate.
--
-- REGOLE PORTANTI, valide per tutto il file:
--   1. Il grano grezzo è (tick, modalità), mai (tick, giocatore).
--   2. Il DENOMINATORE di ogni media viene da stats.poll_cycle, mai dalle
--      righe della modalità. `covered_s` è replicato uguale su tutte le righe
--      dello stesso bucket proprio perché non lo si ricavi per errore.
--   3. Nei rollup si memorizzano solo interi ADDITIVI: la gerarchia
--      5m -> 1h -> 1d è esatta, non approssimata.
--   4. `delta_s` sta su ogni riga grezza: la cadenza non è mai una costante
--      di query e cambiarla non reinterpreta lo storico.
--   5. I confini di partizione sono UTC (SET TimeZone nelle funzioni);
--      il GIORNO CIVILE dei dati è sempre Europe/Rome (stats.civil_day).
--   6. I job li tiene l'applicazione. Niente pg_cron, niente cron esterno.
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout     = '3s';
SET LOCAL statement_timeout = '120s';

CREATE SCHEMA IF NOT EXISTS stats AUTHORIZATION metamc_migrate;
REVOKE ALL ON SCHEMA stats FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 0. RUOLI. Il gruppo porta i privilegi, i login portano i timeout.
--    Un rollup lungo non deve poter rubare la connessione al campionamento,
--    e il timeout sta sul RUOLO così vale anche per chi entra con psql.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metamc_stats_rw') THEN
    CREATE ROLE metamc_stats_rw NOLOGIN;            -- gruppo: solo privilegi
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metamc_ingest') THEN
    CREATE ROLE metamc_ingest LOGIN INHERIT;        -- password fuori dalla migration
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metamc_rollup') THEN
    CREATE ROLE metamc_rollup LOGIN INHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metamc_stats') THEN
    CREATE ROLE metamc_stats LOGIN INHERIT;         -- sola lettura, §16.2
  END IF;
END $$;

GRANT metamc_stats_rw TO metamc_ingest, metamc_rollup;

ALTER ROLE metamc_ingest SET statement_timeout = '5s';   -- sotto il budget di ciclo
ALTER ROLE metamc_ingest SET lock_timeout      = '1s';
ALTER ROLE metamc_ingest SET search_path       = stats, pg_catalog;

ALTER ROLE metamc_rollup SET statement_timeout = '60s';  -- il rollup può durare
ALTER ROLE metamc_rollup SET lock_timeout      = '3s';
ALTER ROLE metamc_rollup SET search_path       = stats, pg_catalog;

ALTER ROLE metamc_stats  SET statement_timeout = '10s';
ALTER ROLE metamc_stats  SET default_transaction_read_only = on;
ALTER ROLE metamc_stats  SET enable_partitionwise_aggregate = on;
ALTER ROLE metamc_stats  SET enable_partitionwise_join      = on;
ALTER ROLE metamc_stats  SET search_path       = stats, pg_catalog;
-- RUNBOOK: default_transaction_read_only blocca anche la manutenzione fatta
-- con queste credenziali. È voluto. Il primo che ci sbatte perde mezz'ora.

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
-- 'partial' = il tick ha letto solo una parte dell'insieme online. NON porta
-- informazione negativa: non chiude sessioni, non conta zeri, non entra nei
-- rollup. La regola è strutturale (i rollup filtrano status = 'ok'), non una if.
CREATE TYPE stats.cycle_status AS ENUM ('ok', 'partial', 'failed');

-- 'quit'   : sparito dal campione dopo la grazia, chiusura osservata
-- 'gap'    : il pannello era fermo fra l'ultima osservazione e il riavvio
-- 'reaper' : non più visto per N minuti senza un quit osservato
-- 'skew'   : connection-time incoerente con l'orologio del pannello
CREATE TYPE stats.session_end AS ENUM ('quit', 'gap', 'reaper', 'skew');

-- 'XX' = non determinato. È un valore legittimo e va MOSTRATO nella legenda:
-- un secchiello XX che cresce è il primo sintomo che il campo `ip` ha
-- cambiato semantica.
CREATE DOMAIN stats.country_code AS char(2) CHECK (VALUE ~ '^[A-Z]{2}$');

-- ---------------------------------------------------------------------------
-- 2. FUSO ORARIO — le uniche due funzioni autorizzate a nominarlo.
--    Ogni altra query usa queste, così Europe/Rome vive in un posto solo.
-- ---------------------------------------------------------------------------
CREATE FUNCTION stats.civil_day(p_ts timestamptz) RETURNS date
LANGUAGE sql STABLE STRICT PARALLEL SAFE AS $$
  SELECT (p_ts AT TIME ZONE 'Europe/Rome')::date
$$;

-- La lunghezza di un giorno NON è 86400: due volte l'anno vale 82800 e 90000.
CREATE FUNCTION stats.day_seconds(p_day date) RETURNS integer
LANGUAGE sql STABLE STRICT PARALLEL SAFE AS $$
  SELECT extract(epoch FROM (((p_day + 1)::timestamp AT TIME ZONE 'Europe/Rome')
                           - ( p_day     ::timestamp AT TIME ZONE 'Europe/Rome')))::integer
$$;

-- ---------------------------------------------------------------------------
-- 3. DIMENSIONE MODALITÀ. Sono RIGHE: aggiungerne una domani è una INSERT
--    che fa l'ingest da solo alla prima osservazione, non una migration.
-- ---------------------------------------------------------------------------
CREATE TABLE stats.mode (
  mode_id       smallint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY,
  mode_key      text     NOT NULL UNIQUE CHECK (mode_key ~ '^[a-z0-9_]{1,32}$'),
  display_name  text     NOT NULL,
  in_breakdown  boolean  NOT NULL DEFAULT true,
  hidden        boolean  NOT NULL DEFAULT false,
  sort_order    smallint NOT NULL DEFAULT 1000,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  created_by    text     NOT NULL DEFAULT 'ingest'
                  CHECK (created_by IN ('ingest', 'operator', 'migration'))
);

-- 0 = totale di rete: identità DISTINTE osservate, non la somma delle modalità
--     (max e count(distinct) non si decompongono). È una riga vera e memorizzata.
-- 1 = server presente ma prefisso non risolto.
-- 2 = giocatore senza `server`: in transito fra due server. È una serie
--     VISIBILE, altrimenti il breakdown non somma a 100% e qualcuno lo
--     «aggiusta» normalizzando le percentuali.
-- INVARIANTE: players(0) = somma di players(mode_id > 0) nello stesso tick.
INSERT INTO stats.mode (mode_id, mode_key, display_name, in_breakdown, sort_order, created_by)
VALUES (0, '__network__', 'Intero network', false,  -1, 'migration'),
       (1, '__unknown__', 'Sconosciuta',    true,  998, 'migration'),
       (2, '__transit__', 'In transito',    true,  999, 'migration');

-- Senza questo la prima modalità creata dall'ingest riceve 1 e collide.
SELECT setval(pg_get_serial_sequence('stats.mode', 'mode_id'), 100, false);

-- Eccezioni alla regola del prefisso: `4v4_2` finisce con un numero che fa
-- parte del nome; due prefissi possono essere la stessa modalità. Entrambi i
-- casi si risolvono con una riga, non con una funzione nuova.
CREATE TABLE stats.mode_alias (
  match_kind  text NOT NULL CHECK (match_kind IN ('server', 'prefix')),
  match_value text NOT NULL CHECK (match_value = lower(match_value)),
  mode_key    text NOT NULL REFERENCES stats.mode(mode_key) ON UPDATE CASCADE,
  note        text,
  PRIMARY KEY (match_kind, match_value)
);

-- `duels_6` -> `duels`;  `bedwars_solo_2` -> `bedwars_solo`;  `lobby` -> `lobby`.
CREATE FUNCTION stats.mode_key_of(p_server text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT nullif(regexp_replace(lower(btrim(p_server)), '_[0-9]+$', ''), '')
$$;

-- Ordine: server esatto -> prefisso ridefinito -> prefisso calcolato -> ignoto.
-- Questa è la definizione DI RIFERIMENTO. L'ingest ne tiene una copia in
-- TypeScript per non fare una query per giocatore: serve un test che confronti
-- le due su un elenco di server reali, altrimenti divergono in silenzio e la
-- divergenza si materializza come una modalità che esiste in due esemplari.
CREATE FUNCTION stats.resolve_mode_key(p_server text) RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT coalesce(
    (SELECT a.mode_key FROM stats.mode_alias a
      WHERE a.match_kind = 'server' AND a.match_value = lower(btrim(p_server))),
    (SELECT a.mode_key FROM stats.mode_alias a
      WHERE a.match_kind = 'prefix' AND a.match_value = stats.mode_key_of(p_server)),
    stats.mode_key_of(p_server),
    '__unknown__')
$$;

-- ---------------------------------------------------------------------------
-- 4. ANAGRAFICA GIOCATORE. Si riscrive SOLO quando cambia qualcosa:
--    `attrs_digest` è confrontato in memoria dall'ingest e se coincide non
--    parte nessuna query. `last_seen_at` si aggiorna alla CHIUSURA della
--    sessione, mai a ogni tick.
--
--    player_id = `identifier` di Redis. È la stessa identità con cui si
--    deduplica l'insieme online, con cui si contano gli unici e con cui si
--    identifica la sessione: una definizione sola di «un giocatore».
-- ---------------------------------------------------------------------------
CREATE TABLE stats.player (
  player_id      integer PRIMARY KEY,
  uuid           uuid,
  premium_id     uuid,
  xuid           text,
  username       text NOT NULL,
  -- STORED esplicito: in PG18 le colonne generate sono VIRTUAL di default e
  -- una colonna virtuale non è indicizzabile.
  username_lower text GENERATED ALWAYS AS (lower(username)) STORED,
  platform       text CHECK (platform IN ('JAVA', 'BEDROCK', 'UNKNOWN')),
  auth_kind      text,
  last_protocol  smallint,
  client_brand   text,
  -- '2024-07-20 09:46:17.0' così com'è: è java.sql.Timestamp.toString(), cioè
  -- l'ora locale della JVM, senza offset. `registered_at` resta NULL finché
  -- stats.ingest_state.registration_offset_min non è stato MISURATO.
  registered_raw text,
  registered_at  timestamptz,
  first_seen_at  timestamptz NOT NULL,
  last_seen_at   timestamptz NOT NULL,
  -- sha256 dei SOLI campi mutabili memorizzati qui. ATTENZIONE: una colonna
  -- mutabile aggiunta e dimenticata nel digest resta congelata per sempre.
  attrs_digest   bytea NOT NULL,
  anonymized_at  timestamptz,          -- art. 17: si svuota, non si elimina la riga
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Unico parziale: rileva la collisione «stesso identifier, uuid diverso»,
-- che è l'unico modo in cui l'ipotesi «identifier mai riassegnato» può
-- rompersi. Una query, non una sorpresa.
CREATE UNIQUE INDEX player_uuid_key     ON stats.player (uuid) WHERE uuid IS NOT NULL;
CREATE INDEX        player_username_idx ON stats.player (username_lower);

COMMENT ON COLUMN stats.player.player_id IS
  'DATO PERSONALE (identificatore online, art. 4(1) GDPR).';

-- I rename tornano indietro (A -> B -> A): la chiave è `valid_from`, non il
-- nome. Niente WITHOUT OVERLAPS: un clock skew farebbe FALLIRE l'ingest invece
-- di segnalare; al suo posto una query di integrità periodica.
CREATE TABLE stats.player_name (
  player_id  integer     NOT NULL REFERENCES stats.player(player_id) ON DELETE CASCADE,
  username   text        NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_to   timestamptz,
  PRIMARY KEY (player_id, valid_from)
);
CREATE INDEX player_name_lookup_idx ON stats.player_name (lower(username), valid_from DESC);

-- ---------------------------------------------------------------------------
-- 5. REGISTRO DEI CICLI. UNA RIGA PER TICK TENTATO, anche fallito.
--
--    Riga assente        -> il poller non stava girando           ('missing')
--    status = 'failed'   -> il poller girava, Redis non c'era     ('failed')
--    status = 'ok' senza righe in sample_mode -> rete DAVVERO vuota
--
--    Redis giù un'ora produce 120 righe 'failed'; Postgres giù un'ora produce
--    120 righe MANCANTI, perché non c'è dove scrivere che non si poteva
--    scrivere. Sono due buchi di natura diversa e la griglia di lettura li
--    distingue: è voluto, altrimenti qualcuno «aggiusta» il caso mancante
--    scrivendo zeri.
--
--    QUESTA TABELLA È IL DENOMINATORE DI TUTTE LE MEDIE.
-- ---------------------------------------------------------------------------
CREATE TABLE stats.poll_cycle (
  tick_at         timestamptz NOT NULL,
  run_id          uuid        NOT NULL,   -- cambia a ogni riavvio: individua i riavvii
  status          stats.cycle_status NOT NULL,
  -- Secondi trascorsi dall'ultimo tick OK, clampati a ingest_state.max_delta_s.
  -- Il tempo oltre il clamp resta SCOPERTO: è così che un fermo di tre ore non
  -- viene accreditato a un solo campione. Il 300 qui è un limite di sanità, non
  -- la cadenza: la cadenza non compare in nessun vincolo.
  delta_s         smallint    NOT NULL CHECK (delta_s BETWEEN 1 AND 300),
  duration_ms     integer,
  -- Identità DISTINTE (deduplicate per player_id). Non è la lunghezza
  -- dell'array di chiavi: la chiave è metaverse:player:{username} e un rename
  -- ne crea una seconda.
  players         integer     CHECK (players >= 0),
  keys_read       integer,               -- chiavi restituite dallo SCAN
  keys_skipped    integer,               -- chiavi che matchano il pattern ma non lo schema
  -- keys_read - players = duplicati di chiave. È LA sonda che dice se il
  -- plugin cancella davvero al quit.
  modes_seen      smallint,
  scan_iterations smallint,
  scan_truncated  boolean     NOT NULL DEFAULT false,
  dbsize          integer,               -- la curva del costo dello SCAN, visibile prima del guasto
  pttl_min_s      integer,               -- sentinella sul TTL (~100 s atteso): se sparisce,
  pttl_max_s      integer,               -- i fantasmi tornano e va rivista D4
  -- Mediana di (connection-time/1000 - tick) sui SOLI giocatori comparsi in
  -- questo tick. In SECONDI, e il nome lo dice. Fuori da quella popolazione
  -- non è skew: è l'età delle sessioni.
  skew_s          integer,
  skew_rejected   integer     NOT NULL DEFAULT 0,  -- righe scartate per |skew| > 24h
  servers_players integer,               -- controincrocio con duels:servers:*, opzionale e parziale
  error_kind      text,
  CONSTRAINT poll_cycle_pk           PRIMARY KEY (tick_at),
  CONSTRAINT poll_cycle_ok_players   CHECK (status <> 'ok'     OR players IS NOT NULL),
  CONSTRAINT poll_cycle_failed_blank CHECK (status <> 'failed' OR players IS NULL)
) PARTITION BY RANGE (tick_at);

ALTER TABLE stats.poll_cycle SET (autovacuum_vacuum_insert_scale_factor = 0.02);

-- ---------------------------------------------------------------------------
-- 6. IL GRANO GREZZO: una riga per (tick, modalità). MAI per giocatore.
--
--    CONVENZIONE SPARSA: nessuna riga per (tick, mode) dentro un tick `ok`
--    significa ZERO giocatori. Il CHECK rende impossibile scrivere uno zero,
--    quindi la convenzione non è un accordo verbale: è un vincolo del database.
--    Ma vale SOLO dentro un tick `ok`, e quella regola vive nelle viste —
--    per questo il GRANT di lettura si dà sulle VISTE, non su questa tabella.
--
--    `delta_s` è denormalizzato dal tick (stesso valore, scritto nella stessa
--    transazione): costa zero byte per allineamento e rende il NUMERATORE
--    calcolabile senza join. Il DENOMINATORE resta poll_cycle.
-- ---------------------------------------------------------------------------
CREATE TABLE stats.sample_mode (
  tick_at  timestamptz NOT NULL,
  mode_id  smallint    NOT NULL REFERENCES stats.mode(mode_id),
  delta_s  smallint    NOT NULL CHECK (delta_s BETWEEN 1 AND 300),
  players  integer     NOT NULL CHECK (players > 0),
  servers  smallint    NOT NULL DEFAULT 0,
  PRIMARY KEY (tick_at, mode_id)
) PARTITION BY RANGE (tick_at);

-- Append-only: senza questo la visibility map resta indietro e le letture
-- index-only degradano a scansioni dello heap.
ALTER TABLE stats.sample_mode SET (autovacuum_vacuum_insert_scale_factor = 0.02);
-- NIENTE BRIN: la PK comincia già con il tempo e serve comunque al reinserimento.

-- ---------------------------------------------------------------------------
-- 7. SESSIONI. Identità = (player_id, connection-time GREZZO).
--
--    `started_at` è to_timestamp(connection-time/1000) COSÌ COM'È: non viene
--    mai clampato, mai sostituito con l'istante corrente, mai ricalcolato.
--    È l'unico modo in cui il confronto «è la stessa sessione?» resta stabile
--    fra due tick anche con l'orologio del gioco fuori fase. Lo skew si
--    misura (poll_cycle.skew_s), si registra alla chiusura (end_reason =
--    'skew') e oltre le 24 ore fa scartare la riga, ma non tocca l'identità.
-- ---------------------------------------------------------------------------

-- LA TABELLA CALDA: una riga per giocatore online. È l'unica HOT-update dello
-- schema. `last_seen_at` si flusha ogni 10 minuti sui soli record sporchi:
-- a ogni tick sarebbero milioni di versioni di riga al giorno su poche
-- migliaia di righe. NON UNLOGGED: verrebbe troncata al crash recovery, cioè
-- esattamente quando serve.
CREATE TABLE stats.session_open (
  player_id     integer     PRIMARY KEY,
  started_at    timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL,
  mode_id_first smallint    NOT NULL REFERENCES stats.mode(mode_id),
  mode_id_last  smallint    NOT NULL REFERENCES stats.mode(mode_id),
  legs          smallint    NOT NULL DEFAULT 1,   -- permanenze contigue: traccia dei trasferimenti
  country       stats.country_code NOT NULL DEFAULT 'XX',
  platform      text,
  protocol      smallint,
  seen_ticks    integer     NOT NULL DEFAULT 1    -- durata OSSERVATA = seen_ticks * delta medio
) WITH (fillfactor = 70,
        autovacuum_vacuum_scale_factor  = 0.02,
        autovacuum_analyze_scale_factor = 0.05);
CREATE INDEX session_open_stale_idx ON stats.session_open (last_seen_at);

-- LO STORICO FREDDO: append-only, una riga per login chiuso.
-- `ended_at` è sempre l'ultimo istante per cui esiste una PROVA (last_seen_at),
-- mai now(): altrimenti ogni durata si gonfia della grazia e, dopo
-- un'interruzione, di ore.
-- La chiusura è un upsert che ESTENDE `ended_at` (GREATEST) invece di un
-- DO NOTHING: sotto guasto il reaper può aver già chiuso la sessione, e con
-- DO NOTHING la seconda metà sparirebbe senza traccia.
CREATE TABLE stats.session (
  started_at    timestamptz NOT NULL,
  player_id     integer     NOT NULL,
  ended_at      timestamptz NOT NULL,
  duration_s    integer GENERATED ALWAYS AS
                  (GREATEST(0, extract(epoch FROM (ended_at - started_at))::integer)) STORED,
  seen_ticks    integer     NOT NULL DEFAULT 1,
  mode_id_first smallint    NOT NULL,
  mode_id_last  smallint    NOT NULL,
  legs          smallint    NOT NULL DEFAULT 1,
  country       stats.country_code NOT NULL DEFAULT 'XX',
  platform      text,
  protocol      smallint,
  end_reason    stats.session_end NOT NULL,
  skew_s        integer,
  PRIMARY KEY (started_at, player_id)
) PARTITION BY RANGE (started_at);
-- Niente FK su mode_id_*: sono descrittivi e una FK su tabella partizionata
-- crea un vincolo per partizione a ogni ATTACH, per una garanzia che qui non
-- serve (le righe di stats.mode non si cancellano).

ALTER TABLE stats.session SET (autovacuum_vacuum_insert_scale_factor = 0.02);

-- QUI il BRIN è giusto, e SOLO qui:
--   * su `started_at` sarebbe ridondante (c'è già la PK in testa);
--   * su `ended_at` no: le righe entrano in ordine di CHIUSURA, quindi
--     `ended_at` è correlato con l'ordine fisico mentre `started_at` no —
--     una sessione da 12 ore si chiude in mezzo a quelle da 2 minuti, ed è
--     esattamente per quegli outlier che serve minmax_multi e non minmax;
--   * `autosummarize` acceso: senza, sulle partizioni append-only i range
--     restano non riassunti finché non passa un VACUUM, e un indice presente,
--     valido e ignorato dal pianificatore è peggio di un indice assente.
CREATE INDEX session_ended_brin ON stats.session
  USING brin (ended_at) WITH (pages_per_range = 32, autosummarize = on);
CREATE INDEX session_player_idx ON stats.session (player_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- 8. UNICI ESATTI (§16.7, niente HyperLogLog).
--
--    `day` è il giorno civile Europe/Rome, calcolato SEMPRE da stats.civil_day
--    sul tick corrente: nessun timer, nessun azzeramento a mezzanotte, nessuna
--    dipendenza dal TZ del processo (i container girano con TZ=UTC e
--    perderebbero ogni notte la coda fra le 00:00 e le 02:00 di Roma).
--
--    Si scrive UNA VOLTA per giocatore per giorno, non a ogni tick.
--    `country` = prima osservazione del giorno, mai riscritto: è la regola
--    deterministica senza la quale l'UPSERT balla a ogni ciclo.
-- ---------------------------------------------------------------------------
CREATE TABLE stats.player_day (
  day            date        NOT NULL,
  player_id      integer     NOT NULL,
  first_seen_at  timestamptz NOT NULL,
  last_seen_at   timestamptz NOT NULL,
  seconds_online integer     NOT NULL DEFAULT 0,  -- sessioni affettate a mezzanotte locale
  sessions       smallint    NOT NULL DEFAULT 0,  -- contate sul giorno in cui INIZIANO
  country        stats.country_code NOT NULL DEFAULT 'XX',
  PRIMARY KEY (day, player_id)
) PARTITION BY RANGE (day);
ALTER TABLE stats.player_day SET (autovacuum_vacuum_insert_scale_factor = 0.02);

-- Serve al DISTINCT ON (player_id) ... ORDER BY player_id, day DESC della
-- mappa: unici del periodo attribuiti al paese del giorno più recente.
-- È l'UNICA definizione della metrica geografica, e vale l'invariante
-- sum(mappa) == uniques(periodo), verificato da stats.integrity_check.
CREATE INDEX player_day_player_idx  ON stats.player_day (player_id, day DESC);
CREATE INDEX player_day_country_idx ON stats.player_day (day, country);

COMMENT ON TABLE stats.player_day IS
  'DATO PERSONALE: player_id + giorno + paese. Retention 730 giorni, cancellazione per DROP di partizione. L''indirizzo IP non entra mai in questo schema, in nessuna forma.';

-- Solo PRESENZA. Niente `seconds_online`, niente `sessions`: attribuire i
-- secondi di una sessione a mode_id_last produce la classifica di ciò che si
-- tocca per ultimo prima di sloggare. I minuti per modalità escono esatti da
-- player_seconds sui campioni, e devono uscire da lì e basta.
CREATE TABLE stats.player_day_mode (
  day       date     NOT NULL,
  mode_id   smallint NOT NULL REFERENCES stats.mode(mode_id),
  player_id integer  NOT NULL,
  PRIMARY KEY (day, mode_id, player_id)
) PARTITION BY RANGE (day);
ALTER TABLE stats.player_day_mode SET (autovacuum_vacuum_insert_scale_factor = 0.02);

-- ---------------------------------------------------------------------------
-- 9. ROLLUP. Solo interi ADDITIVI: la gerarchia 5m -> 1h -> 1d è ESATTA.
--
--    covered_s e samples vengono da poll_cycle e sono IDENTICI su tutte le
--    righe dello stesso bucket. player_seconds viene dalle righe della
--    modalità. La media è player_seconds / covered_s: una modalità aperta
--    5 minuti su 60 con 200 giocatori esce a 16,7 e non a 200.
--
--    players_max sopravvive al downsampling (il record di giocatori
--    contemporanei evaporerebbe con la sola media) e viaggia SEMPRE con
--    players_max_at. Niente players_min: richiederebbe il join sulla griglia
--    e non serve a nessun widget.
-- ---------------------------------------------------------------------------
CREATE TABLE stats.rollup_5m (
  bucket          timestamptz NOT NULL,
  mode_id         smallint    NOT NULL REFERENCES stats.mode(mode_id),
  samples         smallint    NOT NULL,   -- tick 'ok' nel bucket (dal registro)
  covered_s       integer     NOT NULL,   -- somma dei delta_s dei tick 'ok' (dal registro)
  player_seconds  bigint      NOT NULL,   -- somma di players * delta_s (dalla modalità)
  players_max     integer     NOT NULL,
  players_max_at  timestamptz,
  PRIMARY KEY (bucket, mode_id)
) PARTITION BY RANGE (bucket);
ALTER TABLE stats.rollup_5m SET (autovacuum_vacuum_insert_scale_factor = 0.02);

-- NON partizionata: ~500 righe/giorno, ~21 MB/anno. Partizionarla aggiungerebbe
-- tempo di pianificazione a ogni query per non risparmiare niente.
CREATE TABLE stats.rollup_1h (
  bucket          timestamptz NOT NULL,
  mode_id         smallint    NOT NULL REFERENCES stats.mode(mode_id),
  samples         integer     NOT NULL,
  covered_s       integer     NOT NULL,
  player_seconds  bigint      NOT NULL,
  players_max     integer     NOT NULL,
  players_max_at  timestamptz,
  PRIMARY KEY (bucket, mode_id)
);
-- Due domande, due indici: «tutte le modalità su un range» (panoramica, PK) e
-- «una modalità su un range lungo» (dettaglio). ~5 MB/anno: si paga da solo.
CREATE INDEX rollup_1h_mode_idx ON stats.rollup_1h (mode_id, bucket);

-- La tabella che da sola serve la vista a 1 anno di OGNI widget.
-- `day` è il giorno civile di Roma. `expected_s` NON è 86400 e non è una
-- costante: se lo fosse, i due giorni di cambio ora uscirebbero al 104% e al
-- 96% di copertura e qualcuno perderebbe un pomeriggio a cercare il bug
-- nell'ingest.
CREATE TABLE stats.rollup_1d (
  day             date     NOT NULL,
  mode_id         smallint NOT NULL REFERENCES stats.mode(mode_id),
  samples         integer  NOT NULL,
  covered_s       integer  NOT NULL,
  expected_s      integer  NOT NULL CHECK (expected_s IN (82800, 86400, 90000)),
  player_seconds  bigint   NOT NULL,
  players_max     integer  NOT NULL,
  players_max_at  timestamptz,
  uniques         integer  NOT NULL DEFAULT 0,  -- mode 0 da player_day, altre da player_day_mode
  sessions        integer  NOT NULL DEFAULT 0,
  session_seconds bigint   NOT NULL DEFAULT 0,
  -- Un giorno chiuso non si riscrive: `final` lo dichiara, `rebuilt_at` traccia
  -- ogni ricalcolo. Un numero che il committente ha già letto e annotato non
  -- può cambiare in silenzio.
  final           boolean  NOT NULL DEFAULT false,
  rebuilt_at      timestamptz,
  PRIMARY KEY (day, mode_id),
  -- Le sessioni non sono attribuibili a una modalità senza mentire: esistono
  -- solo sulla riga di rete, e il database lo impone.
  CONSTRAINT rollup_1d_sessions_network_only
    CHECK (mode_id = 0 OR (sessions = 0 AND session_seconds = 0))
);
CREATE INDEX rollup_1d_mode_idx ON stats.rollup_1d (mode_id, day);

-- ---------------------------------------------------------------------------
-- 10. VISTE DI LETTURA. Il ruolo di sola lettura riceve il GRANT QUI, non
--     sulle tabelle: la regola «assenza = zero solo dentro un tick coperto»
--     non deve essere aggirabile, e una media non deve mai poter uscire da
--     una divisione per un denominatore preso dalle righe sbagliate.
--
--     covered_s può superare di un delta il nominale sul bordo del bucket
--     (un tick appartiene per intero al bucket in cui cade): la copertura è
--     quindi tagliata a 1.0 qui, una volta sola.
-- ---------------------------------------------------------------------------
CREATE VIEW stats.v_online_5m AS
SELECT r.bucket, r.mode_id, m.mode_key,
       (r.player_seconds::float8 / nullif(r.covered_s, 0))::real AS players_avg,
       CASE WHEN r.covered_s > 0 THEN r.players_max END          AS players_max,
       r.players_max_at,
       LEAST(1.0, r.covered_s::float8 / 300)::real               AS coverage
FROM stats.rollup_5m r JOIN stats.mode m USING (mode_id);

CREATE VIEW stats.v_online_1h AS
SELECT r.bucket, r.mode_id, m.mode_key,
       (r.player_seconds::float8 / nullif(r.covered_s, 0))::real AS players_avg,
       CASE WHEN r.covered_s > 0 THEN r.players_max END          AS players_max,
       r.players_max_at,
       LEAST(1.0, r.covered_s::float8 / 3600)::real              AS coverage,
       -- Etichette locali calcolate QUI e solo qui. La heatmap 7x24 raggruppa
       -- su queste e la media pesata divide per i secondi REALMENTE coperti:
       -- l'ora saltata non produce bucket (cella scoperta), l'ora ripetuta ne
       -- produce due che si sommano. Nessun caso speciale, e mai un `/ 7`.
       extract(isodow FROM (r.bucket AT TIME ZONE 'Europe/Rome'))::smallint AS local_dow,
       extract(hour   FROM (r.bucket AT TIME ZONE 'Europe/Rome'))::smallint AS local_hour
FROM stats.rollup_1h r JOIN stats.mode m USING (mode_id);

CREATE VIEW stats.v_online_1d AS
SELECT r.day, r.mode_id, m.mode_key,
       (r.player_seconds::float8 / nullif(r.covered_s, 0))::real AS players_avg,
       CASE WHEN r.covered_s > 0 THEN r.players_max END          AS players_max,
       r.players_max_at,
       LEAST(1.0, r.covered_s::float8 / r.expected_s)::real      AS coverage,
       r.uniques, r.sessions, r.session_seconds, r.final
FROM stats.rollup_1d r JOIN stats.mode m USING (mode_id);

-- Durata media ONESTA: esclude ciò che non abbiamo osservato per intero.
-- Una query di durata che non filtra end_reason restituisce un numero
-- sbagliato, quindi il filtro è nella vista e non nella buona volontà.
CREATE VIEW stats.v_session_observed AS
SELECT * FROM stats.session WHERE end_reason = 'quit';

-- ---------------------------------------------------------------------------
-- 11. STATO DEI JOB. Il `FOR UPDATE` sulla riga di livello È il lock: due
--     istanze si serializzerebbero da sole, senza advisory lock (che nessuno
--     eserciterebbe finché l'istanza è una sola).
-- ---------------------------------------------------------------------------
CREATE TABLE stats.rollup_state (
  level          text PRIMARY KEY CHECK (level IN ('5m', '1h', '1d')),
  watermark      timestamptz NOT NULL,
  -- Quanti bucket mancano al presente. Il giro ne processa al massimo
  -- max_buckets e riporta behind_buckets > 0 finché è indietro: un arretrato
  -- di 30 giorni non deve MAI diventare un singolo statement, che verrebbe
  -- ucciso dal timeout, ritentato per sempre e lascerebbe il watermark fermo.
  behind_buckets integer     NOT NULL DEFAULT 0,
  max_buckets    integer     NOT NULL DEFAULT 288 CHECK (max_buckets > 0),
  rows_written   integer     NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
-- Watermark a now(), MAI a epoch 0: un reseed a zero scandirebbe dall'inizio
-- dei tempi al primo giro.
INSERT INTO stats.rollup_state (level, watermark) VALUES
  ('5m', date_trunc('hour', now())),
  ('1h', date_trunc('hour', now())),
  ('1d', date_trunc('day',  now()));

CREATE TABLE stats.ingest_state (
  id                       smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_tick_at             timestamptz,
  last_ok_tick_at          timestamptz,
  last_tick_players        integer,
  nominal_delta_s          smallint NOT NULL DEFAULT 30 CHECK (nominal_delta_s BETWEEN 5 AND 120),
  -- Oltre questo, il tempo NON è coperto: è la differenza fra «tenere l'ultimo
  -- valore per un tick saltato» e «accreditare tre ore di buco a un campione».
  max_delta_s              smallint NOT NULL DEFAULT 60 CHECK (max_delta_s BETWEEN 5 AND 300),
  grace_ticks              smallint NOT NULL DEFAULT 3,
  reaper_after_s           integer  NOT NULL DEFAULT 900,
  -- NULL = offset di registrationDate non ancora misurato: finché è NULL,
  -- stats.player.registered_at resta NULL e non ci si fa aritmetica.
  registration_offset_min  smallint,
  -- Prima di questo istante non esiste storico: qualunque metrica «prima
  -- volta» va etichettata come tale in interfaccia.
  history_start_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ingest_delta_order CHECK (max_delta_s >= nominal_delta_s)
);
INSERT INTO stats.ingest_state (id) VALUES (1);

-- Gli invarianti girano come JOB e lasciano una riga. Tutti i modi in cui
-- questo sistema può mentire falliscono in silenzio e in modo plausibile:
-- nessuno solleva un'eccezione, nessuno rompe un grafico.
-- Controlli previsti (uno per `name`):
--   network_equals_breakdown : players(0) = somma players(mode>0) per tick
--   uniques_bounds           : max(uniques per modalità) <= uniques(0) <= somma
--   max_hierarchy            : players_max(1d) = max dei players_max(1h) del giorno
--   geo_sum_equals_uniques   : somma della mappa = unici del periodo
--   delta_agreement          : sample_mode.delta_s = poll_cycle.delta_s
--   rollup_vs_raw            : 1h ricalcolato dal grezzo = 1h memorizzato
--   ticks_missing_24h        : tick mai tentati nelle ultime 24 ore
CREATE TABLE stats.integrity_check (
  run_at   timestamptz NOT NULL DEFAULT now(),
  name     text        NOT NULL,
  failures bigint      NOT NULL,
  detail   jsonb,
  PRIMARY KEY (run_at, name)
);
CREATE INDEX integrity_check_name_idx ON stats.integrity_check (name, run_at DESC);

-- ---------------------------------------------------------------------------
-- 12. PARTIZIONI. Anche il ciclo di vita è fatto di RIGHE: cambiare la
--     retention è una UPDATE, aggiungere una tabella partizionata è una
--     INSERT, e non c'è modo di aggiungerne una dimenticando il job che le
--     crea le partizioni — il guasto documentato nella migration 009.
--
--     `keep_days` di sample_mode NON è una scelta di spazio: è per quanti
--     giorni indietro si può ancora RICALCOLARE un rollup sbagliato.
--     Va posta al committente in questi termini.
--
--     Conto delle partizioni vive con questi valori:
--       sample_mode      36 (giorno)   rollup_5m        15 (mese)
--       poll_cycle        5 (mese)     session          26 (mese)
--       player_day       26 (mese)     player_day_mode  15 (mese)
--     Totale ~123: dentro il regime in cui il pruning è gratuito.
-- ---------------------------------------------------------------------------
CREATE TABLE stats.partitioned_table (
  table_name  text PRIMARY KEY,
  granularity text    NOT NULL CHECK (granularity IN ('day', 'month')),
  -- Il pavimento sta QUI, come vincolo, non come argomento che il chiamante
  -- può scegliere.
  keep_days   integer NOT NULL CHECK (keep_days >= 7)
);
INSERT INTO stats.partitioned_table VALUES
  ('sample_mode',     'day',    30),   -- finestra di correzione dei rollup
  ('poll_cycle',      'month',  90),   -- diagnostica dei buchi
  ('rollup_5m',       'month', 400),   -- il vero pavimento per una ricostruzione
  ('session',         'month', 730),   -- dato personale, coerente col registro
  ('player_day',      'month', 730),   -- dato personale, coerente col registro
  ('player_day_mode', 'month', 400);

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

      EXECUTE format('CREATE TABLE stats.%I PARTITION OF stats.%I FOR VALUES FROM (%L) TO (%L)',
                     part, r.table_name, lo, hi);
      made := made + 1;
    END LOOP;
  END LOOP;
  RETURN made;
END $$;
-- NESSUN GRANT sulle partizioni: per un accesso attraverso la tabella padre
-- Postgres controlla la ACL del SOLO padre. Concederle direttamente
-- aggirerebbe le viste, che sono il punto in cui vive la semantica.

-- La potatura ricava il periodo dal NOME, che è generato da ensure_partitions
-- e ha quindi forma nota; il join su pg_inherits garantisce comunque che si
-- stia toccando solo una partizione di una tabella REGISTRATA.
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
    -- Si elimina solo se la partizione è INTERAMENTE fuori finestra.
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
-- 13. PRIVILEGI.
--     Scrittura: solo il gruppo. Nessun DELETE (la retention è un DROP di
--     partizione) tranne su session_open, dove una sessione che si chiude
--     deve sparire. Nessun TRUNCATE, mai.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA stats TO metamc_stats_rw, metamc_stats;

GRANT SELECT, INSERT, UPDATE ON ALL TABLES    IN SCHEMA stats TO metamc_stats_rw;
GRANT USAGE, SELECT           ON ALL SEQUENCES IN SCHEMA stats TO metamc_stats_rw;
GRANT DELETE ON stats.session_open TO metamc_stats_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE metamc_migrate IN SCHEMA stats
  GRANT SELECT, INSERT, UPDATE ON TABLES TO metamc_stats_rw;

-- Lettura: le VISTE, il dizionario, e le due tabelle di fatto che i KPI di
-- sessione e la mappa devono per forza toccare. MAI sample_mode, MAI
-- poll_cycle, MAI i rollup nudi: chi leggesse le tabelle disegnerebbe zeri
-- al posto dei buchi e medie con il denominatore sbagliato.
GRANT SELECT ON stats.v_online_5m, stats.v_online_1h, stats.v_online_1d,
                stats.v_session_observed, stats.session,
                stats.player_day, stats.player_day_mode,
                stats.mode, stats.mode_alias, stats.ingest_state
  TO metamc_stats;
ALTER DEFAULT PRIVILEGES FOR ROLE metamc_migrate IN SCHEMA stats
  GRANT SELECT ON TABLES TO metamc_stats;

COMMENT ON VIEW stats.v_online_1h IS
  'Fonte unica dei range 7g/30g/90g e della heatmap. players_avg è NULL dove non è stato osservato nulla: mai zero, e mai interpolato fra due punti separati da un NULL.';

-- ---------------------------------------------------------------------------
-- 14. Prime partizioni, così le tabelle sono usabili al primo tick.
--     Partizione mancante = SQLSTATE 23514 e OGNI ciclo fallisce da mezzanotte
--     in poi: il grafico diventa bianco e la causa non è nel codice del
--     grafico. La creazione va rifatta all'avvio E in un job periodico, e
--     l'INSERT deve ritentare UNA volta dopo aver chiamato ensure_partitions.
-- ---------------------------------------------------------------------------
SELECT stats.ensure_partitions();

COMMIT;
```

---

## 3. Il poller

### 3.1 Perimetro e vincoli già decisi

Il poller è l'unico componente che parla con il Redis del **network di gioco**. Legge, non scrive mai. Non richiede nulla a chi mantiene il plugin, non mantiene indici propri, non ascolta il pub/sub, non fa riconciliazioni: con `DBSIZE = 2667` e oltre 1.000 giocatori contemporanei lo SCAN attraversa poco più di due chiavi per giocatore trovato, quindi **lo SCAN per ciclo è la soluzione**, non il problema. Tutta la macchineria pensata per un keyspace grande (ZSET `mm:online:idx`, subscriber, cadenza adattiva, drift) è cancellata dal progetto.

Le chiavi giocatore hanno un **TTL di ~100 s rinnovato dal plugin**. Conseguenza diretta: non esistono fantasmi permanenti, e le quattro regole di rilevamento ghost (server morto, impronta congelata, età, sovraconteggio) sono cancellate insieme al resto. Resta un effetto reale e misurabile, trattato in §4.2: una chiave sopravvive fino a ~100 s dopo l'uscita del giocatore, quindi il conteggio istantaneo include chi è uscito da meno di un TTL e la fine sessione è sovrastimata dello stesso ordine. Il rimedio non è un filtro euristico: è il `PTTL`, che si chiede in pipeline a costo marginale e viene persistito.

**Cadenza D = 30 s.** Il vincolo non è più Redis (a questo keyspace è gratis) ma il volume scritto in Postgres.

### 3.2 Connessione dedicata al Redis di gioco

Client `ioredis` separato da quello delle sessioni e da quello della cache. Non è igiene: è il requisito «un Redis di gioco lento non deve poter rallentare i login».

```ts
// src/redis/game-client.ts
export function createGameRedis(url: string): Redis {
  return new Redis(url, {
    // NESSUN keyPrefix: ioredis lo antepone al MATCH dello SCAN ma NON lo toglie
    // dalle chiavi restituite. Gli HMGET successivi lo aggiungerebbero due volte.
    enableAutoPipelining: false,   // le pipeline le costruiamo a mano, a lotti
    enableOfflineQueue: false,     // un Redis giu' non accumula comandi in RAM per ore
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    commandTimeout: 1_500,         // < budget di ciclo
    lazyConnect: false,
  });
}
```

Sull'istanza di gioco, utente ACL di sola lettura (un bug del poller non deve poter danneggiare il gioco):

```
ACL SETUSER panel_ingest on >__segreto__ \
    ~metaverse:player:* ~duels:servers:* \
    +@read +scan +ping +info +dbsize +pttl -@write -@dangerous -@admin -keys -flushall -flushdb
```

Lato Postgres, pool dedicato: `max: 2` rende **matematicamente** impossibile che l'ingest affami le 6 connessioni del pannello, e `statement_timeout = '5s'` sta sotto il budget di ciclo.

```ts
const ingestPool = createPool({
  connectionString: env.INGEST_DATABASE_URL,
  max: 2, applicationName: 'metamc-ingest', statementTimeout: '5s',
});
```

Il ruolo `metamc_ingest` non ha `USAGE` sugli schemi `auth`, `audit`, `public`, e non ha `DELETE` (la retention è un DETACH/DROP fatto da un altro ruolo). Il rollup **non** usa questo pool: ha il suo (§5.4), altrimenti un giro lungo ruba al campionamento la sua connessione.

### 3.3 Il ciclo, per intero

Costanti e stato del processo:

```ts
const D = 30_000;              // cadenza nominale
const D_MAX_S = 60;            // un campione non puo' coprire piu' di 2 intervalli
const CYCLE_BUDGET_MS = 8_000; // AbortController
const SCAN_BUDGET_MS  = 2_000;
const SCAN_COUNT      = 1000;  // ~3 round trip con DBSIZE ~2.7k
const HMGET_BATCH     = 500;   // il limite sono i round trip, non la CPU
const GRACE_TICKS     = 3;     // 90 s prima di chiudere per assenza
const PREFIX = 'metaverse:player:';

const LIGHT = ['identifier', 'server', 'connection-time'] as const;
const HEAVY = ['uuid','premium-id','username','platform','protocol','proxy',
               'client-brand','ip','registrationDate','xuid'] as const;

let runId = randomUUID();      // cambia a ogni riavvio: individua i riavvii nei cicli
let lastOkAt: Date | null = null;
let running = false;
let pendingGapCheck = false;
const open = new Map<number, OpenSession>();          // player_id -> sessione aperta
const modeIds = new Map<string, number>();            // mode_key -> mode_id
const dayUniques = new Map<string, Set<number>>();    // 'YYYY-MM-DD' (Roma) -> player_id
```

Il ciclo restituisce una **union discriminata**: solo il ramo `Ok` espone l'elenco dei presenti e degli assenti. Non è una convenzione, è la difesa strutturale contro il guasto in cui un hiccup di Redis chiude in massa tutte le sessioni aperte.

```ts
type CycleResult =
  | { kind: 'ok';      sampledAt: Date; deltaS: number; live: Map<number, Light>; diag: Diag }
  | { kind: 'partial'; sampledAt: Date; diag: Diag; reason: 'scan_truncated' | 'budget' }
  | { kind: 'failed';  sampledAt: Date; errorKind: string };
```

#### 3.3.1 Raccolta

```ts
async function collect(sampledAt: Date, signal: AbortSignal): Promise<CycleResult> {
  const diag: Diag = { keysSeen: 0, keysSkipped: 0, dupKeys: 0, scanIters: 0,
                       scanTruncated: false, dbsize: null, pttl: null, skewS: null };
  try {
    // 1) SCAN COMPLETO. Il MATCH e' applicato DOPO il recupero delle chiavi e
    //    anche TYPE hash filtra soltanto: nessuno dei due riduce il costo. Qui
    //    non importa, perche' il keyspace e' ~2 chiavi per giocatore.
    //    SCAN puo' restituire la stessa chiave piu' volte: Set obbligatorio.
    const t0 = Date.now();
    const keys = new Set<string>();
    let cur = '0';
    do {
      const [next, batch] = await game.scan(cur, 'MATCH', `${PREFIX}*`,
                                            'COUNT', SCAN_COUNT, 'TYPE', 'hash');
      for (const k of batch) {
        const rest = k.slice(PREFIX.length);
        if (rest.includes(':')) { diag.keysSkipped++; continue; } // sotto-chiavi future
        keys.add(rest);
      }
      cur = next; diag.scanIters++;
      if (Date.now() - t0 > SCAN_BUDGET_MS) { diag.scanTruncated = true; break; }
      await setImmediate();          // non tenere l'event loop in un blocco contiguo
    } while (cur !== '0');
    diag.keysSeen = keys.size;

    // Uno SCAN troncato NON e' un conteggio: la garanzia "restituisce tutti gli
    // elementi presenti" vale solo per un'iterazione COMPLETA. Meglio un ciclo
    // dichiarato incompleto che un numero sbagliato che sembra giusto (il difetto
    // n.1 del legacy: `if (keys.length >= 1000) break`).
    if (diag.scanTruncated) return { kind: 'partial', sampledAt, diag, reason: 'scan_truncated' };

    // 2) HMGET LEGGERO + PTTL, in pipeline a lotti. 3 campi su 19: HMGET con lista
    //    esplicita fissa il contratto — un campo nuovo del plugin non cambia in
    //    silenzio i byte letti, uno rimosso torna null invece di sparire.
    const rows: Light[] = [];
    const members = [...keys];
    for (let i = 0; i < members.length; i += HMGET_BATCH) {
      if (signal.aborted) return { kind: 'partial', sampledAt, diag, reason: 'budget' };
      const chunk = members.slice(i, i + HMGET_BATCH);
      const p = game.pipeline();
      for (const u of chunk) { p.hmget(PREFIX + u, ...LIGHT); p.pttl(PREFIX + u); }
      const res = await p.exec();
      for (let j = 0; j < chunk.length; j++) {
        const [eH, vals] = res![j * 2], [ , ttl] = res![j * 2 + 1];
        if (eH || !vals) continue;
        const parsed = parseLight(chunk[j], vals as (string|null)[], Number(ttl));
        if (!parsed) { diag.keysSkipped++; continue; }
        rows.push(parsed);
      }
      await setImmediate();
    }

    // 3) DEDUPLICA PER identifier, mai per chiave. La chiave e'
    //    metaverse:player:{username} ed e' case sensitive: un rename ne crea una
    //    nuova e la vecchia puo' restare viva fino allo scadere del TTL. Contare
    //    le chiavi significa contare due volte chi ha appena cambiato nome.
    const live = new Map<number, Light>();
    for (const r of rows) {
      const prev = live.get(r.playerId);
      if (!prev) { live.set(r.playerId, r); continue; }
      diag.dupKeys++;
      if (r.startedRawMs > prev.startedRawMs) live.set(r.playerId, r); // vince la piu' recente
    }

    diag.dbsize = await game.dbsize();
    diag.pttl   = summarizePttl(rows);   // p05/p50/p95 + quanti a -1 (nessun TTL)
    diag.skewS  = medianSkew(rows, sampledAt);  // solo sui connection-time recenti

    const gap = lastOkAt ? Math.round((+sampledAt - +lastOkAt) / 1000) : D / 1000;
    // Un campione rappresenta l'intervallo (t_prev, t]. Oltre 2 intervalli
    // nominali attribuirgli tutto il gap sarebbe una bugia: copre D e il resto
    // resta NON COPERTO, visibile come covered_s < expected_s del bucket.
    const deltaS = gap >= 1 && gap <= D_MAX_S ? gap : D / 1000;

    return { kind: 'ok', sampledAt, deltaS, live, diag };
  } catch (err) {
    return { kind: 'failed', sampledAt, errorKind: classify(err) };
  }
}
```

`parseLight` è dove si scartano le righe inutilizzabili. **Una riga senza `identifier` si scarta, non si inserisce con `player_id = 0`**: uno zero diventa un giocatore fantasma che compare in ogni aggregato e non se ne va più. `connection-time` arriva come stringa in millisecondi: `Number(undefined)` dà `NaN`, e `NaN` passato a Postgres come `bigint` è un errore di query — cioè un ciclo perso — non un `NULL`.

```ts
function parseLight(key: string, v: (string|null)[], pttlMs: number): Light | null {
  const id   = Number(v[0]);
  const conn = Number(v[2]);
  if (!Number.isInteger(id) || id <= 0) return null;
  if (!Number.isFinite(conn) || conn <= 0) return null;
  return { key, playerId: id, server: (v[1] ?? '').trim(), startedRawMs: conn, pttlMs };
}
```

#### 3.3.2 Sessioni nuove e HMGET pesante

I dieci campi pesanti si leggono **una sola volta per sessione**, alla comparsa. Su un ciclo di regime i nuovi sono qualche decina, non mille.

```ts
function newcomers(live: Map<number, Light>): Light[] {
  const out: Light[] = [];
  for (const [pid, r] of live) {
    const s = open.get(pid);
    // Identita' di sessione = (player_id, connection-time GREZZO). Il confronto
    // avviene sempre sul valore grezzo, MAI su quello normalizzato per lo skew:
    // un valore che dipende dal ciclo corrente farebbe chiudere e riaprire ogni
    // sessione a ogni ciclo su un server con l'orologio avanti.
    if (!s || s.startedRawMs !== r.startedRawMs) out.push(r);
  }
  return out;
}

async function hydrate(fresh: Light[], signal: AbortSignal): Promise<Map<number, Heavy>> {
  const out = new Map<number, Heavy>();
  for (let i = 0; i < fresh.length; i += HMGET_BATCH) {
    if (signal.aborted) break;                    // i restanti si idratano al ciclo dopo
    const chunk = fresh.slice(i, i + HMGET_BATCH);
    const p = game.pipeline();
    for (const r of chunk) p.hmget(r.key, ...HEAVY);
    const res = await p.exec();
    res?.forEach(([err, vals], j) => {
      if (err || !vals) return;
      const h = parseHeavy(vals as (string|null)[]);
      // username dal CAMPO username, MAI ricavato dalla chiave.
      if (!h.username) return;
      // L'IP vive solo qui dentro: risolto in paese e mai messo in un oggetto
      // che sopravviva al tick. Non entra in nessuna tabella, in nessun log.
      h.country = countryOf(h.ip); h.ip = undefined;
      out.set(chunk[j].playerId, h);
    });
    await setImmediate();
  }
  return out;
}
```

#### 3.3.3 Conteggi per modalità

```ts
function tally(live: Map<number, Light>): Map<number, { players: number; servers: Set<string> }> {
  const t = new Map<number, { players: number; servers: Set<string> }>();
  for (const r of live.values()) {
    // mode 2 = __transit__. Un giocatore fra due server ha `server` vuoto: e' nel
    // conteggio di rete e in nessuna modalita'. La differenza fra la riga 0 e la
    // somma delle altre e' un DATO, e deve avere una serie propria — altrimenti
    // il grafico a torta non sommera' mai a 100% e qualcuno lo "aggiustera'"
    // normalizzando le percentuali, cioe' spalmando i transiti sulle modalita'.
    const mid = r.server ? resolveModeId(r.server) : 2;
    const e = t.get(mid) ?? { players: 0, servers: new Set() };
    e.players++; if (r.server) e.servers.add(r.server);
    t.set(mid, e);
  }
  // La riga 0 e' la CARDINALITA' della mappa deduplicata, non la somma delle altre.
  t.set(0, { players: live.size, servers: new Set() });
  return t;
}
```

`resolveModeId` consulta una `Map` in memoria caricata all'avvio da `stats.mode` + `stats.mode_alias`; un prefisso mai visto fa un `INSERT ... ON CONFLICT (mode_key) DO NOTHING RETURNING mode_id` e non deve **mai** far fallire un ciclo. La regexp `_[0-9]+$` vive in due posti (la funzione SQL di riferimento e la copia TypeScript): serve un test che le confronti su un elenco di server reali, altrimenti divergono in silenzio e una modalità esiste in due esemplari.

#### 3.3.4 Scrittura: una transazione, quattro statement

```sql
BEGIN;
-- 1) LA RIGA DI CICLO. Prima dei campioni, nella stessa transazione: non puo'
--    esistere un ciclo 'ok' senza i suoi campioni, ne' campioni senza ciclo.
INSERT INTO stats.poll_cycle (sampled_at, run_id, status, delta_s, duration_ms,
        players, keys_seen, keys_skipped, dup_keys, scan_iterations, scan_truncated,
        dbsize, pttl_stats, servers_players, skew_s)
VALUES ($1,$2,'ok',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14)
ON CONFLICT (sampled_at) DO NOTHING;

-- 2) I CAMPIONI, un round trip con unnest. Riga 0 SEMPRE, anche a zero.
--    Le altre modalita' solo con players > 0 (convenzione sparsa).
INSERT INTO stats.sample_mode (sampled_at, mode_id, delta_s, players, servers)
SELECT $1, m, $3, p, s FROM unnest($15::smallint[], $16::int[], $17::smallint[]) AS t(m,p,s)
ON CONFLICT (sampled_at, mode_id) DO NOTHING;

-- 3) UNICI: solo le coppie NUOVE del giorno (Set in memoria, §4.3).
INSERT INTO stats.player_day (day, player_id, first_seen_at, last_seen_at, country)
SELECT $18::date, u, $1, $1, c FROM unnest($19::int[], $20::char(2)[]) AS t(u,c)
ON CONFLICT (day, player_id) DO NOTHING;
INSERT INTO stats.player_day_mode (day, mode_id, player_id)
SELECT $18::date, m, u FROM unnest($21::smallint[], $22::int[]) AS t(m,u)
ON CONFLICT (day, mode_id, player_id) DO NOTHING;

-- 4) Aperture e chiusure di sessione (§4.1, §4.2).
COMMIT;
```

Non c'è FK fra `sample_mode` e `poll_cycle`: su tabelle partizionate costerebbe un vincolo per ogni ATTACH senza aggiungere nulla che la transazione unica non garantisca già.

**Partizione mancante** = SQLSTATE 23514 e ogni ciclo fallisce da mezzanotte in poi: il grafico diventa bianco e la causa non è nel codice del grafico. Le partizioni si creano all'avvio **e** in un job ogni 6 ore, e l'INSERT ritenta **una** volta dopo aver chiamato `stats.ensure_partitions()`.

### 3.4 Fallimenti

**Redis irraggiungibile.** Riga `poll_cycle` con `status='failed'` e `error_kind`, scritta in una transazione **separata** (quella principale non è mai partita). `delta_s` resta `NULL`: un ciclo fallito non copre nulla. Il ciclo successivo non accumula il tempo perso, perché `delta_s` è tagliato a `D_MAX_S`. Circuit breaker con backoff `min(300s, D · 2^min(fail,4))` → 30s, 60s, 120s, 240s, 300s. **Una riga di log per TRANSIZIONE di stato** (sano→guasto, guasto→sano) più un riassunto ogni 60 cicli: 2.880 cicli/giorno moltiplicano tutto, e un Redis giù per una notte scriverebbe migliaia di righe identiche. Tutto il resto vive in `poll_cycle`, che è interrogabile.

**Ciclo che sfora l'intervallo.** `AbortController` a 8 s. Un ciclo `partial` **non porta informazione negativa**: non scrive righe in `sample_mode` (i suoi conteggi sono sottostimati), non chiude sessioni, non conta zeri. Scrive solo la riga `poll_cycle` con `status='partial'`, `delta_s NULL` e i contatori diagnostici. Il tempo di quel ciclo resta non coperto, che è la verità.

**Sovrapposizione.** Timer non-drifting (`setTimeout` ricalcolato sul prossimo multiplo, mai `setInterval`) più un flag `running`. Se il timer scatta mentre un ciclo è in corso, il nuovo **non parte**: si scrive `status='skipped'` con `delta_s NULL` e si continua. Due cicli concorrenti sono comunque respinti dal database (PK su `sampled_at`), non da una `if`.

**Postgres irraggiungibile.** Non c'è dove scrivere che non si poteva scrivere: le righe non esistono e la lettura le vede come `missing`. Un anello in memoria degli ultimi 20 cicli non scritti (10 minuti, cap rigido) viene riversato al ritorno con `ON CONFLICT DO NOTHING`; oltre il cap si perde, ed è corretto che si veda. Redis giù per un'ora produce 120 righe `failed`; Postgres giù per un'ora produce 120 slot `missing`. **Sono due buchi di natura diversa e la lettura li distingue**: va documentato, altrimenti qualcuno «aggiusterà» il caso mancante scrivendo zeri.

**Riavvio dell'applicazione a metà sessione.** All'avvio: nuovo `runId`, si ricaricano le sessioni aperte da `stats.session_open` (che è in Postgres proprio per questo, e non è `UNLOGGED`: verrebbe troncata al crash recovery, cioè nell'unico momento in cui serve), si ricarica il `Set` degli unici già scritti oggi, si alza `pendingGapCheck`. La riconciliazione avviene al **primo ciclo `ok`**, non all'avvio: solo lì sappiamo chi c'è ancora. Vedi §4.2 per la regola sull'`end_reason`.

### 3.5 Zero online contro «non ho raccolto»

Tre stati, tutti e tre distinti **strutturalmente** e tutti e tre visibili al browser:

| in `poll_cycle` | significato | serie |
|---|---|---|
| riga assente | il poller non stava girando (o Postgres era giù) | `null`, stato `missing` |
| `status IN ('failed','partial','skipped')` | il poller girava, il dato non c'è | `null`, stato `failed` |
| `status='ok'`, riga 0 con `players = 0` | la rete era **davvero** vuota | `0`, stato `ok` |
| `status='ok'`, nessuna riga per la modalità M | M aveva zero giocatori | `0` per M |

```sql
CREATE TABLE stats.poll_cycle (
  sampled_at      timestamptz NOT NULL,
  run_id          uuid        NOT NULL,     -- individua i riavvii
  status          stats.cycle_status NOT NULL,  -- ok|partial|failed|skipped
  delta_s         smallint,                 -- NULL se il ciclo non copre nulla
  duration_ms     integer,
  players         integer,                  -- cardinalita' deduplicata per player_id
  keys_seen       integer,                  -- chiavi restituite dallo SCAN
  keys_skipped    integer,                  -- pattern giusto, schema sbagliato
  dup_keys        integer,                  -- chiavi in piu' per lo stesso player_id
  scan_iterations integer,
  scan_truncated  boolean,
  dbsize          bigint,
  pttl_stats      jsonb,                    -- {p05,p50,p95,no_ttl,absent}
  servers_players integer,                  -- somma duels:servers:*.players, controincrocio
  skew_s          integer,                  -- mediana su chi e' appena entrato
  error_kind      text,
  CONSTRAINT poll_cycle_pk PRIMARY KEY (sampled_at)
) PARTITION BY RANGE (sampled_at);
```

`keys_seen - players` è il contatore permanente dei duplicati di chiave (rename, chiavi in scadenza): è la sonda che dice, dai dati e non da un'ipotesi, quanto il TTL sta gonfiando il conteggio istantaneo.

**Il buco non si interpola, mai.** Tre ragioni, in ordine di gravità:

1. Interpolare **cancella per sempre** l'informazione che il dato non c'era. È l'unica operazione irreversibile di tutta la catena.
2. I buchi non sono distribuiti a caso: il poller si ferma quando si fa un deploy (sera) o quando il Redis di gioco è sotto carico (picco). Un'interpolazione lineare fra le 20:00 e le 23:00 riempie le tre ore **più popolose** con la media dei loro estremi, e produce un calo che nessuno saprà spiegare.
3. Un `0` scritto al posto di un buco trasforma un guasto in un evento di business e falsa ogni media a valle, in modo permanente e plausibile.

Il contratto colonnare porta quindi `series: (number|null)[]` più `coverage: number[]` parallelo a `t` (la copertura è una proprietà del ciclo, non della modalità), più `coverageByHour[24]` e la copertura complessiva del periodo **e del periodo precedente**. Regole di disegno, vincolanti: mai una linea fra due punti separati da un `null`; bucket con `coverage < 0.5` tratteggiato; **confronto periodo-su-periodo marcato inaffidabile se le due coperture differiscono di più di 2 punti** — un confronto fra due periodi con coperture diverse è il modo garantito di produrre un delta falso.

Il pannello legge dalle **viste**, non dalle tabelle: `GRANT SELECT` a `metamc_stats` sulla vista e non su `sample_mode`, così la regola «assenza = zero solo dentro un ciclo ok» non è aggirabile per distrazione.

### 3.6 Osservabilità del poller

Contatori di cache e di build non vedono il poller. Servono, in `/internal/metrics`:

- `metamc_ingest_cycle_duration_ms` (ultimo, p95), `metamc_ingest_cycles_total{status=...}`;
- `metamc_ingest_lag_seconds` = età dell'ultimo ciclo `ok`. **È la metrica**: resta bassa solo se il poller sta davvero raccogliendo;
- `metamc_event_loop_delay_p99_ms` da `perf_hooks.monitorEventLoopDelay` — l'unica che collega il ciclo alla latenza dei login, e oggi non esiste;
- `metamc_ingest_dup_keys_total`, `metamc_ingest_keys_skipped_total`.

Allarmi: `lag > 5·D`, `duration_ms > 4000` per 10 cicli, `scan_truncated = true` (a questo `DBSIZE` non deve accadere mai: se accade, il keyspace è cambiato).

---

## 4. Sessioni e unici

### 4.1 Identità e apertura

**L'identità di una sessione è `(player_id, started_raw_ms)`**, dove `player_id` è il campo `identifier` (intero stabile del plugin) e `started_raw_ms` è `connection-time` **grezzo**. `connection-time` è l'unico dato esatto che abbiamo: è l'inizio vero della sessione, deciso dal server di gioco, stabile fra i campionamenti e non ricostruito da noi. Usarlo come chiave chiude da solo i due problemi difficili — il riavvio del poller a metà sessione e la riconnessione fra due campionamenti — senza logica di deduplica.

Lo **skew** dell'orologio di gioco si misura, si registra e si applica **una sola volta**, all'apertura:

```ts
function openSession(r: Light, h: Heavy, sampledAt: Date) {
  const startedMs = r.startedRawMs;
  const skewS = Math.round((startedMs - +sampledAt) / 1000);
  // Il clamp usa il PRIMO avvistamento, non il ciclo corrente, e il valore
  // calcolato qui non viene MAI ricalcolato: e' persistito e basta.
  const startedAt = skewS > 60 ? sampledAt : new Date(startedMs);
  open.set(r.playerId, {
    startedRawMs: startedMs, startedAt, firstSeenAt: sampledAt, lastSeenAt: sampledAt,
    observedS: 0, missed: 0, accountedThrough: startedAt, dirty: true,
    modeFirst: modeOf(r), modeLast: modeOf(r), legs: 1,
    country: h.country, platform: h.platform, protocol: h.protocol,
    skewS, lastPttlMs: r.pttlMs, ttlRefreshes: 0, lastFreshAt: sampledAt,
  });
}
```

`skew_s` si scrive in `poll_cycle` come **mediana sui soli giocatori entrati nell'ultimo intervallo** (`|conn/1000 − sampled_at| < 2·D`): calcolarla su tutte le sessioni aperte misurerebbe l'età mediana delle sessioni, non lo skew, e produrrebbe un numero enorme e negativo che nessuno saprebbe interpretare. Un NTP rotto sul server di gioco non produce un errore: produce quattro metriche sbagliate insieme (identità, durate, giorno di inizio, nuovi giocatori). Va allarmato: `|skew_s| > 5` per un'ora.

Due tabelle, calda e fredda:

- `stats.session_open` — PK `player_id`, una riga per giocatore online. È l'**unica** tabella HOT-update dello schema: `fillfactor = 70`, `autovacuum_vacuum_scale_factor = 0.02`. Non `UNLOGGED`.
- `stats.session` — append-only, PK `(started_at, player_id)`, partizionata per mese, `autovacuum_vacuum_insert_scale_factor = 0.02`, BRIN `minmax_multi` su `ended_at` con `pages_per_range = 32, autosummarize = on` (le righe entrano in ordine di **chiusura**, quindi `ended_at` è correlato con l'ordine fisico mentre `started_at` no: una sessione da 12 ore si chiude in mezzo a quelle da 2 minuti).

Il `last_seen_at` **non** si scrive a ogni ciclo: a 1.500 sessioni aperte e D=30 s sarebbero 4,3 milioni di nuove versioni di tupla al giorno su una tabella da 1.500 righe. Si flusha ogni **20 cicli (10 minuti)** e solo per le sessioni `dirty`, con un `UPDATE ... FROM unnest(...)` unico.

### 4.2 Chiusura

Un ciclo `ok` è l'unico che porta informazione negativa:

```ts
function onCycleOk(c: Extract<CycleResult, {kind:'ok'}>) {
  const { sampledAt, deltaS, live } = c;

  // RIAVVIO. Al primo ciclo ok dopo un boot NON sappiamo nulla di cio' che e'
  // successo durante il fermo: QUALUNQUE chiusura decisa in questo ciclo e' 'gap',
  // presenza o assenza che sia. Un giocatore che si e' disconnesso ed e' rientrato
  // durante il fermo e' PRESENTE con un connection-time diverso: chiuderlo come
  // 'quit' sarebbe un buco travestito da osservazione, e ogni deploy spingerebbe
  // in basso la durata media "onesta".
  const forcedReason: EndReason | null = pendingGapCheck ? 'gap' : null;
  if (pendingGapCheck) {
    for (const [pid, s] of open) if (!live.has(pid)) close(pid, s, s.lastSeenAt, 'gap');
  }

  for (const [pid, r] of live) {
    const s = open.get(pid);
    if (!s) { openLater.push(r); continue; }             // idratazione + INSERT
    if (s.startedRawMs !== r.startedRawMs) {             // riconnessione fra due cicli
      close(pid, s, s.lastSeenAt, forcedReason ?? 'quit');
      openLater.push(r);
      continue;
    }
    if (r.pttlMs > s.lastPttlMs) { s.ttlRefreshes++; s.lastFreshAt = sampledAt; }
    s.lastPttlMs = r.pttlMs;
    s.lastSeenAt = sampledAt;
    s.observedS += deltaS;                               // durata OSSERVATA, non stimata
    s.missed = 0; s.dirty = true;
    const m = modeOf(r);
    if (m !== s.modeLast) { s.modeLast = m; s.legs++; }
  }

  for (const [pid, s] of open) {
    if (live.has(pid)) continue;
    s.missed++;
    // La grazia NON gonfia la durata: la fine registrata resta last_seen_at.
    // Costa un ritardo nella chiusura e in cambio non spezza in due una sessione
    // durante un trasferimento fra server (duels_6 -> lobby_1).
    if (s.missed >= GRACE_TICKS) close(pid, s, s.lastSeenAt, forcedReason ?? 'quit');
  }
  pendingGapCheck = false;
  lastOkAt = sampledAt;
}
```

**`ended_at` è sempre l'ultimo istante per cui abbiamo prova, mai `now()`.** `now()` gonfierebbe sistematicamente ogni durata di `D · GRACE_TICKS` e, dopo un'interruzione, di ore.

Ogni sessione porta **due durate**: quella di parete (`ended_at − started_at`) e quella osservata (`observed_s`, somma dei `delta_s` dei cicli in cui è stata vista — non `cicli × D`, che sarebbe sbagliato appena la cadenza cambia). La differenza fra le due **è** la misura dell'incertezza, riga per riga, e nessuna delle due mente.

`end_reason` ∈ `{'quit','gap','reaper','skew'}`. La vista di lettura delle durate esclude di default `gap` e `reaper`: una query di durata media che non le filtra restituisce un numero sbagliato.

**Il TTL e la fine reale.** La chiave sopravvive fino a ~100 s dopo l'uscita, quindi `ended_at = last_seen_at` sovrastima di 0-100 s (≈50 s in media) e il conteggio istantaneo include chi è uscito da meno di un TTL. Non si applica un filtro euristico: si persistono `last_fresh_at` (ultimo ciclo in cui il `PTTL` è **risalito**, cioè l'ultimo rinnovo osservato dal plugin) e `ttl_refreshes`. La sonda del giorno uno risponde a una sola domanda — *con quale cadenza il plugin rinnova?* — leggendo `pttl_stats` da `poll_cycle` per due settimane. Finché non ha risposto, `ended_at = last_seen_at` e la durata è dichiarata in UI come **limite superiore**; quando ha risposto, la correzione `ended_at = last_fresh_at` è ricalcolabile su tutto lo storico con un `UPDATE`, **perché entrambi gli istanti sono stati salvati dal giorno uno**.

**Reaper**, job separato ogni 60 s, rete di sicurezza per ciò che la mappa in memoria ha perso:

```sql
WITH stale AS (
  DELETE FROM stats.session_open
   WHERE last_seen_at < now() - interval '15 minutes'
  RETURNING *
)
INSERT INTO stats.session (started_at, player_id, ended_at, mode_id_first, mode_id_last,
                           legs, country, platform, protocol, observed_s, end_reason,
                           accounted_through)
SELECT started_at, player_id, last_seen_at, mode_id_first, mode_id_last, legs,
       country, platform, protocol, observed_s, 'reaper', accounted_through
FROM stale
ON CONFLICT (started_at, player_id) DO UPDATE
  SET ended_at   = GREATEST(stats.session.ended_at, EXCLUDED.ended_at),
      observed_s = GREATEST(stats.session.observed_s, EXCLUDED.observed_s),
      end_reason = EXCLUDED.end_reason
  WHERE EXCLUDED.ended_at > stats.session.ended_at;
```

`DO UPDATE ... WHERE` e non `DO NOTHING`: sotto una fase degradata lunga (Redis lento per venti minuti, cicli `partial`) il reaper chiude la sessione, poi il giocatore riappare con lo **stesso** `connection-time` e la chiusura finale colpirebbe il gate di idempotenza — la seconda metà della sessione sparirebbe senza traccia, proprio quando i numeri contano di più. Con l'upsert la riadozione riapre la stessa riga e la estende.

I secondi giornalieri non si riversano dalla chiusura in blocco ma **dal delta**, grazie a `accounted_through`: la scrittura versa da `accounted_through` a `ended_at` e aggiorna il segnalibro. Idempotente anche se la chiusura viene ritentata, e corretta anche se la sessione viene riaperta.

### 4.3 Unici giornalieri e confine Europe/Rome

Unici **esatti**, mai HyperLogLog. Due tabelle:

- `stats.player_day (day date, player_id integer, first_seen_at, last_seen_at, seconds_online, sessions, country)`, PK `(day, player_id)` — gli unici di **rete** sono `count(*)`;
- `stats.player_day_mode (day, mode_id, player_id, seconds_online, sessions)`, PK `(day, mode_id, player_id)` — gli unici **per modalità**.

Chiave su `player_id` intero e non su uuid: riga 36 B contro 52, voce di indice 20 B contro 36 (fattore 1,57× sulla tabella, 1,8× sull'indice), e l'intero è la chiave con cui si arriva a tutto il resto. L'uuid resta una volta sola, sull'anagrafica, con un indice unico parziale che rende la collisione «stesso identifier, uuid diverso» una query e non una sorpresa.

**Gli unici di rete non sono la somma degli unici per modalità**: chi ha giocato a duels e bedwars conta una volta sulla rete e due nella somma. Con due tabelle distinte il problema non può nemmeno porsi, ed è un invariante verificato (§5.7).

**La riga si scrive alla prima osservazione del giorno, non alla chiusura della sessione.** Così l'unico è esatto anche per chi la sessione non la chiude mai, e non dipende dal reaper. I secondi arrivano dopo, dalle chiusure. `ON CONFLICT DO NOTHING` a ogni ciclo su ogni giocatore sarebbero 4,3 M di upsert al giorno che nel 99,8% dei casi non fanno niente: si evita con un `Set` in memoria.

**Il `Set` non ha nessun timer di mezzanotte.** Il giorno si deriva *sempre* dal timestamp del ciclo; le chiavi di ieri si potano per costruzione a fine ciclo. Un timer, o peggio la data locale del processo (i container girano con `TZ=UTC`, cioè mezzanotte UTC = 01:00 o 02:00 a Roma), farebbe perdere sistematicamente la coda notturna di ogni giorno: un errore stabile del 2-5%, quindi invisibile nel confronto mese su mese, e sbagliato per sempre.

```ts
const romeDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
});
const dayOf = (t: Date) => romeDay.format(t);      // 'YYYY-MM-DD'

function markUniques(sampledAt: Date, live: Map<number, Light>) {
  const day = dayOf(sampledAt);
  let seen = dayUniques.get(day);
  if (!seen) { seen = new Set(); dayUniques.set(day, seen); }
  for (const k of dayUniques.keys()) if (k !== day) dayUniques.delete(k); // potatura
  const fresh: number[] = [];
  for (const pid of live.keys()) if (!seen.has(pid)) { seen.add(pid); fresh.push(pid); }
  return { day, fresh };
}
```

Al riavvio il `Set` si ricarica con **una** query (`SELECT player_id FROM stats.player_day WHERE day = $1`), altrimenti dopo ogni restart si ricomincia a martellare il database fino a mezzanotte.

**Sessioni a cavallo della mezzanotte**: i **secondi** si affettano sui due giorni, le **sessioni** si contano una volta sola sul giorno in cui iniziano. Fortuna di progetto: la mezzanotte a Roma non è mai un'ora ambigua (il cambio è alle 02:00/03:00), quindi `(g::timestamp AT TIME ZONE 'Europe/Rome')` è sempre univoco e l'affettatura è sicura anche nei giorni di DST. Vale per Roma, non in generale.

```sql
-- Versamento dei secondi: dal segnalibro alla fine, mai dall'inizio.
WITH s AS (
  SELECT $1::int AS player_id, $2::timestamptz AS from_at, $3::timestamptz AS to_at,
         $4::smallint AS mode_id, $5::char(2) AS country,
         ($2::timestamptz = $6::timestamptz) AS is_start   -- from_at = started_at
), slices AS (
  SELECT s.*, g::date AS day,
         GREATEST(s.from_at, ( g     ::timestamp AT TIME ZONE 'Europe/Rome')) AS lo,
         LEAST   (s.to_at,   ((g + 1)::timestamp AT TIME ZONE 'Europe/Rome')) AS hi,
         (g::date = (s.from_at AT TIME ZONE 'Europe/Rome')::date AND s.is_start) AS counts_session
  FROM s, generate_series((s.from_at AT TIME ZONE 'Europe/Rome')::date,
                          (s.to_at   AT TIME ZONE 'Europe/Rome')::date, interval '1 day') g
), pd AS (
  INSERT INTO stats.player_day AS t (day, player_id, first_seen_at, last_seen_at,
                                     seconds_online, sessions, country)
  SELECT day, player_id, lo, hi, GREATEST(0, extract(epoch FROM (hi-lo)))::int,
         counts_session::int, country FROM slices
  ON CONFLICT (day, player_id) DO UPDATE SET
    first_seen_at  = LEAST(t.first_seen_at, EXCLUDED.first_seen_at),
    last_seen_at   = GREATEST(t.last_seen_at, EXCLUDED.last_seen_at),
    seconds_online = t.seconds_online + EXCLUDED.seconds_online,
    sessions       = t.sessions + EXCLUDED.sessions,
    country        = COALESCE(t.country, EXCLUDED.country)
  RETURNING 1
)
INSERT INTO stats.player_day_mode AS t (day, mode_id, player_id, seconds_online, sessions)
SELECT day, mode_id, player_id, GREATEST(0, extract(epoch FROM (hi-lo)))::int,
       counts_session::int FROM slices
ON CONFLICT (day, mode_id, player_id) DO UPDATE SET
  seconds_online = t.seconds_online + EXCLUDED.seconds_online,
  sessions       = t.sessions + EXCLUDED.sessions;
```

I secondi vanno a `mode_id_last`, e questo è il suo limite dichiarato: un giocatore che fa tre ore di bedwars e quattro minuti di duels prima di uscire attribuisce tutto a duels. **Per questo `player_day_mode.seconds_online` non è la fonte di «minuti giocati per modalità»**: quella domanda si risponde con `sum(players · delta_s)` sui campioni, che è esatta. La colonna serve solo come componente delle durate per giocatore, e va etichettata così ovunque compaia; se un giorno servisse la ripartizione esatta si aggiunge `stats.session_leg` con una migration additiva, non prima.

Le sessioni aperte versano ogni 10 minuti (dal segnalibro a `last_seen_at`), così un crash costa al massimo dieci minuti di secondi — che è esattamente ciò che `end_reason` dichiara come approssimato.

### 4.4 Nuovi giocatori da `registrationDate`

**«Nuovi della rete» è esatto dal primo giorno e non richiede storico maturo.** La registrazione avviene al join: chi si registra oggi è online oggi, quindi entra nel campione e finisce nell'anagrafica. Il conteggio è

```sql
SELECT count(*) FROM stats.player
 WHERE (registered_at AT TIME ZONE 'Europe/Rome')::date = $1::date;
```

e non è una stima che matura con il tempo. Va scritto nel documento perché è l'unica metrica di questo tipo: «nuovi della modalità», che sarebbe left-censored, **resta fuori dalla fase 2** — servirla senza dichiararla produrrebbe un grafico che decresce per un mese e poi si assesta, e qualcuno lo leggerebbe come un calo reale.

`registrationDate` arriva come `2024-07-20 09:46:17.0`: è la forma di `java.sql.Timestamp.toString()`, senza offset, cioè l'ora locale della JVM che l'ha scritta. **L'offset si misura, gratis, il giorno uno**, e non va chiesto a nessuno:

```ts
// Sonda: su ogni giocatore appena entrato, se registrationDate e' a meno di 2
// minuti da connection-time (che e' epoch ms, NON ambiguo), lo scarto fra i due
// interpretati in UTC E' l'offset della JVM del server di gioco.
function probeRegTz(h: Heavy, connMs: number): number | null {
  const asUtc = Date.parse(h.registrationDate!.replace(' ', 'T').replace(/\.\d+$/, 'Z'));
  if (!Number.isFinite(asUtc)) return null;
  const deltaMin = Math.round((asUtc - connMs) / 60_000);
  if (Math.abs(deltaMin) > 26 * 60) return null;   // non e' una registrazione fresca
  return -deltaMin;                                 // minuti da aggiungere per ottenere UTC
}
```

Si accumulano i campioni, si prende la **mediana su almeno 30 osservazioni**, si scrive in `stats.ingest_state.reg_tz_offset_min` e da quel momento `registered_at` si popola. **Finché l'offset è `NULL`, `registered_at` resta `NULL` e il widget «nuovi» non si mostra**: meglio assente che sbagliato di due ore sul confine del giorno, che su un'utenza giovane colpisce una fascia oraria tutt'altro che marginale. `registered_raw` si conserva comunque come `text`, così la correzione retroattiva è un solo `UPDATE`.

L'anagrafica `stats.player` si riscrive **solo quando cambia qualcosa**: `attrs_digest bytea` = sha256 dei soli campi mutabili memorizzati, confrontato in memoria dall'ingest. Le scritture scendono a prime apparizioni + rename + cambi di piattaforma: qualche decina al giorno invece di P per ciclo. **Una colonna mutabile aggiunta e dimenticata nel digest resta congelata per sempre**: va annotato sulla funzione che lo calcola. `last_seen_at` si aggiorna alla chiusura della sessione, non a ogni tick. I rename vanno in `stats.player_name` con PK `(player_id, valid_from)` e non `(player_id, username)`, perché i rename tornano indietro (A → B → A) e il nome come chiave perderebbe il primo periodo.

---

## 5. Catena di rollup

### 5.1 I livelli

```
stats.sample_mode  (tick, mode_id)   grezzo, D=30 s   retention  30 giorni  (partizioni GIORNALIERE)
        │
        ├─► stats.rollup_5m  (bucket 300 s)           retention 400 giorni  (partizioni MENSILI)
        │        │
        │        └─► stats.rollup_1h (bucket 3600 s)  per sempre, NON partizionata (504 righe/g)
        │                   │
        │                   └─► stats.rollup_1d (giorno civile Roma)  per sempre, NON partizionata
```

Mappatura range → livello, con i punti tenuti fra 168 e 365 (un grafico è largo ~1000 px: più punti che pixel sono byte buttati):

| range | fonte | righe lette | punti resi |
|---|---|---|---|
| 24h | `rollup_5m` | 288 × (M+1) | 288 |
| 7g | `rollup_1h` | 168 × (M+1) | 168 |
| 30g | `rollup_1h` | 720 × (M+1) | 360 (2 righe/punto) |
| 90g | `rollup_1h` | 2.160 × (M+1) | 360 (6 righe/punto) |
| 1y | `rollup_1d` | 365 × (M+1) | 365 |

**Il grano grezzo è `(tick, modalità)`, non `(tick, giocatore)`.** 2.880 tick/giorno × ~21 righe = 60.480 righe/giorno, ~2,9 MB: il costo del grafico dell'online è **indipendente dal numero di giocatori**, uguale con 100 o con 100.000 online. Nessun widget del design approvato ha bisogno di sapere dove fosse il giocatore X al tick T; presenza, breakdown, heatmap e picco escono dai conteggi per modalità, unici e durate dalle sessioni.

Nessun livello a 1 minuto: con D=30 s dimezzerebbe soltanto le righe e non paga la propria complessità.

### 5.2 Solo misure additive intere

Ogni livello conserva **esclusivamente** interi additivi:

```sql
CREATE TABLE stats.rollup_5m (
  bucket         timestamptz NOT NULL,
  mode_id        smallint    NOT NULL REFERENCES stats.mode(mode_id),
  samples        integer     NOT NULL,   -- cicli ok del bucket con questa modalita'
  covered_s      integer     NOT NULL,   -- secondi coperti DAL BUCKET (v. 5.3)
  player_seconds bigint      NOT NULL,   -- sum(players * delta_s)
  players_max    integer     NOT NULL,
  players_min    integer     NOT NULL,
  players_max_at timestamptz NOT NULL,
  PRIMARY KEY (bucket, mode_id)
) PARTITION BY RANGE (bucket);
ALTER TABLE stats.rollup_5m SET (autovacuum_vacuum_insert_scale_factor = 0.02);
```

**Nessuna colonna `avg real`.** Sono associative, quindi il rollup gerarchico 5m → 1h → 1d è **esatto e non approssimato**, la profondità di una ricostruzione non è limitata dalla retention del grezzo (30 giorni) ma da quella del 5m (400), e non c'è modo di ottenere due numeri leggermente diversi per la stessa media su due schermate. `sum(real)` in PostgreSQL accumula in `float4`: sommare 8.760 valori per il range annuale perde cifre visibili a occhio. La media si calcola **in lettura**, in `float8`:

```sql
(player_seconds::float8 / NULLIF(covered_s, 0))
```

`players_max` viaggia **sempre** con `players_max_at`, la copertura del bucket in cui è avvenuto e la cadenza usata. In UI il record è «almeno N», e due periodi con cadenze diverse **non sono confrontabili sul massimo**, solo sulla media — che è robusta. Se il downsampling tenesse solo la media, il «record di giocatori contemporanei» evaporerebbe; se il massimo viaggiasse da solo, mentirebbe dopo ogni buco.

**La linea del grafico è la MEDIA a tutti i livelli di zoom.** Il massimo si spedisce come seconda serie e si disegna come banda, mai come la linea: se la linea fosse il massimo del bucket, lo stesso istante mostrerebbe 1.240 nel range 24h, 1.310 nel 30g e 1.480 nell'1y, e l'utente lo scoprirebbe da solo. Il KPI «media» si calcola dagli **stessi** bucket della serie visualizzata, non con una query separata.

### 5.3 Il denominatore, che è il punto in cui quasi tutti sbagliano

**Il denominatore di una media non può mai provenire dalle stesse righe del numeratore.** La convenzione sparsa (nessuna riga = zero) è giusta per lo spazio ed è una trappola per le medie: le righe di una modalità esistono solo per i tick in cui aveva giocatori, quindi `sum(player_seconds)/sum(delta_s)` **sulle sue righe** divide per il tempo in cui la modalità era aperta, non per il tempo del bucket.

Scenario concreto: `evento_1` apre cinque minuti al giorno con 200 giocatori. Media oraria riportata: 200. Media giornaliera riportata: 200. `duels`, aperta 24 ore con 150 giocatori medi, riporta 150. Il breakdown mostra l'evento come la modalità più popolare della rete, e il confronto mese su mese di quella modalità misura la cardinalità delle aperture. Il numero è perfettamente plausibile e completamente falso.

**Regola, senza eccezioni: `covered_s` viene da `poll_cycle` ed è identico per tutte le modalità dello stesso bucket.** È denormalizzato (4 byte per riga) perché così la somma gerarchica resta esatta senza join, e la media di una modalità aperta 5 minuti su 60 esce a 16,7 e non a 200.

```sql
-- ============================================================
-- ROLLUP 5m. Ogni 60 s. Il FOR UPDATE sulla riga di stato E' il lock del job:
-- con una sola istanza applicativa un advisory lock difenderebbe da una
-- concorrenza che per costruzione non esiste.
-- ============================================================
WITH w AS (
  SELECT watermark AS lo,
         LEAST(date_bin('5 minutes', now(), 'epoch'::timestamptz),
               watermark + interval '1 day') AS hi   -- CATCH-UP LIMITATO: max 288 bucket
    FROM stats.rollup_state WHERE level = '5m' FOR UPDATE
),
-- Il denominatore. Viene dal REGISTRO DEI CICLI, non dai campioni.
cov AS (
  SELECT date_bin('5 minutes', c.sampled_at, 'epoch'::timestamptz) AS bucket,
         sum(c.delta_s)::int AS covered_s,
         count(*)::int       AS samples
    FROM stats.poll_cycle c, w
   WHERE c.sampled_at >= w.lo - interval '5 minutes'   -- lookback di 2 bucket
     AND c.sampled_at <  w.hi
     AND c.status = 'ok'
   GROUP BY 1
),
num AS (
  SELECT date_bin('5 minutes', s.sampled_at, 'epoch'::timestamptz) AS bucket, s.mode_id,
         sum(s.players::bigint * s.delta_s) AS player_seconds,
         max(s.players)                     AS players_max,
         min(s.players)                     AS players_min,
         (array_agg(s.sampled_at ORDER BY s.players DESC, s.sampled_at))[1] AS players_max_at
    FROM stats.sample_mode s
    JOIN stats.poll_cycle c ON c.sampled_at = s.sampled_at AND c.status = 'ok'
       , w
   WHERE s.sampled_at >= w.lo - interval '5 minutes' AND s.sampled_at < w.hi
   GROUP BY 1, 2
), ins AS (
  INSERT INTO stats.rollup_5m AS r
    (bucket, mode_id, samples, covered_s, player_seconds, players_max, players_min, players_max_at)
  SELECT n.bucket, n.mode_id, cov.samples, cov.covered_s,
         n.player_seconds, n.players_max, n.players_min, n.players_max_at
    FROM num n JOIN cov USING (bucket)
  ON CONFLICT (bucket, mode_id) DO UPDATE SET      -- upsert TOTALE = idempotente
    samples = EXCLUDED.samples, covered_s = EXCLUDED.covered_s,
    player_seconds = EXCLUDED.player_seconds,
    players_max = EXCLUDED.players_max, players_min = EXCLUDED.players_min,
    players_max_at = EXCLUDED.players_max_at
  RETURNING 1
)
UPDATE stats.rollup_state
   SET watermark = (SELECT hi FROM w), rows_written = (SELECT count(*) FROM ins),
       caught_up = (SELECT hi >= date_bin('5 minutes', now(), 'epoch'::timestamptz) FROM w),
       updated_at = now()
 WHERE level = '5m';
```

I livelli superiori sono somme pure, senza toccare più il grezzo (che vive 30 giorni; il 5m ne vive 400):

```sql
-- 1h da 5m, ogni 5 minuti. Catch-up limitato a 24 bucket per giro.
INSERT INTO stats.rollup_1h AS r (bucket, mode_id, samples, covered_s, player_seconds,
                                  players_max, players_min, players_max_at)
SELECT date_bin('1 hour', b.bucket, 'epoch'::timestamptz), b.mode_id,
       sum(b.samples)::int, sum(b.covered_s)::int, sum(b.player_seconds),
       max(b.players_max), min(b.players_min),
       (array_agg(b.players_max_at ORDER BY b.players_max DESC, b.bucket))[1]
  FROM stats.rollup_5m b, w
 WHERE b.bucket >= w.lo - interval '1 hour' AND b.bucket < w.hi
 GROUP BY 1, 2
ON CONFLICT (bucket, mode_id) DO UPDATE SET /* tutte le colonne */ ;
```

`covered_s` sommato a livello orario **resta il denominatore giusto** perché era già uniforme per bucket: la somma su 12 bucket da 5 minuti dà i secondi coperti dell'ora, uguali per tutte le modalità.

### 5.4 Incrementalità, chi lancia i job, catch-up

`stats.rollup_state (level text PK, watermark timestamptz, rows_written int, caught_up boolean, updated_at)` con livelli `'5m','1h','1d','daily_close'`.

Quattro proprietà, tutte necessarie:

1. **`FOR UPDATE` sulla riga di livello nella stessa transazione che scrive.** È il lock del job. Niente `pg_try_advisory_lock`.
2. **Lookback di 2 bucket** per assorbire i tick arrivati in ritardo (il buffer del poller, §3.4) senza ricalcolare storico.
3. **Upsert totale su tutte le colonne**: rieseguire un giro non produce mai un doppio conteggio.
4. **Catch-up limitato**, che è la correzione a un guasto reale: senza, il primo giro dopo un fermo di trenta giorni aggrega ~1,8 M righe in un solo statement, viene ucciso dallo `statement_timeout`, ritentato ogni 15 s, e **il watermark non avanza mai**. Stallo permanente, grafici vuoti, e un log che dice solo «rollup fallito». Ogni giro avanza al massimo di un giorno e restituisce `caught_up: false` finché è indietro; il job riparte subito invece di aspettare l'intervallo. Il watermark si semina a `now()`, **mai a epoch 0**.

**Chi li lancia.** `JobDefinition` in `src/jobs/keeper.ts`, accanto agli altri: nessun `pg_cron`, nessun cron esterno, coerente con «una sola istanza applicativa, i job li tiene l'applicazione». Il prezzo è dichiarato: a processo fermo non girano, e al riavvio la prima cosa che ognuno fa è recuperare.

| job | intervallo | retry | pool |
|---|---|---|---|
| `stats_ingest` | 30 s | 5 s | `ingestPool` (max 2, timeout 5 s) |
| `stats_session_reaper` | 60 s | 15 s | `ingestPool` |
| `stats_rollup_5m` | 60 s | 15 s | `rollupPool` (max 2, timeout 60 s) |
| `stats_rollup_1h` | 300 s | 60 s | `rollupPool` |
| `stats_rollup_1d` | 900 s | 120 s | `rollupPool` |
| `stats_daily_close` | 900 s, agisce solo dopo la mezzanotte locale | 300 s | `rollupPool` |
| `stats_partitions` | 6 h | 600 s | `rollupPool` |
| `stats_invariants` | 24 h | 1 h | `statsPool` (sola lettura) |

Il rollup **non** condivide il pool del poller: `max: 2` con un giro lungo in corso significa che il ciclo di campionamento aspetta la sua connessione.

`stats_daily_close` scrive le colonne **non associative** di `rollup_1d` — `uniques`, `new_network`, `sessions`, `session_seconds` — che non possono venire dal livello sotto, e alza `final = true` sul giorno chiuso:

```sql
UPDATE stats.rollup_1d d SET
  uniques     = COALESCE(u.n, 0),
  new_network = COALESCE(nn.n, 0),
  sessions    = COALESCE(ps.sessions, 0),
  session_seconds = COALESCE(ps.secs, 0),
  final = true, rebuilt_at = now()
FROM (SELECT $1::date AS day) k
LEFT JOIN LATERAL (SELECT count(*) n FROM stats.player_day WHERE day = k.day) u ON true
LEFT JOIN LATERAL (SELECT count(*) n FROM stats.player
                    WHERE (registered_at AT TIME ZONE 'Europe/Rome')::date = k.day) nn ON true
LEFT JOIN LATERAL (SELECT sum(sessions) sessions, sum(seconds_online) secs
                     FROM stats.player_day WHERE day = k.day) ps ON true
WHERE d.day = k.day AND d.mode_id = 0;
-- Per mode_id > 0 la stessa forma su player_day_mode. `uniques` della riga 0 ha
-- un COUNT proprio: NON e' la somma delle modalita'.
```

`ON CONFLICT DO UPDATE` e non `DO NOTHING`: se il processo era fermo a mezzanotte, il primo tentativo può aver scritto un conteggio parziale e deve poterlo correggere.

### 5.5 Dati tardivi, buchi, ricalcolo

Il lookback di 2 bucket copre i ritardi ordinari. Oltre, servono tre cose, tutte esistenti dal giorno uno:

1. **`stats.rebuild(level, from, to)`** — idempotente, per **ogni** livello e non solo per l'orario: riporta il watermark a `from` e lascia che il catch-up limitato risalga. Chiamabile a mano e da runbook.
2. **Riconciliazione giornaliera livello-contro-livello**, che scrive il numero di righe divergenti e allarma se `> 0`:

```sql
-- 1h ricalcolato dal grezzo contro 1h memorizzato, sui giorni ancora coperti.
SELECT count(*) AS divergenti FROM stats.rollup_1h h
JOIN (SELECT date_bin('1 hour', s.sampled_at, 'epoch'::timestamptz) AS bucket, s.mode_id,
             sum(s.players::bigint * s.delta_s) AS ps
        FROM stats.sample_mode s JOIN stats.poll_cycle c
          ON c.sampled_at = s.sampled_at AND c.status = 'ok'
       WHERE s.sampled_at >= now() - interval '7 days' GROUP BY 1,2) g USING (bucket, mode_id)
WHERE h.player_seconds IS DISTINCT FROM g.ps;
```

3. **`final boolean` + `rebuilt_at timestamptz`** su `rollup_1d`. Un giorno dichiarato finale non si riscrive; se una `rebuild` lo tocca, `rebuilt_at` cambia e resta la traccia. **Un numero che il committente ha già letto e annotato non può cambiare in silenzio.**

Un errore scoperto oltre la retention del grezzo non è più correggibile su quei giorni. **La retention non è una domanda su quanti GB si tengono: è la domanda «per quanti giorni indietro potremo ancora correggere un numero sbagliato».** Va posta al committente in questi termini, perché la risposta cambia. Il default è 30 giorni per `sample_mode`; `stats.partitioned_table` la rende una `UPDATE` su una riga, non una migration.

Una ri-elaborazione completa dello storico è **manutenzione**, non un job periodico: sposta fisicamente le tuple e degrada la correlazione su cui vive il BRIN di `session`. Va seguita da `brin_summarize_new_values`.

### 5.6 Il DST, e la heatmap che resta onesta

Il fuso morde in **esattamente tre punti**: il confine di giorno, le etichette `dow`/`hour` della heatmap, i bordi del range. Tutto il resto è UTC e va lasciato in pace — gli offset di Europe/Rome sono ore intere (+01/+02), quindi **un bucket allineato a 5 minuti o a 1 ora in UTC è già allineato all'ora locale**. Ri-bucketizzare i dati orari «per il fuso» è lavoro che non produce alcuna differenza, ed è l'errore che fa perdere più tempo.

Regole vincolanti:

- **Mai `date_bin` per il livello giornaliero**: ha un'origine assoluta e produce giorni UTC. Il giorno di Roma è `(bucket AT TIME ZONE 'Europe/Rome')::date`. Usarlo per il giorno fa scivolare ogni bucket di 1-2 ore e rende la heatmap sbagliata in modo credibile, cioè nel modo peggiore. `date_bin` va bene, ed è corretto, per 5m e 1h.
- **La lunghezza del giorno non è 86400.** Due giorni all'anno vale 82.800 e 90.000. `expected_s` si calcola:

```sql
extract(epoch FROM (((d + 1)::timestamp AT TIME ZONE 'Europe/Rome')
                  - ( d      ::timestamp AT TIME ZONE 'Europe/Rome')))::int
```

Con una costante, la copertura di quei due giorni risulta del 104% e del 96%, e qualcuno perderà un pomeriggio a cercare il bug nell'ingest.
- **Confronti di periodo su `date`**, mai `- interval '30 days'` su un `timestamptz`: nei periodi che attraversano un cambio ora le due cose differiscono di un'ora e il confronto scivola di un bucket. E il **giorno in corso si esclude da entrambi i lati** — il periodo corrente contiene un giorno parziale e il precedente no, quindi ogni somma sarebbe sistematicamente più bassa nel corrente, ogni giorno, per costruzione. Il giorno vivo viaggia a parte con `liveTail: true`.
- **Round-trip `AT TIME ZONE` vietato.** Convertire a locale e tornare indietro sull'ora ripetuta sceglie arbitrariamente uno dei due offset. Si tiene UTC ovunque e si converte **solo per etichettare**, mai per calcolare e mai due volte.

**La heatmap 7×24 spedisce tre array, mai la media già divisa.** Nei giorni di cambio ora una cella locale ha **0 occorrenze** (l'ora saltata di marzo) o **2** (l'ora ripetuta di ottobre). Con la sola media quella cella mente e nessuno può accorgersene guardandola — ed è l'unica cella che qualcuno controllerà a mano.

```sql
-- $1 = from, $2 = to, $3 = mode_id (0 = rete). Sorgente: rollup_1h.
SELECT (extract(isodow FROM bucket AT TIME ZONE 'Europe/Rome')::int - 1) * 24
         + extract(hour FROM bucket AT TIME ZONE 'Europe/Rome')::int AS cell,
       sum(player_seconds)::bigint AS v,   -- numeratore
       sum(covered_s)::bigint      AS w,   -- denominatore: media = v/w
       count(*)::int               AS n,   -- occorrenze REALI della cella (0 o 2 al DST)
       max(players_max)            AS peak
  FROM stats.rollup_1h
 WHERE bucket >= $1 AND bucket < $2 AND mode_id = $3
 GROUP BY cell ORDER BY cell;
```

Perché è onesta senza casi speciali: l'ora ripetuta produce **due** bucket UTC che ricadono sulla stessa etichetta locale e i loro numeratori e denominatori si sommano correttamente; l'ora saltata non produce nessun bucket e la cella esce con `n = 0` e `w = 0`, che la UI **grigia** invece di disegnare uno zero. Regole di disegno: `n = 0` → cella grigia con tooltip «ora inesistente per il cambio d'ora»; `w < 50%` del nominale (`n · 3600`) → tratteggiata. **Diventa un bug nel momento esatto in cui qualcuno scrive `sum(...) / 7` o `avg(avg)` da qualche parte**: entrambi vanno vietati in code review.

Il payload non spedisce mai `v/w` già diviso: spedisce `v`, `w`, `n` e il client divide.

### 5.7 Invarianti verificati in continuo

Tutti i difetti di questa classe falliscono in silenzio e in modo plausibile: nessuno solleva un'eccezione, nessuno rompe un grafico. `stats_invariants` gira una volta al giorno, in un secondo, e scrive in `stats.invariant_check (checked_at, name, offenders)`; `offenders > 0` allarma.

```sql
-- 1. Il totale di rete e' la somma del breakdown piu' i transiti. Tolleranza 0.
SELECT count(*) FROM (
  SELECT sampled_at, max(players) FILTER (WHERE mode_id = 0) AS net,
         sum(players) FILTER (WHERE mode_id > 0)             AS parts
    FROM stats.sample_mode WHERE sampled_at >= now() - interval '1 day'
   GROUP BY 1) t WHERE net <> parts;

-- 2. Unici di rete fra il massimo e la somma degli unici per modalita'.
SELECT count(*) FROM (
  SELECT d.day, d.uniques AS net,
         max(m.uniques) AS mx, sum(m.uniques) AS sm
    FROM stats.rollup_1d d JOIN stats.rollup_1d m ON m.day = d.day AND m.mode_id > 0
   WHERE d.mode_id = 0 AND d.day >= current_date - 30 GROUP BY 1, 2) t
 WHERE net < mx OR net > sm;

-- 3. Il massimo giornaliero e' il massimo dei massimi orari.
SELECT count(*) FROM stats.rollup_1d d
  JOIN (SELECT (bucket AT TIME ZONE 'Europe/Rome')::date AS day, mode_id,
               max(players_max) AS mx FROM stats.rollup_1h
         WHERE bucket >= now() - interval '30 days' GROUP BY 1,2) h USING (day, mode_id)
 WHERE d.players_max <> h.mx;

-- 4. covered_s uniforme fra le modalita' dello stesso bucket (il denominatore).
SELECT count(*) FROM (SELECT bucket, count(DISTINCT covered_s) c
                        FROM stats.rollup_5m WHERE bucket >= now() - interval '2 days'
                       GROUP BY 1) t WHERE c > 1;

-- 5. Cicli mai tentati nelle ultime 24 ore (quanti buchi 'missing').
SELECT count(*) FROM generate_series(now() - interval '24 hours', now(), interval '30 seconds') g(s)
  LEFT JOIN stats.poll_cycle c ON c.sampled_at BETWEEN g.s - interval '20 s' AND g.s + interval '20 s'
 WHERE c.sampled_at IS NULL;

-- 6. Nessuno zero scritto per una modalita' (la convenzione sparsa e' intatta).
SELECT count(*) FROM stats.sample_mode
 WHERE mode_id > 0 AND players = 0 AND sampled_at >= now() - interval '7 days';
```

A questi si aggiungono due prove da eseguire su dati **sintetici** prima della messa in produzione, perché sono gli scenari in cui i difetti si manifestano tutti insieme: (a) un giorno con un buco di tre ore in prime time — la media di periodo deve reggere e la copertura oraria deve mostrarlo; (b) i due giorni di cambio ora — heatmap, unici e `expected_s` devono uscire corretti **senza casi speciali**; (c) una sequenza con rename, riconnessione e trasferimento fra server nello stesso ciclo — i conteggi non devono raddoppiare e le sessioni non devono spezzarsi.

---

## 6. Endpoint e payload

### 6.1 Presupposti sullo schema che questa sezione dà per acquisiti

Il livello di lettura legge **una sola** catena. Le altre due varianti prodotte in progettazione sono cancellate.

| Oggetto | Forma unica |
|---|---|
| Grezzo | `stats.sample_mode(sampled_at timestamptz, mode_id smallint, delta_s smallint, players integer, servers smallint)`, PK `(sampled_at, mode_id)`, partizionata per giorno |
| Cadenza | T = 30 s misurata e scritta riga per riga in `delta_s`. Nessuna costante di cadenza in nessuna query |
| Rollup | `rollup_5m` → `rollup_1h` → `rollup_1d`, gerarchici, con sole misure **additive intere**: `player_seconds bigint`, `covered_s integer`, `samples integer`, `players_max integer` |
| Modalità riservate | `0 = __network__` (identità distinte osservate nel tick), `1 = __unknown__` (prefisso non risolto), `2 = __transit__` (campo `server` vuoto) |
| Identità giocatore | `player_id = identifier` (intero del plugin). Una sola definizione per campioni, sessioni e unici: **si conta l'identità, mai la chiave Redis** |
| Unici | `stats.player_day(day, player_id)` esatti, `stats.player_day_mode(day, mode_id, player_id)`, chiusura giornaliera in `stats.daily_unique_count(day, mode_id, uniques, final)` |

Due vincoli sono contratto duro fra ingestione e lettura, e sono la ragione per cui i numeri tornano:

1. **Il denominatore di una media non viene mai dalle righe della modalità.** `covered_s` e `samples` di ogni riga di rollup sono quelli del **bucket**, copiati dalla riga `mode_id = 0`, identici per tutte le modalità dello stesso bucket. Senza questa regola una modalità aperta 5 minuti al giorno con 200 giocatori riporta media 200 e sembra la più popolosa della rete.
2. **Non si memorizza mai una media.** Si memorizzano numeratore e denominatore interi; la media si calcola in `float64` al momento della lettura. È ciò che rende il rollup gerarchico esatto e non approssimato, e che impedisce a due schermate di mostrare due medie leggermente diverse.

Non esiste `players_min`: nessun widget lo chiede e con la convenzione sparsa è una trappola (il minimo sulle sole righe esistenti non è mai 0).

### 6.2 Superficie: due rotte, nient'altro

```
GET /api/stats/overview?range=24h|7d|30d|90d|1y
GET /api/stats/mode?mode=<mode_key>&range=24h|7d|30d|90d|1y
```

- `range` è un **enum chiuso**. Nessun `?days=N`, nessun `?from=&to=`: lo spazio delle chiavi di cache deve restare finito ed enumerabile a priori (5 + 5·N). Aggiungere un range è una modifica server, cioè una decisione di costo.
- `mode` è validato contro una **allowlist** caricata da `stats.mode` all'avvio e rinfrescata dal giro di warm. Modalità sconosciuta → **404**, mai un payload vuoto: un payload vuoto l'interfaccia lo disegna come «zero giocatori», cioè una bugia invece di un errore.
- Schema Fastify con `additionalProperties: false` e `pattern: '^[a-z0-9_]{1,32}$'` su `mode`.
- Autorizzazione: `requireAuth` + `requireLevel(actorOf(req), 'stats', 1)`. Il payload **non varia per ruolo** (vedi 6.6).

Mappatura range → livello, scelta per tenere i punti fra 200 e 400 (un grafico è largo ~1000 px):

| range | fonte | punti | ri-bucketizzazione | `bucketSec` |
|---|---|---|---|---|
| 24h | `rollup_5m` | 288 | nessuna | 300 |
| 7d | `rollup_1h` | 168 | nessuna | 3600 |
| 30d | `rollup_1h` | 360 | 2 righe/bucket | 7200 |
| 90d | `rollup_1h` | 360 | 6 righe/bucket | 21600 |
| 1y | `rollup_1d` | 365 | nessuna | nominale (vedi nota) |

`bucketSec` per il range 1y è un'**etichetta**, non una durata: un giorno civile a Roma dura 82 800 o 90 000 secondi due volte l'anno. La durata reale non serve al client perché la copertura viaggia già normalizzata.

### 6.3 Regole del contratto

1. **Una sola statistica per la linea: la MEDIA**, coerente a tutti i livelli di zoom. Il massimo viaggia come seconda serie e si disegna come banda/ombra, **mai come la linea**. Altrimenti lo stesso istante vale 1240 nel range 24h, 1310 nel 30g e 1480 nell'1y, e l'utente lo scopre da solo.
2. **Il buco è un valore.** `null` significa «non rilevato»; `0` significa «rete davvero vuota». Mai interpolare fra due punti separati da un `null`.
3. **`coverage` è UNO SOLO per bucket**, non uno per modalità: la copertura è una proprietà del ciclo di raccolta. Bucket con `coverage < 0.5` si tratteggia; `coverage = 0` è `null`.
4. **Il totale di rete è memorizzato, non derivato.** `max` e `count(distinct)` non si decompongono: il picco di rete non è la somma dei picchi e gli unici di rete non sono la somma degli unici.
5. **Il breakdown chiude a 100%** perché `__transit__` e `__unknown__` sono serie esplicite e visibili. Senza, la torta non somma mai al totale e il primo che se ne accorge «aggiusta» normalizzando le percentuali, cioè spalma i giocatori in transito sulle modalità.
6. **Nessun massimo viaggia da solo**: sempre con l'istante, la copertura del bucket in cui è avvenuto e l'elenco delle cadenze presenti nel range. Due periodi con `deltas` diversi non sono confrontabili sul massimo, solo sulla media.
7. **I KPI si calcolano dalla stessa statistica e sugli stessi bucket della serie**, sui soli bucket **chiusi**. Non sono una query a parte.
8. Valori arrotondati a un decimale (`Math.round(v*10)/10`): sono conteggi di persone, e il decimale in più è solo byte.

### 6.4 Il tipo, esatto

```ts
// src/stats/contract.ts
export const CONTRACT_VERSION = 2;
export type Range = '24h' | '7d' | '30d' | '90d' | '1y';

export type Kpi = {
  /** Media normalizzata sul profilo orario (vedi 6.5). null se coverage = 0. */
  avg: number | null;
  /** Massimo osservato nei soli bucket CHIUSI del periodo. */
  peak: number | null;
  peakAt: number | null;          // epoch secondi
  peakCoverage: number;           // 0..1, copertura del bucket del picco
  /** Giocatori DISTINTI nel periodo. Non la somma degli unici giornalieri. */
  uniques: number | null;
  /** Secondi effettivamente osservati / secondi nominali del periodo. */
  coverage: number;
};

export type Series = {
  t: number[];                             // epoch secondi, crescente, senza buchi
  total: (number | null)[];                // riga mode 0, MEMORIZZATA
  peak: (number | null)[];                 // massimo del bucket, riga 0
  series: Record<string, (number | null)[]>;   // include __transit__ e __unknown__
  coverage: number[];                      // 0..1, uno per bucket
};

export type OverviewPayload = {
  v: 2;
  range: Range;
  tz: 'Europe/Rome';
  bucketSec: number;
  generatedAt: number;        // quando il worker ha prodotto QUESTI byte
  closedThrough: number;      // ultimo istante definitivo (fine ultimo bucket chiuso)
  liveTail: boolean;          // l'ultimo punto è un bucket in corso: si tratteggia
  deltas: number[];           // cadenze di campionamento distinte presenti nel range
  modes: string[];            // ordine di disegno; NON fidarsi dell'ordine di `series`
  labels: Record<string, string>;

  online: Series;
  /** Linea fantasma: SOLO il totale. `t` è il suo, non quello di `online`. */
  prev: { t: number[]; total: (number | null)[]; coverage: number[] };

  kpi: Kpi;
  kpiPrev: Kpi;
  /** false => la UI deve rifiutarsi di mostrare il delta percentuale. */
  comparable: boolean;

  /** 7x24, cella = (isodow-1)*24 + hour. TRE array, mai la media già divisa. */
  heatmap: { v: number[]; w: number[]; n: number[] };

  /** Unici giornalieri esatti. t = mezzanotte LOCALE di ogni giorno. */
  uniques: { t: number[]; v: (number | null)[]; prev: (number | null)[]; final: boolean[] };

  /** Unici del periodo per paese. sum(v) === kpi.uniques, per costruzione. */
  geo: { cc: string[]; v: number[]; asOf: number; exact: boolean } | null;
};

export type ModePayload = Omit<OverviewPayload, 'modes'> & { mode: string; modes: [string] };
```

`geo: null` quando la geolocalizzazione non è attiva (§8, passo 0 non superato): la UI nasconde il widget invece di disegnare una mappa vuota.

### 6.5 Definizioni dei KPI, scritte una volta

**`kpi.avg` — media normalizzata sul profilo orario.** Non è `player_seconds / covered_s` sul periodo intero. I buchi non sono mai indipendenti dall'ora del giorno (si fa deploy la sera, Redis soffre al picco): tre serate perse in un mese fanno scendere la media dell'8-10% con copertura complessiva al 98,8%, e nessuno guarda con sospetto una copertura del 98,8%.

```
celle = (giorno-settimana, ora) del periodo        // 24 celle per il range 24h
media = Σ_c  occ_nominali(c) · media(c)   /   Σ_c  occ_nominali(c)
        limitata alle celle con covered_s > 0
kpi.coverage = Σ covered_s / Σ secondi nominali del periodo
```

Una serata mancante allora non sposta la media: abbassa `coverage`. È la stessa aritmetica della heatmap, riusata.

**`kpi.peak`, `kpi.uniques`, tutti gli scalari** si calcolano sui **soli bucket chiusi** (`< closedThrough`), e la finestra del periodo precedente ha **la stessa lunghezza**. Senza questa regola il periodo corrente contiene un bucket parziale e quello precedente no: ogni somma è sistematicamente più bassa nel periodo corrente, ogni giorno, per costruzione.

**`comparable`** = `|kpi.coverage − kpiPrev.coverage| ≤ 0.02`. Un confronto fra due periodi con coperture diverse è l'unico modo garantito di produrre un delta falso, ed è lo scenario più probabile in cui il pannello mente a chi lo paga.

**Aritmetica dei bordi**: i confini di range si calcolano su `date` (`current_date - 30`), mai con `- interval '30 days'` su un `timestamptz`. Nei periodi che attraversano un cambio ora le due cose differiscono di un'ora e il confronto scivola di un bucket.

### 6.6 Le query: una per widget, N+1 payload

Il costo di una scansione su `rollup_1h` per 90 giorni è lo stesso che si voglia una modalità o venti: è lo stesso intervallo di indice. Si paga **una volta**, si taglia in JS.

**Serie + periodo precedente, una sola scansione** (`$4` = ore per bucket; per il range 24h la stessa query su `rollup_5m` senza il livello `b`):

```sql
WITH src AS (
  SELECT bucket, mode_id, player_seconds, covered_s, samples, players_max,
         (bucket >= $1) AS cur
  FROM   stats.rollup_1h
  WHERE  bucket >= $3 AND bucket < $2          -- UN solo intervallo di indice
), b AS (
  SELECT cur,
         date_trunc('day', bucket, 'Europe/Rome')
           + make_interval(hours =>
               (extract(hour FROM bucket AT TIME ZONE 'Europe/Rome')::int / $4) * $4) AS t,
         mode_id, player_seconds, covered_s, samples, players_max
  FROM src
), cov AS (              -- IL DENOMINATORE VIENE DALLA RIGA DI RETE
  SELECT cur, t, sum(covered_s) AS covered_s, sum(samples) AS samples
  FROM b WHERE mode_id = 0 GROUP BY 1, 2
)
SELECT b.cur, extract(epoch FROM b.t)::bigint AS t, b.mode_id,
       sum(b.player_seconds)::bigint AS player_seconds,
       max(b.players_max)            AS players_max,
       c.covered_s, c.samples
FROM b JOIN cov c USING (cur, t)
GROUP BY b.cur, b.t, b.mode_id, c.covered_s, c.samples
ORDER BY b.cur, b.t, b.mode_id;
```

`date_trunc(unità, ts, fuso)` a tre argomenti, mai `date_bin`: `date_bin` ha un'origine assoluta e non è DST-safe. E poiché gli offset di Roma sono ore intere, un bucket orario UTC è **già** allineato all'ora locale: il fuso morde solo sul confine di giorno, sulle etichette della heatmap e sui bordi del range.

**Heatmap, tutte le modalità in un giro** (numeratore per modalità, denominatore e occorrenze dalla riga 0):

```sql
SELECT (extract(isodow FROM bucket AT TIME ZONE 'Europe/Rome')::int - 1) * 24
         + extract(hour FROM bucket AT TIME ZONE 'Europe/Rome')::int AS cell,
       mode_id,
       sum(player_seconds)::bigint AS v,
       sum(covered_s)::bigint      AS w_self,
       count(*)::int               AS n_self
FROM stats.rollup_1h
WHERE bucket >= $1 AND bucket < $2
GROUP BY cell, mode_id;
```

In JS: `w` e `n` di ogni cella sono quelli della riga `mode_id = 0`; `v` è quello della modalità. Media = `v/w`. Cella con `n = 0` grigia (ora saltata del cambio ora), cella con `w` sotto il 50% del nominale tratteggiata. Nessun caso speciale per il DST: l'ora raddoppiata produce due bucket UTC che ricadono sulla stessa etichetta e si sommano correttamente.

**Unici giornalieri**: giorni chiusi da `stats.daily_unique_count` (definitivi, scritti una volta), giorno vivo con un conteggio index-only su `player_day` / `player_day_mode`. La riga di rete ha un `count` suo: la somma degli unici per modalità conta due volte chi ha giocato a due modalità.

**Unici del periodo e mappa** vengono dalla **stessa CTE** (§8.6), così `sum(geo.v) === kpi.uniques` è vero per costruzione e non per accordo.

### 6.7 Trasporto HTTP

```ts
reply.header('Cache-Control', 'private, no-cache, must-revalidate');
reply.header('Vary', 'Cookie, Accept-Encoding');
reply.header('ETag', `"${env.etag}"`);
reply.header('X-Stats-Age', String(age));            // secondi
reply.header('X-Online-Now', String(live.players));  // vedi sotto
reply.header('X-Online-Now-At', String(live.at));
reply.header('Server-Timing', `age;dur=${age * 1000}`);
if (req.headers['if-none-match'] === `"${env.etag}"`) return reply.code(304).send();
reply.header('Content-Type', 'application/json; charset=utf-8');  // Buffer => altrimenti octet-stream
```

**Deroga al §9, ristretta per prefisso a `/api/stats/*`.** La regola «nessuna risposta il cui contenuto dipende dai permessi viene cachata» ha una premessa che qui non ricorre: il payload è *gated* da `requireLevel` ma non *varia* per ruolo. `no-store` proibirebbe la richiesta condizionale e renderebbe l'ETag decorativo. Prezzo obbligatorio: il test di invarianza byte-per-byte fra due ruoli diversi (§9, I11) e una riga in `docs/security/deviations.md`.

**`onlineNow` non sta nel corpo.** Dentro un payload con `freshMs 90 s` il numero etichettato «online adesso» sarebbe vecchio fino a due minuti in condizioni normali e fino a dieci durante un hiccup del worker — ed è il numero che il committente confronta con quello che vede sul server. Il corpo è pre-compresso e condiviso byte per byte fra tutti i lettori, quindi uno scalare per-richiesta non può starci dentro senza ricomprimere. Viaggia come **header**, letto a ogni richiesta con una singola lettura per chiave primaria dell'ultimo ciclo `ok` (< 1 ms, ~10 richieste/minuto): sopravvive anche al **304**, che è esattamente il caso del polling.

Corpo servito in Brotli se `Accept-Encoding` lo accetta (zero ricompressione, zero copia), altrimenti decompresso **in modo asincrono** — `brotliDecompressSync` è lavoro sincrono sull'event loop innescabile da qualunque client autenticato che ometta l'header.

`AbortSignal` propagato: `AbortSignal.any([request.signal, AbortSignal.timeout(9_000)])`. Nove secondi, non dieci: il timeout applicativo deve scattare **prima** dello `statement_timeout` di Postgres, altrimenti nei log finisce l'errore di Postgres, che non dice quale richiesta l'ha causato.

### 6.8 Invarianti asserite al build, non alla lettura

Il fallimento tipico di un contratto colonnare è il disallineamento di lunghezza: il grafico disegna, non lancia, e mostra numeri corretti sotto l'etichetta sbagliata.

```ts
export function assertPayload(p: OverviewPayload): void {
  const n = p.online.t.length, bad: string[] = [];
  for (const [k, a] of [['total', p.online.total], ['peak', p.online.peak],
                        ['coverage', p.online.coverage]] as const)
    if (a.length !== n) bad.push(k);
  for (const [k, a] of Object.entries(p.online.series)) if (a.length !== n) bad.push(`series.${k}`);
  if (p.prev.total.length !== p.prev.t.length) bad.push('prev');
  if (p.heatmap.v.length !== 168 || p.heatmap.w.length !== 168 || p.heatmap.n.length !== 168) bad.push('heatmap');
  if (p.uniques.v.length !== p.uniques.t.length) bad.push('uniques');
  if (p.geo && p.geo.cc.length !== p.geo.v.length) bad.push('geo');
  for (const m of p.modes) if (!(m in p.online.series)) bad.push(`modes.${m}`);
  // I1: il breakdown chiude sul totale (tolleranza di arrotondamento)
  for (let i = 0; i < n; i++) {
    if (p.online.total[i] === null) continue;
    let s = 0; for (const m of p.modes) s += p.online.series[m][i] ?? 0;
    if (Math.abs(s - p.online.total[i]!) > 0.05 * p.modes.length + 0.5) { bad.push(`somma@${i}`); break; }
  }
  // I5: la mappa somma agli unici del periodo
  if (p.geo && p.kpi.uniques !== null &&
      p.geo.v.reduce((a, b) => a + b, 0) !== p.kpi.uniques) bad.push('geo≠uniques');
  if (bad.length) throw new PayloadInvalid(bad.join(', '));
}
```

Un build che fallisce **lascia in cache la chiave vecchia** e alza `metamc_stats_build_failures_total`. Non scrive mai un payload rotto.

---

## 7. Cache

### 7.1 Dove sta il confine fra storia immutabile e finestra viva

**Nei rollup, non nella cache.** `stats.rollup_1d` e `stats.daily_unique_count` portano `final boolean NOT NULL DEFAULT false`, alzato dal job giornaliero quando il giorno locale è chiuso e la copertura è calcolata. Una riga `final` **non si riscrive mai**: un ricalcolo che la cambierebbe scrive una riga in `stats.rebuild_log(level, day, mode_id, old, new, at)` e alza un allarme, invece di correggere in silenzio un numero che il committente ha già letto e annotato.

Conseguenza pratica: la query su 1y tocca 365 righe che nessuno riscrive mai — quindi sempre in `shared_buffers` — più il giorno vivo. La cache resta a **una chiave per payload**, senza due segmenti da concatenare a ogni richiesta e senza un confine da ricalcolare a mezzanotte in JS.

### 7.2 Chiavi

```ts
export const K = {
  ov:  (r: Range) => `stats:v2:ov:${r}`,
  md:  (m: string, r: Range) => `stats:v2:md:${m}:${r}`,
  hot: (r: Range) => `stats:v2:hot:${r}`,   // ZSET per RANGE, non globale
};
```

`v2` sta **nella chiave**, non solo nel payload: un cambio di contratto è un namespace nuovo e le chiavi vecchie scadono da sole. Una cache non si migra.

L'hot-set è **uno per range**. Con uno ZSET unico e score `Date.now()`, una dashboard aperta che rinfresca il 24h ogni minuto occupa permanentemente i primi 20 posti e i payload per modalità dei range lunghi non vengono scaldati mai — cioè il meccanismo che dovrebbe evitare l'esplosione combinatoria non funziona per quattro range su cinque.

Istanza Valkey **dedicata alla cache** (`allkeys-lru`, `save ""`, `appendonly no`, `maxmemory 64mb`), client ioredis separato da quello delle sessioni: con `enableAutoPipelining` attivo un blob da 10 kB finirebbe nella stessa pipeline del round trip di autorizzazione e aggiungerebbe latenza a ogni login. Su questa istanza vivono **solo payload**: nessuno stato operativo, nessun indice. `evicted_keys != 0` è un allarme, non una statistica: con ~1,5 MB previsti contro 64 MB, un'eviction significa che qualcuno ci ha scritto chiavi non previste.

### 7.3 Cadenze e freschezza

```ts
export const WARM_MS = 60 * S;
export const TTL: Ttl = { fresh: 90 * S, stale: 10 * M };
```

**Una cadenza sola, per tutti e cinque i range**, e un solo job che li percorre in sequenza.

La versione precedente ne prevedeva cinque diverse (60 s per il 24h, 15 min per 30g e 90g, un'ora per l'1y), e la ragione scritta era che «nel payload 1y solo l'ultimo punto si muove». Era vero finché i range lunghi erano viste di solo storico. L'emendamento sul selettore l'ha invalidata: il selettore in alto governa **ogni** riquadro della panoramica, quindi sull'1y si muovono anche la heatmap, il picco del periodo, gli unici e la provenienza, e tutti includono il giorno in corso.

Cadenze diverse producevano una domanda a cui il pannello non sapeva rispondere: lo stesso dato appariva fresco sul 24h e fermo a un quarto d'ora prima sul 90g, e per accorgersi che le due schermate non erano in disaccordo bisognava sapere a memoria la tabella. **Un selettore di intervallo cambia cosa si guarda, non quanto è vecchio.**

Il costo che giustificava lo scaglionamento è stato tolto, non accettato: `buildAll` prende ora l'elenco delle modalità che servono davvero e salta le tre query per modalità quando è vuoto. Sono la parte cara del giro — `heatmapModeRows` misura 1,7 s sul 90g contro i 25 ms della gemella di rete — e la panoramica non ne legge una riga. Misurato prima e dopo, stesso seme:

| range | prima | dopo |
|---|---|---|
| 24h | 73 ms | 55 ms |
| 7g | 75 ms | 53 ms |
| 30g | 288 ms | 215 ms |
| 90g | 816 ms | 605 ms |
| 1y | 394 ms | 205 ms |

Giro completo **754 ms misurati in produzione**, con diciannove server: 24h 360, 7g 69, 30g 84, 90g 107, 1y 133. Poco più dell’1% di un minuto.

La storia vale più del numero. Questa riga ha detto due cose sbagliate prima di dirne una giusta. La prima: «~1,1 s, sotto il 2%», misurato su una macchina di sviluppo con tre server e affermato come se valesse ovunque. In produzione erano **7,9 s** — il 12% del tempo, con i giri a 68 secondi invece di 60 perché il timer riparte alla fine del giro.

Quegli 8 secondi erano **una query**: la metà «per modalità» di `geoRows`, calcolata a ogni giro e buttata via perché nessuno aveva aperto il dettaglio di una modalità — lo stesso difetto già corretto per le altre tre query per modalità, sfuggito perché qui la metà per modalità sta dentro la stessa query invece che in una funzione a parte. Chiuso il cancello, i tre range lunghi sono passati da ~2500 ms a meno di 140.

Per arrivarci sono serviti due giri di rilascio, perché il log dava un totale e non una ripartizione. Ora `buildAll` cronometra tutte e tredici le query e il giro stampa `ms` per range più il nome della query più cara del range peggiore: tredici coppie di `Date.now()` che non si misurano, contro due indagini.

`fresh = 1,5 × warm`. Se fossero uguali, ogni warm arriverebbe un capello in ritardo e ogni richiesta vedrebbe una chiave tecnicamente obsoleta, innescando rivalidazioni all'infinito.

**Un job, non cinque.** Con la stessa cadenza, cinque timer indipendenti scoccherebbero insieme e lancerebbero cinque costruzioni concorrenti: 65 query in volo su un pool da otto, cioè esattamente il `Promise.all` da cui questo disegno si tiene alla larga. In sequenza il picco resta uno, e un range che va in timeout non fa invecchiare gli altri quattro.

### 7.4 Il giro di warm: `warm()`, mai `getOrSet()`

`getOrSet` nel ramo *stale* fa partire la rivalidazione **senza attenderla** e ritorna subito. Un giro di warm che chiama `getOrSet` in un ciclo spara quindi N+1 compressioni **concorrenti** — esattamente il `Promise.all` che ci si è vietati — e l'`await` davanti non protegge nulla. L'interfaccia `CacheService` ha già i due metodi distinti: si usano per quello che sono.

- `warm(key, factory, ttl)` — costruisce, serializza, comprime, scrive su Valkey, aggiorna `#lastGood`. **Attesa, sequenziale.** Solo il worker la chiama.
- `getOrSet(key, factory, ttl)` — solo percorso di lettura: singleflight + stale-while-revalidate.

```ts
export function startStatsWorker(ctx: Ctx, reg: JobRegistry) {
  for (const [range, cfg] of Object.entries(RANGES) as [Range, Cfg][]) {
    startJob({
      name: `stats-warm-${range}`,
      intervalMs: cfg.warm,
      retryMs: Math.min(cfg.warm, 30_000),
      successMessage: `payload ${range} ricostruito`,
      failureMessage: `il pannello statistiche servira' numeri vecchi per il range ${range}`,
      run: async () => {
        const t0 = Date.now();
        const rows = await queryAll(ctx.statsDb, range);       // UNA scansione per widget
        const built = splitByMode(rows, range);                 // N+1 payload
        await ctx.cache.warm(K.ov(range), () => serialize(built.overview), cfg, 11);
        let done = 1, deferred = 0;
        for (const mode of await hotModes(ctx.redis, range)) {
          if (Date.now() - t0 > WARM_BUDGET_MS || underPressure(ctx)) { deferred++; continue; }
          const p = built.perMode.get(mode);
          if (!p) continue;
          await ctx.cache.warm(K.md(mode, range), () => serialize(p), cfg, 5);
          done++;
        }
        return { payloads: done, deferred, rows: rows.length, ms: Date.now() - t0 };
      },
    }, ctx.logger, reg);
  }
}

async function hotModes(redis: Redis, range: Range): Promise<string[]> {
  const cut = Date.now() - 3600_000;
  await redis.zremrangebyscore(K.hot(range), '-inf', cut);
  return redis.zrevrange(K.hot(range), 0, 19);     // chiavi = mode_key, lo ZSET è già per range
}
```

Il tetto del giro è **temporale** (`WARM_BUDGET_MS = 250`), non un numero fisso di chiavi: N è ignoto, e un tetto per conteggio è un tetto tarato su un'ipotesi. Ciò che non entra nel budget è servito pigramente al primo accesso e conteggiato in `metamc_stats_warm_deferred_total`.

L'hot-set è alimentato dall'handler: `void ctx.redis.zadd(K.hot(range), Date.now(), mode)`. Si riscalda ciò che qualcuno ha **guardato**, non «le tre modalità con più giocatori» — quella è una supposizione, e sbaglia esattamente quando l'admin sta indagando su una modalità marginale.

### 7.5 Compressione: non deve toccare i thread di Argon2

Misure sulla forma di payload descritta (Node 22, payload 30d con N=20, raw 37,4 kB):

| qualità | byte | tempo |
|---|---|---|
| q11 | 9,7 kB | 34 ms |
| q9 | 11,0 kB | 6,0 ms |
| q5 | 11,0 kB | 1,3 ms |

q11 costa 5,7 volte q9 per il 12% di byte in meno, e 26 volte q5 per **zero** byte in meno rispetto a q9. Il rapporto reale è ~3,8:1, non 8,4:1: il payload sul filo è ~10 kB e l'occupazione Valkey ~1,5 MB. Le stime del progetto vanno corrette con questi numeri, incluse le soglie della metrica `payload_bytes`.

Regole:

1. **q11 solo sui 5 payload overview** (build-once, serve-many: ~60 letture per build). **q5 sui payload per modalità** (2-3 letture prima del rebuild).
2. **Sempre in sequenza.** `brotliCompress` gira sul threadpool libuv, lo stesso da cui `HashSemaphore` prende `UV_THREADPOOL_SIZE − 2 = 6` slot. La sequenzialità garantisce **al più un thread** occupato da Brotli in ogni istante: 6 Argon2 + 1 Brotli + 1 di riserva su 8. È il vincolo, e va reso strutturale — mai `Promise.all`, mai `void`.
3. **Contropressione prima di ogni compressione.** `HashSemaphore.saturated` conta gli hash *in volo*, non l'occupazione dei thread, ed è strutturalmente cieco a Brotli, `fs` e `dns`: non è un indicatore utilizzabile. Si usa il ritardo dell'event loop:
   ```ts
   const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
   const underPressure = (ctx: Ctx) =>
     loop.percentile(99) / 1e6 > 100 || ctx.hashSemaphore.inFlight >= 5;
   ```
   Sotto pressione il giro si interrompe e riprende al prossimo tick: un grafico non può far rallentare un login.
4. `BROTLI_PARAM_SIZE_HINT = raw.length` e `LGWIN = 24`: migliorano rapporto **e** velocità e costano una riga.
5. Se il test di carico (§9.3) mostra fame su `fs`/`dns`, si alza `UV_THREADPOOL_SIZE` a 10 **fissando esplicitamente** il semaforo a 6 (`HASH_SEMAPHORE_MAX=6`), altrimenti la formula `threadpool − 2` alzerebbe la concorrenza di Argon2 come effetto collaterale. È una modifica innescata da una misura, non a priori.

### 7.6 L'implementazione dietro `CacheService`

```ts
const HEADER = 42;   // 1 ver | 1 enc | 8 builtAt | 8 freshUntil | 8 staleUntil | 4 rawLen | 12 etag

export class StatsCache implements CacheService {
  #flights = new Map<string, Promise<Envelope>>();
  /** UNA voce per chiave. NON è un L1 di latenza: è il degrado se Valkey cade.
   *  Il nome lo dice apposta, così nessuno lo "ottimizza" facendolo crescere. */
  #lastGood = new Map<string, Envelope>();

  async warm(key: string, factory: () => Promise<Buffer>, ttl: Ttl, quality: 5 | 11) {
    const raw = await factory();
    const body = await br(raw, { params: { [Z.BROTLI_PARAM_QUALITY]: quality,
                                           [Z.BROTLI_PARAM_LGWIN]: 24,
                                           [Z.BROTLI_PARAM_SIZE_HINT]: raw.length } });
    const env = seal(raw, body, ttl);
    this.#lastGood.set(key, env);
    try { await this.redis.set(key, encode(env), 'PX', ttl.fresh + ttl.stale + 60_000); }
    catch { this.m.redisDown++; }          // il payload vale comunque
    return env;
  }

  async getOrSet(key, factory, ttl): Promise<Envelope> {
    const now = Date.now();
    let env: Envelope | null = null;
    try { env = decode(await this.redis.getBuffer(key)); }   // getBuffer, MAI get
    catch { this.m.redisDown++; env = this.#lastGood.get(key) ?? null; }
    if (env && now < env.freshUntil) { this.m.hits++; return env; }
    if (env && now < env.staleUntil) { this.m.stale++; void this.#fly(key, factory, ttl).catch(() => {}); return env; }
    this.m.misses++;
    return this.#fly(key, factory, ttl);
  }
}
```

- **`getBuffer`, mai `get`.** `get` decodifica in UTF-8 e distrugge silenziosamente i byte Brotli: il payload arriva, non solleva eccezioni, e il client riceve JSON illeggibile. È *il* bug di questa architettura. Vale anche in scrittura: passare una stringa a `set` la ricodifica.
- **TTL Redis = fresh + stale + margine.** Il TTL da solo non sa esprimere «obsoleto ma servibile»: una chiave scaduta è sparita, e sparita significa bloccare una richiesta che poteva essere servita. I due istanti stanno nell'intestazione binaria, non in una seconda chiave.
- **Singleflight in-processo** (`Map<string, Promise>`), non un lock distribuito: c'è una sola istanza applicativa, e un lock che nessuno esercita è codice non verificato. Il punto in cui prenderlo, se un giorno le istanze diventassero due, è `#fly()`, prima della factory.
- `invalidateTag(tag)` opera per prefisso (`stats:v2:md:{mode}:`) con `SCAN MATCH` sull'istanza di cache, che contiene un centinaio di chiavi.

### 7.7 Cache fredda al primo avvio

```ts
export async function warmOnBoot(ctx: Ctx) {
  for (const r of ['24h', '7d', '30d', '90d', '1y'] as const) {
    try { await buildAndStore(ctx, r); }
    catch (e) { ctx.logger.warn({ range: r, err: e },
      'warm iniziale fallito: la prima richiesta di questo range paghera\' l\'aggregazione'); }
  }
}
```

Dopo `listen()`, **mai prima**: `/health/ready` non deve mai dipendere dalle statistiche, o un rollup lento tiene il pannello fuori dal load balancer. Sequenziale e in quest'ordine, con la 1y per ultima: `statsPool` ha 8 connessioni e lanciarne cinque insieme su una page cache fredda trasforma un warm da 2 secondi in uno da 20 e ruba CPU al percorso di login. Più lento in totale, più veloce per la schermata che qualcuno aprirà davvero per prima. Con un anno di storico: ~200k righe scansionate e 5 compressioni q11, ordine di 2-4 secondi.

L'istanza Valkey di cache è un **container separato che sopravvive al deploy**: un riavvio dell'applicazione non è una cache fredda, e `warmOnBoot` resta una cortesia e non un vincolo di rilascio.

### 7.8 Il pool di lettura

```ts
pool.on('connect', (c) => void c.query(`
  SET search_path = stats, public;
  SET TIME ZONE 'Europe/Rome';
  SET statement_timeout = '10s';
  SET idle_in_transaction_session_timeout = '10s';
  SET lock_timeout = '2s';`));
```

`max: 8`, ruolo `metamc_stats` con `default_transaction_read_only = on`, `enable_partitionwise_aggregate = on` e `statement_timeout` impostati **sul ruolo**, così valgono anche per chi indaga con psql. `inflightQueryAbortStrategy: 'cancel query'` richiede un `controlClient` **separato**: è da quella connessione che parte `pg_cancel_backend()`, e prenderla dal pool significa che sotto carico la cancellazione fallisce in silenzio, cioè l'`AbortSignal` risulta collegato e non fa nulla.

Il pool del **rollup** è distinto sia da questo sia da quello dell'ingest (`max: 2`, `statement_timeout 5s`): un giro di rollup lungo non deve poter rubare al ciclo di campionamento la sua connessione. `statement_timeout = '60s'` sul pool di rollup, e **catch-up limitato** — ogni giro avanza al massimo di N bucket (288 = un giorno) e ritorna `caught_up: false` finché è indietro. Senza, il primo giro dopo un fermo prova ad aggregare tutto l'arretrato in un solo statement, viene ucciso dal timeout, e il watermark non avanza mai: stallo permanente con grafici vuoti.

### 7.9 Metriche

`metamc_stats_cache_age_seconds{key}` è **la** metrica. Con il warm anticipato l'hit rate è ~100% per costruzione e resta al 100% anche se il worker è morto e Valkey serve lo stesso payload da tre ore: chi allarma sull'hit rate non allarmerà mai. L'età della chiave servita è l'unica cosa che distingue «cache che funziona» da «cache che ha smesso di aggiornarsi ma continua a rispondere». **Allarme: `age > 3 ×` la cadenza di warm del suo range.**

Le altre, tutte in `/internal/metrics`, scritte a mano come nel §13:

```
metamc_stats_build_ms{key,stage="query"|"serialize"|"compress"}   gauge  -- indicatore anticipatore, soglia 2000 su query
metamc_stats_payload_bytes{key,enc="raw"|"br"}                    gauge  -- raw > 120 kB => rivedere "tutte le modalità nell'overview"
metamc_stats_build_failures_total                                 counter
metamc_stats_warm_deferred_total                                  counter -- >0 stabile => N è cresciuto o la macchina è satura
metamc_stats_cache_{hits,stale,misses}_total                      counter
metamc_stats_singleflight_joined_total                            counter -- sempre 0 => il percorso pigro non è mai stato esercitato
metamc_stats_redis_unavailable_total                              counter
metamc_event_loop_delay_ms{quantile="0.99"}                       gauge  -- l'unica metrica che lega il worker alla latenza di login
```

---

## 8. Geolocalizzazione e dati personali

### 8.1 Passo zero obbligatorio: il campo `ip` è del giocatore o del proxy?

**Prima di scrivere una riga di codice geografico.** Nel campione l'`ip` è `2.196.7.107` (rete mobile italiana) e sembra il giocatore, ma un campione solo non è una prova, e una configurazione con proxy-protocol mal impostata farebbe collassare tutti i giocatori su pochi indirizzi. Se il campo è l'IP del proxy Velocity, la funzione geografica **va tolta dal design**, non implementata sbagliata.

Sonda in memoria, nulla su disco, da eseguire **tre volte in ore diverse** (mattina, prime time, notte):

```ts
// scripts/probe-ip.ts — legge, misura, stampa aggregati. Non scrive IP da nessuna parte.
const rows = await readOnlineOnce(gameRedis);          // stesso percorso del poller
const ips = new Set(rows.map(r => r.ip).filter(Boolean));
const proxies = new Set(rows.map(r => r.proxy).filter(Boolean));
const freq = new Map<string, number>();
for (const r of rows) if (r.ip) freq.set(r.ip, (freq.get(r.ip) ?? 0) + 1);
const topShare = Math.max(...freq.values()) / rows.length;
console.log({ players: rows.length, distinctIp: ips.size, distinctProxy: proxies.size,
              ipPerProxy: ips.size / Math.max(1, proxies.size), topShare,
              missingIp: rows.filter(r => !r.ip).length / rows.length });
```

| esito | verdetto |
|---|---|
| `distinctIp <= distinctProxy + 3` **oppure** `topShare > 0.5` | Il campo è l'IP del proxy. **Si ferma qui**: si toglie la mappa dal design, `geo: null` nel payload, nessuna colonna `country`, nessun database MMDB, niente §8.2-8.8 |
| `ipPerProxy >= 20` **e** `topShare <= 0.10` | Via libera |
| in mezzo | Si ripete su altri tick e si chiede al committente com'è configurato il proxy prima di procedere |

`distinctIp / players` è **informativo e basta**: il CGNAT mobile italiano lo abbassa legittimamente. Si registra il valore, non si decide su quello.

### 8.2 Sorgente e libreria

- **DB-IP «IP to Country Lite»**, formato MMDB, **CC BY 4.0**. Release 2026-08 verificata: 706 484 record, accuracy index 81, `dbip-country-lite-2026-08.mmdb.gz` = 4 096 588 byte, ~7,9 MB decompresso. Aggiornamento mensile, URL deterministico `dbip-country-lite-YYYY-MM.mmdb.gz`, nessun account, nessuna chiave a scadenza.
- Scelta su un criterio solo: è l'unica gratuita che sia insieme **senza ShareAlike**, **senza account** e con URL costruibile da un job. Lo ShareAlike (GeoLite2, IPinfo Lite, IPLocate, IP2Location LITE) copre anche i «database adattati», e le tabelle aggregate sono derivate riga per riga dal database: CC BY 4.0 chiude la questione senza doverla argomentare. GeoLite2 imporrebbe in più di distruggere le versioni superate entro 30 giorni da ogni rilascio (due a settimana), cioè vieterebbe di congelare il file.
- **Attribuzione obbligatoria**: link «IP Geolocation by DB-IP» nel **footer della schermata mappa**, non nel README. È il requisito che si dimentica.
- Lettore: **`maxmind` 5.0.7** (MIT, JS puro, `mmdb-lib` 3.0.3 + `tiny-lru` 13). Nessun binding nativo, nessun `node-gyp`, compatibile con `pnpm install --ignore-scripts` già in uso nel Dockerfile. Ordine di grandezza atteso: ~1,7 µs per lookup, da rimisurare su Node 24.
- **Nessun servizio HTTP di lookup**: manderebbe l'IP dei giocatori a un terzo, cioè un responsabile del trattamento e un DPA, più un salto di rete dentro un ciclo da 30 secondi.
- **Solo paese, nessuna regione.** DB-IP City Lite costa 124 MB residenti (15 volte) per un dettaglio che il design non chiede e che su rete mobile italiana geolocalizza il PoP dell'operatore, non il giocatore. Se servisse poi, `subdivision` è una migration additiva e i dati storici non si recuperano comunque: va detto prima.

### 8.3 Dove sta il file e come si aggiorna

Il `.mmdb` sta in un **volume** (`/var/lib/metamc/geo/country.mmdb`), mai in un layer dell'immagine: altrimenti l'aggiornamento senza riavvio non ha dove scrivere.

```ts
let reader: Reader<CountryRecord> | null = null;
let buildEpoch = 0;

export async function loadGeoDb(path: string) {
  const next = new Reader<CountryRecord>(await readFile(path), { cache: { max: 8_192 } });
  if (next.get('8.8.8.8')?.country?.iso_code !== 'US')
    throw new Error('geo: file mmdb non valido o non e\' un country db');   // valida PRIMA di promuovere
  reader = next;                       // swap del riferimento: atomico in JS, nessun lock
  buildEpoch = next.metadata.buildEpoch as unknown as number;
}
```

Nessun `watchForUpdates`: usa `fs.watch`, che perde gli eventi sui rename atomici e sui bind mount Docker, cioè fallirebbe esattamente nel caso per cui esiste. Lo swap del riferimento lascia i lookup in volo sul buffer vecchio, che il GC raccoglie; picco di memoria durante lo scambio ~16 MB.

Job giornaliero (`startJob`, accanto agli altri): scarica il mese corrente, poi il precedente se il primo dà 404 (il file di settembre non esiste il 1° settembre alle 00:01); scompatta su `.tmp`; **valida**; `rename` atomico; ricarica. Un fallimento **non è fatale**: il reader in memoria resta quello di prima. Metrica `metamc_geo_db_age_days` da `buildEpoch`, **allarme a 45 giorni** — altrimenti il database invecchia e nessuno se ne accorge.

### 8.4 Il lookup non lancia mai

```ts
export function countryOf(ip: string | undefined): string {
  if (!ip || !reader) return 'XX';
  const v = isIP(ip);                            // Reader.get() LANCIA su input malformato
  if (v === 0) return 'XX';
  if (v === 4 ? RESERVED_V4.test(ip) : RESERVED_V6.test(ip)) return 'XX';
  const r = reader.get(ip);
  return r?.country?.iso_code ?? r?.registered_country?.iso_code ?? 'XX';
}
```

Un solo `ip` sporco in un hash Redis farebbe saltare l'intero campione del ciclo. `'XX'` è un risultato, non un errore.

Se l'`ip` è vuoto e va estratto da `address`: **mai `split(':')[0]`** — un indirizzo IPv6 è pieno di due punti e quel giocatore diventerebbe `'XX'` per sempre. `lastIndexOf(':')` e gestione delle parentesi quadre.

### 8.5 Cosa si persiste

**Solo `country char(2)`. L'IP non tocca mai il disco**: né tabella, né log, né file temporaneo. Vive dentro lo scope di una funzione del ciclo e ne esce.

Il paese è una **colonna di `stats.player_day`**, nullable: `NULL` = geolocalizzazione non attiva, `'XX'` = attiva e non risolta. È l'unica sede: la metrica della mappa è «unici del periodo per paese» e `player_day` è l'unica tabella che può rispondere, senza join né seconda scrittura, e rende la cancellazione di un giocatore una sola `DELETE`.

**Quando si scrive, e quanto costa.** Non a ogni ciclo. Un upsert per giocatore per tick sarebbe, a P=2000 e T=30 s, 5,76 milioni di versioni di riga al giorno su una partizione da ~5000 righe vive: un worker di autovacuum permanentemente incollato a quella tabella, per sempre, per produrre 6 MB al giorno di dato utile.

| momento | scrittura | volume/giorno |
|---|---|---|
| apertura sessione | `INSERT (day, player_id, country, first_seen_at) ON CONFLICT DO NOTHING` | ≈ U·S (~12 500) |
| chiusura sessione | `UPDATE` dei secondi e delle sessioni, affettati sui giorni attraversati | ≈ U·S |
| mezzanotte locale | riga per le sessioni ancora aperte | ≈ P |

L'INSERT all'apertura è indispensabile: se si scrivesse solo alla chiusura, gli unici del **giorno vivo** perderebbero tutti i giocatori ancora connessi.

**Regola del paese, deterministica**: vince la **prima osservazione del giorno**. `country = COALESCE(player_day.country, EXCLUDED.country)` nell'`ON CONFLICT`. Senza una regola scritta, un giocatore su rete mobile che salta su un PoP diverso fa ballare il conteggio a ogni riscrittura.

Aggregati per la mappa, senza identificativi: `stats.geo_range(range, mode_id, country, uniques, computed_at)`, riscritta dal job giornaliero per i range 30d/90d/1y. Per 24h e 7d il conteggio esatto si fa al volo nel giro di warm (rispettivamente ~5k e ~35k righe). Il `DISTINCT ON` su 12 partizioni per il range 1y non entra mai in un giro di warm.

### 8.6 Le due query, dalla stessa CTE

```sql
-- $1 primo giorno locale, $2 giorno successivo all'ultimo, $3 mode_id (0 = rete)
WITH ranged AS (
  SELECT DISTINCT ON (d.player_id) d.player_id, d.country
  FROM stats.player_day d
  WHERE d.day >= $1 AND d.day < $2
    AND ($3 = 0 OR EXISTS (SELECT 1 FROM stats.player_day_mode m
                            WHERE m.day = d.day AND m.player_id = d.player_id AND m.mode_id = $3))
  ORDER BY d.player_id, d.day DESC        -- attribuito al paese del giorno più recente
)
SELECT coalesce(country, 'XX') AS cc, count(*)::int AS uniques FROM ranged GROUP BY 1 ORDER BY 2 DESC;
-- kpi.uniques = (SELECT count(*) FROM ranged)   <- stessa CTE, quindi sum(v) === kpi.uniques
```

Un giocatore visto in giorni diversi da paesi diversi conta **una volta**. La metrica è «giocatori unici», non «giocatori-giorno»: con poll da 30 secondi un giocatore connesso un'ora produce 120 campioni, e una mappa costruita sui campioni misura *quanto la gente sta online*, non *da dove viene*, premiando meccanicamente il fuso orario di casa.

`'XX'` è una barra della mappa con etichetta «non determinato», **mai uno scarto**: un secchiello `XX` che cresce è il primo sintomo che il campo `ip` ha cambiato semantica, e scartandolo la mappa continuerebbe a sembrare corretta mentre misura un terzo dei giocatori.

### 8.7 L'IP non deve poter finire nei log dalla porta di servizio

Il rischio non è il `logger.info` che si controlla: è l'oggetto errore. Un throw dentro il ciclo con l'hash Redis nel contesto serializza `address` e `ip` nello stack.

```ts
redact: { paths: ['ip', '*.ip', '*.*.ip', 'address', '*.address', 'err.*.ip',
                  'req.headers["x-forwarded-for"]', 'req.headers["x-real-ip"]'],
          censor: '[redatto]' }
```

Più una guardia in `scripts/check-guards.ts` (già nello script `check`), applicata a `src/geo/**` e `src/stats/**`, che fallisce la CI su `logger.*({ ... ip ... })` e su `JSON.stringify(hash)`.

### 8.8 Retention e cancellazione

| tabella | retention | come |
|---|---|---|
| `stats.player_day`, `player_day_mode` | **730 giorni** | DETACH + DROP di partizione mensile |
| `stats.session` | 730 giorni | idem |
| `stats.sample_mode` (grezzo) | 30 giorni | DROP di partizione giornaliera |
| `stats.rollup_5m` | 400 giorni | DROP mensile |
| `rollup_1h`, `rollup_1d`, `daily_unique_count`, `geo_range` | per sempre | non partizionate, ~200 kB/anno |

I 730 giorni sostituiscono i 3650 proposti: erano incoerenti con i 24 mesi già dichiarati nel registro dei trattamenti, e da soli producevano 123 partizioni su una tabella, spingendo lo schema a ~241 partizioni contro il tetto dichiarato di 150. Con 730 si sta a ~144. È una `UPDATE` su `stats.partitioned_table`, che è precisamente il motivo per cui quel registro è fatto di righe.

Cancellazione su richiesta di un singolo giocatore: `DELETE FROM stats.player_day WHERE player_id = $1` (più `player_day_mode`, `session`, `player_name`) e svuotamento di `stats.player` con `anonymized_at = now()`, senza eliminare la riga: gli aggregati restano, e restano corretti, perché non sono più dato personale.

**Fuori perimetro**: nessuna tabella di IP hashati, nessuna correlazione anti-alt in `stats`. Un SHA-256 dell'IP senza pepper non è anonimizzazione (2³² precalcolabili in secondi), e la costruzione corretta — HMAC con pepper versionato e ruotato fuori da Postgres — alza la soglia di valutazione DPIA e va decisa a parte, con il committente, prima di scrivere codice.

Documenti da produrre **prima** del passaggio in produzione, come artefatti del progetto e non come consulenza: `docs/privacy/lia-geo.md` (finalità, necessità, bilanciamento, datata), la voce di registro art. 30 già redatta in fase di progetto, e la valutazione preliminare di soglia DPIA di una pagina che motiva perché ricorre **un solo** criterio (soggetti vulnerabili) e non gli altri. La soglia va rivista il giorno in cui si tocca lo schema, non una volta sola all'inizio.

### 8.9 La mappa nel client

`countries-110m.json` (108 kB) **non entra nel bundle**: un `import` statico di JSON lo incorpora come letterale in un chunk JS, cioè 108 kB che passano dal parser JavaScript invece che da `JSON.parse`.

```ts
const topoUrl = new URL('../assets/countries-110m.json', import.meta.url);
let topoPromise: Promise<Topology> | null = null;
const loadTopo = () => (topoPromise ??= fetch(topoUrl).then(r => r.json()));
// prefetch al passaggio del mouse sulla voce di menu: la latenza sparisce, non costa un byte
```

Componente caricato con `import()` dinamico sulla rotta; asset con nome hashato e `Cache-Control: public, max-age=31536000, immutable`, precompresso Brotli a build time. `world-atlas` e `topojson-client` sono fermi al 2019: si trattano come **dati congelati**, vendorizzati nel repo, non come librerie mantenute. La tabella alpha-2 → numerico ISO vive in quel chunk (~2,5 kB): un codice non mappato (`XK`) degrada a «non disegnato» con un warning, mai a un errore che rompe la mappa.

Etichetta obbligatoria: **«provenienza approssimata»**. Nessun database gratuito segnala VPN, proxy e datacenter: una fetta di traffico apparirà da NL, DE o US per ragioni che non hanno niente a che vedere con la provenienza. La mappa non va mai usata come prova in una decisione di moderazione.

---

## 9. Verifiche e ordine di implementazione

### 9.1 Invarianti verificati in continuo

Tutti i difetti che contano falliscono in silenzio e in modo plausibile: nessuno solleva un'eccezione, nessuno rompe un grafico. Servono asserzioni **eseguite come job**, non test una tantum. Job `stats_selfcheck`, ogni ora, che scrive in `stats.selfcheck_run(at, name, offenders, sample jsonb)` e alza `metamc_stats_invariant_violations_total{name}`; `offenders > 0` è un allarme.

| # | Invariante | Scenario concreto in cui il numero diventa falso |
|---|---|---|
| **I1** | Per ogni bucket: `players(mode 0) = Σ players(mode ≥ 1)`, con `__transit__` e `__unknown__` inclusi | Un giocatore in transito ha `server` vuoto: senza la modalità esplicita la torta non somma al totale e il primo che se ne accorge normalizza le percentuali, spalmando i transiti sulle modalità |
| **I2** | `covered_s` e `samples` identici per tutte le modalità dello stesso bucket | Denominatore preso dalle righe della modalità: `evento_1`, aperta 5 minuti al giorno con 200 giocatori, riporta media 200 e batte `duels` aperta 24h con 150 |
| **I3** | `players_max(1d) = max(players_max(1h) del giorno) = max(players_max(5m) dell'ora)` | Un errore nel rollup gerarchico rende il «record di giocatori contemporanei» diverso a ogni livello di zoom |
| **I4** | Su ogni giorno ancora coperto dal grezzo: `player_seconds(1h)` ricalcolato dal grezzo = `player_seconds(1h)` memorizzato | Un bug nel rollup scoperto dopo 45 giorni: i 30 recenti si ricalcolano, i 15 precedenti restano sbagliati **per sempre** e nessuna colonna dice che lo sono |
| **I5** | `Σ geo.v = kpi.uniques` per lo stesso range e la stessa modalità | La mappa in «giocatori-giorno» (37 800 italiani) accanto al KPI in giocatori (5 000), con «giocatori» scritto nella legenda |
| **I6** | `uniques(mode 0, giorno) ≥ max_m uniques(m, giorno)` **e** `≤ Σ_m uniques(m, giorno)` | Unici di rete derivati sommando le modalità: 5 000 persone diventano 11 000 con 2,2 modalità medie a testa, e il numero cresce con la rotazione fra modalità invece che con le persone |
| **I7** | Slot mai tentati nelle ultime 24h = 0, oppure pari ai fermi dichiarati | Postgres giù per un'ora produce 120 slot **mancanti** (non c'è dove scrivere che non si poteva scrivere); Redis giù ne produce 120 `failed`. Sono buchi di natura diversa e la griglia di lettura li distingue: chi non lo sa «aggiusta» il caso mancante scrivendo zeri |
| **I8** | Nessuna riga con `players < 0`, `delta_s` fuori `[1, 3600]`, `covered_s > durata nominale del bucket` | Uno slot ripetuto o un `delta_s` fuori scala dopo un riavvio gonfia la copertura oltre il 100% |
| **I9** | Righe `final = true` immutabili: checksum di `rollup_1d` e `daily_unique_count` sui giorni chiusi, confrontato con quello del giro precedente | Un rollup rieseguito cambia in silenzio un numero che il committente ha già letto e annotato |
| **I10** | Sessioni: nessuna durata negativa; `end_reason='skew'` sotto l'1%; `gap`+`reaper` sotto il 5% delle chiusure | Un NTP avanti di 5 minuti sul server di gioco chiude e riapre ogni sessione a ogni ciclo: 4,3 M righe/giorno, durata media 20 secondi, e grafico dell'online perfettamente intatto |
| **I11** | `keys_read − distinct(player_id)` sotto soglia | Un rename lascia viva la vecchia chiave: il totale conta quel giocatore due volte per sempre, le sessioni una sola, e due numeri sullo stesso schermo si contraddicono |
| **I12** | `assertPayload` a ogni build (§6.8) | Serie disallineata di un elemento: il grafico disegna, non lancia, e mostra numeri corretti sotto l'etichetta sbagliata |
| **I13** | Due ruoli diversi con `stats:1` ricevono **byte identici** sulla stessa chiave | È il prezzo della deroga al §9: se un giorno il payload dovesse variare per ruolo, il test fallisce prima della fuga |
| **I14** | `metamc_stats_cache_age_seconds` ≤ 3× la cadenza di warm del suo range | Il worker è morto e Valkey serve lo stesso payload da tre ore con hit rate al 100% |

### 9.2 Test di proprietà su dati sintetici

Tre generatori, da eseguire in CI su un database effimero. Sono i tre scenari in cui i difetti si manifestano tutti insieme.

1. **Buco di tre ore in prime time.** Trenta giorni sintetici con profilo diurno realistico; si cancellano i cicli dalle 20:00 alle 23:00 di tre giorni consecutivi. Attese: `kpi.avg` (normalizzata sul profilo) varia meno dell'1%; `kpi.coverage` scende a ~98,8%; `comparable` diventa `false` nel confronto con il mese precedente; i bucket mancanti sono `null` e non `0`.
2. **I due giorni di cambio ora**, ultima domenica di ottobre e di marzo. Attese: la cella `(dom, 02)` di ottobre ha `n = 2` e media pesata corretta; quella di marzo ha `n = 0` ed esce grigia, non zero; `expected_s` del giorno vale 90 000 e 82 800 e la copertura resta ≤ 100%; nessun bucket duplicato né mancante nella serie.
3. **Rename + riconnessione + trasferimento di server nello stesso ciclo.** Attese: il giocatore conta **una volta** nel totale e negli unici; il trasferimento `duels_6 → lobby_1` **non** spezza la sessione (grazia di 3 cicli); la riconnessione con `connection-time` diverso **la** spezza; nessuna sessione duplicata dopo un riavvio del poller a metà.
4. **Modalità intermittente**: `evento_x` presente 10 tick al giorno con 200 giocatori. Atteso: media giornaliera ≈ 200 · 10 · 30 / 86 400 ≈ 0,7, **non** 200.
5. **Cadenza cambiata a metà storia** (30 → 20 s al giorno 15). Attese: nessuna copertura fuori da `[0,1]`; `deltas = [20, 30]` nel payload del range che li contiene; le medie prima e dopo restano continue.
6. **Sessione a cavallo della mezzanotte** (23:40 → 00:20): i secondi si affettano sui due giorni, la sessione si conta **una volta sola** sul giorno di inizio, il giocatore compare negli unici di entrambi.

### 9.3 Test di carico di fase 2

Lo scenario che oggi non esiste da nessuna parte, ed è il solo che dice se questo disegno rispetta il proprio contratto: **poller a P reale + rollup + worker di warm + 20 login concorrenti, tutti insieme**.

Verifiche: login p95 < 400 ms (budget già scritto in fase 1); `metamc_event_loop_delay_ms{0.99}` < 100 ms; `/health/ready` mai 503; `metamc_stats_warm_deferred_total` stabile; nessun ciclo di poll che sfora il proprio slot. Il budget da scrivere e sorvegliare non è in GB di tabella ma in **WAL al giorno** e **tuple morte al minuto per tabella**: con il disegno di §8.5 le scritture per giocatore scendono da ~10 M/giorno a ~360k, ed è quel rapporto che va verificato sul campo, non stimato.

Da misurare **prima** di congelare qualunque formula di costo: l'**RTT verso il Redis di gioco**, che è un'altra istanza e presumibilmente un altro host. `ceil(P/BATCH) × RTT` è il termine dominante del ciclo e tutte le stime di progetto assumevano implicitamente loopback.

### 9.4 Ordine di implementazione

Ogni passo ha un cancello: se non passa, non si prosegue.

**Passo 0 — le sonde da trenta secondi.** Sul Redis di gioco: `DBSIZE`; `SELECT DISTINCT server` sull'insieme online (una volta al giorno per una settimana: è l'unico modo per conoscere N e per validare la regexp del prefisso); `PTTL` su 50 chiavi; mediana di `connection-time/1000 − now` sui soli giocatori entrati nell'ultimo intervallo (lo skew, misurato su quella popolazione e non su tutte le sessioni, che darebbe l'età mediana delle sessioni); la sonda IP-contro-proxy di §8.1. *Cancello: senza N e senza il verdetto sull'IP non si scrive SQL.*

**Passo 1 — migration 011, unica.** Schema `stats` come da §6.1, ruoli `metamc_stats` e `metamc_ingest`, `stats.partitioned_table` con le retention di §8.8, `ensure_partitions` / `drop_expired_partitions` con `SET TimeZone = 'UTC'` sulla funzione. *Cancello: `SELECT stats.ensure_partitions()` crea le partizioni attese e la potatura non tocca nulla dentro finestra.*

**Passo 2 — poller minimale.** Legge, deduplica **per `player_id`**, conta per modalità, scrive `sample_mode` (righe 0, 1, 2 comprese) e il registro dei cicli. Niente sessioni, niente geo, niente filtro ghost: il TTL di ~100 s è accertato, quindi i fantasmi permanenti non esistono e le regole R1/R4 (che costano lavoro per ciclo e coprono le sole modalità duels) non entrano. Restano registrati gratis `players` per server e il controincrocio con `duels:servers:*.players`. *Cancello: I1, I7, I8 verdi per 48 ore.*

**Passo 3 — rollup 5m/1h/1d** con watermark inizializzato a `now()`, catch-up limitato a 288 bucket per giro, lookback di un bucket, upsert totale, flag `final`. *Cancello: I2, I3, I4 verdi; ricostruzione completa da zero cronometrata su storico reale.*

**Passo 4 — endpoint `overview` senza cache.** Query di §6.6, `assertPayload`, misura di `build_ms{query}` per tutti e cinque i range. *Cancello: il range 90d, il più pesante, sotto i 500 ms.*

**Passo 5 — cache e worker.** `StatsCache` dietro `CacheService`, `warm()` sequenziale, hot-set per range, `warmOnBoot`, metriche di §7.9, endpoint `mode`. *Cancello: `cache_age_seconds` stabile sotto soglia per 24 ore; `singleflight_joined` non nullo dopo un test che colpisce una chiave fredda in parallelo.*

**Passo 6 — sessioni, `player_day`, unici.** Identità `(player_id, connection-time grezzo)`; `ended_at` sempre l'ultimo istante con prova, mai `now()`; chiusura idempotente con `ON CONFLICT DO UPDATE ... WHERE EXCLUDED.ended_at > session.ended_at` (il `DO NOTHING` puro fa sparire la seconda metà di una sessione riadottata dopo una fase degradata); scrittura di `player_day` all'apertura e alla chiusura, mai per ciclo. *Cancello: I6, I10, I11 verdi; il test di proprietà 3 e 6 passa.*

**Passo 7 — geolocalizzazione**, solo se il passo 0 ha dato via libera. Reader, job di aggiornamento, colonna `country`, `geo_range`, redazione dei log e guardia in CI. *Cancello: I5 verde e `XX` sotto l'1%.*

**Passo 8 — heatmap, periodo precedente, mappa nel client.** Prefetch su hover, attribuzione DB-IP nel footer. *Cancello: test di proprietà 2 passa.*

**Passo 9 — deroga §9 e carico.** Test di invarianza byte-per-byte (I13), riga in `docs/security/deviations.md`, scenario di §9.3. *Cancello: budget di login rispettato con tutto acceso.*

### 9.5 Incognite ancora aperte

**Elenco dei prefissi `server` e numero di modalità (N).** Ignoto: il campione mostra solo `duels_6`. `stats.mode` si auto-popola e un prefisso mai visto non fa fallire un ciclo, quindi non blocca nulla — ma restano da mappare a mano etichette e ordine, e la regola `regexp_replace(server, '_[0-9]+$', '')` va rivista se un nome finisce legittimamente con cifre (`4v4_2`, `bedwars2_3`): è il caso che `stats.mode_alias` copre con una riga, e va verificato **prima** di accumulare storico, perché correggerlo dopo significa ricalcolare `mode_id` su tutto il partizionato. *Se N ≈ 20*: tutto come scritto. *Se N ≈ 60*: `series` passa da ~37 a ~81 kB grezzi e scatta la soglia già scritta (`payload_bytes{raw} > 120 kB`) → overview con le prime 8 modalità più una serie `__other__` aggregata, elenco completo solo su richiesta esplicita; e la retention del grezzo scende da 30 a 14 giorni.

**Definizione concordata di «online».** Chiave viva, sessione attiva, o conteggio del proxy Velocity sono tre numeri diversi, e il committente confronterà il nostro con quello che vede sul server. Il progetto sceglie «identità distinte con una chiave viva»: va **detto** e scritto accanto al KPI. *Se esiste un conteggio per proxy*: è l'osservatore migliore in assoluto (è il proxy a sapere davvero chi è connesso) e va usato come controincrocio permanente, con lo scarto esposto come metrica. *Se non esiste*: resta la somma di `duels:servers:*.players`, che copre le sole modalità duels e va interpretata come parziale.

**`ip` del giocatore o del proxy.** Risolta dal passo 0, ma finché non è eseguito è aperta. *Se è del proxy*: la funzione geografica esce dal design, `geo: null`, e tutta la §8 non si scrive.

**`identifier` può essere riassegnato?** Non verificabile dal campione, e l'intera scelta della chiave degli unici ci si appoggia. Presidio già nello schema: indice unico parziale su `stats.player.uuid`, che rende la collisione «stesso identifier, uuid diverso» una query e non una sorpresa. *Se venisse riciclato*: si passa a `uuid` come chiave, con +57% su `player_day` e +80% sui suoi indici, e la migrazione resta possibile **solo perché** `uuid` e `premium_id` sono salvati dal giorno uno sull'anagrafica.

**Fuso in cui il plugin scrive `registrationDate`** (`2024-07-20 09:46:17.0`, cioè `java.sql.Timestamp.toString()`, senza offset). *Senza risposta*: il campo resta `text`, non ci si fa aritmetica, e «nuovi giocatori di oggi» sbaglia per chi si registra fra mezzanotte e le 02:00. *Con la risposta*: diventa una `date` interrogabile. Si risolve senza chiedere a nessuno, confrontando `registrationDate` con `connection-time` (epoch ms, non ambiguo) dello stesso hash di un giocatore appena registrato: lo scarto **è** l'offset. Va fatto al passo 0 e l'offset misurato va registrato in `stats.ingest_state`.

**Picco reale di giocatori contemporanei (P) e unici giornalieri (U).** Nessun tipo è al limite (`players integer` regge 2,1 miliardi) e nessuna formula di dimensionamento del grezzo dipende da P. Spostano due sole soglie: sopra P ≈ 20 000 la scrittura per sessione va spostata fuori da Postgres; sopra U ≈ 200 000 `player_day_mode` diventa il termine dominante e la sua retention va rinegoziata. Sono modifiche di parametro, non di struttura.

**Retention del grezzo, da porre al committente nei termini giusti.** Non è «quanti GB teniamo»: è **«per quanti giorni indietro potremo ancora correggere un numero sbagliato»**. 14 / 30 / 90 giorni = ~100 / 200 / 600 MB, e i rollup non cambiano. La risposta cambia se la domanda è posta così.

**Payload dei canali `duels:player:join` / `duels:player:quit`.** Il legacy li usa come semplici trigger. Nessuna parte di questo disegno ci si appoggia — il conteggio viene **sempre** da una lettura, mai da un'accumulazione di eventi, perché un solo messaggio perso falserebbe il numero per sempre in modo monotono e invisibile. *Se il payload contenesse lo username*: si chiuderebbe l'unico punto cieco strutturale del polling, cioè le sessioni più brevi dell'intervallo di campionamento, e `sessions` / `new_network` passerebbero da «esatti salvo sessioni sotto delta» a esatti. Lo schema non cambia di una riga.

**`stats` è un modulo RBAC a sé o riusa un modulo esistente?** Cambia la riga `requireLevel(actorOf(req), 'stats', 1)` e il seed nella migration dei moduli. Se fosse a sé, va deciso anche cosa significhi il livello 2 su una schermata di sola lettura: probabilmente nulla, e allora il modulo ha un solo livello utile, che è un odore da guardare prima di crearlo.

**Linea fantasma anche per modalità?** Oggi solo sul totale (2 array invece di N+1). *Se servisse per modalità*: raddoppia la parte grossa del payload e conviene spostare il confronto per-modalità sulla sola schermata di dettaglio, dove le serie sono una sola.

**SSE (rotta già predisposta in `deploy/nginx.conf`).** *Se entra in fase 2*: `onlineNow` smette di essere un header e viaggia sul canale (~40 byte ogni 30 s), il polling dell'overview scende a una volta per apertura di schermata, e la deroga ETag/`no-cache` si può **ritirare** — che è sempre preferibile a mantenerla.