// Le schermate del pannello, e i quattro posti che devono nominarle tutte.
//
// TRE VOLTE LO STESSO DIFETTO. Le stesse schermate erano elencate a mano in
// quattro punti — barra laterale, breadcrumb, palette ⌘K, selettore del
// periodo — e ogni elenco si è dimenticato qualcosa:
//
//   1. il breadcrumb aveva due `startsWith` e poi «Console» per tutto il
//      resto, quindi ogni schermata aggiunta dopo scriveva «Console › Console»;
//   2. il periodo era un elenco di ESCLUSIONI, quindi Modes e Maps sono nate
//      con sopra un selettore che lì non governa niente;
//   3. la palette non nominava la Panoramica network e il Dettaglio modalità,
//      che esistono da mesi.
//
// Nessuno dei tre produce un errore, e nessuno dei tre si nota lavorando: sono
// tutti «una schermata che c'è e da qualche parte non compare». Adesso la
// tabella è una sola e questi test la tengono coerente.

import { describe, expect, it } from 'vitest';
import { MODULE_KEYS } from '#web/lib/modules.ts';
import { entryOf, hasPeriod, NAV, titleOf } from '#web/lib/nav.ts';

describe('la tabella delle schermate sta in piedi da sola', () => {
  it('ogni voce ha percorso, titolo ed etichetta', async () => {
    // Un titolo vuoto non rompe niente: la barra in alto scrive una riga
    // vuota, e sembra un caricamento che non finisce.
    const monche = NAV.filter((n) => !n.to || !n.title || !n.label);
    expect(monche).toEqual([]);
  });

  it('nessun percorso doppio', async () => {
    // Due voci sullo stesso percorso vorrebbero dire due comandi identici
    // nella palette e un breadcrumb che dipende dall'ordine dell'elenco.
    expect(new Set(NAV.map((n) => n.to)).size).toBe(NAV.length);
  });

  it('ogni percorso comincia con una barra', async () => {
    expect(NAV.filter((n) => !n.to.startsWith('/'))).toEqual([]);
  });

  it('ogni voce nomina moduli che esistono davvero', async () => {
    // Un modulo scritto male non fa comparire la voce a nessuno, e non lo
    // dice: `modules.some(...)` è falso per tutti e la schermata sparisce dal
    // menu restando raggiungibile per URL.
    const fantasmi = NAV.flatMap((n) =>
      n.modules.filter((m) => !(MODULE_KEYS as readonly string[]).includes(m)).map((m) => `${n.to}: ${m}`),
    );
    expect(fantasmi).toEqual([]);
  });
});

describe('il titolo della barra in alto', () => {
  it('ogni schermata ha il suo, e nessuna cade nel ripiego', async () => {
    // È il difetto numero 1: «Console › Console» compariva perché il ripiego
    // copriva il caso normale. Un ripiego che copre il caso normale non è un
    // ripiego, è l'unico comportamento.
    for (const entry of NAV) {
      expect(titleOf(entry.to), entry.to).toBe(entry.title);
      expect(titleOf(entry.to), entry.to).not.toBe('Console');
    }
  });

  it('vale anche per una sotto-pagina', async () => {
    expect(titleOf('/dettaglio-modalita/bedwars')).toBe('Dettaglio modalità');
    expect(titleOf('/duels/trends?range=7d')).toBe('Duels · Trends');
  });

  it('e «Console» resta per cio` che non e` una schermata', async () => {
    expect(titleOf('/')).toBe('Console');
    expect(titleOf('/qualcosa-che-non-esiste')).toBe('Console');
  });

  it('fra due percorsi annidati vince il piu` lungo', async () => {
    // Non è il caso di oggi, ma il giorno che una voce sta sotto un'altra la
    // più corta vincerebbe sempre, e la schermata figlia scriverebbe il nome
    // della madre.
    expect(entryOf('/duels/trends')?.to).toBe('/duels/trends');
  });
});

describe('il selettore del periodo', () => {
  it('c`e` sulle schermate che hanno un periodo', async () => {
    expect(hasPeriod('/panoramica')).toBe(true);
    expect(hasPeriod('/dettaglio-modalita')).toBe(true);
    expect(hasPeriod('/duels/trends')).toBe(true);
    expect(hasPeriod('/duels/ratings')).toBe(true);
  });

  it('e NON c`e` dove non governa niente', async () => {
    // È il difetto numero 2. Un comando che non fa niente si prova una volta
    // e poi non ci si fida più nemmeno dove funziona.
    expect(hasPeriod('/duels/modes')).toBe(false);
    expect(hasPeriod('/duels/maps')).toBe(false);
    expect(hasPeriod('/utenti')).toBe(false);
    expect(hasPeriod('/registro')).toBe(false);
  });

  it('e nemmeno su una pagina che la tabella non conosce', async () => {
    expect(hasPeriod('/')).toBe(false);
  });
});

describe('la palette nomina tutte le schermate', () => {
  it('ogni voce ha un suggerimento', async () => {
    // È il difetto numero 3, preso dall'altro lato: se una voce nuova entra
    // nella tabella senza `hint`, la palette la mostra comunque — ma questo
    // test lo dice, perché la riga sotto il nome è ciò che distingue due
    // comandi che si somigliano.
    const senzaHint = NAV.filter((n) => !n.hint).map((n) => n.to);
    expect(senzaHint).toEqual([]);
  });

  it('la Panoramica network e il Dettaglio modalita` ci sono', async () => {
    // I due che mancavano. Il test li nomina per nome perché è la loro
    // assenza ad aver mostrato che l'elenco era tenuto a mano.
    const percorsi = NAV.map((n) => n.to);
    expect(percorsi).toContain('/panoramica');
    expect(percorsi).toContain('/dettaglio-modalita');
  });
});
