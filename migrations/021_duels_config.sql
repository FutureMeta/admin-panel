-- ============================================================================
-- Migration 021 — «Duels · Configurazioni»: il modulo RBAC e le tabelle dei
-- file YAML che i server scaricano all'avvio.
--
-- ----------------------------------------------------------------------------
-- 1. IL PROBLEMA CHE RISOLVE.
--
-- Il plugin Duels ha 183 file di configurazione sparsi su 12 moduli, e 116
-- percorsi distinti: ventisei percorsi esistono in piu' moduli come copie
-- andate alla deriva. `inventories/event_settings.yml` ha il 95% delle chiavi
-- in comune fra lobby, ffa e duel-command, ma ffa e' rimasto alla grafica
-- vecchia — cioe' lo stesso menu ha due aspetti diversi a seconda del server da
-- cui lo apri. La duplicazione non e' solo spreco: sta gia' producendo
-- incoerenza in gioco.
--
-- Qui i file vivono una volta sola. Un percorso ha una versione condivisa fra i
-- moduli che lo usano, oppure una versione per modulo quando devono davvero
-- differire — e in quel caso la differenza e' una scelta, non un incidente.
--
-- ----------------------------------------------------------------------------
-- 2. PERCHE' NELLO SCHEMA `stats`, E COSA LO RENDE UN'ECCEZIONE.
--
-- La regola di questo progetto e' che le tabelle nuove dei duels stanno in
-- `stats` con prefisso `duels_`, e non in uno schema nuovo. Queste la seguono.
--
-- Sono pero' le uniche tabelle di `stats` che il PANNELLO scrive: tutte le
-- altre le riempie l'ingestione e il pannello le legge da un ruolo di sola
-- lettura. Quindi il GRANT qui sotto e' verso `metamc_app`, non verso
-- `metamc_stats_rw`. E' scritto perche' chi guardera' i privilegi di `stats`
-- fra sei mesi non pensi a uno sbaglio.
--
-- ----------------------------------------------------------------------------
-- 3. IL MODELLO, IN TRE TABELLE.
--
--   duels_config_path      un percorso gestito: 'inventories/event/uhc.yml'
--   duels_config_version   un contenuto. UNO se il percorso e' condiviso fra i
--                          moduli, N se ogni modulo ha il suo
--   duels_config_binding   quale modulo riceve quale versione
--
-- LE CARTELLE NON ESISTONO come entita'. Sono implicite nel percorso, l'albero
-- del pannello si costruisce da li', e non c'e' modo di avere una cartella
-- vuota da ripulire.
--
-- ----------------------------------------------------------------------------
-- 4. IL VINCOLO CHE CONTA DAVVERO.
--
-- Un modulo non puo' ricevere due versioni dello stesso percorso: sarebbe un
-- file scritto due volte con contenuti diversi, e vincerebbe l'ultimo arrivato.
-- Lo impedisce la chiave primaria (path_id, module) di `binding`.
--
-- E la versione legata dev'essere una versione DI QUEL percorso. Non e'
-- ovvio: `binding` porta sia `path_id` sia `version_id`, e senza un vincolo
-- niente impedirebbe di legare al percorso A una versione del percorso B — un
-- errore che nessuna schermata mostrerebbe. Lo chiude la chiave esterna
-- composita verso `(id, path_id)` di `version`, che per esistere ha bisogno
-- dell'UNIQUE apparentemente ridondante li' sopra.
--
-- ----------------------------------------------------------------------------
-- 5. BOZZA E PUBBLICATO SONO DUE COLONNE, NON DUE STATI.
--
-- `published` e' cio' che i server ricevono; `draft` e' cio' che qualcuno sta
-- scrivendo. Tenerli separati vuol dire che salvare non pubblica mai per
-- sbaglio, e che si puo' lavorare su una modifica per giorni senza che il
-- gioco se ne accorga. `draft IS NULL` significa «nessuna modifica in
-- sospeso», ed e' la condizione che accende il tasto Pubblica.
--
-- `published IS NULL` e' un percorso creato e mai pubblicato: esiste nel
-- pannello, non esiste ancora per i server.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout      = '3s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- Il modulo RBAC.
--
-- 80 per restare attaccato al gruppo Duels (75-79). Lo slot era di `server`,
-- che scala a 81 e si porta dietro `assistente` a 82: sono due moduli di
-- «Sistema» e restano contigui fra loro. `sort_order` governa solo l'ordine di
-- presentazione nella matrice — nessun permesso cambia.
-- ---------------------------------------------------------------------------
UPDATE auth.modules SET sort_order = 82 WHERE key = 'assistente';
UPDATE auth.modules SET sort_order = 81 WHERE key = 'server';

INSERT INTO auth.modules (key, name, sort_order) VALUES
  ('duels_config', 'Configurazioni', 80);

ALTER TABLE auth.role_permissions DISABLE TRIGGER t_protect_system_role_permissions;

-- I tre livelli hanno tutti un significato, ed e' il vocabolario del pannello
-- applicato a questa schermata:
--   1 = guarda i file e le versioni
--   2 = modifica e salva bozze — non tocca il gioco
--   3 = PUBBLICA, cioe' manda in produzione
--
-- `dev` a 2 e non a 3: scrivere una configurazione e mandarla su tutti i server
-- sono due decisioni diverse, e la seconda si vede in gioco entro pochi
-- secondi. `moderatore` a 0: non e' il suo mestiere.
INSERT INTO auth.role_permissions (role_id, module_id, level)
SELECT r.id, m.id, v.level
FROM (VALUES
  ('owner',      'duels_config', 3),
  ('admin',      'duels_config', 3),
  ('dev',        'duels_config', 2),
  ('moderatore', 'duels_config', 0)
) AS v(role_key, module_key, level)
JOIN auth.roles   r ON r.key = v.role_key
JOIN auth.modules m ON m.key = v.module_key;

ALTER TABLE auth.role_permissions ENABLE TRIGGER t_protect_system_role_permissions;

-- ---------------------------------------------------------------------------
-- I percorsi.
-- ---------------------------------------------------------------------------
CREATE TABLE stats.duels_config_path (
  id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Sempre con le barre in avanti e senza barra iniziale: e' la stessa chiave
  -- che `ConfigManager` costruisce nel plugin (`normalizeKey`), quindi le due
  -- parti si parlano senza tradurre niente.
  path       text NOT NULL UNIQUE CHECK (path <> '' AND path NOT LIKE '/%' AND path NOT LIKE '%\\%'),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL
);

-- ---------------------------------------------------------------------------
-- Le versioni.
-- ---------------------------------------------------------------------------
CREATE TABLE stats.duels_config_version (
  id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  path_id      integer NOT NULL REFERENCES stats.duels_config_path(id) ON DELETE CASCADE,
  /** Il contenuto che i server ricevono. NULL = creata e mai pubblicata. */
  published    text,
  published_at timestamptz,
  published_by text,
  /** La modifica in sospeso. NULL = niente da pubblicare. */
  draft        text,
  draft_at     timestamptz,
  draft_by     text,
  -- Apparentemente ridondante — `id` e' gia' chiave primaria — ed e' invece
  -- cio' che rende esprimibile la chiave esterna composita di `binding`.
  UNIQUE (id, path_id),
  -- I tre campi di una pubblicazione vivono o muoiono insieme. Senza questo,
  -- una riga con `published` valorizzato e `published_by` nullo passerebbe, e
  -- il registro direbbe che quel file l'ha pubblicato nessuno.
  CONSTRAINT duels_config_version_published_complete CHECK (
    (published IS NULL AND published_at IS NULL AND published_by IS NULL)
    OR (published IS NOT NULL AND published_at IS NOT NULL AND published_by IS NOT NULL)
  ),
  CONSTRAINT duels_config_version_draft_complete CHECK (
    (draft IS NULL AND draft_at IS NULL AND draft_by IS NULL)
    OR (draft IS NOT NULL AND draft_at IS NOT NULL AND draft_by IS NOT NULL)
  )
);

CREATE INDEX duels_config_version_path_idx ON stats.duels_config_version (path_id);

-- ---------------------------------------------------------------------------
-- I legami: quale modulo riceve quale versione.
-- ---------------------------------------------------------------------------
CREATE TABLE stats.duels_config_binding (
  path_id    integer NOT NULL,
  -- Il modulo del plugin: lobby, game, ffa, event, replay, setup,
  -- duel-command, event-command. L'elenco vive nel codice e non qui: un
  -- vincolo di dominio in SQL vorrebbe dire una migration per ogni modulo
  -- nuovo del plugin, che e' esattamente il genere di attrito che questa
  -- schermata esiste per togliere.
  module     text NOT NULL CHECK (module <> ''),
  version_id integer NOT NULL,
  PRIMARY KEY (path_id, module),
  FOREIGN KEY (path_id) REFERENCES stats.duels_config_path(id) ON DELETE CASCADE,
  FOREIGN KEY (version_id, path_id)
    REFERENCES stats.duels_config_version(id, path_id) ON DELETE CASCADE
);

CREATE INDEX duels_config_binding_version_idx ON stats.duels_config_binding (version_id);
-- Il bundle si costruisce per MODULO, ed e' la sola lettura che i server
-- fanno: senza questo indice ogni avvio scandirebbe tutti i legami.
CREATE INDEX duels_config_binding_module_idx ON stats.duels_config_binding (module);

-- ---------------------------------------------------------------------------
-- La cronologia: una riga per pubblicazione.
--
-- Serve a tornare indietro, ed e' l'unica ragione per cui esiste. Non e' un
-- registro di modifiche — quello e' `audit.audit_log`, con la sua catena di
-- hash — ed e' per questo che conserva il CONTENUTO e non chi ha fatto cosa.
-- ---------------------------------------------------------------------------
CREATE TABLE stats.duels_config_revision (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version_id   integer NOT NULL REFERENCES stats.duels_config_version(id) ON DELETE CASCADE,
  content      text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  published_by text NOT NULL
);

CREATE INDEX duels_config_revision_version_idx
  ON stats.duels_config_revision (version_id, published_at DESC);

-- ---------------------------------------------------------------------------
-- PRIVILEGI. Verso `metamc_app` e non verso i ruoli dell'ingestione: vedi il
-- punto 2 in testa al file.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON
  stats.duels_config_path, stats.duels_config_version,
  stats.duels_config_binding, stats.duels_config_revision
  TO metamc_app;

COMMIT;
