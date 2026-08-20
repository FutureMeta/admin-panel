// Il contratto del payload delle statistiche. Fase 2, §6.
//
// REGOLE CHE NON SI NEGOZIANO, perche' ognuna corrisponde a un modo preciso in
// cui il pannello mentirebbe:
//
//  1. UNA SOLA statistica per la linea: la MEDIA, coerente a ogni livello di
//     zoom. Il massimo viaggia come seconda serie e si disegna come banda, mai
//     come la linea. Se la linea fosse il massimo del bucket, lo stesso
//     istante varrebbe 1240 nel range 24h, 1310 nel 30g e 1480 nell'1y, e
//     l'utente lo scoprirebbe da solo.
//  2. IL BUCO E' UN VALORE. `null` significa «non rilevato», `0` significa
//     «rete davvero vuota». Non si interpola mai fra due punti separati da un
//     `null`: interpolare cancella per sempre l'informazione che il dato non
//     c'era, ed e' l'unica operazione irreversibile di tutta la catena.
//  3. `coverage` e' UNO SOLO per bucket, non uno per modalita': la copertura
//     e' una proprieta' del ciclo di raccolta, non di chi c'era dentro.
//  4. Il totale di rete e' MEMORIZZATO, non derivato: `max` e
//     `count(distinct)` non si decompongono.
//  5. Il breakdown chiude a 100% perche' `__transit__` e `__unknown__` sono
//     serie esplicite e visibili. Senza, la torta non somma mai al totale e il
//     primo che se ne accorge «aggiusta» normalizzando le percentuali — cioe'
//     spalma i giocatori non classificati sulle modalita' vere.
//  6. Nessun massimo viaggia da solo: sempre con l'istante e con la copertura
//     del bucket in cui e' avvenuto.

/** Nella CHIAVE di cache, non solo nel corpo: una cache non si migra. */
export const CONTRACT_VERSION = 2;

export type Range = '24h' | '7d' | '30d' | '90d' | '1y';

/**
 * Enum CHIUSO, e non per pigrizia.
 *
 * Niente `?days=N` e niente `?from=&to=`: lo spazio delle chiavi di cache deve
 * restare finito ed enumerabile a priori. Aggiungere un range e' una modifica
 * server, cioe' una decisione di costo presa da qualcuno.
 */
export const RANGES: readonly Range[] = ['24h', '7d', '30d', '90d', '1y'] as const;

export function isRange(v: unknown): v is Range {
  return typeof v === 'string' && (RANGES as readonly string[]).includes(v);
}

/**
 * Attiva, e non risolta. Un secchiello che cresce e' il primo sintomo che il
 * campo `ip` ha cambiato semantica: e' un DATO, e si mostra.
 */
export const UNRESOLVED_COUNTRY = 'XX';

/**
 * Non rilevata: la geolocalizzazione era spenta quando quel giocatore e' stato
 * visto. NON E' LA STESSA COSA DI `XX`, e tenerle separate non e' pedanteria:
 * il giorno in cui si accende la funzione, tutto lo storico precedente e'
 * senza paese, e confonderlo con «non risolto» produrrebbe una barra XX
 * all'ottanta per cento — cioe' l'allarme che XX esiste per dare, acceso da
 * un guasto che non c'e'.
 */
export const NOT_COLLECTED_COUNTRY = '--';

export type Kpi = {
  /** Media normalizzata sul profilo orario. `null` se la copertura e' zero. */
  avg: number | null;
  /** Massimo osservato nei soli bucket CHIUSI del periodo. */
  peak: number | null;
  /** Epoch in secondi. Un massimo senza il suo istante non e' verificabile. */
  peakAt: number | null;
  /** 0..1, copertura del bucket in cui il massimo e' avvenuto. */
  peakCoverage: number;
  /** Giocatori DISTINTI nel periodo. Non la somma degli unici giornalieri. */
  uniques: number | null;
  /** Secondi osservati / secondi nominali del periodo. */
  coverage: number;
};

export type Series = {
  /** Epoch in secondi, crescente e SENZA buchi: il buco e' un null nei valori. */
  t: number[];
  /** La riga di rete, memorizzata. */
  total: (number | null)[];
  /** Massimo del bucket sulla riga di rete. Si disegna come banda. */
  peak: (number | null)[];
  /** Include sempre `__transit__` e `__unknown__`. */
  series: Record<string, (number | null)[]>;
  /** 0..1, uno per bucket. */
  coverage: number[];
};

export type OverviewPayload = {
  v: typeof CONTRACT_VERSION;
  range: Range;
  tz: 'Europe/Rome';
  bucketSec: number;
  /** Quando il server ha prodotto QUESTI byte. */
  generatedAt: number;
  /** Ultimo istante definitivo: fine dell'ultimo bucket chiuso. */
  closedThrough: number;
  /** L'ultimo punto e' un bucket in corso: la UI lo tratteggia. */
  liveTail: boolean;
  /** Cadenze di campionamento distinte presenti nel range. */
  deltas: number[];
  /** Ordine di disegno. NON fidarsi dell'ordine delle chiavi di `series`. */
  modes: string[];
  labels: Record<string, string>;

  online: Series;
  kpi: Kpi;

  /** 7x24, cella = (isodow-1)*24 + hour. TRE array, mai la media gia' divisa. */
  heatmap: { v: number[]; w: number[]; n: number[] };

  /**
   * Unici per giorno civile del PERIODO. `t` e' la mezzanotte locale.
   *
   * Segue il selettore come tutto il resto della pagina: chi clicca «7g» si
   * aspetta che la pagina risponda, non che un widget continui a mostrare
   * trenta giorni per conto suo.
   */
  uniques: { t: number[]; v: (number | null)[]; final: boolean[] };

  /** `null` quando non c'e' nessun paese nel periodo. Vedi `geoEnabled`. */
  geo: { cc: string[]; v: number[]; asOf: number; exact: boolean } | null;

  /**
   * Se la geolocalizzazione e' ACCESA, indipendentemente dal fatto che questo
   * periodo abbia dati.
   *
   * SERVE A NON MENTIRE NEL SEGNAPOSTO. `geo: null` da solo confonde due
   * situazioni diverse: «la funzione non e' attiva» e «e' attiva da poco, e i
   * giorni chiusi che questo periodo guarda sono precedenti all'accensione».
   * Senza questo campo l'interfaccia dice la prima anche quando vale la
   * seconda, cioe' manda a cercare una configurazione che c'e' gia'.
   */
  geoEnabled: boolean;

  /**
   * Il massimo di giocatori contemporanei MAI osservato, con il suo istante.
   *
   * NON DIPENDE DAL RANGE: e' l'unico numero del payload che guarda tutto lo
   * storico invece della finestra scelta, ed e' voluto — «record» significa
   * quello. Viene dalla riga di rete memorizzata, quindi e' esatto: il picco
   * di rete non e' la somma dei picchi (regola 4).
   *
   * `since` dice DA QUANDO si guarda, e non e' un ornamento: prima di quella
   * data non esiste storico, e un «record di sempre» calcolato su tre giorni
   * di raccolta e' un record di tre giorni. Chi legge deve poterlo sapere.
   *
   * `null` finche' non c'e' nemmeno un giorno con dati.
   */
  record: { players: number; at: number | null; since: number } | null;
};

/**
 * Il payload di UNA modalita'. Stessa forma, una serie sola.
 *
 * IL PICCO QUI E' SEMPRE `null`, ed e' una conseguenza aritmetica, non una
 * funzione mancante. `players_max` e' memorizzato per SERVER (la modalita' si
 * risolve in lettura, emendamento E2, cosi' che riclassificare un server
 * riscriva anche il passato). Il picco di una modalita' con tre server e' il
 * massimo nel tempo della SOMMA dei tre, e da tre massimi presi
 * separatamente quella somma non si ricostruisce: il massimo dei tre e' un
 * limite inferiore, la loro somma un limite superiore, e nessuno dei due e' il
 * numero. Il massimo di rete resta esatto perche' quello e' memorizzato come
 * riga propria (`server_id = 0`), che e' esattamente la regola 4.
 *
 * Mostrare `max(players_max)` etichettato «picco» sarebbe la stessa bugia che
 * la regola 4 esiste per impedire, con l'aggravante di essere plausibile.
 */
export type ModePayload = Omit<OverviewPayload, 'modes'> & {
  mode: string;
  modes: [string];
};

export class PayloadInvalid extends Error {
  constructor(problems: string) {
    super(`payload delle statistiche non valido: ${problems}`);
    this.name = 'PayloadInvalid';
  }
}

/**
 * Le invarianti si verificano alla COSTRUZIONE, non alla lettura.
 *
 * Il fallimento tipico di un contratto colonnare e' il disallineamento di
 * lunghezza fra due array paralleli: il grafico disegna, non lancia, e mostra
 * numeri corretti sotto l'etichetta sbagliata. E' il difetto peggiore di
 * tutti, perche' non ha sintomi.
 *
 * Un build che fallisce lascia in cache la chiave vecchia: servire un payload
 * vecchio e' meno grave che servirne uno rotto.
 */
export function assertPayload(p: OverviewPayload | ModePayload): void {
  const n = p.online.t.length;
  const bad: string[] = [];

  for (const [k, a] of [
    ['total', p.online.total],
    ['peak', p.online.peak],
    ['coverage', p.online.coverage],
  ] as const) {
    if (a.length !== n) bad.push(`${k} ha ${a.length} valori invece di ${n}`);
  }
  for (const [k, a] of Object.entries(p.online.series)) {
    if (a.length !== n) bad.push(`series.${k} ha ${a.length} valori invece di ${n}`);
  }
  if (p.heatmap.v.length !== 168 || p.heatmap.w.length !== 168 || p.heatmap.n.length !== 168) {
    bad.push('la heatmap non e` 7x24');
  }
  if (p.uniques.v.length !== p.uniques.t.length) bad.push('uniques disallineata');
  if (p.geo && p.geo.cc.length !== p.geo.v.length) bad.push('geo disallineata');
  for (const m of p.modes) {
    if (!(m in p.online.series)) bad.push(`la modalita\` ${m} e\` nell'ordine ma non nei dati`);
  }

  // I1 — il breakdown chiude sul totale. La tolleranza copre gli
  // arrotondamenti a un decimale di ogni serie, non un errore vero.
  for (let i = 0; i < n; i += 1) {
    const total = p.online.total[i];
    if (total === null || total === undefined) continue;
    let sum = 0;
    for (const m of p.modes) {
      if (m === '__network__') continue;
      sum += p.online.series[m]?.[i] ?? 0;
    }
    if (Math.abs(sum - total) > 0.05 * p.modes.length + 0.5) {
      bad.push(`la somma delle modalita\` non fa il totale al punto ${i}: ${sum} contro ${total}`);
      break;
    }
  }

  // I5, nella forma che gli spetta ORA.
  //
  // L'invariante nasce per impedire un errore di UNITA': «37.800 italiani»
  // accanto a «5.000 giocatori» sullo stesso schermo, con scritto «giocatori»
  // in entrambe le legende — cioe' una mappa contata in giocatori-GIORNO
  // accanto a un KPI contato in giocatori.
  //
  // La mappa guarda UN SOLO GIORNO CIVILE, quello in corso, come chiede il
  // design («Giocatori unici oggi»). Su un giorno solo giocatori e
  // giocatori-giorno coincidono per definizione, e l'errore di unita' non e'
  // costruibile. Confrontarla con `kpi.uniques`, che copre il PERIODO e
  // esclude apposta il giorno in corso, sarebbe confrontare due popolazioni
  // diverse e far fallire il payload per un disaccordo che non e' un difetto.
  //
  // Resta da difendere che i conteggi siano conteggi.
  if (p.geo) {
    if (p.geo.v.some((v) => !Number.isInteger(v) || v < 0)) {
      bad.push('la mappa contiene valori che non sono conteggi di persone');
    }
  }

  if (bad.length > 0) throw new PayloadInvalid(bad.join('; '));
}

/** Conteggi di persone: il decimale in piu' sono solo byte sul filo. */
export function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
