-- ============================================================================
-- Migration 026 — i giorni rimasti «non definitivi» si ricalcolano e si chiudono.
--
-- IL DIFETTO, corretto nel codice (src/stats/rollup.ts, `dailyClose`). La
-- chiusura giornaliera gira ogni quarto d'ora, e il primo giro dopo
-- mezzanotte trova quasi sempre ieri ancora in lavorazione nel rollup
-- giornaliero: giusto non dichiararlo definitivo. Ma il suo watermark passava
-- comunque a oggi, e ieri non veniva piu' rivisto. Da quando le statistiche
-- esistono, quasi ogni giorno e' rimasto aperto.
--
-- NON BASTA CHIUDERLI. Un giorno aperto puo' anche essere SBAGLIATO: il
-- rollup giornaliero guarda indietro due ore, e un'ora riscritta piu' tardi —
-- dati arrivati in ritardo, un riavvio — non arriva piu' alla riga del
-- giorno. L'invariante `max_hierarchy` ne ha trovato uno in produzione (30
-- agosto, server 107: 78 nel giorno, 80 in un'ora). Chiudere quei giorni cosi'
-- com'e' congelerebbe per sempre anche l'errore.
--
-- Quindi si riportano indietro DUE segnalibri, al primo giorno passato ancora
-- aperto: quello del rollup giornaliero, che ricalcola quei giorni per intero
-- dalle ore, e quello della chiusura, che li dichiara definitivi man mano che
-- il rollup li supera — il codice ora si ferma al primo giorno non ancora
-- finito. Tutti e due camminano a pezzi, come dopo un fermo. Le righe gia'
-- definitive non si toccano: ogni scrittura ha `final = false` nella WHERE.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout      = '3s';
SET LOCAL statement_timeout = '60s';

WITH aperto AS (
  SELECT min(day) AS day FROM stats.rollup_1d
   WHERE server_id = 0 AND NOT final AND day < stats.civil_day(now())
)
UPDATE stats.rollup_state s
   SET watermark = LEAST(s.watermark,
                         CASE s.level
                           -- Come la scrive `dailyClose`: il giorno, a mezzanotte.
                           WHEN 'daily_close' THEN a.day::timestamptz
                           -- Il livello giornaliero cammina per ore: la
                           -- mezzanotte di Roma di quel giorno.
                           ELSE a.day::timestamp AT TIME ZONE 'Europe/Rome'
                         END),
       behind_buckets = 0,
       updated_at = now()
  FROM aperto a
 WHERE s.level IN ('1d', 'daily_close') AND a.day IS NOT NULL;

COMMIT;
