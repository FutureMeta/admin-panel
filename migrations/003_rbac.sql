-- Migration 003 — RBAC: moduli, ruoli, permessi, vista effettiva, trigger di
-- invalidazione, seed.  §6.3, §7, §18.4
--
-- Livelli: 0 = nessuno, 1 = lettura, 2 = scrittura, 3 = gestione.
-- smallint con CHECK, non quattro booleani e non un bitmask: l'ordine totale
-- riduce ogni controllo a `level >= N` e la risoluzione multi-ruolo a max().

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE auth.modules (
  id         smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key        text NOT NULL UNIQUE,
  name       text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0
);

CREATE TABLE auth.roles (
  id        smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key       text NOT NULL UNIQUE,
  name      text NOT NULL,
  -- SEC-09: owner. Non modificabile, non cancellabile, non assegnabile via
  -- invito ne' via UI. Si concede solo con la procedura a quattro occhi (§8.8).
  is_system boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0
);

CREATE TABLE auth.role_permissions (
  role_id   smallint NOT NULL REFERENCES auth.roles(id) ON DELETE CASCADE,
  module_id smallint NOT NULL REFERENCES auth.modules(id) ON DELETE CASCADE,
  level     smallint NOT NULL CHECK (level BETWEEN 0 AND 3),
  PRIMARY KEY (role_id, module_id)
);

CREATE TABLE auth.user_roles (
  user_id    text NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
  -- ON DELETE RESTRICT: cancellare un ruolo ancora assegnato deve fallire,
  -- non declassare in silenzio le persone che ce l'hanno.
  role_id    smallint NOT NULL REFERENCES auth.roles(id) ON DELETE RESTRICT,
  granted_by text REFERENCES auth."user"(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

CREATE INDEX user_roles_role_idx ON auth.user_roles (role_id);

-- Override individuale, SOLO in aumento: nessuna semantica di deny, quindi
-- nessuna precedenza controintuitiva e nessun bug da ordine di valutazione.
CREATE TABLE auth.user_permissions (
  user_id    text NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
  module_id  smallint NOT NULL REFERENCES auth.modules(id) ON DELETE CASCADE,
  level      smallint NOT NULL CHECK (level BETWEEN 0 AND 3),
  granted_by text REFERENCES auth."user"(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, module_id)
);

-- effective = GREATEST(max(livelli dei ruoli), override individuale)
CREATE VIEW auth.effective_permissions AS
SELECT u.id AS user_id, m.id AS module_id, m.key AS module_key,
       GREATEST(COALESCE(r.lvl, 0), COALESCE(up.level, 0)) AS level
FROM auth."user" u
CROSS JOIN auth.modules m
LEFT JOIN LATERAL (
  SELECT max(rp.level) AS lvl
  FROM auth.user_roles ur
  JOIN auth.role_permissions rp
    ON rp.role_id = ur.role_id AND rp.module_id = m.id
  WHERE ur.user_id = u.id
) r ON true
LEFT JOIN auth.user_permissions up
  ON up.user_id = u.id AND up.module_id = m.id;

-- ---------------------------------------------------------------------------
-- Invalidazione: permissions_version sulla riga utente.
--
-- La sessione porta il valore visto al login. Se differisce, il middleware
-- ricalcola i permessi da Postgres e riscrive la sessione (§7, §9 passo 5).
-- Senza questi trigger un declassamento avrebbe effetto solo al login
-- successivo, cioe' mai per una sessione gia' aperta.
-- ---------------------------------------------------------------------------
CREATE FUNCTION auth.fn_bump_by_user() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE uid text;
BEGIN
  uid := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
  UPDATE auth."user" SET permissions_version = permissions_version + 1 WHERE id = uid;
  IF TG_OP = 'UPDATE' AND OLD.user_id IS DISTINCT FROM NEW.user_id THEN
    UPDATE auth."user" SET permissions_version = permissions_version + 1 WHERE id = OLD.user_id;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER t_bump_user_roles AFTER INSERT OR UPDATE OR DELETE ON auth.user_roles
  FOR EACH ROW EXECUTE FUNCTION auth.fn_bump_by_user();
CREATE TRIGGER t_bump_user_permissions AFTER INSERT OR UPDATE OR DELETE ON auth.user_permissions
  FOR EACH ROW EXECUTE FUNCTION auth.fn_bump_by_user();

-- Cambiare la matrice di un RUOLO declassa (o promuove) tutti quelli che ce
-- l'hanno: la versione va alzata a ognuno di loro, non al ruolo.
CREATE FUNCTION auth.fn_bump_by_role() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rid smallint;
BEGIN
  rid := CASE WHEN TG_OP = 'DELETE' THEN OLD.role_id ELSE NEW.role_id END;
  UPDATE auth."user" u SET permissions_version = u.permissions_version + 1
   WHERE EXISTS (SELECT 1 FROM auth.user_roles ur WHERE ur.user_id = u.id AND ur.role_id = rid);
  RETURN NULL;
END $$;

CREATE TRIGGER t_bump_role_permissions AFTER INSERT OR UPDATE OR DELETE ON auth.role_permissions
  FOR EACH ROW EXECUTE FUNCTION auth.fn_bump_by_role();

-- ban e status non sono permessi, ma cambiano l'esito di ogni autorizzazione:
-- passano dallo stesso contatore, cosi' il middleware ha UNA sola cosa da
-- confrontare.
CREATE FUNCTION auth.fn_user_state_bump() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.banned IS DISTINCT FROM OLD.banned
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.ban_expires IS DISTINCT FROM OLD.ban_expires
     OR NEW.sessions_valid_from IS DISTINCT FROM OLD.sessions_valid_from THEN
    -- Se il chiamante ha gia' alzato la versione (offboarding, §8.10) non la
    -- si alza due volte: basta che cambi.
    IF NEW.permissions_version = OLD.permissions_version THEN
      NEW.permissions_version := OLD.permissions_version + 1;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER t_user_state_bump BEFORE UPDATE ON auth."user"
  FOR EACH ROW EXECUTE FUNCTION auth.fn_user_state_bump();

-- ---------------------------------------------------------------------------
-- SEC-09 — il ruolo di sistema e' intoccabile a livello di database.
--
-- L'enforcement applicativo esiste comunque, ma un invariante che regge solo
-- nel codice cade alla prima rotta che qualcuno dimentica di proteggere.
-- ---------------------------------------------------------------------------
CREATE FUNCTION auth.fn_protect_system_role() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_system THEN RAISE EXCEPTION 'il ruolo di sistema % non e'' cancellabile', OLD.key; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD.is_system OR NEW.is_system) THEN
    IF OLD.key IS DISTINCT FROM NEW.key OR OLD.is_system IS DISTINCT FROM NEW.is_system THEN
      RAISE EXCEPTION 'il ruolo di sistema % non e'' modificabile', OLD.key;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER t_protect_system_role BEFORE UPDATE OR DELETE ON auth.roles
  FOR EACH ROW EXECUTE FUNCTION auth.fn_protect_system_role();

CREATE FUNCTION auth.fn_protect_system_role_permissions() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rid smallint;
BEGIN
  rid := CASE WHEN TG_OP = 'DELETE' THEN OLD.role_id ELSE NEW.role_id END;
  IF EXISTS (SELECT 1 FROM auth.roles WHERE id = rid AND is_system) THEN
    RAISE EXCEPTION 'i permessi di un ruolo di sistema non sono modificabili';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

-- Il trigger e' creato DOPO il seed: il seed stesso deve poter popolare la
-- matrice di owner.

-- ---------------------------------------------------------------------------
-- Seed — moduli
-- ---------------------------------------------------------------------------
INSERT INTO auth.modules (key, name, sort_order) VALUES
  ('utenti',       'Utenti',        10),
  ('ruoli',        'Ruoli',         20),
  ('inviti',       'Inviti',        30),
  ('sessioni',     'Sessioni',      40),
  ('audit',        'Registro attivita''', 50),
  ('impostazioni', 'Impostazioni',  60),
  ('statistiche',  'Statistiche',   70),
  ('server',       'Server',        80);

-- ---------------------------------------------------------------------------
-- Seed — ruoli e matrice
--
-- La matrice non e' decorativa: determina la dominanza (§7) e quindi chi puo'
-- agire su chi. owner ha 3 ovunque, ed e' l'unico: e' cio' che rende vero il
-- test 6 ("un admin non puo' declassare un owner"). Se admin avesse 3 su tutti
-- i moduli, la dominanza diventerebbe simmetrica e un admin potrebbe bannare
-- un owner.
-- ---------------------------------------------------------------------------
INSERT INTO auth.roles (key, name, is_system, sort_order) VALUES
  ('owner',      'Owner',      true,  10),
  ('admin',      'Admin',      false, 20),
  ('dev',        'Sviluppatore', false, 30),
  ('moderatore', 'Moderatore', false, 40);

INSERT INTO auth.role_permissions (role_id, module_id, level)
SELECT r.id, m.id, v.level
FROM (VALUES
  -- ruolo,        modulo,         livello
  ('owner',      'utenti',       3), ('owner',      'ruoli',        3),
  ('owner',      'inviti',       3), ('owner',      'sessioni',     3),
  ('owner',      'audit',        3), ('owner',      'impostazioni', 3),
  ('owner',      'statistiche',  3), ('owner',      'server',       3),

  ('admin',      'utenti',       3), ('admin',      'ruoli',        2),
  ('admin',      'inviti',       3), ('admin',      'sessioni',     3),
  ('admin',      'audit',        2), ('admin',      'impostazioni', 2),
  ('admin',      'statistiche',  2), ('admin',      'server',       3),

  ('dev',        'utenti',       1), ('dev',        'ruoli',        0),
  ('dev',        'inviti',       0), ('dev',        'sessioni',     1),
  ('dev',        'audit',        1), ('dev',        'impostazioni', 1),
  ('dev',        'statistiche',  2), ('dev',        'server',       2),

  ('moderatore', 'utenti',       1), ('moderatore', 'ruoli',        0),
  ('moderatore', 'inviti',       0), ('moderatore', 'sessioni',     0),
  ('moderatore', 'audit',        1), ('moderatore', 'impostazioni', 0),
  ('moderatore', 'statistiche',  1), ('moderatore', 'server',       1)
) AS v(role_key, module_key, level)
JOIN auth.roles   r ON r.key = v.role_key
JOIN auth.modules m ON m.key = v.module_key;

CREATE TRIGGER t_protect_system_role_permissions
  BEFORE INSERT OR UPDATE OR DELETE ON auth.role_permissions
  FOR EACH ROW EXECUTE FUNCTION auth.fn_protect_system_role_permissions();

-- ---------------------------------------------------------------------------
-- Privilegi
-- ---------------------------------------------------------------------------
GRANT SELECT ON auth.modules TO metamc_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth.roles TO metamc_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth.role_permissions TO metamc_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth.user_roles TO metamc_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth.user_permissions TO metamc_app;
GRANT SELECT ON auth.effective_permissions TO metamc_app;
-- I moduli sono il vocabolario del sistema: si aggiungono con una migration,
-- non da runtime.
REVOKE INSERT, UPDATE, DELETE ON auth.modules FROM metamc_app;
