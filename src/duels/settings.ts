// Il registro dei settings del plugin: cosa esiste, di che tipo e', e quanto
// vale quando nessuno lo ha toccato.
//
// STA SUL SERVER E VIAGGIA NEL PAYLOAD. La schermata deve disegnare
// quarantotto righe tipizzate con etichetta, default e valori ammessi: se
// quell'elenco lo tenesse anche il client sarebbero due copie della stessa
// tabella, e la seconda si dimenticherebbe — e' gia' successo due volte in
// questo pannello, con le aree dei moduli e con il loro numero.
//
// PERCHE' I DEFAULT CONTANO PIU' DI QUANTO SEMBRI. Nel database del gioco una
// riga ASSENTE significa «usa il default»: il plugin non legge una tabella
// completa di quarantotto righe per modalita', legge quelle che ci sono. Da
// qui due regole che questo modulo esiste per far rispettare:
//
//   * scrivere un valore uguale al default NON e' innocuo. Lascia una riga che
//     dice la stessa cosa del silenzio, e da quel momento il default del
//     plugin e quella riga sono due numeri distinti che possono divergere: se
//     una versione nuova del plugin cambia quel default, la modalita' con la
//     riga scritta non lo segue, e non lo dice nessuno;
//   * riportare un setting al default si fa CANCELLANDO la riga, non
//     scrivendoci sopra il valore di default.
//
// E LE STRINGHE DEGLI ENUM SONO FRAGILI. Il plugin le rilegge con
// `Enum.valueOf`, che e' case-sensitive e LANCIA: un valore sbagliato non
// degrada, impedisce il caricamento di quella modalita' all'avvio del server.
// Per questo il valore ammesso e' un elenco chiuso e non un campo di testo.

/** Come si legge — e come si riscrive — il `TEXT` della colonna `value`. */
export type SettingKind = 'bool' | 'int' | 'double' | 'enum';

export type SettingSpec = {
  /** La costante del plugin. E' meta' della chiave primaria, MAIUSCOLA. */
  key: string;
  kind: SettingKind;
  /** Il default del plugin, nella forma in cui si scriverebbe su `value`. */
  fallback: string;
  /** Solo per `enum`: i soli valori che il plugin sa rileggere. */
  options?: readonly string[];
  /** Il gruppo in cui la schermata lo mostra. */
  group: string;
  /** Come si chiama per chi lo legge. Le chiavi restano quelle del plugin. */
  label: string;
};

const DIFFICULTY = ['PEACEFUL', 'EASY', 'NORMAL', 'HARD'] as const;
const OBJECTIVE = ['NONE', 'DESTROY_BLOCK', 'ENTER_AREA'] as const;

/**
 * I sei gruppi.
 *
 * Il raggruppamento NON viene dal plugin — li' i quarantotto settings sono un
 * elenco piatto — e nemmeno dal mockup, che ne mostra sei senza nominarli. E'
 * una scelta di lettura: quarantotto righe di seguito non si scorrono, e senza
 * gruppi l'unico modo di trovare «danno da caduta» e' sapere gia' come si
 * chiama la costante.
 */
export const MODE_SETTING_GROUPS = [
  'Partita',
  'Giocatore',
  'Oggetti',
  'Blocchi',
  'Esplosivi',
  'Creature',
] as const;

/**
 * I quarantotto `ModeSetting`, con il default del plugin.
 *
 * L'ordine dentro un gruppo e' quello in cui si leggono, non quello del codice
 * Java: chi apre «Partita» cerca prima quanto dura il conto alla rovescia e
 * poi quante persone servono per cominciare.
 */
export const MODE_SETTINGS: readonly SettingSpec[] = [
  // --- Partita -------------------------------------------------------------
  { key: 'START_COOLDOWN', kind: 'int', fallback: '3', group: 'Partita', label: 'Conto alla rovescia' },
  { key: 'PLAYERS_TO_START', kind: 'int', fallback: '2', group: 'Partita', label: 'Giocatori per iniziare' },
  { key: 'MIN_ROUND', kind: 'int', fallback: '2', group: 'Partita', label: 'Round minimi' },
  { key: 'RESPAWN_COOLDOWN', kind: 'int', fallback: '0', group: 'Partita', label: 'Attesa di rinascita' },
  { key: 'INSTANT_DEATH', kind: 'bool', fallback: '0', group: 'Partita', label: 'Morte immediata' },
  { key: 'MAP_RESET', kind: 'bool', fallback: '1', group: 'Partita', label: 'Ripristina la mappa' },
  {
    key: 'TEAM_OBJECTIVE_TYPE',
    kind: 'enum',
    fallback: 'NONE',
    options: OBJECTIVE,
    group: 'Partita',
    label: 'Obiettivo di squadra',
  },

  // --- Giocatore -----------------------------------------------------------
  {
    key: 'DIFFICULTY',
    kind: 'enum',
    fallback: 'HARD',
    options: DIFFICULTY,
    group: 'Giocatore',
    label: 'Difficoltà',
  },
  {
    key: 'DAMAGE_MULTIPLIER',
    kind: 'double',
    fallback: '1.0',
    group: 'Giocatore',
    label: 'Moltiplicatore del danno',
  },
  {
    key: 'NATURAL_REGENERATION',
    kind: 'bool',
    fallback: '1',
    group: 'Giocatore',
    label: 'Rigenerazione naturale',
  },
  { key: 'SATURATION', kind: 'bool', fallback: '1', group: 'Giocatore', label: 'Saturazione' },
  { key: 'HUNGER', kind: 'bool', fallback: '1', group: 'Giocatore', label: 'Fame' },
  { key: 'FEED_DELAY', kind: 'int', fallback: '0', group: 'Giocatore', label: 'Intervallo di nutrimento' },
  { key: 'FEED_AMOUNT', kind: 'int', fallback: '0', group: 'Giocatore', label: 'Quantità di nutrimento' },
  { key: 'HEAL_DELAY', kind: 'int', fallback: '0', group: 'Giocatore', label: 'Intervallo di cura' },
  { key: 'HEAL_AMOUNT', kind: 'double', fallback: '0.0', group: 'Giocatore', label: 'Quantità di cura' },
  {
    key: 'HEALTH_INDICATOR',
    kind: 'bool',
    fallback: '1',
    group: 'Giocatore',
    label: 'Indicatore della vita',
  },
  { key: 'FALL_DAMAGE', kind: 'bool', fallback: '1', group: 'Giocatore', label: 'Danno da caduta' },
  { key: 'SHIELD_STUN', kind: 'bool', fallback: '1', group: 'Giocatore', label: 'Stordimento con lo scudo' },

  // --- Oggetti -------------------------------------------------------------
  { key: 'ITEM_DAMAGE', kind: 'bool', fallback: '0', group: 'Oggetti', label: 'Usura degli oggetti' },
  {
    key: 'PREVENT_ITEM_DROP',
    kind: 'bool',
    fallback: '0',
    group: 'Oggetti',
    label: 'Impedisci di lasciare oggetti',
  },
  {
    key: 'DROP_INVENTORY_ON_DEATH',
    kind: 'bool',
    fallback: '0',
    group: 'Oggetti',
    label: 'Lascia tutto alla morte',
  },
  {
    key: 'PREVENT_ARMOR_TOOLS_DROP',
    kind: 'bool',
    fallback: '0',
    group: 'Oggetti',
    label: 'Trattieni armatura e attrezzi',
  },
  {
    key: 'PREVENT_ARMOR_MOVE',
    kind: 'bool',
    fallback: '0',
    group: 'Oggetti',
    label: 'Blocca lo spostamento dell’armatura',
  },
  {
    key: 'REFILL_KIT_ON_KILL',
    kind: 'bool',
    fallback: '0',
    group: 'Oggetti',
    label: 'Ricarica il kit a ogni uccisione',
  },
  { key: 'AUTO_SMELT', kind: 'bool', fallback: '0', group: 'Oggetti', label: 'Fusione automatica' },
  {
    key: 'RANDOM_ITEM_COOLDOWN',
    kind: 'int',
    fallback: '0',
    group: 'Oggetti',
    label: 'Attesa dell’oggetto casuale',
  },
  {
    key: 'ARROW_RETURN_COOLDOWN',
    kind: 'int',
    fallback: '0',
    group: 'Oggetti',
    label: 'Attesa del ritorno frecce',
  },

  // --- Blocchi -------------------------------------------------------------
  { key: 'PLACE_BLOCKS', kind: 'bool', fallback: '0', group: 'Blocchi', label: 'Piazzare blocchi' },
  { key: 'BREAK_BLOCKS', kind: 'bool', fallback: '0', group: 'Blocchi', label: 'Rompere blocchi' },
  {
    key: 'BREAK_MAP_BLOCKS',
    kind: 'bool',
    fallback: '0',
    group: 'Blocchi',
    label: 'Rompere i blocchi della mappa',
  },
  {
    key: 'DROP_PLAYER_BLOCKS',
    kind: 'bool',
    fallback: '1',
    group: 'Blocchi',
    label: 'I blocchi dei giocatori cadono',
  },
  {
    key: 'DROP_MAP_BLOCKS',
    kind: 'bool',
    fallback: '0',
    group: 'Blocchi',
    label: 'I blocchi della mappa cadono',
  },
  {
    key: 'OPEN_MAP_CONTAINERS',
    kind: 'bool',
    fallback: '0',
    group: 'Blocchi',
    label: 'Aprire i contenitori della mappa',
  },
  { key: 'TREECAPITATOR', kind: 'bool', fallback: '0', group: 'Blocchi', label: 'Abbattere l’albero intero' },
  {
    key: 'LEAF_APPLE_DROP_CHANCE',
    kind: 'double',
    fallback: '0.0',
    group: 'Blocchi',
    label: 'Probabilità della mela dalle foglie',
  },

  // --- Esplosivi -----------------------------------------------------------
  {
    key: 'EXPLOSION_GRIEFING',
    kind: 'bool',
    fallback: '0',
    group: 'Esplosivi',
    label: 'Le esplosioni rompono',
  },
  {
    key: 'EXPLOSION_DESTROY_DROPS',
    kind: 'bool',
    fallback: '1',
    group: 'Esplosivi',
    label: 'Le esplosioni distruggono gli oggetti a terra',
  },
  { key: 'BED_EXPLOSION', kind: 'bool', fallback: '0', group: 'Esplosivi', label: 'Esplosione dei letti' },
  {
    key: 'CREEPER_INSTANT_IGNITE',
    kind: 'bool',
    fallback: '0',
    group: 'Esplosivi',
    label: 'I creeper si innescano subito',
  },
  {
    key: 'CREEPER_EXPLOSION_TIME',
    kind: 'int',
    fallback: '0',
    group: 'Esplosivi',
    label: 'Tempo di innesco dei creeper',
  },
  { key: 'TNT_JUMP', kind: 'bool', fallback: '0', group: 'Esplosivi', label: 'Salto con il TNT' },
  { key: 'TNT_INSTANT', kind: 'bool', fallback: '0', group: 'Esplosivi', label: 'TNT istantaneo' },
  {
    key: 'TNT_EXPLOSION_TIME',
    kind: 'int',
    fallback: '0',
    group: 'Esplosivi',
    label: 'Tempo di innesco del TNT',
  },
  {
    key: 'FIREBALL_JUMP',
    kind: 'bool',
    fallback: '0',
    group: 'Esplosivi',
    label: 'Salto con la palla di fuoco',
  },

  // --- Creature ------------------------------------------------------------
  { key: 'MOB_TIMER', kind: 'int', fallback: '10', group: 'Creature', label: 'Timer delle creature' },
  { key: 'MOB_DROPS', kind: 'bool', fallback: '1', group: 'Creature', label: 'Le creature lasciano oggetti' },
  { key: 'PEARL_GLITCH', kind: 'bool', fallback: '0', group: 'Creature', label: 'Glitch della perla' },
];

/**
 * I sei `MapSetting`.
 *
 * `DOOR_DIRECTION` e' un enum di cui conosciamo SOLO il default: l'elenco
 * completo dei valori non ce l'ha dato nessuno. Finche' non ce l'ha, le scelte
 * offerte sono `UP` piu' quelle gia' presenti nel database — vedi
 * `withObservedOptions`. Inventarne altre sarebbe il modo esatto di impedire
 * il caricamento di una mappa: `Enum.valueOf` lancia, non ripiega.
 */
export const MAP_SETTINGS: readonly SettingSpec[] = [
  { key: 'DOOR', kind: 'bool', fallback: '1', group: 'Porta', label: 'Porta di partenza' },
  {
    key: 'DOOR_DIRECTION',
    kind: 'enum',
    fallback: 'UP',
    options: ['UP'],
    group: 'Porta',
    label: 'Direzione di apertura',
  },
  { key: 'DOOR_DISTANCE', kind: 'int', fallback: '3', group: 'Porta', label: 'Distanza della porta' },
  { key: 'DOOR_TIME', kind: 'int', fallback: '2', group: 'Porta', label: 'Durata dell’apertura' },
  {
    key: 'MOVE_DURING_COOLDOWN',
    kind: 'bool',
    fallback: '1',
    group: 'Partenza',
    label: 'Muoversi durante il conto alla rovescia',
  },
  {
    key: 'TELEPORT_ON_PLAY',
    kind: 'bool',
    fallback: '0',
    group: 'Partenza',
    label: 'Teletrasporto all’avvio',
  },
];

export const MODE_SETTING_BY_KEY = new Map(MODE_SETTINGS.map((s) => [s.key, s]));
export const MAP_SETTING_BY_KEY = new Map(MAP_SETTINGS.map((s) => [s.key, s]));

/**
 * Aggiunge a un enum i valori GIA' PRESENTI nel database.
 *
 * Serve per `DOOR_DIRECTION`, di cui conosciamo un valore su chissa' quanti.
 * Un valore che una mappa usa gia' e' un valore che il plugin rilegge senza
 * lanciare — e' una prova, non un'ipotesi — quindi si puo' offrire. Quello che
 * NON si fa e' completare l'elenco a intuito: `DOWN` e `NORTH` sembrano
 * ovvi e non lo sono, e l'errore non si vedrebbe qui.
 *
 * Il valore osservato viene comunque dal database del gioco, quindi si
 * normalizza e si scarta tutto cio' che non ha la forma di una costante.
 */
export function withObservedOptions(
  specs: readonly SettingSpec[],
  observed: ReadonlyMap<string, readonly string[]>,
): SettingSpec[] {
  return specs.map((spec) => {
    if (spec.kind !== 'enum') return spec;
    const extra = (observed.get(spec.key) ?? []).filter((v) => /^[A-Z][A-Z0-9_]*$/.test(v));
    const options = [...new Set([...(spec.options ?? []), ...extra])];
    return { ...spec, options };
  });
}

/**
 * Il valore proposto e' scrivibile per questo setting?
 *
 * FALLISCE CHIUSO, E SUL SERVER. Quello che arriva dal client non e' fidato, e
 * qui un valore sbagliato non produce un errore nel pannello: lo produce
 * all'avvio di un server di gioco, ore dopo, come una modalita' che non
 * carica. Questo e' il punto in cui accorgersene costa poco.
 */
export function settingValueIsValid(spec: SettingSpec, value: string): boolean {
  switch (spec.kind) {
    case 'bool':
      // Solo `1` e `0`: e' la forma che scrive il gioco stesso e che
      // `getBoolean` rilegge. `true`/`false` funzionerebbero, ma due forme
      // per lo stesso valore vorrebbero dire normalizzare prima di ogni
      // confronto con il default — e prima o poi qualcuno non lo fa.
      return value === '1' || value === '0';
    case 'int':
      return /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value));
    case 'double':
      return /^-?\d+(\.\d+)?$/.test(value) && Number.isFinite(Number(value));
    case 'enum':
      return (spec.options ?? []).includes(value);
  }
}

/**
 * Il valore coincide con il default del plugin?
 *
 * I numeri si confrontano come NUMERI: `1` e `1.0` sono lo stesso default
 * scritto in due modi, e confrontandoli come stringhe si lascerebbe in tabella
 * una riga inutile — cioe' proprio la riga che, il giorno in cui il plugin
 * cambia quel default, impedisce alla modalita' di seguirlo.
 */
export function isDefaultValue(spec: SettingSpec, value: string): boolean {
  if (spec.kind === 'int' || spec.kind === 'double') {
    return Number(value) === Number(spec.fallback);
  }
  return value === spec.fallback;
}
