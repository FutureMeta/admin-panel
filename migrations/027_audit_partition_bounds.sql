-- ============================================================================
-- Migration 027 — le partizioni del registro si attaccano l'una all'altra.
--
-- VISTO IN PRODUZIONE: «partition audit_log_2027_09 would overlap partition
-- audit_log_2027_08», a ogni giro del job delle partizioni.
--
-- IL MECCANISMO. `create_month_partition` scriveva i confini come date nude —
-- `FROM ('2027-09-01') TO ('2027-10-01')` — su una colonna timestamptz, e
-- PostgreSQL le legge nel fuso della SESSIONE che chiama. Le partizioni fino
-- ad agosto 2027 le aveva create la migration 001, con il fuso del server
-- (UTC nel container); il job del pannello chiama con `SET TIME ZONE
-- 'Europe/Rome'`. Settembre 2027 e' il primo mese che il pannello crea da
-- solo, e comincia due ore prima che agosto finisca. Con i fusi invertiti
-- sarebbe stato peggio: due ore di BUCO, e ogni scrittura del pannello in
-- quelle due ore sarebbe fallita.
--
-- LA CORREZIONE NON DIPENDE DA COME SONO NATE LE PARTIZIONI GIA' ESISTENTI.
-- Un mese comincia esattamente dove finisce quello prima e finisce dove
-- comincia quello dopo, se ci sono: i confini si leggono dal catalogo, non si
-- ricalcolano. Solo un mese senza vicini usa la mezzanotte, e la mezzanotte
-- di UTC, fissata sulla funzione — come fa gia' `stats.ensure_partitions`
-- dalla 011, e per la stessa ragione.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout      = '3s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION audit.create_month_partition(p_month date) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET TimeZone = 'UTC'
AS $$
DECLARE
  start_date date := date_trunc('month', p_month)::date;
  end_date   date := (date_trunc('month', p_month) + interval '1 month')::date;
  part_name  text := 'audit_log_' || to_char(start_date, 'YYYY_MM');
  prev_name  text := 'audit_log_' || to_char(start_date - interval '1 month', 'YYYY_MM');
  next_name  text := 'audit_log_' || to_char(end_date, 'YYYY_MM');
  qualified  text := format('audit.%I', part_name);
  horizon_lo date := (date_trunc('month', now()) - interval '12 month')::date;
  horizon_hi date := (date_trunc('month', now()) + interval '24 month')::date;
  lo timestamptz;
  hi timestamptz;
BEGIN
  IF start_date < horizon_lo OR start_date > horizon_hi THEN
    RAISE EXCEPTION 'mese fuori orizzonte: % non e'' fra % e %',
      start_date, horizon_lo, horizon_hi
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'audit' AND c.relname = part_name
  ) THEN
    RETURN qualified;
  END IF;

  -- I confini dei vicini, come il catalogo li scrive: «FOR VALUES FROM (...)
  -- TO (...)», con l'offset. Riletti come timestamptz sono l'istante esatto.
  SELECT (regexp_match(pg_get_expr(c.relpartbound, c.oid), 'TO \(''([^'']+)''\)'))[1]::timestamptz
    INTO lo
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'audit' AND c.relname = prev_name;
  SELECT (regexp_match(pg_get_expr(c.relpartbound, c.oid), 'FROM \(''([^'']+)''\)'))[1]::timestamptz
    INTO hi
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'audit' AND c.relname = next_name;

  EXECUTE format(
    'CREATE TABLE %s PARTITION OF audit.audit_log FOR VALUES FROM (%L) TO (%L)',
    qualified,
    coalesce(lo, start_date::timestamp AT TIME ZONE 'UTC'),
    coalesce(hi, end_date::timestamp AT TIME ZONE 'UTC'));

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

-- CREATE OR REPLACE conserva i privilegi; si riscrivono comunque, come nella
-- 009, perche' chi legge questo file non debba andarli a cercare.
REVOKE ALL ON FUNCTION audit.create_month_partition(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.create_month_partition(date) TO metamc_app;

COMMIT;
