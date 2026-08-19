-- Migration 009 — le partizioni dell'audit se le crea l'applicazione.
--
-- IL PROBLEMA. Le partizioni mensili vanno create in anticipo. Se finiscono,
-- l'INSERT di audit fallisce, e siccome sta nella stessa transazione delle
-- modifiche di stato falliscono anche quelle: il pannello si blocca in
-- scrittura, tutto insieme e senza preavviso. Finora dipendeva da un job
-- esterno che nessuno aveva configurato — cioe' da qualcosa che si sarebbe
-- scoperto il giorno del guasto, non prima.
--
-- IL CONFLITTO. Farlo fare all'applicazione vuol dire creare tabelle, e
-- `metamc_app` non ha privilegi DDL PER SCELTA: e' il livello 1 del §10, cio'
-- che rende il registro append-only anche davanti a una SQL injection
-- riuscita nel percorso applicativo. Concedergli `CREATE` sullo schema audit
-- smonterebbe proprio la garanzia che il registro esiste per dare.
--
-- LA VIA D'USCITA. La funzione diventa `SECURITY DEFINER`: gira con i
-- privilegi di chi la possiede (metamc_migrate), non di chi la chiama.
-- L'applicazione non riceve DDL, riceve il permesso di eseguire UNA funzione
-- che fa UNA cosa. Continua a non poter cancellare, modificare, staccare o
-- distruggere niente.
--
-- Tre precauzioni, perche' `SECURITY DEFINER` e' anche il modo classico di
-- regalare privilegi senza accorgersene:
--
--   1. `SET search_path = pg_catalog` sulla funzione. Senza, un chiamante che
--      controlli il proprio search_path puo' far risolvere un nome interno a
--      un oggetto suo e farsi eseguire codice con i privilegi del proprietario.
--      E' la prima riga di ogni guida su SECURITY DEFINER, ed e' anche la piu'
--      dimenticata.
--   2. `REVOKE ... FROM PUBLIC`. In Postgres le funzioni nascono eseguibili da
--      chiunque: `CREATE OR REPLACE` conserva i privilegi esistenti, quindi
--      senza questa riga la funzione resterebbe aperta a PUBLIC — innocuo
--      finche' girava coi privilegi del chiamante, non piu' adesso.
--   3. Un ORIZZONTE sui mesi accettati. La funzione non prende testo e non
--      compone nomi da input, quindi non c'e' superficie di injection; ma un
--      chiamante compromesso potrebbe chiamarla in ciclo su date lontane e
--      riempire lo schema di tabelle vuote. Fuori da [-12, +24] mesi si
--      rifiuta.
--
-- Il corpo resta quello della 001, con l'aggiunta del controllo di orizzonte.

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION audit.create_month_partition(p_month date) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  start_date date := date_trunc('month', p_month)::date;
  end_date   date := (date_trunc('month', p_month) + interval '1 month')::date;
  part_name  text := 'audit_log_' || to_char(start_date, 'YYYY_MM');
  qualified  text := format('audit.%I', part_name);
  horizon_lo date := (date_trunc('month', now()) - interval '12 month')::date;
  horizon_hi date := (date_trunc('month', now()) + interval '24 month')::date;
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

-- L'ordine conta: prima si chiude a tutti, poi si apre a chi serve.
REVOKE ALL ON FUNCTION audit.create_month_partition(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.create_month_partition(date) TO metamc_app;
