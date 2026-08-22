-- ============================================================================
-- Migration 019 — l'assistente conversazionale: il modulo RBAC e i privilegi
-- di lettura del ruolo da cui legge.
--
-- ----------------------------------------------------------------------------
-- 1. PERCHE' SVETLANA E' UN MODULO A SE'.
--
-- Perche' altrimenti non si puo' spegnere. Un assistente disponibile a
-- chiunque entri non e' «un permesso in meno da gestire»: e' una superficie in
-- piu' che nessuna riga della matrice descrive, e quindi che nessuno puo'
-- togliere a una persona sola senza toglierle anche il resto. Le risposte
-- passano da un fornitore esterno (vedi punto 4): dare o non dare
-- quell'accesso e' esattamente il genere di decisione che la matrice esiste
-- per rendere esplicita.
--
-- Il modulo NON allarga niente. Chi ha `assistente >= 1` puo' aprire la chat;
-- cosa Svetlana riesce a leggere lo decidono i moduli che quella persona ha
-- gia' — ogni tool ricontrolla `can()` con il contesto di chi ha scritto. Un
-- moderatore con i soli duels ottiene i duels e nient'altro, e lo ottiene
-- perche' quel controllo sta DENTRO il tool, non davanti alla rotta.
--
-- ----------------------------------------------------------------------------
-- 2. IL RUOLO DI LETTURA — RICHIESTO, NON CREATO QUI.
--
-- Stessa divisione della 011: `metamc_migrate` non ha CREATEROLE, e CREATE
-- ROLE / GRANT di appartenenza / ALTER ROLE ... SET sono operazioni di
-- CLUSTER. Si creano una volta sola con `node scripts/create-assistant-role.ts`
-- e questa migration li PRETENDE.
--
-- ----------------------------------------------------------------------------
-- 3. COSA IL RUOLO PUO' LEGGERE, E COSA NO.
--
-- L'appartenenza a `metamc_stats` (data dallo script) porta le viste delle
-- statistiche e dei duels. Qui si aggiunge il minimo che serve ai due tool che
-- guardano il pannello: cercare una persona dello staff, e leggere le ultime
-- voci del registro.
--
-- Restano FUORI, e l'elenco conta piu' di quello dentro: `auth.account` (gli
-- hash delle password), `auth."twoFactor"` (i segreti TOTP),
-- `auth.recovery_code`, `auth.invitation` (i token), `auth.verification`,
-- `auth.webauthn_credential`, `auth.two_factor_reset`. Non e' una svista che
-- manchino: un tool che le leggesse manderebbe segreti a un fornitore esterno,
-- e il modo di impedirlo e' non avere il GRANT.
--
-- ----------------------------------------------------------------------------
-- 4. NOTA PER IL COMMITTENTE — DATI PERSONALI VERSO UN FORNITORE ESTERNO.
--
-- Le risposte dei tool finiscono all'API di Anthropic: nomi e indirizzi email
-- dello staff, nomi dei giocatori, commenti scritti da loro. E' un
-- trasferimento verso un responsabile esterno e va deciso, non scoperto: serve
-- una posizione sulla conservazione lato fornitore e una riga nel registro dei
-- trattamenti. Gli indirizzi IP non escono in nessun caso — il GRANT sul
-- registro c'e', ma il tool non seleziona quelle colonne, e nello schema delle
-- statistiche non ci sono gia' oggi.
-- ============================================================================
SET LOCAL lock_timeout      = '3s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metamc_assistant') THEN
    RAISE EXCEPTION 'ruolo di lettura dell''assistente mancante: metamc_assistant'
      USING ERRCODE = 'invalid_authorization_specification',
            HINT = 'Eseguire UNA volta come superuser: node scripts/create-assistant-role.ts';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Il modulo. 79: l'ultimo numero libero fra `duels_maps` (78) e `server` (80),
-- cosi' la matrice non si riordina.
--
-- Chiave `assistente`, nome «Svetlana»: la chiave nomina la capacita' e non
-- cambia se un giorno l'assistente cambia nome, il nome e' quello che si legge
-- nella matrice. E' la stessa divisione di `duels_feedback` / «Ratings».
--
-- I moduli si aggiungono QUI e non da runtime: la 003 revoca INSERT su
-- `auth.modules` a `metamc_app` (003_rbac.sql:239).
-- ---------------------------------------------------------------------------
INSERT INTO auth.modules (key, name, sort_order) VALUES
  ('assistente', 'Svetlana', 79);

-- ---------------------------------------------------------------------------
-- La matrice.
--
-- UN SOLO LIVELLO UTILE, e va detto invece di fingere che ce ne siano quattro.
-- In v1 Svetlana non scrive niente: `1` apre la chat, e non esiste niente che
-- `2` o `3` possano concedere in piu'. Le manopole morte insegnano a non
-- fidarsi di quelle vive, quindi non se ne mettono.
--
-- `admin` e `owner` a 3 lo stesso, e non e' una contraddizione con quanto
-- sopra: la matrice determina la DOMINANZA (003_rbac.sql:186-193), e un ruolo
-- con un livello superiore a quello di admin smetterebbe di essere dominato da
-- admin. Il livello 3 qui non apre niente di piu' del livello 1; serve a non
-- rompere la gerarchia. Quando arriveranno le scritture, il gradino esiste
-- gia'.
--
-- `dev` e `moderatore` a 1: la chat non da' accesso a dati che non abbiano
-- gia', e negargliela non protegge niente — sposta solo la stessa lettura su
-- una schermata.
--
-- Il trigger va spento per la durata del seed, come nella 015 e nella 018:
-- rifiuta qualunque insert sui permessi di un ruolo di sistema, e `owner` lo
-- e'. `t_bump_role_permissions` invece NON si tocca: e' quello che alza
-- `permissions_version` e fa comparire la voce alle sessioni GIA' aperte.
-- ---------------------------------------------------------------------------
ALTER TABLE auth.role_permissions DISABLE TRIGGER t_protect_system_role_permissions;

INSERT INTO auth.role_permissions (role_id, module_id, level)
SELECT r.id, m.id, v.level
FROM (VALUES
  ('owner',      'assistente', 3),
  ('admin',      'assistente', 3),
  ('dev',        'assistente', 1),
  ('moderatore', 'assistente', 1)
) AS v(role_key, module_key, level)
JOIN auth.roles   r ON r.key = v.role_key
JOIN auth.modules m ON m.key = v.module_key;

ALTER TABLE auth.role_permissions ENABLE TRIGGER t_protect_system_role_permissions;

-- ---------------------------------------------------------------------------
-- I privilegi di lettura.
--
-- USAGE sullo schema e SELECT sulle singole relazioni, mai `ALL TABLES`: un
-- GRANT per elenco si legge e si verifica, un GRANT per schema comprende
-- anche cio' che verra' aggiunto domani da qualcun altro.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA auth  TO metamc_assistant;
GRANT USAGE ON SCHEMA audit TO metamc_assistant;

-- Ricerca di una persona dello staff, con i suoi ruoli e da quanto non entra.
GRANT SELECT ON auth."user", auth."session", auth.user_roles, auth.roles,
                auth.modules, auth.effective_permissions
  TO metamc_assistant;

-- Le ultime voci del registro. Il GRANT sta sulla tabella PADRE: l'accesso
-- attraverso di essa non richiede privilegi sulle partizioni, e darli
-- significherebbe doverli ridare a ogni partizione nuova.
GRANT SELECT ON audit.audit_log TO metamc_assistant;

-- NESSUNA default privilege: una tabella aggiunta domani in `auth` o in
-- `audit` non deve diventare leggibile da sola. L'elenco sopra e' la
-- superficie, e allargarla dev'essere una migration che qualcuno legge.
