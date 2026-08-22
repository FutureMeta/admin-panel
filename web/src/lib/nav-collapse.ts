// Quali categorie della barra laterale sono chiuse.
//
// Sta in un modulo suo, e non dentro il componente, per la stessa ragione di
// sempre: sono regole, non disegno. Una in particolare non e' ovvia e si
// romperebbe in silenzio — vedi `openArea`.

/**
 * La chiave del ricordo.
 *
 * `localStorage` e non un cookie: non viaggia con nessuna richiesta, e questa
 * e' una preferenza di disegno, non uno stato del server. Non contiene niente
 * di riservato — nomi di categorie, gli stessi che chiunque legge aprendo il
 * pannello — quindi su un computer condiviso non racconta chi l'ha usato.
 */
export const COLLAPSED_KEY = 'metamc.sidebar.collapsed';

/**
 * Una voce e' quella corrente?
 *
 * ESISTE PER ESSERE USATA DA DUE POSTI. La barra la usa per evidenziare la
 * voce, e `areaOf` per sapere quale categoria contiene la pagina aperta. Se
 * le due risposte divergessero si otterrebbe una categoria chiusa che
 * contiene la voce evidenziata — cioe' l'evidenziazione invisibile, che e'
 * peggio di nessuna evidenziazione perche' sembra che la barra abbia perso il
 * segno.
 */
export function isActive(pathname: string, to: string): boolean {
  return pathname.startsWith(to);
}

/** La categoria che contiene la pagina aperta, se c'e'. */
export function areaOf(groups: Array<[string, Array<{ to: string }>]>, pathname: string): string | null {
  for (const [area, items] of groups) {
    if (items.some((item) => isActive(pathname, item.to))) return area;
  }
  return null;
}

/**
 * Legge il ricordo, e sopravvive a qualunque cosa ci trovi.
 *
 * `localStorage` e' scrivibile da chiunque abbia la console aperta e resta li'
 * fra una versione e l'altra del pannello: un valore di un formato vecchio, o
 * scritto a mano, non deve impedire alla barra di disegnarsi. Qualunque cosa
 * non sia un elenco di stringhe vale «niente di chiuso», che e' lo stato in
 * cui tutto si vede.
 */
export function readCollapsed(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === 'string'));
  } catch {
    return new Set();
  }
}

export function writeCollapsed(areas: Set<string>): string {
  // Ordinato: due sessioni che chiudono le stesse categorie scrivono la stessa
  // stringa, e un diff fra due stati non mostra differenze che non ci sono.
  return JSON.stringify([...areas].sort());
}

export function toggleArea(collapsed: Set<string>, area: string): Set<string> {
  const next = new Set(collapsed);
  if (next.has(area)) next.delete(area);
  else next.add(area);
  return next;
}

/**
 * Apre la categoria in cui si e' appena arrivati.
 *
 * IL DIFETTO CHE TOGLIE. Si puo' arrivare su una pagina senza passare dalla
 * barra — la palette con ⌘K, un link condiviso, il ritorno alla pagina
 * salvata. Se quella pagina sta in una categoria chiusa, la barra non mostra
 * nessuna voce evidenziata: non e' un dettaglio estetico, e' l'unica cosa che
 * dice DOVE ci si trova, e senza sembra che la navigazione si sia persa.
 *
 * SI CHIAMA SOLO QUANDO IL PERCORSO CAMBIA, mai a ogni disegno. Chiamandola
 * sempre, chiudere la categoria della pagina aperta diventerebbe impossibile:
 * il clic la chiude, il disegno successivo la riapre, e il pulsante sembra
 * rotto. E' lo stesso stato finale con due significati opposti — chiuderla
 * mentre ci si sta dentro e' una scelta legittima, e va rispettata.
 */
export function openArea(collapsed: Set<string>, area: string | null): Set<string> {
  if (area === null || !collapsed.has(area)) return collapsed;
  const next = new Set(collapsed);
  next.delete(area);
  return next;
}

/**
 * Le due sole operazioni che servono su `localStorage`.
 *
 * Descritto per quello che si usa invece di chiamarlo `Storage`: questo modulo
 * lo compilano DUE programmi — quello del pannello, che ha il DOM, e quello
 * dei test, che non ce l'ha — e un tipo del DOM qui dentro fa fallire il
 * secondo.
 */
type Store = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

/**
 * `localStorage`, quando c'e'.
 *
 * LEGGERLO PUO' LANCIARE. Con i cookie di terze parti bloccati, o in certe
 * modalita' private, il solo accesso alla proprieta' solleva un
 * `SecurityError`: senza questa rete, una preferenza di disegno butterebbe
 * giu' l'intero guscio del pannello. Chi non ce l'ha vede tutte le categorie
 * aperte, che e' esattamente cio' che vedeva prima.
 */
export function safeStorage(): Store | null {
  try {
    return (globalThis as { localStorage?: Store }).localStorage ?? null;
  } catch {
    return null;
  }
}
