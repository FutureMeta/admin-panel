-- Migration 004 — inviti, recovery code, webauthn (vuota).  §6.4, §6.5, §6.6, §18.5

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- auth.uuidv7 — identificatori ordinati nel tempo, senza richiedere PostgreSQL 18
--
-- `uuidv7()` e' nativa dalla 18. Dipenderne significava che su una 17 la
-- migrazione si fermava qui, a schema mezzo creato, con
-- `function uuidv7() does not exist`. Il resto del progetto non usa niente
-- della 18, quindi era una dipendenza da una riga sola.
--
-- Perche' v7 e non v4: i primi 48 bit sono il timestamp in millisecondi,
-- quindi le chiavi nuove finiscono in fondo all'indice invece che sparse.
-- Con v4 ogni inserimento tocca una pagina a caso e l'indice si frammenta.
--
-- I 12 bit dopo la versione portano la frazione di millisecondo: senza,
-- l'ordinamento vale solo fra millisecondi diversi e due righe create nello
-- stesso millisecondo escono in ordine casuale. Misurato su 500 generazioni:
-- 263 ordinate senza quei bit, 500 con — che e' quanto fa la nativa della 18.
-- ---------------------------------------------------------------------------
CREATE FUNCTION auth.uuidv7() RETURNS uuid
LANGUAGE plpgsql VOLATILE PARALLEL SAFE AS $fn$
DECLARE
  now_ms double precision := extract(epoch from clock_timestamp()) * 1000;
  ms     bigint := floor(now_ms);
  sub    int    := floor((now_ms - ms) * 4096);
  b      bytea  := uuid_send(gen_random_uuid());
BEGIN
  -- 48 bit di timestamp nei primi 6 byte.
  b := overlay(b placing substring(int8send(ms) from 3) from 1 for 6);
  -- Byte 6: nibble di versione (0111) piu' i 4 bit alti della frazione.
  b := set_byte(b, 6, 112 + (sub >> 8));
  b := set_byte(b, 7, sub & 255);
  -- Byte 8: variante RFC 9562 (10xx), il resto resta casuale.
  b := set_byte(b, 8, (get_byte(b, 8) & 63) | 128);
  RETURN encode(b, 'hex')::uuid;
END $fn$;

GRANT EXECUTE ON FUNCTION auth.uuidv7() TO metamc_app;

-- ---------------------------------------------------------------------------
-- auth.invitation
--
-- In tabella va SOLO sha256(token), mai il token: un dump del database non
-- deve permettere di accettare inviti altrui.
-- ---------------------------------------------------------------------------
CREATE TABLE auth.invitation (
  id               uuid PRIMARY KEY DEFAULT auth.uuidv7(),
  email_lower      text NOT NULL,
  token_hash       bytea NOT NULL UNIQUE,
  role_id          smallint NOT NULL REFERENCES auth.roles(id),
  invited_by       text NOT NULL REFERENCES auth."user"(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  consumed_at      timestamptz,
  consumed_user_id text REFERENCES auth."user"(id),
  revoked_at       timestamptz,
  revoked_by       text REFERENCES auth."user"(id),
  resend_message_id text,
  CHECK (consumed_at IS NULL OR revoked_at IS NULL),
  CHECK (expires_at > created_at),
  CHECK (email_lower = lower(email_lower)),
  CHECK (consumed_at IS NULL OR consumed_user_id IS NOT NULL)
);

-- Un solo invito pendente per email. E' il vincolo che rende impossibile
-- inondare una casella di inviti validi contemporanei.
CREATE UNIQUE INDEX invitation_one_pending_per_email
  ON auth.invitation (email_lower)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE INDEX invitation_expiry_idx ON auth.invitation (expires_at)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

-- Serve alla revoca in blocco dell'offboarding (§8.10 passo 3): revocare
-- tutti gli inviti pendenti emessi dalla persona che esce.
CREATE INDEX invitation_inviter_idx ON auth.invitation (invited_by)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

-- SEC-09: il ruolo owner non e' assegnabile via invito. Vincolo di database,
-- non solo di applicazione.
CREATE FUNCTION auth.fn_invitation_no_system_role() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM auth.roles WHERE id = NEW.role_id AND is_system) THEN
    RAISE EXCEPTION 'un ruolo di sistema non e'' assegnabile via invito';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER t_invitation_no_system_role BEFORE INSERT OR UPDATE ON auth.invitation
  FOR EACH ROW EXECUTE FUNCTION auth.fn_invitation_no_system_role();

-- Un invito consumato o revocato non torna indietro.
CREATE FUNCTION auth.fn_invitation_monotona() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    RAISE EXCEPTION 'un invito consumato non si riapre';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'un invito revocato non si riapre';
  END IF;
  IF OLD.token_hash IS DISTINCT FROM NEW.token_hash THEN
    RAISE EXCEPTION 'il token di un invito non si sostituisce';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER t_invitation_monotona BEFORE UPDATE ON auth.invitation
  FOR EACH ROW EXECUTE FUNCTION auth.fn_invitation_monotona();

-- ---------------------------------------------------------------------------
-- auth.recovery_code
--
-- 128 bit da crypto.randomBytes, SHA-256 one-way. 128 bit supera la soglia dei
-- 112 bit di NIST §3.1.2.2, il che AUTORIZZA SHA-256 al posto di un password
-- hashing scheme: altrimenti servirebbero 10 esecuzioni Argon2id per tentativo,
-- cioe' un DoS applicativo banale.
-- ---------------------------------------------------------------------------
CREATE TABLE auth.recovery_code (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    text NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
  code_hash  bytea NOT NULL,
  generation smallint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at    timestamptz,
  used_ip    inet,
  UNIQUE (user_id, code_hash),
  CHECK (used_at IS NOT NULL OR used_ip IS NULL)
);

CREATE INDEX recovery_code_open_idx ON auth.recovery_code (user_id) WHERE used_at IS NULL;

-- Un codice speso non torna disponibile.
CREATE FUNCTION auth.fn_recovery_code_monotono() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.used_at IS NOT NULL THEN
    RAISE EXCEPTION 'un recovery code speso non si riapre';
  END IF;
  IF OLD.code_hash IS DISTINCT FROM NEW.code_hash OR OLD.user_id IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'il codice o il proprietario non si sostituiscono';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER t_recovery_code_monotono BEFORE UPDATE ON auth.recovery_code
  FOR EACH ROW EXECUTE FUNCTION auth.fn_recovery_code_monotono();

-- ---------------------------------------------------------------------------
-- auth.webauthn_credential — CREATA VUOTA (§6.6, §16.8)
--
-- La passkey e' fase 1.5, entro 60 giorni dal go-live. Creare la tabella ora
-- costa nulla e rende quella consegna una migration additiva invece che una
-- ristrutturazione. Nessun codice di fase 1 la tocca.
-- ---------------------------------------------------------------------------
CREATE TABLE auth.webauthn_credential (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       text NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
  credential_id bytea NOT NULL UNIQUE,
  public_key    bytea NOT NULL,
  sign_count    bigint NOT NULL DEFAULT 0,
  transports    text[],
  aaguid        uuid,
  label         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);

CREATE INDEX webauthn_user_idx ON auth.webauthn_credential (user_id);

-- ---------------------------------------------------------------------------
-- auth.two_factor_reset — reset assistito a quattro occhi (§8.8)
--
-- Non e' un endpoint di comodo: e' la procedura con due approvatori distinti,
-- verifica out-of-band e ritardo obbligatorio di 24 ore. La tabella esiste
-- perche' quella procedura ha uno stato, e uno stato senza tabella diventa una
-- chat su Discord.
-- ---------------------------------------------------------------------------
CREATE TABLE auth.two_factor_reset (
  id             uuid PRIMARY KEY DEFAULT auth.uuidv7(),
  target_user_id text NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
  requested_by   text NOT NULL REFERENCES auth."user"(id),
  requested_at   timestamptz NOT NULL DEFAULT now(),
  reason         text NOT NULL,
  -- Il canale su cui l'identita' e' stata verificata fuori banda. Testo
  -- obbligatorio: se nessuno sa dire dove ha verificato, non ha verificato.
  verification_channel text,
  approved_by_1  text REFERENCES auth."user"(id),
  approved_at_1  timestamptz,
  approved_by_2  text REFERENCES auth."user"(id),
  approved_at_2  timestamptz,
  -- Ritardo obbligatorio: impostato alla seconda approvazione, +24h.
  effective_at   timestamptz,
  executed_at    timestamptz,
  cancelled_at   timestamptz,
  cancelled_by   text REFERENCES auth."user"(id),
  CHECK (approved_by_1 IS NULL OR approved_by_1 <> requested_by),
  CHECK (approved_by_2 IS NULL OR approved_by_2 <> approved_by_1),
  CHECK (approved_by_2 IS NULL OR approved_by_2 <> requested_by),
  CHECK (executed_at IS NULL OR cancelled_at IS NULL),
  CHECK (executed_at IS NULL OR effective_at IS NOT NULL)
);

CREATE UNIQUE INDEX two_factor_reset_one_open_per_user
  ON auth.two_factor_reset (target_user_id)
  WHERE executed_at IS NULL AND cancelled_at IS NULL;

-- ---------------------------------------------------------------------------
-- Privilegi
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON auth.invitation TO metamc_app;
-- Nessun DELETE: un invito si revoca, non si cancella. La riga e' la prova di
-- chi ha invitato chi.
REVOKE DELETE ON auth.invitation FROM metamc_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON auth.recovery_code TO metamc_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth.webauthn_credential TO metamc_app;
GRANT SELECT, INSERT, UPDATE ON auth.two_factor_reset TO metamc_app;
REVOKE DELETE ON auth.two_factor_reset FROM metamc_app;
