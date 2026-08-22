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
 *
 * `secure: true` sempre: il prefisso `__Host-` lo RICHIEDE, e senza il browser
 * scarta il cookie in silenzio.
 */
export const CSRF_COOKIE_OPTIONS = {
  path: '/',
  secure: true,
  httpOnly: false,
  sameSite: 'strict',
} as const;

/** Ha `setCookie`: e' cio' che serve, e non lega questo modulo a Fastify. */
type CookieSetter = {
  setCookie: (name: string, value: string, options: Record<string, unknown>) => unknown;
};

/**
 * SEC-17 — emette il cookie CSRF per una sessione.
 *
 * UN SOLO punto, chiamato ovunque nasca o cambi una sessione: il ponte
 * better-auth, `requireAuth`, `/api/me`, l'accettazione dell'invito.
 *
 * Il motivo per cui e' una funzione e non quattro righe ripetute: il token e'
 * derivato dall'id di sessione, quindi ogni rotazione lo invalida. Dimenticare
 * di riemetterlo dopo una rotazione non produce un errore visibile — produce
 * un 403 sulla richiesta successiva, in un punto lontano da dove sta la causa.
 * E' gia' successo tre volte durante questa implementazione: dopo il login,
 * dopo la verifica TOTP, e dopo l'accettazione dell'invito.
 *
 * LA DURATA E' OBBLIGATORIA, e deve essere quella della sessione. Senza
 * `maxAge` il browser tratta il cookie come cookie di sessione SUA e lo butta
 * alla chiusura, mentre la sessione vera dura giorni (D-11): si resta con
 * meta' della coppia. In quello stato SEC-17 si attiva — la sessione c'e' ed
 * e' valida — e non trova il token, quindi rifiuta OGNI richiesta che cambia
 * stato, compreso il login stesso. E il login e' l'unica cosa che quella
 * persona puo' provare a fare, per cui non ne esce: le sue credenziali sono
 * giuste, la sua origine e' giusta, e il pannello risponde 403 finche' non
 * cancella i cookie a mano. E' successo in produzione.
 *
 * Obbligatoria e non con un default, perche' il valore giusto lo conosce solo
 * il chiamante e perche' un default sbagliato qui non fa rumore: rifa'
 * esattamente il difetto, e lo rifa' in silenzio.
 */
export function issueCsrfCookie(
  reply: CookieSetter,
  key: Buffer,
  sessionId: string,
  maxAgeSeconds: number,
): void {
  reply.setCookie(CSRF_COOKIE, csrfToken(key, sessionId), {
    ...CSRF_COOKIE_OPTIONS,
    maxAge: maxAgeSeconds,
  });
}
