-- ============================================================================
-- Migration 023 — «Lingue»: un modulo per ciascuna delle due schermate.
--
-- ----------------------------------------------------------------------------
-- 1. PERCHE' UNA CHIAVE NUOVA.
--
-- La 022 metteva Bundle ed Elenco sullo stesso modulo, `lingue`, e il livello
-- 3 — «Gestione» nella matrice — voleva dire anche «crea le lingue e le
-- accende per tutti i giocatori», senza che nessuna riga lo dicesse. E' la
-- stessa trappola della 018 e della 020: un permesso che non compare e' un
-- permesso che nessuno revoca, e non si poteva dare l'Elenco senza i testi o
-- i testi senza l'Elenco.
--
-- Adesso ogni schermata ha la sua riga, sotto l'area «Lingue», come i Duels:
--
--   Bundle (`lingue`)        1 = legge i testi
--                            2 = traduce e corregge, anche con l'AI
--   Elenco (`lingue_elenco`) 1 = vede le lingue
--                            3 = le crea, le accende, le rinomina, le riordina
--
-- I livelli che una riga non usa restano concedibili — la matrice e' un
-- ordine totale — e valgono quanto quello sotto.
--
-- ----------------------------------------------------------------------------
-- 2. NESSUNO PERDE NIENTE.
--
-- Ogni ruolo — di sistema o creato dal pannello — riceve su Elenco lo stesso
-- livello che aveva su Lingue, e cosi' ogni override individuale. Chi prima
-- gestiva le lingue le gestisce ancora; chi le vedeva le vede ancora.
-- `t_bump_role_permissions` e `t_bump_user_permissions` restano accesi: sono
-- loro ad alzare `permissions_version`, e senza le sessioni gia' aperte non
-- vedrebbero la riga nuova per giorni.
--
-- ----------------------------------------------------------------------------
-- 3. I NOMI SONO QUELLI DEL MENU, come nella 017: nella matrice si concede
-- una SCHERMATA, e il raggruppamento «Lingue» dice gia' di che cosa.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout      = '3s';
SET LOCAL statement_timeout = '60s';

UPDATE auth.modules SET name = 'Bundle' WHERE key = 'lingue';

-- 84: subito dopo `lingue` (83), cosi' l'area resta contigua.
INSERT INTO auth.modules (key, name, sort_order) VALUES ('lingue_elenco', 'Elenco', 84);

-- Il trigger di protezione rifiuta qualunque scrittura sui permessi di un
-- ruolo di sistema, e `owner` lo e': si spegne per la durata della copia,
-- come nella 015, nella 018 e nella 020.
ALTER TABLE auth.role_permissions DISABLE TRIGGER t_protect_system_role_permissions;

INSERT INTO auth.role_permissions (role_id, module_id, level)
SELECT rp.role_id, elenco.id, rp.level
FROM auth.role_permissions rp
JOIN auth.modules lingue ON lingue.id = rp.module_id AND lingue.key = 'lingue'
CROSS JOIN (SELECT id FROM auth.modules WHERE key = 'lingue_elenco') elenco;

ALTER TABLE auth.role_permissions ENABLE TRIGGER t_protect_system_role_permissions;

INSERT INTO auth.user_permissions (user_id, module_id, level, granted_by, granted_at)
SELECT up.user_id, elenco.id, up.level, up.granted_by, up.granted_at
FROM auth.user_permissions up
JOIN auth.modules lingue ON lingue.id = up.module_id AND lingue.key = 'lingue'
CROSS JOIN (SELECT id FROM auth.modules WHERE key = 'lingue_elenco') elenco;

COMMIT;
