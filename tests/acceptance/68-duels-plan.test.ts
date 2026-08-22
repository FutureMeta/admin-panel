// Cosa viene scritto davvero quando si preme Salva.
//
// TUTTO QUELLO CHE C'E' QUI SBAGLIA IN SILENZIO. Non esiste un caso in cui il
// pannello mostri un errore: il piano parte, il database accetta, la schermata
// dice «salvato». Quello che cambia e' cosa trova un server di gioco al
// riavvio successivo — ore dopo, altrove, senza niente che colleghi le due
// cose.
//
// Le quattro regole che questi test tengono ferme:
//
//   1. tornare al default CANCELLA la riga, non ci scrive sopra il default;
//   2. un valore che non e' cambiato non si riscrive;
//   3. una riga che il registro non conosce non si tocca;
//   4. un insieme si aggiorna per differenza, non svuotandolo e rifacendolo.

import { describe, expect, it } from 'vitest';
import { isEmptySetPlan, isEmptySettingPlan, planSet, planSettings } from '#src/duels/plan.ts';
import { MODE_SETTINGS, type SettingSpec } from '#src/duels/settings.ts';

function spec(key: string): SettingSpec {
  const found = MODE_SETTINGS.find((s) => s.key === key);
  if (!found) throw new Error(`chiave assente dal registro: ${key}`);
  return found;
}

/** `SATURATION` vale 1 di default, `PLACE_BLOCKS` vale 0, `MOB_TIMER` vale 10. */
const SATURATION = spec('SATURATION');
const PLACE_BLOCKS = spec('PLACE_BLOCKS');
const MOB_TIMER = spec('MOB_TIMER');
const DAMAGE = spec('DAMAGE_MULTIPLIER');

const plan = (
  specs: readonly SettingSpec[],
  current: Record<string, string>,
  desired: Record<string, string>,
) => planSettings(specs, new Map(Object.entries(current)), new Map(Object.entries(desired)));

describe('tornare al default cancella la riga', () => {
  it('il valore di default NON si scrive: si toglie la riga', async () => {
    // Scriverlo lascerebbe una riga che dice quello che direbbe il silenzio, e
    // da quel momento il default del plugin e quella riga sono due numeri
    // distinti. Il giorno in cui una versione nuova cambia quel default,
    // questa modalita' non lo segue — e non lo dice nessuno.
    const p = plan([SATURATION], { SATURATION: '0' }, { SATURATION: '1' });

    expect(p.deletes).toEqual(['SATURATION']);
    expect(p.upserts).toEqual([]);
  });

  it('e se la riga non c`era, non si cancella niente', async () => {
    // Una DELETE su una riga assente riesce senza toccare niente, quindi il
    // difetto non si vedrebbe: si vedrebbe nel registro di audit, come una
    // modifica che non ha modificato nulla.
    const p = plan([SATURATION], {}, { SATURATION: '1' });
    expect(isEmptySettingPlan(p)).toBe(true);
  });

  it('vale anche quando il default si scrive in un altro modo', async () => {
    // `1.0` e `1` sono lo stesso default. Confrontandoli come stringhe la riga
    // resterebbe li'.
    const p = plan([DAMAGE], { DAMAGE_MULTIPLIER: '2.5' }, { DAMAGE_MULTIPLIER: '1' });
    expect(p.deletes).toEqual(['DAMAGE_MULTIPLIER']);
  });
});

describe('quello che non e` cambiato non si riscrive', () => {
  it('stesso valore, nessuna scrittura', async () => {
    const p = plan([MOB_TIMER], { MOB_TIMER: '30' }, { MOB_TIMER: '30' });
    expect(isEmptySettingPlan(p)).toBe(true);
  });

  it('stesso NUMERO scritto in due modi, nessuna scrittura', async () => {
    // Riscriverlo non cambierebbe il gioco e sporcherebbe l'audit di modifiche
    // che non hanno modificato niente — che e' il modo piu' rapido di rendere
    // inutile un registro.
    const p = plan([DAMAGE], { DAMAGE_MULTIPLIER: '2.0' }, { DAMAGE_MULTIPLIER: '2' });
    expect(isEmptySettingPlan(p)).toBe(true);
  });

  it('un valore diverso dal default e diverso da adesso si scrive', async () => {
    const p = plan([PLACE_BLOCKS], {}, { PLACE_BLOCKS: '1' });
    expect(p.upserts).toEqual([{ key: 'PLACE_BLOCKS', value: '1' }]);
    expect(p.deletes).toEqual([]);
  });

  it('un setting che la schermata non ha mandato resta com`e`', async () => {
    // «Assente» e «riportato al default» sono due cose diverse, e confonderle
    // significherebbe che aprire una scheda e salvarla senza toccare niente
    // cancella tutti i settings che quella scheda non mostrava.
    const p = plan([SATURATION, MOB_TIMER], { SATURATION: '0', MOB_TIMER: '30' }, { MOB_TIMER: '30' });
    expect(isEmptySettingPlan(p)).toBe(true);
  });
});

describe('le righe che il registro non conosce non si toccano', () => {
  it('un setting sconosciuto sopravvive al salvataggio', async () => {
    // E' il caso del plugin piu' nuovo del pannello. Cancellarlo sarebbe
    // togliere una configurazione messa apposta; non disegnarlo e' solo
    // ammettere di non conoscerla.
    const p = plan([SATURATION], { SATURATION: '0', SETTING_DEL_FUTURO: '7' }, { SATURATION: '0' });
    expect(isEmptySettingPlan(p)).toBe(true);
    expect(p.deletes).not.toContain('SETTING_DEL_FUTURO');
  });

  it('e nemmeno se la schermata prova a mandarlo', async () => {
    // Il piano guarda SOLO il registro: quello che arriva dal client non
    // decide quali chiavi esistono.
    const p = plan([SATURATION], {}, { SETTING_DEL_FUTURO: '9' });
    expect(isEmptySettingPlan(p)).toBe(true);
  });
});

describe('gli insiemi si aggiornano per differenza', () => {
  it('aggiunge e toglie solo cio` che e` cambiato', async () => {
    // Non «cancella tutto e riscrivi»: su una tabella con cascate quella e'
    // una finestra in cui lo stato vuoto e' visibile a qualcun altro.
    const p = planSet([1, 2, 3], [2, 3, 4]);
    expect(p.add).toEqual([4]);
    expect(p.remove).toEqual([1]);
  });

  it('nessuna differenza, nessuna scrittura', async () => {
    expect(isEmptySetPlan(planSet([1, 2], [2, 1]))).toBe(true);
  });

  it('svuotare toglie tutto senza aggiungere', async () => {
    const p = planSet(['UHC', 'PILLARS'], []);
    expect(p.remove.sort()).toEqual(['PILLARS', 'UHC']);
    expect(p.add).toEqual([]);
  });

  it('i doppioni non producono scritture doppie', async () => {
    // Due volte lo stesso valore nella richiesta e' una INSERT che viola la
    // chiave primaria, cioe' un salvataggio che fallisce per intero.
    const p = planSet([], ['UHC', 'UHC']);
    expect(p.add).toEqual(['UHC']);
  });
});
