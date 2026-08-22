-- ============================================================================
-- Migration 017 — i due moduli Duels si chiamano come le schermate che aprono.
--
-- «Duels» e «Valutazioni Duels» erano i nomi di quando le schermate non
-- esistevano ancora. Adesso esistono e si chiamano Trends e Ratings: nella
-- matrice dei permessi si concede l'accesso a una SCHERMATA, e chi la concede
-- deve poter riconoscere quale senza tradurre. Un nome che non coincide con
-- la voce del menu costringe a indovinare, e indovinare sui permessi si
-- sbaglia in silenzio — nessuno si accorge di aver dato l'accesso sbagliato
-- finche' non lo usa qualcun altro.
--
-- Il contesto lo da' la CATEGORIA. Nella matrice le due righe stanno sotto
-- «Duels», come nella barra laterale, quindi «Trends» non e' ambiguo: il
-- raggruppamento dice gia' di che cosa.
--
-- LE CHIAVI NON SI TOCCANO. `duels` e `duels_feedback` sono il vocabolario su
-- cui il codice decide, e stanno in `ModuleKey`, nelle rotte e nelle sessioni
-- gia' aperte. Qui cambia solo l'etichetta che si legge.
--
-- E NEMMENO `sort_order`: 75 e 76 tengono le due righe fra `statistiche` e
-- `server`, che e' dove il gruppo le vuole.
--
-- I nomi si cambiano QUI e non da runtime: la 003 revoca UPDATE su
-- `auth.modules` a `metamc_app` (003_rbac.sql:239). Il vocabolario del
-- sistema non e' dato che l'applicazione possa riscriversi da sola.
--
-- Nessun permesso cambia, quindi NON si tocca `permissions_version`: le
-- sessioni aperte continuano con lo snapshot che hanno, ed e' corretto —
-- rinominare un'etichetta non concede e non toglie niente a nessuno.
-- ============================================================================
SET LOCAL lock_timeout      = '3s';
SET LOCAL statement_timeout = '60s';

UPDATE auth.modules SET name = 'Trends'  WHERE key = 'duels';
UPDATE auth.modules SET name = 'Ratings' WHERE key = 'duels_feedback';
