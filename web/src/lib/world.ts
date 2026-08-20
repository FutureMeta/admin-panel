// La geometria del mondo. Fase 2, §8.9 — passo 8.
//
// DATI CONGELATI, NON UNA LIBRERIA. `world-atlas` e `topojson-client` sono
// fermi al 2019: trattarli come dipendenze significherebbe portarsi dietro due
// pacchetti che nessuno aggiorna per una funzione che non cambiera' mai —
// i confini del mondo si muovono meno spesso di una minor version. Il file
// sta in `assets/` e il decodificatore e' queste sessanta righe.
//
// IL JSON NON ENTRA NEL BUNDLE. Un `import` statico di JSON lo incorpora come
// letterale dentro un chunk JavaScript: 108 kB che passano dal PARSER JS
// invece che da `JSON.parse`, che è molto piu' veloce e non blocca la
// compilazione del resto. Qui l'asset ha un URL e si scarica quando serve.
//
// SI PUO' ANTICIPARE: `loadWorld()` e' memoizzata, quindi chiamarla al
// passaggio del mouse sulla voce di menu fa sparire la latenza senza costare
// un byte in piu' a chi non apre mai quella schermata.

/** Un paese: la sua sagoma, gia' in gradi. */
export type CountryShape = {
  /** Codice ISO 3166-1 NUMERICO, come stringa a tre cifre. */
  id: string;
  /** Nome inglese dalla sorgente. In interfaccia si usa `Intl.DisplayNames`. */
  name: string;
  /** Anelli di coordinate [longitudine, latitudine]. */
  rings: Array<Array<[number, number]>>;
};

type Topology = {
  transform?: { scale: [number, number]; translate: [number, number] };
  arcs: number[][][];
  objects: Record<string, { geometries: TopoGeometry[] }>;
};

type TopoGeometry = {
  type: string;
  id?: string | number;
  properties?: { name?: string };
  arcs?: unknown;
};

/**
 * Un arco, da delta quantizzati a gradi.
 *
 * I punti sono memorizzati come DIFFERENZE dal precedente, e la prima coppia
 * e' assoluta: accumulare e' obbligatorio, e saltarlo produce un mondo
 * accartocciato nell'angolo in alto a sinistra invece di un errore.
 */
function decodeArc(arc: number[][], t: Topology['transform']): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let x = 0;
  let y = 0;
  for (const point of arc) {
    x += point[0] ?? 0;
    y += point[1] ?? 0;
    out.push(t ? [x * t.scale[0] + t.translate[0], y * t.scale[1] + t.translate[1]] : [x, y]);
  }
  return out;
}

/** Un anello dagli indici degli archi. Un indice NEGATIVO e' l'arco `~i` al contrario. */
function ringOf(indexes: number[], arcs: Array<Array<[number, number]>>): Array<[number, number]> {
  const ring: Array<[number, number]> = [];
  for (const index of indexes) {
    const arc = index < 0 ? [...(arcs[~index] ?? [])].reverse() : (arcs[index] ?? []);
    // Il primo punto di ogni arco ripete l'ultimo del precedente: si salta,
    // altrimenti l'anello ha vertici doppi e il riempimento SVG puo' produrre
    // artefatti sui confini condivisi.
    ring.push(...(ring.length > 0 ? arc.slice(1) : arc));
  }
  return ring;
}

export function decodeTopology(topology: Topology, objectName: string): CountryShape[] {
  const arcs = topology.arcs.map((a) => decodeArc(a, topology.transform));
  const collection = topology.objects[objectName];
  if (!collection) return [];

  const shapes: CountryShape[] = [];
  for (const geometry of collection.geometries) {
    const rings: Array<Array<[number, number]>> = [];
    if (geometry.type === 'Polygon') {
      for (const r of (geometry.arcs as number[][]) ?? []) rings.push(ringOf(r, arcs));
    } else if (geometry.type === 'MultiPolygon') {
      for (const polygon of (geometry.arcs as number[][][]) ?? []) {
        for (const r of polygon) rings.push(ringOf(r, arcs));
      }
    }
    if (rings.length === 0) continue;
    shapes.push({
      id: String(geometry.id ?? ''),
      name: geometry.properties?.name ?? '',
      rings,
    });
  }
  return shapes;
}

const topoUrl = new URL('../assets/countries-110m.json', import.meta.url);
let pending: Promise<CountryShape[]> | null = null;

/**
 * Le sagome, scaricate una volta sola.
 *
 * Memoizzata sulla PROMESSA e non sul risultato: due chiamate ravvicinate —
 * il passaggio del mouse sul menu e l'apertura della schermata — devono
 * condividere lo stesso scaricamento, non farne due.
 */
export function loadWorld(): Promise<CountryShape[]> {
  pending ??= fetch(topoUrl)
    .then((r) => {
      if (!r.ok) throw new Error(`countries-110m.json: HTTP ${r.status}`);
      return r.json();
    })
    .then((t) => decodeTopology(t as Topology, 'countries'))
    .catch((err) => {
      // Un fallimento non deve restare inchiodato: senza questo, una singola
      // richiesta andata male impedirebbe per sempre di riprovare, e la mappa
      // resterebbe vuota fino al ricaricamento della pagina.
      pending = null;
      throw err;
    });
  return pending;
}

// ---------------------------------------------------------------------------
// Proiezione
// ---------------------------------------------------------------------------

export const MAP_WIDTH = 720;
/**
 * Latitudini tenute: sotto i -58° c'e' solo l'Antartide.
 *
 * Tagliarla non e' pigrizia cartografica: occupa un quinto dell'altezza per
 * dire sempre zero, e in una equirettangolare la sua deformazione e' tale che
 * chi guarda crede sia il continente piu' grande del pianeta.
 */
const LAT_TOP = 84;
const LAT_BOTTOM = -58;
export const MAP_HEIGHT = Math.round((MAP_WIDTH * (LAT_TOP - LAT_BOTTOM)) / 360);

const px = (lon: number) => ((lon + 180) / 360) * MAP_WIDTH;
const py = (lat: number) => ((LAT_TOP - lat) / (LAT_TOP - LAT_BOTTOM)) * MAP_HEIGHT;

/**
 * Srotola le longitudini di un anello che attraversa l'antimeridiano.
 *
 * IL DIFETTO CHE EVITA. Russia e Figi hanno anelli i cui punti passano da
 * +179 a -179: sono due gradi di distanza sul globo, ma su una carta piatta
 * sono l'intera larghezza. Disegnati cosi', quei paesi diventano una striscia
 * orizzontale che taglia il mondo da parte a parte — e non e' un errore
 * sottile, e' la prima cosa che si vede aprendo la schermata.
 *
 * Il salto si riconosce perche' supera i 180 gradi, e si annulla accumulando
 * un offset: l'anello diventa continuo e finisce fuori dalla carta da un lato,
 * dove il viewport lo taglia.
 */
export function unwrap(ring: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let offset = 0;
  let previous: number | null = null;
  for (const [lon, lat] of ring) {
    if (previous !== null) {
      const jump = lon - previous;
      if (jump > 180) offset -= 360;
      else if (jump < -180) offset += 360;
    }
    previous = lon;
    out.push([lon + offset, lat]);
  }
  return out;
}

function ringPath(ring: Array<[number, number]>, shift: number): string {
  let d = '';
  ring.forEach((p, i) => {
    d += `${i === 0 ? 'M' : 'L'}${px(p[0] + shift).toFixed(1)},${py(p[1]).toFixed(1)}`;
    if (i < ring.length - 1) d += ' ';
  });
  return `${d}Z`;
}

export function pathOf(shape: CountryShape): string {
  let d = '';
  for (const raw of shape.rings) {
    if (raw.length < 3) continue;
    // Interamente sotto il taglio: e' l'Antartide, e il suo anello gira
    // attorno al polo coprendo tutti i 360 gradi. Fuori dal riquadro sarebbe
    // ritagliata dal viewport comunque, ma sono migliaia di coordinate
    // calcolate e serializzate per non disegnare niente.
    if (Math.max(...raw.map((p) => p[1])) < LAT_BOTTOM) continue;
    const ring = unwrap(raw);
    d += ringPath(ring, 0);

    // La parte finita oltre il bordo si ridisegna DALL'ALTRO LATO. Senza,
    // la Cukotka sparirebbe dalla mappa invece di comparire a sinistra, che e'
    // dove sta su ogni carta del mondo.
    const lons = ring.map((p) => p[0]);
    if (Math.max(...lons) > 180) d += ringPath(ring, -360);
    if (Math.min(...lons) < -180) d += ringPath(ring, 360);
  }
  return d;
}
