-- Migration 007 — eliminazione di un utente.
--
-- Perche' una colonna e non un DELETE.
--
-- Il registro attivita' e' gia' pronto a sopravvivere alla sparizione di una
-- persona: `audit.actor_user_id` non ha una chiave esterna, apposta. Ma gli
-- INVITI si': `auth.invitation.invited_by` e' NOT NULL e punta a auth."user"
-- senza ON DELETE. Un DELETE su una persona che ha invitato qualcuno
-- fallirebbe; per farlo passare bisognerebbe rendere quella colonna nullabile
-- e perdere «chi ha fatto entrare chi» — che in un pannello ad accesso solo su
-- invito e' esattamente la storia da non perdere. Stessa cosa per
-- `auth.two_factor_reset.requested_by`.
--
-- Quindi eliminare qui significa: l'account smette di esistere come mezzo di
-- accesso — credenziali distrutte, sessioni chiuse, ruoli e permessi rimossi,
-- inviti pendenti revocati — e la riga resta come segnaposto di identita' per
-- il registro e per la storia degli inviti. Nella lista non compare piu'.
--
-- La differenza con l'offboarding e' netta e vale la pena tenerla: dopo un
-- offboarding l'account e' spento ma riattivabile, dopo un'eliminazione no,
-- perche' password, secondo fattore e codici di recupero non ci sono piu'.

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE auth."user" ADD COLUMN deleted_at timestamptz;

-- L'elenco degli utenti filtra sempre su questa condizione.
CREATE INDEX user_not_deleted_idx ON auth."user" ("createdAt" DESC) WHERE deleted_at IS NULL;

-- Un'eliminazione non si annulla: come per gli inviti consumati e i recovery
-- code spesi, la monotonia sta nel database e non nella buona volonta' di chi
-- scrive la query.
CREATE FUNCTION auth.fn_user_deletion_monotona() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'un utente eliminato non si ripristina';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER t_user_deletion_monotona
  BEFORE UPDATE OF deleted_at ON auth."user"
  FOR EACH ROW EXECUTE FUNCTION auth.fn_user_deletion_monotona();
