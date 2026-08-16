// Controllo HIBP con k-anonymity. §8.6
//
// Perche' non il plugin `better-auth/plugins/haveibeenpwned` (SPIKE-3):
//
//  1. Il plugin chiama `betterFetch` SENZA `timeout` ne' `signal`, e non
//     espone un'opzione per impostarli. Il timeout di 2 s richiesto dal §8.6
//     non e' configurabile. E' l'unico requisito dello spike che ha fallito.
//  2. Il §8.6 chiede una VOCE NELL'AUDIT LOG quando il controllo fallisce in
//     chiuso. Il plugin lancia un APIError e non ha accesso al nostro
//     contesto di audit: quella voce non potrebbe scriverla.
//  3. Il plugin si aggancia avvolgendo `ctx.password.hash`, cioe' esegue una
//     chiamata di rete DENTRO il percorso di hashing. Se quel percorso
//     finisse dentro una transazione che scrive audit, violerebbe la regola
//     non negoziabile del §10. Con un client nostro il controllo resta dove
//     deve stare: prima di aprire la transazione.

import { createHash } from 'node:crypto';
import { Agent } from 'node:https';

const ENDPOINT = 'https://api.pwnedpasswords.com/range/';
const TIMEOUT_MS = 2_000;

/**
 * Keep-alive: senza, ogni controllo pagherebbe una `dns.lookup`, che gira sul
 * threadpool libuv — lo stesso che serve Argon2 (§8.6).
 */
const agent = new Agent({ keepAlive: true, maxSockets: 4, keepAliveMsecs: 30_000 });

export type HibpVerdict =
  | { status: 'clean' }
  | { status: 'compromised'; occurrences: number }
  | { status: 'unavailable'; reason: string };

export type HibpOptions = {
  timeoutMs?: number;
  /** Iniettabile nei test: nessuna chiamata reale esce durante la suite. */
  fetchImpl?: typeof fetch;
};

export class HibpClient {
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(opts: HibpOptions = {}) {
    this.#timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  /**
   * Restituisce l'esito. NON lancia: la politica fail-closed la applica il
   * chiamante, che e' l'unico a sapere se deve anche scrivere audit.
   */
  async check(password: string): Promise<HibpVerdict> {
    const sha1 = createHash('sha1').update(password.normalize('NFKC')).digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const res = await this.#fetch(`${ENDPOINT}${prefix}`, {
        method: 'GET',
        headers: {
          // Risposta di lunghezza costante: senza padding, la dimensione del
          // corpo restringe l'insieme dei prefissi possibili.
          'Add-Padding': 'true',
          // Senza User-Agent l'API risponde 403 (§17.5, errore 1010).
          'User-Agent': 'MetaMC-Admin/1.0',
          Accept: 'text/plain',
        },
        signal: controller.signal,
        // @ts-expect-error `dispatcher`/`agent` non e' nei tipi di fetch ma
        // undici lo accetta; il keep-alive e' il punto di questa chiamata.
        agent,
      });

      if (!res.ok) return { status: 'unavailable', reason: `http ${res.status}` };

      const body = await res.text();
      for (const line of body.split('\n')) {
        const sep = line.indexOf(':');
        if (sep === -1) continue;
        if (line.slice(0, sep).trim().toUpperCase() === suffix) {
          const n = Number.parseInt(line.slice(sep + 1).trim(), 10);
          // Il padding introduce righe con conteggio 0: non sono occorrenze reali.
          if (Number.isFinite(n) && n > 0) return { status: 'compromised', occurrences: n };
          return { status: 'clean' };
        }
      }
      return { status: 'clean' };
    } catch (err) {
      const reason =
        err instanceof Error && err.name === 'AbortError'
          ? `timeout ${this.#timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : 'errore sconosciuto';
      return { status: 'unavailable', reason };
    } finally {
      clearTimeout(timer);
    }
  }
}

export class PasswordCompromised extends Error {
  readonly occurrences: number;
  constructor(occurrences: number) {
    super('password compromessa');
    this.name = 'PasswordCompromised';
    this.occurrences = occurrences;
  }
}

export class HibpUnavailable extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super('controllo password non disponibile');
    this.name = 'HibpUnavailable';
    this.reason = reason;
  }
}
