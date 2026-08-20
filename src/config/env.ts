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
  SESSION_ABSOLUTE_SECONDS: z.coerce
    .number()
    .int()
    .default(8 * 60 * 60),
  SESSION_IDLE_SECONDS: z.coerce
    .number()
    .int()
    .default(30 * 60),
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
   * Il Redis di gioco. In questa installazione e' la stessa istanza del
   * pannello, quindi in assenza si usa REDIS_URL — ma con un client
   * dedicato, con i suoi timeout e senza autopipelining.
   */
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
   * In assenza si usa REDIS_URL: le chiavi stanno tutte sotto `stats:v2:` e il
   * client e' comunque dedicato, quindi separare l'istanza un domani non
   * richiede di toccare il codice.
   */
  CACHE_REDIS_URL: z.string().min(1).optional(),
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
  return result.data;
}
