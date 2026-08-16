// §14 test 2 — manomettere una riga passata dell'audit (via metamc_migrate)
// fa fallire la verifica della catena.  SEC-47.
//
// Il modello di minaccia e' esplicito: l'avversario POSSIEDE la tabella. Deve
// quindi disattivare il trigger di immutabilita' per scrivere — cosa che solo
// il proprietario puo' fare. La catena hash e' l'ultimo livello, quello che
// resta in piedi quando i primi due sono stati aggirati.
//
// Ogni scenario distruttivo lavora su un database effimero suo: una catena
// spezzata non si "ripara" in modo credibile, e riusare il database fra
// scenari renderebbe l'esito del secondo dipendente dal primo.

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, createTestDatabase, type TestDatabase } from '#tests/support/postgres.ts';

const PART = new Date().toISOString().slice(0, 7).replace('-', ''); // YYYYMM

type Verdict = { ok: boolean; rows_checked: string; bad_id: string | null; detail: string | null };

type Fixture = {
  db: TestDatabase;
  app: pg.Client;
  owner: pg.Client;
  verify: () => Promise<Verdict>;
  /** Disattiva il trigger di immutabilita', manomette, lo riattiva. */
  tamper: (sql: string, params?: unknown[]) => Promise<void>;
  close: () => Promise<void>;
};

const opened: Fixture[] = [];

async function fixture(label: string, rows = 8): Promise<Fixture> {
  const db = await createTestDatabase(label);
  const app = await connect(db.appUrl, 'metamc-app');
  const owner = await connect(db.migrateUrl, 'metamc-migrate');

  for (let i = 0; i < rows; i += 1) {
    await app.query(
      `INSERT INTO audit.audit_log (action, outcome, actor_user_id, actor_email, target_id, meta)
       VALUES ($1, 'success', $2, $3, $4, $5)`,
      [`test.evento.${i}`, `u_${i}`, `u${i}@metamc.it`, `t_${i}`, JSON.stringify({ i })],
    );
  }

  const f: Fixture = {
    db,
    app,
    owner,
    verify: async () => {
      const res = await app.query<Verdict>('SELECT * FROM audit.verify_chain($1)', [PART]);
      const row = res.rows[0];
      if (!row) throw new Error('verify_chain non ha restituito righe');
      return row;
    },
    tamper: async (sql, params = []) => {
      await owner.query('ALTER TABLE audit.audit_log DISABLE TRIGGER t_immutable');
      try {
        await owner.query(sql, params);
      } finally {
        await owner.query('ALTER TABLE audit.audit_log ENABLE TRIGGER t_immutable');
      }
    },
    close: async () => {
      await app.end().catch(() => undefined);
      await owner.end().catch(() => undefined);
      await db.drop();
    },
  };
  opened.push(f);
  return f;
}

/** L'id della riga che chiude davvero la catena: quella che nessuno punta. */
async function chainTailId(f: Fixture): Promise<string> {
  const res = await f.owner.query<{ id: string }>(
    `SELECT l.id FROM audit.audit_log l
      WHERE NOT EXISTS (SELECT 1 FROM audit.audit_log n WHERE n.prev_hash = l.hash)`,
  );
  const id = res.rows[0]?.id;
  if (!id) throw new Error('nessuna coda di catena trovata');
  return id;
}

async function idOf(f: Fixture, action: string): Promise<string> {
  const res = await f.owner.query<{ id: string }>('SELECT id FROM audit.audit_log WHERE action = $1', [
    action,
  ]);
  const id = res.rows[0]?.id;
  if (!id) throw new Error(`nessuna riga con action=${action}`);
  return id;
}

let base: Fixture;
beforeAll(async () => {
  base = await fixture('chainbase');
}, 180_000);

afterAll(async () => {
  await Promise.all(opened.map((f) => f.close().catch(() => undefined)));
});

describe('SEC-47 — catena hash tamper-evident', () => {
  it('la catena e` integra subito dopo gli INSERT', async () => {
    const v = await base.verify();
    expect(v.detail).toBeNull();
    expect(v.ok).toBe(true);
    expect(Number(v.rows_checked)).toBe(8);
  });

  it('ogni riga e` concatenata alla precedente, e ce n`e` una sola radice e una sola coda', async () => {
    const orphans = await base.app.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit.audit_log l
        WHERE l.prev_hash <> decode(repeat('00',32),'hex')
          AND NOT EXISTS (SELECT 1 FROM audit.audit_log p WHERE p.hash = l.prev_hash)`,
    );
    expect(Number(orphans.rows[0]?.n)).toBe(0);

    const roots = await base.app.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit.audit_log WHERE prev_hash = decode(repeat('00',32),'hex')`,
    );
    expect(Number(roots.rows[0]?.n)).toBe(1);

    const tails = await base.app.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit.audit_log l
        WHERE NOT EXISTS (SELECT 1 FROM audit.audit_log n WHERE n.prev_hash = l.hash)`,
    );
    expect(Number(tails.rows[0]?.n)).toBe(1);
  });

  it('la verifica e` eseguibile dal ruolo applicativo (endpoint /internal/audit-integrity)', async () => {
    await expect(base.app.query('SELECT * FROM audit.verify_chain($1)', [PART])).resolves.toBeDefined();
  });

  it('manomettere il CONTENUTO di una riga passata fa fallire la verifica', async () => {
    const f = await fixture('chaincontent');
    const id = await idOf(f, 'test.evento.3');
    await f.tamper("UPDATE audit.audit_log SET outcome = 'denied' WHERE id = $1", [id]);

    const v = await f.verify();
    expect(v.ok).toBe(false);
    expect(v.detail).toMatch(/non corrisponde al suo contenuto/);
    expect(v.bad_id).toBe(id);
  });

  it('manomettere un campo jsonb fa fallire la verifica', async () => {
    const f = await fixture('chainjsonb');
    const id = await idOf(f, 'test.evento.5');
    await f.tamper(`UPDATE audit.audit_log SET meta = '{"i": 999}'::jsonb WHERE id = $1`, [id]);

    const v = await f.verify();
    expect(v.ok).toBe(false);
    expect(v.bad_id).toBe(id);
  });

  it('manomettere l`IP di una riga fa fallire la verifica (i due IP sono nella canonica)', async () => {
    const f = await fixture('chainip');
    const id = await idOf(f, 'test.evento.2');
    await f.tamper("UPDATE audit.audit_log SET actor_ip = '10.0.0.1'::inet WHERE id = $1", [id]);
    expect((await f.verify()).ok).toBe(false);
  });

  it('CANCELLARE una riga intermedia fa fallire la verifica', async () => {
    const f = await fixture('chaindelete');
    const id = await idOf(f, 'test.evento.4');
    await f.tamper('DELETE FROM audit.audit_log WHERE id = $1', [id]);

    const v = await f.verify();
    expect(v.ok).toBe(false);
    expect(v.detail).toMatch(/riga cancellata o riscritta/);
  });

  it('TRONCARE la coda fa fallire la verifica contro chain_head', async () => {
    const f = await fixture('chaintruncate');
    const tail = await chainTailId(f);
    await f.tamper('DELETE FROM audit.audit_log WHERE id = $1', [tail]);

    const v = await f.verify();
    expect(v.ok).toBe(false);
    expect(v.detail).toMatch(/chain_head non coincide|catena troncata/);
  });

  it('manomettere chain_head fa fallire la verifica anche a righe intatte', async () => {
    const f = await fixture('chainhead');
    expect((await f.verify()).ok).toBe(true);

    await f.owner.query(
      `UPDATE audit.chain_head SET head_hash = decode(repeat('ff',32),'hex') WHERE partition_key = $1`,
      [PART],
    );
    const v = await f.verify();
    expect(v.ok).toBe(false);
    expect(v.detail).toMatch(/chain_head non coincide/);
  });

  it('reinserire una riga con hash ricalcolato NON ripara la catena (l`hash successivo non torna)', async () => {
    const f = await fixture('chainforge');
    const id = await idOf(f, 'test.evento.3');
    // L'avversario riscrive la riga E ricalcola il suo hash sul contenuto
    // nuovo: e' il tentativo di manomissione piu' credibile. In due passaggi,
    // perche' dentro una sola UPDATE `audit.canonical(audit_log.*)` vedrebbe
    // ancora i valori vecchi.
    await f.tamper("UPDATE audit.audit_log SET outcome = 'denied' WHERE id = $1", [id]);
    await f.tamper(
      `UPDATE audit.audit_log
          SET hash = sha256(prev_hash || convert_to(audit.canonical(audit_log.*),'UTF8'))
        WHERE id = $1`,
      [id],
    );

    // Il controllo 1 ora passa per QUELLA riga: l'hash corrisponde al contenuto.
    const selfConsistent = await f.owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit.audit_log l
        WHERE l.id = $1 AND l.hash = sha256(l.prev_hash || convert_to(audit.canonical(l),'UTF8'))`,
      [id],
    );
    expect(Number(selfConsistent.rows[0]?.n)).toBe(1);

    // Ma la riga SUCCESSIVA continua a puntare al vecchio hash: la catena si
    // spezza comunque. E' esattamente cio' per cui esiste il concatenamento.
    const v = await f.verify();
    expect(v.ok).toBe(false);
    expect(v.detail).toMatch(/riga cancellata o riscritta|chain_head non coincide|biforcata/);
  });
});
