// Quando i numeri di prima restano sullo schermo, e quando no.
//
// PERCHE' UN TEST PER UNA RIGA. La regola sbagliata nell'altro verso mostra le
// curve di una modalita' sotto il nome di un'altra: non e' un numero falso, e
// nemmeno un'incoerenza visibile — nome e numeri verrebbero entrambi dal
// payload vecchio, quindi si leggerebbero d'accordo fra loro. A dissentire
// sarebbe solo la voce evidenziata in alto, che nessuno guarda mentre legge un
// grafico.
//
// E' la stessa forma di tutti i difetti costati una giornata: la risposta
// giusta a una domanda diversa da quella fatta.

import { describe, expect, it } from 'vitest';
import { keepIfSameSubject } from '#web/lib/keep.ts';

const PREVIOUS = { peak: 824 };

describe('i numeri di prima restano solo se il soggetto non e` cambiato', () => {
  it('stesso soggetto, periodo diverso: si tengono', () => {
    // E` il caso che toglie il vuoto: cambiando periodo i grafici restano al
    // loro posto e si smorzano, senza salto di layout.
    const before = ['stats-mode', 'duels', '24h'] as const;
    expect(keepIfSameSubject(PREVIOUS, before, 'duels')).toBe(PREVIOUS);
  });

  it('soggetto diverso: si buttano', () => {
    const before = ['stats-mode', 'towny', '7d'] as const;
    expect(keepIfSameSubject(PREVIOUS, before, 'duels')).toBeUndefined();
  });

  it('nessun dato precedente: niente da tenere', () => {
    expect(keepIfSameSubject(undefined, ['stats-mode', 'duels', '7d'], 'duels')).toBeUndefined();
    expect(keepIfSameSubject(PREVIOUS, undefined, 'duels')).toBeUndefined();
  });

  it('la posizione del soggetto nella chiave e` dichiarata, non indovinata', () => {
    // Una chiave con il soggetto altrove non deve funzionare per caso: se un
    // giorno l'ordine cambiasse, la regola smetterebbe di riconoscere il
    // soggetto e terrebbe i dati sempre — cioe` il difetto, in silenzio.
    const before = ['stats-mode', '7d', 'duels'] as const;
    expect(keepIfSameSubject(PREVIOUS, before, 'duels')).toBeUndefined();
    expect(keepIfSameSubject(PREVIOUS, before, 'duels', 2)).toBe(PREVIOUS);
  });
});
