// Le tre rotte duels, dal cookie in giu'.
//
// LA COSA CHE SI PROVA QUI E' IL CONFINE, non il contenuto: il contenuto lo
// prova la 59, contro il database e senza HTTP di mezzo.
//
// DUE MODULI, E DEVONO DAVVERO ESSERE DUE. `duels` apre conteggi aggregati;
// `duels_feedback` apre nomi di giocatori e testo che hanno scritto loro. La
// migration 015 da` a `dev` il primo e non il secondo, ed e' esattamente il
// caso che rende il confine verificabile: se le rotte guardassero lo stesso
// modulo, dividerli sarebbe stato inutile e nessuno se ne accorgerebbe fino a
// una segnalazione.
//
// E il 404 al posto del payload vuoto. Una modalita' inesistente che
// rispondesse `{total: 0}` l'interfaccia la disegna come «nessuno ha votato»:
// una bugia al posto di un errore, e chi guarda non ha modo di distinguerle.

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loginAs, seedUser } from '#tests/support/actors.ts';
import { startTestApp, type TestApp } from '#tests/support/app.ts';
import { connect } from '#tests/support/postgres.ts';

let t: TestApp;
let sql: pg.Client;

beforeAll(async () => {
  t = await startTestApp({ label: 'duelsrt', statsDb: true });
  sql = await connect(t.db.migrateUrl, 'metamc-test-duelsrt-sql');

  await sql.query(
    `INSERT INTO stats.duels_mode (mode_id, name, display_name, ranking, mode_type, color)
     VALUES (1, 'classic', 'Classic', 'RANKED', 'DUEL', '#d34545')`,
  );
  await sql.query(
    `INSERT INTO stats.duels_match_hour (bucket_at, mode_id, map_id, match_type, context, matches)
     VALUES (date_trunc('hour', now() - interval '2 hours'), 1, 10, 'DUEL', 'NORMAL', 12)`,
  );
  await sql.query(
    `INSERT INTO stats.duels_rating (rating_id, created_at, match_id, player_id, player_name, mode_id, rating, comment)
     VALUES (1, now() - interval '90 minutes', gen_random_uuid(), 7, 'Vally90', 1, 5, 'bella')`,
  );
}, 300_000);

afterAll(async () => {
  await sql?.end().catch(() => undefined);
  await t?.close();
});

async function actorWith(roleKey: string) {
  const user = await seedUser(t, { roleKey });
  return loginAs(t, user);
}

async function get(url: string, headers: Record<string, string>) {
  return t.app.inject({ method: 'GET', url, headers: { ...headers, 'accept-encoding': 'identity' } });
}

describe('i due moduli sono due confini distinti', () => {
  it('«moderatore» ha tutti e due e legge tutti e due', async () => {
    const actor = await actorWith('moderatore');
    const tr = await get('/api/duels/trends?range=24h', actor.cookieOnly());
    const rt = await get('/api/duels/ratings?range=24h', actor.cookieOnly());

    expect(tr.statusCode, tr.body.slice(0, 200)).toBe(200);
    expect(rt.statusCode, rt.body.slice(0, 200)).toBe(200);
    expect(JSON.parse(tr.body).totals.matches).toBe(12);
  });

  it('«dev» vede le partite ma NON chi ha scritto cosa', async () => {
    // 015: dev ha `duels` a 1 e `duels_feedback` a 0. E` il caso che rende
    // verificabile la divisione: con un modulo solo questo test non
    // esisterebbe e nessuno saprebbe che il confine c'e`.
    const actor = await actorWith('dev');
    const tr = await get('/api/duels/trends?range=24h', actor.cookieOnly());
    const rt = await get('/api/duels/ratings?range=24h', actor.cookieOnly());
    const recent = await get('/api/duels/ratings/recent?range=24h', actor.cookieOnly());

    expect(tr.statusCode).toBe(200);
    expect(rt.statusCode, 'le valutazioni sono un altro modulo').toBe(403);
    expect(recent.statusCode).toBe(403);
  });

  it('senza sessione non si entra da nessuna parte', async () => {
    for (const url of ['/api/duels/trends', '/api/duels/ratings', '/api/duels/ratings/recent']) {
      const res = await get(url, {});
      expect(res.statusCode, url).toBe(401);
    }
  });
});

describe('un errore non si travveste da payload vuoto', () => {
  it('una modalita` fuori catalogo risponde 404', async () => {
    const actor = await actorWith('moderatore');
    const res = await get('/api/duels/ratings?range=24h&mode=999', actor.cookieOnly());

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toMatch(/modalita/);
  });

  it('una modalita` che esiste risponde 200 anche senza voti', async () => {
    // Il verso opposto: un 404 che scattasse sempre nasconderebbe le
    // modalita` vere, e il test qui sopra da solo non lo distinguerebbe.
    const actor = await actorWith('moderatore');
    const res = await get('/api/duels/ratings?range=24h&mode=1', actor.cookieOnly());
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
    expect(JSON.parse(res.body).mode).toBe(1);
  });

  it('un cursore alterato e` 400, non la prima pagina', async () => {
    const actor = await actorWith('moderatore');
    const res = await get('/api/duels/ratings/recent?range=24h&cursor=xxx', actor.cookieOnly());
    expect(res.statusCode).toBe(400);
  });

  it('un periodo inventato non passa nemmeno dallo schema', async () => {
    const actor = await actorWith('moderatore');
    const res = await get('/api/duels/trends?range=3mesi', actor.cookieOnly());
    expect(res.statusCode).toBe(400);
  });
});

describe('la cache e` dove deve essere, e dove non deve non c`e`', () => {
  it('le tendenze rispondono 304 allo stesso ETag', async () => {
    // Il 304 e` il caso NORMALE: una schermata aperta ripete la richiesta e
    // il payload cambia molto piu` di rado. Senza, ogni polling riscarica
    // tutto.
    const actor = await actorWith('moderatore');
    const primo = await get('/api/duels/trends?range=7d', actor.cookieOnly());
    const etag = primo.headers.etag as string;
    expect(etag).toBeTruthy();

    const secondo = await get('/api/duels/trends?range=7d', {
      ...actor.cookieOnly(),
      'if-none-match': etag,
    });
    expect(secondo.statusCode).toBe(304);
    expect(secondo.body).toBe('');
  });

  it('la lista NON va in cache: ricerca libera e cursore non sono enumerabili', async () => {
    const actor = await actorWith('moderatore');
    const res = await get('/api/duels/ratings/recent?range=24h', actor.cookieOnly());

    expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers.etag, 'un ETag qui prometterebbe una stabilita` che non c`e`').toBeUndefined();
    expect(JSON.parse(res.body).rows).toHaveLength(1);
  });
});

describe('senza il ruolo di lettura si dice cosa manca', () => {
  it('risponde 503 con il dettaglio, non 404 e non un payload vuoto', async () => {
    // Un 404 manderebbe a cercare un errore di instradamento che non c'e`;
    // un payload vuoto verrebbe disegnato come «nessuna partita».
    const senza = await startTestApp({ label: 'duelsno' });
    try {
      const user = await seedUser(senza, { roleKey: 'moderatore' });
      const actor = await loginAs(senza, user);
      const res = await senza.app.inject({
        method: 'GET',
        url: '/api/duels/trends?range=24h',
        headers: actor.cookieOnly(),
      });

      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body).detail).toMatch(/DATABASE_STATS_URL/);
    } finally {
      await senza.close();
    }
  }, 300_000);
});
