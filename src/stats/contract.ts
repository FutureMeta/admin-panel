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
export const CONTRACT_VERSION = 3;

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
  /**
   * Ultimo istante definitivo: fine dell'ultimo bucket chiuso.
   *
   * Con `liveTail` e' anche l'INIZIO dell'ultimo punto disegnato, che e' lo
   * stesso istante detto dai due lati. `assertPayload` lo verifica: i due
   * campi descrivono lo stesso fatto e non possono divergere.
   */
  closedThrough: number;
  /**
   * L'ultimo punto e' un bucket in corso: il grafico lo tratteggia.
   *
   * NON E' UN'ANNOTAZIONE FACOLTATIVA. Un bucket aperto porta la media di
   * quello che si e' visto finora: sull'1y, alle otto del mattino, la colonna
   * di oggi e' la media della notte, piu' bassa di qualunque giorno pieno
   * accanto a lei. Disegnata come le altre si legge come un crollo, e nella
   * figura non c'e' niente che dica il contrario.
   *
   * Vale `false` solo dove l'ultimo bucket della finestra e' completo: oggi
   * il 24h, la cui finestra si ferma all'ultimo intervallo da cinque minuti
   * gia' chiuso.
   */
  liveTail: boolean;
  /** Cadenze di campionamento distinte presenti nel range. */
  deltas: number[];
  /** Ordine di disegno. NON fidarsi dell'ordine delle chiavi di `series`. */
  modes: string[];

  /**
   * I nomi di TUTTE le modalita' conosciute, non solo di quelle in `modes`.
   *
   * `modes` e' l'elenco delle modalita' presenti nella serie di QUESTO range:
   * cambia col selettore, ed e' vuoto su un range il cui storico non esiste
   * ancora. Ritagliare i nomi su quell'elenco faceva ripiegare la schermata
   * sulla chiave grezza — «arena» minuscolo al posto di «Arena» — e solo su
   * certi periodi, cioe' nel modo piu' difficile da attribuire a una causa.
   *
   * Il dizionario e' piccolo (una riga per modalita') e non dipende dal
   * range: mandarlo intero costa niente e toglie una classe di difetti.
   */
  labels: Record<string, string>;

  /**
   * Il colore scelto dall'operatore per ogni modalita', da `stats.mode`.
   *
   * VIENE DAL DIZIONARIO, non da una posizione in un array. Assegnarlo per
   * indice sull'elenco del range significa che la stessa modalita' cambia
   * colore cambiando periodo, e che entrare una modalita' nuova ricolora
   * tutte quelle dopo di lei: il colore smette di identificare qualcosa.
   *
   * Assente per le modalita' a cui nessuno ne ha ancora dato uno: li' la
   * schermata ripiega, ma su un ordine stabile.
   */
  colors: Record<string, string>;

  /**
   * Le modalita' che l'operatore ha marcato come da NON disegnare.
   *
   * Restano in `modes`, in `series` e nella distribuzione: cambia solo cosa la
   * schermata accende all'apertura, e la legenda le elenca comunque perche'
   * altrimenti non ci sarebbe modo di riaccenderle. NESSUN TOTALE CAMBIA — la
   * riga di rete e' misurata, non sommata dalle modalita'.
   */
  hidden: string[];

  /**
   * Le modalita' che non sono una FETTA della distribuzione.
   *
   * La torta deve chiudere sul totale: togliere una fetta senza dirlo sposta
   * ogni percentuale delle altre, in silenzio e in modo plausibile. Quindi il
   * riquadro le esclude e ne dichiara la somma sotto, come gia' fa la mappa
   * con i paesi non attribuiti.
   */
  outOfBreakdown: string[];

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

  /**
   * La popolazione ADESSO, per modalita'. Non dipende dal range.
   *
   * La distribuzione risponde a «chi c'e' in questo momento», non «com'e'
   * andato il periodo»: e' l'unico riquadro della pagina che il selettore in
   * alto non governa, e il design lo dice nel sottotitolo («Popolazione
   * corrente»).
   *
   * Prima usciva dall'ultimo punto della serie del range selezionato: su 24h
   * era un bucket da cinque minuti — quasi «adesso» — ma su un anno era la
   * MEDIA DI UN GIORNO INTERO presentata come popolazione corrente. E
   * cambiava scegliendo un altro periodo, il che rendeva evidente che
   * qualcosa non tornava senza dire cosa.
   *
   * `null` quando non c'e' nessun ciclo abbastanza recente.
   */
  current: { at: number; byMode: Record<string, number> } | null;

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

  /**
   * La popolazione di ADESSO, spezzata per server dentro questa modalita'.
   *
   * E' il gemello di `current` sulla panoramica, un livello piu' giu': li' la
   * torta divide la rete per modalita', qui divide la modalita' per server.
   * Quasi tutte ne hanno piu' di uno, e «duels ha 286 giocatori» non dice se
   * sono tutti su un server o sparsi su sei — che e' esattamente la domanda
   * che si fa aprendo il dettaglio.
   *
   * `null` quando il campionamento non ha ancora chiuso un bucket da cinque
   * minuti: e' diverso da «nessun giocatore», e la schermata lo scrive.
   */
  serverMix: { at: number; byServer: Record<string, number> } | null;

  /**
   * L'andamento nel tempo spezzato per SERVER, allineato a `online.t`.
   *
   * Stessa relazione che la panoramica ha con la rete: li' la riga del totale
   * piu' una per ogni modalita', qui la riga della modalita' (`online.total`)
   * piu' una per ogni suo server. Un gradino nella curva di duels puo' voler
   * dire che e' calata la modalita' o che si e' spento un server, e da una
   * riga sola le due cose non si distinguono.
   *
   * LE PARTI SOMMANO IL TOTALE perche' il denominatore e' lo stesso — la
   * copertura di rete del bucket, come ovunque. Con un denominatore per
   * server, righe e totale non tornerebbero e non ci sarebbe modo di sapere
   * quale delle due misure e' quella giusta.
   *
   * `null` quando la modalita' ha UN SOLO server: quella riga sarebbe identica
   * al totale e disegnata sopra di esso, cioe' uno spessore invece di una
   * scomposizione, con una legenda che promette una divisione che non c'e'.
   */
  byServer: { keys: string[]; series: Record<string, (number | null)[]> } | null;
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

  // LA CODA VIVA E IL CONFINE DEL DEFINITIVO DEVONO ACCORDARSI.
  //
  // Sono due campi che descrivono lo stesso fatto da due lati: `liveTail` dice
  // che l'ultimo punto e' un bucket ancora aperto, `closedThrough` dice fin
  // dove il dato non cambia piu'. Se divergono, il grafico tratteggia un punto
  // che il resto del pannello considera definitivo — oppure, peggio, disegna
  // pieno un bucket che sta ancora riempiendosi.
  //
  // Nessuno dei due, sbagliato, produce un errore: producono una figura che si
  // legge benissimo.
  const lastT = p.online.t.at(-1);
  if (lastT !== undefined) {
    if (p.liveTail && p.closedThrough !== lastT) {
      bad.push(`liveTail dice che l'ultimo bucket e' aperto, ma closedThrough non e' il suo inizio`);
    }
    if (!p.liveTail && p.closedThrough <= lastT) {
      bad.push(`senza liveTail l'ultimo bucket e' chiuso, quindi closedThrough deve stare oltre di lui`);
    }
  }
  if (p.geo && p.geo.cc.length !== p.geo.v.length) bad.push('geo disallineata');
  for (const m of p.modes) {
    if (!(m in p.online.series)) bad.push(`la modalita\` ${m} e\` nell'ordine ma non nei dati`);
  }

  // Le righe per server: stesso asse, e l'ordine di disegno deve trovare i
  // dati. E' lo stesso controllo di sopra un gradino piu' giu', e serve per
  // la stessa ragione: un array corto disegna, non lancia.
  const byServer = 'byServer' in p ? p.byServer : null;
  if (byServer) {
    if (byServer.keys.length < 2) {
      bad.push(`byServer ha ${byServer.keys.length} server: sotto due non si scompone niente`);
    }
    for (const [k, a] of Object.entries(byServer.series)) {
      if (a.length !== n) bad.push(`byServer.${k} ha ${a.length} valori invece di ${n}`);
    }
    for (const k of byServer.keys) {
      if (!(k in byServer.series)) bad.push(`il server ${k} e\` nell'ordine ma non nei dati`);
    }
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
  // LA MAPPA CONTA PERSONE, non giocatori-giorno: `DISTINCT ON (player_id)`
  // sul periodo, un paese a testa. L'errore di unita' quindi non e'
  // costruibile, ed e' questo che l'invariante deve difendere.
  //
  // Non si confronta con `kpi.uniques` benche' oggi guardino lo stesso
  // periodo: quello si ferma ai bucket chiusi e la mappa arriva ad adesso, e
  // basta una riga di `player_day` committata fra le due query — a mezzanotte
  // succede — per far fallire il payload su un disaccordo che non e' un
  // difetto.
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
