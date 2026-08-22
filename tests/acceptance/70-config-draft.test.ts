// La bozza locale, e il pulsante che deve comparire solo quando serve.
//
// LA REGOLA CHE QUESTI TEST TENGONO FERMA. Su Modes e Maps si modifica la
// configurazione del GIOCO, e tutto resta locale finche' non si preme Salva. Il
// pulsante compare solo se c'e' davvero qualcosa da salvare: un Salva sempre
// acceso non distingue «ho modificato» da «non ho toccato niente», e quella
// distinzione e' l'informazione piu' importante della schermata — la si perde
// proprio quando si e' distratti.
//
// E LA REGOLA DEVE COINCIDERE CON QUELLA DEL SERVER. Il client decide se
// mostrare Salva, il server decide se scrivere la riga: se i due non fossero
// d'accordo, il pulsante comparirebbe per modifiche che il server considera
// gia' salvate, e premerlo non cambierebbe niente. L'ultimo test di questo file
// confronta le due implementazioni caso per caso.

import { describe, expect, it } from 'vitest';
import { planSettings } from '#src/duels/plan.ts';
import { MODE_SETTINGS } from '#src/duels/settings.ts';
import {
  changedSettings,
  effectiveValues,
  isOverride,
  looksValid,
  overrideCount,
  type SettingSpec,
  sameSet,
  sameValue,
  toggleIn,
} from '#web/lib/config-draft.ts';

const BOOL: SettingSpec = {
  key: 'SATURATION',
  kind: 'bool',
  fallback: '1',
  group: 'g',
};
const INT: SettingSpec = { key: 'MOB_TIMER', kind: 'int', fallback: '10', group: 'g' };
const DBL: SettingSpec = { key: 'DAMAGE', kind: 'double', fallback: '1.0', group: 'g' };
const ENUM: SettingSpec = {
  key: 'DIFFICULTY',
  kind: 'enum',
  fallback: 'HARD',
  options: ['PEACEFUL', 'EASY', 'NORMAL', 'HARD'],
  group: 'g',
};
const SPECS = [BOOL, INT, DBL, ENUM];

describe('cosa mostra la schermata prima che si tocchi niente', () => {
  it('un setting senza riga mostra il default', async () => {
    // Un valore c'e' sempre: quello che cambia e' se qualcuno lo ha scelto.
    const values = effectiveValues(SPECS, []);
    expect(values.MOB_TIMER).toBe('10');
    expect(values.DIFFICULTY).toBe('HARD');
  });

  it('un setting con una riga mostra la riga', async () => {
    const values = effectiveValues(SPECS, [{ key: 'MOB_TIMER', value: '30' }]);
    expect(values.MOB_TIMER).toBe('30');
  });

  it('«impostato a 10» e «vale 10 perche` e` il default» si distinguono', async () => {
    // E' la differenza che il badge «personalizzato» mostra, e senza la quale
    // non si saprebbe quali settings qualcuno ha deciso davvero.
    expect(isOverride(INT, '30')).toBe(true);
    expect(isOverride(INT, '10')).toBe(false);
  });

  it('il conteggio dei personalizzati non conta i default riscritti', async () => {
    // `1.0` e `1` sono lo stesso default: contarlo direbbe che qualcuno ha
    // personalizzato qualcosa che nessuno ha toccato.
    expect(overrideCount(SPECS, { SATURATION: '1', MOB_TIMER: '30', DAMAGE: '1', DIFFICULTY: 'HARD' })).toBe(
      1,
    );
  });
});

describe('quando compare il pulsante Salva', () => {
  it('non compare se non e` cambiato niente', async () => {
    const saved = { SATURATION: '1', MOB_TIMER: '30', DAMAGE: '1.0', DIFFICULTY: 'HARD' };
    expect(changedSettings(SPECS, saved, { ...saved })).toEqual([]);
  });

  it('compare per il setting cambiato, e nomina solo quello', async () => {
    const saved = { SATURATION: '1', MOB_TIMER: '30', DAMAGE: '1.0', DIFFICULTY: 'HARD' };
    expect(changedSettings(SPECS, saved, { ...saved, MOB_TIMER: '20' })).toEqual(['MOB_TIMER']);
  });

  it('NON compare per lo stesso numero scritto in un altro modo', async () => {
    // Confrontando le stringhe, riscrivere `1.0` come `1` accenderebbe Salva
    // per una modifica che non e' una modifica: si preme, e non succede
    // niente. E' il pulsante di cui non si sa cosa fa.
    const saved = { DAMAGE: '1.0' };
    expect(changedSettings([DBL], saved, { DAMAGE: '1' })).toEqual([]);
    expect(changedSettings([DBL], saved, { DAMAGE: '1.00' })).toEqual([]);
  });

  it('tornare al valore di partenza fa sparire il pulsante', async () => {
    // Si tocca, ci si ripensa, si rimette com'era: da li' in poi non c'e' piu'
    // niente da salvare, e la schermata deve dirlo.
    const saved = { MOB_TIMER: '30' };
    const acceso = changedSettings([INT], saved, { MOB_TIMER: '20' });
    const spento = changedSettings([INT], saved, { MOB_TIMER: '30' });
    expect(acceso).toEqual(['MOB_TIMER']);
    expect(spento).toEqual([]);
  });
});

describe('gli insiemi: modalita` di una mappa, event type', () => {
  it('l`ordine non conta', async () => {
    // Sono righe di una tabella di appartenenza, non una sequenza: se
    // contasse, riordinare accenderebbe Salva senza aver cambiato niente.
    expect(sameSet([1, 2, 3], [3, 1, 2])).toBe(true);
  });

  it('togliere e rimettere la stessa voce non e` una modifica', async () => {
    const partenza = [1, 2];
    const dopo = toggleIn(toggleIn(partenza, 2), 2);
    expect(sameSet(partenza, dopo)).toBe(true);
  });

  it('aggiungere o togliere si vede', async () => {
    expect(sameSet([1, 2], [1, 2, 3])).toBe(false);
    expect(sameSet([1, 2], [1])).toBe(false);
  });

  it('l`interruttore non tocca l`elenco di partenza', async () => {
    // Lo stato di React si sostituisce, non si modifica: mutandolo il disegno
    // successivo potrebbe non accorgersi del cambiamento.
    const partenza = ['UHC'];
    toggleIn(partenza, 'PILLARS');
    expect(partenza).toEqual(['UHC']);
  });
});

describe('quello che si vede prima di premere Salva', () => {
  it('un numero con la virgola si riconosce senza chiedere al server', async () => {
    // `1,5` e' come si scrive in italiano ed e' esattamente cio' che il plugin
    // non sa rileggere. Non sostituisce il controllo del server: evita di far
    // premere Salva per farsi dire di no.
    expect(looksValid(DBL, '1.5')).toBe(true);
    expect(looksValid(DBL, '1,5')).toBe(false);
    expect(looksValid(INT, '3.5')).toBe(false);
    expect(looksValid(ENUM, 'hard')).toBe(false);
    expect(looksValid(BOOL, 'true')).toBe(false);
  });
});

describe('il client e il server sono d`accordo su cosa sia una modifica', () => {
  it('caso per caso, sulle regole vere del registro', async () => {
    // SE QUESTI DUE DIVERGONO il difetto e' invisibile e continuo: Salva
    // compare, si preme, il server pianifica zero scritture e la schermata
    // torna com'era. Nessun errore, nessun messaggio, e nessun modo di capire
    // perche' quel pulsante non faceva niente.
    const casi: Array<[string, string]> = [
      ['10', '10'],
      ['10', '20'],
      ['1.0', '1'],
      ['1.00', '1'],
      ['1.0', '1.5'],
      ['0', '0'],
      ['HARD', 'HARD'],
      ['HARD', 'EASY'],
    ];

    for (const spec of MODE_SETTINGS) {
      for (const [salvato, bozza] of casi) {
        // Solo le coppie che hanno senso per questo tipo.
        if (spec.kind === 'enum' && !(spec.options ?? []).includes(bozza)) continue;
        if (spec.kind !== 'enum' && Number.isNaN(Number(bozza))) continue;
        // E solo gli stati che il pannello puo' davvero produrre: una riga
        // UGUALE al default non dovrebbe esistere, e il server la toglie
        // comunque. Vedi il test qui sotto, che quel caso lo prova a parte.
        if (sameValue(spec.kind, salvato, spec.fallback)) continue;

        const client = changedSettings([spec], { [spec.key]: salvato }, { [spec.key]: bozza }).length > 0;
        const server =
          planSettings([spec], new Map([[spec.key, salvato]]), new Map([[spec.key, bozza]])).upserts.length +
            planSettings([spec], new Map([[spec.key, salvato]]), new Map([[spec.key, bozza]])).deletes
              .length >
          0;

        expect(client, `${spec.key}: ${salvato} -> ${bozza}`).toBe(server);
      }
    }
  });

  it('una riga uguale al default il server la toglie, e non e` una divergenza', async () => {
    // Se il database porta una riga che vale quanto il default — scritta da
    // una versione precedente, o a mano — la schermata non ha niente da
    // mostrare come modificato, e giustamente non accende Salva. Il server
    // pero', il giorno in cui si salva per altri motivi, quella riga la
    // toglie: e' una riga che dice quello che direbbe il silenzio, e finche'
    // resta li' quella modalita' non seguira' il plugin se il default cambia.
    const spec = MODE_SETTINGS.find((s) => s.key === 'RESPAWN_COOLDOWN');
    if (!spec) throw new Error('RESPAWN_COOLDOWN assente dal registro');

    expect(changedSettings([spec], { RESPAWN_COOLDOWN: '0' }, { RESPAWN_COOLDOWN: '0' })).toEqual([]);
    expect(
      planSettings([spec], new Map([['RESPAWN_COOLDOWN', '0']]), new Map([['RESPAWN_COOLDOWN', '0']]))
        .deletes,
    ).toEqual(['RESPAWN_COOLDOWN']);
  });

  it('e sul confronto dei singoli valori', async () => {
    expect(sameValue('double', '1.0', '1')).toBe(true);
    expect(sameValue('int', '10', '10.0')).toBe(true);
    expect(sameValue('enum', 'HARD', 'hard')).toBe(false);
    expect(sameValue('bool', '1', '0')).toBe(false);
  });
});
