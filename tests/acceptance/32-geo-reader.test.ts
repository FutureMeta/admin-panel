// Passo 7 — il lettore geografico. §8.3 e §8.4.
//
// COSA DEVE GARANTIRE, e perche' sono queste e non altre. Ogni riga qui sotto
// corrisponde a un modo preciso in cui la geolocalizzazione fa danno:
//
//   * `Reader.get()` SOLLEVA su input malformato. Un solo `ip` sporco in un
//     hash Redis farebbe fallire il ciclo di campionamento intero, e quel
//     ciclo diventerebbe uno slot `failed` — cioe' un buco nei grafici per
//     tutti, causato da un carattere di troppo in un campo che non
//     controlliamo noi;
//   * un file sbagliato promosso a database in uso attribuirebbe interi
//     blocchi al paese sbagliato, in silenzio e in modo plausibile;
//   * `split(':')[0]` su un indirizzo IPv6 lo trasforma in `XX` per sempre, e
//     `XX` e' un risultato legittimo, quindi nessuno andrebbe a cercarne la
//     causa.
//
// Il file di prova e' un `.mmdb` VERO, scritto da tests/support/mmdb.ts e
// letto da `maxmind` senza sapere che e' piccolo. Il database di DB-IP pesa
// otto megabyte e si scarica da internet: non entra in un repository e non
// puo' entrare in una suite, che deve girare senza rete.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GeoReader, ipFromAddress, UNKNOWN_COUNTRY } from '#src/geo/reader.ts';
import { buildCountryMmdb } from '#tests/support/mmdb.ts';

let dir: string;
let dbPath: string;
let geo: GeoReader;

const BUILD_EPOCH = Math.floor(Date.UTC(2026, 7, 1) / 1000);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'metamc-geo-'));
  dbPath = join(dir, 'country.mmdb');
  await writeFile(
    dbPath,
    buildCountryMmdb(
      [
        // Il canarino: un database di paesi DEVE saperlo.
        { network: '8.8.8.0/24', country: 'US' },
        // La rete mobile italiana del campione della sonda.
        { network: '2.196.0.0/14', country: 'IT' },
        { network: '5.5.5.0/24', country: 'DE', registeredOnly: true },
      ],
      { buildEpoch: BUILD_EPOCH },
    ),
  );
  geo = new GeoReader();
  await geo.load(dbPath);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('il lettore risolve', () => {
  it('un indirizzo noto diventa il suo paese', () => {
    expect(geo.countryOf('8.8.8.8')).toBe('US');
    // 2.196.7.107 e` l'indirizzo uscito dalla sonda del passo 0.
    expect(geo.countryOf('2.196.7.107')).toBe('IT');
  });

  it('ricade su registered_country quando country non c`e`', () => {
    // Il database vero ha righe cosi`. Senza il ripiego, quei giocatori
    // sarebbero `XX` per sempre, e il secchiello dei non determinati
    // crescerebbe senza che nessuno sappia perche`.
    expect(geo.countryOf('5.5.5.5')).toBe('DE');
  });

  it('un indirizzo che il database non conosce e` XX, non un errore', () => {
    expect(geo.countryOf('1.1.1.1')).toBe(UNKNOWN_COUNTRY);
  });
});

describe('il lookup non lancia MAI', () => {
  const dirty = [
    'non-un-indirizzo',
    '999.999.999.999',
    '8.8.8.8; DROP TABLE',
    '',
    '   ',
    '::ffff:8.8.8.8junk',
    '8.8.8',
    'localhost',
    '2001:db8::/32',
  ];

  it('qualunque schifezza restituisce XX invece di sollevare', () => {
    for (const bad of dirty) {
      // Il costo di sbagliare qui e` un ciclo di campionamento intero, cioe`
      // un buco nei grafici per tutti.
      expect(() => geo.countryOf(bad), `input ${JSON.stringify(bad)}`).not.toThrow();
      expect(geo.countryOf(bad), `input ${JSON.stringify(bad)}`).toBe(UNKNOWN_COUNTRY);
    }
  });

  it('undefined e un lettore spento danno XX', () => {
    expect(geo.countryOf(undefined)).toBe(UNKNOWN_COUNTRY);
    const off = new GeoReader();
    expect(off.ready).toBe(false);
    expect(off.countryOf('8.8.8.8')).toBe(UNKNOWN_COUNTRY);
  });

  it('gli indirizzi che non sono di nessuno sono XX per definizione', () => {
    for (const reserved of [
      '10.0.0.1',
      '192.168.1.1',
      '172.16.0.1',
      '172.31.255.255',
      '127.0.0.1',
      '169.254.1.1',
      '100.64.0.1', // CGNAT
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      'fe80::1',
      'fd00::1',
    ]) {
      expect(geo.countryOf(reserved), reserved).toBe(UNKNOWN_COUNTRY);
    }
  });

  it('un indirizzo pubblico vicino a un blocco privato NON viene scartato', () => {
    // Il confine conta: `172.32.0.0` e` pubblico, `172.31.x` no. Una guardia
    // scritta con `startsWith('172.')` butterebbe via mezzo internet.
    expect(geo.countryOf('172.32.0.1')).toBe(UNKNOWN_COUNTRY); // non nel db, ma NON scartato a priori
    expect(geo.countryOf('8.8.8.8')).toBe('US');
    expect(geo.countryOf('2.196.7.107')).toBe('IT');
  });
});

describe("l'indirizzo si estrae senza rompere l'IPv6", () => {
  it('host:porta perde la porta', () => {
    expect(ipFromAddress('2.196.7.107:25565')).toBe('2.196.7.107');
    expect(ipFromAddress('2.196.7.107')).toBe('2.196.7.107');
  });

  it('un IPv6 fra parentesi quadre perde le parentesi e la porta', () => {
    expect(ipFromAddress('[2001:db8::1]:25565')).toBe('2001:db8::1');
  });

  it('un IPv6 NUDO resta intero', () => {
    // MAI `split(':')[0]`: darebbe `2001`, cioe` `XX` per sempre — e in
    // silenzio, perche` `XX` e` un risultato legittimo.
    expect(ipFromAddress('2001:db8::1')).toBe('2001:db8::1');
    expect(ipFromAddress('::1')).toBe('::1');
  });

  it('vuoto e assente danno undefined', () => {
    expect(ipFromAddress(undefined)).toBeUndefined();
    expect(ipFromAddress('')).toBeUndefined();
    expect(ipFromAddress('   ')).toBeUndefined();
  });
});

describe('il file si valida PRIMA di promuoverlo', () => {
  it('un database che non sa dove sta 8.8.8.8 viene rifiutato', async () => {
    const wrongCountryDb = join(dir, 'wrong-country.mmdb');
    await writeFile(wrongCountryDb, buildCountryMmdb([{ network: '1.2.3.0/24', country: 'FR' }]));

    const reader = new GeoReader();
    await expect(reader.load(wrongCountryDb)).rejects.toThrow(/non e' un database di paesi valido/);
    expect(reader.ready).toBe(false);
  });

  it('un file corrotto non sostituisce quello buono', async () => {
    const corrupt = join(dir, 'corrupt.mmdb');
    await writeFile(corrupt, Buffer.from('questo non e` un mmdb'));

    // Il lettore gia` carico deve restare carico: un database di ieri e`
    // preferibile a nessun database, e molto preferibile a uno sbagliato.
    await expect(geo.load(corrupt)).rejects.toThrow();
    expect(geo.ready).toBe(true);
    expect(geo.countryOf('8.8.8.8')).toBe('US');
  });
});

describe('spenta e non risolta sono due cose diverse', () => {
  it('un lettore mai caricato non deve poter dire XX al posto di «spenta»', () => {
    const off = new GeoReader();
    // Il lettore da solo risponde XX, e per lui e` corretto: e` chi lo usa a
    // dover distinguere. Il campionamento passa null finche` `ready` e` falso,
    // cosi` un giocatore entrato prima che il file venisse scaricato non
    // risulta «non determinato» per sempre — e la mappa compare quando i dati
    // ci sono, invece di mostrare una barra XX enorme.
    expect(off.ready).toBe(false);
    expect(off.countryOf('8.8.8.8')).toBe(UNKNOWN_COUNTRY);

    const lookup = (value: string | undefined) => (off.ready ? off.countryOf(value) : null);
    expect(lookup('8.8.8.8')).toBeNull();
  });

  it('a lettore caricato lo stesso ripiego restituisce il paese', () => {
    const lookup = (value: string | undefined) => (geo.ready ? geo.countryOf(value) : null);
    expect(lookup('8.8.8.8')).toBe('US');
    // Acceso ma non risolto: XX, che e` un dato e non un errore.
    expect(lookup('1.1.1.1')).toBe(UNKNOWN_COUNTRY);
  });
});

describe("l'eta` del database e` sorvegliata", () => {
  it('i giorni si contano dalla compilazione, non dal download', () => {
    const status = geo.status(new Date((BUILD_EPOCH + 46 * 86_400) * 1000));
    expect(status.ready).toBe(true);
    expect(status.buildEpoch?.getTime()).toBe(BUILD_EPOCH * 1000);
    // Oltre 45 giorni e` allarme: un database che invecchia senza che nessuno
    // se ne accorga riassegna interi blocchi al paese sbagliato.
    expect(status.ageDays).toBe(46);
  });

  it('senza database non c`e` eta`, e non c`e` zero', () => {
    const off = new GeoReader();
    const status = off.status();
    // `null` e non `0`: zero giorni vorrebbe dire «appena aggiornato», che e`
    // il contrario di «non ce n'e` nessuno».
    expect(status.ageDays).toBeNull();
    expect(status.ready).toBe(false);
  });
});
