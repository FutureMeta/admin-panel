// Lo spicchio della ciambella, e il caso che la faceva sparire.
//
// IL DIFETTO. Un arco SVG e' definito dai suoi due estremi. A 360 gradi
// l'estremo di arrivo E' quello di partenza, e la specifica dice che un arco
// con estremi coincidenti si OMETTE: non degenera in un punto, sparisce. Una
// modalita' sola — o una modalita' con un server solo, nel dettaglio — dava
// quindi un riquadro con il titolo, il numero al centro e nessun anello
// intorno.
//
// PERCHE' NON SI VEDEVA. Il caso capita solo quando le fette sono UNA, cioe'
// sulla rete piu' semplice che esista: una modalita' sola, oppure un dettaglio
// con un server solo. Chi sviluppa ha quasi sempre due o tre modalita' in
// tavola, e li' il disegno e' giusto.
//
// QUESTO TEST NON GUARDA LA STRINGA, guarda la proprieta' che la rendeva
// invisibile: nessun comando `A` deve arrivare dove e' partito. Un test
// sull'output letterale passerebbe anche riscrivendo il difetto in un'altra
// forma.

import { describe, expect, it } from 'vitest';
import { arc } from '#web/lib/donut.ts';

type Point = { x: number; y: number };

/**
 * Gli archi del tracciato, come coppie (da dove parte, dove arriva).
 *
 * Il tracciato usa solo `M`, `A`, `L` e `Z` e numeri separati da virgola o
 * spazio: basta camminarlo tenendo il punto corrente.
 */
function arcsOf(d: string): Array<{ from: Point; to: Point }> {
  const out: Array<{ from: Point; to: Point }> = [];
  let at: Point = { x: 0, y: 0 };

  for (const token of d.trim().split(/(?=[MALZ])/)) {
    const kind = token[0];
    const nums = (token.slice(1).match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);

    if (kind === 'M' || kind === 'L') {
      at = { x: nums[0] as number, y: nums[1] as number };
    } else if (kind === 'A') {
      // rx ry rotazione large sweep x y
      const to = { x: nums[5] as number, y: nums[6] as number };
      out.push({ from: at, to });
      at = to;
    }
  }
  return out;
}

/** Due punti che l'SVG considererebbe lo stesso punto. */
function same(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
}

const START = -Math.PI / 2;

describe('lo spicchio della ciambella si disegna sempre', () => {
  it('la fetta unica produce un anello, non il nulla', () => {
    // E` il caso rotto: `to - from` vale esattamente 2 pi greco.
    const d = arc(90, 90, 84, 58, START, START + Math.PI * 2);

    expect(d.length).toBeGreaterThan(0);
    for (const a of arcsOf(d)) {
      expect(same(a.from, a.to), `arco da ${a.from.x},${a.from.y} a se stesso`).toBe(false);
    }
  });

  it('e resta un ANELLO: due contorni, non un disco pieno', () => {
    // Il foro nasce dal verso opposto del bordo interno. Con un contorno solo
    // il centro sarebbe pieno e il numero dentro illeggibile — un difetto
    // diverso, e altrettanto silenzioso.
    const d = arc(90, 90, 84, 58, START, START + Math.PI * 2);
    const contorni = (d.match(/M/g) ?? []).length;

    expect(contorni).toBe(2);
    expect(d).toContain('A84,84');
    expect(d).toContain('A58,58');
  });

  it('nessuna ampiezza fa sparire un arco, dal quasi niente al giro intero', () => {
    // Le frazioni sono quelle vere: due fette uguali, tre, sei server, e la
    // fetta sottile di una modalita` quasi vuota.
    const frazioni = [0.001, 0.1, 1 / 6, 0.25, 1 / 3, 0.5, 2 / 3, 0.75, 0.999, 1];

    for (const f of frazioni) {
      const d = arc(90, 90, 84, 58, START, START + f * Math.PI * 2);
      const archi = arcsOf(d);
      expect(archi.length, `frazione ${f}`).toBeGreaterThan(0);
      for (const a of archi) {
        expect(same(a.from, a.to), `frazione ${f}: arco da ${a.from.x},${a.from.y} a se stesso`).toBe(false);
      }
    }
  });

  it('le fette parziali restano UN contorno solo', () => {
    // La correzione riguarda il giro intero e nient'altro: se prendesse anche
    // le fette normali, ognuna diventerebbe un anello completo sovrapposto
    // agli altri, cioe` una torta di un colore solo.
    for (const f of [0.25, 0.5, 0.75]) {
      const d = arc(90, 90, 84, 58, START, START + f * Math.PI * 2);
      expect((d.match(/M/g) ?? []).length, `frazione ${f}`).toBe(1);
    }
  });

  it('l`arco lungo si dichiara tale oltre il mezzo giro', () => {
    // `large-arc` sbagliato non fa sparire niente: disegna il COMPLEMENTO,
    // cioe` una fetta del 70% che ne mostra il 30. Plausibile, e falso.
    const piccola = arc(90, 90, 84, 58, START, START + Math.PI * 0.5);
    const grande = arc(90, 90, 84, 58, START, START + Math.PI * 1.5);

    expect(piccola).toContain('A84,84 0 0 1');
    expect(grande).toContain('A84,84 0 1 1');
  });
});
