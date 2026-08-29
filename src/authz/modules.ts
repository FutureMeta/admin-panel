// I moduli del pannello. Il seed della migration 003 e' la fonte di verita';
// questo file e' la sua controparte tipizzata, verificata da un test.
//
// I livelli sono un ordine totale, non quattro booleani e non un bitmask:
// ogni controllo diventa `level >= N` e la risoluzione multi-ruolo `max()`.

export const MODULES = [
  'utenti',
  'ruoli',
  'inviti',
  'sessioni',
  'audit',
  'impostazioni',
  'statistiche',
  'server',
  // Modulo Duels. Due chiavi e non una: le partite sono aggregati, le
  // valutazioni sono nomi di persone e testo libero. Vedi migration 015.
  'duels',
  'duels_feedback',
  // Le due schermate di configurazione. Il livello 3 su `duels` apriva la
  // configurazione del gioco senza che la matrice lo dicesse: un permesso che
  // non compare e' un permesso che nessuno revoca. Vedi migration 018.
  'duels_modes',
  'duels_maps',
  // La schermata realtime. Chiave a se' perche' e' l'unica dei duels che
  // mostra CHI sta giocando adesso, per nome, con server e ping: appoggiarla
  // su `duels` la regalerebbe a chiunque abbia i grafici. Vedi migration 020.
  'duels_live',
  // L'assistente conversazionale. Un modulo a se' perche' altrimenti non si
  // puo' spegnere: le risposte passano da un fornitore esterno, e dare o non
  // dare quell'accesso e' una decisione che la matrice deve poter esprimere.
  // Non allarga niente — ogni tool ricontrolla i moduli che la persona ha
  // gia'. Vedi migration 019.
  'assistente',
] as const;

export type ModuleKey = (typeof MODULES)[number];

export const MODULE_SET: ReadonlySet<string> = new Set(MODULES);

export function isModuleKey(value: string): value is ModuleKey {
  return MODULE_SET.has(value);
}

/** 0 = nessuno, 1 = lettura, 2 = scrittura, 3 = gestione. */
export const LEVEL = { NONE: 0, READ: 1, WRITE: 2, MANAGE: 3 } as const;
export type Level = 0 | 1 | 2 | 3;
/** I livelli che un controllo puo' richiedere: chiedere `>= 0` non ha senso. */
export type RequiredLevel = 1 | 2 | 3;

export function isLevel(value: number): value is Level {
  return Number.isInteger(value) && value >= 0 && value <= 3;
}
