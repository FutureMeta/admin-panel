// §5.1, §2, SEC-33 — `index.html` servito da Node con il nonce CSP.
//
// Il file e' tenuto in memoria come COPPIA DI STRINGHE PRE-SPLITTATE caricate
// all'avvio, mai riletto da disco per richiesta: `fs` gira sul threadpool
// libuv, lo stesso che serve Argon2, e una lettura di file per ogni caricamento
// della pagina competerebbe con i login.
//
// Gli asset con hash nel nome li serve nginx. @fastify/static NON e'
// installato: tre advisory del 2026 su quel pacchetto sono bypass di guardie
// via path non canonici (CVE-2026-15074, CVE-2026-6414, GHSA-8pvw-jcv7-9cmj —
// quest'ultimo aliassa CVE-2026-7120, non CVE-2026-6414: sono tre problemi
// distinti, non uno).

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Segnaposto che il build del frontend lascia nell'HTML. */
const NONCE_PLACEHOLDER = '__CSP_NONCE__';

export type IndexHtml = {
  render: (nonce: string) => string;
  /** Numero di punti di sostituzione trovati: se e' 0, il build e' sbagliato. */
  slots: number;
};

/**
 * Pre-splitta l'HTML sui segnaposto. Il render diventa una `join`, cioe' una
 * concatenazione di stringhe gia' in memoria: nessun regex, nessuna
 * allocazione oltre il risultato.
 */
export function prepareIndexHtml(html: string): IndexHtml {
  const parts = html.split(NONCE_PLACEHOLDER);
  const slots = parts.length - 1;
  if (slots === 0) {
    throw new Error(
      `index.html non contiene ${NONCE_PLACEHOLDER}: senza segnaposto la CSP con nonce non ha effetto ` +
        'e la pagina resterebbe bianca. Controllare il build del frontend.',
    );
  }
  return {
    slots,
    render: (nonce) => parts.join(nonce),
  };
}

export function loadIndexHtml(path: string): IndexHtml {
  return prepareIndexHtml(readFileSync(path, 'utf8'));
}

/** 128 bit in base64: sufficienti e imprevedibili, come richiede la CSP. */
export function newNonce(): string {
  return randomBytes(16).toString('base64');
}

/**
 * SEC-33 / SEC-34 — la CSP.
 *
 * `script-src 'nonce-...' 'strict-dynamic'`: strict-dynamic fa si' che gli
 * script caricati da uno script fidato ereditino la fiducia, il che permette
 * al bundle di Vite di importare i propri chunk senza elencarli.
 *
 * `style-src 'self' 'unsafe-inline'` e' il compromesso ACCETTATO e
 * documentato: React e le primitive Radix iniettano stile inline, e l'XSS via
 * CSS e' molto piu' debole di quello via script. Sta in
 * docs/security/deviations.md.
 */
export function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "manifest-src 'self'",
    'upgrade-insecure-requests',
  ].join('; ');
}
