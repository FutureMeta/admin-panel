// §14 test 10 — due accettazioni CONCORRENTI dello stesso invito: una sola
//               riesce, e non nascono due utenti.
// §14 test 11 — due consumi CONCORRENTI dello stesso recovery code: uno solo
//               riesce.  SEC-13
//
// Sono i due test che nessuna lettura del codice sostituisce: la correttezza
// dipende da cosa fa Postgres quando due transazioni toccano la stessa riga,
// non da cosa sembra fare la funzione.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consumeRecoveryCode, issueRecoveryCodes } from '#src/auth/recovery-codes.ts';
import { type Actor, loginAs, seedUser } from '#tests/support/actors.ts';
import { sameOriginHeaders, startTestApp, type TestApp } from '#tests/support/app.ts';

let t: TestApp;
let invitante: Actor;
let roleId: number;

beforeAll(async () => {
  t = await startTestApp({ label: 'conc' });
  invitante = await loginAs(t, await seedUser(t, { roleKey: 'owner' }));
  const role = await t.ctx.db
    .selectFrom('auth.roles')
    .select('id')
    .where('key', '=', 'moderatore')
    .executeTakeFirstOrThrow();
  roleId = role.id;
}, 180_000);

afterAll(async () => {
  await t?.close();
});

/** Emette un invito e restituisce il token estratto dall'email. */
async function emettiInvito(email: string): Promise<string> {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/invites',
    headers: invitante.headers(),
    payload: { email, roleId },
  });
  if (res.statusCode !== 201) throw new Error(`invito non emesso: ${res.statusCode} ${res.body}`);

  const mail = t.mailer.lastTo(email);
  if (!mail) throw new Error('nessuna email inviata');
  const token = /\/accept\?t=([A-Za-z0-9_-]+)/.exec(mail.text)?.[1];
  if (!token) throw new Error('token non trovato nell`email');
  return token;
}

/** Apre il link di invito e restituisce il cookie di onboarding. */
async function apriInvito(token: string): Promise<string> {
  const res = await t.app.inject({ method: 'GET', url: `/accept?t=${token}` });
  expect(res.statusCode).toBe(302);
  const setCookie = res.headers['set-cookie'];
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const onb = list.find((c) => c.startsWith('__Host-metamc_onboarding='));
  if (!onb) throw new Error('nessun cookie di onboarding');
  return onb.split(';')[0]?.split('=')[1] ?? '';
}

describe('test 10 — due accettazioni concorrenti dello stesso invito', () => {
  it('il token non compare MAI nella risposta HTTP: esiste solo nell`email', async () => {
    const email = 'solo-email@metamc.it';
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/invites',
      headers: invitante.headers(),
      payload: { email, roleId },
    });
    expect(res.statusCode).toBe(201);
    const mail = t.mailer.lastTo(email);
    const token = /\/accept\?t=([A-Za-z0-9_-]+)/.exec(mail?.text ?? '')?.[1];
    expect(token).toBeDefined();
    expect(res.body).not.toContain(token as string);
  });

  it('in tabella c`e` solo lo SHA-256 del token, mai il token', async () => {
    const token = await emettiInvito('hash-solo@metamc.it');
    const rows = await t.ctx.db
      .selectFrom('auth.invitation')
      .select(['token_hash'])
      .where('email_lower', '=', 'hash-solo@metamc.it')
      .execute();
    expect(rows).toHaveLength(1);
    const stored = rows[0]?.token_hash;
    expect(stored).toBeDefined();
    expect(Buffer.from(stored as Buffer).length).toBe(32);
    expect(Buffer.from(stored as Buffer).toString('utf8')).not.toContain(token);
  });

  it('due POST /api/invites/accept concorrenti: UNA sola riesce', async () => {
    const email = 'gara@metamc.it';
    const token = await emettiInvito(email);

    // Due sessioni di onboarding distinte sullo STESSO invito: e' lo scenario
    // reale — lo stesso link aperto in due schede, o un doppio clic.
    const [onbA, onbB] = await Promise.all([apriInvito(token), apriInvito(token)]);

    const accetta = (onb: string) =>
      t.app.inject({
        method: 'POST',
        url: '/api/invites/accept',
        headers: sameOriginHeaders({ cookie: `__Host-metamc_onboarding=${onb}` }),
        payload: { password: 'password-di-accettazione-lunga', name: 'Nuovo Utente' },
      });

    const [a, b] = await Promise.all([accetta(onbA), accetta(onbB)]);
    const statuses = [a.statusCode, b.statusCode].sort();

    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(1);

    // ...e soprattutto: UN solo utente.
    const utenti = await t.ctx.db.selectFrom('auth.user').select('id').where('email', '=', email).execute();
    expect(utenti).toHaveLength(1);

    const invito = await t.ctx.db
      .selectFrom('auth.invitation')
      .select(['consumed_at', 'consumed_user_id'])
      .where('email_lower', '=', email)
      .executeTakeFirstOrThrow();
    expect(invito.consumed_at).not.toBeNull();
    expect(invito.consumed_user_id).toBe(utenti[0]?.id);
  });

  it('quattro accettazioni concorrenti: sempre una sola', async () => {
    const email = 'gara-quattro@metamc.it';
    const token = await emettiInvito(email);
    const onbs = await Promise.all([
      apriInvito(token),
      apriInvito(token),
      apriInvito(token),
      apriInvito(token),
    ]);

    const risultati = await Promise.all(
      onbs.map((onb) =>
        t.app.inject({
          method: 'POST',
          url: '/api/invites/accept',
          headers: sameOriginHeaders({ cookie: `__Host-metamc_onboarding=${onb}` }),
          payload: { password: 'password-di-accettazione-lunga', name: 'Nuovo' },
        }),
      ),
    );

    expect(risultati.filter((r) => r.statusCode === 201)).toHaveLength(1);
    const utenti = await t.ctx.db.selectFrom('auth.user').select('id').where('email', '=', email).execute();
    expect(utenti).toHaveLength(1);
  });

  it('un invito gia` consumato non si riapre, nemmeno con lo stesso token', async () => {
    const email = 'una-volta@metamc.it';
    const token = await emettiInvito(email);
    const onb = await apriInvito(token);

    const primo = await t.app.inject({
      method: 'POST',
      url: '/api/invites/accept',
      headers: sameOriginHeaders({ cookie: `__Host-metamc_onboarding=${onb}` }),
      payload: { password: 'password-di-accettazione-lunga', name: 'Nuovo' },
    });
    expect(primo.statusCode).toBe(201);

    // Il link non porta piu' da nessuna parte: nessun nuovo onboarding.
    const riapertura = await t.app.inject({ method: 'GET', url: `/accept?t=${token}` });
    expect(riapertura.statusCode).toBe(302);
    const list = riapertura.headers['set-cookie'];
    const cookies = Array.isArray(list) ? list : list ? [list] : [];
    expect(cookies.some((c) => c.startsWith('__Host-metamc_onboarding='))).toBe(false);
  });

  it('SEC-32 — token inesistente, scaduto e revocato producono lo STESSO esito', async () => {
    const inesistente = await t.app.inject({ method: 'GET', url: '/accept?t=token-che-non-esiste-affatto' });

    const emailScaduta = 'scaduto@metamc.it';
    const tokenScaduto = await emettiInvito(emailScaduta);
    // Si spostano indietro ENTRAMBE le date: il CHECK `expires_at >
    // created_at` non ammette un invito nato gia' scaduto, ed e' giusto cosi'
    // — nella realta' un invito non si "accorcia", si revoca.
    await t.ctx.db
      .updateTable('auth.invitation')
      .set({ created_at: new Date(Date.now() - 90 * 3600_000), expires_at: new Date(Date.now() - 1000) })
      .where('email_lower', '=', emailScaduta)
      .execute();
    const scaduto = await t.app.inject({ method: 'GET', url: `/accept?t=${tokenScaduto}` });

    const emailRevocata = 'revocato@metamc.it';
    const tokenRevocato = await emettiInvito(emailRevocata);
    await t.ctx.db
      .updateTable('auth.invitation')
      .set({ revoked_at: new Date(), revoked_by: invitante.userId })
      .where('email_lower', '=', emailRevocata)
      .execute();
    const revocato = await t.app.inject({ method: 'GET', url: `/accept?t=${tokenRevocato}` });

    for (const res of [inesistente, scaduto, revocato]) {
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/accept');
      const list = res.headers['set-cookie'];
      const cookies = Array.isArray(list) ? list : list ? [list] : [];
      expect(cookies.some((c) => c.startsWith('__Host-metamc_onboarding='))).toBe(false);
    }
  });

  it('l`indice parziale impedisce due inviti pendenti per la stessa email', async () => {
    const email = 'doppione@metamc.it';
    await emettiInvito(email);
    const secondo = await t.app.inject({
      method: 'POST',
      url: '/api/invites',
      headers: invitante.headers(),
      payload: { email, roleId },
    });
    expect(secondo.statusCode).toBe(409);
  });
});

describe('SEC-13 / test 11 — due consumi concorrenti dello stesso recovery code', () => {
  it('uno solo riesce', async () => {
    const user = await seedUser(t);
    const { codes } = await t.ctx.db.transaction().execute((trx) => issueRecoveryCodes(trx, user.id));
    const code = codes[0];
    expect(code).toBeDefined();

    // Due transazioni, stesso codice, insieme.
    const [a, b] = await Promise.all([
      t.ctx.db.transaction().execute((trx) => consumeRecoveryCode(trx, user.id, code as string, '127.0.0.1')),
      t.ctx.db.transaction().execute((trx) => consumeRecoveryCode(trx, user.id, code as string, '127.0.0.1')),
    ]);

    const riusciti = [a, b].filter((r) => r.ok);
    expect(riusciti).toHaveLength(1);

    const row = await t.ctx.db
      .selectFrom('auth.recovery_code')
      .select(['used_at', 'used_ip'])
      .where('user_id', '=', user.id)
      .where('used_at', 'is not', null)
      .execute();
    expect(row).toHaveLength(1);
  });

  it('cinque consumi concorrenti: sempre uno solo', async () => {
    const user = await seedUser(t);
    const { codes } = await t.ctx.db.transaction().execute((trx) => issueRecoveryCodes(trx, user.id));
    const code = codes[0] as string;

    const esiti = await Promise.all(
      Array.from({ length: 5 }, () =>
        t.ctx.db.transaction().execute((trx) => consumeRecoveryCode(trx, user.id, code, '127.0.0.1')),
      ),
    );
    expect(esiti.filter((e) => e.ok)).toHaveLength(1);
  });

  it('un codice speso non si riapre nemmeno con una UPDATE diretta', async () => {
    const user = await seedUser(t);
    const { codes } = await t.ctx.db.transaction().execute((trx) => issueRecoveryCodes(trx, user.id));
    await t.ctx.db
      .transaction()
      .execute((trx) => consumeRecoveryCode(trx, user.id, codes[0] as string, '127.0.0.1'));

    await expect(
      t.ctx.db
        .updateTable('auth.recovery_code')
        .set({ used_at: null })
        .where('user_id', '=', user.id)
        .where('used_at', 'is not', null)
        .execute(),
    ).rejects.toThrow(/non si riapre/i);
  });

  it('rigenerare invalida in blocco la generazione precedente', async () => {
    const user = await seedUser(t);
    const prima = await t.ctx.db.transaction().execute((trx) => issueRecoveryCodes(trx, user.id));
    const dopo = await t.ctx.db.transaction().execute((trx) => issueRecoveryCodes(trx, user.id));
    expect(dopo.generation).toBe(prima.generation + 1);

    // Un codice della generazione vecchia non vale piu'.
    const esito = await t.ctx.db
      .transaction()
      .execute((trx) => consumeRecoveryCode(trx, user.id, prima.codes[0] as string, '127.0.0.1'));
    expect(esito.ok).toBe(false);

    // Uno della nuova si'.
    const nuovo = await t.ctx.db
      .transaction()
      .execute((trx) => consumeRecoveryCode(trx, user.id, dopo.codes[0] as string, '127.0.0.1'));
    expect(nuovo.ok).toBe(true);
  });

  it('i codici sono 10, da 26 caratteri, e in tabella c`e` solo il digest', async () => {
    const user = await seedUser(t);
    const { codes } = await t.ctx.db.transaction().execute((trx) => issueRecoveryCodes(trx, user.id));
    expect(codes).toHaveLength(10);
    for (const c of codes) {
      // 128 bit in Base32 Crockford = 26 caratteri, alfabeto senza I/L/O/U.
      expect(c).toHaveLength(26);
      expect(c).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
    }
    const rows = await t.ctx.db
      .selectFrom('auth.recovery_code')
      .select('code_hash')
      .where('user_id', '=', user.id)
      .execute();
    for (const r of rows) {
      expect(Buffer.from(r.code_hash).length).toBe(32);
      for (const c of codes) {
        expect(Buffer.from(r.code_hash).toString('utf8')).not.toContain(c);
      }
    }
  });

  it('la normalizzazione perdona O/0 e I/1, che sono l`errore di trascrizione classico', async () => {
    const user = await seedUser(t);
    const { codes } = await t.ctx.db.transaction().execute((trx) => issueRecoveryCodes(trx, user.id));
    const code = codes[0] as string;
    // Formato mostrato all'utente: gruppi separati da trattini, minuscolo.
    const trascritto = (code.match(/.{1,5}/g) ?? []).join('-').toLowerCase();
    const esito = await t.ctx.db
      .transaction()
      .execute((trx) => consumeRecoveryCode(trx, user.id, trascritto, '127.0.0.1'));
    expect(esito.ok).toBe(true);
  });
});
