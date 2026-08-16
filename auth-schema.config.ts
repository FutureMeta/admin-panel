// Configurazione usata SOLO da `pnpm dlx auth@1.6.29 generate` per emettere il
// DDL delle tabelle better-auth. Non e' l'istanza applicativa: contiene
// esclusivamente cio' che influenza lo schema (dialetto, additionalFields,
// plugin registrati). L'istanza vera e' in src/auth/auth.ts.
//
// Versione ESPLICITA nella CLI, mai `auth@latest`: `@better-auth/cli` e'
// bloccato alla 1.4.21 e pinna internamente better-auth 1.4.21 (§3.4).

import { betterAuth } from 'better-auth';
import { twoFactor } from 'better-auth/plugins/two-factor';
import pg from 'pg';

export const auth = betterAuth({
  baseURL: 'https://admin.metamc.it',
  secret: 'solo-per-la-generazione-dello-schema-non-e-un-segreto',
  database: new pg.Pool({ connectionString: process.env.DATABASE_MIGRATE_URL ?? '' }),

  emailAndPassword: { enabled: true },

  // SPIKE-1 superato: il plugin twoFactor resta. haveibeenpwned NON e'
  // registrato (SPIKE-3: timeout non configurabile) e comunque non aggiunge
  // tabelle. Il plugin `admin` non e' registrato per decisione (§0.3, SEC-10).
  plugins: [twoFactor()],

  user: {
    additionalFields: {
      status: { type: 'string', required: true, defaultValue: 'pending_onboarding', input: false },
      permissions_version: { type: 'number', required: true, defaultValue: 1, input: false },
      sessions_valid_from: { type: 'date', required: true, input: false },
      banned: { type: 'boolean', required: true, defaultValue: false, input: false },
      ban_reason: { type: 'string', required: false, input: false },
      ban_expires: { type: 'date', required: false, input: false },
      pepper_version: { type: 'number', required: true, defaultValue: 1, input: false },
      password_updated_at: { type: 'date', required: false, input: false },
      last_totp_step: { type: 'number', required: true, defaultValue: 0, input: false },
      invited_by: { type: 'string', required: false, input: false },
      invite_id: { type: 'string', required: false, input: false },
    },
  },

  session: {
    additionalFields: {
      absolute_expires_at: { type: 'date', required: true, input: false },
      authenticated_at: { type: 'date', required: true, input: false },
      aal: { type: 'number', required: true, defaultValue: 1, input: false },
      amr: { type: 'string[]', required: true, input: false },
      permissions_version: { type: 'number', required: true, input: false },
    },
  },
});
