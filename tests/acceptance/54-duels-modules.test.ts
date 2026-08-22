// I due moduli RBAC del modulo Duels. Migration 015.
//
// LA GUARDIA CHE NON C'ERA. `src/authz/modules.ts` dice di essere «la
// controparte tipizzata del seed, verificata da un test». Quel test non
// esisteva: cercando `MODULES` in tutta la cartella dei test non usciva
// niente. Le due liste potevano divergere in silenzio, e la divergenza si
// vede solo quando qualcuno chiede un permesso su un modulo che il database
// non conosce — cioe' a runtime, su una rotta, addosso a un utente.
//
// IL TRIGGER RIACCESO E' L'ALTRA COSA. La 015 spegne
// `t_protect_system_role_permissions` per poter scrivere la riga di `owner`,
// e lo riaccende in coda. Se quel ripristino saltasse — un errore a meta'
// migration, una riga spostata — la protezione sui ruoli di sistema sparirebbe
// PER SEMPRE e nulla lo direbbe: le migration successive applicherebbero
// pulite, i test passerebbero, e da quel momento i permessi di `owner`
// sarebbero modificabili da chiunque possa scrivere sulla tabella. E' un
// difetto che non ha sintomi finche' non serve.

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MODULES } from '#src/authz/modules.ts';
import { connect, createTestDatabase, type TestDatabase } from '#tests/support/postgres.ts';

let testDb: TestDatabase;
let sql: pg.Client;

beforeAll(async () => {
  testDb = await createTestDatabase('duelsmod');
  sql = await connect(testDb.migrateUrl, 'metamc-test-duelsmod');
}, 180_000);

afterAll(async () => {
  await sql?.end().catch(() => undefined);
  await testDb?.drop();
});

describe('il vocabolario dei moduli e` uno solo', () => {
  it('la lista tipizzata e il seed dicono le stesse chiavi', async () => {
    const res = await sql.query<{ key: string }>('SELECT key FROM auth.modules ORDER BY key');
    const nelDatabase = res.rows.map((r) => r.key).sort();
    expect(nelDatabase).toEqual([...MODULES].sort());
  });

  it('i due moduli nuovi ci sono, con il loro posto nell`ordine', async () => {
    const res = await sql.query<{ key: string; name: string; sort_order: number }>(
      `SELECT key, name, sort_order FROM auth.modules
        WHERE key IN ('duels', 'duels_feedback') ORDER BY sort_order`,
    );
    expect(res.rows).toEqual([
      { key: 'duels', name: 'Duels', sort_order: 75 },
      { key: 'duels_feedback', name: 'Valutazioni Duels', sort_order: 76 },
    ]);
  });

  it('stanno fra `statistiche` e `server`, dove il gruppo li vuole', async () => {
    const res = await sql.query<{ key: string }>(
      `SELECT key FROM auth.modules WHERE sort_order BETWEEN 70 AND 80 ORDER BY sort_order`,
    );
    expect(res.rows.map((r) => r.key)).toEqual(['statistiche', 'duels', 'duels_feedback', 'server']);
  });
});

describe('la matrice dei permessi e` quella dichiarata', () => {
  async function livelli(moduleKey: string): Promise<Record<string, number>> {
    const res = await sql.query<{ role_key: string; level: number }>(
      `SELECT r.key AS role_key, rp.level
         FROM auth.role_permissions rp
         JOIN auth.roles r   ON r.id = rp.role_id
         JOIN auth.modules m ON m.id = rp.module_id
        WHERE m.key = $1`,
      [moduleKey],
    );
    return Object.fromEntries(res.rows.map((r) => [r.role_key, r.level]));
  }

  it('`duels`: owner e admin gestiscono, dev e moderatore leggono', async () => {
    expect(await livelli('duels')).toEqual({ owner: 3, admin: 3, dev: 1, moderatore: 1 });
  });

  it('`duels_feedback`: il moderatore legge i commenti, lo sviluppatore no', async () => {
    // E` il verso che separa un dato personale da un aggregato, ed e` la sola
    // ragione per cui i moduli sono due invece di uno.
    expect(await livelli('duels_feedback')).toEqual({ owner: 3, admin: 2, dev: 0, moderatore: 1 });
  });

  it('owner ha 3 su entrambi, o la dominanza si rompe', async () => {
    // La matrice determina chi puo` agire su chi. Se un ruolo non-owner avesse
    // su un modulo un livello superiore a quello di admin, admin smetterebbe
    // di dominarlo — ed e` il test 6 della fase 1 a cadere, non questo.
    const res = await sql.query<{ key: string; level: number }>(
      `SELECT m.key, rp.level
         FROM auth.role_permissions rp
         JOIN auth.roles r   ON r.id = rp.role_id AND r.key = 'owner'
         JOIN auth.modules m ON m.id = rp.module_id
        WHERE m.key LIKE 'duels%'`,
    );
    expect(res.rows.every((r) => r.level === 3)).toBe(true);
    expect(res.rows).toHaveLength(2);
  });
});

describe('la protezione dei ruoli di sistema e` tornata su', () => {
  it('il trigger e` ABILITATO dopo la migration', async () => {
    // `tgenabled`: 'O' = abilitato (origin), 'D' = disabilitato. Se la 015
    // dimenticasse `ENABLE TRIGGER`, qui uscirebbe 'D' e tutto il resto
    // continuerebbe a funzionare come se niente fosse.
    const res = await sql.query<{ tgenabled: string }>(
      `SELECT tgenabled FROM pg_trigger
        WHERE tgname = 't_protect_system_role_permissions'
          AND tgrelid = 'auth.role_permissions'::regclass`,
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]?.tgenabled).toBe('O');
  });

  it('e rifiuta davvero: i permessi di owner non si toccano', async () => {
    // Non basta leggere `tgenabled`: si esercita. Un trigger abilitato che
    // non scatta e` esattamente il controllo inerte contro cui gira meta` di
    // questo progetto.
    const rifiutata = await sql
      .query(
        `UPDATE auth.role_permissions SET level = 1
          WHERE role_id = (SELECT id FROM auth.roles WHERE key = 'owner')
            AND module_id = (SELECT id FROM auth.modules WHERE key = 'duels')`,
      )
      .then(() => null)
      .catch((err: unknown) => err);

    expect(rifiutata).not.toBeNull();
    expect(String((rifiutata as Error).message)).toContain('ruolo di sistema');
  });
});

describe('le sessioni gia` aperte vedono il modulo nuovo', () => {
  it('`permissions_version` e` stata alzata a chi ha i ruoli toccati', async () => {
    // `t_bump_role_permissions` NON va spento durante il seed, ed e` la
    // ragione: lo snapshot di autorizzazione vive in Redis senza scadenza e si
    // ricostruisce solo al cambio di versione. Spegnendolo, il modulo nuovo
    // comparirebbe solo al prossimo login — che con sessioni da quattordici
    // giorni (D-11) vuol dire due settimane.
    //
    // Il seed della 003 parte con la versione a 1; la 015 scrive otto righe
    // sulla matrice, quindi chi ha uno dei quattro ruoli e` stato bumpato.
    const before = await sql.query<{ v: number }>(`SELECT permissions_version AS v FROM auth."user" LIMIT 1`);
    // Su un database appena migrato non ci sono utenti: si crea la condizione
    // e si verifica il MECCANISMO, che e` cio` che deve restare vero.
    if (before.rowCount === 0) {
      await sql.query(
        `INSERT INTO auth."user" (id, email, name, "emailVerified", "createdAt", "updatedAt")
         VALUES ('u-duels-test', 'bump@metamc.it', 'Bump', true, now(), now())`,
      );
      await sql.query(
        `INSERT INTO auth.user_roles (user_id, role_id)
         SELECT 'u-duels-test', id FROM auth.roles WHERE key = 'moderatore'`,
      );
    }

    const prima = (
      await sql.query<{ v: number }>(
        `SELECT permissions_version AS v FROM auth."user" WHERE id = 'u-duels-test'`,
      )
    ).rows[0]?.v;

    // Una modifica alla matrice di quel ruolo deve alzare la versione.
    await sql.query(
      `UPDATE auth.role_permissions SET level = 1
        WHERE role_id = (SELECT id FROM auth.roles WHERE key = 'moderatore')
          AND module_id = (SELECT id FROM auth.modules WHERE key = 'duels_feedback')`,
    );

    const dopo = (
      await sql.query<{ v: number }>(
        `SELECT permissions_version AS v FROM auth."user" WHERE id = 'u-duels-test'`,
      )
    ).rows[0]?.v;

    expect(Number(dopo)).toBeGreaterThan(Number(prima));
  });
});
