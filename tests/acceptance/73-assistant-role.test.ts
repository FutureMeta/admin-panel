// I privilegi del ruolo da cui legge Svetlana, provati sul database vero.
//
// PERCHE' QUESTO TEST ESISTE E NON BASTA LEGGERE LA MIGRATION. «In v1 nessun
// tool scrive» e «i tool non vedono i segreti» sono due frasi che, scritte
// solo nel codice, valgono finche' nessuno aggiunge una query. Qui diventano
// due proprieta' del RUOLO: se un giorno qualcuno concede un GRANT di troppo o
// toglie `default_transaction_read_only`, questo file si accende — non la
// revisione di una pull request.
//
// I TRE ELENCHI HANNO PESI DIVERSI. Quello di cio' che si legge protegge dalle
// regressioni: senza quei GRANT i tool rispondono «permission denied» e la
// chat sembra rotta. Quello di cio' che NON si legge protegge dalle fughe: e'
// l'unico che, sbagliato, manda segreti a un fornitore esterno. Quello sulle
// scritture e' la regola della versione 1, tutta intera.

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, createTestDatabase, type TestDatabase } from '#tests/support/postgres.ts';

let db: TestDatabase;
let sql: pg.Client;

beforeAll(async () => {
  db = await createTestDatabase('assistant-role');
  sql = await connect(db.assistantUrl, 'metamc-test-assistant');
}, 120_000);

afterAll(async () => {
  await sql?.end().catch(() => undefined);
  await db?.drop();
});

/** Cio' che i cinque tool devono poter leggere per rispondere. */
const LEGGIBILI = [
  'auth."user"',
  'auth."session"',
  'auth.user_roles',
  'auth.roles',
  'auth.modules',
  'auth.effective_permissions',
  'audit.audit_log',
  // Per appartenenza a metamc_stats, non per un GRANT ripetuto: e' il punto
  // dello script che crea il ruolo.
  'stats.v_online_5m',
  'stats.v_duels_mode',
  'stats.mode',
];

/**
 * Cio' che NON deve poter leggere.
 *
 * Sono le tabelle dei segreti di autenticazione. Un tool che ne leggesse una
 * spedirebbe hash di password o segreti TOTP all'API di un fornitore: non
 * «un permesso di troppo», una fuga.
 */
const VIETATE = [
  'auth."account"',
  'auth."twoFactor"',
  'auth.recovery_code',
  'auth.invitation',
  'auth."verification"',
  'auth.webauthn_credential',
  'auth.two_factor_reset',
  'auth.user_permissions',
  'auth.role_permissions',
];

describe('il ruolo dell`assistente legge quello che serve ai tool', () => {
  for (const rel of LEGGIBILI) {
    it(`legge ${rel}`, async () => {
      await expect(sql.query(`SELECT * FROM ${rel} LIMIT 0`)).resolves.toBeDefined();
    });
  }
});

describe('e non vede niente di cio` che non gli serve', () => {
  for (const rel of VIETATE) {
    it(`non legge ${rel}`, async () => {
      // 42501 = insufficient_privilege. Il messaggio non conta, il codice si':
      // un test che confronta la frase si rompe cambiando la lingua del
      // cluster.
      await expect(sql.query(`SELECT * FROM ${rel} LIMIT 0`)).rejects.toMatchObject({
        code: '42501',
      });
    });
  }

  it('e nemmeno una tabella aggiunta domani, perche' + ' non ci sono default privileges', async () => {
    // Il migrate crea una tabella nuova in `auth`; il ruolo non deve vederla
    // per il solo fatto che e' nata li' dentro. Senza questo, un
    // `ALTER DEFAULT PRIVILEGES` aggiunto per comodita' renderebbe leggibile
    // ogni tabella futura — comprese quelle che conterranno segreti.
    const owner = await connect(db.migrateUrl, 'metamc-test-migrate');
    try {
      await owner.query('CREATE TABLE auth.domani (id int primary key)');
      await expect(sql.query('SELECT * FROM auth.domani LIMIT 0')).rejects.toMatchObject({
        code: '42501',
      });
    } finally {
      await owner.query('DROP TABLE IF EXISTS auth.domani').catch(() => undefined);
      await owner.end().catch(() => undefined);
    }
  });
});

describe('e non scrive: la regola della v1 sta nel database', () => {
  it('non puo` scrivere nemmeno dove ha il SELECT', async () => {
    // `default_transaction_read_only` sul RUOLO: la transazione e' di sola
    // lettura prima ancora che i privilegi entrino in gioco. 25006 =
    // read_only_sql_transaction.
    await expect(sql.query(`UPDATE auth."user" SET name = 'x' WHERE id = 'nessuno'`)).rejects.toMatchObject({
      code: '25006',
    });
  });

  it('non puo` scrivere nel registro attivita`', async () => {
    // Il registro e' append-only con catena hash. Che l'assistente non possa
    // scriverci e' cio' che rende credibile la riga che lo riguarda: la scrive
    // il pannello, con il ruolo del pannello, non l'assistente per se stesso.
    await expect(
      sql.query(`INSERT INTO audit.audit_log (action, outcome) VALUES ('x', 'success')`),
    ).rejects.toMatchObject({ code: '25006' });
  });

  it('e non puo` sbloccarsi da solo', async () => {
    // `SET TRANSACTION READ WRITE` dentro una sessione con
    // `default_transaction_read_only` funziona in Postgres: e' la scappatoia
    // ovvia. Quello che resta a fermare la scrittura sono i privilegi, e senza
    // GRANT di INSERT/UPDATE non basta togliere la sola lettura.
    await sql.query('BEGIN');
    try {
      await sql.query('SET TRANSACTION READ WRITE');
      await expect(sql.query(`UPDATE auth."user" SET name = 'x' WHERE id = 'nessuno'`)).rejects.toMatchObject(
        { code: '42501' },
      );
    } finally {
      await sql.query('ROLLBACK').catch(() => undefined);
    }
  });
});
