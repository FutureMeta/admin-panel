// Istanza better-auth. §3.3, §8.2, §8.3
//
// Plugin registrati: SOLO `two-factor`.
//   - `admin` NON registrato (§0.3, SEC-10): elimina in un colpo
//     l'impersonation, la doppia fonte di verita' sui permessi, il ruolo
//     `admin` con controllo totale di default e la classe GHSA-2vg6.
//   - `haveibeenpwned` NON registrato (SPIKE-3): il timeout non e'
//     configurabile e il plugin non puo' scrivere la voce di audit che il
//     §8.6 richiede. Il controllo lo fa src/auth/hibp.ts, fuori transazione.

import { redisStorage } from '@better-auth/redis-storage';
import { betterAuth } from 'better-auth';
import { twoFactor } from 'better-auth/plugins/two-factor';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import type { PasswordService } from './password.ts';

export type AuthDeps = {
  pool: pg.Pool;
  redis: Redis;
  passwords: PasswordService;
  secret: string;
  baseURL: string;
  sessionAbsoluteSeconds: number;
};

export type Auth = ReturnType<typeof createAuth>;

export function createAuth(deps: AuthDeps) {
  return betterAuth({
    baseURL: deps.baseURL,
    secret: deps.secret,
    database: deps.pool,

    // SEC-01 — con secondaryStorage il default di storeSessionInDatabase e'
    // FALSE, cioe' le sessioni esisterebbero solo su Redis. Serve `true`:
    // altrimenti la revoca per-utente non ha una tabella su cui agire, e un
    // FLUSHALL disconnetterebbe tutti senza lasciare traccia di chi era
    // collegato.
    secondaryStorage: redisStorage({ client: deps.redis }),

    session: {
      expiresIn: deps.sessionAbsoluteSeconds,
      // Il rinnovo scorrevole di better-auth NON e' il nostro modello: il
      // tetto vero e' `absolute_expires_at`, che il middleware controlla e che
      // nessuno proroga (SEC-05).
      updateAge: 60,
      storeSessionInDatabase: true,
      // SEC-03 — cookieCache disattivo. Con la cache, il cookie stesso
      // diventa una copia della sessione e la revoca smette di funzionare
      // per la durata della cache.
      cookieCache: { enabled: false },
      additionalFields: {
        // Le quattro colonne che il middleware del §9 legge a ogni richiesta.
        // Stanno qui, e non altrove, perche' devono viaggiare nel blob di
        // sessione: leggerle da Postgres a ogni richiesta annullerebbe il
        // senso del secondary storage. `amr` non c'e': serve solo allo
        // step-up, che e' raro, e resta text[] su Postgres.
        absolute_expires_at: { type: 'date', required: false, input: false },
        authenticated_at: { type: 'date', required: false, input: false },
        aal: { type: 'number', required: false, input: false },
        permissions_version: { type: 'number', required: false, input: false },
      },
    },

    emailAndPassword: {
      enabled: true,
      // Nessuna registrazione pubblica: l'unica via di ingresso e' l'invito.
      disableSignUp: true,
      requireEmailVerification: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      password: {
        // Argon2id con pepper e semaforo. Override di entrambi: il default di
        // better-auth e' scrypt, che non espone un pepper.
        hash: (password) => deps.passwords.hash(password),
        verify: ({ hash, password }) => deps.passwords.verify(hash, password),
      },
    },

    // SEC-24 — il rate limiting interno e' DISATTIVO: ce n'e' uno solo, ed e'
    // rate-limiter-flexible. Tre punti di fail-open indipendenti davanti ad
    // Argon2 sono tre occasioni di sbagliarne uno.
    rateLimit: { enabled: false },

    advanced: {
      // SPIKE-2: `useSecureCookies: true` antepone `__Secure-` al nome GIA'
      // prefissato e produce `__Secure-__Host-metamc_session`, un doppio
      // prefisso invalido che annulla la semantica di __Host- in silenzio.
      // `Secure` lo mettiamo negli attributi, dove non collide.
      useSecureCookies: false,
      cookies: {
        session_token: {
          name: '__Host-metamc_session',
          attributes: {
            path: '/',
            secure: true,
            httpOnly: true,
            sameSite: 'strict',
            // Nessun `domain`: __Host- lo vieta, ed e' il punto.
            // Nessun `partitioned`: il pannello non e' mai in un iframe
            // (frame-ancestors 'none').
          },
        },
      },
      // SEC-22 — UN SOLO header, quello che nginx sovrascrive. Con piu'
      // header better-auth prenderebbe il primo che trova, e un attaccante
      // sceglierebbe quale far trovare.
      ipAddress: {
        ipAddressHeaders: ['x-forwarded-for'],
        disableIpTracking: false,
      },
      // Nessun redirect preso dal client in tutta la fase 1 (SEC-20).
      disableCSRFCheck: false,
    },

    plugins: [
      twoFactor({
        issuer: 'MetaMC Admin',
        // `twoFactorEnabled` resta false finche' non arriva un codice valido:
        // quel flag e' il gate hard di accesso al pannello, e attivarlo prima
        // della verifica significherebbe fidarsi di un enrollment mai provato.
        skipVerificationOnEnable: false,
        totpOptions: {
          digits: 6,
          period: 30,
        },
      }),
    ],

    // `trustDevice` non e' fra le opzioni passate di proposito (§8.3):
    // ricordare il dispositivo 30 giorni rinnovando la finestra a ogni login
    // fa sparire il secondo fattore per chi lo usa tutti i giorni, cioe'
    // esattamente per lo staff.

    // OTP via email non abilitato: il plugin email-otp non e' registrato.

    telemetry: { enabled: false },
  });
}
