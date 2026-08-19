-- Migration 005 — il trigger SEC-09 sugli inviti scattava anche sul consumo.
--
-- Il difetto. In 004 il trigger era:
--
--   CREATE TRIGGER t_invitation_no_system_role BEFORE INSERT OR UPDATE ...
--
-- `OR UPDATE` senza colonne significa "su qualunque UPDATE". Ma l'UPDATE che
-- CONSUMA un invito (§8.1.8, passo 2: `SET consumed_at, consumed_user_id`)
-- rilegge `NEW.role_id`, che per l'invito di bootstrap È il ruolo owner. Il
-- trigger lo rifiutava, e il primo owner del sistema non riusciva ad
-- accettare il proprio invito. Il pannello non era installabile.
--
-- Perche' i test non l'hanno preso. Il test in 05-06 verifica che INSERIRE un
-- invito verso un ruolo di sistema fallisca — ed e' giusto che fallisca. Ma
-- nessun test percorreva bootstrap → accettazione, cioe' l'unico percorso in
-- cui una riga con `role_id` di sistema esiste legittimamente e va consumata.
-- Il test c'e' ora (tests/acceptance/18-bootstrap.test.ts).
--
-- La correzione. `UPDATE OF role_id`: il trigger scatta all'INSERT e solo sugli
-- UPDATE che TOCCANO quella colonna. SEC-09 resta intero — non si crea un
-- invito verso un ruolo di sistema, e non si puo' nemmeno promuovere a owner
-- un invito pendente cambiandogli il ruolo — mentre consumare, revocare o
-- annotare il message-id di Resend non lo risvegliano piu'.

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DROP TRIGGER IF EXISTS t_invitation_no_system_role ON auth.invitation;

CREATE TRIGGER t_invitation_no_system_role
  BEFORE INSERT OR UPDATE OF role_id ON auth.invitation
  FOR EACH ROW EXECUTE FUNCTION auth.fn_invitation_no_system_role();
