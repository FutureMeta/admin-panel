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
  return result.data;
}
