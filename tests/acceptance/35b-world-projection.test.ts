// Passo 8 — la proiezione, e l'antimeridiano. §8.9.
//
// L'ANTIMERIDIANO E' IL DIFETTO CHE SI VEDE PER PRIMO. Russia e Figi hanno
// anelli i cui punti passano da +179 a -179: due gradi sul globo, la larghezza
// intera su una carta piatta. Disegnati cosi', quei due paesi diventano una
// striscia orizzontale che taglia il mondo da parte a parte — e la mappa e'
// inguardabile prima ancora di essere sbagliata.
//
// Non e' un caso di scuola: l'ho misurato su questo file di dati prima di
// scrivere il correttivo, e riguardava quattro anelli su 177 paesi.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeTopology, MAP_HEIGHT, MAP_WIDTH, pathOf, unwrap } from '#web/lib/world.ts';

const assetPath = fileURLToPath(new URL('../../web/src/assets/countries-110m.json', import.meta.url));
const shapes = decodeTopology(JSON.parse(readFileSync(assetPath, 'utf8')), 'countries');

/** Sotto questa latitudine c'e' solo l'Antartide, e non si disegna. */
const LAT_BOTTOM = -58;

describe('lo srotolamento delle longitudini', () => {
  it('un salto da +179 a -179 diventa continuo', () => {
    const ring: Array<[number, number]> = [
      [178, 60],
      [179, 61],
      [-179, 62],
      [-178, 63],
    ];
    // 181 e 182, non -179 e -178: l'anello prosegue oltre il bordo invece di
    // tornare indietro attraversando tutta la carta.
    expect(unwrap(ring).map((p) => p[0])).toEqual([178, 179, 181, 182]);
  });

  it('un anello che non attraversa niente resta identico', () => {
    const ring: Array<[number, number]> = [
      [6, 36],
      [18, 47],
      [12, 41],
    ];
    expect(unwrap(ring)).toEqual(ring);
  });
});

describe('nessuna sagoma disegnata attraversa la carta', () => {
  it('ogni anello visibile copre meno di mezza carta', () => {
    for (const shape of shapes) {
      for (const ring of shape.rings) {
        if (Math.max(...ring.map((p) => p[1])) < LAT_BOTTOM) continue;
        const lons = unwrap(ring).map((p) => p[0]);
        expect(Math.max(...lons) - Math.min(...lons), shape.name).toBeLessThan(200);
      }
    }
  });

  it("l'Antartide non finisce nemmeno nel tracciato", () => {
    const antarctica = shapes.find((s) => s.name === 'Antarctica');
    expect(antarctica).toBeDefined();
    // Il suo anello gira attorno al polo e copre tutti i 360 gradi. Fuori dal
    // riquadro sarebbe ritagliata comunque, ma sono migliaia di coordinate
    // calcolate e serializzate per non disegnare niente.
    expect(pathOf(antarctica as NonNullable<typeof antarctica>)).toBe('');
  });

  it('la Russia compare da ENTRAMBI i lati della carta', () => {
    const russia = shapes.find((s) => s.name === 'Russia');
    const d = pathOf(russia as NonNullable<typeof russia>);
    const xs = [...d.matchAll(/[ML](-?[0-9.]+),/g)].map((m) => Number(m[1]));
    // La Cukotka sta oltre l'antimeridiano: senza la copia spostata sparirebbe
    // invece di comparire a sinistra, dove sta su ogni carta del mondo.
    expect(Math.min(...xs)).toBeLessThan(0);
    expect(Math.max(...xs)).toBeGreaterThan(MAP_WIDTH);
  });
});

describe('la proiezione', () => {
  it('ha le proporzioni della sua finestra di latitudini', () => {
    expect(MAP_WIDTH).toBe(720);
    // 720 * (84 + 58) / 360
    expect(MAP_HEIGHT).toBe(284);
  });

  it("l'Italia cade dove ci si aspetta sulla carta", () => {
    const italy = shapes.find((s) => s.id === '380');
    const d = pathOf(italy as NonNullable<typeof italy>);
    const points = [...d.matchAll(/[ML](-?[0-9.]+),(-?[0-9.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    const xs = points.map((p) => p[0] as number);
    const ys = points.map((p) => p[1] as number);
    // Poco a destra del centro (long. ~12°E) e nella meta` alta (lat. ~42°N).
    expect(Math.min(...xs)).toBeGreaterThan(MAP_WIDTH * 0.5);
    expect(Math.max(...xs)).toBeLessThan(MAP_WIDTH * 0.58);
    expect(Math.min(...ys)).toBeGreaterThan(MAP_HEIGHT * 0.2);
    expect(Math.max(...ys)).toBeLessThan(MAP_HEIGHT * 0.4);
  });
});
