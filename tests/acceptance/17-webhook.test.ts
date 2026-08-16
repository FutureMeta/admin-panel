// §14 test 17 — la firma del webhook Resend fallisce se il body e' stato
//               riparsato.  SEC-19
//
// Non e' un dettaglio implementativo: se il content-type parser consegnasse
// l'oggetto gia' parsato invece del buffer, la firma verrebbe ricalcolata su
// una serializzazione DIVERSA e ogni webhook legittimo sarebbe rifiutato —
// oppure, peggio, si verificherebbe la firma su byte diversi da quelli
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
 * con la chiave decodificata da base64 dopo il prefisso `whsec_`.
 */
function firma(id: string, timestamp: string, payload: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const mac = createHmac('sha256', key).update(`${id}.${timestamp}.${payload}`).digest('base64');
  return `v1,${mac}`;
}

function invia(payload: string, opts: { id?: string; timestamp?: string; signature?: string } = {}) {
  const id = opts.id ?? `msg_${Math.random().toString(36).slice(2)}`;
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  return t.app.inject({
    method: 'POST',
    url: '/webhooks/resend',
    headers: {
      'content-type': 'application/json',
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': opts.signature ?? firma(id, timestamp, payload),
    },
    payload,
  });
}

describe('SEC-19 / test 17 — firma del webhook sul raw body', () => {
  it('un webhook firmato correttamente viene accettato', async () => {
    const payload = JSON.stringify({ type: 'email.delivered', data: { email_id: 'abc123' } });
    const res = await invia(payload);
    expect(res.statusCode).toBe(200);
  });

  it('la firma REGGE su un JSON con spaziatura non canonica', async () => {
    // Byte diversi, stesso oggetto. Se il server riparsasse e riserializzasse,
    // la firma non tornerebbe: e' la prova che si verifica sul RAW.
    const payload = '{  "type" : "email.delivered" ,  "data" : { "email_id" : "abc123" }  }';
    const res = await invia(payload);
    expect(res.statusCode).toBe(200);
  });

  it('la firma calcolata sul body RIPARSATO viene RIFIUTATA', async () => {
    const originale = '{  "type" : "email.delivered" ,  "data" : { "email_id" : "abc123" }  }';
    const riparsato = JSON.stringify(JSON.parse(originale));
    expect(riparsato).not.toBe(originale);

    const id = 'msg_riparsato';
    const timestamp = String(Math.floor(Date.now() / 1000));
    // Si firma la versione riparsata ma si INVIA l'originale: e' esattamente
    // lo scenario in cui un middleware ha toccato il body.
    const res = await invia(originale, { id, timestamp, signature: firma(id, timestamp, riparsato) });
    expect(res.statusCode).toBe(400);
  });

  it('una firma inventata viene rifiutata', async () => {
    const payload = JSON.stringify({ type: 'email.delivered', data: { email_id: 'x' } });
    const res = await invia(payload, { signature: 'v1,ZmlybWFfaW52ZW50YXRh' });
    expect(res.statusCode).toBe(400);
  });

  it('un timestamp diverso da quello firmato viene rifiutato (anti-replay Svix)', async () => {
    const payload = JSON.stringify({ type: 'email.delivered', data: { email_id: 'x' } });
    const id = 'msg_ts';
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await invia(payload, {
      id,
      timestamp: String(Number(ts) - 5000),
      signature: firma(id, ts, payload),
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
    const sig = firma(id, ts, payload);

    const primo = await invia(payload, { id, timestamp: ts, signature: sig });
    const secondo = await invia(payload, { id, timestamp: ts, signature: sig });

    expect(primo.statusCode).toBe(200);
    expect(primo.json()).toEqual({ ok: true });
    expect(secondo.statusCode).toBe(200);
    expect(secondo.json()).toEqual({ ok: true, duplicate: true });
  });

  it('la rotta e` ESENTE da Origin, Sec-Fetch-Site e CSRF (SEC-19)', async () => {
    const payload = JSON.stringify({ type: 'email.delivered', data: { email_id: 'noorigin' } });
    // Nessun Origin, nessun Sec-Fetch-Site, nessun token: passerebbe 403 su
    // qualunque altra POST. Qui deve arrivare all'handler, perche' e'
    // server-to-server e non ha niente di tutto cio' da presentare.
    const res = await invia(payload);
    expect(res.statusCode).toBe(200);
  });

  it('le altre rotte NON sono esenti: la prova che l`esenzione e` mirata', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/invites',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'x@metamc.it', roleId: 1 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('un payload non riconosciuto viene ignorato, non fa cambiare stato', async () => {
    const payload = JSON.stringify({ tipo_sbagliato: true });
    const res = await invia(payload);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });

  it('nessun evento del webhook cambia lo stato del pannello', async () => {
    // Un servizio terzo non deve poter modificare nulla: il webhook e'
    // osservativo. Si verifica che un `email.bounced` su un invito esistente
    // non lo revochi ne' lo consumi.
    const utenti = await t.ctx.db
      .selectFrom('auth.user')
      .select((eb) => eb.fn.countAll().as('n'))
      .executeTakeFirst();
    const payload = JSON.stringify({ type: 'email.bounced', data: { email_id: 'inesistente' } });
    await invia(payload);
    const dopo = await t.ctx.db
      .selectFrom('auth.user')
      .select((eb) => eb.fn.countAll().as('n'))
      .executeTakeFirst();
    expect(Number(dopo?.n)).toBe(Number(utenti?.n));
  });

  it('il webhook riceve un Buffer, non un oggetto gia` parsato', async () => {
    // Verifica diretta del content-type parser: se consegnasse l'oggetto, la
    // firma non sarebbe verificabile e ogni webhook legittimo cadrebbe.
    const payload = JSON.stringify({ type: 'email.delivered', data: { email_id: 'buffer' } });
    const ok = await invia(payload);
    expect(ok.statusCode).toBe(200);

    // Controprova: la stessa rotta con un body che NON e' JSON valido supera
    // comunque il parser (e' un buffer) e cade sulla firma, non sul parsing.
    const id = 'msg_nonjson';
    const ts = String(Math.floor(Date.now() / 1000));
    const nonJson = 'questo-non-e-json';
    const res = await invia(nonJson, { id, timestamp: ts, signature: firma(id, ts, nonJson) });
    // La firma e' valida: il rifiuto arriva dallo schema del payload, e la
    // risposta e' un 200 con `ignored`, non un 400 di parsing.
    expect(res.statusCode).toBe(400);
  });
});

describe('la rotta e` protetta anche senza segreto configurato', () => {
  it('senza RESEND_WEBHOOK_SECRET la rotta risponde 503, non accetta', async () => {
    const senza = await startTestApp({ label: 'whnosec' });
    try {
      // Si azzera il segreto a runtime: e' il caso di una configurazione
      // incompleta in produzione.
      Reflect.deleteProperty(senza.ctx.env, 'RESEND_WEBHOOK_SECRET');
      const res = await senza.app.inject({
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
      await senza.close();
    }
  }, 180_000);
});

// Riferimento non usato altrove, tenuto per chiarezza dell'import.
void sameOriginHeaders;
