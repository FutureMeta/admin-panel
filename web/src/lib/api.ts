// Client HTTP del pannello.
//
// SEC-17 — ogni richiesta che cambia stato rimanda in `X-CSRF-Token` il valore
// del cookie `__Host-metamc_csrf`, che il server ha derivato dall'id di
// sessione. Il cookie e' leggibile da JavaScript apposta: non e' un segreto,
// e' un valore che vale solo per quella sessione.
//
// SEC-20 — nessuna destinazione arriva dal client. Le rotte post-login,
// post-accept e post-reset sono costanti decise dal server.

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code?: string) {
    super(`HTTP ${status}${code ? ` (${code})` : ''}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }

  /** Serve uno step-up: il chiamante apre la challenge TOTP e ritenta. */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
  get isForbidden(): boolean {
    return this.status === 403;
  }
  get isNotFound(): boolean {
    return this.status === 404;
  }
  get isRateLimited(): boolean {
    return this.status === 429;
  }
  get isOverloaded(): boolean {
    return this.status === 503;
  }
}

function readCookie(name: string): string | undefined {
  for (const part of document.cookie.split('; ')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq) === name) return decodeURIComponent(part.slice(eq + 1));
  }
  return undefined;
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
};

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };

  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') {
    const csrf = readCookie('__Host-metamc_csrf');
    if (csrf) headers['x-csrf-token'] = csrf;
  }

  const res = await fetch(path, {
    method,
    headers,
    // Il cookie di sessione e' __Host- e SameSite=Strict: `same-origin` e'
    // l'unica modalita' sensata, e dichiararla evita che una modifica futura
    // la allarghi per sbaglio.
    credentials: 'same-origin',
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (!res.ok) {
    let code: string | undefined;
    try {
      const parsed = (await res.json()) as { code?: string };
      code = parsed.code;
    } catch {
      // Un corpo non JSON su un errore non e' un problema: lo status basta.
    }
    throw new ApiError(res.status, code);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * Come `api`, ma restituisce anche le intestazioni.
 *
 * Serve a una cosa sola: «online adesso» viaggia in `X-Online-Now` e non nel
 * corpo. Dentro un payload costruito ogni pochi minuti quel numero sarebbe
 * vecchio di minuti — ed è proprio il numero che si confronta con quello che
 * si vede sul server. Come intestazione è letto a ogni richiesta e sopravvive
 * anche al 304, che è il caso del polling.
 */
export async function apiWithHeaders<T>(
  path: string,
  options: RequestOptions = {},
): Promise<{ data: T; headers: Headers }> {
  const res = await fetch(path, {
    method: options.method ?? 'GET',
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!res.ok) {
    let code: string | undefined;
    try {
      const parsed = (await res.json()) as { code?: string };
      code = parsed.code;
    } catch {
      // Uno status senza corpo JSON basta a dire cos'e' successo.
    }
    throw new ApiError(res.status, code);
  }
  return { data: (await res.json()) as T, headers: res.headers };
}

// ---------------------------------------------------------------------------
// Tipi di risposta. Scritti a mano come l'interfaccia DB: sono pochi, e una
// divergenza col server diventa un errore di compilazione invece che un campo
// `undefined` a runtime.
// ---------------------------------------------------------------------------

export type ModuleKey =
  | 'utenti'
  | 'ruoli'
  | 'inviti'
  | 'sessioni'
  | 'audit'
  | 'impostazioni'
  | 'statistiche'
  | 'server'
  | 'duels'
  | 'duels_feedback';

export type Me = {
  userId: string;
  email: string;
  name: string;
  permissions: Record<ModuleKey, 0 | 1 | 2 | 3>;
  /** SOLO i moduli a cui l'utente ha accesso. La sidebar non ne conosce altri. */
  modules: ModuleKey[];
  aal: number;
  authenticatedAt: string;
};

export type UserRow = {
  id: string;
  email: string;
  name: string;
  status: 'pending_onboarding' | 'active' | 'disabled';
  banned: boolean;
  banReason: string | null;
  banExpires: string | null;
  createdAt: string;
  roles: Array<{ key: string; name: string; isSystem: boolean }>;
  /** Quanti moduli l'utente vede davvero, override individuali inclusi. */
  modules: number;
  /** Sessione toccata più di recente. `null` se non è mai entrato. */
  lastSeenAt: string | null;
};

export type UserDetail = {
  user: UserRow & { twoFactorEnabled: boolean };
  permissions: Record<string, number>;
  /**
   * L'override INDIVIDUALE per modulo, distinto da `permissions`.
   *
   * `permissions` e' l'effettivo, cioe' GREATEST(ruolo, override): da solo non
   * dice quale dei due lo produce. La schermata che modifica l'override deve
   * poter mostrare quello che modifica.
   */
  overrides: Record<string, number>;
  roles: Array<{ id: number; key: string; name: string; isSystem: boolean; granted_at: string }>;
  sessions: Array<{
    id: string;
    createdAt: string;
    updatedAt: string;
    ipAddress: string | null;
    userAgent: string | null;
    aal: number;
  }>;
  canManage: boolean;
};

export type RolesMatrix = {
  modules: Array<{ id: number; key: ModuleKey; name: string; sort_order: number }>;
  roles: Array<{
    id: number;
    key: string;
    name: string;
    isSystem: boolean;
    members: number;
    editable: boolean;
  }>;
  permissions: Array<{ role_id: number; module_id: number; level: number }>;
};

export type InviteRow = {
  id: string;
  email: string;
  /** Il nome deciso da chi invita: comparirà nel registro accanto alle azioni. */
  name: string;
  createdAt: string;
  expiresAt: string;
  roleName: string;
  invitedByName: string | null;
};

export type AuditEntry = {
  id: string;
  occurredAt: string;
  actor: {
    userId: string | null;
    email: string | null;
    name: string | null;
    ip: string | null;
    socketIp: string | null;
    userAgent: string | null;
  };
  action: string;
  moduleKey: string | null;
  target: { type: string | null; id: string | null; label: string | null };
  outcome: 'success' | 'failure' | 'denied';
  before: unknown;
  after: unknown;
  meta: unknown;
};

export type AuditPage = {
  entries: AuditEntry[];
  nextCursor: { beforeOccurredAt: string; beforeId: string } | null;
};
