// Interfaccia DB per Kysely, SCRITTA A MANO (§3.4): niente kysely-codegen.
// 14 tabelle: il costo di mantenerla e' un'ora all'anno, il beneficio e' che
// una colonna che cambia tipo rompe la compilazione invece di rompersi in
// produzione.
//
// Convenzione: le tabelle di better-auth mantengono il naming della libreria
// (camelCase); le nostre usano snake_case.

import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/** Colonna con DEFAULT che non si scrive mai: si legge e basta. */
type Auto<T> = ColumnType<T, never, never>;
/** Colonna con DEFAULT: opzionale in INSERT, aggiornabile. */
type WithDefault<T> = ColumnType<T, T | undefined, T>;

export type UserStatus = 'pending_onboarding' | 'active' | 'disabled';
export type AuditOutcome = 'success' | 'failure' | 'denied';
export type PermissionLevel = 0 | 1 | 2 | 3;

// ---------------------------------------------------------------------------
// better-auth
// ---------------------------------------------------------------------------

export type UserTable = {
  id: string;
  name: string;
  email: string;
  emailVerified: WithDefault<boolean>;
  image: string | null;
  createdAt: WithDefault<Date>;
  updatedAt: WithDefault<Date>;
  twoFactorEnabled: WithDefault<boolean>;

  status: WithDefault<UserStatus>;
  permissions_version: WithDefault<number>;
  sessions_valid_from: WithDefault<Date>;
  banned: WithDefault<boolean>;
  ban_reason: string | null;
  ban_expires: Date | null;
  pepper_version: WithDefault<number>;
  password_updated_at: Date | null;
  /** bigint: node-postgres lo restituisce come stringa. */
  last_totp_step: WithDefault<string>;
  invited_by: string | null;
  invite_id: string | null;
};

export type SessionTable = {
  id: string;
  expiresAt: Date;
  token: string;
  createdAt: WithDefault<Date>;
  updatedAt: WithDefault<Date>;
  ipAddress: string | null;
  userAgent: string | null;
  userId: string;

  absolute_expires_at: WithDefault<Date>;
  authenticated_at: WithDefault<Date>;
  aal: WithDefault<number>;
  amr: WithDefault<string[]>;
  permissions_version: WithDefault<number>;
};

export type AccountTable = {
  id: string;
  accountId: string;
  providerId: string;
  userId: string;
  accessToken: string | null;
  refreshToken: string | null;
  idToken: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  scope: string | null;
  /** PHC string di Argon2id. Mai loggata, mai restituita da un endpoint. */
  password: string | null;
  createdAt: WithDefault<Date>;
  updatedAt: WithDefault<Date>;
};

export type VerificationTable = {
  id: string;
  identifier: string;
  value: string;
  expiresAt: Date;
  createdAt: WithDefault<Date>;
  updatedAt: WithDefault<Date>;
};

export type TwoFactorTable = {
  id: string;
  /** metamc_app NON ha UPDATE su questa colonna (SEC-42). */
  secret: string;
  backupCodes: string;
  /** metamc_app NON ha UPDATE su questa colonna (SEC-42). */
  userId: string;
  verified: WithDefault<boolean>;
  failedVerificationCount: WithDefault<number>;
  lockedUntil: Date | null;
};

// ---------------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------------

export type ModulesTable = {
  id: Auto<number>;
  key: string;
  name: string;
  sort_order: WithDefault<number>;
};

export type RolesTable = {
  id: Auto<number>;
  key: string;
  name: string;
  is_system: WithDefault<boolean>;
  sort_order: WithDefault<number>;
};

export type RolePermissionsTable = {
  role_id: number;
  module_id: number;
  level: number;
};

export type UserRolesTable = {
  user_id: string;
  role_id: number;
  granted_by: string | null;
  granted_at: WithDefault<Date>;
};

export type UserPermissionsTable = {
  user_id: string;
  module_id: number;
  level: number;
  granted_by: string | null;
  granted_at: WithDefault<Date>;
};

/** Vista: sola lettura. */
export type EffectivePermissionsView = {
  user_id: Auto<string>;
  module_id: Auto<number>;
  module_key: Auto<string>;
  level: Auto<number>;
};

// ---------------------------------------------------------------------------
// Inviti, recovery, 2FA reset, webauthn
// ---------------------------------------------------------------------------

export type InvitationTable = {
  id: Generated<string>;
  email_lower: string;
  /**
   * Il nome con cui la persona comparira' nel registro. Lo decide chi invita:
   * al momento dell'accettazione si legge da qui, mai dal corpo della
   * richiesta — la stessa regola dell'email (§8.1.9).
   */
  display_name: string;
  /** sha256(token). Il token in chiaro non esiste da nessuna parte lato server. */
  token_hash: Buffer;
  role_id: number;
  invited_by: string;
  created_at: WithDefault<Date>;
  expires_at: Date;
  consumed_at: Date | null;
  consumed_user_id: string | null;
  revoked_at: Date | null;
  revoked_by: string | null;
  resend_message_id: string | null;
};

export type RecoveryCodeTable = {
  id: Auto<string>;
  user_id: string;
  code_hash: Buffer;
  generation: number;
  created_at: WithDefault<Date>;
  used_at: Date | null;
  used_ip: string | null;
};

export type TwoFactorResetTable = {
  id: Generated<string>;
  target_user_id: string;
  requested_by: string;
  requested_at: WithDefault<Date>;
  reason: string;
  verification_channel: string | null;
  approved_by_1: string | null;
  approved_at_1: Date | null;
  approved_by_2: string | null;
  approved_at_2: Date | null;
  effective_at: Date | null;
  executed_at: Date | null;
  cancelled_at: Date | null;
  cancelled_by: string | null;
};

/** Creata vuota, fase 1.5 (§16.8). Nessun codice di fase 1 la tocca. */
export type WebauthnCredentialTable = {
  id: Auto<string>;
  user_id: string;
  credential_id: Buffer;
  public_key: Buffer;
  sign_count: WithDefault<string>;
  transports: string[] | null;
  aaguid: string | null;
  label: string | null;
  created_at: WithDefault<Date>;
  last_used_at: Date | null;
};

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export type AuditLogTable = {
  id: Auto<string>;
  occurred_at: WithDefault<Date>;
  request_id: string | null;
  actor_user_id: string | null;
  actor_email: string | null;
  actor_display_name: string | null;
  actor_ip: string | null;
  actor_socket_ip: string | null;
  actor_user_agent: string | null;
  session_id: string | null;
  action: string;
  module_key: string | null;
  target_type: string | null;
  target_id: string | null;
  target_label: string | null;
  outcome: AuditOutcome;
  before: unknown | null;
  after: unknown | null;
  meta: unknown | null;
  /** Calcolati dal trigger: mai scritti dall'applicazione. */
  prev_hash: Auto<Buffer>;
  hash: Auto<Buffer>;
};

export type ChainHeadTable = {
  partition_key: string;
  head_hash: Buffer;
  row_count: WithDefault<string>;
  anchored_at: Date | null;
  updated_at: WithDefault<Date>;
};

// ---------------------------------------------------------------------------

export type DB = {
  'auth.user': UserTable;
  'auth.session': SessionTable;
  'auth.account': AccountTable;
  'auth.verification': VerificationTable;
  'auth.twoFactor': TwoFactorTable;
  'auth.modules': ModulesTable;
  'auth.roles': RolesTable;
  'auth.role_permissions': RolePermissionsTable;
  'auth.user_roles': UserRolesTable;
  'auth.user_permissions': UserPermissionsTable;
  'auth.effective_permissions': EffectivePermissionsView;
  'auth.invitation': InvitationTable;
  'auth.recovery_code': RecoveryCodeTable;
  'auth.two_factor_reset': TwoFactorResetTable;
  'auth.webauthn_credential': WebauthnCredentialTable;
  'audit.audit_log': AuditLogTable;
  'audit.chain_head': ChainHeadTable;
};

export type User = Selectable<UserTable>;
export type NewUser = Insertable<UserTable>;
export type UserUpdate = Updateable<UserTable>;
export type Session = Selectable<SessionTable>;
export type Invitation = Selectable<InvitationTable>;
export type AuditLogRow = Selectable<AuditLogTable>;
