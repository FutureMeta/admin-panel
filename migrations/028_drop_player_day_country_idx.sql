-- ============================================================================
-- Migration 028 — via l'indice (day, country) di `player_day`.
--
-- SERVIVA ALLA MAPPA, e la mappa non passa piu' di li': dalla 025 legge
-- `stats.player_seen`, una riga per giocatore. La strada di riserva, quando
-- `player_seen` non e' al passo, legge `player_day` sui giorni e le serve
-- `player_id` — che questo indice non ha: le basta la chiave primaria
-- (day, player_id). Nessun'altra query filtra per paese.
--
-- Restava da pagare a ogni riga nuova di `player_day`, cioe' una volta per
-- giocatore al giorno, per sempre, e da tenere su disco per settecentotrenta
-- giorni di dati personali.
--
-- `session_player_idx` invece resta, anche se nessuna query del pannello lo
-- usa: costa un inserimento per sessione chiusa ed e' l'indice di chi cerca a
-- mano «quando ha giocato X».
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout      = '3s';
SET LOCAL statement_timeout = '60s';

-- Su una tabella partizionata l'indice del padre porta con se' quelli delle
-- partizioni. Niente CONCURRENTLY: non esiste per gli indici partizionati.
DROP INDEX stats.player_day_country_idx;

COMMIT;
