-- ============================================================================
-- Migration 015 — i due moduli RBAC del modulo Duels.
--
-- PERCHE' DUE E NON UNO. I livelli sono un ordine totale con un significato
-- dichiarato — 0 nessuno, 1 lettura, 2 scrittura, 3 gestione — e usare «2» per
-- dire «puo' vedere i dati personali» torcerebbe quel vocabolario in tutto il
-- sistema. Le partite sono numeri aggregati; le valutazioni sono nomi di
-- persone, UUID e testo libero scritto dai giocatori. Non e' detto che chi
-- guarda i grafici debba leggere i commenti, e con un modulo solo non ci
-- sarebbe modo di dirlo.
--
--   duels           1 = andamento (aggregati)     3 = configurazione
--   duels_feedback  1 = valutazioni e ricerca     2 = moderazione (non fatta)
--                                                 3 = retention ed export
--
-- I moduli si aggiungono QUI e non da runtime: la 003 revoca INSERT, UPDATE e
-- DELETE su `auth.modules` a `metamc_app` (003_rbac.sql:239). Il vocabolario
-- del sistema non e' dato che l'applicazione possa scriversi da sola.
-- ============================================================================
SET LOCAL lock_timeout      = '3s';
SET LOCAL statement_timeout = '60s';

-- 75 e 76: fra `statistiche` (70) e `server` (80). L'ordine dei moduli e'
-- quello in cui compaiono nella matrice dei permessi.
INSERT INTO auth.modules (key, name, sort_order) VALUES
  ('duels',          'Duels',             75),
  ('duels_feedback', 'Valutazioni Duels', 76);

-- ---------------------------------------------------------------------------
-- La matrice.
--
-- IL TRIGGER VA SPENTO PER LA DURATA DEL SEED, e questa e' la differenza con
-- la 003. Li' `t_protect_system_role_permissions` veniva creato DOPO il seed
-- (il commento a 003_rbac.sql:166-167 lo dice), quindi la matrice di `owner`
-- si popolava prima che la protezione esistesse. Qui il trigger c'e' gia' e
-- rifiuta QUALUNQUE insert sui permessi di un ruolo di sistema — e `owner` lo
-- e'.
--
-- Spegnerlo si puo' perche' il runner delle migration e' `metamc_migrate`, che
-- possiede lo schema `auth` (001_schemas_roles_audit.sql:45) e quindi le sue
-- tabelle: `ALTER TABLE ... DISABLE TRIGGER` richiede la proprieta'.
--
-- NON si tocca `t_bump_role_permissions` (003_rbac.sql:109). E' quello che
-- alza `permissions_version` a tutti gli utenti dei ruoli toccati, cioe' cio'
-- che fa comparire le voci nuove ALLE SESSIONI GIA' APERTE: lo snapshot di
-- autorizzazione vive in Redis senza scadenza e si ricostruisce solo al cambio
-- di versione. Spegnendolo, nessuno vedrebbe il modulo nuovo fino al prossimo
-- login — e con sessioni da quattordici giorni (D-11) vorrebbe dire due
-- settimane.
-- ---------------------------------------------------------------------------
ALTER TABLE auth.role_permissions DISABLE TRIGGER t_protect_system_role_permissions;

-- Le righe a livello 0 si scrivono, come nel seed della 003: «non ha accesso»
-- e' un fatto dichiarato, non l'assenza di una riga.
--
-- `owner` ha 3 su ENTRAMBI, e non e' simmetria estetica: la matrice determina
-- la dominanza, cioe' chi puo' agire su chi (003_rbac.sql:186-193). Se un
-- ruolo non-owner avesse su un modulo un livello superiore a quello di admin,
-- admin smetterebbe di dominarlo.
--
-- `moderatore` ha 1 su `duels_feedback` e `dev` ha 0: chi modera la comunita'
-- legge i commenti dei giocatori, chi sviluppa guarda i numeri. E' il verso
-- che separa un dato personale da un aggregato.
INSERT INTO auth.role_permissions (role_id, module_id, level)
SELECT r.id, m.id, v.level
FROM (VALUES
  ('owner',      'duels', 3), ('owner',      'duels_feedback', 3),
  ('admin',      'duels', 3), ('admin',      'duels_feedback', 2),
  ('dev',        'duels', 1), ('dev',        'duels_feedback', 0),
  ('moderatore', 'duels', 1), ('moderatore', 'duels_feedback', 1)
) AS v(role_key, module_key, level)
JOIN auth.roles   r ON r.key = v.role_key
JOIN auth.modules m ON m.key = v.module_key;

ALTER TABLE auth.role_permissions ENABLE TRIGGER t_protect_system_role_permissions;
