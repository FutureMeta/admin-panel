// Passo 7 — l'aggiornamento del database geografico. §8.3.
//
// COSA SI VERIFICA, e perche' vale la pena. Un job che scarica un file e lo
// mette al posto di quello in uso ha tre modi di fare danno, e nessuno dei tre
// solleva un'eccezione al momento giusto:
//
//   * scaricare a meta' e promuovere comunque: da quel momento meta' degli
//     indirizzi risulta «non determinato», e la mappa continua a disegnarsi;
//   * fallire il primo del mese, quando il file del mese nuovo non esiste
//     ancora — cioe' esattamente quando c'e' una versione nuova da prendere;
//   * cancellare quello buono prima di avere quello nuovo.
//
// Nessuna richiesta di rete esce da questa suite: `fetch` e' iniettato.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GeoReader } from '#src/geo/reader.ts';
import { candidateUrls, updateGeoDb } from '#src/geo/updater.ts';
import { buildCountryMmdb } from '#tests/support/mmdb.ts';

const logger = pino({ level: 'silent' });

let dir: string;
let dbPath: string;

const GOOD = buildCountryMmdb([
  { network: '8.8.8.0/24', country: 'US' },
  { network: '2.196.0.0/14', country: 'IT' },
]);
/** Valido come file, ma NON e` un database di paesi: manca il canarino. */
const WRONG = buildCountryMmdb([{ network: '1.2.3.0/24', country: 'FR' }]);

function reply(body: Buffer): Response {
  return new Response(new Blob([new Uint8Array(gzipSync(body))]).stream(), { status: 200 });
}
const notFound = () => new Response(null, { status: 404 });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'metamc-geoupd-'));
  dbPath = join(dir, 'volume', 'country.mmdb');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(join(dir, 'volume'), { recursive: true, force: true });
});

describe('gli URL candidati', () => {
  it('sono il mese corrente e poi il precedente', () => {
    expect(candidateUrls(new Date('2026-08-20T10:00:00Z'))).toEqual([
      'https://download.db-ip.com/free/dbip-country-lite-2026-08.mmdb.gz',
      'https://download.db-ip.com/free/dbip-country-lite-2026-07.mmdb.gz',
    ]);
  });

  it('a gennaio il precedente e` dicembre dell`anno prima', () => {
    // Un errore qui si manifesta una volta l'anno, il 1° gennaio, e sembra
    // un guasto di rete.
    expect(candidateUrls(new Date('2026-01-01T00:01:00Z'))[1]).toBe(
      'https://download.db-ip.com/free/dbip-country-lite-2025-12.mmdb.gz',
    );
  });
});

describe('il giro di aggiornamento', () => {
  it('scarica, valida, promuove e ricarica', async () => {
    const reader = new GeoReader();
    expect(reader.ready).toBe(false);

    const result = await updateGeoDb({
      path: dbPath,
      reader,
      logger,
      now: new Date('2026-08-20T10:00:00Z'),
      fetchImpl: async () => reply(GOOD),
    });

    expect(result.downloaded).toBe(true);
    expect(result.url).toContain('2026-08');
    // La cartella del volume non esisteva: al primo avvio e` la norma.
    expect(await readFile(dbPath)).toBeTruthy();
    // E il lettore in memoria e` gia` quello nuovo: senza il ricarico, il
    // file sarebbe aggiornato e il processo continuerebbe a usare il vecchio
    // fino al riavvio.
    expect(reader.countryOf('2.196.7.107')).toBe('IT');
  });

  it('se il database in uso e` gia` di questo mese NON scarica niente', async () => {
    const reader = new GeoReader();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return reply(GOOD);
    };

    // Primo giro: scarica (buildEpoch della fixture = 1 agosto 2026).
    await updateGeoDb({ path: dbPath, reader, logger, now: new Date('2026-08-20T10:00:00Z'), fetchImpl });
    expect(calls).toBe(1);

    // Secondo giro nello stesso mese: non c`e` niente di piu` nuovo da
    // prendere. Senza questo controllo ogni riavvio del pannello scaricherebbe
    // otto megabyte per rimettere al suo posto lo stesso file.
    const again = await updateGeoDb({
      path: dbPath,
      reader,
      logger,
      now: new Date('2026-08-28T10:00:00Z'),
      fetchImpl,
    });
    expect(calls).toBe(1);
    expect(again.downloaded).toBe(false);
    expect(again.url).toBeNull();
    // E il lettore continua a rispondere: non aver scaricato non e` un guasto.
    expect(reader.countryOf('8.8.8.8')).toBe('US');
  });

  it('il mese nuovo si scarica lo stesso', async () => {
    const reader = new GeoReader();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return reply(GOOD);
    };

    await updateGeoDb({ path: dbPath, reader, logger, now: new Date('2026-08-20T10:00:00Z'), fetchImpl });
    await updateGeoDb({ path: dbPath, reader, logger, now: new Date('2026-09-02T10:00:00Z'), fetchImpl });
    expect(calls).toBe(2);
  });

  it('il 404 sul mese corrente NON e` un fallimento: si prova il precedente', async () => {
    const reader = new GeoReader();
    const asked: string[] = [];

    const result = await updateGeoDb({
      path: dbPath,
      reader,
      logger,
      now: new Date('2026-09-01T00:01:00Z'),
      fetchImpl: async (input) => {
        const url = String(input);
        asked.push(url);
        return url.includes('2026-09') ? notFound() : reply(GOOD);
      },
    });

    expect(asked).toHaveLength(2);
    expect(result.url).toContain('2026-08');
    expect(reader.ready).toBe(true);
  });

  it('un file che non e` un database di paesi non arriva a destinazione', async () => {
    const reader = new GeoReader();

    await expect(
      updateGeoDb({
        path: dbPath,
        reader,
        logger,
        now: new Date('2026-08-20T10:00:00Z'),
        fetchImpl: async () => reply(WRONG),
      }),
    ).rejects.toThrow(/non riuscito/);

    // Niente al posto di destinazione, e il lettore resta spento: meglio
    // nessun database di uno che attribuisce mezzo mondo al paese sbagliato.
    await expect(readFile(dbPath)).rejects.toThrow();
    expect(reader.ready).toBe(false);
  });

  it('un download rotto NON sostituisce il database gia` in uso', async () => {
    // Prima si mette in piedi una situazione sana.
    const reader = new GeoReader();
    await updateGeoDb({
      path: dbPath,
      reader,
      logger,
      now: new Date('2026-08-20T10:00:00Z'),
      fetchImpl: async () => reply(GOOD),
    });
    const before = await readFile(dbPath);

    // Poi arriva spazzatura.
    await expect(
      updateGeoDb({
        path: dbPath,
        reader,
        logger,
        now: new Date('2026-09-20T10:00:00Z'),
        fetchImpl: async () => reply(Buffer.from('non sono un mmdb')),
      }),
    ).rejects.toThrow();

    // Il file di destinazione e` intatto, byte per byte, e il lettore risponde
    // ancora: un database di ieri e` preferibile a nessun database.
    expect((await readFile(dbPath)).equals(before)).toBe(true);
    expect(reader.countryOf('8.8.8.8')).toBe('US');
  });

  it('la rete giu` solleva, e non lascia rifiuti in giro', async () => {
    const reader = new GeoReader();
    await expect(
      updateGeoDb({
        path: dbPath,
        reader,
        logger,
        now: new Date('2026-08-20T10:00:00Z'),
        fetchImpl: async () => {
          throw new Error('getaddrinfo ENOTFOUND');
        },
      }),
    ).rejects.toThrow(/ENOTFOUND/);

    await expect(readFile(join(dir, 'volume', '.country.mmdb.tmp'))).rejects.toThrow();
  });

  it('un file di destinazione preesistente e sbagliato viene sostituito', async () => {
    await writeFile(dbPath.replace(/country\.mmdb$/, 'x'), '', { flag: 'w' }).catch(() => undefined);
    const reader = new GeoReader();
    await updateGeoDb({
      path: dbPath,
      reader,
      logger,
      now: new Date('2026-08-20T10:00:00Z'),
      fetchImpl: async () => reply(GOOD),
    });
    await writeFile(dbPath, 'rovinato a mano');

    await updateGeoDb({
      path: dbPath,
      reader,
      logger,
      now: new Date('2026-09-20T10:00:00Z'),
      fetchImpl: async () => reply(GOOD),
    });
    expect(reader.countryOf('8.8.8.8')).toBe('US');
  });
});
