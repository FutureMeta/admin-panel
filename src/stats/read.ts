// Costruzione del payload delle statistiche. Fase 2, passo 4.
//
// UNA SCANSIONE PER WIDGET, tagliata in JS. Il costo di una scansione su
// `rollup_1h` per novanta giorni e' lo stesso che si voglia una modalita' o
// venti: e' lo stesso intervallo di indice. Si paga una volta.
//
// I CONFINI DEL PERIODO si calcolano su GIORNI CIVILI di Roma, mai con
// `- interval '30 days'` su un timestamptz: nei periodi che attraversano un
// cambio ora le due cose differiscono di un'ora e il grafico scivola di un
// bucket.
//
// IL SELETTORE IN ALTO GOVERNA TUTTA LA PAGINA: andamento, heatmap, unici e
// mappa leggono la stessa finestra. Un widget che ignora il selettore e'
// peggio di un widget assente, perche' chi guarda non ha modo di sapere che
// quel riquadro sta rispondendo a un'altra domanda.

import type { Database } from '#src/db/pool.ts';
import {
  axisOf,
  cellOf,
  daysOf,
  liveEdge,
  nominalCells,
  PLAN,
  ROME,
  ROME_YMD,
  romeMidnight,
  shiftDays,
  windowOf,
} from './calendar.ts';
import {
  CONTRACT_VERSION,
  type Kpi,
  type ModePayload,
  NOT_COLLECTED_COUNTRY,
  type OverviewPayload,
  type Range,
  round1,
} from './contract.ts';
import { dictionaryColors, dictionaryFlags, dictionaryLabels, modeLabels } from './dictionary.ts';
import {
  currentMix,
  deltasIn,
  distinctPlayers,
  distinctPlayersByMode,
  geoRows,
  heatmapModeRows,
  heatmapRows,
  liveBucketRows,
  liveDayUniques,
  liveServerRows,
  type ModeFilter,
  networkFacts,
  type SeriesRow,
  seenIsCurrent,
  seriesRows,
  serverMix,
  serverSeriesRows,
  uniquesByModeRows,
  uniquesRows,
} from './queries.ts';

type Bucket = {
  t: number;
  /** L'istante del massimo dentro questo bucket, dal grezzo. */
  peakAt: number | null;
  coveredS: number;
  byMode: Map<string, number>;
  networkSeconds: number;
  peak: number | null;
};

function collect(rows: SeriesRow[]): Bucket[] {
  const byT = new Map<number, Bucket>();
  for (const r of rows) {
    const t = Number(r.t);
    let b = byT.get(t);
    if (!b) {
      b = {
        t,
        peakAt: null,
        coveredS: Number(r.covered_s),
        byMode: new Map(),
        networkSeconds: 0,
        peak: null,
      };
      byT.set(t, b);
    }
    const seconds = Number(r.player_seconds);
    if (r.mode_key === '__network__') {
      b.networkSeconds = seconds;
      b.peak = r.players_max === null ? null : Number(r.players_max);
      b.peakAt = r.players_max_at ? Math.floor(r.players_max_at.getTime() / 1_000) : null;
    } else {
      b.byMode.set(r.mode_key, (b.byMode.get(r.mode_key) ?? 0) + seconds);
    }
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

/**
 * I KPI del periodo.
 *
 * `avg` NON e' `player_seconds / covered_s` sul periodo intero. I buchi non
 * sono mai indipendenti dall'ora del giorno — si fa deploy la sera, il Redis
 * di gioco soffre al picco — quindi tre serate perse in un mese abbassano la
 * media dell'8-10% con una copertura complessiva del 98,8%. E nessuno guarda
 * con sospetto un 98,8%.
 *
 * Si normalizza sul profilo orario: ogni cella (giorno-settimana, ora) pesa
 * per quante volte ricorre nel periodo, non per quanto e' stata osservata.
 * Cosi' una serata mancante non sposta la media: abbassa `coverage`, che e' il
 * posto giusto in cui farlo vedere.
 */
/**
 * @param numerator I secondi-giocatore da mediare. Per una modalita' sono i
 *   suoi, per la rete quelli della riga di rete. Il DENOMINATORE non e' mai
 *   parametrico: viene sempre dalla riga di rete, o `evento_1` — aperta cinque
 *   minuti al giorno con duecento giocatori — riporterebbe media 200 e
 *   batterebbe `duels` aperta ventiquattr'ore con 150.
 * @param hasPeak Falso per le modalita': il massimo non si decompone (vedi
 *   `ModePayload`). Un limite inferiore etichettato «picco» e' una bugia
 *   plausibile, che e' la specie peggiore.
 */
function kpiOf(
  buckets: Bucket[],
  from: Date,
  to: Date,
  bucketSec: number,
  numerator: (b: Bucket) => number = (b) => b.networkSeconds,
  hasPeak = true,
): Kpi {
  const nominalS = (to.getTime() - from.getTime()) / 1_000;
  const coveredS = buckets.reduce((a, b) => a + b.coveredS, 0);

  let peak: number | null = null;
  let peakAt: number | null = null;
  let peakCoverage = 0;
  if (hasPeak) {
    for (const b of buckets) {
      if (b.peak === null) continue;
      if (peak === null || b.peak > peak) {
        peak = b.peak;
        // L'ISTANTE VERO, non l'inizio del bucket che lo contiene. Con bucket
        // da sei ore (range 90g) l'inizio dista fino a sei ore dal massimo, e
        // lo stesso picco risultava «alle 18:00» su 90g e «alle 20:00» su 7g:
        // due risposte diverse alla stessa domanda, e per accorgersi che non
        // erano in disaccordo bisognava sapere quanto e' largo un bucket.
        peakAt = b.peakAt ?? b.t;
        // Il massimo non viaggia mai da solo: senza la copertura del suo
        // bucket, un picco misurato su due tick su dieci sembra un picco vero.
        peakCoverage = Math.min(1, b.coveredS / bucketSec);
      }
    }
  }

  const num = new Array<number>(168).fill(0);
  const den = new Array<number>(168).fill(0);
  for (const b of buckets) {
    if (b.coveredS <= 0) continue;
    const c = cellOf(b.t);
    num[c] = (num[c] ?? 0) + numerator(b);
    den[c] = (den[c] ?? 0) + b.coveredS;
  }

  const nominal = nominalCells(from, to);
  let weighted = 0;
  let weights = 0;
  for (let c = 0; c < 168; c += 1) {
    const d = den[c] ?? 0;
    const occ = nominal[c] ?? 0;
    if (d <= 0 || occ <= 0) continue;
    weighted += occ * ((num[c] ?? 0) / d);
    weights += occ;
  }

  return {
    avg: weights > 0 ? round1(weighted / weights) : null,
    peak,
    peakAt,
    peakCoverage: Math.round(peakCoverage * 100) / 100,
    uniques: null, // passo 6
    coverage: nominalS > 0 ? Math.min(1, Math.round((coveredS / nominalS) * 100) / 100) : 0,
  };
}

export type BuildResult = { payload: OverviewPayload; queryMs: number };

/** La panoramica piu' i payload di ogni modalita', dalla STESSA scansione. */
export type AllBuild = {
  overview: OverviewPayload;
  perMode: Map<string, ModePayload>;
  queryMs: number;
  /** Le tre query piu' care di questo giro, per nome. Vanno nel log. */
  slowest: Record<string, number>;
};

/**
 * Costruisce la panoramica.
 *
 * Resta come porta d'ingresso di chi vuole solo quella — la rotta e i test —
 * ma dietro c'e' `buildAll`: una scansione su `rollup_1h` per novanta giorni
 * costa lo stesso che si voglia una modalita' o venti, perche' e' lo stesso
 * intervallo di indice. Costruire i payload per modalita' a parte
 * significherebbe pagare N volte la stessa lettura.
 */
export async function buildOverview(db: Database, range: Range, now = new Date()): Promise<BuildResult> {
  // Nessun payload per modalita': questa funzione ne butterebbe via ventuno.
  const all = await buildAll(db, range, now, []);
  return { payload: all.overview, queryMs: all.queryMs };
}

export async function buildAll(
  db: Database,
  range: Range,
  now = new Date(),
  wanted?: readonly string[],
): Promise<AllBuild> {
  const plan = PLAN[range];
  const w = windowOf(range, now);
  // L'asse si calcola PRIMA delle query: e' puro, e serve a sapere quale sia
  // il bucket in corso — cioe' quale finestra chiedere alla sorgente fine.
  const live = liveEdge(axisOf(range, w), w, now);

  // QUALI PAYLOAD PER MODALITA' SERVONO DAVVERO. Non e' un'ottimizzazione
  // marginale: le tre query per modalita' sono le piu' care del lotto —
  // `heatmapModeRows` da sola misura 1,7 s sul range 90g contro i 25 ms
  // della sua gemella di rete — e la panoramica non ne usa nemmeno una riga.
  // Pagarle sempre significava che aprire il pannello sul 90g costava
  // ventuno heatmap che nessuno avrebbe guardato, e che il range lungo era
  // troppo caro per essere riscaldato spesso: e' da li' che nasceva il
  // sintomo visibile, cioe' 24h fresco e 90g fermo a un quarto d'ora prima.
  //
  // `undefined` significa «tutte», che e' il comportamento di prima.
  const want = wanted ? new Set(wanted) : null;
  const anyMode = want === null || want.size > 0;
  const only: ModeFilter = { wanted: anyMode, all: want === null, keys: want ? [...want] : [] };

  const t0 = Date.now();

  // QUALE query costa, non solo quanto costa il giro.
  //
  // Tredici query in parallelo dietro un solo numero: quando il totale sale,
  // il numero non dice dove guardare, e l'unico modo di scoprirlo e'
  // strumentare a mano e rimettere in produzione. E' successo, ed e' costato
  // un giro di rilascio per una domanda a cui il codice poteva rispondere da
  // solo. Tredici coppie di `Date.now()` non si misurano nemmeno.
  const timings: Array<[string, number]> = [];
  // `PromiseLike<T> | T` e non `Promise<T>`: i rami saltati passano di qui
  // gia' risolti (un array vuoto, una Map vuota), e vanno cronometrati come
  // gli altri — costano zero, ed e' proprio quello che si vuole leggere.
  const timed = async <T>(name: string, p: T | PromiseLike<T>): Promise<T> => {
    const at = Date.now();
    try {
      return await p;
    } finally {
      timings.push([name, Date.now() - at]);
    }
  };

  // CHI SI E' VISTO NEL PERIODO, da una riga per giocatore invece che da una
  // per giocatore e giorno (vedi `seenIsCurrent`). I distinti del 24h no: la
  // sua finestra finisce a un istante di oggi, e sui giorni civili quel conto
  // si ferma a ieri, che `player_seen` — «visto dal giorno X in poi» — non sa
  // dire. Per lui restano i giorni, che sono due.
  const seen = await timed('seen', seenIsCurrent(db, now));
  const seenDays = seen && ROME_YMD.format(w.curTo) > ROME_YMD.format(now);

  const [
    rows,
    heat,
    heatByMode,
    deltas,
    labels,
    daily,
    dailyByMode,
    distinctNow,
    distinctModeNow,
    geo,
    facts,
    current,
    liveUniques,
    perServer,
    perServerSeries,
    liveRows,
    liveServers,
  ] = await Promise.all([
    timed('seriesRows', seriesRows(db, range, w)),
    timed('heatmap', heatmapRows(db, w.curFrom, now)),
    timed('heatmapMode', anyMode ? heatmapModeRows(db, w.curFrom, now, only) : []),
    timed('deltas', deltasIn(db, w)),
    timed('labels', modeLabels(db)),
    timed('uniques', uniquesRows(db, now, daysOf(range))),
    timed('uniquesMode', anyMode ? uniquesByModeRows(db, now, daysOf(range), only) : []),
    timed('distinct', distinctPlayers(db, w.curFrom, w.curTo, seenDays)),
    timed(
      'distinctMode',
      anyMode ? distinctPlayersByMode(db, w.curFrom, w.curTo, only, seenDays) : new Map<string, number>(),
    ),
    timed('geo', geoRows(db, w.curFrom, now, only, seen)),
    timed('facts', networkFacts(db)),
    timed('current', currentMix(db)),
    timed('liveUniques', liveDayUniques(db, now)),
    // Solo se qualcuno ha chiesto una modalita': e` la torta della schermata
    // di dettaglio, e la panoramica non la disegna.
    timed(
      'serverMix',
      anyMode ? serverMix(db) : new Map<string, { at: number; byServer: Record<string, number> }>(),
    ),
    // Idem: le righe per server dell'andamento sono un disegno del solo
    // dettaglio, e sono la query piu' voluminosa delle due.
    timed('serverSeries', anyMode ? serverSeriesRows(db, range, w, only) : []),
    // Il bucket in corso, dal livello sotto. Si chiede solo quando c'e' una
    // coda viva da riempire: sul 24h la finestra si ferma gia' all'ultimo
    // bucket chiuso, e questa query non parte.
    timed('liveBucket', live.liveTail ? liveBucketRows(db, live.closedThrough, now) : []),
    timed('liveServers', live.liveTail && anyMode ? liveServerRows(db, live.closedThrough, now, only) : []),
  ]);
  const queryMs = Date.now() - t0;
  // Le tre piu' care, e basta: l'elenco intero sarebbe rumore in ogni riga di
  // log scritta quando tutto va bene.
  const slowest = Object.fromEntries(timings.sort(([, a], [, b]) => b - a).slice(0, 3));

  /**
   * Il bucket in corso SOSTITUISCE quello chiuso, non gli si somma.
   *
   * IL DIFETTO CHE QUESTA RIGA TOGLIE, ed e' arrivato in produzione. Quando il
   * livello orario ha gia' scritto la PRIMA ora di un blocco ancora aperto —
   * su 30g il blocco dura due ore, su 90g sei — la lettura chiusa produce una
   * riga per quel blocco, e la lettura viva ne produce un'altra con lo stesso
   * istante. `collect` le fondeva: la riga di rete veniva SOVRASCRITTA (l'ultima
   * vince) e quelle per modalita' SOMMATE. Risultato, le parti valevano una
   * volta e mezza il loro totale, `assertPayload` rifiutava il payload, e il
   * giro di riscaldamento falliva su 30g, 90g e 1a — cioe' quei tre range
   * rispondevano 500.
   *
   * Sostituire e' anche la scelta giusta nel merito: la lettura viva copre
   * dall'inizio del blocco fino ad adesso, quindi contiene gia' tutto quello
   * che il livello orario aveva scritto, e in piu' i minuti dopo.
   *
   * Si sostituisce SOLO se c'e' qualcosa con cui farlo. Un blocco appena
   * cominciato non ha ancora nessun bucket da cinque minuti chiuso, e buttare
   * via la riga chiusa per rimpiazzarla con niente perderebbe un'ora di dati.
   */
  const liveAt = live.liveTail && liveRows.length > 0 ? live.closedThrough : null;
  const closedRows = liveAt === null ? rows : rows.filter((r) => Number(r.t) !== liveAt);
  const cur = collect([...closedRows, ...liveRows]);

  const modes = [...new Set(rows.map((r) => r.mode_key))]
    .filter((m) => m !== '__network__')
    .sort((a, b) => {
      const oa = labels.get(a)?.order ?? 999;
      const ob = labels.get(b)?.order ?? 999;
      return oa === ob ? a.localeCompare(b) : oa - ob;
    });

  const axis = live.axis;
  const byT = new Map(cur.map((b) => [b.t, b]));

  const series: Record<string, (number | null)[]> = {};
  for (const m of modes) series[m] = [];
  const total: (number | null)[] = [];
  const peakLine: (number | null)[] = [];
  const coverage: number[] = [];

  for (const t of axis) {
    const b = byT.get(t);
    // Il buco e' un valore: `null` significa «non rilevato», e non si
    // interpola mai fra due punti separati da un null.
    const covered = b?.coveredS ?? 0;
    total.push(b && covered > 0 ? round1(b.networkSeconds / covered) : null);
    peakLine.push(b?.peak ?? null);
    coverage.push(round1(Math.min(1, covered / plan.bucketSec) * 100) / 100);
    for (const m of modes) {
      const s = b?.byMode.get(m);
      series[m]?.push(b && covered > 0 ? round1((s ?? 0) / covered) : null);
    }
  }

  const v = new Array<number>(168).fill(0);
  const wArr = new Array<number>(168).fill(0);
  const nArr = new Array<number>(168).fill(0);
  for (const h of heat) {
    v[h.cell] = Number(h.v);
    wArr[h.cell] = Number(h.w);
    nArr[h.cell] = h.n;
  }

  // La mappa, tagliata per modalita' dalla stessa lettura.
  //
  // `geo: null` quando la geolocalizzazione non e' attiva — cioe' quando
  // NESSUNA riga del periodo porta un paese. L'interfaccia nasconde il widget
  // invece di disegnare una mappa vuota, che sarebbe indistinguibile da «non
  // viene nessuno da nessuna parte».
  //
  // Se invece e' attiva e non risolve, le barre esistono e sono tutte `XX`:
  // quello e' un DATO, ed e' il primo sintomo che il campo `ip` ha cambiato
  // significato. Nasconderlo sarebbe nascondere proprio il guasto.
  // LA MAPPA E IL KPI DEGLI UNICI ORA MISURANO PERIODI DIVERSI, e va detto
  // perche' e' una scelta e non una svista.
  //
  // La mappa conta le PERSONE del periodo selezionato — `DISTINCT ON
  // (player_id)`, un paese a testa, quello noto piu' recente — e segue il
  // selettore come il resto della pagina. `kpi.uniques` conta le persone dello
  // stesso periodo ma sui soli bucket chiusi.
  //
  // (Qui c'era scritto «la mappa guarda il giorno in corso». Era vero quando
  // la mappa era ferma a oggi, e non lo e' piu' da quando segue il selettore:
  // il commento nel riquadro della schermata lo dice, questo era rimasto
  // indietro. Un commento che descrive il codice di ieri e' peggio di nessun
  // commento — l'ho letto e stavo per descrivere male il dato.)
  //
  // Il difetto che questa separazione TOGLIE: finche' i due numeri dovevano
  // coincidere, bastava una riga di `player_day` committata fra le due query —
  // e a mezzanotte succede — perche' `assertPayload` rifiutasse l'intero
  // payload per un disaccordo che non era un difetto.
  const geoActive = geo.some((g) => g.cc !== null);
  const geoByMode = new Map<string, Array<{ cc: string; v: number }>>();
  if (geoActive) {
    for (const g of geo) {
      const list = geoByMode.get(g.mode_key) ?? [];
      list.push({ cc: g.cc ?? NOT_COLLECTED_COUNTRY, v: g.uniques });
      geoByMode.set(g.mode_key, list);
    }
    for (const list of geoByMode.values()) list.sort((a, b) => b.v - a.v || a.cc.localeCompare(b.cc));
  }
  const geoOf = (modeKey: string): OverviewPayload['geo'] => {
    const list = geoByMode.get(modeKey);
    if (!list || list.length === 0) return null;
    return {
      cc: list.map((x) => x.cc),
      v: list.map((x) => x.v),
      // L'istante a cui la mappa si riferisce. Il giorno civile in corso NON
      // e' finito: questi numeri crescono durante la giornata, ed e' voluto.
      asOf: Math.floor(now.getTime() / 1_000),
      // Contata adesso su `player_day`, non ripresa da un aggregato notturno.
      exact: true,
    };
  };

  // I giocatori di una modalita' sono un SOTTOINSIEME di quelli della rete.
  //
  // E' l'unica relazione che le due mappe devono rispettare, e si rompe in un
  // modo preciso: se il join per modalita' duplicasse una riga — un giocatore
  // su due server della stessa modalita' — quella modalita' conterebbe piu'
  // persone della rete intera. Un numero piu' grande del totale non ha
  // sintomi finche' qualcuno non li mette accanto.
  const networkTotal = (geoByMode.get('__network__') ?? []).reduce((a, x) => a + x.v, 0);
  for (const [key, list] of geoByMode) {
    if (key === '__network__') continue;
    const total = list.reduce((a, x) => a + x.v, 0);
    if (total > networkTotal) {
      throw new Error(
        `payload delle statistiche non valido: la modalita\` ${key} ha ${total} giocatori sulla mappa, la rete ne ha ${networkTotal}`,
      );
    }
  }

  // I KPI GUARDANO SOLO I BUCKET CHIUSI, e il contratto lo dice da sempre
  // («Massimo osservato nei soli bucket CHIUSI del periodo»). Finche' oggi era
  // fuori dalla finestra la distinzione non serviva; adesso serve, e senza,
  // due numeri sbaglierebbero in silenzio: il picco potrebbe venire da un
  // bucket misurato per dieci minuti, e la copertura dividerebbe i secondi
  // osservati per una giornata intera che deve ancora succedere.
  const closedMs = live.closedThrough * 1_000;
  const closed = cur.filter((b) => b.t * 1_000 < closedMs);
  const closedTo = new Date(closedMs);

  const kpi = kpiOf(closed, w.curFrom, closedTo, plan.bucketSec);
  // I GIOCATORI DISTINTI invece contano anche oggi, ed e' voluto: e' una
  // domanda sulle PERSONE passate nel periodo, e il periodo adesso comprende
  // il giorno in corso. Escluderlo era la stessa omissione che questo
  // intervento toglie, un piano piu' in giu'.
  kpi.uniques = distinctNow;

  // Il grafico degli unici mostra gli ultimi trenta giorni e li confronta con
  // i trenta precedenti, qualunque sia il range scelto: e' una domanda sulle
  // PERSONE, che si muove su scala di giorni, non sulla finestra del grafico
  // dell'online.
  // L'ASSE DEI GIORNI E' UNA GRIGLIA, come quello dei grafici a linea.
  //
  // Disegnando solo i giorni tornati dalla query, un giorno senza riga fa
  // FINIRE la serie invece di lasciare un buco — ed e' il caso normale del
  // giorno in corso: la riga giornaliera nasce quando il primo bucket orario
  // viene aggregato, quindi a mezzanotte e mezza non c'e' ancora. Il grafico
  // sembrava fermo a ieri, e non c'era modo di distinguerlo da un guasto del
  // campionamento.
  //
  // Il buco e' un valore: qui vale `null`, e la barra semplicemente non si
  // disegna.
  const dayAxis: number[] = [];
  {
    let d = shiftDays(romeMidnight(now), -daysOf(range));
    const last = romeMidnight(now);
    while (d.getTime() <= last.getTime()) {
      dayAxis.push(Math.floor(d.getTime() / 1_000));
      d = shiftDays(d, 1);
    }
  }
  const dailyByDay = new Map(daily.map((d) => [Number(d.day), d]));

  // Il giorno in corso viene dalla FONTE, non dal rollup: quest'ultimo lo
  // conosce solo dopo che la prima ora e' chiusa, e fino ad allora oggi
  // sarebbe un buco. Sovrascrive anche quando il rollup ce l'ha, perche' la
  // fonte e' comunque piu' avanti di un quarto d'ora.
  const todayKey = Math.floor(romeMidnight(now).getTime() / 1_000);
  if (liveUniques !== null) {
    dailyByDay.set(todayKey, { day: String(todayKey), uniques: liveUniques, final: false });
  }
  const recent = dayAxis.map((t) => dailyByDay.get(t) ?? null);

  const payload: OverviewPayload = {
    v: CONTRACT_VERSION,
    range,
    tz: ROME,
    bucketSec: plan.bucketSec,
    generatedAt: Math.floor(now.getTime() / 1_000),
    closedThrough: live.closedThrough,
    liveTail: live.liveTail,
    deltas,
    modes,
    labels: dictionaryLabels(labels),
    colors: dictionaryColors(labels),
    ...dictionaryFlags(labels),
    online: { t: axis, total, peak: peakLine, series, coverage },
    kpi,
    heatmap: { v, w: wArr, n: nArr },
    uniques: {
      t: dayAxis,
      v: recent.map((d) => d?.uniques ?? null),
      final: recent.map((d) => d?.final ?? false),
    },
    current,
    geo: geoOf('__network__'),
    geoEnabled: facts.geoEnabled,
    record: facts.record,
  };

  // ---------------------------------------------------------------------
  // I payload per modalita', dagli STESSI array. Niente qui tocca il
  // database: la scansione e' gia' stata pagata sopra.
  // ---------------------------------------------------------------------

  const heatModeCells = new Map<string, number[]>();
  for (const h of heatByMode) {
    let arr = heatModeCells.get(h.mode_key);
    if (!arr) {
      arr = new Array<number>(168).fill(0);
      heatModeCells.set(h.mode_key, arr);
    }
    arr[h.cell] = Number(h.v);
  }

  const dailyModeIndex = new Map<string, Map<number, { uniques: number; final: boolean }>>();
  for (const d of dailyByMode) {
    let byDay = dailyModeIndex.get(d.mode_key);
    if (!byDay) {
      byDay = new Map();
      dailyModeIndex.set(d.mode_key, byDay);
    }
    byDay.set(Number(d.day), { uniques: d.uniques, final: d.final });
  }

  // L'andamento per server, indicizzato modalita' -> server -> istante.
  const serverSecondsByMode = new Map<string, Map<string, Map<number, number>>>();
  // Stessa sostituzione delle righe di rete, e per la stessa ragione: qui le
  // parti si sommerebbero al loro totale un secondo livello piu' giu'.
  const closedServers =
    liveAt === null ? perServerSeries : perServerSeries.filter((r) => Number(r.t) !== liveAt);
  for (const r of [...closedServers, ...liveServers]) {
    let byServer = serverSecondsByMode.get(r.mode_key);
    if (!byServer) {
      byServer = new Map();
      serverSecondsByMode.set(r.mode_key, byServer);
    }
    let line = byServer.get(r.server_key);
    if (!line) {
      line = new Map();
      byServer.set(r.server_key, line);
    }
    line.set(Number(r.t), Number(r.player_seconds));
  }

  /**
   * La riga di un server sull'asse, o `null` se la modalita' ne ha uno solo.
   *
   * STESSA DIVISIONE DELLA RIGA DELLA MODALITA': secondi giocatore diviso la
   * copertura DI RETE dello stesso bucket. E' l'unico modo perche' le righe
   * sotto sommino esattamente la riga sopra — con denominatori diversi il
   * grafico mostrerebbe delle parti che non fanno il loro totale, e sarebbe
   * impossibile capire quale delle due misure e' quella giusta.
   *
   * UN SERVER SOLO NON PRODUCE NIENTE. La sua riga sarebbe identica al totale,
   * disegnata sopra di esso: due tratti coincidenti che si leggono come uno
   * spessore, e una legenda che promette una scomposizione che non c'e'.
   */
  const serverLinesOf = (m: string): { keys: string[]; series: Record<string, (number | null)[]> } | null => {
    const byServer = serverSecondsByMode.get(m);
    if (!byServer || byServer.size < 2) return null;
    const keys = [...byServer.keys()].sort();
    const out: Record<string, (number | null)[]> = {};
    for (const k of keys) {
      const line = byServer.get(k);
      out[k] = axis.map((t) => {
        const b = byT.get(t);
        const covered = b?.coveredS ?? 0;
        // Il buco resta un buco: se il bucket non e' stato rilevato non si
        // scrive zero, che vorrebbe dire «nessuno c'era».
        return b && covered > 0 ? round1((line?.get(t) ?? 0) / covered) : null;
      });
    }
    return { keys, series: out };
  };

  const perMode = new Map<string, ModePayload>();
  for (const m of modes) {
    if (want && !want.has(m)) continue;
    const line = series[m] ?? [];
    const kpiMode = kpiOf(closed, w.curFrom, closedTo, plan.bucketSec, (b) => b.byMode.get(m) ?? 0, false);
    kpiMode.uniques = distinctModeNow.get(m) ?? null;

    const byDay = dailyModeIndex.get(m);
    const modeHeat = heatModeCells.get(m) ?? new Array<number>(168).fill(0);

    perMode.set(m, {
      ...payload,
      mode: m,
      modes: [m],
      labels: dictionaryLabels(labels),
      colors: dictionaryColors(labels),
      ...dictionaryFlags(labels),
      // `total` E' la riga della modalita', non quella di rete: in questo
      // payload la domanda e' «quanti su duels», e mostrare il totale di rete
      // sotto l'etichetta di una modalita' sarebbe il disallineamento che il
      // §6.8 esiste per intercettare.
      online: { t: axis, total: line, peak: axis.map(() => null), series: { [m]: line }, coverage },
      kpi: kpiMode,
      // Denominatore e occorrenze restano quelli di RETE (vedi
      // `heatmapModeRows`): cambia solo il numeratore.
      heatmap: { v: modeHeat, w: wArr, n: nArr },
      uniques: {
        t: dayAxis,
        v: dayAxis.map((t) => byDay?.get(t)?.uniques ?? null),
        final: dayAxis.map((t) => byDay?.get(t)?.final ?? false),
      },
      // La ripartizione PER MODALITA' e' un riquadro della sola panoramica:
      // dentro una modalita' sarebbe un oggetto con una voce sola.
      current: null,
      // Quella per SERVER invece e' propria del dettaglio, ed e' il livello
      // sotto: la stessa domanda, un gradino piu' giu'.
      serverMix: perServer.get(m) ?? null,
      byServer: serverLinesOf(m),
      geo: geoOf(m),
      geoEnabled: facts.geoEnabled,
      // Il record e' della RETE, non della modalita': per una modalita' il
      // massimo non si decompone (vedi ModePayload), quindi qui e' nullo.
      record: null,
    });
  }

  return { overview: payload, perMode, queryMs, slowest };
}
