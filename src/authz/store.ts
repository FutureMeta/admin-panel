// SEC-02 — lo snapshot di autorizzazione vive in `authz:{userId}`, FUORI dal
// blob di sessione.
//
// Il perche' e' il verdetto 2 del §0: con secondaryStorage il blob di sessione
// contiene una copia dell'utente fatta al login. Ban e declassamento non si
// propagano a una sessione gia' aperta, e l'utente bannato continua a lavorare
// finche' il cookie non scade. La chiave separata e' letta a OGNI richiesta,
// nello stesso tick della sessione (un solo round trip con autopipelining).
//
// La chiave non ha TTL: su miss si ricostruisce da Postgres. Un miss costa una
// query da poche righe; un TTL costerebbe una finestra in cui un ban non e'
// ancora visibile.

import type { Redis } from 'ioredis';
import type { Database } from '#src/db/pool.ts';
import { KEYS } from '#src/redis/client.ts';
import type { AuthzSnapshot } from './context.ts';
import { MODULES, type Level, type ModuleKey } from './modules.ts';

export type PermissionMap = Record<ModuleKey, Level>;

export function emptyPermissions(): PermissionMap {
  const out = {} as PermissionMap;
  for (const m of MODULES) out[m] = 0;
  return out;
}

/** Legge i permessi effettivi da Postgres. ~160 righe in role_permissions: sta in shared_buffers. */
export async function readPermissions(db: Database, userId: string): Promise<PermissionMap> {
  const rows = await db
    .selectFrom('auth.effective_permissions')
    .select(['module_key', 'level'])
    .where('user_id', '=', userId)
    .execute();

  const perms = emptyPermissions();
  for (const r of rows) {
    const key = r.module_key as ModuleKey;
    if (key in perms) perms[key] = r.level as Level;
  }
  return perms;
}

export type UserStateRow = {
  permissions_version: number;
  banned: boolean;
  ban_expires: Date | null;
  sessions_valid_from: Date;
  status: 'pending_onboarding' | 'active' | 'disabled';
};

export async function readUserState(db: Database, userId: string): Promise<UserStateRow | undefined> {
  const row = await db
    .selectFrom('auth.user')
    .select(['permissions_version', 'banned', 'ban_expires', 'sessions_valid_from', 'status'])
    .where('id', '=', userId)
    .executeTakeFirst();
  return row as UserStateRow | undefined;
}

function toSnapshot(row: UserStateRow): AuthzSnapshot {
  return {
    pv: row.permissions_version,
    banned: row.banned,
    banExpires: row.ban_expires ? row.ban_expires.toISOString() : null,
    sessionsValidFrom: row.sessions_valid_from.toISOString(),
    status: row.status,
  };
}

export class AuthzStore {
  readonly #redis: Redis;
  readonly #db: Database;

  constructor(redis: Redis, db: Database) {
    this.#redis = redis;
    this.#db = db;
  }

  /** Lettura calda: una GET. `undefined` se la chiave non c'e'. */
  async peek(userId: string): Promise<AuthzSnapshot | undefined> {
    const raw = await this.#redis.get(KEYS.authz(userId));
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as AuthzSnapshot;
    } catch {
      // Chiave corrotta: si comporta come un miss, non come un errore. La
      // ricostruzione da Postgres e' sempre autorevole.
      return undefined;
    }
  }

  /** Ricostruisce da Postgres e riscrive. `undefined` se l'utente non esiste. */
  async rebuild(userId: string): Promise<AuthzSnapshot | undefined> {
    const row = await readUserState(this.#db, userId);
    if (!row) {
      await this.#redis.del(KEYS.authz(userId));
      return undefined;
    }
    const snap = toSnapshot(row);
    await this.#redis.set(KEYS.authz(userId), JSON.stringify(snap));
    return snap;
  }

  /** §9 passo 3: se manca, si ricostruisce. */
  async get(userId: string): Promise<AuthzSnapshot | undefined> {
    return (await this.peek(userId)) ?? (await this.rebuild(userId));
  }

  /**
   * Da chiamare DOPO il COMMIT di ogni modifica che tocca ban, status,
   * sessions_valid_from o i permessi. Prima del commit sarebbe una bugia se la
   * transazione poi fallisse.
   */
  async invalidate(userId: string): Promise<void> {
    await this.rebuild(userId);
  }

  async invalidateMany(userIds: readonly string[]): Promise<void> {
    await Promise.all(userIds.map((id) => this.rebuild(id)));
  }
}
