# Modulo Duels — specifica di costruzione

Radici: **LEGACY** = `C:/Users/fiore/Desktop/Progetti/duels-dashboard`, **NUOVO** = `C:/Users/fiore/Desktop/admin-panel`.
Ogni riferimento è `file:riga`. Chi implementa non deve riaprire il legacy: qui c'è tutto quello che serve a ricostruire i widget.

---

## 1. La risposta alla domanda critica

### 1.1 Endpoint per endpoint, con la prova

| Schermata | Endpoint legacy | Tabelle lette | Redis? | Prova |
|---|---|---|---|---|
| Trends — Matches over time | `GET /api/stats/daily` | `duels_match_statistics` | **no** | `LEGACY/src/app/api/stats/daily/route.ts:1-5` importa solo `@/lib/queries`; SQL a `LEGACY/src/lib/queries.ts:216-236` |
| Trends — Activity heatmap | `GET /api/stats/heatmap` | `duels_match_statistics` | **no** | `LEGACY/src/app/api/stats/heatmap/route.ts:2`; SQL `queries.ts:309-322` |
| Trends — Top modes | `GET /api/stats/top-modes` | `duels_mode`, `duels_match_statistics`, `INFORMATION_SCHEMA.COLUMNS` | **no** | `top-modes/route.ts:2`; SQL `queries.ts:258-284` |
| Trends — Top maps | `GET /api/stats/top-maps` | `duels_match_statistics`, `duels_map` | **no** | `top-maps/route.ts:2`; SQL `queries.ts:294-305` |
| Ratings — selettore modalità | `GET /api/stats/modes` | `duels_mode`, `INFORMATION_SCHEMA.COLUMNS` | **no** | `modes/route.ts:1`; SQL `queries.ts:195-205` |
| Ratings — KPI + distribuzione | `GET /api/stats/ratings/overview` | `duels_match_ratings`, `duels_mode` | **no** | `ratings/overview/route.ts:1`; SQL `queries.ts:628`, `:649`, `:657` |
| Ratings — trend giornaliero | `GET /api/stats/ratings/daily` | `duels_match_ratings` | **no** | `ratings/daily/route.ts:1`; SQL `queries.ts:799-823` |
| Ratings — lista recente | `GET /api/stats/ratings/recent` | `duels_match_ratings`, `duels_userdata`, `duels_mode`, `duels_replay_participants` | **no** | `ratings/recent/route.ts:1`; SQL `queries.ts:756`, `:770-792` |

**Prova per esclusione, ripetibile con due comandi.** `LEGACY/src/lib/queries.ts:6` importa `{ query, queryOne } from "./mysql"` e la stringa `redis` in quel file compare **zero** volte. Gli unici file del legacy che toccano Redis sono `src/lib/redis.ts`, `src/lib/activeMatches.ts`, `src/lib/matchPlayers.ts`, `src/lib/onlinePlayers.ts`, `src/app/api/live/route.ts`, `src/app/api/stats/queues/route.ts`, `src/app/api/stats/servers/route.ts`, `src/hooks/useLive.ts` — **nessuno raggiungibile da `/trends` o `/ratings`**.

**Cosa c'è davvero in quel Redis.** Il keyspace intero è dichiarato a `LEGACY/src/lib/redis.ts:35-47`: `duels:servers:all`, `duels:servers:{id}`, `duels:match:all`, `duels:match:{id}`, `duels:queue:mode:{id}`, più i canali `duels:player:join` / `duels:player:quit` / `duels:broadcast`. L'hash di una partita (`LEGACY/src/lib/activeMatches.ts:80-96`) porta `identifier, type, context, state, modeId, mapId, createdAt`: sono le partite **in corso**. Nessuna chiave contiene la parola `rating`, nessuna contiene una serie storica. E i nomi di modalità e mappa non ci sono nemmeno: `LEGACY/src/lib/activeMatches.ts:63-69` li carica da MySQL e, se MySQL non risponde, ripiega sugli id grezzi.

Il committente ha ragione a metà: quel Redis ha informazioni sui duels, ma sono **stato vivo**, non storia. Su 8 endpoint delle due schermate, **0** sono servibili da Redis.

Due vincoli ulteriori chiudono anche il ripiego «costruiamoci la storia campionando Redis»:

1. **L'ACL di produzione non lo permette.** `NUOVO/docs/architettura-fase2.md:886` fissa `~metaverse:player:* ~duels:servers:*`: `duels:match:*` non è nel pattern. Serve una modifica ACL sull'istanza che tiene anche le sessioni del pannello.
2. **Campionare ≠ contare.** `duels_match_statistics` ha una riga per partita conclusa (`LEGACY/scripts/seed.ts:114-123`). Un poller a 30 s vede una partita da 45 s una o due volte e una da 20 s può non vederla mai; l'errore dipende dalla durata, cioè proprio dalla variabile che distingue le modalità — quindi falsa il «Top modes» in modo non correggibile. E la storia all'indietro resta comunque a zero.

### 1.2 Conclusione operativa

> **Serve MySQL.** Non per «qualche dettaglio»: per il 100% di Trends e Ratings — 8 endpoint, 11 statement, 6 tabelle (`duels_match_statistics`, `duels_mode`, `duels_map`, `duels_match_ratings`, `duels_userdata`, `duels_replay_participants`). Il pannello nuovo oggi non ha alcun driver MySQL: `NUOVO/package.json` ha `pg 8.23.0` e `kysely 0.29.5`, e l'unica occorrenza della parola `mysql` in tutto il repository è una nota su una CVE (`NUOVO/docs/stack-decisions.md:828`).

**Decisione raccomandata: (b) ETL da MySQL verso PostgreSQL**, non connessione diretta. Le ragioni sono tre, tutte verificabili:

- Con l'ETL sparisce l'intera macchina di fuso orario del legacy (`LEGACY/src/lib/clock.ts:34-81` + `LEGACY/src/lib/queries.ts:38-103`, sonda SQL `SELECT NOW(), UNIX_TIMESTAMP()` a `queries.ts:41`, offset **inlineato** nella stringa SQL a `queries.ts:56`). Il pannello nuovo ha già la regola: `stats.civil_day()` e `stats.day_seconds()` sono «le uniche due funzioni autorizzate a nominare il fuso» (`NUOVO/migrations/011_stats.sql:107-124`).
- Con l'ETL i predicati tornano sargable e i `GROUP BY` su espressione spariscono (D2/D3 dell'analisi). Il conteggio partite è **additivo**, quindi si presta esattamente alla regola dei rollup del pannello nuovo: solo interi additivi, così la gerarchia è esatta e non approssimata (`NUOVO/migrations/011_stats.sql:20-22`).
- Con la connessione diretta si porta dentro un driver verso il database **del gioco**, sotto una policy di dipendenze che fa fallire la build su versioni non pinnate (`NUOVO/scripts/check-deps.ts:37`) e impone `pnpm audit` + `osv-scanher` a mano a ogni cambio di lockfile (`NUOVO/docs/deps-policy.md`). È la decisione con il raggio d'esplosione più grande dell'intero porting.

**Il lavoro non si blocca in attesa della risposta.** Si scrive un **port** con due implementazioni, e la UI e le rotte non sanno quale è attiva:

```
src/duels/provider.ts     interfaccia DuelsProvider (trends(range), ratings(range, modeId), recent(query))
src/duels/pg.ts           implementazione su stats.duels_*  ← default
src/duels/mysql.ts        implementazione diretta (opzionale, dietro DUELS_MYSQL_URL)
src/duels/ingest.ts       il job ETL che riempie stats.duels_*
```

Se il committente sceglie (a), si attiva `mysql.ts` e si spegne il job; se sceglie (b), `pg.ts` e il job. **Le rotte, il contratto, la cache e tutta la UI sono identici nei due casi.**

### 1.3 Lo schema di destinazione (opzione b)

Le tabelle vanno **nello schema `stats`, con prefisso `duels_`**, non in uno schema nuovo. Ragione concreta: `stats.ensure_partitions` costruisce le partizioni con `format('CREATE TABLE stats.%I PARTITION OF stats.%I …')` — lo schema è cablato (`NUOVO/migrations/011_stats.sql:919`). Stando in `stats` si eredita gratis il registro delle partizioni (`stats.partitioned_table`, `:844-870`), la retention per DROP di partizione, i ruoli e i GRANT.

```sql
-- migrations/016_duels.sql  (dopo 015, che aggiunge il modulo RBAC)

-- Fatto: partite per ORA UTC. Nessuna colonna di fuso: le etichette locali
-- si calcolano nella vista, come per v_online_1h.
CREATE TABLE stats.duels_match_hour (
  bucket_at  timestamptz NOT NULL,          -- inizio dell'ora, UTC
  mode_id    smallint    NOT NULL,
  map_id     smallint    NOT NULL,
  match_type text        NOT NULL,          -- DUEL | FFA | altro (VARCHAR libero in origine)
  context    text        NOT NULL,          -- NORMAL | EVENT | altro
  matches    integer     NOT NULL CHECK (matches > 0),
  PRIMARY KEY (bucket_at, mode_id, map_id, match_type, context)
) PARTITION BY RANGE (bucket_at);

-- Le righe storiche SENZA created_at: hanno il giorno e non l'ora.
-- Stanno separate apposta — vedi §6.4.
CREATE TABLE stats.duels_match_day_untimed (
  day date NOT NULL, mode_id smallint NOT NULL, map_id smallint NOT NULL,
  match_type text NOT NULL, context text NOT NULL, matches integer NOT NULL,
  PRIMARY KEY (day, mode_id, map_id, match_type, context)
);

-- Cataloghi, replicati per intero a ogni giro (poche decine di righe).
CREATE TABLE stats.duels_mode (
  mode_id smallint PRIMARY KEY, name text NOT NULL, display_name text NOT NULL,
  ranking text, mode_type text, color text CHECK (color ~ '^#[0-9a-f]{6}$'),
  seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE stats.duels_map (
  map_id smallint PRIMARY KEY, name text, display_name text, map_type text,
  seen_at timestamptz NOT NULL DEFAULT now()
);

-- Feedback post-partita. DATO PERSONALE (uuid, nome, testo libero).
CREATE TABLE stats.duels_rating (
  rating_id   bigint      NOT NULL,
  created_at  timestamptz NOT NULL,
  match_id    uuid,
  player_uuid uuid        NOT NULL,
  player_name text,                          -- DENORMALIZZATO in ingestione
  mode_id     smallint,
  rating      smallint    NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     text,
  dialog      jsonb,                         -- validato lato server, non nel browser
  PRIMARY KEY (created_at, rating_id)
) PARTITION BY RANGE (created_at);

-- Aggregato additivo dei rating, per KPI/distribuzione/trend senza toccare il grezzo.
CREATE TABLE stats.duels_rating_day (
  day date NOT NULL, mode_id smallint NOT NULL DEFAULT -1,
  n integer NOT NULL, sum_rating integer NOT NULL, with_comment integer NOT NULL,
  r1 integer NOT NULL, r2 integer NOT NULL, r3 integer NOT NULL,
  r4 integer NOT NULL, r5 integer NOT NULL,
  PRIMARY KEY (day, mode_id)
);

CREATE TABLE stats.duels_ingest_state (
  source text PRIMARY KEY,        -- 'match' | 'rating' | 'catalog'
  last_id bigint NOT NULL DEFAULT 0,
  last_run_at timestamptz,
  since_day date                  -- il primo giorno di dati che esiste davvero
);

INSERT INTO stats.partitioned_table (table_name, granularity, keep_days, partition_options) VALUES
  ('duels_match_hour', 'month', 3650, 'autovacuum_vacuum_insert_scale_factor=0.02'),
  ('duels_rating',     'month',  730, 'autovacuum_vacuum_insert_scale_factor=0.02');
```

`keep_days` di `duels_rating` è **730 come `stats.player_day`** (`NUOVO/migrations/011_stats.sql:864-871`) perché contiene dati personali: è l'unica riga della migration che il committente deve confermare esplicitamente (§7.11).

**Viste di lettura, e il GRANT sta lì.** Nel pannello nuovo il ruolo di sola lettura riceve il `GRANT` **sulle viste, non sulle tabelle** (`NUOVO/migrations/011_stats.sql:700`, `:987-992`). Stessa regola: `stats.v_duels_hour` (che espone `local_dow` 0=lunedì e `local_hour` già calcolati), `stats.v_duels_mode`, `stats.v_duels_map`, `stats.v_duels_rating_day`, `stats.v_duels_rating` — e solo queste vanno in `GRANT SELECT … TO metamc_stats`.

### 1.4 Il job di ingestione

`src/duels/ingest.ts`, registrato come `JobDefinition` (`NUOVO/src/jobs/scheduler.ts:36`, avviato con `startJob`, `:111`), cadenza **5 minuti**.

- Watermark per `AUTO_INCREMENT`: `SELECT … WHERE id > ?` su `duels_match_statistics` e su `duels_match_ratings`, a lotti di 10.000, fino a esaurimento o al budget di ciclo.
- Le partite si aggregano **in Node** in `(bucket_at, mode_id, map_id, type, context) → count` e si scrivono con `INSERT … ON CONFLICT DO UPDATE SET matches = duels_match_hour.matches + EXCLUDED.matches`. Additivo, quindi un lotto ripetuto per un riavvio a metà è l'unico caso da proteggere: il watermark si aggiorna **nella stessa transazione** dell'upsert.
- `bucket_at` = `date_trunc('hour', created_at)`. Le righe con `created_at IS NULL` vanno in `duels_match_day_untimed` usando la colonna `date`. **Non** si fa `COALESCE(created_at, date)` come `LEGACY/src/lib/queries.ts:101`: quello è ciò che le manda tutte nella colonna «00» della heatmap.
- I rating si copiano riga per riga, risolvendo **una volta sola** il nome del giocatore (la `NAME_LATERAL` del legacy, `LEGACY/src/lib/queries.ts:425-441`, materializzava tutta `duels_replay_participants` due volte per richiesta) e riaggregando `duels_rating_day` per i giorni toccati.
- Pool MySQL dedicato, precedente da copiare: `max: 2` + `statement_timeout '5s'` dell'ingest esistente (`NUOVO/docs/architettura-fase2.md:895-899`). Utente MySQL di **sola lettura su 5 tabelle**, non l'utente pieno del legacy (`LEGACY/src/lib/config.ts:26-27`).
- Backfill iniziale: `scripts/duels-backfill.ts`, stesso codice a lotti, `since_day` = `min(COALESCE(created_at, date))`.

---

## 2. Trends

### 2.0 Contratto della rotta

**Un solo endpoint per l'intera schermata.** Il legacy ne fa quattro che scandiscono la stessa finestra (`LEGACY/src/components/sections/daily-chart.tsx:56`, `heatmap.tsx:23`, `top-list.tsx:43` ×2). Il precedente del pannello nuovo è l'opposto: `buildAll` costruisce tutta la panoramica in un giro e la mette in **un** involucro di cache (`NUOVO/src/http/routes/stats.ts:169-186`).

```
GET /api/duels/trends?range=24h|7d|30d|90d|1y
```

- `requireLevel(actorOf(request), 'duels', 1)` — come `NUOVO/src/http/routes/stats.ts:161`.
- **Enum di range chiuso**, quello del pannello: `NUOVO/src/stats/contract.ts:29-41`. Niente `?from=&to=`, per la ragione già scritta lì: lo spazio delle chiavi di cache deve restare finito ed enumerabile. Conseguenza voluta: il selettore è quello del guscio (`NUOVO/web/src/lib/range.ts:88`, `useRange` legge da `from: '/shell'`) e **non** si disegna un secondo selettore nella pagina. `All time` e le date libere non esistono; al loro posto la pagina dichiara `since` (§2.5).
- Servito con `ctx.statsCache.envelope(...)` + `sendEnvelope` (ETag, 304, `Cache-Control: private, max-age=0, must-revalidate`, brotli servito dai byte in cache): `NUOVO/src/http/routes/stats.ts:88-119`. Chiave `duels:v1:tr:{civilDay}:{range}`, TTL `ttlOf()` (`NUOVO/src/stats/warm.ts:149`). Le 5 chiavi entrano nel giro di warm esistente.
- Se il provider non è configurato: **503** con `{ error, detail }`, non un payload vuoto — `NUOVO/src/http/routes/stats.ts:151-157`.

```ts
type DuelsTrends = {
  v: 1;
  range: Range;
  bucket: 'hour' | 'day' | 'week';
  t: number[];                       // inizio di ogni bucket, epoch secondi, ASC
  /** Un elemento per combinazione (tipo, contesto) PRESENTE nel periodo.
   *  Le tab filtrano in memoria: nessuna nuova fetch, nessuna chiave in più. */
  combos: Array<{ type: string; context: string; v: (number | null)[] }>;
  heatmap: { cells: (number | null)[] };      // 168, indice = dow*24 + hour, dow 0 = lunedì
  untimed: number;                            // partite senza orario, escluse dalla heatmap
  modes: Array<{ id: number; name: string; ranking: string | null; type: string | null;
                 color: string | null; matches: number }>;   // TUTTE, anche a 0
  maps:  Array<{ id: number; name: string | null; type: string | null; matches: number }>;
  totals: { matches: number };
  since: string | null;              // 'YYYY-MM-DD': primo giorno che esiste davvero
  builtAt: number;
};
```

`bucket` per range, deciso dal server e non negoziabile dal client: `24h → hour` (24 punti), `7d → hour` (168), `30d → day` (30), `90d → day` (90), `1y → week` (52-53, settimana che parte di lunedì). È esatto a ogni livello perché i conteggi sono additivi.

**`null` e `0` non sono la stessa cosa**, ed è la regola 2 del contratto esistente (`NUOVO/src/stats/contract.ts:12-16`): `0` = «nessuna partita in quel bucket», `null` = «prima di `since`, il dato non esiste». Non si interpola mai attraverso un `null`.

### 2.1 Riquadro 1 — «Andamento partite»

**Cosa mostra.** Numero di partite nel tempo sul periodo scelto, come area. Sottotitolo: `{etichetta periodo} · {granularità} · {totale} partite`.

**Fonte.**

```sql
-- PostgreSQL, su stats.v_duels_hour
SELECT date_bin(:step, bucket_at, :origin) AS t,
       match_type, context, sum(matches)::int AS matches
  FROM stats.v_duels_hour
 WHERE bucket_at >= :from AND bucket_at < :to
 GROUP BY 1, 2, 3
 ORDER BY 1;
```

Le partite senza orario (`duels_match_day_untimed`) si **sommano al bucket giornaliero** quando `bucket >= 'day'`, e si **escludono** quando `bucket = 'hour'`; il campo `untimed` del payload dice quante sono, e la UI lo dichiara. Equivalente MySQL: `LEGACY/src/lib/queries.ts:216-236` senza `DATE_ADD(...)` se il DB è già allineato.

**Calcolo esatto.**
- Il server riempie **tutti** i bucket del periodo, da `from` a `to`. Non replicare `fillDays`, che parte dal primo giorno **con dati** (`LEGACY/src/lib/range.ts:153-158` + `LEGACY/src/app/api/stats/daily/route.ts:42`) e fa cominciare l'asse X silenziosamente in mezzo al periodo richiesto.
- I bucket antecedenti a `since` valgono `null`.
- `totals.matches` = somma di tutti i `combos[].v` non nulli. È lo stesso numero mostrato nel sottotitolo: si calcola una volta server-side, non con un `reduce` nel componente (`LEGACY/src/components/sections/daily-chart.tsx:61`).

**Filtri.** Due gruppi di tab nella barra del riquadro, **entrambi client-side**:
- Tipo: `Tutti | Duel | FFA` (più eventuali valori extra presenti nei `combos`: sono `VARCHAR(50)` liberi, `LEGACY/scripts/seed.ts:117-118`).
- Contesto: `Tutti | Normale | Evento`, stesso trattamento.
La serie disegnata è la somma dei `combos` che soddisfano entrambe le tab. Cambiare tab **non** rifà una richiesta.

**Resa nel design system.**
- Contenitore `Panel` + `PanelBar` (`NUOVO/web/src/components/page.tsx:34`, `:50`); niente `Card` del legacy, niente `shadow-card`, niente `animate-fade-in`.
- Grafico: SVG disegnato a mano, come `OnlineChart` (`NUOVO/web/src/components/stats-panels.tsx:253-396`, tracciato con `<path>` a `:295-396`). **Non installare Recharts.** Prima di scrivere il componente, estrarre in `web/src/lib/chart.ts` le tre funzioni oggi private o locali: `niceScale` (`stats-panels.tsx:96`), `segments` (`:223`) e `gaps` (`:239`) — `segments`/`gaps` sono esattamente ciò che implementa la regola «non interpolare sopra un `null`», e riscriverle è il modo sicuro di perderla.
- Linea `var(--ac)` 2px; riempimento `linear-gradient` verticale da `color-mix(in oklab, var(--ac) 45%, transparent)` a `transparent`. **Nessun `rgb()` letterale**: il legacy ne ha ovunque (`LEGACY/src/components/sections/daily-chart.tsx:99-155`).
- Griglia orizzontale `var(--grid)`; assi `var(--tx-muted)`; etichette `.t-micro`; numeri `.t-mono` con `tabular-nums` (`NUOVO/design/tokens.css:135`).
- Tooltip: `HoverTip` + `useHoverTip` (`NUOVO/web/src/components/hover-tip.tsx:26`, `:43`), non l'attributo `title`.
- Formattazione numeri: `numberFmt` it-IT (`NUOVO/web/src/components/stats-panels.tsx:75`); date: `dayFmt` (`:78`) e gli helper `axisLabel` / `dayAndTime` (`NUOVO/web/src/lib/when.ts`). **Niente `en-US`**: il legacy ha `'12.4K'` e `'Jul 28, 2026'` cablati (`LEGACY/src/lib/format.ts:3,10-13`).
- Transizioni `var(--dur-chart)` (400 ms) con `var(--ease)`. Niente animazione d'ingresso a ogni mount.

### 2.2 Riquadro 2 — «Mappa di attività» (heatmap)

**Cosa mostra.** 7 righe (Lun→Dom) × 24 colonne (00→23), intensità = partite in quella cella sull'intero periodo.

**Fonte.**

```sql
SELECT local_dow, local_hour, sum(matches)::int AS matches
  FROM stats.v_duels_hour
 WHERE bucket_at >= :from AND bucket_at < :to
 GROUP BY 1, 2;
```

Nella vista: `local_dow` = `extract(isodow from bucket_at AT TIME ZONE 'Europe/Rome')::int - 1` e `local_hour` = `extract(hour from bucket_at AT TIME ZONE 'Europe/Rome')::int`.

> **Trappola da non sbagliare.** MySQL `WEEKDAY()` è 0=lunedì (`LEGACY/src/lib/queries.ts:316`), PostgreSQL `isodow` è 1=lunedì. Senza il `- 1` la heatmap ruota di una riga e **sembra plausibile**: nessun test la prende, nessun utente se ne accorge. Il pannello nuovo usa già `isodow` in `v_online_1h` (`NUOVO/migrations/011_stats.sql`, vista a `:722`).

Il giorno di 25 ore (fine ora legale) ha due ore UTC che mappano sulla stessa ora locale: la somma è corretta e va commentata nel codice, non «aggiustata». `stats.day_seconds` esiste per questo (`NUOVO/migrations/011_stats.sql:119`).

**Calcolo esatto.** Il payload porta **sempre 168 celle**, non una matrice sparsa. `null` = nessun dato per quel bucket in tutto il periodo (es. periodo più corto di una settimana, o prima di `since`); `0` = coperto e vuoto. Le partite senza orario non entrano: `untimed` le dichiara.

**Intensità.** **Non** la normalizzazione sul massimo assoluto del legacy (`LEGACY/src/components/sections/heatmap.tsx:48-51`), che con un picco anomalo schiaccia tutto il resto a invisibile. Si usa il **95° percentile** dei valori non nulli come tetto: `i = min(1, v / p95)`; le celle sopra il tetto restano al massimo e la legenda dichiara `≥ {p95}`.

**Filtri.** Solo il periodo del guscio. Tipo e contesto **non** si applicano qui — come nel legacy, e va detto nel sottotitolo (`day-of-week × hour-of-day, tutti i tipi`).

**Resa.**
- Griglia CSS `grid-template-columns: 36px repeat(24, 1fr)`, `gap: 3px`, celle `aspect-ratio: 1`, contenitore `overflow-x: auto`. È la stessa forma della heatmap esistente (`NUOVO/web/src/components/stats-panels.tsx:590-700`): riusare quel componente generalizzandolo, non copiarlo.
- Rampa colore **da token**: `color-mix(in oklab, var(--ac) calc(i * 100%), var(--s-inset))`. Il pannello ha già un debito qui (`stats-panels.tsx:606` usa quattro esadecimali letterali): non raddoppiarlo.
- Cella `null`: fondo `var(--s-inset)` con tratteggio diagonale a 1px `var(--bd-subtle)` — deve essere **visibilmente diversa** da una cella a zero.
- Tooltip via `HoverTip`: «Lun 14:00 — 37 partite».
- Legenda in basso: `Meno` + 5 gradini + `Più`, e la dichiarazione della scala («intensità relativa al periodo selezionato»).
- **Stato vuoto vero**: se tutte le celle sono `null` o 0 si mostra `EmptyState` (`NUOVO/web/src/components/ui.tsx:258`) con «Nessuna partita registrata in questo periodo.» Il legacy non ce l'ha (`LEGACY/src/components/sections/heatmap.tsx:45`) e disegna 168 celle scure identiche a «tutti zero».

### 2.3 Riquadro 3 — «Modalità più giocate»

**Cosa mostra.** Classifica di **tutte** le modalità del catalogo per numero di partite nel periodo, barra proporzionale, conteggio e quota percentuale. Le modalità mai giocate restano in lista, in coda, attenuate.

**Fonte.**

```sql
SELECT m.mode_id, m.display_name, m.ranking, m.mode_type, m.color,
       COALESCE(a.matches, 0) AS matches
  FROM stats.v_duels_mode m
  LEFT JOIN (
        SELECT mode_id, sum(matches)::int AS matches
          FROM stats.v_duels_hour
         WHERE bucket_at >= :from AND bucket_at < :to
         GROUP BY mode_id) a ON a.mode_id = m.mode_id
 ORDER BY COALESCE(a.matches, 0) DESC, m.display_name ASC;
```

Il conteggio sta **dentro** la derivata, come nel legacy (`LEGACY/src/lib/queries.ts:272-279`, motivazione a `:253-256`): partire dal catalogo farebbe scansionare i fatti una volta per modalità.

**Calcolo esatto (client).** `total` = somma dei `matches` **delle righe visibili dopo il filtro ranking**; `max` = massimo; larghezza barra `= matches / max * 100`; quota `= matches / total * 100`, una cifra decimale. Sono **due normalizzazioni diverse nella stessa riga** (barra sul massimo, percentuale sul totale) ed è una scelta del legacy da conservare — ma va dichiarata nell'intestazione della colonna, non lasciata da indovinare.

**Filtri.** `Tutte | Ranked | Unranked`, **client-side** sul campo `ranking` già presente in ogni riga. Nessuna richiesta nuova. Nel legacy questa distinzione richiedeva schema-sniffing a runtime (`LEGACY/src/lib/queries.ts:265-270` sceglie fra `m.ranking` e `m.type` interrogando `INFORMATION_SCHEMA`): l'ETL normalizza una volta sola in `stats.duels_mode.ranking` e la doppia strada **non si porta** (§6.7).

**Nessun `LIMIT` cieco.** Il legacy non tronca per far tornare le percentuali (`LEGACY/src/lib/queries.ts:250-252`), ma così la risposta non ha tetto. Regola nuova: **`LIMIT 25` + una riga «Altre (N)» aggregata**, con `total` calcolato server-side sull'insieme completo. Le quote restano corrette e il payload ha un tetto.

**Resa.**
- `Panel` a metà della griglia `lg` (l'altra metà è Top mappe), lista con `max-height: 420px` e `overflow-y: auto; overscroll-behavior: contain`.
- Barra di fondo: `background: color-mix(in oklab, var(--serie) 22%, transparent)` dove `--serie` è **il colore della modalità**, non un accento fisso. Nel pannello nuovo il colore di una modalità è una **proprietà del dato** (`stats.mode.color`, validato `^#[0-9a-f]{6}$`, `NUOVO/migrations/011_stats.sql:186-190`; la nota a `NUOVO/design/tokens.css:165-180` spiega perché non è un token). Se `color` è nullo si ripiega su `FALLBACK` per posizione stabile nel dizionario (`NUOVO/web/src/components/stats-panels.tsx:67`), **mai** per indice nella lista ordinata del periodo: cambierebbe colore al cambio di periodo.
- Rango: `#N` in `.t-mono`. **Pari merito con lo stesso rango** (rango denso), non `#{i+1}` sull'indice come `LEGACY/src/components/sections/top-list.tsx:102-103`.
- `key` React = `mode_id`, non `${nome}-${indice}` (`top-list.tsx:95`).
- Righe a 0: restano, `color: var(--tx-disabled)`.
- Contatore «N modalità» nella `PanelBar`, in `.t-micro`.

### 2.4 Riquadro 4 — «Mappe più giocate»

Identico al precedente **con una differenza semantica da sanare**. Nel legacy Top modes parte dal catalogo e include le modalità a zero, Top maps parte dai fatti e **le mappe mai giocate spariscono** (`LEGACY/src/lib/queries.ts:296-303`); inoltre Top maps non ha tie-break (`:302`, solo `ORDER BY count DESC`), quindi le mappe a pari conteggio si riordinano a ogni refresh e la lista «salta».

**Decisione: comportamento unico.** Anche le mappe partono dal catalogo (`LEFT JOIN` da `stats.v_duels_map`), includono gli zeri e ordinano `matches DESC, display_name ASC`. Due card visivamente gemelle devono avere la stessa semantica.

`display_name` nullo (mappa cancellata dal catalogo di gioco) → si mostra `#{map_id}`, non `#{indice}`.

Colore: le mappe non hanno un colore proprio → accento unico `var(--blu-viz)`, che è il colore data-viz secondario del pannello (`NUOVO/design/tokens.css:40`).

### 2.5 Stati della schermata

- **Caricamento**: `StatsPanelsSkeleton` / `SkeletonRows` esistenti (`NUOVO/web/src/components/stats-panels.tsx:952`, `NUOVO/web/src/components/ui.tsx:282`).
- **Cambio periodo**: `placeholderData: (previous) => previous` e la pagina si smorza mentre arriva il nuovo — esattamente il pattern di `NUOVO/web/src/routes/overview.tsx:77` con la variabile `refreshing`. È l'equivalente di `keepPreviousData` di SWR.
- **Errore**: messaggio d'interfaccia, **mai** il testo dell'eccezione. `ApiError` porta solo `status` e `code` (`NUOVO/web/src/lib/api.ts:11-38`): non c'è nulla da stampare, ed è voluto. Il legacy stampa il messaggio MySQL grezzo in pagina (`LEGACY/src/lib/safe.ts:9-13` → `daily-chart.tsx:84`, `heatmap.tsx:39`, `top-list.tsx:80`).
- **Non configurato (503)**: `NotYet` (`NUOVO/web/src/components/stats-panels.tsx:873`) con il dettaglio di cosa manca.
- **`since` più recente dell'inizio del periodo**: banda esplicita sopra il grafico — «Raccolta iniziata il {since}: prima di quella data non c'è dato». Sostituisce il preset «All time» del legacy e dice la verità che quel preset nascondeva.
- **Polling**: `refetchInterval: 60_000` come la panoramica (`NUOVO/web/src/routes/overview.tsx:68`), non 30 s. Con ETag/304 il costo è una richiesta condizionale.

---

## 3. Ratings

### 3.0 Che cos'è un «rating», perché nessuno lo confonda

**Non è un sistema di skill rating.** Non è Elo, non è Glicko, non è MMR. È un **sondaggio di gradimento post-partita**: a fine match il giocatore dà da 1 a 5 stelle e può lasciare un commento libero, eventualmente attraverso una conversazione con un bot AI. Il commento del legacy lo dichiara: «Post-match player feedback» (`LEGACY/src/lib/queries.ts:566-571`).

In tutta la pagina non esiste **alcuna aritmetica oltre `COUNT`, `AVG` e `SUM`**: nessun K-factor, nessun expected score, nessuna rating deviation.

L'unico rating skill-based del legacy è l'**ELO**, che sta in `duels_userdata_stats` con `stat='ELO'` (`LEGACY/src/lib/queries.ts:450-463`) ed è consumato solo dalla leaderboard della home — **una schermata che non è fra le due da portare**. Se il committente si aspetta «Ratings = classifica Elo», sta guardando la pagina sbagliata.

Modello dei dati, per l'implementatore: un feedback = `(rating_id, created_at, match_id, player_uuid, mode_id, rating ∈ 1..5, comment?, dialog?)`. Un giocatore può lasciarne più di uno (uno per partita). Il vincolo `1..5` **non è garantito dal DB di origine** e va imposto in ingestione: la UI lo assume ovunque (`BAR_COLORS[rating-1]` va fuori array per 0 o 6, `LEGACY/src/components/sections/ratings-distribution.tsx:114`).

### 3.1 Contratto delle rotte

Due rotte, perché hanno due nature diverse.

```
GET /api/duels/ratings?range=…&mode=<id>       aggregati, in cache
GET /api/duels/ratings/recent?…                lista, MAI in cache
```

**Aggregati** — `requireLevel(actor, 'duels_feedback', 1)`, chiave `duels:v1:rt:{civilDay}:{mode|_all}:{range}`, stesso involucro/ETag/TTL di §2.0. Il parametro `mode` è validato contro un'allowlist rinfrescata su miss, esattamente come `isKnownMode` per `stats.mode` (`NUOVO/src/http/routes/stats.ts:146-150`): un id fuori catalogo risponde **404, non un payload vuoto** (`NUOVO/src/http/routes/stats.ts:210-213`: «un payload vuoto l'interfaccia lo disegna come zero giocatori: una bugia al posto di un errore»). Solo le modalità «calde» entrano nel giro di warm (`markHot` / `hotModes`, `NUOVO/src/stats/warm.ts:171-185`).

```ts
type DuelsRatings = {
  v: 1; range: Range; mode: number | null;
  total: number; average: number; withComment: number;
  distribution: [number, number, number, number, number];   // r1..r5, SEMPRE 5 elementi
  trend: { t: number[]; avg: (number | null)[]; n: (number | null)[] };  // per giorno civile
  mostRated:  { id: number; name: string; count: number; average: number } | null;
  bestRated:  { id: number; name: string; count: number; average: number } | null;
  bestRatedMinSample: number;      // 5 — DICHIARATO, non nascosto
  since: string | null; builtAt: number;
};
```

**Differenza voluta rispetto al legacy: gli aggregati rispettano il periodo.** Nel legacy KPI, distribuzione e lista sono su **tutto lo storico** e solo il trend ha i suoi 7/30/90 giorni (`LEGACY/src/components/sections/ratings-view.tsx:13-57`). Sotto un guscio con il selettore in alto, quell'asimmetria diventa un selettore che non fa niente su tre riquadri su quattro. **Tutti gli aggregati seguono il periodo del guscio**, e il sottotitolo lo dichiara.

**Lista** — `requireLevel(actor, 'duels_feedback', 1)`, `Cache-Control: private, no-store`, nessun involucro: è una query per utente con ricerca libera.

### 3.2 KPI — «Riepilogo valutazioni»

Cinque riquadri in riga. Tre fissi, due che cambiano con lo scope.

| KPI | Calcolo | Note |
|---|---|---|
| **Valutazioni totali** | `sum(n)` da `duels_rating_day` nel periodo | `numberFmt` it-IT. Niente conteggio animato |
| **Voto medio** | `sum(sum_rating) / sum(n)`, 2 decimali | Media grezza, **senza soglia di campione**: con un voto solo dice 5,00 |
| **Con commento** | `sum(with_comment) / sum(n) * 100`, 0 decimali; hint «N di M» | Il criterio guarda **solo `comment`**: un feedback con la sola conversazione AI e commento vuoto **non** conta |
| **Modalità più votata** *(solo scope globale)* | `GROUP BY mode_id ORDER BY n DESC, avg DESC LIMIT 1` | |
| **Modalità meglio votata** *(solo scope globale)* | idem con `HAVING sum(n) >= 5 ORDER BY avg DESC, n DESC LIMIT 1` | La soglia è `BEST_MODE_MIN_RATINGS = 5` (`LEGACY/src/lib/queries.ts:574`), unica regola di significatività dell'intera pagina — e nel legacy **non è mai mostrata**. Qui va nell'hint: «min. 5 valutazioni» |
| **Quota 5★** *(solo scope modalità)* | `r5 / total * 100` | Nessuna query in più: si ricava da `distribution` |
| **Quota bassa (1–2★)** *(solo scope modalità)* | `(r1 + r2) / total * 100` | idem |

Il titolo della sezione cambia con lo scope: «Riepilogo valutazioni» → «Riepilogo modalità».

**Resa.** `KpiCard` esistente (`NUOVO/web/src/components/stats-panels.tsx:133`), tipo `Card` a `:122`. Valore in `.t-display` (Montserrat, `tabular-nums`), etichetta `.t-micro`, hint `.t-sm var(--tx-muted)`. Superficie `var(--s-elevated)`, bordo `1px solid var(--bd-subtle)`. **Niente aloni sfocati, niente `shadow-glow`, niente hover che trasla**: il pannello ricava la profondità dai bordi hairline (`NUOVO/design/tokens.css:16`), non dalle ombre.

**Stelle.** Componente `Stars` nuovo in `duels-panels.tsx`: 5 icone, riempite fino a `Math.round(value)`, colore `var(--warn)`, vuote `var(--tx-disabled)`, `aria-label` con il valore **a due decimali** (compensa l'arrotondamento visivo). Il difetto noto — 3,50 disegna 4 stelle piene sopra la scritta «3,50» (`LEGACY/src/components/ui/stars.tsx:16`) — resta tollerabile solo perché il numero è sempre accanto: va commentato nel codice.

### 3.3 Riquadro — «Distribuzione dei voti»

**Cosa mostra.** Cinque barre, una per valore di stella. Sottotitolo: «Come i giocatori valutano le partite (1–5 stelle)».

**Calcolo.** `distribution` viene dalla **stessa risposta** dei KPI: cinque somme condizionali già materializzate in `duels_rating_day` (`r1..r5`). L'array è **sempre lungo 5**, anche a zero voti: non esistono barre mancanti. Percentuale nel tooltip = `count / total * 100`, 1 decimale.

> Nel legacy questo riquadro monta un **secondo hook SWR sullo stesso URL** dei KPI (`LEGACY/src/components/sections/ratings-distribution.tsx:33-39` vs `ratings-overview.tsx:101-107`). Qui è una sola `useQuery` condivisa nella pagina, passata giù come prop.

**Resa.** Cinque `<div>`, niente motore di grafici — è il caso in cui uscire da Recharts costa meno di tutti. Scala semaforica **dai token**, senza inventare colori (il legacy improvvisa `rgb(251 146 60)` e `rgb(132 204 22)`, che non esistono nemmeno fra le sue variabili, `ratings-distribution.tsx:24-30`):

```css
--r1: var(--err);
--r2: color-mix(in oklab, var(--err) 55%, var(--warn));
--r3: var(--warn);
--r4: color-mix(in oklab, var(--ok) 55%, var(--warn));
--r5: var(--ok);
```

Verificare che `--r2` e `--r4` restino distinguibili nei due temi; sotto ~3:1 di contrasto sul fondo si scarta il gradino intermedio e si passa a 3 colori + etichette. Il colore di una serie non è decorazione (`NUOVO/design/tokens.css:176-179`).

Etichette asse `1★ … 5★`, valori in `.t-mono`, `EmptyState` con «Nessuna valutazione registrata.» quando `total === 0`.

### 3.4 Riquadro — «Andamento del voto»

**Cosa mostra.** Media giornaliera nel tempo, **con la numerosità visibile**.

**Calcolo.**

```sql
SELECT day, sum(n)::int AS n, sum(sum_rating)::numeric / NULLIF(sum(n),0) AS avg
  FROM stats.v_duels_rating_day
 WHERE day BETWEEN :from AND :to AND (:mode IS NULL OR mode_id = :mode)
 GROUP BY day ORDER BY day;
```

**I giorni senza voti si riempiono con `null`** — non si saltano. Il legacy non li riempie (`LEGACY/src/lib/queries.ts:810-822`, nessun `fillDays` a differenza di `/api/stats/daily`): tre giorni di buco diventano un segmento retto che si legge come «la media è stata stabile». `segments`/`gaps` (§2.1) fanno il resto: **non si interpola sopra un `null`**.

**`n` si disegna.** Il legacy trasporta `count` e non lo usa mai (`LEGACY/src/lib/queries.ts:814` vs `ratings-trend.tsx:114`): un giorno con **un** voto da 5★ è indistinguibile da uno con 400 voti a 5,00. Qui `n` va come **barre di fondo** in `color-mix(in oklab, var(--tx-muted) 20%, transparent)` sull'asse destro, oppure — decisione minima accettabile — come seconda riga del tooltip. Le barre sono meglio: il rumore statistico si vede.

**Asse Y.** Dominio `[0, 5]` fisso con tick `0..5`, come il legacy (`ratings-trend.tsx:93-94`). È corretto per una media su scala 1–5, ma schiaccia variazioni reali fra 4,1 e 4,4: si aggiunge una **banda di riferimento** alla media del periodo (linea 1px tratteggiata `var(--tx-muted)`), che restituisce la variazione senza mentire sulla scala.

**Filtri.** Il periodo del guscio. **Spariscono le tab 7d/30d/90d** interne al riquadro (`ratings-trend.tsx:39`): erano un secondo controllo temporale nella pagina, ed è esattamente il difetto da non riportare.

**Resa.** Stesso componente area di §2.1, linea `var(--warn)` (la scala delle stelle è ambra in tutta la schermata), riempimento `color-mix`. Punto singolo: se c'è un solo bucket si disegna un `circle r=3`, altrimenti la serie è invisibile — dettaglio del legacy da preservare (`ratings-trend.tsx:119`).

### 3.5 Riquadro — «Valutazioni recenti»

**Cosa mostra.** Elenco dei singoli feedback: avatar, nome, modalità, stelle, `n/5`, tempo relativo; sotto, la conversazione AI per intero se esiste, altrimenti il commento come citazione.

**Rotta.**

```
GET /api/duels/ratings/recent?range=…&mode=<id>&q=<testo>&comment=all|with|without
                              &sort=recent|worst|best&cursor=<opaco>
```

**Paginazione keyset, non OFFSET.** Il legacy fa `LIMIT ? OFFSET ?` più una `COUNT(*)` separata sugli stessi join pesanti a ogni cambio pagina (`LEGACY/src/lib/queries.ts:756-759`, `:769`, `:789`). Il cursore è la tupla dell'`ORDER BY`, che il legacy già scrive nella forma giusta (`queries.ts:762-767`):

| sort | ORDER BY | cursore | indice |
|---|---|---|---|
| `recent` | `created_at DESC, rating_id DESC` | `(created_at, rating_id)` | PK |
| `worst` | `rating ASC, created_at DESC, rating_id DESC` | `(rating, created_at, rating_id)` | `(rating, created_at DESC, rating_id DESC)` |
| `best` | `rating DESC, created_at DESC, rating_id DESC` | idem | stesso indice |

`pageSize` 15, deciso dal server. Il conteggio totale **non si calcola a ogni pagina**: si spedisce `total` solo alla prima richiesta di una combinazione di filtri, e la barra dice «15 di 1.284» oppure semplicemente «altre».

**Ricerca.** `q` cerca su nome giocatore **e** testo del commento. Nel legacy è `LIKE '%q%'` su un `COALESCE` che coinvolge una colonna della derivata — non indicizzabile per costruzione (`queries.ts:736-741`). Qui: `player_name` è denormalizzato in ingestione (il join sparisce del tutto) e la ricerca usa un **indice GIN trigram**:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX ON stats.duels_rating USING gin (player_name gin_trgm_ops);
CREATE INDEX ON stats.duels_rating USING gin (comment gin_trgm_ops);
```

Debounce 300 ms lato client, come il legacy (`recent-ratings.tsx:168-171`).

**Filtro commento.** `with` → `comment IS NOT NULL AND comment <> ''`; `without` → il complemento; `all` → nessuna clausola.

**Reset di pagina.** Quando cambia la chiave dei filtri (`${mode}|${q}|${comment}|${sort}`) il cursore si azzera **durante il render**, confrontando con la chiave precedente — non in un `useEffect`. È la tecnica corretta del legacy (`recent-ratings.tsx:173-180`) e va replicata: in un effect si emetterebbe prima una richiesta con il cursore vecchio.

**Resa.**
- Non è una tabella: `@tanstack/react-table` è nello stack ma una tabella a colonne fisse non regge un thread multi-riga. Lista di righe, con la conversazione in una **riga espandibile** (chiusa di default, contatore «3 messaggi» — il legacy la tiene sempre aperta e la lista diventa illeggibile).
- Riga: avatar 24px, nome, badge modalità (`Pill`, `NUOVO/web/src/components/ui.tsx:129`) colorato col colore della modalità, `Stars`, `n/5` in `.t-mono`, tempo relativo con `RelativeTime` (`ui.tsx:411`).
- Commento senza dialogo: paragrafo rientrato con barra laterale `2px solid var(--bd-subtle)`, corsivo, virgolette tipografiche.
- **`dialog` arriva già parsato dal server.** È `jsonb` validato in ingestione contro lo schema `Array<{role: string, content: string}>`; un JSON malformato viene **registrato** e la riga arriva con `dialog: null`. Nel legacy è parsato nel browser con un `try/catch` silenzioso e sparisce senza traccia (`recent-ratings.tsx:46-58`).
- **Divieto di build**: `innerHTML` / `dangerouslySetInnerHTML` sono vietati senza eccezioni (`NUOVO/scripts/check-guards.ts:103-113`, `exempt: () => false`). Commenti e nomi sono stringhe controllate da terzi: qualunque idea di «rendiamo il commento con la formattazione» fa fallire la build.
- Stato vuoto **differenziato**, come nel legacy: «Nessuna valutazione corrisponde ai filtri.» se ci sono filtri attivi, «Nessuna valutazione registrata.» altrimenti.

### 3.6 Avatar

`https://mc-heads.net` **non funziona**: la CSP dichiara `img-src 'self' data:` (`NUOVO/src/http/index-html.ts:72`). Non è un errore lato server, è un'immagine rotta in ogni riga.

Il proxy giusto esiste già: `NUOVO/src/http/routes/avatars.ts:28` serve `/api/avatars/:name.png`, autenticato, con `cache-control: private, max-age=3600` e `x-content-type-options: nosniff`; il perché il CDN esterno è escluso è scritto in `NUOVO/src/minecraft/skins.ts:1-28` (quel dominio vedrebbe l'IP di chi guarda e il nome di chi è guardato, riga per riga del registro).

Due attriti concreti e la loro soluzione:

1. La rotta accetta uno **username** validato da `isMinecraftUsername` (`avatars.ts:38`), la riga di rating porta anche uno **UUID**. Poiché l'ETL denormalizza già `player_name`, si usa il nome e **non serve alcuna modifica**. Se il nome è nullo si mostrano le iniziali (`Avatar`, `NUOVO/web/src/components/ui.tsx:325`), che è già il comportamento di ripiego.
2. `sessionserver.mojang.com` accetta **una richiesta al minuto per profilo** (`skins.ts:22-27`). Con 15 righe per pagina va bene; sfogliando velocemente «Peggiori prima» su giocatori tutti diversi la quota si brucia e le facce spariscono a metà lista. Mitigazione: `loading="lazy"` + il ripiego alle iniziali, che è silenzioso e già implementato.

Terza opzione, se il committente vuole zero rete: `duels_replay_participants` ha già `texture_value` / `texture_signature` (`LEGACY/scripts/seed.ts:157-158`) — la texture è nel database.

---

## 4. Configuration

Resta **vuota**. Si costruisce lo scheletro, non si inventano funzioni.

- **Rotta**: `/duels/configurazione`, figlia di `shellRoute` (`NUOVO/web/src/main.tsx:263-317`), componente `DuelsConfigPage` in `web/src/routes/duels-config.tsx`.
- **Permesso**: `duels >= 3` (gestione). La voce **non compare** nella sidebar per chi non ce l'ha: nessuna voce disabilitata, nessun lucchetto — l'elenco stesso dei moduli è informazione (`NUOVO/web/src/components/shell.tsx:1-5`).
- **Nessuna rotta API.** Non si registra `/api/duels/config` finché non c'è nulla da configurare: una rotta vuota è superficie d'attacco senza contropartita.
- **Contenuto**: `PageHeader` («Configurazione», sottotitolo «Impostazioni del modulo Duels») + un solo `EmptyState`:
  > **Non c'è ancora niente da configurare.**
  > Le impostazioni del modulo compariranno qui quando saranno decise.

  Il pannello ha già la primitiva per dirlo bene: `NotYet` (`NUOVO/web/src/components/stats-panels.tsx:873`), che esiste proprio perché «uno zero al posto di un dato mancante è la stessa bugia che il resto di questo lavoro esiste per impedire» (`NUOVO/web/src/routes/overview.tsx:14-16`).
- **Nessuna action di audit**, perché non succede niente.
- **Test**: uno solo — la rotta risponde 200 a chi ha `duels >= 3` e la voce non compare in `/api/me` per gli altri.

I candidati per il futuro (da **non** implementare adesso) sono in §7.12.

---

## 5. Navigazione e permessi

### 5.1 I due moduli nuovi

I moduli sono il vocabolario del sistema e **si aggiungono con una migration, non da runtime**: `NUOVO/migrations/003_rbac.sql:239` fa `REVOKE INSERT, UPDATE, DELETE ON auth.modules FROM metamc_app`.

| chiave | nome | 1 = lettura | 2 = scrittura | 3 = gestione |
|---|---|---|---|---|
| `duels` | Duels | Andamento (aggregati, nessun dato personale) | *(riservato)* | Configurazione |
| `duels_feedback` | Valutazioni Duels | Valutazioni: nomi, UUID, commenti liberi, ricerca | moderazione (nascondere un commento) — **non implementata** | retention ed export |

**Perché due moduli e non uno.** I livelli sono un ordine totale con un significato dichiarato — `0 nessuno, 1 lettura, 2 scrittura, 3 gestione` (`NUOVO/src/authz/modules.ts:26`). Usare «2» per dire «può vedere i dati personali» torcerebbe quel vocabolario in tutto il sistema. Due moduli separano ciò che va separato: le partite sono numeri aggregati, i feedback sono nomi di persone e testo libero, e non è detto che chi guarda i grafici debba leggere i commenti.

### 5.2 La migration

```sql
-- migrations/015_duels_module.sql
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

INSERT INTO auth.modules (key, name, sort_order) VALUES
  ('duels',          'Duels',              75),
  ('duels_feedback', 'Valutazioni Duels',  76);

-- ATTENZIONE. t_protect_system_role_permissions (003_rbac.sql:156-171) rifiuta
-- QUALUNQUE insert sui permessi di un ruolo di sistema, e `owner` lo e'. Nel
-- seed originale il trigger veniva creato DOPO (commento a 003_rbac.sql:166-167);
-- qui esiste gia', quindi va disabilitato per la durata del seed.
ALTER TABLE auth.role_permissions DISABLE TRIGGER t_protect_system_role_permissions;

INSERT INTO auth.role_permissions (role_id, module_id, level)
SELECT r.id, m.id, v.level
FROM (VALUES
  ('owner',      'duels', 3), ('owner',      'duels_feedback', 3),
  ('admin',      'duels', 3), ('admin',      'duels_feedback', 2),
  ('dev',        'duels', 1), ('dev',        'duels_feedback', 0),
  ('moderatore', 'duels', 1), ('moderatore', 'duels_feedback', 1)
) AS v(role_key, module_key, level)
JOIN auth.roles r ON r.key = v.role_key
JOIN auth.modules m ON m.key = v.module_key;

ALTER TABLE auth.role_permissions ENABLE TRIGGER t_protect_system_role_permissions;
```

Tre cose che l'implementatore deve sapere e che non sono ovvie:

1. **`DISABLE TRIGGER` richiede di essere proprietari della tabella**: verificare con quale ruolo gira il runner di migration prima di scrivere questa riga. Se non lo è, l'alternativa è `DROP TRIGGER` + ricrearlo identico in coda alla stessa migration.
2. **Non disabilitare `t_bump_role_permissions`** (`003_rbac.sql:109-110`): è quello che alza `permissions_version` a tutti gli utenti dei ruoli toccati, cioè ciò che fa vedere il modulo nuovo **alle sessioni già aperte**. Lo snapshot di autorizzazione vive in Redis senza TTL e si ricostruisce solo sul cambio di versione (`NUOVO/src/authz/store.ts:1-12`). Senza il bump, nessuno vede la voce nuova finché non rifà il login.
3. **`owner` deve avere 3 su entrambi i moduli nuovi.** La matrice determina la dominanza, cioè chi può agire su chi: la motivazione è scritta a `003_rbac.sql:186-193`. Se un ruolo non-owner avesse un livello superiore a quello di admin su un modulo, admin smetterebbe di dominarlo.

Poi, obbligatoriamente: aggiungere `'duels'` e `'duels_feedback'` a `MODULES` in `NUOVO/src/authz/modules.ts:7-16` — è la controparte tipizzata del seed ed è **verificata da un test** che fallisce se le due liste divergono.

### 5.3 La sidebar

L'ordine dell'array `NAV` **è** l'ordine della barra e i gruppi si formano nell'ordine in cui compaiono le voci (`NUOVO/web/src/components/shell.tsx:40-43`). Il gruppo «Duels» va **dopo «Analisi» e prima di «Amministrazione»**: è materia di analisi, non di amministrazione.

```ts
// in NAV, dopo la voce 'Dettaglio modalità'
{ modules: ['duels'],          label: 'Andamento',     to: '/duels/andamento',     area: 'Duels', icon: ICONS.trend },
{ modules: ['duels_feedback'], label: 'Valutazioni',   to: '/duels/valutazioni',   area: 'Duels', icon: ICONS.star },
{ modules: ['duels'],          label: 'Configurazione', to: '/duels/configurazione', area: 'Duels', icon: ICONS.gear },
```

- **La regola di visibilità è già scritta**: `NAV.filter(n => n.modules.some(m => me.modules.includes(m)))` (`shell.tsx:96`). `me.modules` arriva già filtrato dal server; il client disegna e basta.
- **La Configurazione sfugge a questa regola**: richiede `duels >= 3`, non `>= 1`. Serve un campo in più sulla voce (`minLevel?: Level`) e che `/api/me` esponga i **livelli**, non solo l'elenco delle chiavi. Se oggi `Me.modules` è solo `ModuleKey[]`, questa è la modifica minima da fare — altrimenti la voce comparirebbe anche a chi poi prende 403.
- **Icone**: `lucide-react` non è installato. Le icone sono stringhe di path in `ICONS` (`NUOVO/web/src/components/ui.tsx:459`), disegnate da `Icon` (`:434`). Servono tre path nuovi. Le 10 icone dei KPI Ratings del legacy (Star, Sparkles, MessageSquare, ThumbsUp, ThumbsDown, Crown, Trophy, Search, ChevronLeft, ChevronRight) vanno **ridotte**: solo Star e MessageSquare hanno un ruolo informativo, il resto è decorazione.
- **Command palette**: aggiungere i due comandi «Vai a Duels — Andamento» e «Vai a Duels — Valutazioni», filtrati con la stessa regola dei moduli (`NUOVO/web/src/main.tsx:101-120`).

### 5.4 Rotte e periodo

Le tre pagine sono figlie di `shellRoute` (`NUOVO/web/src/main.tsx:263-284`), quindi ereditano automaticamente il selettore di periodo nella barra in alto e `validateSearch: rangeSearch`. Il periodo **vive nella URL** ed è presidiato da un test (`NUOVO/tests/acceptance/52-range-in-url.test.ts`); il motivo è scritto a `NUOVO/web/src/lib/range.ts:7-12` — «incollato in chat, un grafico dell'anno arrivava come una settimana».

**Il filtro modalità di Ratings va nella URL insieme al periodo**, come search param tipizzato: `?mode=<id>`. Nel legacy è `useState` puro (`LEGACY/src/components/sections/ratings-view.tsx:14`) e la vista filtrata non è condivisibile. Stesso trattamento per `sort`, `comment` e `q` della lista: `retainSearchParams` è già importato in `main.tsx:15`.

Le tab di tipo/contesto/ranking di Trends **non** vanno nella URL: sono filtri client-side su un payload già in mano, e metterli nella URL suggerirebbe che cambino i dati richiesti.

### 5.5 Audit

`NUOVO/src/audit/actions.ts` non contiene **nessuna** azione di lettura: registra solo cambi di stato. Per l'Andamento va benissimo così — non si registra niente.

Per le Valutazioni serve **una** action, e non è «ha aperto la pagina»:

```ts
// in AUDIT_ACTIONS
duelsRatingSearch: 'duels.rating.search',   // chi ha cercato CHI: e' questo il fatto sensibile
```

Si registra su `/api/duels/ratings/recent` **solo quando `q` è non vuoto**, con il termine cercato nei metadati. Registrare ogni consultazione della lista produrrebbe una riga ogni pagina sfogliata e renderebbe il registro illeggibile proprio dove serve.

Se un domani si aggiunge la moderazione dei commenti, quelle sì sono azioni di stato e vanno registrate tutte.

---

## 6. Cosa NON replicare

1. **Il polling a 30 secondi senza cache.** `LEGACY/src/hooks/useStats.ts:19` forza `refreshInterval: 30_000` su ogni widget, le rotte sono `force-dynamic`, il fetcher usa `cache: 'no-store'` (`useStats.ts:8`) e `jsonOk` non emette alcun `Cache-Control` (`LEGACY/src/lib/safe.ts:16-18`). Una sola scheda `/trends` aperta = 4 aggregazioni ogni 30 secondi, per sempre. **Questa, non le query, è la causa della lentezza.** → involucro in cache + ETag/304 + warm (`NUOVO/src/http/routes/stats.ts:88-119`), `refetchInterval: 60_000`.
2. **`config.cacheTtl` / `STATS_CACHE_TTL`.** Definito a `LEGACY/src/lib/config.ts:35`, documentato nel `.env.example`, **mai letto da nessuna parte**. È una manopola morta che fa credere a chi legge la configurazione che esista una cache. Non portare nemmeno il nome.
3. **Quattro richieste per la stessa finestra.** → un payload per schermata (§2.0).
4. **`COALESCE(created_at, date)`** (`LEGACY/src/lib/queries.ts:101`). Le righe storiche senza timestamp valgono mezzanotte e finiscono **tutte nella colonna «00»** della heatmap, gonfiandola. → separate in `duels_match_day_untimed`, contate nel giornaliero, escluse dalla heatmap, dichiarate in interfaccia.
5. **`fillDays` che parte dal primo giorno con dati** (`LEGACY/src/lib/range.ts:153-158` + `daily/route.ts:42`). Il grafico mente sull'ampiezza del periodo mostrato. → il server riempie tutto il periodo richiesto, `null` prima di `since`.
6. **La macchina del fuso orario** (`LEGACY/src/lib/clock.ts:34-81`, `LEGACY/src/lib/queries.ts:38-103`): sonda SQL sul percorso caldo, cache di processo da 5 minuti, offset **inlineato** nella stringa SQL con un clamp difensivo a ±1439, predicati non sargable per costruzione. E `TIME_OFFSET_HOURS` (`LEGACY/src/lib/config.ts:36-39`) è una manopola per un problema che un `timestamptz` non ha. → normalizzazione in ingestione, etichette locali calcolate una volta nella vista.
7. **`hasTable` / `hasColumn` a runtime** (`LEGACY/src/lib/queries.ts:165-193`): interrogano `INFORMATION_SCHEMA` e memorizzano in una `Map` di processo **senza TTL**, quindi dopo una migrazione il pannello usa la forma vecchia finché non riparte. Servono per `duels_mode.ranking`, l'esistenza di `duels_match_ratings`, la colonna `dialog`, `duels_replay_participants`. → il pannello nuovo ha migration versionate con checksum: si sceglie **uno** schema e lo si fissa.
8. **Il degrado morbido a zeri.** Ogni query ratings comincia con «se la tabella non c'è restituisci zero» (`queries.ts:570-571`, `:623`, `:719`, `:800`), quindi senza tabella la pagina mostra KPI a zero e nessun errore. → **503 con il dettaglio di cosa manca**, e 404 invece di un payload vuoto (`NUOVO/src/http/routes/stats.ts:151-157`, `:210-213`).
9. **I messaggi d'errore del database in pagina.** `LEGACY/src/lib/safe.ts:9-13` propaga `err.message` grezzo fino a «failed to load: {message}». Su un pannello pubblico è una fuga di schema; su uno autenticato con audit è comunque sbagliato. → `ApiError` porta solo `status` e `code`.
10. **La normalizzazione della heatmap sul massimo assoluto** (`LEGACY/src/components/sections/heatmap.tsx:48-51`) e **l'assenza dello stato vuoto** (`:45`). → percentile 95 + stato vuoto vero + cella `null` visivamente distinta.
11. **`count` calcolato e mai disegnato** nel trend dei rating (`queries.ts:814` vs `ratings-trend.tsx:114`). → si disegna.
12. **L'asimmetria fra Top modes e Top maps** (uno include gli zeri, l'altro no; uno ha il tie-break, l'altro riordina a caso a ogni refresh, `queries.ts:281` vs `:302`). → comportamento unico.
13. **`#{indice+1}` come rango** e **`key` React su nome + indice** (`LEGACY/src/components/sections/top-list.tsx:95`, `:102-103`), quando il payload ha già `mode_id`/`map_id`.
14. **La `COUNT(*)` duplicata e `NAME_LATERAL`** (`queries.ts:425-441`, `:756-759`, `:786`): due materializzazioni complete di `duels_replay_participants` per mostrare 15 righe, e il join su `UNHEX(REPLACE(u.uuid,'-',''))`. → nome denormalizzato in ingestione, keyset, niente `COUNT` per pagina.
15. **`u.username` senza guardia** (`queries.ts:737`, `:776`) quando il DDL di riferimento crea `duels_userdata` con **sole** colonne `id` e `uuid` (`LEGACY/scripts/seed.ts:124-128`). → §7.3: va verificato **prima** di scrivere una riga.
16. **Tre query sequenziali per l'overview**, due senza filtro temporale (`queries.ts:628`, `:649`, `:657`) che aggregano tutto lo storico ogni 60 secondi per riempire due card. → un aggregato giornaliero già materializzato.
17. **`dialog` come JSON in colonna testuale parsato nel browser con `try/catch` silenzioso** (`recent-ratings.tsx:46-58`): un JSON malformato sparisce senza traccia né log. → `jsonb` validato lato server.
18. **`mc-heads.net`** (`recent-ratings.tsx:36-38`): bloccato dalla CSP e, anche se non lo fosse, manderebbe gli UUID dei giocatori a un terzo a ogni render.
19. **Il preset «All time»** (`LEGACY/src/lib/range.ts:16,95-96`, `from = 2000-01-01`): la query peggiore del progetto dietro il pulsante più facile da premere. → `since` dichiarato.
20. **Colori letterali**: `rgb(34 211 238)`, `rgb(167 139 250)`, `rgb(251 191 36)`, `rgb(32 38 52)`, `rgb(16 20 28)`, `rgb(20 24 34)` in `daily-chart.tsx:99-155`, `heatmap.tsx:86-108`, `top-list.tsx:50-51`, `ratings-distribution.tsx:23-30`, `ratings-trend.tsx:74-119`. Due colori dell'istogramma non esistono nemmeno fra le variabili del legacy. **Onestà**: il pannello nuovo ha già questo debito (`NUOVO/web/src/components/stats-panels.tsx:606` e `:65`). Non è una licenza — è un debito da non raddoppiare.
21. **Decorazione che il pannello nuovo non ammette**: titolo in gradiente con testo trasparente (`LEGACY/src/components/page-header.tsx:15`), aloni sfocati `blur-2xl` sui KPI (`ratings-overview.tsx:66-72`), `shadow-glow` in hover, `fade-in` a ogni mount delle card (`card.tsx:24`), conteggio animato dei KPI (`animated-number.tsx`). La profondità viene dai bordi hairline.
22. **`en-US` cablato ovunque** (`LEGACY/src/lib/format.ts:3,10-13`, `range.ts:178-181`) e i numeri con `font-mono` ma **senza** `tabular-nums` in metà dei posti (`top-list.tsx:102,121-126`). → `it-IT` e cifre tabulari **ovunque compaia un numero** (`NUOVO/design/tokens.css:135`).
23. **Il filtro modalità fuori dalla URL** (`ratings-view.tsx:14`).
24. **Recharts.** Non è installato e non va installato: i grafici del pannello sono SVG disegnati a mano (`NUOVO/web/src/components/stats-panels.tsx:295-396`, `:480-503`).

---

## 7. Incognite aperte

Ognuna con **cosa cambia** a seconda della risposta. Le prime tre bloccano l'inizio del lavoro.

1. **Da dove vengono i dati storici: (a) MySQL diretto, (b) ETL verso PostgreSQL, (c) il gioco scrive altrove?**
   *(b)* → si costruisce `stats.duels_*` + il job, e la lentezza sparisce insieme al fuso orario; costo iniziale più alto, latenza dei dati pari alla cadenza del job. *(a)* → si aggiungono `mysql2` e la policy di dipendenze (`NUOVO/docs/deps-policy.md`, `NUOVO/scripts/check-deps.ts:37`), si riscrive da capo la macchina di fuso per la nuova coppia di macchine, e si eredita ogni difetto della sezione 6 tranne la cache. *(c)* → si riparte da zero come storia: i grafici partono vuoti e `since` = oggi. Il codice dice solo che Redis non basta: la scelta è del committente.
2. **Il MySQL `duels` è raggiungibile dalla rete del pannello, con quali credenziali, ed esiste una replica di lettura?**
   Serve un utente di **sola lettura su 5 tabelle**, non l'utente pieno del legacy (`LEGACY/src/lib/config.ts:26-27`). Se non c'è replica, l'ETL va calibrato per non pesare sul primario del gioco (lotti piccoli, cadenza bassa). Se non è raggiungibile affatto, resta solo (c).
3. **`duels_userdata` in produzione ha la colonna `username`?**
   Il codice la usa senza guardia (`queries.ts:737`, `:776`) mentre protegge tutto il resto, e il DDL di riferimento crea la tabella con sole `id` e `uuid` (`LEGACY/scripts/seed.ts:124-128`). **Se non c'è, «Recent ratings» oggi fallisce con `Unknown column`** — la schermata gira già in modalità degradata e non c'è niente da replicare, solo da progettare. Da verificare con un `DESCRIBE` prima di scrivere una riga.
4. **Il DDL reale di `duels_match_ratings`.** Non è creato né dalla dashboard né dal seed: lo crea il plugin di gioco. Servono tipi, PK e soprattutto gli **indici** su `created_at`, `mode_id`, `player_id`. Senza `created_at` indicizzato l'ETL incrementale per watermark su `id` resta l'unica strada praticabile; con l'indice si può anche ripescare per finestra temporale in caso di buchi.
5. **Volumi e crescita** di `duels_match_statistics`, `duels_match_ratings`, `duels_replay_participants`.
   Sotto ~10 M righe il backfill è un pomeriggio; sopra serve un piano a lotti con ripresa. Determina anche se `duels_match_hour` basta o serve anche un grano giornaliero pre-aggregato.
6. **`duels_mode` in produzione: schema pre o post migrazione** (`ranking` separato, o dentro `type`)?
   Il legacy supporta entrambi a runtime (`queries.ts:200`, `:267`). L'ETL deve fissarne **uno**: se è pre-migrazione, `ranking` si ricava da `type` e `mode_type` resta nullo; se è post, si copiano entrambe. Sbagliare significa un filtro Ranked/Unranked che non filtra niente.
7. **`duels_match_statistics.created_at` contiene NULL, e da che data è affidabile?**
   Determina quante righe finiscono in `duels_match_day_untimed` e quindi quanto è utile la heatmap sui periodi lunghi. Se sono poche, si dichiara il numero; se sono la maggioranza dello storico, la heatmap va limitata a un periodo massimo.
8. **Il vocabolario dei filtri resta `type = DUEL|FFA`, `context = NORMAL|EVENT`, `ranking = RANKED|UNRANKED`?**
   Sono `VARCHAR(50)` liberi (`LEGACY/scripts/seed.ts:117-118`), non enum: in produzione potrebbero esistere valori che il legacy non contempla e che finivano solo dentro «ALL». Il contratto proposto li trasporta come stringhe libere proprio per non perderli, ma le **etichette italiane** delle tab vanno decise sui valori reali.
9. **`duels_match_ratings.rating` è garantito 1..5?**
   Se non c'è un `CHECK` nel DB di origine, l'ETL scarta e **conta** i fuori scala; il numero va mostrato, perché altrimenti la somma delle cinque barre non torna con il totale — difetto silenzioso già presente nel legacy (`queries.ts:578-586`).
10. **La colonna `dialog` è viva o è un residuo? Qual è il contratto del JSON e chi lo scrive?**
    Il legacy la tratta come opzionale con il commento «esiste solo dopo che il plugin lobby ha migrato la tabella» (`queries.ts:724-725`), e il client accetta `Array<{role, content}>` distinguendo solo `role === 'bot'` (`recent-ratings.tsx:34,51-54`). Se è viva serve lo schema esatto (esistono altri ruoli? c'è un timestamp per turno?); se è morta, si risparmia l'intera riga espandibile.
11. **Retention dei commenti dei giocatori.**
    Sono dati personali. `stats.player_day` ha 730 giorni per DROP di partizione (`NUOVO/migrations/011_stats.sql:864-871`) e `stats.player.player_id` è marcato «DATO PERSONALE (identificatore online, art. 4(1) GDPR)». Se non si decide un `keep_days`, quei commenti restano per sempre — e la migration lo scriverebbe nero su bianco.
12. **Cosa va in «Configuration».**
    Due schermate completamente diverse: (i) i parametri oggi cablati — `BEST_MODE_MIN_RATINGS = 5` (`queries.ts:574`), la dimensione di pagina, gli intervalli di aggiornamento, il tetto dei giorni; oppure (ii) la configurazione **del gioco** — modalità, mappe, colori, come la pagina `/wiki` del legacy. La (ii) implica scrittura verso il database del gioco, cioè un permesso e un audit completamente diversi.
13. **La distinzione RBAC proposta va bene?**
    Se `duels_feedback` resta separato, il moderatore legge i commenti e il dev no — che è probabilmente il verso giusto. Se il committente preferisce un modulo solo, i commenti diventano visibili a chiunque veda i grafici e la matrice va rivista.
14. **Il colore delle modalità di gioco.**
    Nel pannello nuovo il colore è una proprietà del dato (`stats.mode.color`). Le modalità dei duels ne hanno uno in `duels_mode`, o va assegnato dall'operatore in Configuration, o si usa il ripiego per posizione? Cambia se le barre di «Modalità più giocate» sono riconoscibili a colpo d'occhio o tutte dello stesso accento.
15. **Il modulo Duels avrà anche una pagina Live?**
    Se no, tutta la parte Redis del legacy resta fuori e la domanda «Redis ha i dati» diventa irrilevante per questa fase. Se sì, va confermato che `duels:match:*` e `duels:queue:mode:*` siano visibili all'utente ACL del pannello — oggi **non lo sono** (`NUOVO/docs/architettura-fase2.md:886`) — e va tenuto presente che i nomi di modalità e mappa non stanno comunque in Redis (`LEGACY/src/lib/activeMatches.ts:63-69`): una Live costruita solo su Redis mostrerebbe «modalità 7 su mappa 12».
16. **Frequenza reale di aggiornamento.**
    Il legacy fa polling a 30-60 s su aggregati giornalieri. Se bastano 5 minuti con il payload in cache, la maggior parte del problema di lentezza sparisce senza toccare una query. Se serve il secondo, l'ETL va portato a una cadenza molto più stretta e cambia il dimensionamento.