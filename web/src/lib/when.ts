// Quando è successo, non solo a che ora.
//
// IL DIFETTO CHE QUESTO MODULO TOGLIE. Il picco del periodo scriveva «alle
// 20:00». Sul range 24h, guardato a mezzogiorno, quel picco è di IERI sera —
// ma l'etichetta è identica a quella di un picco di stamattina, e per capire
// quale dei due si sta leggendo bisogna sapere che il 24h è una finestra
// scorrevole e non «da mezzanotte». Nessuno lo sa guardando, e l'errore è
// silenzioso: si legge un numero di ieri credendolo di oggi.
//
// Sui range lunghi il problema è peggiore, perché l'ora da sola non identifica
// niente: «alle 20:00» in un periodo di novanta giorni indica novanta istanti.
//
// IL GIORNO SI DICE SEMPRE, anche quando è oggi. Dirlo solo quando non è oggi
// sembra un risparmio, ma rende l'assenza del giorno un'informazione da
// decodificare — e chi non conosce la regola legge l'etichetta breve come
// «l'ora e basta», cioè torna al difetto di partenza.

const ROME = 'Europe/Rome';

/** `YYYY-MM-DD` del giorno CIVILE romano che contiene questo istante. */
const CIVIL_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: ROME,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const TIME = new Intl.DateTimeFormat('it-IT', {
  timeZone: ROME,
  hour: '2-digit',
  minute: '2-digit',
});

/** «19 ago» — il mese abbreviato, perché il riquadro è stretto. */
const SHORT_DATE = new Intl.DateTimeFormat('it-IT', { timeZone: ROME, day: 'numeric', month: 'short' });

/** «19 ago 2025» — solo quando l'anno non è quello corrente. */
const SHORT_DATE_YEAR = new Intl.DateTimeFormat('it-IT', {
  timeZone: ROME,
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/**
 * Quanti giorni civili separano due istanti, nel fuso di Roma.
 *
 * SI SOTTRAGGONO DATE, NON ISTANTI. `(a - b) / 86400000` sbaglia due volte
 * l'anno: nel giorno di 23 ore due istanti a 23 ore di distanza cadono in
 * giorni diversi ma la divisione dà 0, e nel giorno di 25 ore succede il
 * contrario. Qui i due `YYYY-MM-DD` si ricompongono come mezzanotte UTC —
 * dove i giorni durano tutti 86400 secondi per costruzione — e la differenza
 * è esatta.
 */
function civilDaysBetween(a: Date, b: Date): number {
  const toUtcMidnight = (d: Date): number => {
    const [y, m, day] = CIVIL_DAY.format(d).split('-').map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, day);
  };
  return Math.round((toUtcMidnight(a) - toUtcMidnight(b)) / 86_400_000);
}

/**
 * «oggi alle 20:00», «ieri alle 20:00», «19 ago alle 20:00».
 *
 * L'anno compare solo quando è diverso da quello corrente: su un range di un
 * anno «19 ago» può essere di due agosti diversi, e senza l'anno la data
 * sembra precisa pur non essendolo.
 */
export function dayAndTime(epochSec: number, now: Date = new Date()): string {
  const at = new Date(epochSec * 1000);
  const time = TIME.format(at);
  const delta = civilDaysBetween(at, now);

  if (delta === 0) return `oggi alle ${time}`;
  if (delta === -1) return `ieri alle ${time}`;
  // Il futuro non dovrebbe capitare — un picco è sempre passato — ma un
  // orologio storto sul server di gioco lo produce, e «domani alle 20:00» è
  // un sintomo leggibile, mentre una data nuda non si distingue da un dato
  // buono.
  if (delta === 1) return `domani alle ${time}`;

  const sameYear = CIVIL_DAY.format(at).slice(0, 4) === CIVIL_DAY.format(now).slice(0, 4);
  const date = sameYear ? SHORT_DATE.format(at) : SHORT_DATE_YEAR.format(at);
  return `${date} alle ${time}`;
}

/** «gio», minuscolo abbreviato: sul 7g serve il giorno della settimana. */
const WEEKDAY_HOUR = new Intl.DateTimeFormat('it-IT', {
  timeZone: ROME,
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

/**
 * L'etichetta di una tacca dell'asse dei tempi.
 *
 * SI SCEGLIE DAL PASSO FRA UNA TACCA E L'ALTRA, non dal range: è il passo a
 * dire quale parte dell'istante distingue una tacca dalla successiva.
 * L'asse ne mostra otto qualunque sia il periodo, quindi con un anno di dati
 * il passo è di quarantasei giorni e con ventiquattro ore è di tre.
 *
 * Prima erano sempre ore e minuti. Su un anno significava otto «00:00»
 * identiche — un asse che non ordina niente e che sembra un errore di
 * caricamento; su trenta e novanta giorni, ore senza data, cioè etichette che
 * sembrano precise e non identificano nulla.
 *
 *  * meno di sei ore di passo: l'ora basta, il giorno è sempre lo stesso o
 *    quasi, e scriverlo ruberebbe spazio a otto tacche affiancate;
 *  * fino a due giorni: il giorno della settimana con l'ora, perché il 7g
 *    salta di ventun ore per tacca e l'ora da sola non dice quale giorno;
 *  * oltre: la data, perché l'ora ha smesso di distinguere.
 */
export function axisLabel(epochSec: number, spacingSec: number): string {
  const at = new Date(epochSec * 1000);
  if (spacingSec < 6 * 3_600) return TIME.format(at);
  if (spacingSec < 48 * 3_600) return WEEKDAY_HOUR.format(at);
  return SHORT_DATE.format(at);
}

/**
 * L'etichetta di una TACCA d'asse, decisa dall'AMPIEZZA DEL PERIODO.
 *
 * NON DALLA DISTANZA FRA LE TACCHE, ed è la correzione di un difetto che si
 * vedeva solo su certi schermi. Quante tacche entrano sull'asse lo decide la
 * larghezza del riquadro, quindi con la distanza fra le tacche la stessa
 * schermata si etichettava in due modi diversi a seconda del monitor: la
 * panoramica a trenta giorni scriveva la data fino a circa 2400 pixel e
 * «gio 14» oltre. Sotto ai duels — trenta bucket giornalieri invece di
 * trecentosessanta da due ore — il salto non avveniva, e le due schermate
 * finivano per dire la stessa cosa in due modi.
 *
 * L'ampiezza invece è una proprietà del PERIODO: non cambia con la finestra
 * del browser, e non cambia con la grana dei bucket.
 *
 *  * fino a due giorni: l'ora basta, il giorno è sempre lo stesso o quasi;
 *  * fino a due settimane: il giorno della settimana con l'ora, perché su
 *    sette giorni «14:00» indica sette istanti diversi;
 *  * oltre: la data, perché l'ora ha smesso di distinguere qualsiasi cosa.
 */
export function tickLabel(epochSec: number, spanSec: number): string {
  const at = new Date(epochSec * 1000);
  if (spanSec <= 48 * 3_600) return TIME.format(at);
  if (spanSec <= 16 * 24 * 3_600) return WEEKDAY_HOUR.format(at);
  return SHORT_DATE.format(at);
}

/**
 * L'etichetta di un BUCKET, che non è sempre un istante.
 *
 * «20 gennaio alle 00:00» su una colonna che vale l'intero 20 gennaio è falso
 * due volte: l'ora non significa niente — il bucket copre ventiquattro ore —
 * e suggerisce che il valore appartenga a quel minuto. Su un bucket
 * settimanale è peggio ancora: quel lunedì a mezzanotte è solo il bordo
 * sinistro di sette giorni.
 *
 * Il passo lo dice la GRIGLIA, non il nome del range: un mese non dura sempre
 * lo stesso e un giorno di cambio ora dura 23 o 25 ore.
 */
export function bucketLabel(epochSec: number, spacingSec: number, now: Date = new Date()): string {
  if (spacingSec < 24 * 3_600) return dayAndTime(epochSec, now);

  const at = new Date(epochSec * 1000);
  const sameYear = CIVIL_DAY.format(at).slice(0, 4) === CIVIL_DAY.format(now).slice(0, 4);
  const date = sameYear ? SHORT_DATE.format(at) : SHORT_DATE_YEAR.format(at);

  // Sopra i due giorni di passo si sta guardando una settimana, e dirlo cambia
  // come si legge il numero accanto: settemila partite in un giorno e in una
  // settimana sono due fatti molto diversi.
  return spacingSec >= 2 * 24 * 3_600 ? `settimana del ${date}` : date;
}
