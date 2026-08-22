-- ============================================================================
-- Migration 018 — i due moduli RBAC delle schermate Modes e Maps.
--
-- PERCHE' NON BASTAVA `duels` A LIVELLO 3. Era la scorciatoia della 015, presa
-- quando le due schermate non esistevano: un livello alto su un modulo che si
-- chiama «Trends» apriva la configurazione del gioco. Nella matrice dei
-- permessi non c'era una riga da cui capirlo — chi concedeva «Gestione» su
-- Trends stava concedendo di cambiare le regole con cui si gioca, e la matrice
-- non lo diceva da nessuna parte.
--
-- Un permesso che non compare e' un permesso che nessuno revoca.
--
-- I QUATTRO LIVELLI HANNO TUTTI UN SIGNIFICATO, ed e' il vocabolario del
-- pannello (0 nessuno, 1 lettura, 2 scrittura, 3 gestione) applicato a queste
-- schermate:
--
--   1  aprire la schermata e leggere la configurazione;
--   2  salvare le modifiche;
--   3  ELIMINARE una modalita' o una mappa.
--
-- L'eliminazione sta un gradino sopra il salvataggio perche' e' l'unica cosa
-- irreversibile di queste due schermate: togliere una modalita' porta via a
-- cascata i suoi settings, i suoi kit e i preferiti dei giocatori che la
-- puntano. Un livello che non fa niente sarebbe stato peggio — le manopole
-- morte insegnano a non fidarsi di quelle vive.
--
-- I moduli si aggiungono QUI e non da runtime: la 003 revoca INSERT su
-- `auth.modules` a `metamc_app` (003_rbac.sql:239).
-- ============================================================================
SET LOCAL lock_timeout      = '3s';
SET LOCAL statement_timeout = '60s';

-- 77 e 78: subito dopo `duels` (75) e `duels_feedback` (76), prima di `server`
-- (80). L'ordine dei moduli e' quello in cui compaiono nella matrice, e il
-- gruppo «Duels» resta contiguo.
INSERT INTO auth.modules (key, name, sort_order) VALUES
  ('duels_modes', 'Modes', 77),
  ('duels_maps',  'Maps',  78);

-- ---------------------------------------------------------------------------
-- La matrice.
--
-- Il trigger va spento per la durata del seed, come nella 015: rifiuta
-- qualunque insert sui permessi di un ruolo di sistema, e `owner` lo e'.
-- `t_bump_role_permissions` invece NON si tocca — e' quello che alza
-- `permissions_version` e fa comparire le voci nuove alle sessioni GIA'
-- aperte. Spegnendolo, con sessioni da quattordici giorni (D-11), nessuno
-- vedrebbe le due schermate per due settimane.
-- ---------------------------------------------------------------------------
ALTER TABLE auth.role_permissions DISABLE TRIGGER t_protect_system_role_permissions;

-- `dev` a 1 e non a 0: guardare com'e' configurata una modalita' e' la
-- domanda che si fa chi sviluppa, e non e' la stessa cosa che cambiarla.
-- `moderatore` a 0: la configurazione del gioco non c'entra con moderare.
--
-- `admin` a 3 su entrambi, come `owner`: la matrice determina la dominanza
-- (003_rbac.sql:186-193), e un ruolo con un livello superiore a quello di
-- admin smetterebbe di essere dominato da admin.
INSERT INTO auth.role_permissions (role_id, module_id, level)
SELECT r.id, m.id, v.level
FROM (VALUES
  ('owner',      'duels_modes', 3), ('owner',      'duels_maps', 3),
  ('admin',      'duels_modes', 3), ('admin',      'duels_maps', 3),
  ('dev',        'duels_modes', 1), ('dev',        'duels_maps', 1),
  ('moderatore', 'duels_modes', 0), ('moderatore', 'duels_maps', 0)
) AS v(role_key, module_key, level)
JOIN auth.roles   r ON r.key = v.role_key
JOIN auth.modules m ON m.key = v.module_key;

ALTER TABLE auth.role_permissions ENABLE TRIGGER t_protect_system_role_permissions;
