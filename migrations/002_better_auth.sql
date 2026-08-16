-- Migration 002 — tabelle better-auth, estese con le colonne del §6.2.  §18.3
--
-- Il DDL di partenza e' quello emesso da `pnpm dlx auth@1.6.29 generate`
-- (conservato in docs/riferimento-schema-better-auth.sql). Qui e' riscritto
-- qualificato nello schema `auth`, con i tipi del §6.2 e i vincoli che la CLI
-- non conosce.
--
-- Convenzione (§6): le tabelle generate da better-auth mantengono il naming
-- della libreria (camelCase, virgolettato); le nostre usano snake_case. Le
-- colonne che aggiungiamo noi restano snake_case anche dentro le loro tabelle,
-- cosi' si distingue a colpo d'occhio cosa possiede chi.

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- auth."user"
--
-- Tutte le colonne nostre hanno un DEFAULT: better-auth non le conosce e non
-- le include nel proprio INSERT. Dichiararle come `additionalFields` le
-- porterebbe dentro il blob di sessione, cioe' dentro uno snapshot — che e'
-- esattamente cio' che SEC-02 vieta di usare per autorizzare.
-- ---------------------------------------------------------------------------
CREATE TABLE auth."user" (
  "id"               text PRIMARY KEY,
  "name"             text NOT NULL,
  "email"            text NOT NULL UNIQUE,
  "emailVerified"    boolean NOT NULL DEFAULT false,
  "image"            text,
  "createdAt"        timestamptz NOT NULL DEFAULT now(),
  "updatedAt"        timestamptz NOT NULL DEFAULT now(),
  "twoFactorEnabled" boolean NOT NULL DEFAULT false,

  status              text NOT NULL DEFAULT 'pending_onboarding'
                        CHECK (status IN ('pending_onboarding','active','disabled')),
  permissions_version integer NOT NULL DEFAULT 1,
  -- logout globale = UPDATE ... SET sessions_valid_from = now()
  sessions_valid_from timestamptz NOT NULL DEFAULT now(),
  banned              boolean NOT NULL DEFAULT false,
  ban_reason          text,
  ban_expires         timestamptz,
  -- SEC-40: presente dal PRIMO schema. Aggiungerlo dopo imporrebbe il reset
  -- globale delle password che si voleva evitare.
  pepper_version      smallint NOT NULL DEFAULT 1,
  password_updated_at timestamptz,
  -- SEC-11: fonte di verita' DUREVOLE dell'anti-replay TOTP. Redis e' la
  -- guardia veloce, questa colonna e' quella che sopravvive a un FLUSHALL.
  last_totp_step      bigint NOT NULL DEFAULT 0,
  invited_by          text REFERENCES auth."user"("id") ON DELETE SET NULL,
  invite_id           uuid,

  CONSTRAINT user_ban_coerente CHECK (banned = false OR ban_reason IS NOT NULL)
);

-- L'unicita' dell'email e' case-insensitive: `Mario@metamc.it` e
-- `mario@metamc.it` sono la stessa persona, e un invito che non lo sapesse
-- creerebbe due account per lo stesso indirizzo.
CREATE UNIQUE INDEX user_email_lower_idx ON auth."user" (lower("email"));
CREATE INDEX user_status_idx ON auth."user" (status) WHERE status <> 'active';

-- ---------------------------------------------------------------------------
-- auth."session"
--
-- Le quattro colonne che il middleware del §9 legge a ogni richiesta sono
-- dichiarate a better-auth come additionalFields, cosi' viaggiano nel blob di
-- sessione e non costano una query. `amr` no: serve solo allo step-up, che e'
-- raro, e resta text[] come da §6.2 invece di diventare jsonb.
-- ---------------------------------------------------------------------------
CREATE TABLE auth."session" (
  "id"        text PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL,
  "token"     text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "ipAddress" text,
  "userAgent" text,
  "userId"    text NOT NULL REFERENCES auth."user"("id") ON DELETE CASCADE,

  -- SEC-05: tetto assoluto 8h, MAI prorogato. E' una colonna nostra proprio
  -- perche' il rinnovo di better-auth non deve poterla toccare.
  absolute_expires_at timestamptz NOT NULL DEFAULT (now() + interval '8 hours'),
  authenticated_at    timestamptz NOT NULL DEFAULT now(),
  -- 1 = solo password, 2 = 2FA completato. Il middleware rifiuta aal < 2.
  aal                 smallint NOT NULL DEFAULT 1 CHECK (aal BETWEEN 0 AND 2),
  amr                 text[] NOT NULL DEFAULT '{}',
  permissions_version integer NOT NULL DEFAULT 1
);

CREATE INDEX session_user_idx    ON auth."session"("userId");
CREATE INDEX session_expires_idx ON auth."session"("expiresAt");

-- ---------------------------------------------------------------------------
-- auth."account" — contiene la PHC string della password
-- ---------------------------------------------------------------------------
CREATE TABLE auth."account" (
  "id"                    text PRIMARY KEY,
  "accountId"             text NOT NULL,
  "providerId"            text NOT NULL,
  "userId"                text NOT NULL REFERENCES auth."user"("id") ON DELETE CASCADE,
  "accessToken"           text,
  "refreshToken"          text,
  "idToken"               text,
  "accessTokenExpiresAt"  timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope"                 text,
  "password"              text,
  "createdAt"             timestamptz NOT NULL DEFAULT now(),
  "updatedAt"             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX account_user_idx ON auth."account"("userId");
CREATE UNIQUE INDEX account_provider_idx ON auth."account"("providerId", "accountId");

-- ---------------------------------------------------------------------------
-- auth."verification" — token di verifica e reset password (§8.7)
-- ---------------------------------------------------------------------------
CREATE TABLE auth."verification" (
  "id"         text PRIMARY KEY,
  "identifier" text NOT NULL,
  "value"      text NOT NULL,
  "expiresAt"  timestamptz NOT NULL,
  "createdAt"  timestamptz NOT NULL DEFAULT now(),
  "updatedAt"  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX verification_identifier_idx ON auth."verification"("identifier");
CREATE INDEX verification_expires_idx    ON auth."verification"("expiresAt");

-- ---------------------------------------------------------------------------
-- auth."twoFactor" — plugin twoFactor
--
-- `backupCodes` viene sovrascritta con byte casuali subito dopo l'enrollment
-- (SEC-14): i recovery code veri sono in auth.recovery_code, 128 bit e
-- SHA-256 one-way. Lo storage `encrypted` del plugin e' reversibile, quindi
-- un dump del DB piu' il segreto bypasserebbe il 2FA di tutto lo staff.
-- ---------------------------------------------------------------------------
CREATE TABLE auth."twoFactor" (
  "id"                      text PRIMARY KEY,
  "secret"                  text NOT NULL,
  "backupCodes"             text NOT NULL,
  "userId"                  text NOT NULL REFERENCES auth."user"("id") ON DELETE CASCADE,
  "verified"                boolean NOT NULL DEFAULT false,
  "failedVerificationCount" integer NOT NULL DEFAULT 0,
  "lockedUntil"             timestamptz
);

CREATE INDEX twofactor_user_idx ON auth."twoFactor"("userId");
-- Un solo fattore TOTP per utente: senza questo vincolo, un enrollment
-- ripetuto lascerebbe righe orfane con segreti ancora validi.
CREATE UNIQUE INDEX twofactor_user_unique_idx ON auth."twoFactor"("userId");

-- ---------------------------------------------------------------------------
-- Privilegi
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON auth."user", auth."session", auth."account", auth."verification"
  TO metamc_app;

-- SEC-42 — attacco di sostituzione di record.
--
-- La minaccia e' copiare il proprio segreto TOTP sulla riga di un owner, o
-- spostare una riga esistente su un altro "userId". La sola cifratura del
-- segreto non lo ferma, perche' l'attaccante non ha bisogno di leggerlo.
--
-- Il GRANT e' quindi per COLONNA: metamc_app aggiorna lo stato operativo che
-- il plugin deve poter scrivere, e non puo' toccare ne' "secret" ne' "userId".
-- INSERT e DELETE restano interi: servono all'enrollment e al reset 2FA.
REVOKE ALL ON auth."twoFactor" FROM metamc_app;
GRANT SELECT, INSERT, DELETE ON auth."twoFactor" TO metamc_app;
GRANT UPDATE ("verified", "failedVerificationCount", "lockedUntil", "backupCodes")
  ON auth."twoFactor" TO metamc_app;
