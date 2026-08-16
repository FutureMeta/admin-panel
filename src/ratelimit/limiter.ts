// SEC-24…SEC-27 — rate limiting.
//
// UN SOLO rate limiter (rate-limiter-flexible su Redis). `rateLimit.enabled`
// e' false su better-auth e @fastify/rate-limit non e' installato: tre punti
// di fail-open indipendenti sulla prima barriera davanti ad Argon2 sono tre
// occasioni di sbagliarne uno.
//
// I limiti si compongono in AND (SEC-26): per IP, per account, e un TETTO
// GLOBALE per rotta. Il tetto globale e' l'unica difesa contro IP falsificati
// o una botnet distribuita, dove i limiti per-IP non mordono mai.
//
// SEC-27 — insuranceLimiter obbligatorio: se Redis e' irraggiungibile il
// limiter degrada su uno store in memoria, NON apre il login.

import type { Redis } from 'ioredis';
import { RateLimiterMemory, RateLimiterRedis, type RateLimiterAbstract, RateLimiterRes } from 'rate-limiter-flexible';

export type LimitSpec = {
  /** Tentativi consentiti nella finestra. */
  points: number;
  /** Finestra, in secondi. */
  duration: number;
  /** Blocco fisso al superamento, in secondi. 0 = nessun blocco oltre la finestra. */
  blockDuration?: number;
};

/**
 * I limiti di fase 1. Enumerati qui: un limite deciso dentro un handler e' un
 * limite che nessuno ritrova quando serve cambiarlo.
 */
export const LIMITS = {
  /** Login: la barriera davanti ad Argon2. */
  loginIp: { points: 20, duration: 300, blockDuration: 300 },
  loginAccount: { points: 10, duration: 900, blockDuration: 900 },
  /** Tetto per ROTTA, indipendente da chi chiama (SEC-26). */
  loginGlobal: { points: 300, duration: 60 },

  /** SEC-26: verifica 2FA, 5 tentativi / 15 min, con backoff esponenziale. */
  twoFactorAccount: { points: 5, duration: 900, blockDuration: 900 },
  twoFactorIp: { points: 30, duration: 900, blockDuration: 300 },
  twoFactorGlobal: { points: 200, duration: 60 },

  /** Consumo invito: per token e per IP. */
  inviteToken: { points: 10, duration: 3600, blockDuration: 3600 },
  inviteIp: { points: 30, duration: 3600, blockDuration: 600 },

  /** Reset password (§8.7): risposta identica, ma il costo non lo e'. */
  forgotIp: { points: 10, duration: 3600, blockDuration: 600 },
  forgotAccount: { points: 5, duration: 3600, blockDuration: 3600 },

  /** Recovery code: identico al TOTP (§8.4). */
  recoveryAccount: { points: 5, duration: 900, blockDuration: 900 },

  /** Fondo scala per tutte le rotte autenticate. */
  apiIp: { points: 600, duration: 60 },
} as const satisfies Record<string, LimitSpec>;

export type LimitName = keyof typeof LIMITS;

export class RateLimited extends Error {
  readonly retryAfterSeconds: number;
  readonly limitName: string;
  constructor(limitName: string, msBeforeNext: number) {
    super('limite di frequenza superato');
    this.name = 'RateLimited';
    this.limitName = limitName;
    this.retryAfterSeconds = Math.max(1, Math.ceil(msBeforeNext / 1000));
  }
}

export type RateLimitOptions = {
  /**
   * Client Redis. Se assente, tutti i limiter girano in memoria: e' la
   * configurazione dei test, e va bene perche' la POLITICA e' la stessa —
   * cambia solo dove sta il contatore.
   */
  redis?: Redis;
};

export class RateLimitService {
  readonly #limiters = new Map<LimitName, RateLimiterAbstract>();
  /**
   * Contatore di recidiva, separato dal limiter principale.
   *
   * Serve un contatore a parte perche' `block()` riscrive i punti consumati
   * del limiter su cui agisce: leggendo quelli, il backoff resterebbe
   * inchiodato al secondo scalino per sempre. Questo contatore non viene mai
   * bloccato, quindi cresce in modo monotono per tutta la sua finestra.
   */
  readonly #strikes = new Map<LimitName, RateLimiterAbstract>();

  constructor(opts: RateLimitOptions = {}) {
    for (const [name, spec] of Object.entries(LIMITS) as Array<[LimitName, LimitSpec]>) {
      this.#limiters.set(name, RateLimitService.#build(name, spec, opts.redis));
      this.#strikes.set(
        name,
        RateLimitService.#build(`${name}:strikes`, { points: 1_000_000, duration: 86_400 }, opts.redis),
      );
    }
  }

  static #build(name: string, spec: LimitSpec, redis?: Redis): RateLimiterAbstract {
    const common = {
      keyPrefix: `rl:${name}`,
      points: spec.points,
      duration: spec.duration,
      ...(spec.blockDuration ? { blockDuration: spec.blockDuration } : {}),
    };
    if (!redis) return new RateLimiterMemory(common);
    return new RateLimiterRedis({
      ...common,
      storeClient: redis,
      // SEC-27 — se Redis cade, si continua a limitare in memoria. Il limite
      // in memoria e' meno preciso (e' per-processo), ma l'alternativa e'
      // togliere la barriera davanti ad Argon2 proprio nel momento in cui
      // l'infrastruttura e' gia' sotto stress.
      insuranceLimiter: new RateLimiterMemory(common),
    });
  }

  #get(name: LimitName): RateLimiterAbstract {
    const l = this.#limiters.get(name);
    if (!l) throw new Error(`limite non configurato: ${name}`);
    return l;
  }

  /**
   * Consuma un punto. Lancia `RateLimited` se il limite e' superato.
   *
   * SEC-25 — va chiamata PRIMA di qualunque chiamata ad Argon2, incluso il
   * percorso utente-inesistente. Se il rate limit venisse consumato solo per
   * gli utenti esistenti, il costo della richiesta diventerebbe l'oracolo che
   * SEC-30 elimina.
   */
  async consume(name: LimitName, key: string, points = 1): Promise<void> {
    try {
      await this.#get(name).consume(key, points);
    } catch (err) {
      if (err instanceof RateLimiterRes) throw new RateLimited(name, err.msBeforeNext);
      // Un errore che non e' un RateLimiterRes e' un guasto dello store. Con
      // insuranceLimiter non dovrebbe arrivare qui; se arriva, si chiude.
      throw new RateLimited(name, 1000);
    }
  }

  /**
   * Consuma piu' limiti in AND. Sono composti a mano invece che con
   * RateLimiterUnion perche' serve sapere QUALE limite ha morso, per l'audit
   * e per il Retry-After giusto.
   */
  async consumeAll(entries: ReadonlyArray<readonly [LimitName, string]>): Promise<void> {
    for (const [name, key] of entries) {
      await this.consume(name, key);
    }
  }

  /**
   * Backoff esponenziale (SEC-26) per la verifica 2FA e i recovery code.
   *
   * Dopo il superamento, ogni tentativo ulteriore raddoppia il blocco fino a
   * un'ora. Un blocco fisso di 15 minuti invita a riprovare per sempre a
   * ritmo costante; il raddoppio rende il tentativo automatizzato inutile
   * senza mai chiudere fuori per sempre una persona reale.
   */
  async penalize(name: LimitName, key: string): Promise<number> {
    const limiter = this.#get(name);
    const strikes = this.#strikes.get(name);
    if (!strikes) throw new Error(`contatore di recidiva non configurato: ${name}`);

    const res = await strikes.penalty(key, 1);
    const over = Math.max(0, res.consumedPoints - limiter.points);
    const seconds = Math.min(3600, 60 * 2 ** over);
    await limiter.block(key, seconds);
    return seconds;
  }

  /** Azzera i contatori dopo un successo: i tentativi falliti non si sommano fra sessioni sane. */
  async reward(name: LimitName, key: string): Promise<void> {
    await this.#get(name).delete(key);
    await this.#strikes.get(name)?.delete(key);
  }

  /** Stato corrente, per la UI e per /internal/metrics. Non consuma. */
  async peek(name: LimitName, key: string): Promise<{ consumed: number; remaining: number } | undefined> {
    const limiter = this.#get(name);
    const res = await limiter.get(key);
    if (!res) return undefined;
    return { consumed: res.consumedPoints, remaining: Math.max(0, limiter.points - res.consumedPoints) };
  }
}
