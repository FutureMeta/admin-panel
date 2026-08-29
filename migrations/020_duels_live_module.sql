-- ============================================================================
-- Migration 020 — «Duels · Live»: il modulo RBAC della schermata realtime.
--
-- ----------------------------------------------------------------------------
-- 1. PERCHE' UNA CHIAVE NUOVA E NON `duels`.
--
-- Perche' mostra una cosa che nessun'altra schermata dei duels mostra: CHI sta
-- giocando, adesso, per nome. Trends e Ratings sono aggregati — «quante
-- partite», «che voto medio» — e il nome di un giocatore ci compare solo dove
-- ha scritto qualcosa. La schermata Live invece elenca il roster di ogni
-- partita in corso, con il server su cui si trova ciascuno e il suo ping.
--
-- E' la posizione delle persone in tempo reale. Non e' la stessa domanda di
-- «come vanno le partite», e appoggiarla su `duels` la darebbe in regalo a
-- chiunque abbia gia' i grafici — senza che nessuna riga della matrice lo
-- dica, e quindi senza che nessuno possa toglierla da sola. E' la stessa
-- ragione della 018: un permesso che non compare e' un permesso che nessuno
-- revoca.
--
-- ----------------------------------------------------------------------------
-- 2. NON SERVE NESSUN PRIVILEGIO NUOVO SUL DATABASE.
--
-- La schermata non legge Postgres: legge il Redis di gioco (server, partite in
-- corso, code, roster) e il catalogo delle modalita' e delle mappe da MySQL,
-- che sono le stesse due sorgenti che il pannello gia' apre. Qui c'e' solo la
-- riga della matrice — cioe' l'unica cosa che manca perche' quel dato abbia un
-- interruttore.
--
-- ----------------------------------------------------------------------------
-- 3. IL LIVELLO 2 NON ESISTE, PER ORA.
--
-- La schermata e' di sola lettura: non espelle nessuno, non chiude nessuna
-- partita, non riavvia nessun server. `>= 1` e' l'unico controllo che le rotte
-- fanno. I livelli piu' alti restano concedibili — la matrice e' un ordine
-- totale — e il giorno in cui arrivera' un'azione avra' gia' dove appoggiarsi.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout      = '3s';
SET LOCAL statement_timeout = '60s';

-- 79 era occupato da `assistente`, e lo era per un motivo che non c'e' mai
-- stato: Svetlana appartiene al gruppo «Sistema», con `impostazioni` e
-- `server`, e stava in mezzo al blocco dei duels. Un posto libero fra 78 e 80
-- non esiste, quindi la si sposta a 81 — SUBITO DOPO `server` (80), cioe'
-- accanto al gruppo suo. Non e' un riordino di comodo per fare spazio: e' il
-- posto giusto, e quello di prima era quello sbagliato.
--
-- Spostare una riga seminata da un'altra migration si puo': quella e' applicata
-- e non si tocca, questa e' nuova e dichiara cosa cambia. `sort_order` governa
-- solo l'ordine di presentazione nella matrice — nessun permesso cambia, e
-- nessuna sessione perde niente.
UPDATE auth.modules SET sort_order = 81 WHERE key = 'assistente';

-- 79: subito dopo `duels_maps` (78) e prima di `server` (80). L'ordine dei
-- moduli e' quello in cui compaiono nella matrice, e cosi' il gruppo «Duels»
-- resta contiguo — 75, 76, 77, 78, 79 — e «Sistema» pure: 80 e 81.
INSERT INTO auth.modules (key, name, sort_order) VALUES
  ('duels_live', 'Live', 79);

-- ---------------------------------------------------------------------------
-- La matrice.
--
-- Il trigger si spegne per la durata del seed, come nella 015 e nella 018:
-- rifiuta qualunque insert sui permessi di un ruolo di sistema, e `owner` lo
-- e'. `t_bump_role_permissions` invece NON si tocca — e' quello che alza
-- `permissions_version` e fa comparire la voce nuova alle sessioni GIA'
-- aperte. Spegnendolo, con sessioni da quattordici giorni (D-11), nessuno
-- vedrebbe la schermata per due settimane.
-- ---------------------------------------------------------------------------
ALTER TABLE auth.role_permissions DISABLE TRIGGER t_protect_system_role_permissions;

-- `moderatore` a 1, ed e' la riga che spiega il modulo: guardare chi sta
-- giocando adesso, su quale server e con che ping, e' letteralmente il lavoro
-- di chi modera. Ha gia' 1 su `duels` e su `duels_feedback` per lo stesso
-- motivo.
--
-- `dev` a 1: la meta' bassa della schermata e' TPS, MSPT e CPU per server, che
-- e' una diagnosi, non una curiosita'.
--
-- `admin` a 3 come `owner`: la matrice determina la dominanza
-- (003_rbac.sql:186-193), e un ruolo con un livello superiore a quello di
-- admin smetterebbe di essere dominato da admin.
INSERT INTO auth.role_permissions (role_id, module_id, level)
SELECT r.id, m.id, v.level
FROM (VALUES
  ('owner',      'duels_live', 3),
  ('admin',      'duels_live', 3),
  ('dev',        'duels_live', 1),
  ('moderatore', 'duels_live', 1)
) AS v(role_key, module_key, level)
JOIN auth.roles   r ON r.key = v.role_key
JOIN auth.modules m ON m.key = v.module_key;

ALTER TABLE auth.role_permissions ENABLE TRIGGER t_protect_system_role_permissions;

COMMIT;
