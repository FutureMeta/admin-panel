// SEC-17 — signed double-submit fatto in casa.
//
// Perche' non @fastify/csrf-protection: senza `@fastify/session` (che non
// usiamo, perche' le sessioni sono di better-auth) il plugin degrada al
// double-submit NAIVE, che OWASP sconsiglia esplicitamente. Il naive confronta
// un cookie con un header senza legarli a nulla: chiunque possa SCRIVERE un
// cookie sul dominio — cioe' un sottodominio compromesso — puo' scegliere
// entrambi i valori e passare il controllo.
//
// Qui il cookie contiene HMAC(k_csrf, session.id). Un sottodominio puo'
// sovrascrivere il cookie, ma non puo' produrre un HMAC valido per l'id di
// sessione della vittima, che non conosce e che non e' nel cookie.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const CSRF_COOKIE = '__Host-metamc_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export function csrfToken(key: Buffer, sessionId: string): string {
  return createHmac('sha256', key).update(sessionId, 'utf8').digest('base64url');
}

export function csrfValid(key: Buffer, sessionId: string, presented: string | undefined): boolean {
  if (!presented) return false;
  const expected = Buffer.from(csrfToken(key, sessionId), 'utf8');
  const given = Buffer.from(presented, 'utf8');
  // Le lunghezze sono uguali per costruzione quando il token e' ben formato;
  // quando non lo e', il confronto di lunghezza e' gia' la risposta e non
  // rivela nulla di piu' di quanto riveli il fallimento stesso.
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

/**
 * Il cookie CSRF e' LEGGIBILE da JavaScript (niente HttpOnly): deve esserlo,
 * perche' il client lo rilegge per rimandarlo nell'header. Non e' un segreto
 * di sessione — e' un valore derivato che vale solo per quella sessione, e da
 * solo non autentica nulla.
 */
export const CSRF_COOKIE_OPTIONS = {
  path: '/',
  secure: true,
  httpOnly: false,
  sameSite: 'strict',
} as const;
