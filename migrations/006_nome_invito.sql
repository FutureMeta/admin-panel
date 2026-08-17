-- Migration 006 — il nome dell'account lo sceglie chi invita, non chi accetta.
--
-- Il disegno (frontend/6-utenti-e-ruoli.dc.html, finestra «Invita utente») ha
-- tre campi: nome account Minecraft, email, ruolo. E la schermata di
-- accettazione (frontend/2-accettazione-invito.dc.html) NON chiede il nome:
-- chiede solo password e secondo fattore. Il nome, quando si arriva li', e'
-- gia' deciso.
--
-- Non e' solo una questione di forma. Il nome visualizzato compare nel
-- registro attivita' accanto a ogni azione di quella persona: e' l'etichetta
-- con cui gli altri la riconoscono quando leggono chi ha fatto cosa. Farlo
-- scegliere a chi accetta significa lasciare che si presenti come vuole —
-- «Amministratore», o il nome di un collega — su un dato che serve a
-- distinguere le persone in un registro immutabile. Deciderlo a monte, da chi
-- ha gia' il permesso di invitare, e' la scelta giusta a prescindere dal
-- disegno.
--
-- Con questa colonna il nome segue la stessa regola dell'email (§8.1.9): al
-- momento dell'accettazione si legge dalla RIGA INVITO, mai dal corpo della
-- richiesta. Il campo sparisce dal payload di /api/invites/accept, quindi
-- sparisce anche come superficie di attacco.
--
-- Righe preesistenti: gli inviti gia' pendenti non hanno un nome, e la
-- colonna e' NOT NULL. Si riempiono con la parte locale dell'indirizzo — che
-- e' quanto di piu' vicino a un nome ci sia gia' nella riga — invece di
-- lasciare la colonna opzionale e portarsi dietro per sempre un ramo «se il
-- nome manca, chiedilo». Sono al massimo una manciata di righe.

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE auth.invitation ADD COLUMN display_name text;

UPDATE auth.invitation
   SET display_name = split_part(email_lower, '@', 1)
 WHERE display_name IS NULL;

ALTER TABLE auth.invitation ALTER COLUMN display_name SET NOT NULL;

-- Lo stesso limite che applica sanitizeDisplayName lato applicazione. Qui non
-- e' una ripetizione inutile: il vincolo nel database e' cio' che regge anche
-- se un giorno una scrittura arriva da un percorso che non passa da li'.
ALTER TABLE auth.invitation
  ADD CONSTRAINT ck_invitation_display_name
  CHECK (length(btrim(display_name)) BETWEEN 1 AND 120);
