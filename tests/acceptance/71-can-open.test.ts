// Chi vede quale voce di menu.
//
// IL DIFETTO CHE QUESTA FUNZIONE TOGLIE. La stessa domanda — «questa persona
// puo' aprire questa schermata?» — era scritta in sei punti con tre forme
// diverse: `modules.includes(k)` nella barra laterale e nella palette,
// `(permissions.k ?? 0) < 3` nelle guardie di rotta e dentro le due schermate
// nuove. Le due forme NON dicono la stessa cosa, e quando divergono si ottiene
// il difetto piu' fastidioso di un menu: una voce che compare e porta a un
// 403, oppure una schermata raggiungibile che nessuna voce nomina.
//
// E NON E' UN CONTROLLO DI SICUREZZA. Quello sta sulle rotte, dove i dati non
// arrivano dal client, ed e' provato altrove (69). Questo decide cosa mostrare:
// e' cortesia, ma una cortesia che sbaglia manda le persone contro un muro.

import { describe, expect, it } from 'vitest';
import { canOpen, MODULE_KEYS } from '#web/lib/modules.ts';

const con = (permissions: Record<string, number>) => ({
  // `modules` e' l'elenco che il server manda: contiene le chiavi con livello
  // maggiore di zero. Qui si ricostruisce cosi', come fa il server.
  modules: Object.keys(permissions).filter((k) => (permissions[k] ?? 0) > 0),
  permissions,
});

describe('avere il modulo e avere il livello sono due cose diverse', () => {
  it('il livello 1 apre le schermate di lettura', async () => {
    const me = con({ duels: 1 });
    expect(canOpen(me, 'duels')).toBe(true);
  });

  it('ma NON quelle che cambiano il gioco', async () => {
    // E' esattamente il caso di Modes e Maps: chi guarda i grafici ha 1, e con
    // il solo controllo sui moduli avrebbe visto due voci che rispondono 403.
    const me = con({ duels: 1 });
    expect(canOpen(me, 'duels', 3)).toBe(false);
  });

  it('il livello 3 le apre tutte', async () => {
    const me = con({ duels: 3 });
    expect(canOpen(me, 'duels')).toBe(true);
    expect(canOpen(me, 'duels', 3)).toBe(true);
  });

  it('senza il modulo non si apre niente, a nessun livello', async () => {
    const me = con({ statistiche: 3 });
    expect(canOpen(me, 'duels')).toBe(false);
    expect(canOpen(me, 'duels', 3)).toBe(false);
  });
});

describe('i casi che sbagliano in silenzio', () => {
  it('un modulo che non compare fra i permessi vale zero, non «indefinito»', async () => {
    // `permissions[k]` assente e' `undefined`, e `undefined >= 3` e' `false`
    // ma `undefined < 3` e' anch'esso `false`: scritto al contrario, lo stesso
    // stato aprirebbe la schermata.
    const me = { modules: ['duels'], permissions: {} as Record<string, number> };
    expect(canOpen(me, 'duels')).toBe(false);
    expect(canOpen(me, 'duels', 3)).toBe(false);
  });

  it('un livello 0 dichiarato non apre niente', async () => {
    // Le righe a livello 0 esistono davvero: «non ha accesso» e' un fatto
    // dichiarato nella matrice, non l'assenza di una riga.
    const me = { modules: ['duels'], permissions: { duels: 0 } };
    expect(canOpen(me, 'duels')).toBe(false);
  });

  it('vale per ogni modulo del pannello, non solo per i duels', async () => {
    for (const key of MODULE_KEYS) {
      expect(canOpen(con({ [key]: 1 }), key), key).toBe(true);
      expect(canOpen(con({ [key]: 1 }), key, 2), key).toBe(false);
      expect(canOpen(con({ [key]: 3 }), key, 3), key).toBe(true);
    }
  });
});
