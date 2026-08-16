// AuthzContext — l'unica cosa che un handler riceve per decidere.
//
// Non contiene l'oggetto utente di better-auth. Contiene i permessi effettivi
// risolti, e nient'altro che serva a una decisione. E' la struttura che rende
// SEC-02 un fatto strutturale invece che una regola da ricordare: se
// `session.user` non e' raggiungibile da qui, nessuno puo' leggerlo per
// sbaglio.

import type { Level, ModuleKey } from './modules.ts';

/** Snapshot di stato tenuto in `authz:{userId}`, FUORI dal blob di sessione. */
export type AuthzSnapshot = {
  /** permissions_version vista in Postgres. */
  pv: number;
  banned: boolean;
  banExpires: string | null;
  sessionsValidFrom: string;
  status: 'pending_onboarding' | 'active' | 'disabled';
};

export type AuthzContext = {
  userId: string;
  sessionId: string;
  /** Livello effettivo per modulo. I moduli assenti valgono 0. */
  permissions: Readonly<Record<ModuleKey, Level>>;
  permissionsVersion: number;
  /** 1 = solo password, 2 = 2FA completato. Il middleware rifiuta gia' aal < 2. */
  aal: number;
  /** Ultima asserzione forte, per lo step-up (§8.5). */
  authenticatedAt: Date;
  /** Identita' denormalizzata per l'audit: com'era AL MOMENTO DEL FATTO. */
  actorEmail: string;
  actorDisplayName: string;
};

/**
 * Contesto di una sessione di onboarding (aal=0, nessun permesso): esiste per
 * il solo scambio invito -> enrollment, e non e' un AuthzContext perche' non
 * puo' autorizzare nulla.
 */
export type OnboardingContext = {
  kind: 'onboarding';
  userId: string;
  sessionId: string;
  inviteId: string;
};
