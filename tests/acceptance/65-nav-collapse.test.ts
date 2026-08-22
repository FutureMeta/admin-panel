// Le categorie della barra laterale si chiudono, e restano chiuse.
//
// Sono quattro righe di stato e due di loro sbagliano in silenzio.
//
// LA PRIMA. Si arriva su una schermata anche senza passare dalla barra: la
// palette con ⌘K, un link mandato a un collega, la pagina riaperta il giorno
// dopo. Se quella schermata sta in una categoria chiusa, la barra non mostra
// nessuna voce evidenziata — e l'evidenziazione è l'unica cosa che dice dove
// ci si trova. Non è un difetto che si nota provando: chi chiude una
// categoria di solito ci sta dentro, e il caso esce fuori dopo, per qualcun
// altro, in un giorno qualsiasi.
//
// LA SECONDA è l'opposto e nasce dalla correzione della prima: aprire la
// categoria corrente a ogni disegno, invece che al solo cambio di percorso,
// rende impossibile chiuderla mentre ci si sta dentro. Il clic la chiude, il
// disegno seguente la riapre, e il pulsante sembra rotto senza esserlo.

import { describe, expect, it } from 'vitest';
import {
  areaOf,
  isActive,
  openArea,
  readCollapsed,
  toggleArea,
  writeCollapsed,
} from '#web/lib/nav-collapse.ts';

/** Gli stessi gruppi della barra, nell'ordine in cui li costruisce. */
const GROUPS: Array<[string, Array<{ to: string }>]> = [
  ['Analisi', [{ to: '/panoramica' }, { to: '/dettaglio-modalita' }]],
  ['Duels', [{ to: '/duels/trends' }, { to: '/duels/ratings' }]],
  ['Amministrazione', [{ to: '/utenti' }, { to: '/registro' }]],
];

describe('chiudere e riaprire', () => {
  it('l`interruttore va in tutt`e due i versi', async () => {
    const closed = toggleArea(new Set(), 'Duels');
    expect([...closed]).toEqual(['Duels']);
    expect([...toggleArea(closed, 'Duels')]).toEqual([]);
  });

  it('non tocca l`insieme di partenza', async () => {
    // Lo stato di React si sostituisce, non si modifica: mutando l'insieme
    // ricevuto il disegno successivo potrebbe non accorgersi del cambiamento.
    const before = new Set(['Duels']);
    toggleArea(before, 'Analisi');
    expect([...before]).toEqual(['Duels']);
  });

  it('il ricordo si scrive ordinato e si rilegge uguale', async () => {
    const areas = new Set(['Duels', 'Amministrazione', 'Analisi']);
    const raw = writeCollapsed(areas);
    expect(raw).toBe('["Amministrazione","Analisi","Duels"]');
    expect([...readCollapsed(raw)].sort()).toEqual([...areas].sort());
  });
});

describe('il ricordo sopravvive a quello che ci trova dentro', () => {
  it('assente, vuoto, o scritto a mano: tutto aperto invece di rompersi', async () => {
    // `localStorage` resta fra una versione e l'altra del pannello ed è
    // scrivibile da chiunque abbia la console aperta. Lo stato di ripiego è
    // quello in cui si vede TUTTO: una barra che non disegna le voci per un
    // valore vecchio sarebbe un pannello inutilizzabile e senza spiegazione.
    expect([...readCollapsed(null)]).toEqual([]);
    expect([...readCollapsed('')]).toEqual([]);
    expect([...readCollapsed('non è json')]).toEqual([]);
    expect([...readCollapsed('{"Duels":true}')]).toEqual([]);
    expect([...readCollapsed('42')]).toEqual([]);
  });

  it('un elenco misto tiene solo le stringhe', async () => {
    expect([...readCollapsed('["Duels",7,null,"Analisi"]')]).toEqual(['Duels', 'Analisi']);
  });
});

describe('arrivare su una pagina apre la sua categoria', () => {
  it('sa quale categoria contiene la pagina aperta', async () => {
    expect(areaOf(GROUPS, '/duels/ratings')).toBe('Duels');
    expect(areaOf(GROUPS, '/panoramica')).toBe('Analisi');
    expect(areaOf(GROUPS, '/impostazioni')).toBeNull();
  });

  it('la categoria chiusa in cui si atterra si apre', async () => {
    // Il caso della palette ⌘K: senza questo la barra non evidenzia niente e
    // sembra che la navigazione abbia perso il segno.
    const after = openArea(new Set(['Duels', 'Analisi']), 'Duels');
    expect([...after].sort()).toEqual(['Analisi']);
  });

  it('le ALTRE categorie chiuse restano chiuse', async () => {
    const after = openArea(new Set(['Duels', 'Amministrazione']), 'Duels');
    expect(after.has('Amministrazione')).toBe(true);
  });

  it('su una pagina fuori dalle categorie non apre niente', async () => {
    const before = new Set(['Duels']);
    expect(openArea(before, areaOf(GROUPS, '/impostazioni'))).toBe(before);
  });

  it('se era gia` aperta restituisce lo STESSO insieme', async () => {
    // Non è un'ottimizzazione: restituire un insieme nuovo a ogni giro
    // farebbe cambiare lo stato di React a ogni disegno, e con esso
    // ripartirebbe l'effetto che scrive il ricordo — un ciclo che non si
    // ferma piu'.
    const before = new Set(['Analisi']);
    expect(openArea(before, 'Duels')).toBe(before);
  });
});

describe('chi decide se una voce e` quella corrente decide anche la categoria', () => {
  it('e` la stessa regola, o si chiude la categoria della voce evidenziata', async () => {
    // Due predicati diversi darebbero una categoria chiusa che contiene la
    // voce accesa: l'evidenziazione c'è ma non si vede, che è peggio di non
    // averla perché sembra che la barra abbia perso il segno.
    for (const [area, items] of GROUPS) {
      for (const item of items) {
        expect(isActive(item.to, item.to)).toBe(true);
        expect(areaOf(GROUPS, item.to)).toBe(area);
      }
    }
  });

  it('una sotto-pagina appartiene alla categoria della sua voce', async () => {
    expect(isActive('/duels/trends?range=7d', '/duels/trends')).toBe(true);
    expect(areaOf(GROUPS, '/dettaglio-modalita/bedwars')).toBe('Analisi');
  });
});
