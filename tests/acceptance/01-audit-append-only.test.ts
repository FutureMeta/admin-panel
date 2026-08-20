// §14 test 1 — `DELETE FROM audit.audit_log` eseguito dal ruolo metamc_app
// solleva eccezione.  SEC-47, SEC-48.
//
// Tre livelli, tutti verificati separatamente perche' ognuno difende da un
// avversario diverso (§10):
//   livello 1 — privilegi: nemmeno una SQL injection riuscita cancella
//   livello 2 — trigger: difende dall'errore umano, anche di chi ha i privilegi
//   livello 3 — catena hash: verificata nel test 2

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, createTestDatabase, type TestDatabase } from '#tests/support/postgres.ts';

let db: TestDatabase;
let app: pg.Client;
let owner: pg.Client;

beforeAll(async () => {
  db = await createTestDatabase('audit1');
  app = await connect(db.appUrl, 'metamc-app');
  owner = await connect(db.migrateUrl, 'metamc-migrate');

  // Una riga da provare a cancellare.
  await app.query(
    `INSERT INTO audit.audit_log (action, outcome, actor_user_id, actor_email)
     VALUES ('test.seed', 'success', 'u_seed', 'seed@metamc.it')`,
  );
}, 120_000);

afterAll(async () => {
  await app?.end().catch(() => undefined);
  await owner?.end().catch(() => undefined);
  await db?.drop();
});

describe('SEC-47 — audit log append-only', () => {
  it('metamc_app puo` inserire e leggere', async () => {
    const res = await app.query('SELECT count(*)::int AS n FROM audit.audit_log');
    expect(res.rows[0].n).toBeGreaterThan(0);
  });

  it('livello 1 — DELETE dal ruolo metamc_app e` negato dai privilegi', async () => {
    await expect(app.query('DELETE FROM audit.audit_log')).rejects.toThrow(
      /permission denied|permesso negato/i,
    );
  });

  it('livello 1 — UPDATE dal ruolo metamc_app e` negato dai privilegi', async () => {
    await expect(app.query("UPDATE audit.audit_log SET action = 'manomesso'")).rejects.toThrow(
      /permission denied|permesso negato/i,
    );
  });

  it('livello 1 — TRUNCATE dal ruolo metamc_app e` negato', async () => {
    await expect(app.query('TRUNCATE audit.audit_log')).rejects.toThrow(
      /permission denied|permesso negato|must be owner|deve essere il proprietario/i,
    );
  });

  it('livello 1 — DELETE che nomina DIRETTAMENTE la partizione e` comunque negato', async () => {
    // I privilegi non si ereditano dal padre quando la query nomina la
    // partizione: senza il REVOKE esplicito su ogni partizione questa sarebbe
    // la scorciatoia che aggira tutto.
    const part = await owner.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'audit' AND c.relname LIKE 'audit_log_%' ORDER BY 1 LIMIT 1`,
    );
    const name = part.rows[0]?.relname;
    expect(name).toBeDefined();
    await expect(app.query(`DELETE FROM audit.${name}`)).rejects.toThrow(
      /permission denied|permesso negato/i,
    );
  });

  it('livello 2 — il trigger blocca il DELETE anche per chi POSSIEDE la tabella', async () => {
    // metamc_migrate e' il proprietario: i privilegi non lo fermano, il
    // trigger si'. E' la difesa contro la migration sbagliata.
    await expect(owner.query('DELETE FROM audit.audit_log')).rejects.toThrow(/append-only/i);
  });

  it('livello 2 — il trigger blocca l`UPDATE anche per il proprietario', async () => {
    await expect(owner.query("UPDATE audit.audit_log SET outcome = 'success'")).rejects.toThrow(
      /append-only/i,
    );
  });

  it('livello 2 — il trigger e` presente anche sulle partizioni, non solo sul padre', async () => {
    const part = await owner.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'audit' AND c.relname LIKE 'audit_log_%' ORDER BY 1 LIMIT 1`,
    );
    const name = part.rows[0]?.relname;
    expect(name).toBeDefined();
    await expect(owner.query(`DELETE FROM audit.${name}`)).rejects.toThrow(/append-only/i);
  });

  it('metamc_app non ha alcun privilegio DDL', async () => {
    await expect(app.query('CREATE TABLE auth.intruso (id int)')).rejects.toThrow(
      /permission denied|permesso negato/i,
    );
  });

  it('lo schema stats non da` niente a metamc_app (§16.1)', async () => {
    // Fino alla fase 2 questo test verificava che lo schema `stats` fosse
    // VUOTO: la 001 lo creava apposta senza tabelle, e la riga a zero era il
    // modo di dire «la fase 2 non e` ancora iniziata». Adesso e` iniziata, e
    // quella asserzione misurerebbe solo il calendario.
    //
    // Cio` che invece vale ancora, e vale di piu` adesso che le tabelle
    // esistono: il ruolo che regge i login non tocca i fatti delle
    // statistiche. La 011 gli concede il solo dizionario delle modalita`,
    // perche` quel modulo passa dal pannello e deve scrivere nel registro
    // attivita`. Tutto il resto e` di `metamc_stats_rw`.
    await expect(app.query('SELECT 1 FROM stats.sample_server LIMIT 1')).rejects.toThrow(
      /permission denied|permesso negato/i,
    );
    await expect(app.query('SELECT 1 FROM stats.poll_cycle LIMIT 1')).rejects.toThrow(
      /permission denied|permesso negato/i,
    );
    await expect(app.query('SELECT 1 FROM stats.rollup_1h LIMIT 1')).rejects.toThrow(
      /permission denied|permesso negato/i,
    );
    // Il dizionario si', ed e` l'unica eccezione.
    await expect(app.query('SELECT 1 FROM stats.mode LIMIT 1')).resolves.toBeDefined();
  });
});
