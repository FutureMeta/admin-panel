// OGGI C'E', su ogni grafico e su ogni periodo.
//
// IL DIFETTO. Su tutti i periodi piu' lunghi del 24h la finestra finiva alla
// mezzanotte PASSATA: il giorno in corso restava fuori per intero. Sul 7g, sul
// 30g e sul 90g — che hanno bucket sotto la giornata — il grafico si fermava
// alle 23:00 di IERI. Sul 24h no, perche' quella finestra scorre con
// l'orologio, ed e' per questo che sembrava un difetto di un range solo.
//
// Non produceva nessun errore: produceva un grafico corretto per una domanda
// che nessuno aveva fatto («gli ultimi 7 giorni COMPIUTI»), e la differenza si
// notava solo confrontando due periodi fra loro.
//
// PERCHE' UN FILE APPOSTA, E PERCHE' CON DENTRO ANCHE I DUELS. Perche' la
// regola e' UNA e vale per tutto il pannello, e l'unico modo di dire «e'
// risolto ovunque» e' avere un posto in cui «ovunque» sia scritto per esteso.
// I duels erano gia' stati corretti mesi prima con le stesse parole; nessuno
// aveva riportato la correzione sulle statistiche perche' non c'era niente che
// mettesse le due cose sulla stessa pagina. Adesso c'e'.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKysely, createPool, type Database } from '#src/db/pool.ts';
import { PgDuelsProvider } from '#src/duels/pg.ts';
import { RANGES, type Range } from '#src/stats/contract.ts';
import { buildAll, romeMidnight } from '#src/stats/read.ts';
import { createTestDatabase, type TestDatabase } from '#tests/support/postgres.ts';

let testDb: TestDatabase;
let db: Database;

/**
 * Un pomeriggio qualunque, lontano dai cambi ora e dalla mezzanotte.
 *
 * Mezzogiorno UTC sono le 14:00 a Roma d'estate: abbastanza dentro la giornata
 * perche' «oggi» abbia gia' delle ore, e abbastanza lontano da stanotte perche'
 * un errore di un bucket non passi inosservato.
 */
const NOW = new Date('2026-08-23T12:00:00Z');
const NOW_SEC = Math.floor(NOW.getTime() / 1_000);
const TODAY = Math.floor(romeMidnight(NOW).getTime() / 1_000);

beforeAll(async () => {
  testDb = await createTestDatabase('today-in-charts');
  db = createKysely(
    createPool({
      connectionString: testDb.statsUrl,
      max: 4,
      applicationName: 'metamc-test-today',
      statementTimeout: '30s',
      searchPath: 'stats, public',
    }),
  );
}, 180_000);

afterAll(async () => {
  await db?.destroy().catch(() => undefined);
  await testDb?.drop();
});

describe('le statistiche di rete: il giorno in corso e` sull`asse', () => {
  for (const range of RANGES) {
    it(`${range} arriva fino a oggi`, async () => {
      const { overview } = await buildAll(db, range, NOW, []);
      const t = overview.online.t;
      expect(t.length).toBeGreaterThan(0);

      // L'ASSERZIONE NEI TERMINI IN CUI IL DIFETTO E' STATO SEGNALATO:
      // almeno un punto cade dentro il giorno di oggi. Prima, su tutto cio'
      // che non fosse il 24h, non ce n'era nemmeno uno.
      expect(t.some((x) => x >= TODAY)).toBe(true);
    });

    it(`${range} non disegna il futuro`, async () => {
      const { overview } = await buildAll(db, range, NOW, []);
      // L'altra meta': la finestra arriva a stanotte, ma i bucket dopo adesso
      // non sono buchi — non sono ancora successi. Disegnarli come «non
      // rilevato» sarebbe una frase falsa su un pezzo di futuro.
      expect(overview.online.t.at(-1)).toBeLessThanOrEqual(NOW_SEC);
    });

    it(`${range} dichiara fin dove il dato e' definitivo`, async () => {
      const { overview } = await buildAll(db, range, NOW, []);
      const last = overview.online.t.at(-1) as number;

      if (overview.liveTail) {
        // L'ultimo punto E' il bucket in formazione: definitivo fino al suo
        // inizio, e non oltre.
        expect(overview.closedThrough).toBe(last);
      } else {
        // Nessuna coda viva: allora l'ultimo bucket e' chiuso, e il confine
        // sta oltre di lui. E' il caso del 24h, la cui finestra si ferma gia'
        // all'ultimo bucket completo.
        expect(overview.closedThrough).toBeGreaterThan(last);
      }
      expect(overview.closedThrough).toBeLessThanOrEqual(NOW_SEC);
    });
  }

  it('il 24h non e` cambiato: nessuna coda viva, si ferma all`ultimo bucket chiuso', async () => {
    // E' l'unico periodo che gia' funzionava, e questo test esiste perche'
    // continui a funzionare uguale: la sua finestra scorre con l'orologio e si
    // ferma all'ultimo bucket da cinque minuti COMPLETO.
    const { overview } = await buildAll(db, '24h', NOW, []);
    expect(overview.liveTail).toBe(false);
    expect(overview.closedThrough).toBe((overview.online.t.at(-1) as number) + 300);
  });

  it('i periodi lunghi invece hanno la coda viva, e lo dichiarano', async () => {
    for (const range of ['7d', '30d', '90d', '1y'] as Range[]) {
      const { overview } = await buildAll(db, range, NOW, []);
      expect(overview.liveTail, range).toBe(true);
    }
  });
});

describe('i KPI guardano solo i bucket chiusi', () => {
  it('la copertura non divide per una giornata che deve ancora succedere', async () => {
    // Se il denominatore arrivasse a stanotte invece che ad adesso, la
    // copertura crollerebbe di ora in ora durante la giornata e tornerebbe su
    // a mezzanotte: un dente di sega che non descrive niente di reale.
    for (const range of RANGES) {
      const { overview } = await buildAll(db, range, NOW, []);
      expect(overview.kpi.coverage, range).toBeGreaterThanOrEqual(0);
      expect(overview.kpi.coverage, range).toBeLessThanOrEqual(1);
    }
  });
});

/**
 * Quanto puo' durare al massimo un bucket, per tipo.
 *
 * Sono TETTI, non durate: un giorno civile puo' durare 23 o 25 ore e una
 * settimana altrettanto. Servono a dire «l'ultimo bucket contiene adesso»
 * senza dover ricalcolare il calendario dentro il test — che sarebbe una
 * seconda implementazione delle stesse regole, cioe' la cosa che questi test
 * esistono per non avere.
 */
const MAX_SPAN = { hour: 2 * 3_600, day: 25 * 3_600, week: 8 * 86_400 } as const;

describe('i duels: la stessa regola, gia` in vigore', () => {
  for (const range of RANGES) {
    it(`${range} arriva fino a oggi e non oltre`, async () => {
      const provider = new PgDuelsProvider(db);
      const trends = await provider.trends(range, NOW);
      expect(trends.t.length).toBeGreaterThan(0);

      const last = trends.t.at(-1) as number;
      // «OGGI C'E'» SI DICE COSI', e non «un punto cade dopo la mezzanotte di
      // oggi»: sull'1y il bucket e' la SETTIMANA, e la colonna che contiene
      // oggi porta l'etichetta di lunedi'. Con la formulazione ingenua questo
      // test falliva su un grafico corretto — il che e' esattamente il motivo
      // per cui l'invariante va scritta come «l'ultimo bucket contiene
      // adesso» e non come «c'e' un punto di oggi».
      expect(last).toBeLessThanOrEqual(NOW_SEC);
      expect(NOW_SEC - last).toBeLessThan(MAX_SPAN[trends.bucket]);
    });

    it(`${range}: anche l'andamento delle valutazioni`, async () => {
      // La stessa finestra, con una GRANA diversa: il 7g delle partite e' a
      // ore, quello delle valutazioni a giorni, perche' un centinaio di voti
      // al giorno diviso ventiquattro e' rumore disegnato come segnale. Grana
      // diversa, stessa regola — ed e' un grafico con un asse dei tempi, cioe'
      // uno dei posti in cui «ovunque» deve valere.
      const provider = new PgDuelsProvider(db);
      const ratings = await provider.ratings(range, null, NOW);
      const last = ratings.trend.t.at(-1) as number;
      expect(last).toBeLessThanOrEqual(NOW_SEC);
      // Il tetto piu' largo: qui la tabella dei bucket e' un'altra, e il test
      // non la ricopia — verifica solo che l'ultimo punto non sia vecchio di
      // piu' di una settimana, che e' il bucket piu' grosso che esista.
      expect(NOW_SEC - last).toBeLessThan(MAX_SPAN.week);
    });
  }
});
