-- Migration 008 — l'eliminazione libera l'indirizzo email.
--
-- Il difetto. Dopo aver eliminato una persona, reinvitare lo stesso indirizzo
-- rispondeva «esiste gia' un utente». Due cause sovrapposte:
--
--   1. `assertInvitable` cercava l'utente per email senza escludere gli
--      eliminati, e trovava la riga rimasta come segnaposto;
--   2. anche togliendo quel controllo, `user_email_lower_idx` e' UNIQUE e non
--      parziale: l'accettazione avrebbe fallito piu' avanti, sul database,
--      con un errore che nella schermata sarebbe arrivato come «non e' stato
--      possibile completare l'accettazione».
--
-- Un'eliminazione che non libera l'indirizzo non e' un'eliminazione: la
-- persona non puo' rientrare, e nessun altro puo' usare quella casella.
--
-- La correzione non e' rendere l'indice parziale. Sembrerebbe piu' elegante —
-- la riga eliminata terrebbe la sua email vera — ma lascerebbe DUE righe con
-- lo stesso indirizzo, e better-auth cerca l'utente per email al login: la
-- riga giusta diventerebbe una questione di fortuna. Qui invece l'indirizzo
-- della riga eliminata viene sostituito con un segnaposto in un dominio che
-- non esiste, quindi resta esattamente una riga per indirizzo e nessuna query
-- puo' sbagliare bersaglio.
--
-- Cosa NON si perde: l'email originale sta nel registro attivita', sia nel
-- payload `before` dell'evento di eliminazione, sia in `actor_email` su ogni
-- riga scritta da quella persona; e la riga dell'invito con cui era entrata
-- conserva `email_lower`.

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

UPDATE auth."user"
   SET "email" = 'deleted+' || id || '@invalid.local',
       "emailVerified" = false
 WHERE deleted_at IS NOT NULL
   AND "email" NOT LIKE 'deleted+%@invalid.local';
