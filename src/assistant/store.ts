// Dove vive una conversazione, e quanto puo' costare un mese.
//
// LA CRONOLOGIA STA SUL SERVER. Il client manda il proprio testo e un
// identificativo di conversazione, niente altro: i turni precedenti — compresi
// quelli dell'assistente — non passano mai dal browser.
//
// Non e' una comodita', e' la meta' che rende vera la regola sulle istruzioni.
// Se la cronologia arrivasse dal client, chiunque controlli quella pagina
// potrebbe fabbricare cose che Svetlana «ha detto» nei turni precedenti e
// usarle come contesto per il turno dopo. Cosi' invece il client puo' scrivere
// una cosa sola — il proprio turno `user` — e le istruzioni operative viaggiano
// solo come messaggi `system`, che non ha modo di produrre.
//
// STA SUL REDIS PRINCIPALE, non su quello dei payload. Quello e' `allkeys-lru`
// e senza persistenza: una conversazione sfrattata a meta' e' una chat che
// perde la memoria senza dirlo, e un contatore di spesa sfrattato e' un tetto
// che si azzera da solo.

import type { Anthropic } from '@anthropic-ai/sdk';
import type { Redis } from 'ioredis';
import { CONVERSATION_TTL_SECONDS, MAX_STORED_TURNS } from './config.ts';

export type Turn = Anthropic.Beta.Messages.BetaMessageParam;

/**
 * La chiave comprende l'ID UTENTE, e non e' ridondanza.
 *
 * Un identificativo di conversazione indovinato da un'altra persona costruisce
 * una chiave diversa, quindi non trova niente. Senza l'utente nella chiave
 * sarebbe un identificativo segreto a proteggere la conversazione di qualcun
 * altro, che e' una difesa sola e per giunta indovinabile.
 */
function key(userId: string, conversationId: string): string {
  return `svetlana:conv:${userId}:${conversationId}`;
}

export class ConversationStore {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  async read(userId: string, conversationId: string): Promise<Turn[]> {
    const raw = await this.#redis.get(key(userId, conversationId));
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as Turn[]) : [];
    } catch {
      // Una conversazione illeggibile ricomincia da capo. Fallire qui
      // significherebbe che una chat resta rotta finche' non scade il TTL, e
      // per l'utente sarebbe un pannello guasto senza motivo visibile.
      return [];
    }
  }

  async write(userId: string, conversationId: string, turns: readonly Turn[]): Promise<void> {
    // Il taglio e' un tetto di MEMORIA, non la gestione del contesto: quella
    // la fa la compattazione lato server, che riassume invece di tagliare.
    const kept = turns.slice(-MAX_STORED_TURNS);
    await this.#redis.set(key(userId, conversationId), JSON.stringify(kept), 'EX', CONVERSATION_TTL_SECONDS);
  }

  async forget(userId: string, conversationId: string): Promise<void> {
    await this.#redis.del(key(userId, conversationId));
  }
}

// ---------------------------------------------------------------------------
// Il tetto di spesa
// ---------------------------------------------------------------------------

/**
 * Il mese civile in fuso locale del network.
 *
 * In UTC il primo del mese cambierebbe alle 2 del mattino ora italiana, e per
 * due ore la spesa finirebbe nel secchio del mese dopo: nessuno se ne
 * accorgerebbe mai, ed e' esattamente per questo che vale la pena farlo bene.
 */
export function monthKey(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const year = parts.find((p) => p.type === 'year')?.value ?? '0000';
  const month = parts.find((p) => p.type === 'month')?.value ?? '00';
  return `${year}-${month}`;
}

/**
 * Quanto si e' speso questo mese, e se si puo' spendere ancora.
 *
 * IL COMPORTAMENTO AL SUPERAMENTO E' DEFINITO: Svetlana si spegne con un
 * messaggio chiaro. Non risponde male, non risponde a meta', non fallisce in
 * silenzio — le tre cose che un tetto scritto in fretta produce.
 *
 * Il conto e' una STIMA fatta con i prezzi di listino di `config.ts`: la
 * fattura la fa il fornitore. Serve a fermarsi prima di una sorpresa, non a
 * essere esatta al centesimo.
 */
export class SpendLedger {
  readonly #redis: Redis;
  readonly #capUsd: number;
  /** L'ultimo valore letto, per /internal/metrics: la lettura e' asincrona, la metrica no. */
  #lastSeen = 0;

  constructor(redis: Redis, capUsd: number) {
    this.#redis = redis;
    this.#capUsd = capUsd;
  }

  get capUsd(): number {
    return this.#capUsd;
  }

  get lastSeenUsd(): number {
    return this.#lastSeen;
  }

  async spentThisMonth(now: Date): Promise<number> {
    const raw = await this.#redis.get(`svetlana:spend:${monthKey(now)}`);
    const value = raw === null ? 0 : Number.parseFloat(raw);
    this.#lastSeen = Number.isFinite(value) ? value : 0;
    return this.#lastSeen;
  }

  async exhausted(now: Date): Promise<boolean> {
    if (this.#capUsd <= 0) return false;
    return (await this.spentThisMonth(now)) >= this.#capUsd;
  }

  /**
   * Somma quanto e' costato un messaggio.
   *
   * La chiave scade dopo poco piu' di due mesi: il tetto guarda il mese
   * corrente, e tenere per sempre il conto di ogni mese passato vorrebbe dire
   * scrivere uno storico in un posto che non e' fatto per conservarlo. Chi
   * vuole lo storico lo prende dalle metriche.
   */
  async add(now: Date, usd: number): Promise<void> {
    if (usd <= 0) return;
    const k = `svetlana:spend:${monthKey(now)}`;
    const total = await this.#redis.incrbyfloat(k, usd);
    await this.#redis.expire(k, 70 * 24 * 60 * 60);
    const value = Number.parseFloat(String(total));
    if (Number.isFinite(value)) this.#lastSeen = value;
  }
}
