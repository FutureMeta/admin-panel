// Il colore della mappa viene dal VALORE, non dalla posizione in classifica.
//
// I DUE DIFETTI VISTI A SCHERMO, e sono opposti fra loro:
//
//   «un paese con 900 giocatori ha gli stessi colori di uno con 1200, e alcuni
//    invece con numeri molto simili hanno colori diversi»
//
// Venivano tutti e due dalla stessa riga. Il colore era `indice / (paesi - 1)`
// sulla classifica ordinata, quindi:
//
//   * due paesi vicini in classifica avevano colori vicini QUALUNQUE fosse la
//     distanza fra i loro numeri — 900 e 1.200 distavano il 2,5% della rampa
//     perche' erano secondo e primo;
//   * paesi con lo STESSO numero avevano colori diversi, perche' la classifica
//     li mette comunque in fila. Quindici paesi da due giocatori si spalmavano
//     su un terzo della scala.
//
// La seconda e' la piu' grave: inventa nei dati una differenza che non c'e'.
// I test qui sotto la rendono impossibile per costruzione — il colore e' una
// funzione del valore, e una funzione dello stesso valore da' lo stesso
// risultato — e misurano che la prima sia davvero migliorata, con i numeri
// esatti della segnalazione.

import { describe, expect, it } from 'vitest';
import { HEAT_STOPS, MAP_FLOOR, MAP_GRADIENT, mapPosition, rampColour } from '#web/lib/heat.ts';

/** Il vecchio calcolo, per confronto: la posizione in classifica. */
function byRank(value: number, all: readonly number[]): number {
  const asc = [...all].sort((a, b) => a - b);
  const i = asc.indexOf(value);
  return 0.15 + (asc.length > 1 ? i / (asc.length - 1) : 0.5) * 0.85;
}

/** Colora un intero insieme di paesi come fa il componente. */
function fillsOf(values: readonly number[]): string[] {
  const top = Math.max(...values);
  return values.map((v) => rampColour(mapPosition(v, top)));
}

describe('numeri uguali, colore uguale — sempre', () => {
  it('la coda di pari merito e` di un colore solo', () => {
    // Quindici paesi da due giocatori piu' l'Italia: il caso vero, quello che
    // a schermo si vedeva come una sfumatura. Si colora l'insieme come fa il
    // componente, e si conta quante tinte distinte escono dai pari merito.
    const pari = Array.from({ length: 15 }, () => 2);
    const colori = fillsOf([...pari, 1_200]).slice(0, 15);
    expect(new Set(colori).size).toBe(1);
  });

  it('e con la classifica erano quindici colori diversi', () => {
    // Il calcolo di prima, sugli stessi identici dati. Non e' un test del
    // codice attuale: e' la misura di cosa e' stato tolto, e senza di essa la
    // riga qui sopra non dice quanto valeva.
    const tutti = [...Array.from({ length: 15 }, () => 2), 1_200];
    const asc = [...tutti].sort((a, b) => a - b);
    const posizioni = asc.slice(0, 15).map((_, i) => 0.15 + (i / (asc.length - 1)) * 0.85);
    expect(new Set(posizioni).size).toBe(15);
    // E il primo e l'ultimo dei pari merito distavano un terzo della rampa.
    expect((posizioni.at(-1) ?? 0) - (posizioni[0] ?? 0)).toBeGreaterThan(0.3);
  });
});

describe('900 e 1.200 adesso si vedono diversi', () => {
  it('la distanza sulla rampa e` molte volte quella di prima', () => {
    const nuovo = mapPosition(1_200, 1_200) - mapPosition(900, 1_200);
    // Quaranta paesi, 900 e 1.200 primo e secondo: due posizioni adiacenti.
    const classifica = Array.from({ length: 38 }, (_, i) => i + 1).concat([900, 1_200]);
    const before = byRank(1_200, classifica) - byRank(900, classifica);
    expect(before).toBeLessThan(0.03);
    expect(nuovo).toBeGreaterThan(0.1);
    expect(nuovo / before).toBeGreaterThan(4);
  });

  it('e la scala resta monotona: piu` giocatori, piu` colore', () => {
    const valori = [1, 2, 5, 20, 100, 300, 900, 1_200];
    const posizioni = valori.map((v) => mapPosition(v, 1_200));
    expect(posizioni).toEqual([...posizioni].sort((a, b) => a - b));
    // Nessun pari merito fra valori diversi: ogni gradino e' un gradino vero.
    expect(new Set(posizioni).size).toBe(valori.length);
  });
});

describe('la coda non si schiaccia, che era il motivo della classifica', () => {
  it('i paesi piccoli occupano un pezzo di rampa, non un punto', () => {
    // E' l'obiezione che aveva fatto scegliere la classifica, ed era giusta:
    // con una scala LINEARE e l'Italia in testa, da 1 a 100 giocatori si
    // attraversa l'8% della rampa e basta.
    const lineare = 100 / 1_200 - 1 / 1_200;
    expect(lineare).toBeLessThan(0.09);

    // Con la radice, lo stesso tratto ne prende piu' del venti.
    const coda = mapPosition(100, 1_200) - mapPosition(1, 1_200);
    expect(coda).toBeGreaterThan(0.2);
  });

  it('il paese piu` piccolo resta colorato, non spento', () => {
    // Sotto la soglia la rampa incontra il proprio fondo, che e' quasi il
    // colore dei paesi senza dati: «un giocatore» e «nessun dato» sono due
    // cose diverse e devono restare due colori diversi.
    expect(mapPosition(1, 1_200)).toBeGreaterThanOrEqual(MAP_FLOOR);
  });

  it('nessun paese, nessun colore: zero non e` NaN', () => {
    expect(mapPosition(0, 0)).toBe(0);
    expect(mapPosition(5, 0)).toBe(0);
    expect(mapPosition(0, 1_200)).toBe(0);
  });

  it('il primo prende la cima della rampa, e non oltre', () => {
    expect(mapPosition(1_200, 1_200)).toBe(1);
    // Un valore fuori scala non sfonda: puo' capitare solo per un errore di
    // chiamata, e un colore fuori rampa sarebbe un colore che non esiste.
    expect(mapPosition(9_999, 1_200)).toBe(1);
  });
});

describe('la rampa e` una sola, e la legenda mostra quella', () => {
  it('la mappa e la heatmap passano dalla stessa funzione', () => {
    // La mappa aveva la sua copia della rampa, allungata a sette fermate e
    // interpolata in sRGB — dove il tratto centrale cambia tinta senza
    // cambiare chiarezza, e mezza scala si appiattisce. Adesso c'e' `oklab`.
    expect(rampColour(0)).toContain(HEAT_STOPS[0]);
    expect(rampColour(1)).toContain(HEAT_STOPS[HEAT_STOPS.length - 1]);
    expect(rampColour(0.5)).toContain('oklab');
  });

  it('la legenda parte da dove parte la carta, non da zero', () => {
    // Una legenda che mostrasse anche il fondo prometterebbe colori che sulla
    // carta non compaiono mai: e' il modo piu' educato di far sbagliare una
    // lettura.
    expect(MAP_GRADIENT).toContain(rampColour(MAP_FLOOR));
    expect(MAP_GRADIENT).toContain(rampColour(1));
    expect(MAP_GRADIENT).not.toContain(rampColour(0));
  });

  it('fuori dai bordi non si esce', () => {
    expect(rampColour(-1)).toBe(rampColour(0));
    expect(rampColour(2)).toBe(rampColour(1));
  });
});
