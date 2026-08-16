// Hashing password. §5.2, SEC-25, SEC-28, SEC-30, SEC-40
//
// Parametri: m=19456 (floor OWASP), t=2, p=1, outputLen=32, pepper da HKDF.
//
// Deviazione da RFC 9106 SECOND RECOMMENDED (m=65536) documentata in
// docs/security/deviations.md: 64 MiB x N login concorrenti su un threadpool
// da pochi thread e' un DoS a costo zero, e il moltiplicatore di sicurezza in
// questo sistema e' il 2FA obbligatorio piu' il rate limiting, non la memoria
// per hash.
//
// @node-rs/argon2 e' CommonJS: in un progetto "type": "module" va importato
// come default (accertato dallo SPIKE-4).

import { timingSafeEqual } from 'node:crypto';
import argon2 from '@node-rs/argon2';
import type { HashSemaphore } from './semaphore.ts';

const { hash, verify } = argon2;

// `algorithm` non viene passato di proposito: `Algorithm` e' un ambient const
// enum e con `verbatimModuleSyntax` non e' accessibile a runtime (il type
// stripping lo cancella e resta un oggetto vuoto). Il default di
// @node-rs/argon2 e' gia' Argon2id — verificato, e comunque riverificato dal
// test che controlla il prefisso della PHC string.
export const ARGON2_PARAMS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

/** Minimo 12, massimo 128 (§8.6). Nessuna regola di composizione: NIST SHALL NOT. */
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

/**
 * NFKC prima dell'hash (§8.6): senza normalizzazione la stessa password
 * digitata su due sistemi operativi diversi produce due hash diversi.
 */
export function normalizePassword(password: string): string {
  return password.normalize('NFKC');
}

/**
 * @node-rs/argon2 2.1.0 NON esporta `needsRehash` (il §3.3 lo dava per
 * presente: verificato falso nello SPIKE-4). I parametri si leggono dalla PHC
 * string, che il modulo produce correttamente.
 */
export function phcParams(phc: string): { m: number; t: number; p: number } | undefined {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(phc);
  if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined) return undefined;
  return { m: Number(m[1]), t: Number(m[2]), p: Number(m[3]) };
}

/**
 * SEC-40 — un hash va rifatto se i parametri sono cambiati OPPURE se e' stato
 * prodotto con un pepper di versione precedente. La seconda condizione e'
 * quella che permette di ruotare il pepper senza un reset password globale:
 * senza `pepper_version` sulla riga utente, cambiare pepper invaliderebbe
 * tutti gli hash in un colpo.
 */
export function needsRehash(phc: string, userPepperVersion: number, currentPepperVersion: number): boolean {
  if (userPepperVersion !== currentPepperVersion) return true;
  const p = phcParams(phc);
  if (!p) return true;
  return (
    p.m !== ARGON2_PARAMS.memoryCost || p.t !== ARGON2_PARAMS.timeCost || p.p !== ARGON2_PARAMS.parallelism
  );
}

export type PasswordServiceOptions = {
  pepper: Buffer;
  semaphore: HashSemaphore;
};

export class PasswordService {
  readonly #pepper: Buffer;
  readonly #semaphore: HashSemaphore;
  /** Hash-esca, precomputato all'avvio con parametri IDENTICI (SEC-30). */
  #decoy: string | undefined;

  constructor(opts: PasswordServiceOptions) {
    this.#pepper = opts.pepper;
    this.#semaphore = opts.semaphore;
  }

  /**
   * Precalcola l'hash-esca. Va chiamato una volta all'avvio: calcolarlo alla
   * prima richiesta renderebbe quella richiesta distinguibile.
   */
  async warmUp(): Promise<void> {
    if (this.#decoy) return;
    this.#decoy = await hash('esca-che-nessuno-usera-mai-come-password', {
      ...ARGON2_PARAMS,
      secret: this.#pepper,
    });
  }

  async hash(password: string): Promise<string> {
    return this.#semaphore.run(() =>
      hash(normalizePassword(password), { ...ARGON2_PARAMS, secret: this.#pepper }),
    );
  }

  async verify(phc: string, password: string): Promise<boolean> {
    return this.#semaphore.run(async () => {
      try {
        return await verify(phc, normalizePassword(password), { secret: this.#pepper });
      } catch {
        // Una PHC string malformata non e' una password valida. Non si
        // distingue da una password sbagliata, nemmeno nel messaggio.
        return false;
      }
    });
  }

  /**
   * SEC-30 — percorso utente inesistente.
   *
   * Verifica la password contro l'hash-esca, con gli stessi parametri e
   * passando dallo stesso semaforo. Restituisce SEMPRE false. Serve solo a
   * consumare lo stesso tempo e le stesse risorse del percorso reale.
   */
  async verifyDecoy(password: string): Promise<false> {
    if (!this.#decoy) await this.warmUp();
    const decoy = this.#decoy;
    if (!decoy) return false;
    await this.#semaphore.run(async () => {
      try {
        await verify(decoy, normalizePassword(password), { secret: this.#pepper });
      } catch {
        /* l'esito non interessa: conta il costo */
      }
    });
    return false;
  }

  /** Confronto a tempo costante fra digest di lunghezza fissa (recovery code). */
  static timingSafeDigestEqual(a: Buffer, b: Buffer): boolean {
    // Lunghezza fissa 32 byte per costruzione: nessuna eccezione possibile.
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}
