// I conti che la schermata Trends fa da sola, senza il server.
//
// SONO TRE COSE CHE UN GRAFICO PUO' SBAGLIARE SENZA SMETTERE DI DISEGNARE, e
// per questo stanno in un modulo e non dentro un componente: dentro un
// componente si verificherebbero solo aprendo la pagina e guardandola, che e'
// esattamente il modo in cui un numero plausibile e sbagliato sopravvive.
//
//  1. SOMMARE SOPRA UN BUCO. Le tab «tipo» e «contesto» filtrano in memoria e
//     sommano le combinazioni rimaste. Se la somma trattasse i `null` come
//     zeri, un periodo precedente all'inizio della raccolta diventerebbe una
//     linea a fondo scala: «non lo sappiamo» diventerebbe «non e' successo
//     niente», e non si torna piu' indietro.
//  2. NORMALIZZARE SUL NUMERO SBAGLIATO. La barra si misura sul massimo, la
//     percentuale sul totale — e il totale comprende le righe che il server ha
//     tagliato. Con il totale delle sole righe spedite le quote sommerebbero
//     al 100% di un insieme diverso da quello che la pagina dice di mostrare.
//  3. NUMERARE I PARI MERITO PER POSIZIONE. Tre modalita' con lo stesso
//     conteggio devono avere lo stesso rango.

import { describe, expect, it } from 'vitest';
import { gaps, niceScale, segments } from '#web/lib/chart.ts';
import { ALL, combineCombos, comboFilters, ranked, shareLabel, spacingOf } from '#web/lib/duels.ts';

describe('le tab sommano senza chiudere i buchi', () => {
  const combos = [
    { type: 'DUEL', context: 'NORMAL', v: [null, 2, 3] },
    { type: 'DUEL', context: 'EVENT', v: [null, 5, 0] },
    { type: 'FFA', context: 'NORMAL', v: [null, 1, 4] },
  ];

  it('senza filtri somma tutto, e il buco resta un buco', async () => {
    expect(combineCombos(combos, ALL, ALL)).toEqual([null, 8, 7]);
  });

  it('il filtro sul tipo tiene solo le sue combinazioni', async () => {
    expect(combineCombos(combos, 'DUEL', ALL)).toEqual([null, 7, 3]);
  });

  it('i due filtri insieme isolano una combinazione sola', async () => {
    expect(combineCombos(combos, 'DUEL', 'EVENT')).toEqual([null, 5, 0]);
  });

  it('uno zero e` un valore, un `null` no', async () => {
    // La distinzione che tutto il pannello difende: `0` significa «nessuna
    // partita», `null` significa «prima della raccolta». La somma non deve
    // trasformare il secondo nel primo.
    const misto = [{ type: 'DUEL', context: 'NORMAL', v: [0, null, 4] }];
    expect(combineCombos(misto, ALL, ALL)).toEqual([0, null, 4]);
  });

  it('una combinazione mista conta come dato presente', async () => {
    // Se almeno una combinazione ha un numero, il bucket un numero ce l'ha.
    const misto = [
      { type: 'DUEL', context: 'NORMAL', v: [null, 2] },
      { type: 'FFA', context: 'NORMAL', v: [7, 3] },
    ];
    expect(combineCombos(misto, ALL, ALL)).toEqual([7, 5]);
  });

  it('le tab elencano solo i valori PRESENTI nel periodo', async () => {
    // `match_type` e `context` sono testo libero all'origine: una tab per un
    // valore che il periodo non contiene mostrerebbe sempre un grafico vuoto.
    expect(comboFilters(combos)).toEqual({ types: ['DUEL', 'FFA'], contexts: ['EVENT', 'NORMAL'] });
  });
});

describe('le due normalizzazioni della stessa riga', () => {
  it('la barra si misura sul massimo, la quota sul totale', async () => {
    const rows = [{ matches: 100 }, { matches: 50 }];
    const r = ranked(rows, { n: 0, matches: 0 });

    expect(r.rows[0]?.width).toBe(100);
    expect(r.rows[1]?.width).toBe(50);
    expect(r.rows[0]?.share).toBeCloseTo(66.7, 1);
  });

  it('il totale comprende le righe TAGLIATE dal server', async () => {
    // Il taglio a venticinque righe manda il resto aggregato. Con il totale
    // delle sole righe spedite, la prima riga sembrerebbe il 100% di tutto.
    const rows = [{ matches: 100 }];
    const senza = ranked(rows, { n: 0, matches: 0 });
    const con = ranked(rows, { n: 5, matches: 300 });

    expect(senza.rows[0]?.share).toBe(100);
    expect(con.rows[0]?.share).toBe(25);
    expect(con.total).toBe(400);
  });

  it('i pari merito hanno lo STESSO rango', async () => {
    const rows = [{ matches: 400 }, { matches: 400 }, { matches: 400 }, { matches: 10 }];
    expect(ranked(rows, { n: 0, matches: 0 }).rows.map((r) => r.rank)).toEqual([1, 1, 1, 2]);
  });

  it('una classifica vuota non divide per zero', async () => {
    const r = ranked([], { n: 0, matches: 0 });
    expect(r.total).toBe(0);
    expect(r.rows).toEqual([]);
  });

  it('la quota si scrive in italiano', async () => {
    expect(shareLabel(66.666)).toBe('66,7%');
  });
});

describe('l`asse legge la griglia invece di dedurla', () => {
  it('la distanza fra due bucket la dice la griglia stessa', async () => {
    // Un mese non dura sempre lo stesso e un giorno di cambio ora dura 23 o
    // 25 ore: dedurre il passo dal nome del bucket sbaglierebbe due volte
    // l'anno, e proprio nei giorni in cui conta.
    expect(spacingOf([0, 3_600, 7_200])).toBe(3_600);
    expect(spacingOf([0, 86_400])).toBe(86_400);
    expect(spacingOf([42]), 'un punto solo non ha un passo').toBe(3_600);
  });
});

describe('le funzioni del grafico sono le stesse delle statistiche', () => {
  it('la linea si SPEZZA sul buco invece di attraversarlo', async () => {
    // E` la regola che `segments` implementa, ed e` la ragione per cui e`
    // stata estratta invece che riscritta: una seconda copia a memoria
    // unirebbe i punti, il grafico sembrerebbe piu` bello, e il buco
    // sparirebbe per sempre.
    const pezzi = segments(
      [1, 2, null, 4, 5],
      (i) => i * 10,
      (v) => v,
    );
    expect(pezzi).toHaveLength(2);
    expect(pezzi[0]).toBe('M0.0,1.0 L10.0,2.0');
    expect(pezzi[1]).toBe('M30.0,4.0 L40.0,5.0');
  });

  it('le fasce non rilevate escono come intervalli', async () => {
    expect(gaps([1, null, null, 4])).toEqual([[1, 2]]);
    expect(gaps([null, 2, 3])).toEqual([[0, 0]]);
    expect(gaps([1, 2, null])).toEqual([[2, 2]]);
  });

  it('l`asse verticale arrotonda a tacche che si sommano a mente', async () => {
    expect(niceScale(823).values).toEqual([0, 250, 500, 750, 1000]);
    expect(niceScale(0).values, 'niente asse che si ripete').toEqual([0, 1]);
  });
});
