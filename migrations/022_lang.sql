-- ============================================================================
-- Migration 022 — «Lingue»: il modulo RBAC.
--
-- SOLO IL MODULO, E NESSUNA TABELLA. I testi che i giocatori vedono in gioco
-- vivono nel database di Metaverse (`metaverse_message`, `metaverse_language`,
-- su MariaDB): ce li scrivono i plugin all'avvio e li rileggono ogni minuto.
-- Il pannello ci entra dalla porta di servizio — una connessione a parte,
-- `METAVERSE_MYSQL_URL` — e non tiene una copia. Una copia sarebbe una seconda
-- verita' da tenere allineata con la prima, e il giorno in cui divergono si
-- scopre in chat, da un giocatore.
--
-- I tre livelli:
--   1 = legge i testi
--   2 = li modifica — arriva in gioco entro un minuto, non c'e' una bozza
--   3 = gestisce le lingue: ne crea, le accende per i giocatori, le riordina
--
-- `dev` a 2 e `moderatore` a 1: tradurre e' lavoro di staff e non tocca come
-- si gioca, ma accendere una lingua per tutti i giocatori e' un'altra cosa.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout      = '3s';
SET LOCAL statement_timeout = '60s';

-- 83: dopo l'ultimo. E' un'area a se', «Lingue», e l'ordine nella matrice
-- viene dall'area, non da questo numero.
INSERT INTO auth.modules (key, name, sort_order) VALUES ('lingue', 'Lingue', 83);

ALTER TABLE auth.role_permissions DISABLE TRIGGER t_protect_system_role_permissions;

INSERT INTO auth.role_permissions (role_id, module_id, level)
SELECT r.id, m.id, v.level
FROM (VALUES
  ('owner',      'lingue', 3),
  ('admin',      'lingue', 3),
  ('dev',        'lingue', 2),
  ('moderatore', 'lingue', 1)
) AS v(role_key, module_key, level)
JOIN auth.roles   r ON r.key = v.role_key
JOIN auth.modules m ON m.key = v.module_key;

ALTER TABLE auth.role_permissions ENABLE TRIGGER t_protect_system_role_permissions;

COMMIT;
