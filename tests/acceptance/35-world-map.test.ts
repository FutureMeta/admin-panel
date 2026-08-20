// Passo 8 — i dati congelati della mappa. §8.9.
//
// PERCHE' UN TEST SU UN FILE DI DATI. Il decodificatore TopoJSON e' sessanta
// righe scritte a mano, e sbaglia in un modo solo ma preciso: se si dimentica
// che i punti sono DIFFERENZE dal precedente, il mondo si accartoccia
// nell'angolo in alto a sinistra. Non solleva niente, disegna qualcosa, e chi
// guarda vede una macchia. Qui si verifica su geografia vera: l'Italia sta
// dove sta l'Italia.
//
// E si verifica che il file resti MINIFICATO. Il formattatore lo aveva gia'
// riportato a 182 kB una volta, in silenzio: un test che confronta i byte e'
// l'unico modo perche' quella regressione non torni al prossimo `lint:fix`.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONTENT_TYPES } from '#src/http/static-assets.ts';
import { ALPHA2_TO_NUMERIC } from '#web/lib/country-codes.ts';
import { decodeTopology } from '#web/lib/world.ts';

const assetPath = fileURLToPath(new URL('../../web/src/assets/countries-110m.json', import.meta.url));
const raw = readFileSync(assetPath, 'utf8');
const topology = JSON.parse(raw);
const shapes = decodeTopology(topology, 'countries');

describe('il file dei contorni', () => {
  it('resta minificato: una riga sola', () => {
    // Pretty-printed pesa 182 kB contro 108, per un file che nessuno legge a
    // mano. E` escluso dal formattatore apposta (biome.json).
    expect(raw.split('\n')).toHaveLength(1);
    expect(raw.length).toBeLessThan(115_000);
  });

  it('porta 177 paesi con id ISO numerico', () => {
    expect(shapes).toHaveLength(177);
    for (const s of shapes.slice(0, 20)) {
      expect(s.rings.length).toBeGreaterThan(0);
    }
  });
});

describe('il decodificatore mette i paesi dove stanno', () => {
  const boxOf = (id: string) => {
    const shape = shapes.find((s) => s.id === id);
    if (!shape) throw new Error(`nessuna sagoma con id ${id}`);
    const points = shape.rings.flat();
    return {
      lonMin: Math.min(...points.map((p) => p[0])),
      lonMax: Math.max(...points.map((p) => p[0])),
      latMin: Math.min(...points.map((p) => p[1])),
      latMax: Math.max(...points.map((p) => p[1])),
    };
  };

  it("l'Italia sta fra 6,6°E e 18,5°E, fra 36,6°N e 47,1°N", () => {
    // Se i delta non venissero accumulati, questi numeri sarebbero tutti
    // vicini a -180 / -85, cioe` l'angolo della carta.
    const it = boxOf('380');
    expect(it.lonMin).toBeGreaterThan(6);
    expect(it.lonMax).toBeLessThan(19);
    expect(it.latMin).toBeGreaterThan(35);
    expect(it.latMax).toBeLessThan(48);
  });

  it("l'emisfero e il segno sono giusti: il Brasile e` a ovest e a sud", () => {
    const br = boxOf('076');
    expect(br.lonMax).toBeLessThan(-30);
    expect(br.latMin).toBeLessThan(-30);
    expect(br.latMax).toBeGreaterThan(0);
  });

  it('il mondo copre entrambi gli emisferi per intero', () => {
    const all = shapes.flatMap((s) => s.rings.flat());
    expect(Math.min(...all.map((p) => p[0]))).toBeCloseTo(-180, 0);
    expect(Math.max(...all.map((p) => p[0]))).toBeCloseTo(180, 0);
  });
});

describe('il file dev`essere SERVIBILE, non solo presente', () => {
  it('ogni estensione in web/src/assets sa uscire dal server statico', () => {
    // IL DIFETTO CHE QUESTO TEST HA GIA` TROVATO: `.json` non era nella
    // tabella dei tipi, e il server statico risponde 404 a tutto cio` che non
    // riconosce. Il file c'era, il bundle lo emetteva, e la mappa non avrebbe
    // caricato mai — senza un errore, perche` il componente degrada a
    // «contorni non disponibili» e sembra un problema di rete.
    const dir = fileURLToPath(new URL('../../web/src/assets/', import.meta.url));
    const extensions = new Set(
      readdirSync(dir)
        .filter((n) => !n.endsWith('.md'))
        .map((n) => n.slice(n.lastIndexOf('.'))),
    );
    expect(extensions.size).toBeGreaterThan(0);
    for (const ext of extensions) {
      expect(CONTENT_TYPES[ext], `estensione ${ext}`).toBeDefined();
    }
  });

  it('i tipi che il build emette sempre ci sono', () => {
    for (const ext of ['.js', '.css', '.json']) {
      expect(CONTENT_TYPES[ext], ext).toBeDefined();
    }
  });
});

describe('la tabella dei codici', () => {
  it('mappa alpha-2 sul numerico con lo zero iniziale', () => {
    // La topologia usa id a TRE cifre: '008', non '8'. Un confronto senza
    // zeri iniziali non troverebbe mezza Europa.
    expect(ALPHA2_TO_NUMERIC.IT).toBe('380');
    expect(ALPHA2_TO_NUMERIC.AL).toBe('008');
    expect(ALPHA2_TO_NUMERIC.DE).toBe('276');
  });

  it('ogni sagoma CON un codice ISO e` raggiungibile da un alpha-2', () => {
    const reachable = new Set(Object.values(ALPHA2_TO_NUMERIC));
    // Una sagoma raggiungibile da nessun alpha-2 sarebbe un paese che non si
    // potrebbe MAI colorare, qualunque dato arrivi.
    const orphans = shapes.filter((s) => s.id !== '' && !reachable.has(s.id));
    expect(orphans.map((s) => s.name)).toEqual([]);
  });

  it('le tre sagome senza ISO restano non disegnate, e si sa quali sono', () => {
    // Cipro del Nord, Somaliland e Kosovo non hanno un codice ISO 3166-1.
    // Kosovo e` il caso che il §8.9 nomina: `XK` e` un codice assegnato
    // dall'utente, non standard, e degrada a «non disegnato». Il dato non si
    // perde — resta nell'elenco a destra — ma la sagoma non si colora, ed e`
    // meglio di colorare il paese sbagliato.
    const senzaIso = shapes
      .filter((s) => s.id === '')
      .map((s) => s.name)
      .sort();
    expect(senzaIso).toEqual(['Kosovo', 'N. Cyprus', 'Somaliland']);
    expect(ALPHA2_TO_NUMERIC.XK).toBeUndefined();
  });

  it('XX non e` un paese e non deve avere una sagoma', () => {
    // E` il secchiello dei non risolti: vive nell'elenco, non sulla mappa.
    expect(ALPHA2_TO_NUMERIC.XX).toBeUndefined();
  });
});
