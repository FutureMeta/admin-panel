// Un MySQL finto per le schermate di configurazione, con dello STATO VERO.
//
// PERCHE' NON BASTA QUELLO CHE C'E' GIA'. `fakeDuelsMysql` risponde a domande e
// non ricorda niente: va benissimo per l'ingestione, che legge e basta, e non
// serve a niente qui, dove la cosa da verificare e' proprio cosa resta scritto.
//
// PERCHE' NON UN MYSQL VERO. Non ce n'e' uno nella suite — i test hanno
// Postgres e Redis — e puntarli a quello di produzione e' vietato e sarebbe
// comunque assurdo: si verificherebbero le regole del pannello scrivendo nel
// gioco.
//
// COSA PROVA E COSA NON PROVA, detto chiaro. Prova che le nostre operazioni
// avvengano nell'ordine giusto, sulle righe giuste, e che una transazione
// fallita non lasci niente. NON prova che MySQL accetti quell'SQL: le chiavi
// esterne, le cascate e i vincoli qui non esistono. Quella parte la prova solo
// il database vero, e le sue eccezioni sono trattate come tali dalle rotte.

import type { DuelsMysql, DuelsTx } from '#src/duels/mysql.ts';

export type ConfigState = {
  modes: Array<{ id: number; name: string; display_name: string; type: string; ranking: string }>;
  modeSettings: Array<{ mode_id: number; type: string; value: string }>;
  maps: Array<{
    id: number;
    name: string;
    display_name: string;
    type: string;
    context: string;
    enabled: number;
  }>;
  mapSettings: Array<{ map_id: number; type: string; value: string }>;
  mapModes: Array<{ map_id: number; mode_id: number }>;
  mapEvents: Array<{ map_id: number; event_type: string }>;
  teams: Array<{ id: number; name: string; display_name: string; color: string }>;
  mapTeams: Array<{ map_id: number; team_id: number }>;
};

export function emptyState(): ConfigState {
  return {
    modes: [],
    modeSettings: [],
    maps: [],
    mapSettings: [],
    mapModes: [],
    mapEvents: [],
    teams: [],
    mapTeams: [],
  };
}

export type FakeConfigMysql = DuelsMysql & {
  state: ConfigState;
  /** Ogni istruzione passata, nell'ordine. Serve a provare cosa NON si fa. */
  log: string[];
  /** Fa lanciare la prossima istruzione che contiene questo pezzo di SQL. */
  breakOn: (fragment: string) => void;
  /**
   * Fa rispondere a MySQL «non hai il privilegio» su questa istruzione.
   *
   * Serve a provare la strada che in produzione ha prodotto un 500 «errore non
   * gestito»: un errore con `errno` e `sqlMessage`, cioè la forma vera di
   * quello che arriva da mysql2, non una `Error` qualunque. Con una `Error`
   * nuda il test passerebbe senza esercitare il riconoscimento.
   */
  denyOn: (fragment: string, error: { errno: number; sqlMessage: string }) => void;
};

const norm = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

export function fakeConfigMysql(initial: Partial<ConfigState> = {}): FakeConfigMysql {
  const state: ConfigState = { ...emptyState(), ...initial };
  const log: string[] = [];
  let broken: string | null = null;
  let denied: { fragment: string; errno: number; sqlMessage: string } | null = null;

  const run = (sql: string, params: unknown[]): { rows: unknown[]; affectedRows: number } => {
    const q = norm(sql);
    log.push(q);
    if (denied && q.includes(denied.fragment)) {
      const err = new Error(denied.sqlMessage) as Error & { errno: number; sqlMessage: string };
      err.errno = denied.errno;
      err.sqlMessage = denied.sqlMessage;
      denied = null;
      throw err;
    }
    if (broken && q.includes(broken)) {
      broken = null;
      throw new Error(`istruzione fatta fallire dal test: ${q.slice(0, 60)}`);
    }
    const p = params;

    // --- letture -----------------------------------------------------------
    //
    // SOTTO UN `SELECT`, e non e' pedanteria: i riconoscitori qui sotto
    // cercano un pezzo di query in mezzo alla stringa, e «DELETE FROM
    // duels_mode_setting WHERE mode_id = ?» CONTIENE «FROM duels_mode_setting
    // WHERE mode_id = ?». Senza questo cancello una cancellazione veniva
    // servita come una lettura: nessun errore, zero righe toccate, e un test
    // che accusava il codice di non cancellare mentre a non cancellare era il
    // finto.
    if (q.startsWith('SELECT')) {
      const read = reads(state, q, p);
      if (read) return read;
    }

    // --- scritture ---------------------------------------------------------
    if (/^UPDATE duels_mode SET/.test(q)) return updateRow(state.modes, q, p);
    if (/^UPDATE duels_map SET/.test(q)) return updateRow(state.maps, q, p);

    if (/^INSERT INTO duels_mode_setting/.test(q)) {
      return upsertSetting(state.modeSettings, 'mode_id', Number(p[0]), String(p[1]), String(p[2]));
    }
    if (/^INSERT INTO duels_map_setting/.test(q)) {
      return upsertSetting(state.mapSettings, 'map_id', Number(p[0]), String(p[1]), String(p[2]));
    }
    if (/^DELETE FROM duels_mode_setting/.test(q)) {
      return removeWhere(state.modeSettings, (r) => r.mode_id === Number(p[0]) && r.type === String(p[1]));
    }
    if (/^DELETE FROM duels_map_setting/.test(q)) {
      return removeWhere(state.mapSettings, (r) => r.map_id === Number(p[0]) && r.type === String(p[1]));
    }
    if (/^INSERT INTO duels_map_mode/.test(q)) {
      state.mapModes.push({ map_id: Number(p[0]), mode_id: Number(p[1]) });
      return { rows: [], affectedRows: 1 };
    }
    if (/^DELETE FROM duels_map_mode/.test(q)) {
      return removeWhere(state.mapModes, (r) => r.map_id === Number(p[0]) && r.mode_id === Number(p[1]));
    }
    if (/^INSERT INTO duels_map_event_type/.test(q)) {
      state.mapEvents.push({ map_id: Number(p[0]), event_type: String(p[1]) });
      return { rows: [], affectedRows: 1 };
    }
    if (/^DELETE FROM duels_map_event_type/.test(q)) {
      return removeWhere(state.mapEvents, (r) => r.map_id === Number(p[0]) && r.event_type === String(p[1]));
    }
    if (/^DELETE FROM duels_mode WHERE id/.test(q)) {
      // La cascata la fa il database vero; qui si imita, o il test non
      // vedrebbe la differenza fra eliminare e lasciare orfani.
      const id = Number(p[0]);
      removeWhere(state.modeSettings, (r) => r.mode_id === id);
      removeWhere(state.mapModes, (r) => r.mode_id === id);
      return removeWhere(state.modes, (r) => r.id === id);
    }
    if (/^DELETE FROM duels_map WHERE id/.test(q)) {
      const id = Number(p[0]);
      removeWhere(state.mapSettings, (r) => r.map_id === id);
      removeWhere(state.mapModes, (r) => r.map_id === id);
      removeWhere(state.mapEvents, (r) => r.map_id === id);
      removeWhere(state.mapTeams, (r) => r.map_id === id);
      return removeWhere(state.maps, (r) => r.id === id);
    }

    // Il tetto di esecuzione e il `SELECT 1` d'avvio.
    if (/^SET /.test(q)) return { rows: [], affectedRows: 0 };

    throw new Error(`il finto non conosce questa istruzione: ${q}`);
  };

  const rows = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => run(sql, params).rows as T[];

  return {
    state,
    log,
    breakOn: (fragment) => {
      broken = fragment;
    },
    denyOn: (fragment, error) => {
      denied = { fragment, ...error };
    },
    rows,
    tx: async <T>(fn: (t: DuelsTx) => Promise<T>): Promise<T> => {
      // La transazione si imita SUL SERIO: si lavora sullo stato e lo si
      // ripristina da una copia se qualcosa lancia. Un finto che scrivesse
      // comunque farebbe passare un test sul rollback senza che il rollback
      // esista.
      const snapshot: ConfigState = structuredClone(state);
      try {
        return await fn({
          rows,
          run: async (sql: string, params: unknown[] = []) => ({
            affectedRows: run(sql, params).affectedRows,
          }),
        });
      } catch (err) {
        for (const key of Object.keys(snapshot) as Array<keyof ConfigState>) {
          // Si riassegna il CONTENUTO, non il riferimento: chi ha in mano
          // `state` deve vedere il ripristino.
          (state[key] as unknown[]).length = 0;
          (state[key] as unknown[]).push(...(snapshot[key] as unknown[]));
        }
        throw err;
      }
    },
    cap: () => 'mysql' as const,
    close: async () => undefined,
  };
}

/** Le sole letture che le rotte fanno. `null` se nessuna corrisponde. */
function reads(
  state: ConfigState,
  q: string,
  p: unknown[],
): { rows: unknown[]; affectedRows: number } | null {
  if (/^SELECT m\.id, m\.name/.test(q)) {
    return {
      rows: state.modes
        .map((m) => ({
          ...m,
          overrides: state.modeSettings.filter((s) => s.mode_id === m.id).length,
        }))
        .sort((a, b) => a.display_name.localeCompare(b.display_name)),
      affectedRows: 0,
    };
  }
  if (/FROM duels_mode WHERE id = \?/.test(q)) {
    return { rows: state.modes.filter((m) => m.id === Number(p[0])), affectedRows: 0 };
  }
  if (/FROM duels_mode_setting WHERE mode_id = \?/.test(q)) {
    return { rows: state.modeSettings.filter((s) => s.mode_id === Number(p[0])), affectedRows: 0 };
  }
  if (/FROM duels_map ORDER BY/.test(q)) {
    return {
      rows: [...state.maps].sort((a, b) => a.display_name.localeCompare(b.display_name)),
      affectedRows: 0,
    };
  }
  if (/FROM duels_map WHERE id = \?/.test(q)) {
    return { rows: state.maps.filter((m) => m.id === Number(p[0])), affectedRows: 0 };
  }
  if (/FROM duels_map_mode WHERE map_id = \?/.test(q)) {
    return { rows: state.mapModes.filter((r) => r.map_id === Number(p[0])), affectedRows: 0 };
  }
  if (/FROM duels_map_event_type WHERE map_id = \?/.test(q)) {
    return { rows: state.mapEvents.filter((r) => r.map_id === Number(p[0])), affectedRows: 0 };
  }
  if (/FROM duels_map_setting WHERE map_id = \?/.test(q)) {
    return { rows: state.mapSettings.filter((r) => r.map_id === Number(p[0])), affectedRows: 0 };
  }
  if (/SELECT DISTINCT event_type/.test(q)) {
    return {
      rows: [...new Set(state.mapEvents.map((e) => e.event_type))].map((v) => ({ event_type: v })),
      affectedRows: 0,
    };
  }
  if (/SELECT DISTINCT value/.test(q)) {
    const vals = state.mapSettings.filter((s) => s.type === 'DOOR_DIRECTION').map((s) => s.value);
    return { rows: [...new Set(vals)].map((v) => ({ value: v })), affectedRows: 0 };
  }
  return null;
}

function updateRow<T extends Record<string, unknown>>(
  table: T[],
  q: string,
  params: unknown[],
): { rows: unknown[]; affectedRows: number } {
  const columns =
    /SET (.+) WHERE id/
      .exec(q)?.[1]
      ?.split(', ')
      .map((c) => c.split(' = ')[0] ?? '') ?? [];
  const id = Number(params.at(-1));
  const row = table.find((r) => Number(r.id) === id);
  if (!row) return { rows: [], affectedRows: 0 };
  columns.forEach((column, i) => {
    (row as Record<string, unknown>)[column] = params[i];
  });
  return { rows: [], affectedRows: 1 };
}

function upsertSetting(
  table: Array<Record<string, unknown>>,
  column: string,
  id: number,
  type: string,
  value: string,
): { rows: unknown[]; affectedRows: number } {
  const found = table.find((r) => r[column] === id && r.type === type);
  if (found) {
    found.value = value;
    return { rows: [], affectedRows: 1 };
  }
  table.push({ [column]: id, type, value });
  return { rows: [], affectedRows: 1 };
}

function removeWhere<T>(table: T[], match: (row: T) => boolean): { rows: unknown[]; affectedRows: number } {
  let removed = 0;
  for (let i = table.length - 1; i >= 0; i -= 1) {
    const row = table[i];
    if (row !== undefined && match(row)) {
      table.splice(i, 1);
      removed += 1;
    }
  }
  return { rows: [], affectedRows: removed };
}
