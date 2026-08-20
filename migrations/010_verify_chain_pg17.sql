-- Migration 010 — `audit.verify_chain` senza `min(bytea)`.
--
-- IL DIFETTO. Il passo 4 della funzione — «una sola coda, che coincide con
-- chain_head» — usava `min(l.hash)` per prendere l'hash della riga finale.
-- `min()` su `bytea` NON esiste in PostgreSQL 17: e' stato aggiunto nella 18.
-- In sviluppo la 18 lo accetta e ogni test passa; in produzione, che gira su
-- 17.11, la funzione si ferma con «function min(bytea) does not exist».
--
-- DA DOVE VIENE. La 001 nasceva quando il minimo era PostgreSQL 18. Quando il
-- requisito e' stato abbassato a «17 o superiore», `uuidv7()` e' stato
-- riscritto in PL/pgSQL per non dipendere dalla 18 — ma il resto dello schema
-- non e' stato riletto cercando altre funzioni della stessa generazione.
-- Questa e' l'unica rimasta: `max(rp.level)` lavora su uno smallint, `sha256`
-- esiste dalla 11 e `gen_random_uuid` dalla 13.
--
-- PERCHE' NON SI E' VISTO PRIMA. Il difetto sta in un ramo che si raggiunge
-- solo con una catena integra e non vuota, e PL/pgSQL analizza le istruzioni
-- SQL alla prima esecuzione, non alla creazione della funzione. In piu' fino a
-- oggi la verifica non la eseguiva nessuno: e' stato il job appena schedulato
-- a farla girare per la prima volta in produzione.
--
-- LA CORREZIONE. `(array_agg(l.hash))[1]` al posto di `min(l.hash)`.
-- `array_agg` accetta `bytea` da sempre, e il ramo in cui il valore viene
-- usato si raggiunge solo quando le code sono esattamente una — quindi
-- «l'unico elemento» e «il minimo» sono lo stesso valore.
--
-- Il corpo e' quello della 001, riprodotto per intero perche' CREATE OR
-- REPLACE non ammette modifiche parziali. La 001 non si tocca: e' applicata, e
-- il tracker ne confronta il checksum.

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION audit.verify_chain(p_partition_key text)
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
  --
  -- `(array_agg(...))[1]` e non `min(...)`: su `bytea` il secondo esiste solo
  -- dalla 18, e questo schema deve girare anche sulla 17. Il valore si usa
  -- solo nel ramo in cui le code sono una sola, quindi «il primo» e «il
  -- minimo» coincidono.
  SELECT count(*), (array_agg(l.hash))[1] INTO v_count, v_tail
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

-- CREATE OR REPLACE conserva i privilegi, ma la riga resta esplicita: chi
-- legge questa migration deve vedere chi puo' eseguirla senza aprire la 001.
GRANT EXECUTE ON FUNCTION audit.verify_chain(text) TO metamc_app;
