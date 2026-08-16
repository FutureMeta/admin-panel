// SEC-13 — recovery code custom. §8.4
//
// Perche' non i backup code del plugin: lo storage `encrypted` e' REVERSIBILE.
// Un dump del database piu' il segreto di cifratura sarebbe il bypass del 2FA
// di tutto lo staff in un colpo. E 10 caratteri stanno sotto i 112 bit di
// NIST §3.1.2.2.
//
// Qui: 16 byte (128 bit) da crypto.randomBytes, Base32 Crockford, SHA-256
// one-way. 128 bit superano la soglia NIST, e questo AUTORIZZA SHA-256 al
// posto di un password hashing scheme — altrimenti ogni tentativo costerebbe
// 10 esecuzioni Argon2id, cioe' un DoS applicativo banale.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Transaction } from 'kysely';
import type { Database } from '#src/db/pool.ts';
import type { DB } from '#src/db/types.ts';

/** Crockford Base32: niente I, L, O, U — le confusioni di lettura piu' comuni. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_BYTES = 16; // 128 bit
/** ceil(128 / 5) = 26 caratteri. */
const RECOVERY_CODE_CHARS = 26;
/** Soglia sotto la quale parte l'email di avviso (§8.4). */
export const RECOVERY_CODES_LOW_THRESHOLD = 3;

function encodeCrockford(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out.slice(0, RECOVERY_CODE_CHARS);
}

/**
 * Normalizzazione prima dell'hash: maiuscolo, via spazi e trattini, e le
 * lettere che Crockford esclude ricondotte alla cifra corrispondente.
 *
 * Serve perche' la gente ritrascrive i codici a mano da un foglio: `O` per
 * `0` e `I` per `1` sono l'errore piu' frequente, e rifiutare un codice
 * corretto trascritto in modo prevedibile manderebbe la persona sul reset
 * assistito a quattro occhi per niente.
 */
export function normalizeRecoveryCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[OQ]/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V');
}

export function hashRecoveryCode(code: string): Buffer {
  return createHash('sha256').update(normalizeRecoveryCode(code), 'utf8').digest();
}

/** Formato di visualizzazione: gruppi di 5, mostrati UNA SOLA VOLTA (§8.1.12). */
export function formatRecoveryCode(code: string): string {
  return (code.match(/.{1,5}/g) ?? [code]).join('-');
}

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => encodeCrockford(randomBytes(RECOVERY_CODE_BYTES)));
}

/**
 * Genera un blocco nuovo e invalida in blocco i precedenti alzando
 * `generation`. Va eseguita nella transazione dell'evento che la richiede
 * (enrollment o rigenerazione), cosi' l'audit resta l'ultima istruzione.
 */
export async function issueRecoveryCodes(
  trx: Transaction<DB>,
  userId: string,
): Promise<{ codes: string[]; generation: number }> {
  const prev = await trx
    .selectFrom('auth.recovery_code')
    .select((eb) => eb.fn.max('generation').as('g'))
    .where('user_id', '=', userId)
    .executeTakeFirst();

  const generation = (prev?.g ?? 0) + 1;
  const codes = generateRecoveryCodes();

  // I codici della generazione precedente non si cancellano: restano come
  // prova che sono esistiti e quando sono stati spesi. Il consumo filtra su
  // `generation`, quindi non sono piu' utilizzabili.
  await trx
    .insertInto('auth.recovery_code')
    .values(codes.map((c) => ({ user_id: userId, code_hash: hashRecoveryCode(c), generation })))
    .execute();

  return { codes, generation };
}

export type ConsumeResult = { ok: true; remaining: number } | { ok: false };

/**
 * Consumo ATOMICO (§8.4): la UPDATE con `used_at IS NULL` nella WHERE e'
 * l'intero meccanismo di mutua esclusione. Zero righe = gia' speso.
 * Due richieste concorrenti con lo stesso codice: una sola vince.
 */
export async function consumeRecoveryCode(
  trx: Transaction<DB>,
  userId: string,
  code: string,
  ip: string | null,
): Promise<ConsumeResult> {
  const generation = await trx
    .selectFrom('auth.recovery_code')
    .select((eb) => eb.fn.max('generation').as('g'))
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!generation?.g) return { ok: false };

  const updated = await trx
    .updateTable('auth.recovery_code')
    .set({ used_at: new Date(), used_ip: ip })
    .where('user_id', '=', userId)
    .where('code_hash', '=', hashRecoveryCode(code))
    .where('generation', '=', generation.g)
    .where('used_at', 'is', null)
    .returning('id')
    .executeTakeFirst();

  if (!updated) return { ok: false };

  const left = await trx
    .selectFrom('auth.recovery_code')
    .select((eb) => eb.fn.countAll().as('n'))
    .where('user_id', '=', userId)
    .where('generation', '=', generation.g)
    .where('used_at', 'is', null)
    .executeTakeFirst();

  return { ok: true, remaining: Number(left?.n ?? 0) };
}

export async function countOpenRecoveryCodes(db: Database, userId: string): Promise<number> {
  const row = await db
    .selectFrom('auth.recovery_code')
    .select((eb) => eb.fn.countAll().as('n'))
    .where('user_id', '=', userId)
    .where('used_at', 'is', null)
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

/**
 * Confronto a tempo costante fra digest. La lunghezza e' fissa a 32 byte per
 * costruzione, quindi `timingSafeEqual` non puo' lanciare.
 *
 * Non e' usato nel percorso di consumo — li' il confronto lo fa l'indice
 * UNIQUE di Postgres, che e' gia' un confronto su un digest e non su un
 * segreto — ma serve dove un confronto avviene in memoria.
 */
export function digestEquals(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
