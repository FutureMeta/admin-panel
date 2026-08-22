// Leggere e scrivere la configurazione del gioco: modalita' e mappe.
//
// E' L'UNICA PARTE DEL PANNELLO CHE CAMBIA IL GIOCO. Tutto il resto — trends,
// ratings, statistiche — legge; qui si scrive nelle tabelle da cui i server
// prendono le loro regole. Da questo discendono tre cose che non sono
// preferenze di stile:
//
//   * SI LEGGE DAL MYSQL, NON DALL'AGGREGATO. Le altre schermate leggono
//     `stats.duels_*` su Postgres, che e' una copia con un ritardo di trenta
//     secondi. Una copia va bene per un grafico e non va bene per un modulo di
//     modifica: si modificherebbe una cosa guardandone un'altra.
//
//   * QUELLO CHE SI SALVA NON ARRIVA SUBITO AI SERVER ACCESI. I server tengono
//     modalita' e mappe in una cache in memoria, caricata una volta all'avvio.
//     Finche' non riavviano, continuano a giocare con la configurazione
//     vecchia. Non e' un difetto da nascondere: e' un fatto da dire a chi
//     salva, ed e' per questo che la risposta lo porta scritto.
//
//   * IL MONDO NON SI TOCCA. La geometria dei blocchi e' un blob SlimeWorld
//     scritto dall'editor in-game. Qui si cambiano i metadati che gli stanno
//     intorno, ed eliminare una mappa NON cancella il suo mondo.

import type { DuelsMysql, DuelsTx } from './mysql.ts';
import { planSet, planSettings, type SetPlan, type SettingPlan } from './plan.ts';
import {
  EVENT_TYPES,
  MAP_SETTINGS,
  MATCH_CONTEXTS,
  MATCH_TYPES,
  MODE_SETTING_GROUPS,
  MODE_SETTINGS,
  MODE_TYPES,
  normaliseValue,
  RANKING_TYPES,
  type SettingSpec,
  settingValueIsValid,
  withObserved,
  withObservedOptions,
} from './settings.ts';

// ---------------------------------------------------------------------------
// Cosa esce dalle rotte
// ---------------------------------------------------------------------------

export type ConfigMode = {
  id: number;
  name: string;
  displayName: string;
  type: string;
  ranking: string;
  /** Quanti settings sono diversi dal default: e' il numero che si legge. */
  overrides: number;
};

export type ConfigMap = {
  id: number;
  name: string;
  displayName: string;
  type: string;
  context: string;
  enabled: boolean;
};

export type SettingValue = { key: string; value: string };

export type ModeDetail = {
  mode: ConfigMode;
  /** SOLO le righe presenti: quelle assenti valgono il default del registro. */
  settings: SettingValue[];
};

export type MapTeam = { id: number; name: string; displayName: string; color: string };

export type MapDetail = {
  map: ConfigMap;
  modeIds: number[];
  eventTypes: string[];
  settings: SettingValue[];
  teams: MapTeam[];
};

/**
 * Il vocabolario che la schermata disegna.
 *
 * VIAGGIA NEL PAYLOAD invece di stare anche nel client. Sono quarantotto righe
 * con etichetta, tipo, default e valori ammessi: una seconda copia nel
 * pannello sarebbe una tabella da tenere allineata a mano, ed e' gia' due
 * volte che una tabella tenuta a mano in questo progetto si dimentica.
 */
export type ConfigVocabulary = {
  modeSettings: SettingSpec[];
  /**
   * I sei gruppi NELL ORDINE DICHIARATO, che non e quello in cui compaiono
   * nella tabella: ricavarlo dai dati darebbe sei sezioni in un ordine che
   * nessuno ha scelto.
   */
  modeSettingGroups: readonly string[];
  mapSettings: SettingSpec[];
  modeTypes: readonly string[];
  rankingTypes: readonly string[];
  matchTypes: readonly string[];
  matchContexts: readonly string[];
  eventTypes: string[];
};

// ---------------------------------------------------------------------------
// Lettura
// ---------------------------------------------------------------------------

type ModeRow = { id: number; name: string; display_name: string; type: string; ranking: string };
type MapRow = {
  id: number;
  name: string;
  display_name: string;
  type: string;
  context: string;
  enabled: number | boolean;
};

/**
 * L'elenco delle modalita', con quanti settings ognuna ha personalizzato.
 *
 * IL CONTEGGIO SI FA IN SQL e non in JavaScript, perche' altrimenti servirebbe
 * portarsi dietro tutte le righe dei settings di tutte le modalita' per
 * scrivere un numero accanto a ciascuna.
 */
export async function listModes(my: DuelsMysql): Promise<ConfigMode[]> {
  const rows = await my.rows<ModeRow & { overrides: number | string }>(
    `SELECT m.id, m.name, m.display_name, m.type, m.ranking,
            (SELECT COUNT(*) FROM duels_mode_setting s WHERE s.mode_id = m.id) AS overrides
       FROM duels_mode m
      ORDER BY m.display_name`,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    displayName: r.display_name,
    type: r.type,
    ranking: r.ranking,
    overrides: Number(r.overrides),
  }));
}

export async function modeDetail(my: DuelsMysql, id: number): Promise<ModeDetail | null> {
  const [row] = await my.rows<ModeRow>(
    `SELECT id, name, display_name, type, ranking FROM duels_mode WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!row) return null;

  const settings = await my.rows<{ type: string; value: string }>(
    `SELECT type, value FROM duels_mode_setting WHERE mode_id = ?`,
    [id],
  );
  const overrides = settings.length;

  return {
    mode: {
      id: Number(row.id),
      name: row.name,
      displayName: row.display_name,
      type: row.type,
      ranking: row.ranking,
      overrides,
    },
    settings: normalised(MODE_SETTINGS, settings),
  };
}

export async function listMaps(my: DuelsMysql): Promise<ConfigMap[]> {
  const rows = await my.rows<MapRow>(
    `SELECT id, name, display_name, type, context, enabled FROM duels_map ORDER BY display_name`,
  );
  return rows.map(toMap);
}

function toMap(r: MapRow): ConfigMap {
  return {
    id: Number(r.id),
    name: r.name,
    displayName: r.display_name,
    type: r.type,
    context: r.context,
    // `enabled` arriva come 1/0 su MariaDB e come booleano su MySQL: si
    // normalizza qui, o la schermata mostrerebbe uno stato diverso a seconda
    // del database.
    enabled: r.enabled === true || Number(r.enabled) === 1,
  };
}

export async function mapDetail(my: DuelsMysql, id: number): Promise<MapDetail | null> {
  const [row] = await my.rows<MapRow>(
    `SELECT id, name, display_name, type, context, enabled FROM duels_map WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!row) return null;

  const [modes, events, settings, teams] = await Promise.all([
    my.rows<{ mode_id: number }>(`SELECT mode_id FROM duels_map_mode WHERE map_id = ?`, [id]),
    my.rows<{ event_type: string }>(`SELECT event_type FROM duels_map_event_type WHERE map_id = ?`, [id]),
    my.rows<{ type: string; value: string }>(`SELECT type, value FROM duels_map_setting WHERE map_id = ?`, [
      id,
    ]),
    my.rows<{ id: number; name: string; display_name: string; color: string }>(
      `SELECT t.id, t.name, t.display_name, t.color
         FROM duels_map_team mt
         JOIN duels_team t ON t.id = mt.team_id
        WHERE mt.map_id = ?
        ORDER BY t.name`,
      [id],
    ),
  ]);

  return {
    map: toMap(row),
    modeIds: modes.map((m) => Number(m.mode_id)),
    eventTypes: events.map((e) => e.event_type),
    settings: normalised(MAP_SETTINGS, settings),
    teams: teams.map((t) => ({
      id: Number(t.id),
      name: t.name,
      displayName: t.display_name,
      color: t.color,
    })),
  };
}

/**
 * Il vocabolario, allargato con quello che il database usa GIA'.
 *
 * Serve a due enum di cui non conosciamo tutti i valori. Un valore che una
 * mappa sta gia' usando e' un valore che il plugin rilegge senza lanciare: e'
 * una prova, non un'ipotesi, e mostrarlo evita che salvando quella scheda si
 * cancelli una configurazione solo perche' questo pannello non sapeva
 * disegnarla.
 */
export async function vocabulary(my: DuelsMysql): Promise<ConfigVocabulary> {
  const [events, doors] = await Promise.all([
    my.rows<{ event_type: string }>(`SELECT DISTINCT event_type FROM duels_map_event_type`),
    my.rows<{ value: string }>(`SELECT DISTINCT value FROM duels_map_setting WHERE type = 'DOOR_DIRECTION'`),
  ]);

  const observed = new Map<string, string[]>([['DOOR_DIRECTION', doors.map((d) => String(d.value))]]);

  return {
    modeSettings: [...MODE_SETTINGS],
    modeSettingGroups: MODE_SETTING_GROUPS,
    mapSettings: withObservedOptions(MAP_SETTINGS, observed),
    modeTypes: MODE_TYPES,
    rankingTypes: RANKING_TYPES,
    matchTypes: MATCH_TYPES,
    matchContexts: MATCH_CONTEXTS,
    eventTypes: withObserved(
      EVENT_TYPES,
      events.map((e) => e.event_type),
    ),
  };
}

// ---------------------------------------------------------------------------
// Scrittura
// ---------------------------------------------------------------------------

/** Cosa una richiesta ha davvero cambiato. Serve al registro di audit. */
export type ConfigChange = {
  /** I campi della riga principale, con il valore nuovo. */
  fields: Record<string, string>;
  settings: SettingPlan;
  modes?: SetPlan<number>;
  events?: SetPlan<string>;
};

export class NotFound extends Error {}
export class InvalidValue extends Error {}

/** Nessuno dei tre piani chiede niente al database. */
export function isNoOp(change: ConfigChange): boolean {
  return (
    Object.keys(change.fields).length === 0 &&
    change.settings.upserts.length === 0 &&
    change.settings.deletes.length === 0 &&
    (change.modes?.add.length ?? 0) === 0 &&
    (change.modes?.remove.length ?? 0) === 0 &&
    (change.events?.add.length ?? 0) === 0 &&
    (change.events?.remove.length ?? 0) === 0
  );
}

export type ModeEdit = {
  displayName?: string;
  type?: string;
  ranking?: string;
  /** I valori scelti nella schermata, chiave -> valore gia' codificato. */
  settings?: Record<string, string>;
};

/**
 * Salva una modalita': i campi che si possono cambiare e i suoi settings.
 *
 * `name` e `icon` NON si toccano, ed e' voluto: la schermata non li mostra, e
 * `name` per giunta e' la chiave con cui i preferiti dei giocatori puntano a
 * questa modalita'.
 */
export async function saveMode(my: DuelsMysql, id: number, edit: ModeEdit): Promise<ConfigChange> {
  return my.tx(async (t) => {
    // SI RILEGGE DENTRO LA TRANSAZIONE. Quello che la schermata ha in mano puo'
    // essere vecchio di minuti: e' una bozza locale, per scelta. Il piano si
    // calcola su cio' che c'e' adesso, o si riscriverebbero valori che nel
    // frattempo ha cambiato qualcun altro.
    const [row] = await t.rows<ModeRow>(
      `SELECT id, name, display_name, type, ranking FROM duels_mode WHERE id = ? FOR UPDATE`,
      [id],
    );
    if (!row) throw new NotFound(`modalita' ${id} non trovata`);

    const fields = coreFields(
      [
        ['display_name', edit.displayName, row.display_name, null],
        ['type', edit.type, row.type, MODE_TYPES],
        ['ranking', edit.ranking, row.ranking, RANKING_TYPES],
      ],
      'modalita',
    );

    const current = await currentSettings(
      t,
      MODE_SETTINGS,
      `SELECT type, value FROM duels_mode_setting WHERE mode_id = ?`,
      id,
    );
    const settings = planFor(MODE_SETTINGS, current, edit.settings);

    await applyFields(t, 'duels_mode', id, fields);
    await applySettings(t, 'duels_mode_setting', 'mode_id', id, settings);

    return { fields, settings };
  });
}

export type MapEdit = {
  displayName?: string;
  type?: string;
  context?: string;
  settings?: Record<string, string>;
  modeIds?: number[];
  eventTypes?: string[];
};

export async function saveMap(my: DuelsMysql, id: number, edit: MapEdit): Promise<ConfigChange> {
  return my.tx(async (t) => {
    const [row] = await t.rows<MapRow>(
      `SELECT id, name, display_name, type, context, enabled FROM duels_map WHERE id = ? FOR UPDATE`,
      [id],
    );
    if (!row) throw new NotFound(`mappa ${id} non trovata`);

    const fields = coreFields(
      [
        ['display_name', edit.displayName, row.display_name, null],
        ['type', edit.type, row.type, MATCH_TYPES],
        ['context', edit.context, row.context, MATCH_CONTEXTS],
      ],
      'mappa',
    );

    const current = await currentSettings(
      t,
      MAP_SETTINGS,
      `SELECT type, value FROM duels_map_setting WHERE map_id = ?`,
      id,
    );
    const settings = planFor(MAP_SETTINGS, current, edit.settings);

    await applyFields(t, 'duels_map', id, fields);
    await applySettings(t, 'duels_map_setting', 'map_id', id, settings);

    const change: ConfigChange = { fields, settings };

    if (edit.modeIds) {
      const have = await t.rows<{ mode_id: number }>(`SELECT mode_id FROM duels_map_mode WHERE map_id = ?`, [
        id,
      ]);
      const plan = planSet(
        have.map((m) => Number(m.mode_id)),
        edit.modeIds,
      );
      for (const modeId of plan.add) {
        // Una modalita' inesistente farebbe fallire la chiave esterna e con
        // essa l'intero salvataggio: e' il comportamento giusto, e il
        // messaggio che ne esce dice quale.
        await t.run(`INSERT INTO duels_map_mode (map_id, mode_id) VALUES (?, ?)`, [id, modeId]);
      }
      for (const modeId of plan.remove) {
        await t.run(`DELETE FROM duels_map_mode WHERE map_id = ? AND mode_id = ?`, [id, modeId]);
      }
      change.modes = plan;
    }

    if (edit.eventTypes) {
      const have = await t.rows<{ event_type: string }>(
        `SELECT event_type FROM duels_map_event_type WHERE map_id = ?`,
        [id],
      );
      const plan = planSet(
        have.map((e) => e.event_type),
        edit.eventTypes,
      );
      for (const type of plan.add) {
        await t.run(`INSERT INTO duels_map_event_type (map_id, event_type) VALUES (?, ?)`, [id, type]);
      }
      for (const type of plan.remove) {
        await t.run(`DELETE FROM duels_map_event_type WHERE map_id = ? AND event_type = ?`, [id, type]);
      }
      change.events = plan;
    }

    return change;
  });
}

/**
 * Elimina una modalita'.
 *
 * Le cascate le fa il database: settings, kit e i preferiti dei giocatori che
 * puntano a questa modalita'. E' irreversibile e la schermata lo dice prima.
 */
export async function deleteMode(my: DuelsMysql, id: number): Promise<string> {
  return my.tx(async (t) => {
    const [row] = await t.rows<{ name: string }>(`SELECT name FROM duels_mode WHERE id = ? FOR UPDATE`, [id]);
    if (!row) throw new NotFound(`modalita' ${id} non trovata`);
    await t.run(`DELETE FROM duels_mode WHERE id = ?`, [id]);
    return row.name;
  });
}

/** Elimina una mappa. Il mondo slime in `duels_world` NON viene toccato. */
export async function deleteMap(my: DuelsMysql, id: number): Promise<string> {
  return my.tx(async (t) => {
    const [row] = await t.rows<{ name: string }>(`SELECT name FROM duels_map WHERE id = ? FOR UPDATE`, [id]);
    if (!row) throw new NotFound(`mappa ${id} non trovata`);
    await t.run(`DELETE FROM duels_map WHERE id = ?`, [id]);
    return row.name;
  });
}

// ---------------------------------------------------------------------------

type FieldSpec = [
  column: string,
  proposed: string | undefined,
  existing: string,
  allowed: readonly string[] | null,
];

/**
 * I campi della riga principale che cambiano davvero.
 *
 * Un campo uguale a quello che c'e' gia' non entra: una UPDATE che non cambia
 * niente riesce comunque, e finirebbe nel registro di audit come una modifica.
 * Un registro pieno di modifiche che non hanno modificato niente e' un
 * registro che non si legge piu'.
 */
function coreFields(specs: FieldSpec[], what: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [column, proposed, existing, allowed] of specs) {
    if (proposed === undefined) continue;
    const value = proposed.trim();
    if (value === '') throw new InvalidValue(`${column} della ${what} non puo' essere vuoto`);
    if (allowed && !allowed.includes(value)) {
      // Il valore arriva dal client e finisce in una colonna che il plugin
      // rilegge con `Enum.valueOf`: qui e' l'ultimo punto in cui costa poco.
      throw new InvalidValue(`${column} della ${what} non ammette ${value}`);
    }
    if (value === existing) continue;
    out[column] = value;
  }
  return out;
}

async function currentSettings(
  t: DuelsTx,
  specs: readonly SettingSpec[],
  sql: string,
  id: number,
): Promise<Map<string, string>> {
  const rows = await t.rows<{ type: string; value: string }>(sql, [id]);
  // NORMALIZZATE ANCHE QUI, o il piano confronterebbe `true` con `1` e li
  // vedrebbe diversi: ogni salvataggio riscriverebbe righe che non sono
  // cambiate, e il registro si riempirebbe di modifiche che non modificano.
  return new Map(rows.map((r) => [r.type, canonical(specs, r.type, String(r.value))]));
}

/**
 * Il valore come lo scriviamo noi, qualunque forma avesse nel database.
 *
 * Una chiave che il registro non conosce passa intatta: non e' compito nostro
 * decidere che un valore sconosciuto e' sbagliato.
 */
function canonical(specs: readonly SettingSpec[], key: string, value: string): string {
  const spec = specs.find((s) => s.key === key);
  return spec ? normaliseValue(spec, value) : value;
}

/** Le righe presenti, con i valori riportati alla forma canonica. */
function normalised(
  specs: readonly SettingSpec[],
  rows: Array<{ type: string; value: string }>,
): SettingValue[] {
  return rows.map((r) => ({ key: r.type, value: canonical(specs, r.type, String(r.value)) }));
}

function planFor(
  specs: readonly SettingSpec[],
  current: ReadonlyMap<string, string>,
  desired: Record<string, string> | undefined,
): SettingPlan {
  if (!desired) return { upserts: [], deletes: [] };

  const wanted = new Map<string, string>();
  for (const [key, value] of Object.entries(desired)) {
    const spec = specs.find((s) => s.key === key);
    // Una chiave che il registro non conosce si IGNORA invece di rifiutare la
    // richiesta: il pianificatore comunque non la scriverebbe, e rifiutare
    // tutto renderebbe impossibile salvare da una scheda aperta prima di un
    // aggiornamento del pannello.
    if (!spec) continue;
    if (!settingValueIsValid(spec, value)) {
      throw new InvalidValue(`${key} non ammette ${value}`);
    }
    wanted.set(key, value);
  }
  return planSettings(specs, current, wanted);
}

async function applyFields(
  t: DuelsTx,
  table: string,
  id: number,
  fields: Record<string, string>,
): Promise<void> {
  const entries = Object.entries(fields);
  if (entries.length === 0) return;
  // I nomi di colonna vengono da `coreFields`, che li prende da un elenco
  // scritto qui dentro: non c'e' un percorso da cui il client possa sceglierli.
  // I valori restano parametri.
  const set = entries.map(([column]) => `${column} = ?`).join(', ');
  await t.run(`UPDATE ${table} SET ${set} WHERE id = ?`, [...entries.map(([, v]) => v), id]);
}

async function applySettings(
  t: DuelsTx,
  table: string,
  column: string,
  id: number,
  plan: SettingPlan,
): Promise<void> {
  for (const row of plan.upserts) {
    await t.run(
      `INSERT INTO ${table} (${column}, type, value) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE value = VALUES(value)`,
      [id, row.key, row.value],
    );
  }
  for (const key of plan.deletes) {
    // Cancellare, non scrivere il default: e' la riga assente a significare
    // «usa il default», e una riga scritta smetterebbe di seguire il plugin.
    await t.run(`DELETE FROM ${table} WHERE ${column} = ? AND type = ?`, [id, key]);
  }
}
