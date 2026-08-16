// §9 — middleware di autorizzazione. Algoritmo normativo.
//
// REGOLA ASSOLUTA: `session.user` non viene mai usato per decisioni di
// autorizzazione. E' uno snapshot fatto al login e non riflette ne' ban ne'
// declassamenti. Tutto cio' che decide viene da `authz:{userId}` e dalla
// vista effective_permissions.
//
// Sui round trip a Redis. Il §9 prescrive un solo round trip mettendo nello
// stesso tick la GET della sessione, la GET di authz:{userId} e il consumo
// del rate limit. Il primo e il terzo si possono davvero unire, perche' la
// chiave del rate limit e' l'IP ed e' nota in partenza. Il secondo no: la
// chiave authz contiene lo userId, che si conosce solo DOPO aver letto la
// sessione. Sono quindi due tick — sessione+ratelimit, poi authz+sessrev —
// entrambi fusi da enableAutoPipelining. Su una rete locale sono frazioni di
// millisecondo, e l'alternativa (indicizzare le sessioni per utente in una
// chiave a parte) aggiungerebbe una struttura da mantenere coerente per
// risparmiare un round trip che nessuno misura.

import type { Redis } from 'ioredis';
import type { Auth } from '#src/auth/auth.ts';
import type { AuthzContext, AuthzSnapshot } from '#src/authz/context.ts';
import { type AuthzStore, emptyPermissions, readPermissions } from '#src/authz/store.ts';
import type { Database } from '#src/db/pool.ts';
import { KEYS } from '#src/redis/client.ts';

/**
 * Un solo motivo di rifiuto esposto al client: 401 generico.
 * Il motivo preciso resta nei log e nell'audit. Distinguere "bannato" da
 * "sessione scaduta" nella risposta direbbe a un attaccante con un cookie
 * rubato che l'account esiste ed e' stato chiuso.
 */
export type RejectReason =
  | 'nessun_cookie'
  | 'sessione_assente'
  | 'utente_sconosciuto'
  | 'sessione_precedente_al_logout_globale'
  | 'utente_bannato'
  | 'utente_non_attivo'
  | 'sessione_revocata'
  | 'scadenza_assoluta'
  | 'inattivita'
  | 'secondo_fattore_mancante';

export type AuthzOutcome =
  | { ok: true; context: AuthzContext }
  | { ok: false; reason: RejectReason; userId: string | null; sessionId: string | null };

export type SessionShape = {
  id: string;
  token: string;
  userId: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  absolute_expires_at?: Date | string | null;
  authenticated_at?: Date | string | null;
  aal?: number | null;
  permissions_version?: number | null;
};

export type UserShape = { id: string; email: string; name: string };

export type AuthzMiddlewareDeps = {
  auth: Auth;
  db: Database;
  redis: Redis;
  store: AuthzStore;
  idleSeconds: number;
};

function toDate(value: Date | string | null | undefined): Date | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value : new Date(value);
}

function banActive(snapshot: AuthzSnapshot, now: Date): boolean {
  if (!snapshot.banned) return false;
  // Un ban senza scadenza e' attivo. Un ban con scadenza futura e' attivo.
  // Un ban scaduto non lo e' piu'.
  if (snapshot.banExpires === null) return true;
  return new Date(snapshot.banExpires) > now;
}

export class AuthzMiddleware {
  readonly #deps: AuthzMiddlewareDeps;

  constructor(deps: AuthzMiddlewareDeps) {
    this.#deps = deps;
  }

  /**
   * Risolve la richiesta in un AuthzContext, oppure la rifiuta.
   * `headers` sono quelli della richiesta: da li' better-auth legge il cookie.
   */
  async resolve(headers: Headers, now: Date = new Date()): Promise<AuthzOutcome> {
    const { auth, db, redis, store, idleSeconds } = this.#deps;

    // passo 1-2 — sessione
    const raw = await auth.api.getSession({ headers });
    if (!raw?.session || !raw.user) {
      return { ok: false, reason: 'sessione_assente', userId: null, sessionId: null };
    }
    const session = raw.session as unknown as SessionShape;
    // L'oggetto utente serve SOLO per la denormalizzazione dell'audit
    // (email e nome al momento del fatto). Non entra in nessuna decisione.
    const identity = raw.user as unknown as UserShape;
    const userId = session.userId;
    const sessionId = session.id;

    // passo 2 (secondo tick) — authz + revoca puntuale, fusi da autopipelining
    const [snapshotRaw, revoked] = await Promise.all([
      store.peek(userId),
      redis.exists(KEYS.sessionRevoked(sessionId)),
    ]);

    // passo 3 — se authz manca, si ricostruisce da Postgres
    const snapshot = snapshotRaw ?? (await store.rebuild(userId));
    if (!snapshot) {
      return { ok: false, reason: 'utente_sconosciuto', userId, sessionId };
    }

    // passo 4 — rifiuti
    if (revoked === 1) {
      return { ok: false, reason: 'sessione_revocata', userId, sessionId };
    }
    if (new Date(session.createdAt) < new Date(snapshot.sessionsValidFrom)) {
      return { ok: false, reason: 'sessione_precedente_al_logout_globale', userId, sessionId };
    }
    if (banActive(snapshot, now)) {
      return { ok: false, reason: 'utente_bannato', userId, sessionId };
    }
    if (snapshot.status !== 'active') {
      return { ok: false, reason: 'utente_non_attivo', userId, sessionId };
    }

    // -----------------------------------------------------------------------
    // Colonne di sicurezza della sessione: si leggono da POSTGRES, non dal
    // blob di sessione.
    //
    // Il blob e' scritto alla CREAZIONE della sessione. `aal` pero' cambia
    // dopo: la verifica TOTP alza a 2 una sessione che gia' esiste, e una
    // revoca di step-up la riabbassa. Un blob che dichiara `aal = 2` mentre
    // Postgres dice altro e' lo stesso identico errore di SEC-02, solo su un
    // altro campo — e nella direzione pericolosa, perche' un declassamento non
    // si propagherebbe.
    //
    // Costa una query, ma non una in piu': i permessi effettivi vanno letti da
    // Postgres comunque (non stanno nel blob, di proposito), e questa parte
    // dalla stessa connessione nello stesso momento.
    // -----------------------------------------------------------------------
    const [row, permissions] = await Promise.all([
      db
        .selectFrom('auth.session')
        .select([
          'aal',
          'absolute_expires_at',
          'authenticated_at',
          'permissions_version',
          'createdAt',
          'updatedAt',
          'expiresAt',
        ])
        .where('id', '=', sessionId)
        .executeTakeFirst(),
      // La vista tocca ~160 righe di role_permissions: sta in shared_buffers.
      readPermissions(db, userId),
    ]);

    // SEC-01 — con `storeSessionInDatabase: true` la riga DEVE esserci. Se non
    // c'e', la sessione e' stata cancellata (revoca) e il blob Redis e' solo
    // in ritardo.
    if (!row) {
      return { ok: false, reason: 'sessione_assente', userId, sessionId };
    }

    const absolute = toDate(row.absolute_expires_at);
    // Assente non vuol dire illimitato: senza tetto la sessione non vale.
    if (!absolute || absolute < now) {
      return { ok: false, reason: 'scadenza_assoluta', userId, sessionId };
    }
    if (new Date(row.expiresAt) < now) {
      return { ok: false, reason: 'scadenza_assoluta', userId, sessionId };
    }
    const idleMs = now.getTime() - new Date(row.updatedAt).getTime();
    if (idleMs > idleSeconds * 1000) {
      return { ok: false, reason: 'inattivita', userId, sessionId };
    }
    if (row.aal < 2) {
      return { ok: false, reason: 'secondo_fattore_mancante', userId, sessionId };
    }

    // passo 5 — se la versione differisce, la si riallinea sulla riga di
    // sessione. I permessi sono gia' stati letti: il confronto serve a sapere
    // se la sessione portava un valore vecchio, non a decidere se leggerli.
    if (row.permissions_version !== snapshot.pv) {
      await db
        .updateTable('auth.session')
        .set({ permissions_version: snapshot.pv })
        .where('id', '=', sessionId)
        .execute();
    }

    // passo 6 — AuthzContext
    return {
      ok: true,
      context: {
        userId,
        sessionId,
        permissions,
        permissionsVersion: snapshot.pv,
        aal: row.aal,
        authenticatedAt: toDate(row.authenticated_at) ?? new Date(row.createdAt),
        actorEmail: identity.email,
        actorDisplayName: identity.name,
      },
    };
  }

  /** Revoca puntuale di una sessione: chiave Redis + delete della riga (§8.2). */
  async revokeSession(sessionId: string, expiresAt: Date, now: Date = new Date()): Promise<void> {
    const ttl = Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / 1000));
    await this.#deps.redis.set(KEYS.sessionRevoked(sessionId), '1', 'EX', ttl);
    await this.#deps.db.deleteFrom('auth.session').where('id', '=', sessionId).execute();
  }

  /**
   * Logout globale / ban (§8.2). Il meccanismo e' NOSTRO e non dipende dal
   * ciclo di vita interno di better-auth: il middleware rifiuta ogni sessione
   * con `createdAt < sessions_valid_from`, quindi basta spostare quella data.
   */
  async revokeAllSessions(userId: string, now: Date = new Date()): Promise<number> {
    const { db, store } = this.#deps;
    await db.updateTable('auth.user').set({ sessions_valid_from: now }).where('id', '=', userId).execute();
    const deleted = await db
      .deleteFrom('auth.session')
      .where('userId', '=', userId)
      .returning('id')
      .execute();
    // Dopo il COMMIT: lo snapshot va riallineato, altrimenti il middleware
    // continuerebbe a confrontare contro la vecchia sessions_valid_from.
    await store.invalidate(userId);
    return deleted.length;
  }
}
