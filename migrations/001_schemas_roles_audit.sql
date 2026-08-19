-- Migration 001 — schemi, ruoli Postgres, GRANT/REVOKE, audit_log partizionato
-- con catena hash e chain_head.  §6.1, §6.7, §6.8, §10, §18.2
--
-- Rende verdi i test 1 e 2 del §14:
--   1. `DELETE FROM audit.audit_log` eseguito da metamc_app solleva eccezione.
--   2. Manomettere una riga passata fa fallire la verifica della catena.
--
-- Forward-only. Non esiste un down: in produzione una migration si corregge
-- con la successiva, non si annulla.

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- Schemi
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS audit;
-- Creato VUOTO di proposito (§16.1): le tabelle di rollup, il partizionamento
-- e gli indici BRIN sono fase 2. BRIN e' corretto li' e sbagliato sull'audit.
CREATE SCHEMA IF NOT EXISTS stats;

-- Nessuno crea oggetti in public per sbaglio.
REVOKE ALL ON SCHEMA public FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Ruoli
--
-- Creati SENZA password: con scram-sha-256 un ruolo senza password non puo'
-- autenticarsi, quindi il default e' chiuso. Le password si impostano fuori
-- dal repository con `node scripts/set-role-passwords.ts` (le legge da env).
-- Nessuna credenziale entra mai in una migration committata.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metamc_migrate') THEN
    CREATE ROLE metamc_migrate LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metamc_app') THEN
    CREATE ROLE metamc_app LOGIN;
  END IF;
END $$;

-- metamc_migrate possiede il DDL.
ALTER SCHEMA auth  OWNER TO metamc_migrate;
ALTER SCHEMA audit OWNER TO metamc_migrate;
ALTER SCHEMA stats OWNER TO metamc_migrate;

-- metamc_app puo' attraversare gli schemi ma NON creare oggetti: nessun CREATE.
GRANT USAGE ON SCHEMA auth  TO metamc_app;
GRANT USAGE ON SCHEMA audit TO metamc_app;
GRANT USAGE ON SCHEMA stats TO metamc_app;
REVOKE CREATE ON SCHEMA auth, audit, stats FROM metamc_app;

-- ---------------------------------------------------------------------------
-- audit.audit_log — partizionata RANGE mensile dal giorno uno (§0.14)
--
-- E' l'unica tabella che cresce senza limite e che non si puo' potare con
-- DELETE, perche' la catena hash si spezzerebbe. La retention e' DETACH/DROP
-- di partizione.
-- ---------------------------------------------------------------------------
CREATE TABLE audit.audit_log (
  id                 bigint GENERATED ALWAYS AS IDENTITY,
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  request_id         uuid,
  -- Nessuna FK su actor_user_id: la riga deve sopravvivere alla cancellazione
  -- dell'utente. Un registro che sparisce con il suo autore non e' un registro.
  actor_user_id      text,
  actor_email        text,                -- DENORMALIZZATO al momento del fatto
  actor_display_name text,                -- DENORMALIZZATO
  actor_ip           inet,                -- derivato da X-Forwarded-For
  actor_socket_ip    inet,                -- socket.remoteAddress, non falsificabile
  actor_user_agent   text,
  session_id         text,
  action             text NOT NULL,
  module_key         text,
  target_type        text,
  target_id          text,
  target_label       text,                -- DENORMALIZZATO
  outcome            text NOT NULL CHECK (outcome IN ('success','failure','denied')),
  before             jsonb,
  after              jsonb,
  meta               jsonb,
  prev_hash          bytea NOT NULL,
  hash               bytea NOT NULL,
  PRIMARY KEY (occurred_at, id)
) PARTITION BY RANGE (occurred_at);

-- La query principale della UI e' `ORDER BY occurred_at DESC, id DESC LIMIT 50`
-- con paginazione keyset. La PK (occurred_at, id) la serve con una scansione
-- all'indietro: non serve un secondo indice DESC, che costerebbe scritture
-- sulla tabella piu' calda. BRIN sarebbe sbagliato qui (non ordina) ed e'
-- corretto invece su stats.* in fase 2 (§0.13).
CREATE INDEX audit_log_actor_idx  ON audit.audit_log (actor_user_id, occurred_at DESC, id DESC);
CREATE INDEX audit_log_module_idx ON audit.audit_log (module_key, action, occurred_at DESC, id DESC);

CREATE TABLE audit.chain_head (
  partition_key text PRIMARY KEY,     -- 'YYYYMM'
  head_hash     bytea NOT NULL,
  row_count     bigint NOT NULL DEFAULT 0,
  anchored_at   timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Catena hash (§10, livello 3)
-- ---------------------------------------------------------------------------
CREATE FUNCTION audit.canonical(r audit.audit_log) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT concat_ws(U&'\0001',
    to_char(r.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US'),
    coalesce(r.actor_user_id,''), coalesce(r.actor_email,''),
    coalesce(host(r.actor_ip),''), coalesce(host(r.actor_socket_ip),''),
    r.action, coalesce(r.module_key,''), coalesce(r.target_type,''),
    coalesce(r.target_id,''), r.outcome,
    coalesce(r.before::text,''), coalesce(r.after::text,''), coalesce(r.meta::text,''))
$$;

CREATE FUNCTION audit.fn_hash_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pk   text := to_char(NEW.occurred_at AT TIME ZONE 'UTC','YYYYMM');
  prev bytea;
BEGIN
  -- Lock transaction-scoped: si rilascia al COMMIT senza codice esplicito, ed
  -- e' gia' compatibile con un eventuale transaction pooling futuro.
  PERFORM pg_advisory_xact_lock(hashtextextended('audit_chain:'||pk, 0));
  SELECT head_hash INTO prev FROM audit.chain_head WHERE partition_key = pk FOR UPDATE;
  IF prev IS NULL THEN
    SELECT head_hash INTO prev FROM audit.chain_head
      WHERE partition_key < pk ORDER BY partition_key DESC LIMIT 1;
    prev := coalesce(prev, decode(repeat('00',32),'hex'));
    INSERT INTO audit.chain_head(partition_key, head_hash) VALUES (pk, prev);
  END IF;
  NEW.prev_hash := prev;
  NEW.hash := sha256(prev || convert_to(audit.canonical(NEW),'UTF8'));
  UPDATE audit.chain_head
     SET head_hash = NEW.hash, row_count = row_count + 1, updated_at = now()
   WHERE partition_key = pk;
  RETURN NEW;
END $$;

CREATE TRIGGER t_hash_chain BEFORE INSERT ON audit.audit_log
  FOR EACH ROW EXECUTE FUNCTION audit.fn_hash_chain();

-- ---------------------------------------------------------------------------
-- Immutabilita' (§10, livello 2)
--
-- Difende dall'errore umano — una migration sbagliata, un DELETE senza WHERE —
-- non da un superuser. Il livello 1 (privilegi) e il livello 3 (catena) sono
-- gli altri due.
-- ---------------------------------------------------------------------------
CREATE FUNCTION audit.fn_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$;

CREATE TRIGGER t_immutable BEFORE UPDATE OR DELETE ON audit.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit.fn_immutable();

-- ---------------------------------------------------------------------------
-- Creazione di una partizione mensile.
--
-- Non basta CREATE TABLE ... PARTITION OF: i privilegi e i trigger di statement
-- NON si ereditano dal padre quando la query nomina direttamente la partizione.
-- Senza questa funzione, `DELETE FROM audit.audit_log_2026_08` aggirerebbe sia
-- il GRANT sia il trigger di immutabilita'. Ogni partizione passa di qui.
-- ---------------------------------------------------------------------------
CREATE FUNCTION audit.create_month_partition(p_month date) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  start_date date := date_trunc('month', p_month)::date;
  end_date   date := (date_trunc('month', p_month) + interval '1 month')::date;
  part_name  text := 'audit_log_' || to_char(start_date, 'YYYY_MM');
  qualified  text := format('audit.%I', part_name);
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'audit' AND c.relname = part_name
  ) THEN
    RETURN qualified;
  END IF;

  EXECUTE format(
    'CREATE TABLE %s PARTITION OF audit.audit_log FOR VALUES FROM (%L) TO (%L)',
    qualified, start_date, end_date);

  -- Livello 1 sulla partizione: solo INSERT e SELECT, come sul padre.
  EXECUTE format('REVOKE ALL ON %s FROM metamc_app', qualified);
  EXECUTE format('GRANT INSERT, SELECT ON %s TO metamc_app', qualified);

  -- Livello 2 sulla partizione: un DELETE che nomina la partizione deve
  -- fallire esattamente come uno che nomina il padre.
  EXECUTE format(
    'CREATE TRIGGER t_immutable BEFORE UPDATE OR DELETE ON %s
       FOR EACH STATEMENT EXECUTE FUNCTION audit.fn_immutable()', qualified);

  RETURN qualified;
END $$;

-- 12 mesi in anticipo + i 2 precedenti, cosi' un orologio sbagliato o un
-- evento datato all'indietro non fanno fallire un INSERT di audit.
DO $$
DECLARE m int;
BEGIN
  FOR m IN -2..12 LOOP
    PERFORM audit.create_month_partition((date_trunc('month', now()) + (m || ' month')::interval)::date);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Privilegi (§10, livello 1)
--
-- Nemmeno una SQL injection riuscita nel percorso applicativo puo' cancellare
-- la storia: metamc_app non ha il privilegio, punto.
-- ---------------------------------------------------------------------------
REVOKE ALL ON audit.audit_log FROM metamc_app;
GRANT INSERT, SELECT ON audit.audit_log TO metamc_app;
GRANT SELECT, INSERT, UPDATE ON audit.chain_head TO metamc_app;
-- Nessun DELETE su chain_head: le teste di catena non si cancellano.
REVOKE DELETE, TRUNCATE ON audit.chain_head FROM metamc_app;

-- La colonna id e' GENERATED ALWAYS AS IDENTITY: la sequenza e' interna alla
-- tabella e non richiede un GRANT separato.

GRANT EXECUTE ON FUNCTION audit.canonical(audit.audit_log) TO metamc_app;

-- ---------------------------------------------------------------------------
-- Verifica della catena (§10, endpoint GET /internal/audit-integrity)
--
-- La verifica NON percorre le righe in ordine di occurred_at o di id: sotto
-- concorrenza nessuno dei due coincide con l'ordine della catena. `occurred_at`
-- vale now(), cioe' l'ora di INIZIO della transazione, e `id` viene allocato
-- dall'identity PRIMA che il trigger prenda il lock: due transazioni che si
-- accavallano possono quindi entrare in catena in ordine inverso rispetto a
-- entrambe le colonne.
--
-- L'ordine vero e' la catena stessa. La verifica e' percio' insiemistica:
--   1. ogni riga deve avere hash = sha256(prev_hash || canonical(riga))
--      -> intercetta qualunque manomissione del contenuto
--   2. il prev_hash di ogni riga deve essere la genesi oppure l'hash di
--      un'altra riga della partizione  -> intercetta cancellazioni e riscritture
--   3. esattamente una riga parte dalla genesi                -> niente fork
--   4. esattamente una riga non e' puntata da nessuna altra,
--      ed e' quella registrata in chain_head                  -> niente troncamenti
--
-- Le quattro condizioni insieme dicono che le righe formano una sola catena
-- integra che termina dove chain_head dichiara.
-- ---------------------------------------------------------------------------
CREATE FUNCTION audit.verify_chain(p_partition_key text)
RETURNS TABLE (ok boolean, rows_checked bigint, bad_id bigint, bad_occurred_at timestamptz, detail text)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_genesis bytea;
  v_n       bigint;
  v_bad     record;
  v_count   bigint;
  v_head    bytea;
  v_tail    bytea;
BEGIN
  SELECT ch.head_hash INTO v_genesis FROM audit.chain_head ch
   WHERE ch.partition_key < p_partition_key ORDER BY ch.partition_key DESC LIMIT 1;
  v_genesis := coalesce(v_genesis, decode(repeat('00',32),'hex'));

  SELECT count(*) INTO v_n FROM audit.audit_log l
   WHERE to_char(l.occurred_at AT TIME ZONE 'UTC','YYYYMM') = p_partition_key;

  IF v_n = 0 THEN
    RETURN QUERY SELECT true, 0::bigint, NULL::bigint, NULL::timestamptz, NULL::text;
    RETURN;
  END IF;

  -- 1. contenuto
  SELECT l.id, l.occurred_at INTO v_bad
    FROM audit.audit_log l
   WHERE to_char(l.occurred_at AT TIME ZONE 'UTC','YYYYMM') = p_partition_key
     AND l.hash IS DISTINCT FROM sha256(l.prev_hash || convert_to(audit.canonical(l),'UTF8'))
   ORDER BY l.occurred_at, l.id
   LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT false, v_n, v_bad.id, v_bad.occurred_at,
      'hash della riga non corrisponde al suo contenuto: riga manomessa';
    RETURN;
  END IF;

  -- 2. concatenamento
  SELECT l.id, l.occurred_at INTO v_bad
    FROM audit.audit_log l
   WHERE to_char(l.occurred_at AT TIME ZONE 'UTC','YYYYMM') = p_partition_key
     AND l.prev_hash <> v_genesis
     AND NOT EXISTS (
       SELECT 1 FROM audit.audit_log p
        WHERE to_char(p.occurred_at AT TIME ZONE 'UTC','YYYYMM') = p_partition_key
          AND p.hash = l.prev_hash)
   ORDER BY l.occurred_at, l.id
   LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT false, v_n, v_bad.id, v_bad.occurred_at,
      'prev_hash non punta ad alcuna riga esistente: riga cancellata o riscritta';
    RETURN;
  END IF;

  -- 3. una sola radice
  SELECT count(*) INTO v_count FROM audit.audit_log l
   WHERE to_char(l.occurred_at AT TIME ZONE 'UTC','YYYYMM') = p_partition_key
     AND l.prev_hash = v_genesis;
  IF v_count <> 1 THEN
    RETURN QUERY SELECT false, v_n, NULL::bigint, NULL::timestamptz,
      format('la partizione ha %s radici invece di 1: catena biforcata', v_count);
    RETURN;
  END IF;

  -- 4. una sola coda, che coincide con chain_head
  SELECT count(*), min(l.hash) INTO v_count, v_tail
    FROM audit.audit_log l
   WHERE to_char(l.occurred_at AT TIME ZONE 'UTC','YYYYMM') = p_partition_key
     AND NOT EXISTS (
       SELECT 1 FROM audit.audit_log n
        WHERE to_char(n.occurred_at AT TIME ZONE 'UTC','YYYYMM') = p_partition_key
          AND n.prev_hash = l.hash);
  IF v_count <> 1 THEN
    RETURN QUERY SELECT false, v_n, NULL::bigint, NULL::timestamptz,
      format('la partizione ha %s code invece di 1: catena biforcata', v_count);
    RETURN;
  END IF;

  SELECT ch.head_hash INTO v_head FROM audit.chain_head ch WHERE ch.partition_key = p_partition_key;
  IF v_head IS DISTINCT FROM v_tail THEN
    RETURN QUERY SELECT false, v_n, NULL::bigint, NULL::timestamptz,
      'chain_head non coincide con l''ultima riga: catena troncata o testa manomessa';
    RETURN;
  END IF;

  RETURN QUERY SELECT true, v_n, NULL::bigint, NULL::timestamptz, NULL::text;
END $$;

GRANT EXECUTE ON FUNCTION audit.verify_chain(text) TO metamc_app;
