// Quanto dura una sessione, dopo D-11.
//
// LA DECISIONE. `SESSION_IDLE_SECONDS = 0` SPEGNE il timeout di inattività;
// il tetto assoluto passa a quattordici giorni e resta l'unico limite. Il
// perché e il costo stanno per intero in D-11 di
// `docs/security/deviations.md`, e non si riassumono qui: quello che si prova
// qui è che il codice faccia quello che quel documento dichiara.
//
// PERCHÉ SERVE UN TEST. Zero è un valore di confine, e i valori di confine
// sbagliano in silenzio nella direzione peggiore. `idleMs > 0 * 1000` è vero
// per qualunque sessione più vecchia di un millisecondo: senza il ramo
// esplicito, mettere zero avrebbe buttato fuori TUTTI a ogni richiesta invece
// di non buttare fuori nessuno. È la lettura opposta dello stesso numero, e la
// si scopre solo provandola.
//
// E il tetto assoluto va provato ANCORA, proprio perché adesso è rimasto solo
// lui. Un tetto che smettesse di mordere non lo direbbe nessun sintomo: le
// sessioni durerebbero per sempre e sembrerebbe che funzioni tutto.

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loginAs, seedUser } from '#tests/support/actors.ts';
import { startTestApp, type TestApp } from '#tests/support/app.ts';

let t: TestApp;

/** Un valore che NON coincide con nessun default: 3 giorni. */
const ABSOLUTE_SECONDS = 3 * 24 * 60 * 60;

beforeAll(async () => {
  // Zero come in produzione dopo D-11, e un tetto DIVERSO sia dal default
  // della variabile (28800) sia da quello della colonna (8 ore). Con tre
  // numeri uguali non si distingue chi comanda: e' esattamente cosi' che il
  // difetto qui sotto e' rimasto nascosto per mesi.
  t = await startTestApp({ label: 'lifetime', idleSeconds: 0, absoluteSeconds: ABSOLUTE_SECONDS });
}, 180_000);

afterAll(async () => {
  await t?.close();
});

/** Sposta indietro l'ultima attività della sessione, senza toccare i tetti. */
async function ageSession(minutes: number): Promise<void> {
  await sql`
    UPDATE auth.session
       SET "updatedAt" = now() - make_interval(mins => ${minutes})
     WHERE id = (SELECT id FROM auth.session ORDER BY "createdAt" DESC LIMIT 1)
  `.execute(t.ctx.db);
}

describe('con l`inattività spenta la sessione non scade per inattività', () => {
  it('una sessione ferma da otto ore risponde ancora', async () => {
    // Con i trenta minuti di prima questa richiesta era un 401. E` la
    // situazione di ogni mattina: pannello lasciato aperto la sera.
    const user = await seedUser(t, { email: 'ferma@metamc.it' });
    const actor = await loginAs(t, user);

    await ageSession(8 * 60);

    const res = await t.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: actor.cookieOnly(),
    });
    expect(res.statusCode).toBe(200);
  });

  it('e nemmeno una ferma da dieci giorni, che e` dentro il tetto', async () => {
    const user = await seedUser(t, { email: 'lunga@metamc.it' });
    const actor = await loginAs(t, user);

    await ageSession(10 * 24 * 60);

    const res = await t.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: actor.cookieOnly(),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('il tetto assoluto viene dalla CONFIGURAZIONE, non dal database', () => {
  it('`absolute_expires_at` vale quanto SESSION_ABSOLUTE_SECONDS dice', async () => {
    // IL DIFETTO CHE QUESTO TEST ESISTE PER PRENDERE. La colonna ha un default
    // nella migration 002 — `now() + interval '8 hours'` — e per mesi e` stato
    // lui il tetto vero: la variabile governava `expiresIn` di better-auth,
    // cioe` il cookie, e non la colonna che il middleware guarda per prima.
    // Portata a quattordici giorni non spostava niente: chi entrava la sera si
    // ritrovava fuori la mattina dopo.
    //
    // La versione precedente di questo file non poteva vederlo: invecchiava
    // `updatedAt` e lasciava stare il tetto, dicendo a chiare lettere «cosi` il
    // test non dipende da quanto vale SESSION_ABSOLUTE_SECONDS». Era proprio
    // quella la dipendenza da provare.
    const user = await seedUser(t, { email: 'tetto@metamc.it' });
    await loginAs(t, user);

    const row = await t.ctx.db
      .selectFrom('auth.session')
      .select(['absolute_expires_at', 'createdAt'])
      .orderBy('createdAt', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();

    const durata = (new Date(row.absolute_expires_at).getTime() - new Date(row.createdAt).getTime()) / 1000;
    // Qualche secondo di scarto fra la INSERT e la promozione ad aal=2.
    expect(durata).toBeGreaterThan(ABSOLUTE_SECONDS - 30);
    expect(durata).toBeLessThan(ABSOLUTE_SECONDS + 30);
    // E soprattutto: NON e` il default della colonna.
    expect(durata).toBeGreaterThan(8 * 60 * 60);
  });
});

describe('il tetto assoluto e` rimasto l`unico limite, e morde', () => {
  it('oltre `absolute_expires_at` la sessione non vale piu`', async () => {
    // Non si sposta l'orologio: si sposta la COLONNA, che e` il modo in cui
    // il tetto e` scritto. Cosi` il test non dipende da quanto vale
    // SESSION_ABSOLUTE_SECONDS, e resta vero se un giorno cambia.
    const user = await seedUser(t, { email: 'scaduta@metamc.it' });
    const actor = await loginAs(t, user);

    await sql`
      UPDATE auth.session
         SET absolute_expires_at = now() - interval '1 minute'
       WHERE id = (SELECT id FROM auth.session ORDER BY "createdAt" DESC LIMIT 1)
    `.execute(t.ctx.db);

    const res = await t.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: actor.cookieOnly(),
    });
    expect(res.statusCode).toBe(401);
  });

  it('una sessione SENZA tetto non si puo` nemmeno scrivere', async () => {
    // Il middleware ha un ramo per il tetto assente — «assente non vuol dire
    // illimitato» — e a rigore non e` raggiungibile: la colonna e` NOT NULL,
    // quindi la garanzia vera sta un livello piu` sotto ed e` piu` forte di
    // un controllo applicativo. Si verifica quella, perche' e` quella su cui
    // si appoggia D-11: tolto il timeout di inattivita`, se una sessione
    // potesse esistere senza scadenza non morirebbe mai piu`.
    await seedUser(t, { email: 'senzatetto@metamc.it' }).then((u) => loginAs(t, u));

    // Si aggancia lo SQLSTATE, non il messaggio: `23502` e` «not null
    // violation» in qualunque lingua, e questo cluster risponde in italiano.
    // Un test che legge il testo dell'errore passa o fallisce a seconda del
    // `lc_messages` di chi lo esegue.
    const rifiutata = await sql`
      UPDATE auth.session
         SET absolute_expires_at = NULL
       WHERE id = (SELECT id FROM auth.session ORDER BY "createdAt" DESC LIMIT 1)
    `
      .execute(t.ctx.db)
      .then(() => null)
      .catch((err: unknown) => err);

    expect((rifiutata as { code?: string } | null)?.code).toBe('23502');
  });
});

describe('la revoca resta il rimedio, ed e` immediata', () => {
  it('`logout-all` chiude la sessione anche se il tetto e` lontano', async () => {
    // E` cio` che resta al posto del timeout di inattivita`, e D-11 dice che
    // ci si appoggia: se smettesse di funzionare, non ci sarebbe piu` NESSUN
    // modo di chiudere una sessione prima dei quattordici giorni.
    const user = await seedUser(t, { email: 'revocata@metamc.it' });
    const actor = await loginAs(t, user);

    const out = await t.app.inject({
      method: 'POST',
      url: '/api/session/logout-all',
      headers: actor.headers(),
    });
    expect(out.statusCode).toBe(200);

    const res = await t.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: actor.cookieOnly(),
    });
    expect(res.statusCode).toBe(401);
  });
});
