// Cosa dice il riquadro sotto il cursore, quando le linee sono piu' d'una.
//
// IL DIFETTO DI PARTENZA. Il riquadro riportava una lettura sola, e sempre la
// stessa: il totale, cioe' la linea in alto. Sotto ce n'erano altre —
// disegnate, colorate, spiegate in legenda — e passandoci sopra non dicevano
// niente. Ma si passa sopra un grafico proprio per sapere COME si divide quel
// punto, e la risposta era ogni volta la somma che si vedeva gia'.
//
// Le regole qui sotto sembrano dettagli di impaginazione e non lo sono:
// sbagliarne una produce un riquadro che si legge benissimo e dice il falso.

import { describe, expect, it } from 'vitest';
import { liveSplit, MAX_PARTS, readingsAt, type TipRow } from '#web/lib/chart.ts';
import { numberFmt } from '#web/lib/format.ts';

function readings(
  index: number,
  total: (number | null)[],
  series: Record<string, (number | null)[]>,
  hidden: string[] = [],
): TipRow[] {
  return readingsAt({
    index,
    total,
    parts: { keys: Object.keys(series), series },
    hidden: new Set(hidden),
    colorOf: (k) => `colore-${k}`,
    labels: { bedwars: 'BedWars' },
    format: (v) => numberFmt.format(v),
  });
}

describe('il riquadro riporta TUTTE le linee, non solo quella in alto', () => {
  it('una riga per il totale e una per ogni parte', async () => {
    const rows = readings(0, [900], { bedwars: [500], skywars: [400] });

    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ label: 'Totale', value: '900', color: 'var(--ac)' });
    expect(rows.map((r) => r.label)).toEqual(['Totale', 'BedWars', 'skywars']);
  });

  it('il colore della riga e` quello della linea, o non si sa di chi parla', async () => {
    // E' l'unica cosa che lega la riga alla linea: senza, un elenco di nomi
    // e un fascio di linee colorate restano due oggetti separati.
    const rows = readings(0, [900], { bedwars: [500] });
    expect(rows[1]?.color).toBe('colore-bedwars');
  });

  it('senza un nome in dizionario si mostra la chiave, come fa la legenda', async () => {
    // Il dettaglio di una modalita' si divide per SERVER, e i server non
    // stanno nel dizionario delle modalita': la chiave e' gia' il loro nome.
    const rows = readings(0, [10], { 'duels-3': [10] });
    expect(rows[1]?.label).toBe('duels-3');
  });
});

describe('il totale non e` la somma delle parti, e non deve diventarlo', () => {
  it('spegnere una voce toglie la sua riga senza toccare il totale', async () => {
    // E' la stessa regola della legenda: il totale e' MISURATO. Ricavarlo
    // dalle righe visibili darebbe un numero che non compare da nessun'altra
    // parte nel pannello, e cambierebbe cliccando sulla legenda.
    const rows = readings(0, [900], { bedwars: [500], skywars: [400] }, ['skywars']);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.value).toBe('900');
    expect(rows.map((r) => r.label)).toEqual(['Totale', 'BedWars']);
  });

  it('e le parti possono non sommare al totale senza che sia un errore', async () => {
    const rows = readings(0, [900], { bedwars: [100] });
    expect(rows[0]?.value).toBe('900');
    expect(rows[1]?.value).toBe('100');
  });
});

describe('un buco non e` uno zero', () => {
  it('la parte non rilevata non compare: in quel punto la sua linea non c`e`', async () => {
    // Scrivere «0» direbbe che quella modalita' era vuota. Non lo era: non e'
    // stata misurata, ed e' la differenza che `gaps` e `segments` esistono
    // per non perdere.
    const rows = readings(1, [900, 900], { bedwars: [500, null], skywars: [400, 400] });

    expect(rows.map((r) => r.label)).toEqual(['Totale', 'skywars']);
    expect(JSON.stringify(rows)).not.toContain('"0"');
  });

  it('il totale non rilevato lo dice invece di sparire', async () => {
    // La riga del totale resta SEMPRE: sparendo, un bucket senza misura
    // sembrerebbe un bucket senza traffico.
    const rows = readings(0, [null], { bedwars: [null] });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ label: 'Totale', value: 'non rilevato', color: 'var(--ac)' });
  });
});

describe('l`ordine e il tetto', () => {
  it('dalla piu` alta alla piu` bassa, come si incontrano scendendo con l`occhio', async () => {
    const rows = readings(0, [60], { a: [10], b: [30], c: [20] });
    expect(rows.slice(1).map((r) => r.label)).toEqual(['b', 'c', 'a']);
  });

  it('oltre il tetto le escluse si CONTANO, non spariscono', async () => {
    // Un elenco troncato in silenzio si legge come un elenco completo: e' il
    // modo piu' facile di far sembrare che un server non ci fosse.
    const many: Record<string, (number | null)[]> = {};
    for (let i = 0; i < MAX_PARTS + 3; i += 1) many[`s${i}`] = [100 - i];

    const rows = readings(0, [10_000], many);

    expect(rows).toHaveLength(1 + MAX_PARTS + 1);
    expect(rows.at(-1)).toEqual({ value: '+3 altre' });
    // E il totale resta leggibile con il separatore delle migliaia: e' il
    // formattatore del pannello, non `String(n)`.
    expect(rows[0]?.value).toBe('10.000');
  });

  it('esattamente al tetto non si conta niente', async () => {
    const exact: Record<string, (number | null)[]> = {};
    for (let i = 0; i < MAX_PARTS; i += 1) exact[`s${i}`] = [10];

    const rows = readings(0, [80], exact);
    expect(rows).toHaveLength(1 + MAX_PARTS);
    expect(JSON.stringify(rows)).not.toContain('altre');
  });
});

// ---------------------------------------------------------------------------
// La coda viva
// ---------------------------------------------------------------------------

describe('l`ultimo bucket e` ancora aperto, e il disegno lo dice', () => {
  it('la parte definitiva e quella in formazione condividono un punto', () => {
    // Se non lo condividessero, fra il tratto pieno e quello tratteggiato ci
    // sarebbe un buco: si leggerebbe come un dato mancante, che e' proprio
    // l'unica cosa che quel punto non e'.
    const { solid, live } = liveSplit([10, 20, 30, 40], true);
    expect(solid).toEqual([10, 20, 30, null]);
    expect(live).toEqual([null, null, 30, 40]);
  });

  it('senza coda viva non si tratteggia niente', () => {
    const { solid, live } = liveSplit([10, 20, 30], false);
    expect(solid).toEqual([10, 20, 30]);
    expect(live).toEqual([null, null, null]);
  });

  it('un punto solo non si puo` spezzare', () => {
    // Due punti sono il minimo per disegnare un segmento: sotto, il
    // tratteggio non avrebbe dove andare e il punto sparirebbe dal grafico.
    const { solid, live } = liveSplit([42], true);
    expect(solid).toEqual([42]);
    expect(live).toEqual([null]);
  });

  it('un buco appena prima della coda resta un buco', () => {
    // Il null non diventa un punto d'attacco per il tratteggio: la linea
    // tratteggiata comincia dove c'e` un valore, o non comincia.
    const { solid, live } = liveSplit([10, null, 30], true);
    expect(solid).toEqual([10, null, null]);
    expect(live).toEqual([null, null, 30]);
  });

  it('non tocca l`array che riceve', () => {
    const values: (number | null)[] = [1, 2, 3];
    liveSplit(values, true);
    expect(values).toEqual([1, 2, 3]);
  });
});
