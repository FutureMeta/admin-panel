// Il registro dei settings, confrontato con la tabella del plugin.
//
// PERCHE' LA TABELLA STA ANCHE QUI. E' la stessa forma di
// `src/authz/modules.ts`: da una parte l'implementazione, dall'altra la
// trascrizione della fonte, e un test che le confronta. Copiarla senza
// confrontarla non servirebbe a niente; confrontarla e' l'unico modo in cui
// una riga sbagliata — un default a 1 invece che a 0, un `int` dichiarato
// `double` — si fa vedere qui invece che all'avvio di un server di gioco.
//
// E QUI SBAGLIARE COSTA PIU' DEL SOLITO. Questi valori non li legge il
// pannello: li rilegge il plugin, ore dopo, mentre carica. Un valore fuori
// forma non degrada e non avvisa — impedisce il caricamento di quella
// modalita'.

import { describe, expect, it } from 'vitest';
import {
  isDefaultValue,
  MAP_SETTING_BY_KEY,
  MAP_SETTINGS,
  MODE_SETTING_BY_KEY,
  MODE_SETTING_GROUPS,
  MODE_SETTINGS,
  type SettingKind,
  type SettingSpec,
  settingValueIsValid,
  withObservedOptions,
} from '#src/duels/settings.ts';

/**
 * La tabella del plugin, trascritta: chiave, tipo, default.
 *
 * I default booleani sono scritti come `1`/`0` perche' e' la forma in cui
 * finiscono nella colonna `value`; nella documentazione del plugin sono
 * `true`/`false`, che e' lo stesso fatto detto in Java.
 */
const PLUGIN: ReadonlyArray<[string, SettingKind, string]> = [
  ['START_COOLDOWN', 'int', '3'],
  ['PLAYERS_TO_START', 'int', '2'],
  ['ITEM_DAMAGE', 'bool', '0'],
  ['PREVENT_ITEM_DROP', 'bool', '0'],
  ['DROP_INVENTORY_ON_DEATH', 'bool', '0'],
  ['PREVENT_ARMOR_TOOLS_DROP', 'bool', '0'],
  ['PREVENT_ARMOR_MOVE', 'bool', '0'],
  ['SATURATION', 'bool', '1'],
  ['DIFFICULTY', 'enum', 'HARD'],
  ['DAMAGE_MULTIPLIER', 'double', '1.0'],
  ['NATURAL_REGENERATION', 'bool', '1'],
  ['HUNGER', 'bool', '1'],
  ['PLACE_BLOCKS', 'bool', '0'],
  ['BREAK_BLOCKS', 'bool', '0'],
  ['BREAK_MAP_BLOCKS', 'bool', '0'],
  ['DROP_PLAYER_BLOCKS', 'bool', '1'],
  ['DROP_MAP_BLOCKS', 'bool', '0'],
  ['EXPLOSION_GRIEFING', 'bool', '0'],
  ['EXPLOSION_DESTROY_DROPS', 'bool', '1'],
  ['BED_EXPLOSION', 'bool', '0'],
  ['CREEPER_INSTANT_IGNITE', 'bool', '0'],
  ['CREEPER_EXPLOSION_TIME', 'int', '0'],
  ['MOB_TIMER', 'int', '10'],
  ['MOB_DROPS', 'bool', '1'],
  ['MAP_RESET', 'bool', '1'],
  ['RESPAWN_COOLDOWN', 'int', '0'],
  ['TEAM_OBJECTIVE_TYPE', 'enum', 'NONE'],
  ['INSTANT_DEATH', 'bool', '0'],
  ['FEED_DELAY', 'int', '0'],
  ['FEED_AMOUNT', 'int', '0'],
  ['HEAL_DELAY', 'int', '0'],
  ['HEAL_AMOUNT', 'double', '0.0'],
  ['HEALTH_INDICATOR', 'bool', '1'],
  ['ARROW_RETURN_COOLDOWN', 'int', '0'],
  ['TNT_JUMP', 'bool', '0'],
  ['TNT_INSTANT', 'bool', '0'],
  ['TNT_EXPLOSION_TIME', 'int', '0'],
  ['FIREBALL_JUMP', 'bool', '0'],
  ['FALL_DAMAGE', 'bool', '1'],
  ['PEARL_GLITCH', 'bool', '0'],
  ['AUTO_SMELT', 'bool', '0'],
  ['RANDOM_ITEM_COOLDOWN', 'int', '0'],
  ['MIN_ROUND', 'int', '2'],
  ['REFILL_KIT_ON_KILL', 'bool', '0'],
  ['TREECAPITATOR', 'bool', '0'],
  ['LEAF_APPLE_DROP_CHANCE', 'double', '0.0'],
  ['OPEN_MAP_CONTAINERS', 'bool', '0'],
  ['SHIELD_STUN', 'bool', '1'],
];

describe('il registro dice esattamente quello che dice il plugin', () => {
  it('quarantotto settings, nessuno in piu` e nessuno in meno', async () => {
    expect(MODE_SETTINGS).toHaveLength(48);
    expect(PLUGIN).toHaveLength(48);
    expect(MODE_SETTINGS.map((s) => s.key).sort()).toEqual(PLUGIN.map(([k]) => k).sort());
  });

  it('tipo e default coincidono riga per riga', async () => {
    // UN CONFRONTO SOLO, con tutte le differenze insieme: quarantotto
    // asserzioni separate direbbero la prima e tacerebbero le altre.
    const nostri = MODE_SETTINGS.map((s) => `${s.key} ${s.kind} ${s.fallback}`).sort();
    const loro = PLUGIN.map(([k, kind, def]) => `${k} ${kind} ${def}`).sort();
    expect(nostri).toEqual(loro);
  });

  it('nessuna chiave doppia', async () => {
    // Una chiave ripetuta non romperebbe niente: la seconda vincerebbe nella
    // mappa e la prima resterebbe visibile nell'elenco, cioe' due righe con
    // due valori per lo stesso setting.
    expect(MODE_SETTING_BY_KEY.size).toBe(MODE_SETTINGS.length);
  });

  it('ogni setting sta in uno dei sei gruppi dichiarati', async () => {
    // Un gruppo scritto male produce una settima sezione con una riga sola,
    // e la riga sparisce da dove chi la cerca andrebbe a cercarla.
    const fuori = MODE_SETTINGS.filter(
      (s) => !(MODE_SETTING_GROUPS as readonly string[]).includes(s.group),
    ).map((s) => s.key);
    expect(fuori).toEqual([]);
  });

  it('e i gruppi dichiarati sono tutti abitati', async () => {
    const abitati = new Set(MODE_SETTINGS.map((s) => s.group));
    expect([...MODE_SETTING_GROUPS].filter((g) => !abitati.has(g))).toEqual([]);
  });

  it('ogni enum porta i suoi valori ammessi, default compreso', async () => {
    for (const spec of [...MODE_SETTINGS, ...MAP_SETTINGS]) {
      if (spec.kind !== 'enum') continue;
      expect(spec.options, spec.key).toBeDefined();
      expect(spec.options, spec.key).toContain(spec.fallback);
    }
  });

  it('i due soli enum di modalita` sono quelli documentati', async () => {
    const enums = MODE_SETTINGS.filter((s) => s.kind === 'enum').map((s) => s.key);
    expect(enums.sort()).toEqual(['DIFFICULTY', 'TEAM_OBJECTIVE_TYPE']);
    expect(MODE_SETTING_BY_KEY.get('DIFFICULTY')?.options).toEqual(['PEACEFUL', 'EASY', 'NORMAL', 'HARD']);
    expect(MODE_SETTING_BY_KEY.get('TEAM_OBJECTIVE_TYPE')?.options).toEqual([
      'NONE',
      'DESTROY_BLOCK',
      'ENTER_AREA',
    ]);
  });
});

/**
 * Il registro DEVE avere questa chiave.
 *
 * Non `?.` e non `!`: se un giorno la chiave viene rinominata, questo test
 * deve dire quale manca, non passare su un `undefined` o rompersi con un
 * messaggio che non nomina niente.
 */
function spec(key: string): SettingSpec {
  const found = MODE_SETTING_BY_KEY.get(key) ?? MAP_SETTING_BY_KEY.get(key);
  if (!found) throw new Error(`chiave assente dal registro: ${key}`);
  return found;
}

describe('quello che si puo` scrivere nella colonna `value`', () => {
  it('i booleani sono `1` e `0`, e nient`altro', async () => {
    const bool = spec('SATURATION');
    expect(settingValueIsValid(bool, '1')).toBe(true);
    expect(settingValueIsValid(bool, '0')).toBe(true);
    // `true` lo rileggerebbe anche il plugin, ma due forme per lo stesso
    // valore vogliono dire normalizzare prima di ogni confronto con il
    // default, e prima o poi qualcuno non lo fa.
    expect(settingValueIsValid(bool, 'true')).toBe(false);
    expect(settingValueIsValid(bool, '')).toBe(false);
  });

  it('gli interi non accettano virgole, spazi, ne` notazione esponenziale', async () => {
    const int = spec('START_COOLDOWN');
    expect(settingValueIsValid(int, '5')).toBe(true);
    expect(settingValueIsValid(int, '-2')).toBe(true);
    expect(settingValueIsValid(int, '3.5')).toBe(false);
    expect(settingValueIsValid(int, '3,5')).toBe(false);
    expect(settingValueIsValid(int, ' 3')).toBe(false);
    expect(settingValueIsValid(int, '1e3')).toBe(false);
  });

  it('i decimali usano il PUNTO, perche` a rileggerli e` Java', async () => {
    // `1,5` con la virgola e' come si scrive in italiano ed e' esattamente il
    // valore che il plugin non sa rileggere.
    const dbl = spec('DAMAGE_MULTIPLIER');
    expect(settingValueIsValid(dbl, '1.5')).toBe(true);
    expect(settingValueIsValid(dbl, '2')).toBe(true);
    expect(settingValueIsValid(dbl, '1,5')).toBe(false);
  });

  it('gli enum sono un elenco CHIUSO e maiuscolo', async () => {
    // `Enum.valueOf` e' case-sensitive e lancia: `hard` non e' `HARD`, ed e'
    // la differenza fra una modalita' che carica e una che no.
    const enu = spec('DIFFICULTY');
    expect(settingValueIsValid(enu, 'HARD')).toBe(true);
    expect(settingValueIsValid(enu, 'hard')).toBe(false);
    expect(settingValueIsValid(enu, 'BRUTAL')).toBe(false);
    expect(settingValueIsValid(enu, '')).toBe(false);
  });
});

describe('riconoscere il default e` cio` che decide se la riga esiste', () => {
  it('`1` e `1.0` sono lo STESSO default', async () => {
    // Confrontandoli come stringhe si scriverebbe una riga per un valore che
    // gia' vale, e da quel momento il default del plugin e quella riga sono
    // due numeri distinti: se una versione nuova cambia il default, la
    // modalita' con la riga scritta non lo segue e non lo dice nessuno.
    const dbl = spec('DAMAGE_MULTIPLIER');
    expect(isDefaultValue(dbl, '1.0')).toBe(true);
    expect(isDefaultValue(dbl, '1')).toBe(true);
    expect(isDefaultValue(dbl, '1.00')).toBe(true);
    expect(isDefaultValue(dbl, '1.5')).toBe(false);
  });

  it('e vale anche per gli interi', async () => {
    const int = spec('MOB_TIMER');
    expect(isDefaultValue(int, '10')).toBe(true);
    expect(isDefaultValue(int, '11')).toBe(false);
  });
});

describe('gli enum di cui non conosciamo tutti i valori', () => {
  it('si allargano con quelli GIA` presenti nel database', async () => {
    // Un valore che una mappa usa gia' e' un valore che il plugin rilegge
    // senza lanciare: e' una prova, non un'ipotesi.
    const [found] = withObservedOptions(
      MAP_SETTINGS.filter((s) => s.key === 'DOOR_DIRECTION'),
      new Map([['DOOR_DIRECTION', ['DOWN', 'UP']]]),
    );
    expect(found?.options).toEqual(['UP', 'DOWN']);
    expect(found ? settingValueIsValid(found, 'DOWN') : false).toBe(true);
  });

  it('ma non con quello che non ha la forma di una costante', async () => {
    // Il valore osservato viene dal database del gioco, che non e' nostro:
    // arriva come `TEXT` e puo' contenere qualunque cosa.
    const [found] = withObservedOptions(
      MAP_SETTINGS.filter((s) => s.key === 'DOOR_DIRECTION'),
      new Map([['DOOR_DIRECTION', ['down', '', 'DROP TABLE', '1']]]),
    );
    expect(found?.options).toEqual(['UP']);
  });

  it('e non tocca i settings che non sono enum', async () => {
    const door = withObservedOptions(MAP_SETTINGS, new Map([['DOOR', ['SI']]])).find((s) => s.key === 'DOOR');
    expect(door?.options).toBeUndefined();
  });
});
