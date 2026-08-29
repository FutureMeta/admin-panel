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

/** Una voce della barra, per quel poco che serve a queste funzioni. */
type Item = { to: string; group?: string | undefined };

/**
 * Le chiavi da aprire perche' la pagina corrente si veda: la categoria, e —
 * quando la voce sta in un sottogruppo — anche quella del sottogruppo.
 *
 * DUE E NON UNA, ed e' il difetto che ha smesso di essere impossibile il
 * giorno in cui Modes, Maps e Configs sono finiti dentro «Setup»: aprire la
 * sola categoria lasciando chiuso il sottogruppo che contiene la voce
 * evidenziata significa una barra che dice «sei qui» indicando un posto che
 * non si vede.
 *
 * Nell'ordine dal fuori al dentro, che e' anche l'ordine in cui vanno aperte.
 */
export function chainOf(groups: Array<[string, Item[]]>, pathname: string): string[] {
  for (const [area, items] of groups) {
    const item = items.find((x) => isActive(pathname, x.to));
    if (item === undefined) continue;
    return item.group === undefined ? [area] : [area, `${area}/${item.group}`];
  }
  return [];
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
 * Apre tutto quello che sta sopra la pagina in cui si e' appena arrivati.
 *
 * IL DIFETTO CHE TOGLIE. Si puo' arrivare su una pagina senza passare dalla
 * barra — la palette con ⌘K, un link condiviso, il ritorno alla pagina
 * salvata. Se quella pagina sta in una categoria chiusa, la barra non mostra
 * nessuna voce evidenziata: non e' un dettaglio estetico, e' l'unica cosa che
 * dice DOVE ci si trova, e senza sembra che la navigazione si sia persa.
 *
 * PRENDE LA CATENA INTERA e non una chiave sola: da quando esistono i
 * sottogruppi, aprire la categoria non basta piu' a rendere visibile la voce.
 *
 * SI CHIAMA SOLO QUANDO IL PERCORSO CAMBIA, mai a ogni disegno. Chiamandola
 * sempre, chiudere la categoria della pagina aperta diventerebbe impossibile:
 * il clic la chiude, il disegno successivo la riapre, e il pulsante sembra
 * rotto. E' lo stesso stato finale con due significati opposti — chiuderla
 * mentre ci si sta dentro e' una scelta legittima, e va rispettata.
 *
 * RESTITUISCE LO STESSO INSIEME quando non c'e' niente da aprire. Non e'
 * un'ottimizzazione: e' quello che permette di passarla a `setCollapsed` senza
 * provocare un disegno in piu' a ogni cambio di pagina.
 */
export function openChain(collapsed: Set<string>, keys: readonly string[]): Set<string> {
  if (!keys.some((key) => collapsed.has(key))) return collapsed;
  const next = new Set(collapsed);
  for (const key of keys) next.delete(key);
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
