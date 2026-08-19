// Avatar Minecraft serviti dal nostro dominio.
//
// Perche' un proxy e non un <img> che punta al CDN delle skin: la CSP
// dichiara `img-src 'self' data:`. Allargarla a un host esterno gli
// regalerebbe l'IP di chi guarda e il nome di chi sta guardando, riga per
// riga del registro, e legherebbe il pannello alla disponibilita' di quel
// CDN. Passando dal nostro server la CSP resta chiusa.
//
// Le proprieta' che una schermata non puo' garantire da sola, ed e' il motivo
// per cui stanno qui:
//
//   1. SSRF — il nome finisce dentro una URL verso l'esterno. Se non fosse
//      validato prima, `..%2F..%2Fadmin` o un nome con `@` o `/` cambierebbe
//      l'host interrogato. La validazione deve avvenire PRIMA della rete, e
//      un nome non valido non deve produrre nessuna chiamata.
//   2. Le API di Mojang sono a quota stretta: il profilo si puo' chiedere
//      una volta al minuto. Senza cache, una pagina del registro con
//      cinquanta righe brucerebbe la quota al primo caricamento. La seconda
//      richiesta non deve uscire in rete.
//   3. Anche l'esito negativo va in cache: un nome che non esiste su Mojang
//      e' comunque una risposta, e ripeterla a ogni render costa quanto una
//      positiva.
//   4. La rotta e' autenticata. Aperta, sarebbe un proxy anonimo verso
//      Mojang ospitato a spese nostre.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loginAs, seedUser } from '#tests/support/actors.ts';
import { startTestApp, type TestApp } from '#tests/support/app.ts';

let t: TestApp;

/** Un PNG minimo valido: bastano la firma e un IHDR per distinguerlo da un corpo qualsiasi. */
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000400000004008060000008fb6ba60', 'hex');

beforeAll(async () => {
  t = await startTestApp({ label: 'avatar' });
}, 240_000);

afterAll(async () => {
  await t?.close();
});

beforeEach(() => {
  t.minecraft.reset();
});

describe('avatar Minecraft', () => {
  it('serve la skin del giocatore come PNG dal nostro dominio', async () => {
    const user = await seedUser(t, { name: 'Notch', roleKey: 'owner' });
    const actor = await loginAs(t, user);

    const res = await t.app.inject({
      method: 'GET',
      url: '/api/avatars/Notch.png',
      headers: actor.cookieOnly(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(Buffer.from(res.rawPayload).equals(PNG)).toBe(true);
  });

  it('non esce in rete una seconda volta per lo stesso nome', async () => {
    const user = await seedUser(t, { name: 'Jeb_', roleKey: 'owner' });
    const actor = await loginAs(t, user);

    await t.app.inject({ method: 'GET', url: '/api/avatars/Jeb_.png', headers: actor.cookieOnly() });
    const afterFirst = t.minecraft.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    const second = await t.app.inject({
      method: 'GET',
      url: '/api/avatars/Jeb_.png',
      headers: actor.cookieOnly(),
    });

    expect(second.statusCode).toBe(200);
    expect(t.minecraft.calls.length).toBe(afterFirst);
  });

  it('ricorda anche che un nome non esiste, invece di richiederlo ogni volta', async () => {
    const user = await seedUser(t, { name: 'Grumm', roleKey: 'owner' });
    const actor = await loginAs(t, user);
    t.minecraft.known = false;

    const first = await t.app.inject({
      method: 'GET',
      url: '/api/avatars/Sconosciuto.png',
      headers: actor.cookieOnly(),
    });
    const afterFirst = t.minecraft.calls.length;

    const second = await t.app.inject({
      method: 'GET',
      url: '/api/avatars/Sconosciuto.png',
      headers: actor.cookieOnly(),
    });

    expect(first.statusCode).toBe(404);
    expect(second.statusCode).toBe(404);
    expect(afterFirst).toBeGreaterThan(0);
    expect(t.minecraft.calls.length).toBe(afterFirst);
  });

  it('rifiuta un nome non conforme senza toccare la rete', async () => {
    const user = await seedUser(t, { name: 'Dinnerbone', roleKey: 'owner' });
    const actor = await loginAs(t, user);

    // Ognuno di questi, se finisse in una URL senza controlli, cambierebbe
    // l'host o il percorso interrogato.
    const rejected = [
      '..%2F..%2Fadmin',
      'nome con spazi',
      'a', // sotto i 3 caratteri minimi di Mojang
      'name-troppo-lungo-per-minecraft',
      'utente@altrove',
      'evil%2F..%2F',
    ];

    for (const candidate of rejected) {
      const res = await t.app.inject({
        method: 'GET',
        url: `/api/avatars/${candidate}.png`,
        headers: actor.cookieOnly(),
      });
      expect(res.statusCode, `nome rifiutato: ${candidate}`).toBe(404);
    }

    expect(t.minecraft.calls).toEqual([]);
  });

  it('senza sessione non serve niente e non chiama Mojang', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/avatars/Notch.png' });

    expect(res.statusCode).toBe(401);
    expect(t.minecraft.calls).toEqual([]);
  });

  it('scarta una texture oltre il limite di dimensione invece di inoltrarla', async () => {
    const user = await seedUser(t, { name: 'Cupquake', roleKey: 'owner' });
    const actor = await loginAs(t, user);
    t.minecraft.oversized = true;

    const res = await t.app.inject({
      method: 'GET',
      url: '/api/avatars/Cupquake.png',
      headers: actor.cookieOnly(),
    });

    expect(res.statusCode).toBe(404);
  });

  it('interroga soltanto gli host ufficiali di Mojang', async () => {
    const user = await seedUser(t, { name: 'Marc', roleKey: 'owner' });
    const actor = await loginAs(t, user);

    await t.app.inject({ method: 'GET', url: '/api/avatars/Marc.png', headers: actor.cookieOnly() });

    const hosts = [...new Set(t.minecraft.calls.map((u) => new URL(u).host))];
    expect(hosts.sort()).toEqual(
      ['api.mojang.com', 'sessionserver.mojang.com', 'textures.minecraft.net'].sort(),
    );
    expect(t.minecraft.calls.every((u) => u.startsWith('https://'))).toBe(true);
  });

  it('quando Mojang non risponde non lascia in cache un errore permanente', async () => {
    const user = await seedUser(t, { name: 'Searge', roleKey: 'owner' });
    const actor = await loginAs(t, user);
    t.minecraft.down = true;

    const whileDown = await t.app.inject({
      method: 'GET',
      url: '/api/avatars/Searge.png',
      headers: actor.cookieOnly(),
    });
    expect(whileDown.statusCode).toBe(404);

    // Tornata su, la richiesta successiva deve riprovare davvero: un guasto
    // temporaneo non puo' spegnere l'avatar per le prossime ventiquattro ore.
    t.minecraft.down = false;
    const afterRecovery = await t.app.inject({
      method: 'GET',
      url: '/api/avatars/Searge.png',
      headers: actor.cookieOnly(),
    });
    expect(afterRecovery.statusCode).toBe(200);
  });
});
