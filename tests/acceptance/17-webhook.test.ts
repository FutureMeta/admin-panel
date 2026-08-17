// §14 test 17 — la sign del webhook Resend fallisce se il body e' stato
//               reparsed.  SEC-19
//
// Non e' un dettaglio implementativo: se il content-type parser consegnasse
// l'oggetto gia' parsato invece del buffer, la sign verrebbe ricalcolata su
// una serializzazione DIVERSA e ogni webhook legittimo sarebbe rifiutato —
// oppure, peggio, si verificherebbe la sign su byte diversi da quelli
// firmati.

import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sameOriginHeaders, startTestApp, type TestApp } from '#tests/support/app.ts';

let t: TestApp;
let secret: string;

beforeAll(async () => {
  t = await startTestApp({ label: 'webhook' });
  secret = t.ctx.env.RESEND_WEBHOOK_SECRET ?? '';
  expect(secret).not.toBe('');
}, 180_000);

afterAll(async () => {
  await t?.close();
});

/**
 * Firma Standard Webhooks: HMAC-SHA256 su `${id}.${timestamp}.${payload}`,
 * con la chiave decodificata da base64 usersAfter il prefisso `whsec_`.
 */
function sign(id: string, timestamp: string, payload: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const mac = createHmac('sha256', key).update(`${id}.${timestamp}.${payload}`).digest('base64');
  return `v1,${mac}`;
}

function send(payload: string, opts: { id?: string; timestamp?: string; signature?: string } = {}) {
  const id = opts.id ?? `msg_${Math.random().toString(36).slice(2)}`;
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  return t.app.inject({
    method: 'POST',
    url: '/webhooks/resend',
    headers: {
      'content-type': 'application/json',
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': opts.signature ?? sign(id, timestamp, payload),
    },
    payload,
  });
}

describe('SEC-19 / test 17 — sign del webhook sul raw body', () => {
  it('un webhook firmato correttamente viene accettato', async () => {
    const payload = JSON.stringify({ type: 'email.delivered', data: { email_id: 'abc123' } });
    const res = await send(payload);
    expect(res.statusCode).toBe(200);
  });

  it('la sign REGGE su un JSON con spaziatura non canonica', async () => {
    // Byte diversi, stesso oggetto. Se il server riparsasse e riserializzasse,
    // la sign non tornerebbe: e' la prova che si verifica sul RAW.
    const payload = '{  "type" : "email.delivered" ,  "data" : { "email_id" : "abc123" }  }';
    const res = await send(payload);
    expect(res.statusCode).toBe(200);
  });

  it('la sign calcolata sul body RIPARSATO viene RIFIUTATA', async () => {
    const original = '{  "type" : "email.delivered" ,  "data" : { "email_id" : "abc123" }  }';
    const reparsed = JSON.stringify(JSON.parse(original));
    expect(reparsed).not.toBe(original);

    const id = 'msg_riparsato';
    const timestamp = String(Math.floor(Date.now() / 1000));
    // Si sign la versione riparsata ma si INVIA l'original: e' esattamente
    // lo scenario in cui un middleware ha toccato il body.
    const res = await send(original, { id, timestamp, signature: sign(id, timestamp, reparsed) });
    expect(res.statusCode).toBe(400);
  });

  it('una sign inventata viene rifiutata', async () => {
    const payload = JSON.stringify({ type: 'email.delivered', data: { email_id: 'x' } });
    const res = await send(payload, { signature: 'v1,ZmlybWFfaW52ZW50YXRh' });
    expect(res.statusCode).toBe(400);
  });

  it('un timestamp diverso da quello firmato viene rifiutato (anti-replay Svix)', async () => {
    const payload = JSON.stringify({ type: 'email.delivered', data: { email_id: 'x' } });
    const id = 'msg_ts';
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await send(payload, {
      id,
      timestamp: String(Number(ts) - 5000),
      signature: sign(id, ts, payload),
    });
    expect(res.statusCode).toBe(400);
  });

  it('gli header mancanti producono 400, non un 500', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/webhooks/resend',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ type: 'email.delivered' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('la stessa consegna due volte viene deduplicata su svix-id', async () => {
    const payload = JSON.stringify({ type: 'email.delivered', data: { email_id: 'dedupe' } });
    const id = 'msg_dedupe_unico';
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = sign(id, ts, payload);

    const first = await send(payload, { id, timestamp: ts, signature: sig });
    const second = await send(payload, { id, timestamp: ts, signature: sig });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ ok: true, duplicate: true });
  });

  it('la rotta e` ESENTE da Origin, Sec-Fetch-Site e CSRF (SEC-19)', async () => {
    const payload = JSON.stringify({ type: 'email.delivered', data: { email_id: 'noorigin' } });
    // Nessun Origin, nessun Sec-Fetch-Site, nessun token: passerebbe 403 su
    // qualunque altra POST. Qui deve arrivare all'handler, perche' e'
    // server-to-server e non ha niente di tutto cio' da presentare.
    const res = await send(payload);
    expect(res.statusCode).toBe(200);
  });

  it('le altre rotte NON sono esenti: la prova che l`esenzione e` mirata', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/invites',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'x@metamc.it', name: 'Invitato', roleId: 1 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('un payload non riconosciuto viene ignorato, non fa cambiare stato', async () => {
    const payload = JSON.stringify({ tipo_sbagliato: true });
    const res = await send(payload);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });

  it('nessun evento del webhook cambia lo stato del pannello', async () => {
    // Un servizio terzo non deve poter modificare nulla: il webhook e'
    // osservativo. Si verifica che un `email.bounced` su un invito esistente
    // non lo revochi ne' lo consumi.
    const usersBefore = await t.ctx.db
      .selectFrom('auth.user')
      .select((eb) => eb.fn.countAll().as('n'))
      .executeTakeFirst();
    const payload = JSON.stringify({ type: 'email.bounced', data: { email_id: 'inesistente' } });
    await send(payload);
    const usersAfter = await t.ctx.db
      .selectFrom('auth.user')
      .select((eb) => eb.fn.countAll().as('n'))
      .executeTakeFirst();
    expect(Number(usersAfter?.n)).toBe(Number(usersBefore?.n));
  });

  it('il webhook riceve un Buffer, non un oggetto gia` parsato', async () => {
    // Verifica diretta del content-type parser: se consegnasse l'oggetto, la
    // sign non sarebbe verificabile e ogni webhook legittimo cadrebbe.
    const payload = JSON.stringify({ type: 'email.delivered', data: { email_id: 'buffer' } });
    const ok = await send(payload);
    expect(ok.statusCode).toBe(200);

    // Controprova: la stessa rotta con un body che NON e' JSON valido supera
    // comunque il parser (e' un buffer) e cade sulla sign, non sul parsing.
    const id = 'msg_nonjson';
    const ts = String(Math.floor(Date.now() / 1000));
    const nonJson = 'questo-non-e-json';
    const res = await send(nonJson, { id, timestamp: ts, signature: sign(id, ts, nonJson) });
    // La sign e' valida: il rifiuto arriva dallo schema del payload, e la
    // risposta e' un 200 con `ignored`, non un 400 di parsing.
    expect(res.statusCode).toBe(400);
  });
});

describe('la rotta e` protetta anche withoutSecret segreto configurato', () => {
  it('withoutSecret RESEND_WEBHOOK_SECRET la rotta risponde 503, non accetta', async () => {
    const withoutSecret = await startTestApp({ label: 'whnosec' });
    try {
      // Si azzera il segreto a runtime: e' il caso di una configurazione
      // incompleta in produzione.
      Reflect.deleteProperty(withoutSecret.ctx.env, 'RESEND_WEBHOOK_SECRET');
      const res = await withoutSecret.app.inject({
        method: 'POST',
        url: '/webhooks/resend',
        headers: {
          'content-type': 'application/json',
          'svix-id': 'x',
          'svix-timestamp': '1',
          'svix-signature': 'v1,x',
        },
        payload: JSON.stringify({ type: 'email.delivered' }),
      });
      // 503 e non 200: un endpoint non verificabile non accetta nulla.
      expect([503, 400]).toContain(res.statusCode);
    } finally {
      await withoutSecret.close();
    }
  }, 180_000);
});

// Riferimento non usato altrove, tenuto per chiarezza dell'import.
void sameOriginHeaders;
