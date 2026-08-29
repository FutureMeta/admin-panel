// Il contratto fra il pannello e il plugin, che vivono in due repository.
//
// PERCHE' QUESTO TEST ESISTE. La rotta del bundle e' l'unico punto in cui il
// pannello parla con qualcosa che non e' il proprio frontend, e dall'altra
// parte c'e' del Java che sta in un altro repository e che nessun compilatore
// controlla insieme a questo. Se un giorno qualcuno rinominasse `files` in
// `entries`, qui non fallirebbe niente: fallirebbero i server, all'avvio, tutti
// insieme.
//
// Quindi qui si fissa la FORMA della risposta, campo per campo, con i nomi
// esatti che `PanelConfigs.Bundle` si aspetta di leggere.
//
// E si fissano le tre risposte che non sono un bundle, perche' il plugin si
// comporta diversamente su ognuna:
//
//   401  token sbagliato o assente → il plugin ripiega sulla cache
//   304  niente e' cambiato        → il plugin riscrive dalla cache, gratis
//   503  funzione non configurata  → il plugin resta ai default del jar

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConfigPath, publishConfigDrafts, saveConfigDraft } from '#src/duels/config-store.ts';
import { startTestApp, type TestApp } from '#tests/support/app.ts';

const TOKEN = 'token-di-prova-lungo-abbastanza-1234';

let t: TestApp;

beforeAll(async () => {
  t = await startTestApp({ label: 'duels-bundle', duelsConfigToken: TOKEN });

  await createConfigPath(t.ctx.db, {
    path: 'inventories/event/tnt_run.yml',
    modules: ['lobby', 'ffa'],
    author: 'import@metamc.it',
  });
}, 240_000);

afterAll(async () => {
  await t?.close();
});

/** L'id della versione di quel percorso. Ce n'e' una sola, in questa suite. */
async function versionIdOf(path: string): Promise<number> {
  const found = await sql<{ id: number }>`
    SELECT v.id FROM stats.duels_config_version v
      JOIN stats.duels_config_path p ON p.id = v.path_id
     WHERE p.path = ${path}
  `.execute(t.ctx.db);
  return found.rows[0]?.id as number;
}

/** Il bundle come lo chiede un server: token nell'intestazione, modulo in query. */
function bundle(module: string, headers: Record<string, string> = {}) {
  return t.app.inject({
    method: 'GET',
    url: `/api/duels/config/bundle?module=${module}`,
    headers: { 'x-duels-token': TOKEN, ...headers },
  });
}

describe('senza il token non si passa, e il rifiuto non spiega niente', () => {
  it('senza intestazione e` 401', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/duels/config/bundle?module=lobby' });
    expect(res.statusCode).toBe(401);
  });

  it('con il token sbagliato e` 401, e il corpo non dice quale dei due manchi', async () => {
    // Un messaggio che distinguesse «token assente» da «token sbagliato»
    // sarebbe un aiuto a chi prova a indovinarlo.
    const res = await bundle('lobby', { 'x-duels-token': 'sbagliato-ma-lungo-uguale-12345678' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'non autorizzato' });
  });

  it('e nessuna sessione del pannello apre questa rotta', async () => {
    // La rotta e' per le macchine: un cookie valido non deve bastare, o il
    // confine fra i due pubblici sarebbe solo un'intenzione.
    const res = await t.app.inject({ method: 'GET', url: '/api/duels/config/bundle?module=lobby' });
    expect(res.statusCode).toBe(401);
  });
});

describe('la forma della risposta e` quella che il plugin legge', () => {
  it('modulo, versione e file con percorso e contenuto', async () => {
    const versionId = await versionIdOf('inventories/event/tnt_run.yml');

    await saveConfigDraft(t.ctx.db, {
      versionId,
      content: 'title: TNT Run\nrows: 5\n',
      author: 'vally90@metamc.it',
    });
    await publishConfigDrafts(t.ctx.db, 'vally90@metamc.it');

    const res = await bundle('lobby');
    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      module: string;
      version: string;
      files: Array<{ path: string; content: string }>;
    };

    // I NOMI, uno per uno. Sono quelli che `PanelConfigs.Bundle` dichiara come
    // campi, e Gson li lega per nome: rinominarne uno qui vuol dire un `null`
    // silenzioso in Java, non un errore.
    expect(Object.keys(body).sort()).toEqual(['files', 'module', 'version']);
    expect(body.module).toBe('lobby');
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);

    const file = body.files.find((f) => f.path === 'inventories/event/tnt_run.yml');
    expect(Object.keys(file ?? {}).sort()).toEqual(['content', 'path']);
    expect(file?.content).toBe('title: TNT Run\nrows: 5\n');
  });

  it('e i percorsi sono relativi, con le barre in avanti', async () => {
    // Il plugin li risolve dentro la propria cartella dati e rifiuta tutto
    // quello che ne uscirebbe. Un percorso assoluto o con le barre rovesciate
    // verrebbe scartato dal suo lato, e il file semplicemente non arriverebbe.
    const res = await bundle('lobby');
    const body = res.json() as { files: Array<{ path: string }> };
    for (const f of body.files) {
      expect(f.path.startsWith('/')).toBe(false);
      expect(f.path).not.toContain('\\');
      expect(f.path).not.toContain('..');
      expect(f.path.endsWith('.yml')).toBe(true);
    }
  });

  it('un modulo non legato riceve un elenco vuoto, non un errore', async () => {
    const res = await bundle('setup');
    expect(res.statusCode).toBe(200);
    expect((res.json() as { files: unknown[] }).files).toEqual([]);
  });

  it('un modulo che non esiste e` 400, non un bundle vuoto', async () => {
    // La differenza conta: un elenco vuoto vorrebbe dire «questo modulo non ha
    // file», e un modulo scritto male passerebbe per un modulo senza file.
    const res = await bundle('lobbi');
    expect(res.statusCode).toBe(400);
  });
});

describe('l`ETag risparmia il trasferimento, e non mente', () => {
  it('con la stessa impronta risponde 304 e nessun corpo', async () => {
    const first = await bundle('lobby');
    const etag = first.headers.etag as string;
    expect(etag).toBeTruthy();

    const second = await bundle('lobby', { 'if-none-match': etag });
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe('');
  });

  it('e cambia appena cambia un file', async () => {
    const before = (await bundle('lobby')).headers.etag as string;

    const versionId = await versionIdOf('inventories/event/tnt_run.yml');

    await saveConfigDraft(t.ctx.db, {
      versionId,
      content: 'title: TNT Run\nrows: 6\n',
      author: 'matty@metamc.it',
    });
    await publishConfigDrafts(t.ctx.db, 'matty@metamc.it');

    const after = (await bundle('lobby')).headers.etag as string;
    // Se questa non cambiasse, ogni server risponderebbe al proprio 304 e
    // resterebbe alla versione vecchia per sempre, senza un errore da nessuna
    // parte.
    expect(after).not.toBe(before);
  });
});

describe('senza il token configurato la funzione e` spenta, non rotta', () => {
  it('risponde 503 e lo dice', async () => {
    const other = await startTestApp({ label: 'duels-bundle-off' });
    try {
      const res = await other.app.inject({
        method: 'GET',
        url: '/api/duels/config/bundle?module=lobby',
        headers: { 'x-duels-token': TOKEN },
      });
      // 503 e non 401: il token non e' sbagliato, e' che questa installazione
      // non ha acceso la funzione. Il plugin resta ai default del jar, ed e'
      // il comportamento giusto.
      expect(res.statusCode).toBe(503);
      expect((res.json() as { error: string }).error).toBe('non disponibile');
    } finally {
      await other.close();
    }
  }, 240_000);
});
