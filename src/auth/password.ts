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
import { currentPepperSubject } from './pepper-context.ts';
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

/**
 * Cosa fare quando un hash e' stato verificato con un pepper vecchio.
 *
 * Vive fuori dal servizio perche' scrivere su `auth.account` e su
 * `auth.user` non e' compito di chi calcola hash, e perche' un suo guasto
 * non deve poter far fallire un login: chi la implementa inghiotte i propri
 * errori e li registra.
 */
export type RehashSink = (input: {
  userId: string;
  /**
   * L'hash nuovo, oppure `undefined` quando c'e' solo da riallineare la
   * colonna: l'hash era gia' prodotto con il pepper corrente ed era la riga a
   * dichiarare il numero sbagliato. Rifarlo sarebbe lavoro per niente.
   */
  phc?: string;
  pepperVersion: number;
}) => Promise<void>;

export type PasswordServiceOptions = {
  /**
   * SEC-40 — i pepper per versione, dalla 1 alla corrente.
   *
   * Non uno solo: un hash prodotto prima di una rotazione va verificato con il
   * pepper con cui e' nato, altrimenti ruotare equivarrebbe a un reset
   * password globale.
   */
  peppers: Map<number, Buffer>;
  /** La versione usata per i NUOVI hash. */
  currentPepperVersion: number;
  semaphore: HashSemaphore;
  /** Facoltativo: senza, la migrazione degli hash non avviene e basta. */
  onRehash?: RehashSink;
};

export class PasswordService {
  readonly #peppers: Map<number, Buffer>;
  readonly #currentVersion: number;
  readonly #semaphore: HashSemaphore;
  readonly #onRehash: RehashSink | undefined;
  /** Hash-esca, precomputato all'avvio con parametri IDENTICI (SEC-30). */
  #decoy: string | undefined;

  constructor(opts: PasswordServiceOptions) {
    this.#peppers = opts.peppers;
    this.#currentVersion = opts.currentPepperVersion;
    this.#semaphore = opts.semaphore;
    this.#onRehash = opts.onRehash;

    const current = this.#peppers.get(this.#currentVersion);
    if (!current) {
      // Meglio non partire che partire senza poter hashare: sarebbe un
      // pannello che accetta password e non ne verifica nessuna.
      throw new Error(`manca il pepper della versione corrente (${this.#currentVersion})`);
    }
  }

  /** Il pepper corrente: quello con cui nascono i nuovi hash. */
  get #pepper(): Buffer {
    const current = this.#peppers.get(this.#currentVersion);
    if (!current) throw new Error('pepper corrente assente');
    return current;
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

  /**
   * SEC-30 — verifica a costo COSTANTE.
   *
   * Se la PHC string non e' una delle nostre (utente inesistente, segnaposto
   * della libreria, riga corrotta) si verifica comunque contro l'hash-esca,
   * con parametri identici. Cosi' il costo del percorso non dipende
   * dall'esistenza dell'account, e la garanzia e' NOSTRA: non eredita il
   * comportamento di better-auth, che potrebbe cambiare in una minor.
   */
  async verify(phc: string, password: string): Promise<boolean> {
    const isOurs = phc.startsWith('$argon2id$') && this.#hasCurrentParams(phc);
    if (!isOurs) {
      await this.verifyDecoy(password);
      return false;
    }

    // SEC-40 — con quale pepper e' stato prodotto questo hash.
    //
    // La colonna `pepper_version` e' un SUGGERIMENTO, non un vincolo, ed e'
    // una distinzione che costa poco e vale molto. Nessuno la scrive quando
    // un hash nasce o cambia: better-auth riscrive `auth.account.password`
    // da se' su cambio password e su reset, e quella colonna resta indietro.
    // Se la trattassimo come verita', dopo una rotazione chiunque cambiasse
    // password — o venisse creato — si troverebbe una riga che dichiara una
    // versione con cui il suo hash non e' stato prodotto, e non entrerebbe
    // piu'. Un blocco totale, silenzioso e senza rimedio, perche' un hash non
    // si ricalcola senza la password in chiaro.
    //
    // Quindi: si prova il suggerimento, e se fallisce e non era gia' il
    // corrente si riprova con il corrente. Il costo aggiuntivo esiste solo
    // durante la finestra di migrazione, per le righe non ancora allineate, e
    // si estingue da solo perche' la verifica riuscita fa scattare il
    // ri-hash. A regime — suggerimento uguale al corrente — l'Argon2 resta
    // uno solo, e la costanza di costo del SEC-30 non e' toccata.
    const subject = currentPepperSubject();
    const hinted = subject?.pepperVersion ?? this.#currentVersion;

    const attempt = async (version: number): Promise<boolean> => {
      const pepper = this.#peppers.get(version);
      if (!pepper) return false;
      return this.#semaphore.run(async () => {
        try {
          return await verify(phc, normalizePassword(password), { secret: pepper });
        } catch {
          // Una PHC string malformata non e' una password valida. Non si
          // distingue da una password sbagliata, nemmeno nel messaggio.
          return false;
        }
      });
    };

    let usedVersion = hinted;
    let ok = await attempt(hinted);
    if (!ok && hinted !== this.#currentVersion) {
      usedVersion = this.#currentVersion;
      ok = await attempt(this.#currentVersion);
    }

    if (ok && subject) {
      if (needsRehash(phc, usedVersion, this.#currentVersion)) {
        // L'hash e' nato con un pepper vecchio: va rifatto.
        await this.#migrate(subject.userId, password);
      } else if (usedVersion !== hinted) {
        // L'hash era gia' quello giusto e a mentire era la colonna — succede
        // quando better-auth riscrive la password da se'. Senza questo, ogni
        // accesso di quella persona pagherebbe due Argon2 per sempre.
        await this.#realign(subject.userId, usedVersion);
      }
    }
    return ok;
  }

  /**
   * Rigenera l'hash con il pepper corrente, dopo una verifica RIUSCITA.
   *
   * E' l'unico momento in cui la password in chiaro esiste ed e' provata
   * giusta: e' li' che una rotazione del pepper puo' avvenire senza chiedere
   * niente a nessuno.
   *
   * Passa dallo stesso semaforo di tutti gli altri hash — quindi non puo'
   * raddoppiare gli Argon2 in volo — e un suo guasto non fa fallire il login:
   * la password era giusta, e al prossimo accesso si riprova.
   */
  async #migrate(userId: string, password: string): Promise<void> {
    const sink = this.#onRehash;
    if (!sink) return;
    try {
      const phc = await this.hash(password);
      await sink({ userId, phc, pepperVersion: this.#currentVersion });
    } catch {
      // Inghiottito di proposito: vedi sopra.
    }
  }

  /** Solo la colonna: nessun Argon2, perche' l'hash e' gia' quello giusto. */
  async #realign(userId: string, pepperVersion: number): Promise<void> {
    const sink = this.#onRehash;
    if (!sink) return;
    try {
      await sink({ userId, pepperVersion });
    } catch {
      // Come sopra: la password era giusta, e questo e' bookkeeping.
    }
  }

  #hasCurrentParams(phc: string): boolean {
    const p = phcParams(phc);
    return p !== undefined && p.m === ARGON2_PARAMS.memoryCost && p.t === ARGON2_PARAMS.timeCost;
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
