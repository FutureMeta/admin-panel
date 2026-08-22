// Il registro dei settings del plugin: cosa esiste, di che tipo e', e quanto
// vale quando nessuno lo ha toccato.
//
// STA SUL SERVER E VIAGGIA NEL PAYLOAD. La schermata deve disegnare
// quarantotto righe tipizzate con tipo, default e valori ammessi: se
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
  /**
   * Il gruppo in cui la schermata lo mostra. Assente per i settings di mappa,
   * che nel disegno sono un elenco unico.
   */
  group?: string;
};

// ---------------------------------------------------------------------------
// Gli enum delle colonne, non dei settings
// ---------------------------------------------------------------------------

/** `duels_mode.type`. Non esiste `EVENT`: il contesto e' della MAPPA. */
export const MODE_TYPES = ['DUEL', 'FFA'] as const;

/** `duels_mode.ranking`. */
export const RANKING_TYPES = ['UNRANKED', 'RANKED'] as const;

/** `duels_map.type`. */
export const MATCH_TYPES = ['DUEL', 'FFA'] as const;

/** `duels_map.context`. */
export const MATCH_CONTEXTS = ['NORMAL', 'EVENT'] as const;

/**
 * `duels_map_event_type.event_type`.
 *
 * Elenco completo, confermato dall'esercente il 22 agosto 2026. Resta scritto
 * qui e non indovinato altrove: e' una colonna `VARCHAR` senza vincolo, quindi
 * il database accetta qualunque cosa e il plugin lancia leggendola.
 *
 * SI UNISCE SEMPRE A QUELLO CHE C'E' GIA'. Se una mappa usasse un valore che
 * questo elenco non contiene — un tipo aggiunto al plugin e non qui — mostrare
 * solo l'elenco lo farebbe sparire dalla schermata, e salvare la scheda lo
 * cancellerebbe dal database senza che nessuno abbia chiesto di toglierlo.
 * Vedi `withObserved`.
 */
export const EVENT_TYPES = ['UHC', 'MANHUNT', 'CRYSTAL_ROYALE', 'TNT_RUN', 'PILLARS', 'LAVA_RISE'] as const;

/**
 * L'elenco dichiarato piu' quello osservato nel database, senza doppioni.
 *
 * E' la rete che impedisce a una schermata di cancellare cio' che non sa
 * disegnare. Quello che arriva dal database del gioco passa comunque per il
 * filtro di forma: e' `TEXT` senza vincoli, e non e' roba nostra.
 */
export function withObserved(declared: readonly string[], observed: readonly string[]): string[] {
  const extra = observed.filter((v) => /^[A-Z][A-Z0-9_]*$/.test(v));
  return [...new Set([...declared, ...extra])];
}

/**
 * I sei gruppi, NELL'ORDINE DICHIARATO DAL MOCKUP.
 *
 * Non nell'ordine in cui compaiono nella tabella: sono due ordini diversi —
 * «Blocchi & mappa» viene prima di «Oggetti & inventario» nell'elenco e dopo
 * nella tabella — e ricavarlo dai dati invece di leggerlo darebbe sei sezioni
 * in un ordine che nessuno ha scelto.
 */
export const MODE_SETTING_GROUPS = [
  'Round & partita',
  'Combattimento',
  'Blocchi & mappa',
  'Oggetti & inventario',
  'Mob & ambiente',
  'Recupero & cure',
] as const;

/**
 * I quarantotto `ModeSetting`: chiave, tipo, default, gruppo.
 *
 * NESSUNA DESCRIZIONE, e non e' una dimenticanza. La riga mostra il nome della
 * costante e basta, perche' e' quello il nome della cosa: e' cio' che sta nel
 * database, cio' che il plugin rilegge, e cio' con cui se ne parla. Una
 * traduzione italiana accanto sarebbe una seconda verita' da tenere allineata
 * a mano, e chi cerca `SHIELD_STUN` cerca `SHIELD_STUN`.
 *
 * TABELLA E ORDINE VENGONO DAL MOCKUP, generati da `frontend/metamc-shared.js`
 * invece di ricopiati: cinquantaquattro righe trascritte a occhio sono
 * cinquantaquattro occasioni di sbagliare un default, e un default sbagliato
 * qui non lo vede nessuno finche' non lo vede un server di gioco.
 */
export const MODE_SETTINGS: readonly SettingSpec[] = [
  { key: 'START_COOLDOWN', kind: 'int', fallback: '3', group: 'Round & partita' },
  { key: 'PLAYERS_TO_START', kind: 'int', fallback: '2', group: 'Round & partita' },
  { key: 'ITEM_DAMAGE', kind: 'bool', fallback: '0', group: 'Combattimento' },
  { key: 'PREVENT_ITEM_DROP', kind: 'bool', fallback: '0', group: 'Oggetti & inventario' },
  { key: 'DROP_INVENTORY_ON_DEATH', kind: 'bool', fallback: '0', group: 'Oggetti & inventario' },
  { key: 'PREVENT_ARMOR_TOOLS_DROP', kind: 'bool', fallback: '0', group: 'Oggetti & inventario' },
  { key: 'PREVENT_ARMOR_MOVE', kind: 'bool', fallback: '0', group: 'Oggetti & inventario' },
  { key: 'SATURATION', kind: 'bool', fallback: '1', group: 'Combattimento' },
  {
    key: 'DIFFICULTY',
    kind: 'enum',
    fallback: 'HARD',
    options: ['PEACEFUL', 'EASY', 'NORMAL', 'HARD'],
    group: 'Combattimento',
  },
  { key: 'DAMAGE_MULTIPLIER', kind: 'double', fallback: '1.0', group: 'Combattimento' },
  { key: 'NATURAL_REGENERATION', kind: 'bool', fallback: '1', group: 'Combattimento' },
  { key: 'HUNGER', kind: 'bool', fallback: '1', group: 'Combattimento' },
  { key: 'PLACE_BLOCKS', kind: 'bool', fallback: '0', group: 'Blocchi & mappa' },
  { key: 'BREAK_BLOCKS', kind: 'bool', fallback: '0', group: 'Blocchi & mappa' },
  { key: 'BREAK_MAP_BLOCKS', kind: 'bool', fallback: '0', group: 'Blocchi & mappa' },
  { key: 'DROP_PLAYER_BLOCKS', kind: 'bool', fallback: '1', group: 'Oggetti & inventario' },
  { key: 'DROP_MAP_BLOCKS', kind: 'bool', fallback: '0', group: 'Blocchi & mappa' },
  { key: 'EXPLOSION_GRIEFING', kind: 'bool', fallback: '0', group: 'Combattimento' },
  { key: 'EXPLOSION_DESTROY_DROPS', kind: 'bool', fallback: '1', group: 'Combattimento' },
  { key: 'BED_EXPLOSION', kind: 'bool', fallback: '0', group: 'Combattimento' },
  { key: 'CREEPER_INSTANT_IGNITE', kind: 'bool', fallback: '0', group: 'Combattimento' },
  { key: 'CREEPER_EXPLOSION_TIME', kind: 'int', fallback: '0', group: 'Combattimento' },
  { key: 'MOB_TIMER', kind: 'int', fallback: '10', group: 'Mob & ambiente' },
  { key: 'MOB_DROPS', kind: 'bool', fallback: '1', group: 'Mob & ambiente' },
  { key: 'MAP_RESET', kind: 'bool', fallback: '1', group: 'Blocchi & mappa' },
  { key: 'RESPAWN_COOLDOWN', kind: 'int', fallback: '0', group: 'Round & partita' },
  {
    key: 'TEAM_OBJECTIVE_TYPE',
    kind: 'enum',
    fallback: 'NONE',
    options: ['NONE', 'DESTROY_BLOCK', 'ENTER_AREA'],
    group: 'Round & partita',
  },
  { key: 'INSTANT_DEATH', kind: 'bool', fallback: '0', group: 'Combattimento' },
  { key: 'FEED_DELAY', kind: 'int', fallback: '0', group: 'Recupero & cure' },
  { key: 'FEED_AMOUNT', kind: 'int', fallback: '0', group: 'Recupero & cure' },
  { key: 'HEAL_DELAY', kind: 'int', fallback: '0', group: 'Recupero & cure' },
  { key: 'HEAL_AMOUNT', kind: 'double', fallback: '0.0', group: 'Recupero & cure' },
  { key: 'HEALTH_INDICATOR', kind: 'bool', fallback: '1', group: 'Combattimento' },
  { key: 'ARROW_RETURN_COOLDOWN', kind: 'int', fallback: '0', group: 'Combattimento' },
  { key: 'TNT_JUMP', kind: 'bool', fallback: '0', group: 'Combattimento' },
  { key: 'TNT_INSTANT', kind: 'bool', fallback: '0', group: 'Combattimento' },
  { key: 'TNT_EXPLOSION_TIME', kind: 'int', fallback: '0', group: 'Combattimento' },
  { key: 'FIREBALL_JUMP', kind: 'bool', fallback: '0', group: 'Combattimento' },
  { key: 'FALL_DAMAGE', kind: 'bool', fallback: '1', group: 'Combattimento' },
  { key: 'PEARL_GLITCH', kind: 'bool', fallback: '0', group: 'Combattimento' },
  { key: 'AUTO_SMELT', kind: 'bool', fallback: '0', group: 'Blocchi & mappa' },
  { key: 'RANDOM_ITEM_COOLDOWN', kind: 'int', fallback: '0', group: 'Oggetti & inventario' },
  { key: 'MIN_ROUND', kind: 'int', fallback: '2', group: 'Round & partita' },
  { key: 'REFILL_KIT_ON_KILL', kind: 'bool', fallback: '0', group: 'Oggetti & inventario' },
  { key: 'TREECAPITATOR', kind: 'bool', fallback: '0', group: 'Blocchi & mappa' },
  { key: 'LEAF_APPLE_DROP_CHANCE', kind: 'double', fallback: '0.0', group: 'Oggetti & inventario' },
  { key: 'OPEN_MAP_CONTAINERS', kind: 'bool', fallback: '0', group: 'Blocchi & mappa' },
  { key: 'SHIELD_STUN', kind: 'bool', fallback: '1', group: 'Combattimento' },
];

/**
 * I sei `MapSetting`, senza gruppo: nel disegno sono un elenco unico.
 *
 * `DOOR_DIRECTION` porta finalmente tutti i suoi valori: li aveva il mockup,
 * non il documento da cui ero partito — e avevo fatto bene a non indovinarli,
 * perche' avrei scritto `UP, DOWN` e mi sarei perso i quattro punti cardinali.
 *
 * `withObservedOptions` resta comunque: un valore gia' presente nel database
 * e' la prova che il plugin lo rilegge, e non offrirlo vorrebbe dire
 * cancellarlo al primo salvataggio di quella scheda.
 */
export const MAP_SETTINGS: readonly SettingSpec[] = [
  { key: 'DOOR', kind: 'bool', fallback: '1' },
  {
    key: 'DOOR_DIRECTION',
    kind: 'enum',
    fallback: 'UP',
    options: ['UP', 'DOWN', 'NORTH', 'SOUTH', 'EAST', 'WEST'],
  },
  { key: 'DOOR_DISTANCE', kind: 'int', fallback: '3' },
  { key: 'DOOR_TIME', kind: 'int', fallback: '2' },
  { key: 'MOVE_DURING_COOLDOWN', kind: 'bool', fallback: '1' },
  { key: 'TELEPORT_ON_PLAY', kind: 'bool', fallback: '0' },
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
    return { ...spec, options: withObserved(spec.options ?? [], observed.get(spec.key) ?? []) };
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

/**
 * Il valore letto dal database, riportato alla forma canonica.
 *
 * SERVE PERCHE' IL GIOCO NON SCRIVE SEMPRE ALLO STESSO MODO. La colonna e'
 * `TEXT` e un booleano ci finisce come `1`, `0`, `true` o `false` a seconda di
 * chi lo ha scritto: il plugin li rilegge tutti con `getBoolean`, e per lui
 * sono lo stesso valore.
 *
 * Senza questo passaggio il pannello mostrava un errore su `DOOR` e
 * `MOVE_DURING_COOLDOWN` — «il valore non ha la forma giusta» — su due
 * settings che nel gioco erano perfettamente validi: aveva letto `true` e si
 * aspettava `1`. Un pannello che dichiara sbagliato cio' che il gioco accetta
 * e' peggio di un pannello che non controlla niente.
 *
 * Quello che non si riconosce si lascia com'e': non e' compito di questa
 * funzione decidere che un valore e' sbagliato, e riscriverlo a caso
 * cancellerebbe una configurazione vera.
 */
export function normaliseValue(spec: SettingSpec, raw: string): string {
  if (spec.kind !== 'bool') return raw;
  if (raw === 'true' || raw === '1') return '1';
  if (raw === 'false' || raw === '0') return '0';
  return raw;
}
