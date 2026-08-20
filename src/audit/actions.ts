// Catalogo chiuso delle azioni registrate. §8.1, §10
//
// Enumerarle serve a due cose concrete: la UI del registro puo' offrire un
// filtro senza fare un DISTINCT sulla tabella piu' grande del sistema, e una
// action scritta male diventa un errore di compilazione invece di una riga
// che nessuno ritrovera' piu'.
//
// La colonna resta `text`: una FK verso una tabella di azioni renderebbe
// l'audit dipendente da un'altra tabella, e una riga di audit non deve poter
// fallire perche' manca un lookup.

export const AUDIT_ACTIONS = {
  // --- inviti (§8.1) --------------------------------------------------------
  inviteCreate: 'invite.create',
  inviteEmailSent: 'invite.email_sent',
  inviteEmailFailed: 'invite.email_failed',
  inviteOpened: 'invite.opened',
  inviteAccepted: 'invite.accepted',
  inviteRevoked: 'invite.revoked',
  inviteRejected: 'invite.rejected',

  // --- utenti ---------------------------------------------------------------
  userPasswordSet: 'user.password_set',
  userPasswordChanged: 'user.password_changed',
  userPasswordResetRequested: 'user.password_reset_requested',
  userPasswordResetCompleted: 'user.password_reset_completed',
  userTwoFactorEnabled: 'user.2fa_enabled',
  userTwoFactorDisabled: 'user.2fa_disabled',
  userRecoveryCodesGenerated: 'user.recovery_codes_generated',
  userRecoveryCodeUsed: 'user.recovery_code_used',
  userRecoveryCodesLow: 'user.recovery_codes_low',
  userEmailChangeRequested: 'user.email_change_requested',
  userEmailChanged: 'user.email_changed',
  userEmailChangeCancelled: 'user.email_change_cancelled',
  userBanned: 'user.banned',
  userUnbanned: 'user.unbanned',
  userOffboarded: 'user.offboarded',
  userDeleted: 'user.deleted',

  // --- ruoli e permessi -----------------------------------------------------
  roleGranted: 'user.role.grant',
  roleRevoked: 'user.role.revoke',
  permissionGranted: 'user.permission.grant',
  permissionRevoked: 'user.permission.revoke',
  rolePermissionsChanged: 'role.permissions.change',
  roleCreated: 'role.create',
  roleDeleted: 'role.delete',

  // --- statistiche: dizionario delle modalita' (fase 2) ---------------------
  // Il dizionario decide come si raggruppano i server nei grafici. Una
  // riclassificazione cambia ogni numero per modalita' a partire dal giro di
  // warm successivo, quindi va registrata con il prima e il dopo: senza,
  // nessuno puo' spiegare perche' un grafico e' cambiato.
  statsModeCreated: 'stats.mode.create',
  statsModeUpdated: 'stats.mode.update',
  statsModeDeleted: 'stats.mode.delete',
  statsModeAliasesChanged: 'stats.mode.aliases.change',

  // --- sessioni -------------------------------------------------------------
  loginSucceeded: 'auth.login.success',
  loginFailed: 'auth.login.failure',
  /** Challenge 2FA superata al login. La coppia di `twoFactorChallengeFailed`. */
  twoFactorChallengeSucceeded: 'auth.2fa.success',
  twoFactorChallengeFailed: 'auth.2fa.failure',
  twoFactorReplayBlocked: 'auth.2fa.replay_blocked',
  lockout: 'auth.lockout',
  logout: 'auth.logout',
  sessionRevoked: 'session.revoke',
  sessionsRevokedAll: 'session.revoke_all',
  /**
   * STORICHE. Lo step-up e' stato rimosso (deviazione D-09) e nessuna riga
   * nuova nasce con questi valori.
   *
   * Restano nel catalogo per una ragione sola: il registro e' append-only e a
   * catena hash, quindi le righe gia' scritte non si riscrivono — e fra
   * queste ci sono tutti i login con 2FA fino a oggi, registrati per errore
   * come `auth.step_up.success` invece che come una challenge superata.
   * Toglierle dal catalogo renderebbe quelle righe non filtrabili dal
   * pannello: la storia resterebbe, e sparirebbe il modo di leggerla.
   */
  stepUpSucceeded: 'auth.step_up.success',
  stepUpFailed: 'auth.step_up.failure',

  // --- reset 2FA assistito (§8.8) -------------------------------------------
  twoFactorResetRequested: 'twofactor_reset.requested',
  twoFactorResetApproved: 'twofactor_reset.approved',
  twoFactorResetExecuted: 'twofactor_reset.executed',
  twoFactorResetCancelled: 'twofactor_reset.cancelled',

  // --- sistema --------------------------------------------------------------
  hibpUnavailable: 'system.hibp_unavailable',
  auditIntegrityFailed: 'system.audit_integrity_failed',
  auditAnchored: 'system.audit_anchored',
  bootstrapOwner: 'system.bootstrap_owner',
  /** Invito owner emesso dalla riga di comando, fuori dal pannello (runbook §9). */
  breakGlassOwnerInvite: 'system.break_glass_owner_invite',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/**
 * Eventi di SICUREZZA: l'INSERT dovrebbe stare nella STESSA transazione della
 * modifica di stato (SEC-48). Mai `hooks.after`, mai `runInBackground`.
 *
 * Gli altri sono osservativi (login riuscito, login fallito, challenge 2FA
 * fallita, lockout) e possono passare da un hook dopo la risposta.
 *
 * ATTENZIONE A COSA QUESTO ELENCO E' E A COSA NON E'. E' una CHECKLIST, non un
 * controllo: nessun codice lo legge. La garanzia vera la da'
 * `securityTransaction()` in `src/audit/log.ts`, che apre la transazione,
 * esegue il lavoro e scrive l'audit prima del COMMIT — chi passa di li' non
 * puo' sbagliare l'ordine. Chi chiama `writeAudit()` a mano, invece, non ha
 * niente che lo fermi.
 *
 * E oggi due percorsi lo fanno: `sessionsRevokedAll` viene scritto con
 * `writeAudit(ctx.db, ...)` — quindi fuori transazione — in
 * `src/http/routes/auth.ts` e in `src/http/routes/users.ts`. Se la revoca
 * riesce e l'INSERT no, le sessioni cadono senza che ne resti traccia.
 *
 * Renderlo un controllo e' possibile: `writeAudit` conosce l'esecutore e puo'
 * vedere se e' una transazione. Ma prima va deciso l'elenco, perche' la stessa
 * azione compare anche con `outcome: 'denied'` — un rifiuto non cambia stato e
 * fuori transazione ci sta benissimo — e perche' i due percorsi qui sopra
 * vanno corretti o esentati di proposito. Non e' una riga: e' una decisione.
 */
export const SECURITY_ACTIONS: ReadonlySet<AuditAction> = new Set<AuditAction>([
  AUDIT_ACTIONS.inviteCreate,
  AUDIT_ACTIONS.inviteAccepted,
  AUDIT_ACTIONS.inviteRevoked,
  AUDIT_ACTIONS.userPasswordSet,
  AUDIT_ACTIONS.userPasswordChanged,
  AUDIT_ACTIONS.userPasswordResetCompleted,
  AUDIT_ACTIONS.userTwoFactorEnabled,
  AUDIT_ACTIONS.userTwoFactorDisabled,
  AUDIT_ACTIONS.userRecoveryCodesGenerated,
  AUDIT_ACTIONS.userRecoveryCodeUsed,
  AUDIT_ACTIONS.userEmailChanged,
  AUDIT_ACTIONS.userBanned,
  AUDIT_ACTIONS.userUnbanned,
  AUDIT_ACTIONS.userOffboarded,
  AUDIT_ACTIONS.userDeleted,
  AUDIT_ACTIONS.roleGranted,
  AUDIT_ACTIONS.roleRevoked,
  AUDIT_ACTIONS.permissionGranted,
  AUDIT_ACTIONS.permissionRevoked,
  AUDIT_ACTIONS.rolePermissionsChanged,
  AUDIT_ACTIONS.roleCreated,
  AUDIT_ACTIONS.roleDeleted,
  AUDIT_ACTIONS.sessionRevoked,
  AUDIT_ACTIONS.sessionsRevokedAll,
  AUDIT_ACTIONS.twoFactorResetRequested,
  AUDIT_ACTIONS.twoFactorResetApproved,
  AUDIT_ACTIONS.twoFactorResetExecuted,
  AUDIT_ACTIONS.twoFactorResetCancelled,
]);
