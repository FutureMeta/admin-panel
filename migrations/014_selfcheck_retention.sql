-- ============================================================================
-- Migration 014 — il giro degli invarianti puo' potare la propria storia.
--
-- PERCHE'. `stats.integrity_check` esiste dalla 011 con i nomi degli otto
-- controlli scritti sopra di lei, e fino a oggi non l'ha scritta nessuno: il
-- job di §9.1 non era implementato. Ora lo e', e scrive otto righe all'ora.
--
-- Sono poche — circa 123 000 all'anno — ma ognuna porta un `detail` jsonb con
-- le righe colpevoli, e una tabella che nessuno pota cresce finche' qualcuno
-- se ne accorge. Novanta giorni bastano a rispondere alla sola domanda che si
-- fa a quella storia: «da quando?».
--
-- PERCHE' UN GRANT E NON UN DROP DI PARTIZIONE. Lo schema toglie il DELETE a
-- `metamc_stats_rw` di proposito — la retention e' un DROP di partizione, e un
-- ruolo che puo' cancellare righe puo' cancellare le righe sbagliate. Ma
-- `integrity_check` non e' partizionata e non ha senso che lo diventi: sono
-- otto righe l'ora, e una partizione al mese per potarne 5 800 sarebbe
-- macchinario per niente.
--
-- Resta quindi un'ECCEZIONE NOMINATA, la seconda dello schema dopo
-- `session_open`, e vale per una tabella che contiene solo esiti di controlli:
-- cancellarne una non perde un fatto misurato, perde un verbale. Nessun'altra
-- tabella dello schema riceve DELETE con questa migration.
-- ============================================================================
SET LOCAL lock_timeout      = '3s';
SET LOCAL statement_timeout = '60s';

GRANT DELETE ON stats.integrity_check TO metamc_stats_rw;

COMMENT ON TABLE stats.integrity_check IS
  'Esiti del job stats-selfcheck (§9.1), una riga per controllo per giro, anche a zero violazioni: una tabella che si popola solo in caso di guasto non distingue «tutto bene» da «il job e'' morto». Retention 90 giorni, cancellata dal job stesso.';
