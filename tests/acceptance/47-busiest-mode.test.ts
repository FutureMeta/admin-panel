// Su quale modalita' si apre il dettaglio quando nessuno ne ha chiesta una.
//
// PERCHE' E' UNA FUNZIONE E NON TRE RIGHE NEL COMPONENTE. La regola ha tre
// casi che non si vedono guardando lo schermo: i pari merito, l'assenza di
// misure, e le sentinella che sono serie ma non destinazioni. Sbagliarne uno
// non produce un errore — produce un pannello che si apre sulla modalita'
// sbagliata, o su una diversa a ogni apertura, che e' peggio perche' si
// scambia per un difetto di rete.

import { describe, expect, it } from 'vitest';
import { busiestMode, navigableModes } from '#web/lib/busiest.ts';

/** L'ordine e` quello del dizionario: `sort_order`, scelto dall'operatore. */
const LABELS = {
  duels: 'Duels',
  towny: 'Towny',
  lobby: 'Lobby',
  __transit__: 'In transito',
};

describe('il dettaglio si apre sulla modalita` piu` popolata', () => {
  it('sceglie quella con piu` giocatori adesso', () => {
    const current = { byMode: { duels: 40, towny: 286, lobby: 12 } };
    expect(busiestMode(current, LABELS)).toBe('towny');
  });

  it('non sceglie una sentinella, per quanti giocatori abbia', () => {
    // `__transit__` e` il giocatore osservato senza un campo `server`: in un
    // momento di riavvii puo` benissimo essere la voce piu` numerosa della
    // rete, e non e` un posto dove andare a guardare.
    const current = { byMode: { __transit__: 900, duels: 40, towny: 286 } };
    expect(busiestMode(current, LABELS)).toBe('towny');
  });

  it('a pari merito vince la prima del dizionario, sempre la stessa', () => {
    // Il difetto silenzioso: lasciando decidere all'ordine di iterazione
    // dell'oggetto, di notte — quando sono tutte a zero, o tutte uguali — il
    // pannello si aprirebbe ogni volta su una modalita` diversa.
    const pari = { byMode: { towny: 50, duels: 50, lobby: 50 } };
    const altroOrdine = { byMode: { lobby: 50, towny: 50, duels: 50 } };

    expect(busiestMode(pari, LABELS)).toBe('duels');
    expect(busiestMode(altroOrdine, LABELS)).toBe('duels');
  });

  it('senza misure ripiega sulla prima del dizionario', () => {
    // `current` e` nullo quando non c'e` nessun ciclo abbastanza recente:
    // succede al primo avvio e dopo un fermo. Non e` un errore, e non deve
    // diventare una pagina vuota.
    expect(busiestMode(null, LABELS)).toBe('duels');
    expect(busiestMode(undefined, LABELS)).toBe('duels');
    expect(busiestMode({ byMode: {} }, LABELS)).toBe('duels');
  });

  it('una modalita` mai osservata vale zero, non «assente»', () => {
    // Chi non compare in `byMode` non e` stata vista: resta candidata, con
    // zero. Trattarla come inesistente la renderebbe irraggiungibile
    // dall'ingresso proprio quando e` appena stata creata.
    const current = { byMode: { duels: 0, towny: 0, lobby: 0 } };
    expect(busiestMode(current, LABELS)).toBe('duels');
    expect(busiestMode({ byMode: { lobby: 3 } }, LABELS)).toBe('lobby');
  });

  it('senza nessuna modalita` non inventa una destinazione', () => {
    expect(busiestMode({ byMode: {} }, {})).toBeNull();
    expect(busiestMode({ byMode: { __transit__: 10 } }, { __transit__: 'In transito' })).toBeNull();
  });

  it('l`elenco navigabile tiene fuori le sole sentinella', () => {
    expect(navigableModes(LABELS)).toEqual(['duels', 'towny', 'lobby']);
  });
});
