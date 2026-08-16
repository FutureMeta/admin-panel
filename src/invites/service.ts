// Ciclo di vita dell'invito. §8.1
//
// Il token e' 256 bit da crypto.randomBytes; in tabella va SOLO sha256(token).
// Il token in chiaro non esiste da nessuna parte lato server: nemmeno un dump
// del database permette di accettare un invito altrui.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Transaction } from 'kysely';
import type { Database } from '#src/db/pool.ts';
import type { DB } from '#src/db/types.ts';

export const INVITE_TTL_HOURS = 72;
/** La sessione di onboarding vive 15 minuti: e' il tempo di scegliere una password e inquadrare un QR. */
export const ONBOARDING_TTL_SECONDS = 900;

export function newInviteToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashInviteToken(token) };
}

export function hashInviteToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export type CreateInviteInput = {
  emailLower: string;
  roleId: number;
  invitedBy: string;
  now?: Date;
};

export type CreatedInvite = { id: string; token: string; expiresAt: Date };

export class InviteConflict extends Error {
  readonly code: 'utente_esistente' | 'invito_pendente' | 'email_propria';
  constructor(code: 'utente_esistente' | 'invito_pendente' | 'email_propria') {
    super(code);
    this.name = 'InviteConflict';
    this.code = code;
  }
}

/**
 * §8.1.2 — i tre rifiuti, verificati dentro la transazione.
 *
 * Il vincolo `invitation_one_pending_per_email` copre comunque il secondo
 * caso a livello di database: questo controllo serve a dare un errore
 * comprensibile, non a garantire l'invariante. L'invariante e' l'indice.
 */
export async function assertInvitable(
  trx: Transaction<DB>,
  emailLower: string,
  actorId: string,
): Promise<void> {
  const existing = await trx
    .selectFrom('auth.user')
    .select('id')
    .where((eb) => eb.fn('lower', ['email']), '=', emailLower)
    .executeTakeFirst();
  if (existing) {
    if (existing.id === actorId) throw new InviteConflict('email_propria');
    throw new InviteConflict('utente_esistente');
  }

  const pending = await trx
    .selectFrom('auth.invitation')
    .select('id')
    .where('email_lower', '=', emailLower)
    .where('consumed_at', 'is', null)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  if (pending) throw new InviteConflict('invito_pendente');
}

export async function insertInvite(
  trx: Transaction<DB>,
  input: CreateInviteInput,
): Promise<CreatedInvite & { hash: Buffer }> {
  const { token, hash } = newInviteToken();
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_HOURS * 3600_000);

  const row = await trx
    .insertInto('auth.invitation')
    .values({
      email_lower: input.emailLower,
      token_hash: hash,
      role_id: input.roleId,
      invited_by: input.invitedBy,
      expires_at: expiresAt,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();

  return { id: row.id, token, expiresAt, hash };
}

export type PendingInvite = {
  id: string;
  email_lower: string;
  role_id: number;
  invited_by: string;
  expires_at: Date;
};

/**
 * Legge un invito ancora spendibile a partire dal token.
 * `undefined` per token inesistente, scaduto, consumato o revocato: il
 * chiamante non ha modo di distinguere i quattro casi, ed e' il punto
 * (SEC-32).
 */
export async function findSpendableInvite(
  db: Database,
  token: string,
  now = new Date(),
): Promise<PendingInvite | undefined> {
  const row = await db
    .selectFrom('auth.invitation')
    .select(['id', 'email_lower', 'role_id', 'invited_by', 'expires_at'])
    .where('token_hash', '=', hashInviteToken(token))
    .where('consumed_at', 'is', null)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', now)
    .executeTakeFirst();
  return row as PendingInvite | undefined;
}

/**
 * §8.1.8, passo 1 di 2 — RIVENDICAZIONE atomica.
 *
 * `FOR UPDATE` e' l'intero meccanismo di mutua esclusione. Due accettazioni
 * concorrenti colpiscono la stessa riga: la seconda si mette in attesa del
 * lock, e quando la prima committa Postgres rivaluta la WHERE sulla riga
 * aggiornata. `consumed_at` ora e' valorizzato, la riga non corrisponde piu',
 * e la seconda ottiene zero righe.
 *
 * Non si consuma subito perche' `consumed_user_id` ha una FK verso
 * auth."user" e l'utente non esiste ancora: prima si blocca la riga, poi si
 * crea l'utente, poi si consuma. Se qualcosa fallisce in mezzo, il ROLLBACK
 * riporta indietro tutto — utente compreso.
 */
export async function claimInvite(
  trx: Transaction<DB>,
  tokenHash: Buffer,
  now = new Date(),
): Promise<PendingInvite | undefined> {
  const row = await trx
    .selectFrom('auth.invitation')
    .select(['id', 'email_lower', 'role_id', 'invited_by', 'expires_at'])
    .where('token_hash', '=', tokenHash)
    .where('consumed_at', 'is', null)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', now)
    .forUpdate()
    .executeTakeFirst();
  return row as PendingInvite | undefined;
}

/** §8.1.8, passo 2 di 2 — consumo, con l'utente ormai esistente. */
export async function consumeInvite(
  trx: Transaction<DB>,
  inviteId: string,
  userId: string,
  now = new Date(),
): Promise<boolean> {
  const row = await trx
    .updateTable('auth.invitation')
    .set({ consumed_at: now, consumed_user_id: userId })
    .where('id', '=', inviteId)
    .where('consumed_at', 'is', null)
    .where('revoked_at', 'is', null)
    .returning('id')
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * §8.1.9 — creazione dell'utente.
 *
 * L'email viene presa ESCLUSIVAMENTE dalla riga invito, mai dal body: se
 * arrivasse dal client, chiunque avesse un invito valido per un indirizzo
 * potrebbe registrarsi con un altro.
 *
 * `emailVerified = true` perche' aver aperto il link dalla casella E' la
 * prova di controllo di quell'indirizzo. `status = pending_onboarding`:
 * diventa `active` solo a enrollment TOTP completato.
 */
export async function createUserFromInvite(
  trx: Transaction<DB>,
  invite: PendingInvite,
  passwordHash: string,
  displayName: string,
): Promise<string> {
  const userId = randomUUID().replace(/-/g, '');

  await trx
    .insertInto('auth.user')
    .values({
      id: userId,
      name: displayName,
      email: invite.email_lower,
      emailVerified: true,
      status: 'pending_onboarding',
      twoFactorEnabled: false,
      invited_by: invite.invited_by,
      invite_id: invite.id,
      password_updated_at: new Date(),
    })
    .execute();

  await trx
    .insertInto('auth.account')
    .values({
      id: randomUUID().replace(/-/g, ''),
      accountId: userId,
      providerId: 'credential',
      userId,
      password: passwordHash,
    })
    .execute();

  await trx
    .insertInto('auth.user_roles')
    .values({ user_id: userId, role_id: invite.role_id, granted_by: invite.invited_by })
    .execute();

  return userId;
}

/** §8.10.3 — revoca in blocco degli inviti pendenti emessi da una persona. */
export async function revokeInvitesBy(
  trx: Transaction<DB>,
  invitedBy: string,
  revokedBy: string,
  now = new Date(),
): Promise<number> {
  const rows = await trx
    .updateTable('auth.invitation')
    .set({ revoked_at: now, revoked_by: revokedBy })
    .where('invited_by', '=', invitedBy)
    .where('consumed_at', 'is', null)
    .where('revoked_at', 'is', null)
    .returning('id')
    .execute();
  return rows.length;
}

/**
 * Il ruolo concede livello 3 su almeno un modulo? Determina se l'emissione
 * dell'invito richiede step-up (§8.1.1).
 */
export async function roleGrantsManage(db: Database, roleId: number): Promise<boolean> {
  const row = await db
    .selectFrom('auth.role_permissions')
    .select('level')
    .where('role_id', '=', roleId)
    .where('level', '=', 3)
    .executeTakeFirst();
  return row !== undefined;
}
