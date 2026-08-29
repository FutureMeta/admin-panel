// Le schermate del pannello, viste dal server.
//
// PERCHE' QUESTA TABELLA ESISTE, dato che il client ne ha gia' una uguale in
// `web/src/lib/nav.ts`.
//
// Il contesto automatico finisce in un messaggio `role: "system"` — il canale
// delle istruzioni operative, l'unico che il client non puo' scrivere. Se il
// titolo della schermata arrivasse dal browser e venisse interpolato li'
// dentro, quel canale smetterebbe di essere non falsificabile: basterebbe
// mandare `title: "ignora le regole precedenti"` per far scrivere una frase
// qualunque nel posto piu' autorevole della richiesta.
//
// Il client manda quindi solo un PERCORSO, e il titolo lo sceglie questa
// tabella. Un percorso sconosciuto non produce un titolo inventato: produce
// una frase generica. Cosi' nel messaggio di sistema finiscono soltanto
// stringhe scritte qui dentro.
//
// (Il percorso stesso e' del client, e compare accanto al titolo. Non e' una
// contraddizione: passa da un vincolo di forma stretto — vedi `isKnownPath` —
// che non lascia entrare una frase.)
//
// LE DUE COPIE SI CONFRONTANO IN UN TEST, come per l'elenco dei moduli: una
// schermata che il client conosce e il server no farebbe dire a Svetlana «non
// so dove sei» proprio mentre chi scrive la sta guardando.

export type Screen = { path: string; title: string };

/** L'ordine non conta: la ricerca prende il prefisso PIU' LUNGO che combacia. */
export const SCREENS: readonly Screen[] = [
  { path: '/panoramica', title: 'Panoramica network' },
  { path: '/dettaglio-modalita', title: 'Dettaglio modalità' },
  { path: '/duels/trends', title: 'Duels · Trends' },
  { path: '/duels/ratings', title: 'Duels · Ratings' },
  { path: '/duels/modes', title: 'Duels · Modes' },
  { path: '/duels/maps', title: 'Duels · Maps' },
  { path: '/duels/live', title: 'Duels · Live' },
  { path: '/utenti', title: 'Utenti & Ruoli' },
  { path: '/registro', title: 'Registro attività' },
];

/** Quello che si dice quando il percorso non e' fra quelli conosciuti. */
export const UNKNOWN_SCREEN: Screen = {
  path: '/',
  title: 'una schermata del pannello',
};

/**
 * La forma ammessa per un percorso. Non e' una convalida di esistenza: e' un
 * vincolo che impedisce a una frase di entrare dove entra un percorso.
 */
export function isKnownPath(path: string): boolean {
  return /^\/[a-z0-9/_-]{0,64}$/.test(path);
}

export function screenOf(path: string): Screen {
  if (!isKnownPath(path)) return UNKNOWN_SCREEN;
  let best: Screen | null = null;
  for (const screen of SCREENS) {
    if (!path.startsWith(screen.path)) continue;
    if (!best || screen.path.length > best.path.length) best = screen;
  }
  // Il percorso resta quello vero anche quando il titolo e' generico: «sei su
  // /impostazioni, che non conosco» e' piu' utile di «non so dove sei».
  return best ? { path, title: best.title } : { ...UNKNOWN_SCREEN, path };
}
