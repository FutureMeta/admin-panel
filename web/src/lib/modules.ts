// I moduli del pannello, per il lato client: come si chiamano, quanti sono, e
// sotto quale intestazione compaiono nella matrice dei permessi.
//
// STA IN UN MODULO SUO PERCHE' VA CONTROLLATO. Niente qui dentro si rompe
// quando e' sbagliato: un modulo senza area compare in fondo alla matrice
// sotto «Altro», e un conteggio fermo scrive «Tutti i moduli» a chi non li ha
// tutti. Sono due frasi che si leggono benissimo e dicono il falso.
//
// E' successo a entrambi con la migration 015. I due moduli dei Duels sono
// rimasti in fondo alla tabella sotto un'intestazione generica, lontani dalle
// schermate che governano, mentre nella barra laterale il gruppo «Duels»
// c'era gia'; e il totale e' rimasto a otto mentre le chiavi diventavano
// dieci, per cui chi aveva otto moduli su dieci risultava averli tutti.
//
// Concedere permessi e' l'operazione in cui l'errore si vede piu' tardi di
// tutte: chi sbaglia non se ne accorge, se ne accorge qualcun altro quando
// apre — o non apre — una schermata. Un elenco che si puo' dimenticare di
// aggiornare, in quel punto, non va lasciato dove nessun test lo guarda.

/**
 * Le chiavi, nell'ordine del seed.
 *
 * E' la controparte client di `src/authz/modules.ts`, che a sua volta e' la
 * controparte tipizzata del seed della 003. Le due copie esistono perche' il
 * pannello si compila da solo e non importa codice del server; a tenerle
 * uguali c'e' un test, che e' cio' che rende la copia sicura invece che
 * pericolosa.
 */
export const MODULE_KEYS = [
  'utenti',
  'ruoli',
  'inviti',
  'sessioni',
  'audit',
  'impostazioni',
  'statistiche',
  'server',
  'duels',
  'duels_feedback',
  'duels_modes',
  'duels_maps',
  'assistente',
] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];

/** Quanti moduli esistono in tutto: serve a dire «Tutti i moduli». */
export const MODULE_TOTAL = MODULE_KEYS.length;

/**
 * Il ripiego per un modulo senza area.
 *
 * Serve — un modulo nuovo deve comunque comparire, o si concederebbe un
 * permesso invisibile — ma e' un ripiego, non un posto, e un test verifica
 * che nessuno lo usi.
 */
export const OTHER_AREA = 'Altro';

/** Aree della matrice: lo stesso raggruppamento della barra laterale. */
export const MODULE_AREAS: Record<string, string> = {
  utenti: 'Accessi',
  ruoli: 'Accessi',
  inviti: 'Accessi',
  sessioni: 'Accessi',
  audit: 'Controllo',
  impostazioni: 'Sistema',
  statistiche: 'Analisi',
  duels: 'Duels',
  duels_feedback: 'Duels',
  duels_modes: 'Duels',
  duels_maps: 'Duels',
  server: 'Sistema',
  // Sta con «Impostazioni» e «Server» e non con «Analisi»: non e' una
  // schermata di dati, e' una capacita' del pannello che si accende o si
  // spegne per persona.
  assistente: 'Sistema',
};

export function areaOfModule(key: string): string {
  return MODULE_AREAS[key] ?? OTHER_AREA;
}

/** Quanto in alto puo' arrivare un permesso. 0 = nessun accesso. */
export type Level = 0 | 1 | 2 | 3;

/**
 * Questa persona puo' aprire questa schermata?
 *
 * UNA DOMANDA SOLA, IN UN POSTO SOLO. Era scritta in sei punti — la barra
 * laterale, la palette, le guardie di rotta, le due schermate — ognuno con la
 * sua forma: `modules.includes(k)` da una parte, `(permissions.k ?? 0) < 3`
 * dall'altra, e le due non dicono la stessa cosa. Quando divergono si ottiene
 * il difetto piu' fastidioso di un menu: una voce che compare e porta a un
 * 403, oppure una schermata raggiungibile che nessuna voce nomina.
 *
 * IL LIVELLO E' LA DOMANDA VERA. `duels` a 1 apre i grafici, a 3 si cambia
 * come si gioca: sono due permessi diversi sulla stessa chiave, e guardare
 * solo l'elenco dei moduli non li distingue.
 *
 * NON E' UN CONTROLLO DI SICUREZZA e non prova a esserlo: quello sta sulle
 * rotte, dove i dati non arrivano dal client. Questo decide cosa mostrare, ed
 * e' cortesia — ma una cortesia che sbaglia manda le persone contro un muro.
 */
export function canOpen(
  me: { modules: readonly string[]; permissions: Record<string, number> },
  module: string,
  minLevel: Level = 1,
): boolean {
  return me.modules.includes(module) && (me.permissions[module] ?? 0) >= minLevel;
}
