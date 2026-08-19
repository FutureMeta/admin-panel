// Le partizioni dell'audit se le crea l'applicazione. §10, §17
//
// PERCHE' E' DELICATO, e perche' merita un test di accettazione invece di
// essere solo una funzione in piu'.
//
// Le partizioni mensili vanno create in anticipo. Se finiscono, l'INSERT di
// audit fallisce — e siccome sta nella stessa transazione delle modifiche di
// stato, falliscono anche quelle: il pannello si blocca in scrittura. Finora
// dipendeva da un cron che nessuno aveva mai configurato, cioe' da una cosa
// che sarebbe stata scoperta il giorno del guasto.
//
// Farlo fare all'applicazione significa dare a `metamc_app` il potere di
// creare tabelle, e quel ruolo non ha privilegi DDL PER SCELTA: e' cio' che
// rende il registro append-only anche davanti a una SQL injection riuscita.
//
// La via d'uscita e' una funzione `SECURITY DEFINER`: l'applicazione non
// riceve DDL, riceve il permesso di eseguire UNA funzione che fa una cosa
// sola. Quindi le proprieta' da verificare sono tre, e le prime due contano
// piu' della terza:
//
//   1. dopo la modifica, `metamc_app` NON puo' ancora cancellare, modificare
//      o distruggere niente. Il potere concesso e' additivo e stretto.
//   2. la funzione non si presta ad altro: un mese fuori da un orizzonte
//      ragionevole viene rifiutato, cosi' un chiamante compromesso non puo'
//      riempire lo schema di tabelle.
//   3. e, quella per cui esiste, `metamc_app` riesce davvero a crearle.

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKysely, createPool, type Database } from '#src/db/pool.ts';
import { connect, createTestDatabase, type TestDatabase } from '#tests/support/postgres.ts';

let testDb: TestDatabase;
let pool: pg.Pool;
let db: Database;
/** Connessione col ruolo applicativo: e' il soggetto di quasi tutti i test. */
let app: pg.Client;

/** Un mese lontano ma dentro l'orizzonte, scelto per non collidere con quelli seminati. */
const FUTURO = '2027-11-01';
const FUTURO_PART = 'audit_log_2027_11';

beforeAll(async () => {
  testDb = await createTestDatabase('partizioni');
  pool = createPool({ connectionString: testDb.appUrl, applicationName: 'metamc-test' });
  db = createKysely(pool);
  app = await connect(testDb.appUrl, 'metamc-test-app');
}, 180_000);

afterAll(async () => {
  await app?.end().catch(() => undefined);
  await db?.destroy().catch(() => undefined);
  await testDb?.drop();
});

describe('il ruolo applicativo resta senza potere di distruggere', () => {
  it('non puo` cancellare dal registro', async () => {
    await expect(app.query('DELETE FROM audit.audit_log')).rejects.toThrow();
  });

  it('non puo` modificare il registro', async () => {
    await expect(app.query("UPDATE audit.audit_log SET action = 'x'")).rejects.toThrow();
  });

  it('non puo` distruggere una partizione, che e` il modo in cui si pota', async () => {
    await expect(app.query('DROP TABLE audit.audit_log_2026_06')).rejects.toThrow();
  });

  it('non puo` staccare una partizione dal padre', async () => {
    await expect(
      app.query('ALTER TABLE audit.audit_log DETACH PARTITION audit.audit_log_2026_06'),
    ).rejects.toThrow();
  });

  it('non puo` creare una tabella per conto suo: il DDL resta negato', async () => {
    await expect(app.query('CREATE TABLE audit.abusivo (id int)')).rejects.toThrow();
  });
});

describe('la funzione concede una cosa sola, e stretta', () => {
  it('rifiuta un mese oltre l`orizzonte, cosi` non si riempie lo schema di tabelle', async () => {
    await expect(app.query("SELECT audit.create_month_partition('2099-01-01'::date)")).rejects.toThrow(
      /orizzonte/i,
    );
  });

  it('rifiuta un mese troppo indietro', async () => {
    await expect(app.query("SELECT audit.create_month_partition('2000-01-01'::date)")).rejects.toThrow(
      /orizzonte/i,
    );
  });

  it('non e` eseguibile da PUBLIC: il permesso e` nominale, non universale', async () => {
    const { rows } = await app.query<{ concesso: boolean }>(
      "SELECT has_function_privilege('public', 'audit.create_month_partition(date)', 'EXECUTE') AS concesso",
    );
    expect(rows[0]?.concesso).toBe(false);
  });
});

describe('e la cosa per cui esiste', () => {
  it('metamc_app crea una partizione mancante', async () => {
    const { rows } = await app.query<{ create_month_partition: string }>(
      `SELECT audit.create_month_partition('${FUTURO}'::date)`,
    );
    expect(rows[0]?.create_month_partition).toBe(`audit.${FUTURO_PART}`);

    const esiste = await app.query(
      `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'audit' AND c.relname = '${FUTURO_PART}'`,
    );
    expect(esiste.rowCount).toBe(1);
  });

  it('chiamarla due volte non e` un errore: e` la stessa partizione', async () => {
    const { rows } = await app.query<{ create_month_partition: string }>(
      `SELECT audit.create_month_partition('${FUTURO}'::date)`,
    );
    expect(rows[0]?.create_month_partition).toBe(`audit.${FUTURO_PART}`);
  });

  it('la partizione nata cosi` eredita i vincoli: niente DELETE nemmeno li`', async () => {
    await expect(app.query(`DELETE FROM audit.${FUTURO_PART}`)).rejects.toThrow();
    await expect(app.query(`UPDATE audit.${FUTURO_PART} SET action = 'x'`)).rejects.toThrow();
  });

  it('e` attaccata al padre con i confini del mese giusto', async () => {
    // Una tabella creata ma non collegata non riceverebbe nessuna riga, e
    // l'INSERT di audit fallirebbe comunque: qui si verifica il legame.
    const { rows } = await app.query<{ bounds: string }>(
      `SELECT pg_get_expr(c.relpartbound, c.oid) AS bounds
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'audit' AND c.relname = '${FUTURO_PART}'`,
    );
    expect(rows[0]?.bounds).toContain('2027-11-01');
    expect(rows[0]?.bounds).toContain('2027-12-01');
  });
});
