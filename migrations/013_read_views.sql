-- ============================================================================
-- Migration 013 — due viste strette per la lettura.
--
-- PERCHE'. Il payload della panoramica ha bisogno di due cose che stanno solo
-- nel registro dei cicli, e il ruolo di sola lettura su quel registro non ha
-- accesso — per una ragione che resta valida: chi leggesse `poll_cycle` a
-- piacere potrebbe ricavarne medie con il denominatore preso dalle righe
-- sbagliate, che e' il difetto contro cui e' costruito tutto lo schema.
--
-- Il rifiuto e' arrivato in faccia scrivendo il passo 4, ed e' la prova che
-- quel GRANT fa il suo mestiere. La risposta giusta non e' allargarlo: e'
-- esporre le due domande, non la tabella.
-- ============================================================================
SET LOCAL lock_timeout      = '3s';
SET LOCAL statement_timeout = '60s';

-- Quali CADENZE di campionamento compaiono in un periodo.
--
-- Serve perche' due periodi campionati a cadenze diverse NON sono
-- confrontabili sul massimo — solo sulla media, che e' robusta. Il payload
-- porta l'elenco e la UI se ne serve per rifiutare un confronto che
-- mentirebbe.
--
-- Espone `tick_at` e `delta_s` e NIENT'ALTRO: senza i conteggi non ci si puo'
-- calcolare nessuna media, giusta o sbagliata.
CREATE VIEW stats.v_cadence AS
SELECT tick_at, delta_s FROM stats.poll_cycle WHERE status = 'ok' AND delta_s IS NOT NULL;

COMMENT ON VIEW stats.v_cadence IS
  'Solo le cadenze dei cicli riusciti. Deliberatamente senza conteggi: da qui non si puo'' ricavare nessuna media.';

-- Il numero VIVO, una riga sola.
--
-- Non sta nel corpo del payload: dentro un payload costruito ogni pochi
-- minuti, un numero etichettato «online adesso» sarebbe vecchio di minuti — ed
-- e' proprio il numero che il committente confronta con quello che vede sul
-- server. Viaggia come intestazione HTTP, e sopravvive anche al 304.
--
-- COSA SIGNIFICA, e va scritto accanto a dove si mostra: e' il numero di
-- identita' con una chiave viva nel Redis di gioco. Il TTL misurato e' circa
-- 104 secondi, quindi chi esce resta visibile per un paio di minuti e questo
-- conteggio e' STRUTTURALMENTE piu' alto di quello dichiarato dal proxy. E'
-- una definizione, non un errore: si dichiara, non si aggiusta.
CREATE VIEW stats.v_online_now AS
SELECT tick_at, players, delta_s
  FROM stats.poll_cycle
 WHERE status = 'ok'
 ORDER BY tick_at DESC
 LIMIT 1;

COMMENT ON VIEW stats.v_online_now IS
  'L''ultimo ciclo riuscito, una riga. «Online adesso» = identita'' con una chiave viva in Redis; con TTL ~104 s e'' piu'' alto del conteggio del proxy, e va etichettato come tale.';

GRANT SELECT ON stats.v_cadence, stats.v_online_now TO metamc_stats;
