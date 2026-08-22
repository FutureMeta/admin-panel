// La porta verso i dati dei duels.
//
// PERCHE' UNA PORTA, se la decisione e' gia' presa. La decisione e' l'ETL:
// PostgreSQL e' l'implementazione predefinita e quella che gira. La porta
// esiste perche' la scelta resti reversibile in un posto solo — se un giorno
// l'ETL fosse il problema invece della soluzione, si cambia questa riga e non
// le rotte, non il contratto, non la cache, non le schermate.
//
// LE ROTTE NON SANNO QUALE E' ATTIVA, ed e' il punto. `kind` esiste per
// dirlo nei log e nelle diagnostiche, non perche' qualcuno ci si ramifichi
// sopra: il giorno in cui una rotta scrivesse `if (provider.kind === ...)`,
// la porta avrebbe smesso di essere una porta.

import type {
  DuelsCommentFilter,
  DuelsRatings,
  DuelsRecent,
  DuelsRecentSort,
  DuelsTrends,
  Range,
} from './contract.ts';

export type RecentQuery = {
  range: Range;
  mode: number | null;
  /** Ricerca libera su nome giocatore e testo del commento. */
  q: string | null;
  comment: DuelsCommentFilter;
  sort: DuelsRecentSort;
  /** Opaco, prodotto dalla pagina precedente. */
  cursor: string | null;
  /** Se contare il totale: solo alla prima pagina di una combinazione. */
  withTotal: boolean;
  now: Date;
};

export type DuelsProvider = {
  /** Per i log e le diagnostiche. Nessuna rotta ci si rami sopra. */
  readonly kind: 'postgres' | 'mysql';
  trends(range: Range, now: Date): Promise<DuelsTrends>;
  ratings(range: Range, mode: number | null, now: Date): Promise<DuelsRatings>;
  recent(query: RecentQuery): Promise<DuelsRecent>;
  /**
   * Gli id di modalita' che esistono nel catalogo.
   *
   * Serve all'allowlist della rotta: un id fuori catalogo risponde 404, non un
   * payload vuoto. Un payload vuoto l'interfaccia lo disegna come «zero
   * valutazioni», cioe' una bugia al posto di un errore.
   */
  modeIds(): Promise<Set<number>>;
};

/** Cursore malformato: 400, non una pagina qualunque. */
export class BadCursor extends Error {
  constructor() {
    super('cursore non valido');
    this.name = 'BadCursor';
  }
}
