-- ============================================================================
-- Migration 024 — i ruoli si creano, si rinominano e si eliminano dal pannello.
--
-- ----------------------------------------------------------------------------
-- 1. ELIMINARE E' UNA COLONNA, NON UN DELETE — come per gli utenti (007).
--
-- `auth.invitation.role_id` e' NOT NULL e punta a `auth.roles` senza ON
-- DELETE: un DELETE su un ruolo usato anche una sola volta per un invito
-- fallirebbe, e renderla nullabile perderebbe «con quale ruolo e' entrata
-- questa persona», che e' la storia da non perdere. Quindi un ruolo eliminato
-- resta come riga, sparisce dalla matrice e non si assegna piu'.
--
-- ----------------------------------------------------------------------------
-- 2. LE REGOLE STANNO QUI, non solo nel codice:
--
--   - l'owner non si elimina (SEC-09);
--   - un ruolo eliminato non torna, come un utente eliminato;
--   - un ruolo eliminato non si assegna ne' via pannello ne' via invito.
--     Il controllo prende un FOR SHARE sulla riga del ruolo: l'eliminazione
--     la prende FOR UPDATE, quindi un'assegnazione e un'eliminazione
--     contemporanee si mettono in fila invece di passare tutte e due.
--
-- «Nessuno ce l'ha e nessun invito pendente lo offre» e' controllato dalla
-- rotta, dentro la stessa transazione e dopo quel lock: e' una condizione su
-- altre tabelle, e il messaggio utile — quante persone, quanti inviti — lo sa
-- dare solo lei.
--
-- ----------------------------------------------------------------------------
-- 3. DUE RUOLI VIVI NON HANNO LO STESSO NOME, maiuscole a parte: nella
-- tendina dell'editor e nella scheda di una persona si riconoscono dal nome.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout      = '3s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE auth.roles ADD COLUMN deleted_at timestamptz;

CREATE UNIQUE INDEX roles_name_live_unique ON auth.roles (lower(name)) WHERE deleted_at IS NULL;

CREATE FUNCTION auth.fn_role_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'un ruolo eliminato non si ripristina';
  END IF;
  IF OLD.is_system AND NEW.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'il ruolo di sistema % non e'' cancellabile', OLD.key;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER t_role_deletion BEFORE UPDATE OF deleted_at ON auth.roles
  FOR EACH ROW EXECUTE FUNCTION auth.fn_role_deletion();

-- La riga si blocca PRIMA di guardarla. Con la condizione dentro la WHERE, un
-- ruolo non ancora eliminato non combacerebbe, non verrebbe bloccato, e
-- un'eliminazione in corso passerebbe accanto senza aspettare.
CREATE FUNCTION auth.fn_no_deleted_role() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE gone timestamptz;
BEGIN
  SELECT deleted_at INTO gone FROM auth.roles WHERE id = NEW.role_id FOR SHARE;
  IF gone IS NOT NULL THEN
    RAISE EXCEPTION 'un ruolo eliminato non si assegna';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER t_user_roles_no_deleted_role BEFORE INSERT OR UPDATE OF role_id ON auth.user_roles
  FOR EACH ROW EXECUTE FUNCTION auth.fn_no_deleted_role();

CREATE TRIGGER t_invitation_no_deleted_role BEFORE INSERT OR UPDATE OF role_id ON auth.invitation
  FOR EACH ROW EXECUTE FUNCTION auth.fn_no_deleted_role();

COMMIT;
