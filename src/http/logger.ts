// SEC-43 — logging. §13
//
// `redact` va configurato PRIMA della prima riga di log: una redaction
// aggiunta dopo non ripulisce cio' che e' gia' finito su disco, e la prima
// riga che pino scrive e' quella di avvio, che in molte configurazioni
// contiene gia' la stringa di connessione.
//
// Mai loggare: codici OTP, segreti TOTP, recovery code, token di invito.
// Nemmeno in debug, nemmeno in sviluppo — perche' la configurazione di
// sviluppo e' quella che poi viene copiata in produzione.

import { type Logger, type LoggerOptions, pino, stdSerializers } from 'pino';

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  'token',
  '*.token',
  'otp',
  '*.otp',
  'code',
  '*.code',
  'secret',
  '*.secret',
  'apiKey',
  '*.apiKey',
  'backupCodes',
  '*.backupCodes',
  'recoveryCode',
  '*.recoveryCode',
  'MASTER_KEY',
  'DATABASE_URL',
  'REDIS_URL',
  'RESEND_API_KEY',

  // §8.7 — l'IP dei giocatori non deve poter uscire dalla porta di servizio.
  //
  // IL RISCHIO NON E' IL `logger.info` CHE SI CONTROLLA. E' l'oggetto errore:
  // un throw dentro il ciclo di campionamento con l'hash Redis nel contesto
  // serializza `address` e `ip` dentro lo stack, e finiscono su disco senza
  // che nessuno abbia scritto una riga di log con dentro un indirizzo.
  //
  // L'IP vive nello scope di una funzione del ciclo e ne esce come due
  // lettere. Queste righe sono la rete sotto, non la regola.
  'ip',
  '*.ip',
  '*.*.ip',
  'err.*.ip',
  'address',
  '*.address',
  '*.*.address',
  'err.*.address',
  'req.headers["x-forwarded-for"]',
  'req.headers["x-real-ip"]',
];

export function createLogger(level: string, pretty = false): Logger {
  const options: LoggerOptions = {
    level,
    redact: { paths: REDACT_PATHS, censor: '[redatto]' },
    // Il serializer di default di pino-http logga l'INTERO oggetto request:
    // header, cookie compresi. Questo tiene solo cio' che serve a ritrovare
    // una richiesta.
    serializers: {
      req(request: { id?: string; method?: string; url?: string; headers?: Record<string, unknown> }) {
        return {
          id: request.id,
          method: request.method,
          // La query string puo' contenere un token (link di invito): si
          // registra solo il path.
          url: typeof request.url === 'string' ? request.url.split('?')[0] : undefined,
          userAgent: request.headers?.['user-agent'],
        };
      },
      res(reply: { statusCode?: number }) {
        return { statusCode: reply.statusCode };
      },
      err: stdSerializers.err,
    },
    base: { service: 'metamc-admin' },
  };

  if (pretty) {
    return pino({ ...options, transport: { target: 'pino/file', options: { destination: 1 } } });
  }
  return pino(options);
}
