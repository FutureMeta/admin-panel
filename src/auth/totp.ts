// SEC-11 / SEC-12 — anti-replay TOTP.
//
// NIST SP 800-63B §3.1.4.2 e' uno SHALL: un OTP non deve essere accettato due
// volte. Con window=1 la finestra vale 90 secondi, cioe' un codice
// intercettato resta spendibile per un minuto e mezzo se nessuno lo marca.
//
// Due guardie, non una:
//   - Redis `totp:used:{userId}:{step}` — veloce, TTL 120 s, copre i tre step
//     della finestra. E' quella che risponde nel percorso caldo.
//   - `auth."user".last_totp_step` in Postgres — monotona, durevole. E' quella
//     che sopravvive a un riavvio di Redis, a un FLUSHALL e a un failover.
//
// Con la sola Redis, svuotare la cache riaprirebbe tutti i codici della
// finestra. Con la sola Postgres, ogni verifica costerebbe una scrittura sul
// percorso di login.
//
// SEC-12 — window = 1, mai 2. Window 2 sono 150 secondi, sopra il limite di
// due minuti di NIST §3.1.4.1.

import type { Redis } from 'ioredis';
import type { Database } from '#src/db/pool.ts';
import { KEYS } from '#src/redis/client.ts';

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_WINDOW = 1;
/** Un po' piu' della finestra (3 step = 90 s), per coprire lo skew ammesso. */
const USED_TTL_SECONDS = 120;

export function currentStep(now: number = Date.now()): number {
  return Math.floor(now / 1000 / TOTP_PERIOD_SECONDS);
}

/** I tre step accettabili con window=1: precedente, corrente, successivo. */
export function windowSteps(step: number): number[] {
  const out: number[] = [];
  for (let d = -TOTP_WINDOW; d <= TOTP_WINDOW; d += 1) out.push(step + d);
  return out;
}

export type ReplayVerdict =
  | { allowed: true }
  | { allowed: false; reason: 'step_already_used' | 'step_not_monotonic' };

export class TotpReplayGuard {
  readonly #redis: Redis;
  readonly #db: Database;

  constructor(redis: Redis, db: Database) {
    this.#redis = redis;
    this.#db = db;
  }

  /**
   * Da chiamare nel `hooks.before` di /two-factor/verify-totp, PRIMA che
   * l'handler valuti il codice (SPIKE-1 ha verificato che il before hook vede
   * il body e puo' rifiutare).
   *
   * Si controllano tutti e tre gli step della finestra, non solo quello
   * corrente: il codice presentato potrebbe essere valido per uno step
   * adiacente, e marcare solo lo step corrente lascerebbe due buchi.
   */
  async check(userId: string, now: number = Date.now()): Promise<ReplayVerdict> {
    const step = currentStep(now);

    const marks = await this.#redis.mget(...windowSteps(step).map((s) => KEYS.totpUsed(userId, s)));
    if (marks.some((m) => m !== null)) return { allowed: false, reason: 'step_already_used' };

    const row = await this.#db
      .selectFrom('auth.user')
      .select('last_totp_step')
      .where('id', '=', userId)
      .executeTakeFirst();

    // bigint: node-postgres lo restituisce come stringa.
    const last = row ? Number(row.last_totp_step) : 0;

    // `last >= step`, non `last > step`.
    //
    // `last_totp_step` registra lo step piu' alto gia' consumato. Se e' uguale
    // a quello corrente, una verifica in questa finestra e' gia' avvenuta, e
    // qualunque codice presentabile adesso e' o quello gia' speso o uno dei
    // due adiacenti — che con window=1 sono accettati dal verificatore e sono
    // quindi altrettanto riusabili.
    //
    // La regola e' piu' stretta del minimo necessario: blocca anche un secondo
    // accesso LEGITTIMO nella stessa finestra da 30 secondi. E' il prezzo
    // giusto: per farlo l'utente dovrebbe ridigitare lo stesso codice, che e'
    // esattamente il replay, e l'attesa massima e' mezzo minuto.
    if (last >= step) return { allowed: false, reason: 'step_not_monotonic' };

    return { allowed: true };
  }

  /**
   * Da chiamare nel `hooks.after`, SOLO su esito positivo.
   *
   * Marca i tre step della finestra con SET NX EX e alza `last_totp_step` in
   * modo monotono. La UPDATE ha `AND last_totp_step < $step`: due verifiche
   * concorrenti non possono farlo tornare indietro.
   */
  async markUsed(userId: string, now: number = Date.now()): Promise<void> {
    const step = currentStep(now);

    const pipeline = this.#redis.pipeline();
    for (const s of windowSteps(step)) {
      pipeline.set(KEYS.totpUsed(userId, s), '1', 'EX', USED_TTL_SECONDS, 'NX');
    }
    await pipeline.exec();

    await this.#db
      .updateTable('auth.user')
      .set({ last_totp_step: String(step) })
      .where('id', '=', userId)
      .where('last_totp_step', '<', String(step))
      .execute();
  }
}
