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
  server: 'Sistema',
};

export function areaOfModule(key: string): string {
  return MODULE_AREAS[key] ?? OTHER_AREA;
}
