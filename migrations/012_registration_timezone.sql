-- ============================================================================
-- Migration 012 — il fuso di `registrationDate` e' un FUSO, non un offset.
--
-- PERCHE'. La 011 prevedeva `stats.ingest_state.registration_offset_min`, un
-- intero di minuti misurato una volta e poi applicato per sempre. La sonda del
-- passo 0, eseguita in produzione ad agosto su 102 campioni recenti, ha dato
-- il picco a +120 minuti: la JVM del server di gioco sta su un fuso europeo,
-- non su UTC.
--
-- E li' sta il difetto: a novembre lo stesso server scrivera' +60. Un offset
-- costante sbaglierebbe di un'ora OGNI registrazione fatta d'inverno, e
-- sposterebbe di un giorno chiunque si registri fra mezzanotte e l'una — cioe'
-- produrrebbe un «nuovi giocatori di oggi» sbagliato in modo stabile e
-- plausibile, che e' la classe di errore contro cui e' costruito tutto il
-- resto di questo schema. `civil_day` gia' fa la cosa giusta: si nomina il
-- fuso e si lascia decidere a PostgreSQL quando scatta l'ora legale.
--
-- La colonna vecchia si elimina invece di restare accanto alla nuova: e' stata
-- sempre NULL (niente l'ha mai scritta) e due sorgenti per lo stesso fatto
-- sono il modo in cui una delle due diventa quella sbagliata.
-- ============================================================================
SET LOCAL lock_timeout      = '3s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE stats.ingest_state DROP COLUMN registration_offset_min;

ALTER TABLE stats.ingest_state
  ADD COLUMN registration_tz text
    -- Controllo di FORMA, non di esistenza: l'elenco dei fusi vive in un
    -- catalogo e un CHECK non puo' interrogarlo (dev'essere immutabile). Un
    -- nome inesistente si manifesta alla prima conversione con «time zone not
    -- recognized», che e' un messaggio che si capisce.
    CHECK (registration_tz IS NULL
           OR registration_tz ~ '^(UTC|[A-Za-z]+(/[A-Za-z0-9_+-]+){1,2})$');

COMMENT ON COLUMN stats.ingest_state.registration_tz IS
  'Fuso in cui la JVM del server di gioco scrive registrationDate. NULL = non ancora misurato, e finche'' e'' NULL stats.player.registered_at resta NULL: meglio assente che sbagliato di un''ora sul confine del giorno.';

-- Misurato, non supposto: sonda del 2026-08-20, 102 campioni recenti, picco a
-- +120 minuti. Lo scarto di ogni campione vale `offset - eta_account` e l'eta'
-- non e' mai negativa, quindi la risposta e' il MASSIMO della distribuzione,
-- non la mediana.
--
-- Non si distingue Europe/Rome da Paris, Berlin o Madrid: hanno gli stessi
-- offset e le stesse regole di ora legale, quindi la conversione e' identica.
-- Si sceglie Rome perche' e' il fuso che il resto del pannello gia' nomina.
-- Se il server di gioco si sposta, e' una UPDATE su una riga.
UPDATE stats.ingest_state SET registration_tz = 'Europe/Rome' WHERE id = 1;

-- La conversione, in un posto solo.
--
-- `registrationDate` arriva come '2024-07-20 09:46:17.0': e'
-- java.sql.Timestamp.toString(), cioe' l'ora di parete della JVM senza
-- offset. Si taglia ai secondi, si legge come timestamp SENZA fuso e si
-- interpreta nel fuso dichiarato — che e' esattamente cio' che significa quel
-- testo.
--
-- LIMITE DICHIARATO: nell'ora ripetuta del cambio d'ora di ottobre una stessa
-- ora di parete esiste due volte e AT TIME ZONE ne sceglie una. E' un errore
-- di un'ora su una registrazione all'anno, contro l'errore di un'ora su TUTTE
-- le registrazioni invernali che dava l'offset costante.
CREATE FUNCTION stats.registered_at_of(p_raw text, p_tz text) RETURNS timestamptz
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN p_raw IS NULL OR p_tz IS NULL OR btrim(p_raw) = '' THEN NULL
    ELSE substring(btrim(p_raw) FROM 1 FOR 19)::timestamp AT TIME ZONE p_tz
  END
$$;

-- La 011 e' applicata e non si tocca: il suo commento su stats.player rimanda
-- a una colonna che da qui in poi non esiste piu'. Questo lo sovrascrive, cosi'
-- chi legge la tabella trova il meccanismo vero e non quello superato.
COMMENT ON COLUMN stats.player.registered_at IS
  'registrationDate convertito con stats.registered_at_of(registered_raw, ingest_state.registration_tz). Resta NULL finche'' il fuso non e'' stato misurato. Supera registration_offset_min, eliminata dalla migration 012: un offset costante sbaglia di un''ora tutte le registrazioni invernali.';

GRANT EXECUTE ON FUNCTION stats.registered_at_of(text, text) TO metamc_stats_rw, metamc_stats;
