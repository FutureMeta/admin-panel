// I moduli, i loro nomi e dove compaiono nella matrice dei permessi.
//
// PERCHE' ESISTE. Il pannello si compila per conto suo e non importa codice
// del server: l'elenco dei moduli e' scritto due volte, una per lato. Finche'
// nessuno li confronta, la copia del client puo' restare indietro senza che
// niente si rompa — e non si rompe davvero, dice solo cose false.
//
// E' successo con la migration 015, che ha aggiunto `duels` e
// `duels_feedback`. Da allora:
//
//   * nella matrice i due comparivano in fondo sotto «Altro», lontani dalle
//     schermate che governano, mentre nella barra laterale il gruppo «Duels»
//     esisteva gia';
//   * il totale dei moduli e' rimasto otto mentre le chiavi erano dieci,
//     quindi la tabella degli utenti scriveva «Tutti i moduli» a chi ne aveva
//     otto su dieci.
//
// Nessuna delle due ha prodotto un errore. La prima e' una riga in piu' in
// una tabella lunga; la seconda e' una frase rassicurante al posto di un
// numero. Concedere permessi e' l'operazione in cui l'errore si vede piu'
// tardi di tutte, e queste sono esattamente le due frasi che chi concede
// legge per decidere.

import { describe, expect, it } from 'vitest';
import { MODULES } from '#src/authz/modules.ts';
import { areaOfModule, MODULE_AREAS, MODULE_KEYS, MODULE_TOTAL, OTHER_AREA } from '#web/lib/modules.ts';

describe('le due copie dell`elenco dei moduli restano uguali', () => {
  it('stesse chiavi, stesso ordine', async () => {
    // L'ordine conta: e' quello del seed, ed e' l'ordine in cui le righe
    // compaiono nella matrice.
    expect([...MODULE_KEYS]).toEqual([...MODULES]);
  });

  it('il totale si CONTA, non si scrive', async () => {
    // Era scritto a mano, ed e' cosi' che e' rimasto a otto. Un numero
    // ricavato dall'elenco non puo' piu' divergere dall'elenco.
    expect(MODULE_TOTAL).toBe(MODULES.length);
  });
});

describe('ogni modulo ha il suo posto nella matrice', () => {
  it('nessuno finisce in «Altro»', async () => {
    // Il ripiego serve — un modulo nuovo deve comunque comparire, o si
    // concederebbe un permesso invisibile — ma se qualcuno ci finisce e'
    // perche' ci si e' dimenticati di dirgli dove va.
    const senzaArea = MODULE_KEYS.filter((k) => areaOfModule(k) === OTHER_AREA);
    expect(senzaArea).toEqual([]);
  });

  it('e non ci sono aree per moduli che non esistono', async () => {
    // Una voce di troppo e' il segno di una chiave rinominata a meta': la
    // riga vecchia resta li' e non la nota nessuno, perche' non compare.
    const fantasmi = Object.keys(MODULE_AREAS).filter((k) => !(MODULE_KEYS as readonly string[]).includes(k));
    expect(fantasmi).toEqual([]);
  });

  it('i due moduli dei Duels stanno sotto «Duels»', async () => {
    expect(areaOfModule('duels')).toBe('Duels');
    expect(areaOfModule('duels_feedback')).toBe('Duels');
  });
});
