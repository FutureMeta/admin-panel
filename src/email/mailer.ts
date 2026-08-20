// Invio email. §8.1, §17.5, SEC-44, SEC-45, SEC-46
//
// L'invio avviene SEMPRE fuori dalla transazione che ha scritto l'audit
// (§10): se il lock della catena si serializzasse sulla latenza di Resend,
// ogni azione di ogni admin si accoderebbe dietro un'email.
//
// Una coda a concorrenza limitata sta davanti all'SDK: il rate limit di
// Resend e' di 10 req/s PER TEAM, su tutte le API key insieme, quindi creare
// piu' chiavi non lo aggira.

import type { Logger } from 'pino';
import { Resend } from 'resend';

export type SendResult =
  | { ok: true; messageId: string | null }
  | { ok: false; retryable: boolean; reason: string };

export type SendRequest = {
  to: string;
  subject: string;
  html: string;
  text: string;
  /**
   * SEC-46 — chiave DETERMINISTICA derivata dall'evento di dominio
   * (`invite:{inviteId}:{tokenVersion}`), mai un UUID casuale: un UUID nuovo
   * a ogni tentativo rende l'idempotenza inutile proprio nel caso in cui
   * serve, cioe' il retry.
   */
  idempotencyKey: string;
};

export type Mailer = {
  send: (request: SendRequest) => Promise<SendResult>;
};

/**
 * Coda con concorrenza 1 e spaziatura minima fra invii.
 * 10 req/s per team: si sta larghi, perche' un pannello da 10-50 persone non
 * manda mai raffiche e il costo di andare piano e' nullo.
 */
class SendQueue {
  #chain: Promise<unknown> = Promise.resolve();
  readonly #minIntervalMs: number;
  #lastAt = 0;

  constructor(minIntervalMs = 150) {
    this.#minIntervalMs = minIntervalMs;
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(async () => {
      const wait = this.#lastAt + this.#minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.#lastAt = Date.now();
      return fn();
    });
    // La catena non deve rompersi su un errore, altrimenti il primo invio
    // fallito bloccherebbe tutti quelli dopo.
    this.#chain = next.catch(() => undefined);
    return next;
  }
}

export type ResendMailerOptions = {
  apiKey: string;
  from: string;
  logger: Logger;
};

export class ResendMailer implements Mailer {
  readonly #client: Resend;
  readonly #from: string;
  readonly #logger: Logger;
  readonly #queue = new SendQueue();

  constructor(opts: ResendMailerOptions) {
    this.#client = new Resend(opts.apiKey);
    this.#from = opts.from;
    this.#logger = opts.logger;
  }

  async send(request: SendRequest): Promise<SendResult> {
    return this.#queue.run(async () => {
      try {
        const res = await this.#client.emails.send(
          {
            from: this.#from,
            to: request.to,
            subject: request.subject,
            html: request.html,
            text: request.text,
            // SEC-45 — il click tracking deve restare SPENTO: con il
            // tracking attivo Resend riscrive gli URL, e il token di invito o
            // di reset passerebbe per un redirector di terze parti.
            //
            // Non si disattiva da qui. I `tags` di Resend sono metadata e non
            // cambiano il comportamento: la riga che stava qui — un tag
            // `click_tracking: disabled` — non spegneva niente e faceva
            // credere il contrario a chi la leggeva. L'impostazione vera e' di
            // DOMINIO, nel pannello Resend, ed e' gia' spenta di default.
          },
          { idempotencyKey: request.idempotencyKey },
        );

        if (res.error) {
          return { ok: false, retryable: isRetryable(res.error.name), reason: res.error.name };
        }
        return { ok: true, messageId: res.data?.id ?? null };
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'errore sconosciuto';
        this.#logger.error({ reason }, 'invio email fallito');
        return { ok: false, retryable: true, reason };
      }
    });
  }
}

/**
 * §17.5 — `rate_limit_exceeded` si risolve aspettando; le quote giornaliera e
 * mensile restituiscono anch'esse 429 ma NON si risolvono aspettando.
 * Ritentare quelle e' solo rumore.
 */
function isRetryable(name: string): boolean {
  if (name === 'daily_quota_exceeded' || name === 'monthly_quota_exceeded') return false;
  return name === 'rate_limit_exceeded' || name === 'internal_server_error' || name === 'application_error';
}

/** Mailer per i test e per lo sviluppo: raccoglie invece di spedire. */
export class InMemoryMailer implements Mailer {
  readonly sent: Array<SendRequest & { messageId: string }> = [];
  #n = 0;
  /** Impostabile dai test per verificare il percorso di fallimento. */
  failNext: { retryable: boolean; reason: string } | undefined;

  async send(request: SendRequest): Promise<SendResult> {
    if (this.failNext) {
      const f = this.failNext;
      this.failNext = undefined;
      return { ok: false, ...f };
    }
    this.#n += 1;
    const messageId = `mem_${this.#n}`;
    this.sent.push({ ...request, messageId });
    return { ok: true, messageId };
  }

  lastTo(email: string): (SendRequest & { messageId: string }) | undefined {
    return [...this.sent].reverse().find((s) => s.to.toLowerCase() === email.toLowerCase());
  }

  clear(): void {
    this.sent.length = 0;
  }
}
