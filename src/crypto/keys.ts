// SEC-39 — derivazione delle chiavi.
//
// Un solo MASTER_KEY di 32 byte. Tutte le chiavi di scopo sono derivate con
// HKDF e un `info` distinto. Mai una chiave sola per tutto: se il pepper di
// Argon2 e la chiave CSRF fossero lo stesso byte, la compromissione di una
// sarebbe la compromissione dell'altra, e la rotazione dell'una imporrebbe
// la rotazione dell'altra.
//
// SEC-41 — nessun valore derivato viene mai loggato, ne' finisce in un
// messaggio d'errore.

import { hkdfSync } from 'node:crypto';

/** `info` HKDF. Cambiarne uno cambia la chiave: sono di fatto versionati nel nome. */
export const KEY_INFO = {
  betterAuthSecret: 'better-auth-secret',
  argon2Pepper: 'argon2-pepper-v1',
  csrf: 'csrf-v1',
  auditAnchor: 'audit-anchor-v1',
  inviteToken: 'invite-token-v1',
} as const;

export type KeyPurpose = keyof typeof KEY_INFO;

export type DerivedKeys = {
  /** Segreto passato a better-auth. */
  betterAuthSecret: string;
  /** Pepper di Argon2id: 32 byte, passato come `secret`. */
  argon2Pepper: Buffer;
  /** Chiave HMAC del double-submit firmato (SEC-17). */
  csrf: Buffer;
  /** Chiave di firma dell'ancoraggio esterno dell'audit (§10). */
  auditAnchor: Buffer;
  /** Chiave HMAC usata per indicizzare i token di invito senza esporli. */
  inviteToken: Buffer;
};

function derive(master: Buffer, info: string, length = 32): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      master,
      // Nessun salt: il master e' gia' 32 byte di entropia piena da un secret
      // manager, e un salt costante non aggiungerebbe nulla. La separazione
      // di dominio la fa `info`, che e' il suo scopo.
      Buffer.alloc(0),
      Buffer.from(info, 'utf8'),
      length,
    ),
  );
}

export function deriveKeys(masterKey: Buffer): DerivedKeys {
  if (masterKey.length !== 32) {
    throw new Error(`MASTER_KEY deve essere di 32 byte, ricevuti ${masterKey.length}`);
  }
  return {
    betterAuthSecret: derive(masterKey, KEY_INFO.betterAuthSecret).toString('base64url'),
    argon2Pepper: derive(masterKey, KEY_INFO.argon2Pepper),
    csrf: derive(masterKey, KEY_INFO.csrf),
    auditAnchor: derive(masterKey, KEY_INFO.auditAnchor),
    inviteToken: derive(masterKey, KEY_INFO.inviteToken),
  };
}
