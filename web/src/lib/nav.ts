// Le schermate del pannello: dove stanno, come si chiamano, chi le vede.
//
// UNA TABELLA SOLA, E QUESTO E' IL PUNTO. Le stesse schermate erano elencate a
// mano in quattro posti — la barra laterale, il breadcrumb della barra in
// alto, i comandi della palette ⌘K, e l'elenco di chi ha un selettore del
// periodo — e ogni elenco si e' dimenticato qualcosa, in tre occasioni
// diverse:
//
//   * il breadcrumb aveva due `startsWith` e poi «Console» per tutto il resto,
//     quindi ogni schermata aggiunta dopo scriveva «Console › Console»;
//   * il periodo era un elenco di ESCLUSIONI — «tutto tranne utenti e
//     registro» — quindi Modes e Maps sono nate con sopra «24h · 7g · 30g»,
//     che li' non governa niente;
//   * la palette non nominava la Panoramica network e il Dettaglio modalita',
//     che esistono da mesi.
//
// Nessuno dei tre produce un errore. Sono tutti «una schermata che c'e' e da
// qualche parte non compare», ed e' la forma di difetto che si scopre solo
// quando qualcuno la cerca e non la trova.
//
// Da qui in poi si aggiunge una riga qui e le quattro cose seguono.
//
// L'ICONA E IL PREFETCH NON STANNO QUI: sono roba di componenti, e li tiene la
// barra laterale accanto al suo disegno. Questo file resta dati puri, quindi
// si puo' provare senza montare React.

export type NavEntry = {
  /** Il percorso. E' anche la chiave: due voci non possono averlo uguale. */
  to: string;
  /**
   * Il nome COMPLETO: quello del breadcrumb e della palette, dove il gruppo
   * non si vede. «Trends» da solo non dice di cosa, «Duels · Trends» si'.
   */
  title: string;
  /** Il nome nella barra laterale, dove il gruppo e' gia' scritto sopra. */
  label: string;
  area: string;
  /** Basta UNO di questi moduli per vedere la voce. */
  modules: readonly string[];
  /** Il livello minimo, quando avere il modulo non basta. */
  minLevel?: 1 | 2 | 3;
  /** La riga sotto il nome nella palette. */
  hint?: string;
  /**
   * La schermata ha un periodo, quindi il selettore in alto la governa.
   *
   * DICHIARATO E NON DEDOTTO: era un elenco di esclusioni, e un'esclusione
   * dimenticata regala il selettore a una schermata che non lo usa. Un
   * comando che non fa niente si prova una volta e poi non ci si fida piu'
   * nemmeno dove funziona.
   */
  period?: boolean;
};

/** L'ordine di questo elenco E' l'ordine della barra laterale. */
export const NAV: readonly NavEntry[] = [
  {
    to: '/panoramica',
    title: 'Panoramica network',
    label: 'Panoramica network',
    area: 'Analisi',
    modules: ['statistiche'],
    hint: 'giocatori, mappa, distribuzione',
    period: true,
  },
  {
    to: '/dettaglio-modalita',
    title: 'Dettaglio modalità',
    label: 'Dettaglio modalità',
    area: 'Analisi',
    modules: ['statistiche'],
    hint: 'una modalità alla volta',
    period: true,
  },
  {
    to: '/duels/trends',
    title: 'Duels · Trends',
    label: 'Trends',
    area: 'Duels',
    modules: ['duels'],
    hint: 'andamento delle partite',
    period: true,
  },
  {
    to: '/duels/ratings',
    title: 'Duels · Ratings',
    label: 'Ratings',
    area: 'Duels',
    modules: ['duels_feedback'],
    hint: 'feedback dei giocatori',
    period: true,
  },
  {
    to: '/duels/modes',
    title: 'Duels · Modes',
    label: 'Modes',
    area: 'Duels',
    modules: ['duels_modes'],
    hint: 'configurazione delle modalità',
  },
  {
    to: '/duels/maps',
    title: 'Duels · Maps',
    label: 'Maps',
    area: 'Duels',
    modules: ['duels_maps'],
    hint: 'configurazione delle mappe',
  },
  {
    to: '/duels/live',
    title: 'Duels · Live',
    label: 'Live',
    area: 'Duels',
    modules: ['duels_live'],
    hint: 'cosa sta girando adesso',
  },
  {
    to: '/utenti',
    title: 'Utenti & Ruoli',
    label: 'Utenti & Ruoli',
    area: 'Amministrazione',
    modules: ['utenti', 'ruoli', 'inviti'],
    hint: 'g u',
  },
  {
    to: '/registro',
    title: 'Registro attività',
    label: 'Registro attività',
    area: 'Amministrazione',
    modules: ['audit'],
    hint: 'g r',
  },
];

/**
 * La voce che corrisponde a un percorso.
 *
 * Il confronto e' per prefisso, perche' `/dettaglio-modalita/bedwars` e'
 * ancora il dettaglio modalita'. Si prende la voce PIU' LUNGA che combacia:
 * con due percorsi annidati, la piu' corta vincerebbe sempre.
 */
export function entryOf(pathname: string): NavEntry | null {
  let best: NavEntry | null = null;
  for (const entry of NAV) {
    if (!pathname.startsWith(entry.to)) continue;
    if (!best || entry.to.length > best.to.length) best = entry;
  }
  return best;
}

/**
 * Il titolo per la barra in alto.
 *
 * «Console» e' il ripiego ed e' l'ULTIMA risorsa, non la prima: un ripiego
 * che copre il caso normale non e' un ripiego, e' l'unico comportamento — e
 * non fallisce mai abbastanza da farsi notare.
 */
export function titleOf(pathname: string): string {
  return entryOf(pathname)?.title ?? 'Console';
}

/** Il selettore del periodo governa questa schermata? */
export function hasPeriod(pathname: string): boolean {
  return entryOf(pathname)?.period === true;
}
