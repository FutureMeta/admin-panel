// La distribuzione per modalita' e il selettore in alto.
//
// IL DIFETTO CHE QUESTO FILE ESISTE PER FERMARE non produce un numero
// sbagliato: fa sparire un riquadro. Le fette prendevano i VALORI da
// `current` — la misura di adesso, che non dipende dal range — e le CHIAVI da
// `modes`, che e' l'elenco delle modalita' presenti nella serie del range
// scelto. Le due liste coincidono quasi sempre, quindi in sviluppo non si vede
// niente; su un range il cui storico non c'e' ancora — l'1y finche' non esiste
// un rollup giornaliero — `modes` e' vuoto, e la ciambella scriveva «nessuna
// misura ancora» tenendo in mano la misura.
//
// Un'assenza sembra sempre un problema di dati e mai di codice: e' per questo
// che e' costata un giro di segnalazione invece di essere vista scrivendola.

import { describe, expect, it } from 'vitest';
import { slicesOf } from '#web/lib/distribution.ts';

const ADESSO = { at: 1_787_000_000, byMode: { arena: 220, duels: 90, eventi: 12 } };

describe('le fette vengono da `current`, non dal range', () => {
  it('con la serie del range vuota le fette ci sono lo stesso', () => {
    // E' esattamente il payload dell'1y su una rete accesa da pochi giorni:
    // nessun rollup giornaliero, quindi nessuna serie, ma il bucket da cinque
    // minuti c'e' e dice chi sta giocando in questo momento.
    expect(slicesOf(ADESSO).slices).toHaveLength(3);
  });

  it('ordina dalla piu` popolata alla meno', () => {
    expect(slicesOf(ADESSO).slices.map((s) => s.key)).toEqual(['arena', 'duels', 'eventi']);
  });

  it('una modalita` a zero non e` una fetta', () => {
    // Ampiezza nulla: una voce in legenda senza niente da indicare, e una
    // percentuale che si legge come «0,0%» invece che come «non c'e' nessuno».
    const conVuota = { at: 1, byMode: { arena: 10, deserta: 0 } };
    expect(slicesOf(conVuota).slices.map((s) => s.key)).toEqual(['arena']);
  });

  it('`current` nullo e` lista vuota, non un errore', () => {
    // Il campionamento non ha ancora chiuso un bucket. E' una cosa diversa da
    // «zero giocatori» e il riquadro la scrive: qui basta che non sollevi.
    expect(slicesOf(null).slices).toEqual([]);
    expect(slicesOf(undefined).slices).toEqual([]);
  });
});

describe('chi e` fuori dalla ripartizione non sparisce: si dichiara', () => {
  it('la modalita` esclusa non ha una fetta', () => {
    const { slices } = slicesOf(ADESSO, ['eventi']);
    expect(slices.map((s) => s.key)).toEqual(['arena', 'duels']);
  });

  it('e i suoi giocatori tornano indietro come somma', () => {
    // IL PUNTO DI TUTTO IL RIQUADRO. Le percentuali si calcolano sul totale
    // delle fette rimaste: escludendo «eventi» senza dirlo, arena passerebbe
    // dal 68,5% al 71%. Un numero plausibile, diverso dal vero, e senza
    // niente su cui dubitare. Il riquadro scrive quei 12 sotto.
    expect(slicesOf(ADESSO, ['eventi']).excluded).toBe(12);
  });

  it('escludere una modalita` assente non inventa niente', () => {
    expect(slicesOf(ADESSO, ['mai_vista']).excluded).toBe(0);
    expect(slicesOf(ADESSO, ['mai_vista']).slices).toHaveLength(3);
  });

  it('e una modalita` esclusa ma a zero non conta come esclusa', () => {
    // Zero giocatori non sono giocatori nascosti: annunciarli sarebbe una
    // riga che allarma su niente.
    const conVuota = { at: 1, byMode: { arena: 10, deserta: 0 } };
    expect(slicesOf(conVuota, ['deserta']).excluded).toBe(0);
  });
});
