// Il calendario delle statistiche: giorni civili di Roma, finestre dei
// periodi, assi dei grafici e celle della heatmap. Tutto puro, niente
// database: si prova con un orologio finto.

import type { Range } from './contract.ts';

export const ROME = 'Europe/Rome';

type Plan = {
  /** La tabella da cui si legge. */
  source: '5m' | '1h' | '1d';
  /** Quante ore per punto quando si ri-bucketizza il livello orario. */
  hoursPerBucket?: number;
  /** Etichetta del bucket in secondi. Per `1y` e' nominale: un giorno non dura sempre 86400. */
  bucketSec: number;
  /** Ampiezza del periodo. In giorni civili, tranne il 24h. */
  days?: number;
  hours?: number;
};

/**
 * Mappatura range -> livello, scelta per tenere i punti fra 168 e 365.
 *
 * Un grafico e' largo circa mille pixel: piu' punti che pixel sono byte
 * buttati, e non aggiungono una sola informazione visibile.
 */
export const PLAN: Record<Range, Plan> = {
  '24h': { source: '5m', bucketSec: 300, hours: 24 },
  '7d': { source: '1h', hoursPerBucket: 1, bucketSec: 3_600, days: 7 },
  '30d': { source: '1h', hoursPerBucket: 2, bucketSec: 7_200, days: 30 },
  '90d': { source: '1h', hoursPerBucket: 6, bucketSec: 21_600, days: 90 },
  '1y': { source: '1d', bucketSec: 86_400, days: 365 },
};

export type Window = { curFrom: Date; curTo: Date };

/**
 * I formattatori si costruiscono UNA VOLTA.
 *
 * `new Intl.DateTimeFormat(...)` dentro una funzione chiamata in ciclo e' la
 * spesa nascosta piu' cara di questo file: costruirne uno costa piu' che
 * usarlo. L'asse di un anno ne creava 730.
 */
export const ROME_YMD = new Intl.DateTimeFormat('en-CA', {
  timeZone: ROME,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const ROME_FULL = new Intl.DateTimeFormat('en-CA', {
  timeZone: ROME,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** Lo scarto fra Roma e UTC a un dato istante, in millisecondi. */
function romeOffset(at: Date): number {
  const p = Object.fromEntries(ROME_FULL.formatToParts(at).map((x) => [x.type, x.value])) as Record<
    string,
    string
  >;
  const asUtc = Date.UTC(
    Number(p['year']),
    Number(p['month']) - 1,
    Number(p['day']),
    Number(p['hour']),
    Number(p['minute']),
    Number(p['second']),
  );
  return asUtc - at.getTime();
}

/**
 * La mezzanotte di Roma del giorno che contiene `at`, come istante.
 *
 * L'OFFSET SI MISURA, non si assume: due volte l'anno una costante
 * sbaglierebbe di un'ora, e sarebbe proprio nei giorni in cui conta. Si misura
 * due volte perche' la prima stima usa l'offset dell'istante sbagliato: presa
 * la mezzanotte come se fosse UTC, in ottobre cade dentro il fuso vecchio.
 * La seconda passata parte da un istante gia' quasi giusto e conferma.
 *
 * Prima lo scarto si ricavava da due `toLocaleString`, che costano ~170 µs a
 * chiamata: l'asse dell'1y ne faceva 730 e ci metteva 93 ms, ogni minuto, per
 * un risultato identico. Ora sono due `formatToParts` su formattatori gia'
 * costruiti, ~12 µs in tutto.
 */
export function romeMidnight(at: Date): Date {
  const [y, m, d] = ROME_YMD.format(at).split('-').map(Number) as [number, number, number];
  const naive = Date.UTC(y, m - 1, d);
  const first = naive - romeOffset(new Date(naive));
  const second = naive - romeOffset(new Date(first));
  return new Date(second);
}

/**
 * Sposta di N giorni CIVILI, che non e' la stessa cosa di N per 86400.
 *
 * Mezzogiorno come appiglio non e' un dettaglio: e' l'ora piu' lontana da
 * entrambi i cambi, quindi sommare giorni li' non puo' mai far scivolare la
 * data. Poi si torna alla mezzanotte del giorno cosi' raggiunto.
 */
export function shiftDays(midnight: Date, days: number): Date {
  const [y, m, d] = ROME_YMD.format(midnight).split('-').map(Number) as [number, number, number];
  return romeMidnight(new Date(Date.UTC(y, m - 1, d + days, 12)));
}

/**
 * La finestra corrente e quella precedente, della STESSA lunghezza.
 *
 * Sono la stessa lunghezza in giorni civili, non in secondi: due periodi che
 * attraversano un cambio ora hanno un'ora di differenza, ed e' giusto cosi'
 * — il confronto e' fra un mese e un mese, non fra 720 ore e 720 ore.
 */
export function windowOf(range: Range, now: Date): Window {
  const plan = PLAN[range];
  if (plan.hours !== undefined) {
    // Il 24h non si appoggia ai giorni: e' una finestra scorrevole allineata
    // al bucket, e il periodo precedente sono le 24 ore prima.
    const step = plan.bucketSec * 1_000;
    const curTo = new Date(Math.floor(now.getTime() / step) * step);
    const span = plan.hours * 3_600_000;
    return { curTo, curFrom: new Date(curTo.getTime() - span) };
  }
  const days = plan.days as number;
  // OGGI E' DENTRO, e prima non lo era.
  //
  // La finestra finisce alla mezzanotte che VERRA', non a quella passata. Con
  // `romeMidnight(now)` il giorno in corso restava fuori per intero: su 7g,
  // 30g e 90g — che hanno bucket sotto la giornata — il grafico si fermava
  // alle 23:00 di IERI, e nessuna spiegazione sul giorno parziale regge
  // davanti a quel vuoto. Era la prima cosa che si notava aprendo la pagina.
  //
  // Il motivo per cui oggi era escluso resta vero: l'ultimo bucket e'
  // parziale, e su un range a bucket giornaliero — l'1y — la media di mezza
  // giornata si legge come un crollo. Ma la risposta giusta e' DICHIARARLO,
  // non toglierlo: `liveEdge` taglia l'asse ad ADESSO invece che a stanotte,
  // `closedThrough` dice fin dove il dato e' definitivo, `liveTail` dice che
  // l'ultimo punto e' in formazione, e il grafico lo tratteggia.
  //
  // E' la stessa decisione gia' presa per i duels (`duelsWindowOf`), con le
  // stesse parole: adesso e' una regola sola per tutto il pannello.
  const curTo = shiftDays(romeMidnight(now), 1);
  return { curTo, curFrom: shiftDays(curTo, -days) };
}

/**
 * Dove finisce cio' che si puo' disegnare, e dove finisce cio' che e' definitivo.
 *
 * L'asse arriva fino alla fine della finestra — cioe' a stanotte — ma i bucket
 * dopo `now` non sono buchi: non sono ancora successi. Disegnarli come `null`
 * riempirebbe il bordo destro di tratteggio «non rilevato», che e' una frase
 * falsa su un pezzo di futuro; disegnarli come zero sarebbe peggio.
 *
 * Si taglia quindi al bucket che CONTIENE adesso, e si dice due cose distinte:
 *
 *   * `closedThrough` — la fine dell'ultimo bucket CHIUSO. Oltre, il numero
 *     puo' ancora cambiare;
 *   * `liveTail` — l'ultimo punto disegnato e' quel bucket in formazione.
 *
 * IL CONFINE SI CHIEDE ALL'ASSE, non si ricalcola. L'asse sa gia' dove
 * cominciano i bucket, comprese le giornate storte del cambio ora: un secondo
 * conto qui dentro sarebbe una seconda verita' che diverge il 26 ottobre.
 *
 * Sul 24h non cambia niente: la sua finestra si ferma gia' all'ultimo bucket
 * chiuso, quindi non c'e' nessuna coda viva da dichiarare.
 */
export function liveEdge(
  axis: readonly number[],
  w: Window,
  now: Date,
): { axis: number[]; closedThrough: number; liveTail: boolean } {
  const nowSec = Math.floor(now.getTime() / 1_000);
  const endSec = Math.floor(w.curTo.getTime() / 1_000);

  let lastIndex = -1;
  for (let i = 0; i < axis.length; i += 1) {
    if ((axis[i] as number) <= nowSec) lastIndex = i;
    else break;
  }
  if (lastIndex < 0) return { axis: [], closedThrough: endSec, liveTail: false };

  const kept = axis.slice(0, lastIndex + 1);
  const last = axis[lastIndex] as number;
  // La fine di quel bucket e' l'inizio del successivo. L'ultimo dell'asse
  // finisce con la finestra.
  const ends = lastIndex + 1 < axis.length ? (axis[lastIndex + 1] as number) : endSec;

  return ends <= nowSec
    ? { axis: kept, closedThrough: ends, liveTail: false }
    : { axis: kept, closedThrough: last, liveTail: true };
}

/**
 * Quanti giorni civili copre il range, per i widget che ragionano a giorni.
 *
 * IL SELETTORE IN ALTO GOVERNA TUTTA LA PAGINA. Prima il grafico degli unici
 * stava fisso a trenta giorni «qualunque sia il range scelto»: una scelta
 * difendibile in astratto — le persone si muovono su scala di giorni — e
 * sbagliata in pratica, perche' chi clicca «7g» si aspetta che la pagina
 * risponda, non che tre widget su quattro lo ignorino.
 *
 * Il 24h vale un giorno civile: un grafico a barre giornaliere su ventiquattro
 * ore ha una barra sola, ed e' la conseguenza onesta di quella scelta.
 */
export function daysOf(range: Range): number {
  const plan = PLAN[range];
  return plan.days ?? 1;
}

/**
 * La griglia dei punti, senza buchi.
 *
 * `t` e' regolare per costruzione: dove non c'e' un bucket il VALORE e' null,
 * non il punto a mancare. Una serie con l'asse dei tempi bucato costringe il
 * client a indovinare, e indovinare qui significa interpolare.
 */
function grid(from: Date, to: Date, bucketSec: number): number[] {
  const step = bucketSec * 1_000;
  const out: number[] = [];
  for (let t = from.getTime(); t < to.getTime(); t += step) out.push(Math.floor(t / 1_000));
  return out;
}

/**
 * L'asse dei tempi, ANCORATO ALLE MEZZANOTTI CIVILI.
 *
 * IL DIFETTO CHE QUESTA FUNZIONE ESISTE PER TOGLIERE. L'asse si costruiva a
 * passi fissi di `bucketSec` secondi dall'inizio della finestra, mentre le
 * chiavi che tornano da SQL sono ancorate alla mezzanotte civile di Roma
 * (`date_trunc('day', bucket, 'Europe/Rome')`). Le due cose coincidono finche'
 * i giorni durano tutti 86400 secondi. L'ultima domenica di ottobre ne dura
 * 90000: da li' in poi la griglia e' sfasata di un'ora rispetto ai dati,
 * `byT.get(t)` non trova piu' niente, e ogni serie diventa `null`.
 *
 * NON E' UN BUCO NEI DATI, ed e' questo che lo rendeva cattivo: le righe
 * c'erano tutte e venivano scartate nell'ultimo passaggio in JS. Con copertura
 * piena seminata su un anno, i punti che trovavano il loro dato erano 88 su
 * 365. Si vedeva come un range lungo vuoto mentre i corti funzionavano — cioe'
 * come un problema di raccolta, che manda a guardare dalla parte sbagliata.
 *
 * Il 24h non passa di qui: la sua finestra e' assoluta e allineata al bucket
 * da cinque minuti, e le sue chiavi sono istanti assoluti. Li' il passo fisso
 * e' la regola giusta, non una semplificazione.
 *
 * Per gli altri, ogni giorno civile porta `24 / hoursPerBucket` punti, a
 * scarti ASSOLUTI dalla sua mezzanotte — che e' esattamente come SQL li
 * costruisce. Il conto per giorno non cambia nei giorni storti: in quello di
 * 25 ore due ore locali finiscono nello stesso punto, in quello di 23 un
 * punto resta senza dato, ed e' giusto che si veda vuoto perche' quell'ora
 * non e' esistita.
 */
export function axisOf(range: Range, w: Window): number[] {
  const plan = PLAN[range];
  if (plan.source === '5m') return grid(w.curFrom, w.curTo, plan.bucketSec);

  const out: number[] = [];
  if (plan.source === '1d') {
    for (let day = w.curFrom; day.getTime() < w.curTo.getTime(); day = shiftDays(day, 1)) {
      out.push(Math.floor(day.getTime() / 1_000));
    }
    return out;
  }

  // SI CAMMINA SULLE ORE VERE E SI PRENDE LA PRIMA DI OGNI BLOCCO LOCALE.
  //
  // Non «mezzanotte piu' k volte il passo»: quel conto assume che il giorno
  // abbia 24 ore. Camminando invece sulle ore realmente esistenti e cambiando
  // punto quando cambia il blocco locale, il giorno di 23 ore ne produce uno
  // in meno e quello di 25 uno di piu' dove l'ora si ripete — che e'
  // esattamente cio' che la query raggruppa, e per la stessa ragione.
  const hours = plan.hoursPerBucket as number;
  let block = -1;
  let day = -1;
  for (let t = w.curFrom.getTime(); t < w.curTo.getTime(); t += 3_600_000) {
    const p = romeParts(new Date(t));
    const b = Math.floor(p.hour / hours) * hours;
    if (b !== block || p.day !== day) {
      out.push(Math.floor(t / 1_000));
      block = b;
      day = p.day;
    }
  }
  return out;
}

/** Le componenti dell'ora locale, forzate a 00-23: `hour12: false` da' «24» a mezzanotte. */
const ROME_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: ROME,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
});

/** Giorno e ora LOCALI di un istante. Serve a camminare sull'orologio di Roma. */
function romeParts(at: Date): { day: number; hour: number } {
  const p = Object.fromEntries(ROME_PARTS.formatToParts(at).map((x) => [x.type, x.value])) as Record<
    string,
    string
  >;
  return { day: Number(p['day']), hour: Number(p['hour']) };
}

/** La cella 7x24 di un istante: `(isodow - 1) * 24 + ora`, come in SQL. */
export function cellOf(epochSec: number): number {
  const p = Object.fromEntries(
    ROME_PARTS.formatToParts(new Date(epochSec * 1_000)).map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  const d = new Date(
    Date.UTC(Number(p['year']), Number(p['month']) - 1, Number(p['day']), Number(p['hour'])),
  );
  const isodow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  return (isodow - 1) * 24 + d.getUTCHours();
}

/**
 * Quante volte ogni cella ricorre NEL PERIODO.
 *
 * Si cammina di un'ora UTC per volta, e non e' un dettaglio: cosi' l'ora
 * saltata di marzo esce con zero occorrenze e quella ripetuta di ottobre con
 * due, che e' la verita'. Al massimo 8.760 giri sull'anno, una volta per
 * payload.
 */
export function nominalCells(from: Date, to: Date): number[] {
  const out = new Array<number>(168).fill(0);
  for (let t = from.getTime(); t < to.getTime(); t += 3_600_000) {
    const c = cellOf(Math.floor(t / 1_000));
    out[c] = (out[c] ?? 0) + 1;
  }
  return out;
}
