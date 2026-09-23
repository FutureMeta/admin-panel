-- ============================================================================
-- Migration 025 — chi si e' visto, e quando l'ultima volta.
--
-- PERCHE'. I giocatori distinti del periodo e la mappa si contavano
-- rileggendo `player_day` — una riga per giocatore e giorno — su tutta la
-- finestra, a ogni giro di warm, per ogni range. Il costo cresceva con lo
-- storico: con un anno di dati alla scala della rete (5.000 giocatori al
-- giorno, diciannove server) la panoramica a 1 anno costava 3 secondi, 2,9
-- dei quali solo per la mappa, e il dettaglio di una modalita' 4,5 — sulla
-- macchina di sviluppo. In produzione il tetto e' lo statement_timeout di 10
-- secondi.
--
-- Qui c'e' UNA riga per giocatore e UNA per coppia giocatore-server: l'ultimo
-- giorno in cui si e' visto, e l'ultimo paese noto con il suo giorno. Ogni
-- finestra delle statistiche finisce OGGI, quindi «visto nel periodo» e'
-- «visto l'ultima volta dal primo giorno del periodo in poi», e il paese del
-- periodo e' l'ultimo noto se cade dentro la finestra, altrimenti nessuno —
-- la stessa regola del `DISTINCT ON` che sostituisce («prima un paese noto,
-- poi il giorno piu' recente»). Il costo va con i giocatori, non con i giorni.
--
-- LE TENGONO I TRIGGER, non l'ingest. Cosi' valgono per chiunque scriva
-- `player_day` — l'ingest, un ripristino a mano, i test che seminano con un
-- INSERT — e non possono restare indietro: sono nella stessa transazione.
-- Il costo e' un upsert per riga NUOVA di `player_day` (una per giocatore al
-- giorno), e uno quando il paese passa da NULL a noto.
--
-- DATO PERSONALE, come `player_day` da cui viene, e mai piu' di quello: un
-- giorno e un paese per giocatore invece di uno per giorno. La retention deve
-- seguire quella di `player_day` e `player_day_server`: chi un giorno mettera'
-- in calendario `drop_expired_partitions` deve cancellare qui le righe con
-- `last_day` fuori dalla stessa finestra. Nessuna lettura ne dipende: ogni
-- range guarda al piu' 365 giorni, e una riga piu' vecchia non entra mai in
-- una finestra.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout      = '3s';
SET LOCAL statement_timeout = '120s';

CREATE TABLE stats.player_seen (
  player_id   integer PRIMARY KEY,
  last_day    date    NOT NULL,
  -- L'ultimo paese NOTO e il giorno in cui lo era. NULL tutti e due se il
  -- giocatore non e' mai stato visto con la geolocalizzazione attiva.
  country     stats.country_code,
  country_day date,
  CONSTRAINT player_seen_country_pair CHECK ((country IS NULL) = (country_day IS NULL)),
  CONSTRAINT player_seen_country_day  CHECK (country_day <= last_day)
)
-- Ogni giocatore attivo aggiorna la sua riga una volta al giorno. Con il
-- default (20%) le righe morte si accumulano per giorni, e le letture
-- index-only tornano a leggere lo heap: misurato, 400 ms invece di 90 sul
-- range di un anno, finche' un VACUUM non passa.
WITH (autovacuum_vacuum_scale_factor = 0.02);
CREATE INDEX player_seen_last_day_idx ON stats.player_seen (last_day) INCLUDE (country, country_day);

COMMENT ON TABLE stats.player_seen IS
  'DATO PERSONALE, derivato da player_day dai trigger: ultimo giorno visto e ultimo paese noto, una riga per giocatore. Retention come player_day.';

CREATE TABLE stats.player_server_seen (
  server_id smallint NOT NULL REFERENCES stats.server(server_id),
  player_id integer  NOT NULL,
  last_day  date     NOT NULL,
  PRIMARY KEY (server_id, player_id)
) WITH (autovacuum_vacuum_scale_factor = 0.02);
-- «Chi e' passato da questi server dal giorno X»: i server di una modalita'
-- sono pochi, e per ciascuno si legge solo la coda recente.
CREATE INDEX player_server_seen_day_idx ON stats.player_server_seen (server_id, last_day) INCLUDE (player_id);

COMMENT ON TABLE stats.player_server_seen IS
  'DATO PERSONALE, derivato da player_day_server dai trigger: ultimo giorno visto per giocatore e server. Retention come player_day_server.';

-- SECURITY DEFINER: scrive l'ingest, che su queste tabelle non ha e non deve
-- avere privilegi propri.
CREATE FUNCTION stats.fn_player_seen() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  INSERT INTO stats.player_seen AS s (player_id, last_day, country, country_day)
  VALUES (NEW.player_id, NEW.day, NEW.country, CASE WHEN NEW.country IS NOT NULL THEN NEW.day END)
  ON CONFLICT (player_id) DO UPDATE SET
    last_day    = GREATEST(s.last_day, EXCLUDED.last_day),
    -- Un paese noto vince se e' di un giorno uguale o piu' recente. `>=` e non
    -- `>`: lo stesso giorno puo' passare da NULL a noto, mai il contrario.
    country     = CASE WHEN EXCLUDED.country_day >= s.country_day OR s.country_day IS NULL
                       THEN coalesce(EXCLUDED.country, s.country) ELSE s.country END,
    country_day = CASE WHEN EXCLUDED.country_day >= s.country_day OR s.country_day IS NULL
                       THEN coalesce(EXCLUDED.country_day, s.country_day) ELSE s.country_day END;
  RETURN NULL;
END $$;

CREATE FUNCTION stats.fn_player_server_seen() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  INSERT INTO stats.player_server_seen AS s (server_id, player_id, last_day)
  VALUES (NEW.server_id, NEW.player_id, NEW.day)
  ON CONFLICT (server_id, player_id) DO UPDATE SET last_day = GREATEST(s.last_day, EXCLUDED.last_day);
  RETURN NULL;
END $$;

-- UNA RIGA TOLTA SI RICALCOLA DA CIO' CHE RESTA. Nessun ruolo ha DELETE su
-- `player_day` — la retention e' un DROP di partizione, che non passa di qui
-- e non serve che passi: le righe che lascerebbe indietro sono piu' vecchie
-- di qualunque finestra. Ma un DELETE a mano, domani la cancellazione di un
-- giocatore, e oggi i test che ripuliscono fra un caso e l'altro, non devono
-- lasciare qui una persona che nei giorni non c'e' piu'. I trigger AFTER
-- scattano a fine istruzione: vedono gia' cio' che resta.
CREATE FUNCTION stats.fn_player_unseen() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE r record;
BEGIN
  SELECT max(day) AS last_day,
         (array_agg(country ORDER BY day DESC) FILTER (WHERE country IS NOT NULL))[1] AS country,
         max(day) FILTER (WHERE country IS NOT NULL) AS country_day
    INTO r FROM stats.player_day WHERE player_id = OLD.player_id;
  IF r.last_day IS NULL THEN
    DELETE FROM stats.player_seen WHERE player_id = OLD.player_id;
  ELSE
    UPDATE stats.player_seen
       SET last_day = r.last_day, country = r.country, country_day = r.country_day
     WHERE player_id = OLD.player_id;
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION stats.fn_player_server_unseen() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE d date;
BEGIN
  SELECT max(day) INTO d FROM stats.player_day_server
   WHERE server_id = OLD.server_id AND player_id = OLD.player_id;
  IF d IS NULL THEN
    DELETE FROM stats.player_server_seen WHERE server_id = OLD.server_id AND player_id = OLD.player_id;
  ELSE
    UPDATE stats.player_server_seen SET last_day = d
     WHERE server_id = OLD.server_id AND player_id = OLD.player_id;
  END IF;
  RETURN NULL;
END $$;

-- Sul padre partizionato: PostgreSQL li clona su ogni partizione, anche su
-- quelle che `ensure_partitions` creera' domani.
CREATE TRIGGER t_player_seen AFTER INSERT ON stats.player_day
  FOR EACH ROW EXECUTE FUNCTION stats.fn_player_seen();
-- L'upsert dell'ingest riempie il paese quando la prima osservazione del
-- giorno era a geolocalizzazione spenta (COALESCE): e' l'unico UPDATE che
-- cambia qualcosa qui, e il WHEN lo filtra senza chiamare la funzione.
CREATE TRIGGER t_player_seen_country AFTER UPDATE OF country ON stats.player_day
  FOR EACH ROW WHEN (OLD.country IS DISTINCT FROM NEW.country)
  EXECUTE FUNCTION stats.fn_player_seen();
CREATE TRIGGER t_player_server_seen AFTER INSERT ON stats.player_day_server
  FOR EACH ROW EXECUTE FUNCTION stats.fn_player_server_seen();
CREATE TRIGGER t_player_unseen AFTER DELETE ON stats.player_day
  FOR EACH ROW EXECUTE FUNCTION stats.fn_player_unseen();
CREATE TRIGGER t_player_server_unseen AFTER DELETE ON stats.player_day_server
  FOR EACH ROW EXECUTE FUNCTION stats.fn_player_server_unseen();

-- I TRIGGER PRIMA DEL RIEMPIMENTO: creandoli si prende un lock che ferma le
-- scritture dell'ingest fino al COMMIT, quindi niente puo' passare fra la
-- fotografia qui sotto e il primo trigger.
INSERT INTO stats.player_seen (player_id, last_day, country, country_day)
SELECT player_id,
       max(day),
       (array_agg(country ORDER BY day DESC) FILTER (WHERE country IS NOT NULL))[1],
       max(day) FILTER (WHERE country IS NOT NULL)
  FROM stats.player_day
 GROUP BY player_id;

INSERT INTO stats.player_server_seen (server_id, player_id, last_day)
SELECT server_id, player_id, max(day)
  FROM stats.player_day_server
 GROUP BY server_id, player_id;

-- Le statistiche subito, non al primo passaggio di autovacuum: senza, il primo
-- giro di warm pianifica su una tabella che per il planner e' vuota.
ANALYZE stats.player_seen, stats.player_server_seen;

GRANT SELECT ON stats.player_seen, stats.player_server_seen TO metamc_stats;

COMMIT;
