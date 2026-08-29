// Validazione dell'ambiente al boot. Zod e' usato QUI e nel payload dei
// webhook dopo la verifica della firma: mai al confine HTTP, dove valida
// AJV attraverso i JSON Schema di Fastify (§0.7, §3.6).
//
// Il processo non parte con una configurazione incompleta. Fallire all'avvio
// e' l'unico momento in cui un errore di configurazione costa poco.

import { z } from 'zod';

const hex32 = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, 'atteso 32 byte in esadecimale (64 caratteri)')
  .transform((s) => Buffer.from(s, 'hex'));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // --- rete -----------------------------------------------------------------
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('127.0.0.1'),
  /** Origine ESATTA del pannello. SEC-15 confronta questa stringa e nient'altro. */
  APP_ORIGIN: z.string().url(),
  /**
   * CIDR del proxy, mai `true` (SEC-22). Con trustProxy: true chiunque puo'
   * dichiarare il proprio IP con un header e falsificare rate limit e audit.
   */
  TRUST_PROXY_CIDR: z.string().min(1),

  // --- dati -----------------------------------------------------------------
  DATABASE_URL: z.string().min(1),
  DATABASE_MIGRATE_URL: z.string().min(1).optional(),
  PG_POOL_MAX: z.coerce.number().int().min(1).max(50).default(6),
  /** Redis (il documento diceva Valkey: stesso protocollo, stesso client). */
  REDIS_URL: z.string().min(1),

  // --- crittografia ---------------------------------------------------------
  /**
   * SEC-39 — un solo segreto radice. Tutte le altre chiavi sono derivate con
   * HKDF e un `info` distinto per scopo. Mai una chiave sola per tutto, mai
   * una chiave per scopo scritta a mano in env.
   */
  MASTER_KEY: hex32,
  /** SEC-40 — la versione del pepper in uso per i NUOVI hash. */
  PEPPER_VERSION: z.coerce.number().int().min(1).default(1),

  /**
   * §10 — dove il job di ancoraggio scrive le teste di partizione firmate.
   *
   * Facoltativa con un default, non obbligatoria: renderla richiesta
   * impedirebbe l'avvio a un'installazione che gira gia'. Il file locale e' il
   * primo passo — portarlo su uno storage append-only fuori da questa macchina
   * resta una decisione di chi gestisce il server.
   */
  AUDIT_ANCHOR_PATH: z.string().min(1).default('./audit-anchor.jsonl'),

  // --- Argon2 e threadpool --------------------------------------------------
  /** §5.1: mai il default 4. Il threadpool e' condiviso da Argon2, fs, dns, zlib. */
  UV_THREADPOOL_SIZE: z.coerce.number().int().min(2).max(128).default(8),

  // --- email ----------------------------------------------------------------
  RESEND_API_KEY: z.string().min(1).optional(),
  RESEND_WEBHOOK_SECRET: z.string().min(1).optional(),
  MAIL_FROM: z.string().default('MetaMC Admin <no-reply@metamc.it>'),

  // --- sessione -------------------------------------------------------------
  /**
   * Il tetto della sessione: si fissa al login e NESSUNO lo proroga (SEC-05).
   *
   * Quattordici giorni, non otto ore. E' una scelta dell'esercente, presa
   * sapendo cosa costa, ed e' scritta per intero in D-11 di
   * `docs/security/deviations.md`.
   */
  SESSION_ABSOLUTE_SECONDS: z.coerce
    .number()
    .int()
    .default(14 * 24 * 60 * 60),
  /**
   * Inattivita' massima. **Zero = controllo spento.**
   *
   * Spento qui: il pannello vive aperto in una scheda, e react-query non
   * interroga il server quando la finestra non e' a fuoco. Trenta minuti di
   * inattivita' scattavano a ogni pausa, a ogni riunione, a ogni sospensione
   * del portatile, e il rientro costava password piu' TOTP. Vedi D-11 per il
   * conto completo di cosa si perde.
   */
  SESSION_IDLE_SECONDS: z.coerce.number().int().min(0).default(0),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // --- statistiche, fase 2 --------------------------------------------------
  /**
   * Il campionamento e' SPENTO finche' non lo si accende.
   *
   * Non e' prudenza: e' che accenderlo scrive ~2.900 righe al giorno e apre
   * una connessione permanente al Redis di gioco. Deve essere una decisione,
   * non una conseguenza di un aggiornamento.
   */
  STATS_INGEST_ENABLED: z
    .enum(['0', '1'])
    .default('0')
    .transform((v) => v === '1'),
  /**
   * Il ruolo che scrive le statistiche: `metamc_ingest`, mai `metamc_app`.
   *
   * La 011 non da' a `metamc_app` nessun diritto sulle tabelle di fatto, e
   * questo e' voluto: il ruolo che regge i login non deve poter scrivere nel
   * grezzo. Senza questa variabile il campionamento non parte.
   */
  DATABASE_INGEST_URL: z.string().min(1).optional(),
  /**
   * Il ruolo dei giri di rollup. In assenza si usa quello del campionamento:
   * cambia solo quale timeout eredita chi si collega a mano. Il pool resta
   * separato in ogni caso, perche' un giro lungo non deve poter togliere la
   * connessione al ciclo da trenta secondi.
   */
  DATABASE_ROLLUP_URL: z.string().min(1).optional(),
  /**
   * Il ruolo di SOLA LETTURA delle statistiche: `metamc_stats`.
   *
   * Ha `default_transaction_read_only` impostato sul ruolo e vede le VISTE,
   * non le tabelle di fatto: chi leggesse i rollup nudi disegnerebbe zeri al
   * posto dei buchi e medie con il denominatore preso dalle righe sbagliate.
   * Senza questa variabile le rotte rispondono 503, non 404.
   */
  DATABASE_STATS_URL: z.string().min(1).optional(),
  /**
   * L'ingestione dei duels e' SPENTA finche' non la si accende.
   *
   * Stessa ragione del campionamento, piu' una: accenderla apre una
   * connessione permanente al MySQL del gioco, che e' un database di
   * qualcun altro. Deve essere una decisione.
   *
   * L'ORDINE CONTA: prima si importa lo storico con `pnpm run duels:backfill`,
   * poi si accende questa. Accendendola prima, il giro da trenta secondi
   * comincia dallo storico piu' vecchio a lotti da diecimila e ci mette ore,
   * e nel frattempo le schermate mostrano una storia che cresce all'indietro.
   * Non e' sbagliato — i numeri restano giusti — ma e' incomprensibile.
   */
  DUELS_INGEST_ENABLED: z
    .enum(['0', '1'])
    .default('0')
    .transform((v) => v === '1'),
  /**
   * Il MySQL del gioco, in SOLA LETTURA.
   *
   * L'utente dovrebbe avere il SELECT sulle cinque tabelle che
   * `src/duels/mysql.ts` nomina e su nient'altro. Il codice non puo'
   * imporlo: puo' solo non scrivere mai, che e' quello che fa.
   */
  DUELS_MYSQL_URL: z.string().min(1).optional(),
  /**
   * Il fuso in cui il server di gioco scrive `created_at`.
   *
   * E' UN FUSO, NON UN OFFSET, ed e' la stessa lezione di `registration_tz`
   * nella migration 012: un offset costante sbaglia di un'ora per meta' anno.
   * Il controllo e' di FORMA, non di esistenza — l'elenco dei fusi vive in un
   * catalogo e non si puo' interrogare da qui; un nome inesistente si
   * manifesta alla prima conversione con «time zone not recognized», che e'
   * un messaggio che si capisce.
   *
   * Il predefinito e' Europe/Rome perche' e' cio' che la macchina del gioco
   * usa oggi: misurato il 22 agosto 2026, il pannello mostrava le partite due
   * ore avanti rispetto al pannello vecchio, che e' esattamente lo scarto fra
   * Roma e UTC d'estate.
   */
  DUELS_SOURCE_TZ: z
    .string()
    .regex(/^(UTC|[A-Za-z]+(\/[A-Za-z0-9_+-]+){1,2})$/)
    .default('Europe/Rome'),
  /**
   * Il Redis di gioco. In questa installazione e' la stessa istanza del
   * pannello, quindi in assenza si usa REDIS_URL — ma con un client
   * dedicato, con i suoi timeout e senza autopipelining.
   */
  /**
   * Il segreto con cui i server di gioco chiedono il proprio bundle di
   * configurazioni.
   *
   * Facoltativo: senza, la rotta del bundle risponde 503 e il resto del
   * pannello gira uguale. Vive nel `credentials.yml` del plugin, che e'
   * l'unico file che il pannello NON gestisce proprio perche' contiene i
   * segreti — e quindi e' l'unico posto in cui questo token puo' stare senza
   * finire dentro se stesso.
   */
  DUELS_CONFIG_TOKEN: z.string().min(24).optional(),

  GAME_REDIS_URL: z.string().min(1).optional(),
  /** Il pattern dell'insieme online, misurato dalla sonda del passo 0. */
  GAME_REDIS_PATTERN: z.string().min(1).default('metaverse:player:*'),
  /**
   * Il Redis dei payload statistici.
   *
   * Il §7.2 vuole un'istanza dedicata (`allkeys-lru`, `save ""`, 64 MB): su
   * quell'istanza vivono SOLO payload, quindi `evicted_keys != 0` diventa un
   * allarme invece di una statistica — con ~1,5 MB previsti contro 64 MB, una
   * eviction significa che qualcuno ci ha scritto chiavi non previste.
   *
   * In assenza si usa REDIS_URL: le chiavi stanno tutte sotto `stats:v<n>:` e il
   * client e' comunque dedicato, quindi separare l'istanza un domani non
   * richiede di toccare il codice.
   */
  CACHE_REDIS_URL: z.string().min(1).optional(),
  /**
   * Il database geografico DB-IP, in un VOLUME e mai in un layer
   * dell'immagine: altrimenti l'aggiornamento senza riavvio non ha dove
   * scrivere.
   *
   * Assente = geolocalizzazione spenta. Non e' un degrado: il paese resta
   * NULL su ogni riga (che significa «funzione non attiva») invece di
   * diventare XX (che significa «attiva e non risolta»), e il payload porta
   * geo: null, cosi' l'interfaccia nasconde il widget invece di disegnare
   * una mappa vuota.
   */
  GEO_MMDB_PATH: z.string().min(1).optional(),

  // --- assistente (Svetlana) ------------------------------------------------
  /**
   * La chiave dell'API di Anthropic. Vive SOLO qui, nell'ambiente del
   * processo Node, e non raggiunge mai il browser: il pannello parla con una
   * rotta nostra, ed e' quella rotta a parlare con il fornitore.
   *
   * Assente = assistente spento. La rotta risponde 503 e il resto del
   * pannello non cambia, esattamente come per le statistiche senza il loro
   * ruolo di lettura.
   */
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  /**
   * Il ruolo di SOLA LETTURA da cui l'assistente guarda `auth` e `audit`:
   * `metamc_assistant`, mai `metamc_app`.
   *
   * `metamc_app` scrive, e la regola della versione 1 e' che nessun tool
   * possa modificare niente — una regola che vale quanto il posto in cui e'
   * scritta. Con questa variabile sta nel database (migration 019); senza,
   * i due tool che guardano il pannello rispondono «non disponibile» e quelli
   * delle statistiche funzionano lo stesso.
   */
  DATABASE_ASSISTANT_URL: z.string().min(1).optional(),
  /**
   * Quanto a fondo pensa. `medium` di base: le domande sono per lo piu'
   * ricerche su dati gia' aggregati, e alzarlo si paga a ogni messaggio.
   */
  ASSISTANT_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  /**
   * Il tetto di spesa MENSILE, in dollari. Al superamento l'assistente si
   * spegne con un messaggio chiaro, non fallisce in silenzio.
   *
   * Zero = nessun tetto, ed e' una scelta esplicita: il valore predefinito non
   * lo e'.
   */
  ASSISTANT_MONTHLY_BUDGET_USD: z.coerce.number().min(0).default(50),
  /**
   * Il timeout verso l'API, in millisecondi.
   *
   * Il default dell'SDK e' dieci minuti: una chiamata appesa dieci minuti e'
   * una richiesta del pannello appesa dieci minuti. Un guasto del fornitore
   * deve diventare un messaggio d'errore nella chat, non un'attesa.
   */
  ASSISTANT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(60_000),
});

export type Env = z.infer<typeof EnvSchema>;

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.') || '(radice)'}: ${i.message}`)
      .join('\n');
    // SEC-41: si stampa il NOME della variabile mancante, mai il suo valore.
    throw new Error(`configurazione non valida:\n${issues}`);
  }
  if (result.data.NODE_ENV === 'production' && !result.data.APP_ORIGIN.startsWith('https://')) {
    throw new Error('APP_ORIGIN deve essere https:// in produzione: i cookie __Host- richiedono Secure.');
  }
  if (result.data.STATS_INGEST_ENABLED && !result.data.DATABASE_INGEST_URL) {
    // Fallire all'avvio invece di partire e non raccogliere: un campionamento
    // acceso che non scrive e' un buco che nessuno guarda, e ce ne si accorge
    // settimane dopo davanti a un grafico vuoto.
    throw new Error(
      'STATS_INGEST_ENABLED=1 richiede DATABASE_INGEST_URL (ruolo metamc_ingest, non metamc_app).',
    );
  }
  if (
    result.data.DUELS_INGEST_ENABLED &&
    (!result.data.DUELS_MYSQL_URL || !result.data.DATABASE_INGEST_URL)
  ) {
    // Due variabili, e mancarne una sola basta a rendere il giro inutile: si
    // fallisce all'avvio invece di partire, non ingerire, e lasciare le
    // schermate ferme a un'ora che non si muove piu'.
    throw new Error(
      'DUELS_INGEST_ENABLED=1 richiede DUELS_MYSQL_URL (sola lettura sul MySQL del gioco) ' +
        'e DATABASE_INGEST_URL (ruolo di scrittura su stats).',
    );
  }
  return result.data;
}
