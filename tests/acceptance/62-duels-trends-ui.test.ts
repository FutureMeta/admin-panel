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
import {
  bandAt,
  CHART,
  chartScales,
  everyNth,
  gaps,
  niceScale,
  segments,
  slotsFor,
  tickSpacing,
} from '#web/lib/chart.ts';
import {
  ALL,
  avgLabel,
  combineCombos,
  comboFilters,
  distributionBars,
  filterKey,
  omitEmpty,
  pctLabel,
  ranked,
  ratingsSearch,
  shareLabel,
  spacingOf,
  starsFilled,
} from '#web/lib/duels.ts';
import { heatColour, heatPosition } from '#web/lib/heat.ts';
import { axisLabel, bucketLabel } from '#web/lib/when.ts';

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

describe('i conti della schermata Ratings', () => {
  it('le barre sono SEMPRE cinque, anche a zero voti', async () => {
    // Una distribuzione con quattro colonne suggerirebbe che quel voto non si
    // possa dare.
    const bars = distributionBars([0, 0, 0, 0, 0], 0);
    expect(bars.map((b) => b.stars)).toEqual([1, 2, 3, 4, 5]);
    expect(bars.every((b) => b.share === 0)).toBe(true);
  });

  it('la scala va dall`errore all`ok, non al contrario', async () => {
    // Il mockup assegna i colori nell'ordine sbagliato e cinque stelle
    // finiscono rosse. Uno e cinque sono l'errore e l'ok del pannello.
    const bars = distributionBars([1, 1, 1, 1, 1], 5);
    expect(bars[0]?.color).toBe('var(--r1)');
    expect(bars[4]?.color).toBe('var(--r5)');
  });

  it('le quote si calcolano sul totale, non sulla barra piu` alta', async () => {
    const bars = distributionBars([1, 0, 0, 1, 2], 4);
    expect(bars.map((b) => Math.round(b.share))).toEqual([25, 0, 0, 25, 50]);
  });

  it('le stelle si arrotondano, e il numero resta accanto', async () => {
    // 3,50 disegna quattro stelle piene: il difetto e` noto e tollerato solo
    // perche` la cifra sta sempre di fianco.
    expect(starsFilled(3.5)).toBe(4);
    expect(starsFilled(4.49)).toBe(4);
    expect(starsFilled(0)).toBe(0);
    expect(starsFilled(9)).toBe(5);
    expect(avgLabel(4.2)).toBe('4,20');
  });

  it('«N di M» non si divide per zero', async () => {
    expect(pctLabel(0, 0)).toBe('0%');
    expect(pctLabel(38, 100)).toBe('38%');
  });

  it('la chiave dei filtri cambia quando cambia una domanda', async () => {
    // E` cio` che azzera il cursore: senza, la pagina due di una ricerca
    // finirebbe sotto un'altra ricerca.
    const base = { mode: null, q: '', comment: 'all', sort: 'recent', range: '7d' } as const;
    expect(filterKey(base)).toBe(filterKey({ ...base }));
    expect(filterKey({ ...base, q: 'Vally' })).not.toBe(filterKey(base));
    expect(filterKey({ ...base, mode: 1 })).not.toBe(filterKey(base));
    expect(filterKey({ ...base, sort: 'worst' })).not.toBe(filterKey(base));
    expect(filterKey({ ...base, range: '30d' })).not.toBe(filterKey(base));
  });

  it('un parametro tolto SPARISCE dalla URL invece di restare vuoto', async () => {
    expect(omitEmpty({ range: '7d', q: 'x' }, { q: undefined })).toEqual({ range: '7d' });
    expect(omitEmpty({ range: '7d' }, { sort: 'worst' })).toEqual({ range: '7d', sort: 'worst' });
    expect(omitEmpty({ range: '7d', q: 'x' }, { q: '' })).toEqual({ range: '7d' });
  });

  it('un valore impossibile nella URL si toglie, non si tiene', async () => {
    // Lasciare in barra un `?sort=migliori` che non ha effetto fa credere che
    // l'abbia avuto.
    expect(ratingsSearch({ sort: 'migliori', comment: 'boh', mode: 'x' })).toEqual({});
    expect(ratingsSearch({ sort: 'worst', comment: 'with', mode: 3, q: 'Vally' })).toEqual({
      sort: 'worst',
      comment: 'with',
      mode: 3,
      q: 'Vally',
    });
    // Il predefinito non si scrive: una URL nuda vale «piu` recenti».
    expect(ratingsSearch({ sort: 'recent', comment: 'all' })).toEqual({});
  });
});

describe('la geometria dei grafici e` UNA SOLA', () => {
  it('la banda sotto il tracciato lascia respiro alle etichette', async () => {
    // E` il difetto che si e` visto a occhio: con la banda a due unita` le ore
    // finiscono appiccicate al bordo della scheda. Venti unita` fino alla
    // linea di base, dodici di respiro sotto — e sono le stesse per tutti e
    // tre i grafici, o tornano a divergere.
    expect(CHART.AXIS_BAND - CHART.LABEL_DY).toBeGreaterThanOrEqual(10);
  });

  it('il carattere delle etichette e` un NOME, non una variabile CSS', async () => {
    // Dentro un attributo di presentazione SVG `var(--font-mono)` non si
    // risolve: non fallisce, ripiega sul font di sistema, e l'unico modo di
    // accorgersene e` guardare due assi vicini e vedere che uno e` diverso.
    expect(CHART.FONT).not.toMatch(/var\(/);
  });

  it('le scale toccano i due bordi del tracciato, non uno solo', async () => {
    const s = chartScales(24, 100, 236);
    expect(s.x(0)).toBe(CHART.LEFT);
    expect(s.x(23)).toBe(CHART.RIGHT);
    expect(s.y(0)).toBe(236);
    expect(s.y(100)).toBe(CHART.TOP);
    expect(s.bottom).toBe(236);
  });

  it('un punto solo non divide per zero', async () => {
    const s = chartScales(1, 0, 236);
    expect(Number.isFinite(s.x(0))).toBe(true);
    expect(Number.isFinite(s.y(0))).toBe(true);
  });

  it('l`ultima tacca c`e` SEMPRE: e` quella che dice dove finisce il periodo', async () => {
    const ticks = everyNth(30, (i) => String(i));
    expect(ticks.at(-1)?.at).toBe(29);
    expect(ticks.length).toBeLessThanOrEqual(10);

    // Anche quando l'ultimo indice cade su un multiplo, non si duplica.
    const esatte = everyNth(9, (i) => String(i));
    expect(esatte.map((t) => t.at)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe('la rampa della heatmap ha piu` di quattro colori', () => {
  it('due valori vicini danno due colori DIVERSI', async () => {
    // Prima la rampa era a gradini: `Math.floor` su quattro fermate sceglieva
    // una delle quattro tinte, quindi centosessantotto celle finivano dipinte
    // con tre o quattro colori in tutto. La differenza fra un'ora da dieci
    // partite e una da settanta spariva dentro lo stesso rettangolo — cioe`
    // la heatmap smetteva di essere una heatmap.
    const colori = new Set<string>();
    for (let v = 0; v <= 100; v += 1) colori.add(heatColour(v, 100));
    expect(colori.size).toBeGreaterThan(50);
  });

  it('gli estremi restano gli estremi', async () => {
    expect(heatColour(null, 100)).toBe('transparent');
    // Zero e` il primo gradino pieno, non il tratteggio: «coperto e vuoto».
    expect(heatColour(0, 100)).not.toBe('transparent');
    // Oltre il tetto la cella resta al massimo invece di uscire dalla scala.
    expect(heatColour(500, 100)).toBe(heatColour(100, 100));
  });

  it('la rampa e` monotona: piu` partite non danno un colore piu` scuro', async () => {
    // Non si puo` confrontare un `color-mix` a occhio, ma si puo` pretendere
    // che la posizione sulla rampa cresca: e` quella a decidere il colore.
    expect(heatPosition(10, 100)).toBeLessThan(heatPosition(70, 100));
    expect(heatPosition(0, 100)).toBe(0);
    expect(heatPosition(100, 100)).toBe(1);
  });
});

describe('il grafico non si stira per riempire il riquadro', () => {
  it('le scale seguono la LARGHEZZA misurata, non un viewBox fisso', async () => {
    // Con un viewBox fisso e `preserveAspectRatio="none"` il disegno viene
    // stirato per riempire il contenitore, e con lui il TESTO: a piena pagina
    // e` un 6% che non si nota, nel riquadro a meta` pagina dell'andamento del
    // voto e` il 50% — e il «5★» finisce sopra la prima colonna.
    const largo = chartScales(10, 100, 200, 1120);
    const stretto = chartScales(10, 100, 200, 520);

    expect(largo.right).toBe(1108);
    expect(stretto.right).toBe(508);
    // Il margine sinistro resta lo stesso in PIXEL: e` lo spazio delle
    // etichette, e non si restringe con il riquadro.
    expect(largo.x(0)).toBe(stretto.x(0));
  });

  it('un riquadro strettissimo non produce una scala rovesciata', async () => {
    const minimo = chartScales(10, 100, 200, 20);
    expect(minimo.right).toBeGreaterThan(CHART.LEFT);
  });

  it('le tacche dell`asse le detta lo SPAZIO, non un numero fisso', async () => {
    // Otto etichette stanno su mille pixel e si accavallano su cinquecento.
    expect(slotsFor(1120)).toBeGreaterThan(slotsFor(520));
    expect(slotsFor(120)).toBeGreaterThanOrEqual(2);
  });

  it('l`ultima tacca c`e` sempre, e non si accavalla alla penultima', async () => {
    const larghe = everyNth(168, (i) => String(i), 8);
    expect(larghe.at(-1)?.at).toBe(167);
    const strette = everyNth(168, (i) => String(i), 3);
    expect(strette.at(-1)?.at).toBe(167);
    // Fra le ultime due tacche resta almeno mezzo passo.
    const passo = 168 / 3;
    const ultime = strette.slice(-2).map((t) => t.at);
    expect((ultime[1] as number) - (ultime[0] as number)).toBeGreaterThan(passo / 2);
  });
});

describe('le barre di fondo non escono dal tracciato', () => {
  it('la prima e l`ultima si tagliano al bordo invece di sporgere', async () => {
    // Una linea vive sui PUNTI, una barra su una FASCIA: centrando la barra sul
    // punto, la prima sporge di mezza larghezza a sinistra del tracciato. Con
    // 168 punti sono due pixel; con sette — l'andamento del voto a sette
    // giorni — sono trenta, e la barra finisce sopra le etichette dell'asse.
    const scales = chartScales(7, 5, 214, 520);

    const first = bandAt(scales, 7, 0);
    expect(first.x).toBeGreaterThanOrEqual(CHART.LEFT);

    const last = bandAt(scales, 7, 6);
    expect(last.x + last.width).toBeLessThanOrEqual(scales.right);
  });

  it('quelle in mezzo restano intere e con un po` di respiro', async () => {
    const scales = chartScales(7, 5, 214, 520);
    const slot = (scales.right - CHART.LEFT) / 6;
    const middle = bandAt(scales, 7, 3);

    expect(middle.width).toBeCloseTo(slot * 0.7, 1);
    // Attaccate diventerebbero un'area piena, cioe` un'altra figura.
    expect(middle.width).toBeLessThan(slot);
  });

  it('con un punto solo non si divide per zero', async () => {
    const scales = chartScales(1, 5, 214, 520);
    const only = bandAt(scales, 1, 0);
    expect(only.width).toBeGreaterThan(0);
    expect(Number.isFinite(only.x)).toBe(true);
  });
});

describe('l`etichetta dell`asse la decide la distanza fra le TACCHE', () => {
  /** 168 bucket da un'ora, come il 7g. */
  const hourly = Array.from({ length: 168 }, (_, i) => 1_787_000_000 + i * 3_600);
  /** 30 bucket da un giorno, come il 30g. */
  const daily = Array.from({ length: 30 }, (_, i) => 1_787_000_000 + i * 86_400);

  it('sul 7g le tacche distano ORE, ma abbastanza da volere il giorno', async () => {
    // IL DIFETTO: passando il passo dei BUCKET (un'ora) l'etichetta diventava
    // «14:00» senza il giorno, e su sette giorni quell'ora indica sette
    // istanti diversi. La panoramica passava il passo giusto ed era corretta:
    // stessa figura, due risposte, perche' il numero lo sceglieva ogni
    // grafico per conto suo.
    const ticks = everyNth(hourly.length, () => '', slotsFor(1050));
    const step = tickSpacing(hourly, ticks);

    expect(step).toBeGreaterThanOrEqual(6 * 3_600);
    expect(step).toBeLessThan(48 * 3_600);
    expect(axisLabel(hourly[0] as number, step)).toMatch(/\d{1,2}:\d{2}|\s\d{1,2}$/);
    expect(axisLabel(hourly[0] as number, step)).not.toBe(axisLabel(hourly[0] as number, 3_600));
  });

  it('sul 30g le tacche distano giorni, e l`ora sparisce', async () => {
    // Col passo dei bucket (un giorno) usciva «gio 00», cioe` il giorno con
    // un'ora che non significa niente.
    const ticks = everyNth(daily.length, () => '', slotsFor(1050));
    const step = tickSpacing(daily, ticks);

    expect(step).toBeGreaterThanOrEqual(48 * 3_600);
    expect(axisLabel(daily[0] as number, step)).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it('con una tacca sola si ripiega sul passo dei bucket', async () => {
    expect(tickSpacing(hourly, [])).toBe(3_600);
    expect(tickSpacing(daily, [{ at: 0, label: '' }])).toBe(86_400);
  });

  it('un bucket giornaliero nel tooltip non dice «alle 00:00»', async () => {
    expect(bucketLabel(daily[0] as number, 86_400)).not.toMatch(/alle/);
    expect(bucketLabel(daily[0] as number, 7 * 86_400)).toMatch(/^settimana del /);
    expect(bucketLabel(hourly[0] as number, 3_600)).toMatch(/alle/);
  });
});
