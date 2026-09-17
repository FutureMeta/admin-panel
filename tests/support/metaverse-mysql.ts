// Un MariaDB finto per le Lingue, con dello STATO VERO.
//
// Stesse ragioni di `duels-config-mysql.ts`: non c'e' un MariaDB nella suite,
// puntare a quello di produzione e' vietato, e la cosa da verificare e'
// proprio cosa resta scritto — e cosa NO. Le tabelle sono le due di Metaverse,
// con le colonne che il pannello legge e scrive.
//
// COSA PROVA E COSA NON PROVA. Prova che le nostre istruzioni tocchino le righe
// giuste, che una transazione fallita non lasci niente, e che `version` e
// `updated_at` salgano come li fa salire Metaverse — perche' e' da li' che i
// server capiscono che c'e' qualcosa di nuovo. NON prova che MariaDB accetti
// quell'SQL: quella parte la prova solo il database vero.

import type { DuelsMysql, DuelsTx } from '#src/duels/mysql.ts';

export type MessageRow = {
  namespace: string;
  locale: string;
  message_key: string;
  shipped: string | null;
  custom: string | null;
  version: number;
  updated_at: number;
};

export type LanguageRow = {
  locale: string;
  enabled: number;
  display_name: string;
  head_texture: string | null;
  position: number;
  version: number;
  updated_at: number;
};

export type LangState = { messages: MessageRow[]; languages: LanguageRow[] };

/** Le due lingue con cui Metaverse nasce (V2__messages.sql). */
export function seededState(): LangState {
  return {
    messages: [],
    languages: [
      {
        locale: 'en',
        enabled: 1,
        display_name: '<white>English',
        head_texture: null,
        position: 0,
        version: 0,
        updated_at: 1,
      },
      {
        locale: 'it',
        enabled: 1,
        display_name: '<white>Italiano',
        head_texture: null,
        position: 1,
        version: 0,
        updated_at: 1,
      },
    ],
  };
}

/** Quello che fa un server all'avvio: `MessageDatabase.publish`. */
export function publish(state: LangState, ns: string, shipped: Record<string, Record<string, string>>): void {
  for (const [locale, keys] of Object.entries(shipped)) {
    for (const [key, text] of Object.entries(keys)) {
      const row = state.messages.find(
        (r) => r.namespace === ns && r.locale === locale && r.message_key === key,
      );
      if (row) row.shipped = text;
      else
        state.messages.push({
          namespace: ns,
          locale,
          message_key: key,
          shipped: text,
          custom: null,
          version: 0,
          updated_at: 1,
        });
    }
  }
}

export type FakeMetaverseMysql = DuelsMysql & { state: LangState; log: string[] };

const norm = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

export function fakeMetaverseMysql(initial: LangState = seededState()): FakeMetaverseMysql {
  const state = initial;
  const log: string[] = [];

  const effective = (r: MessageRow): string | null => r.custom ?? r.shipped;
  const languagesInOrder = () =>
    [...state.languages].sort((a, b) => a.position - b.position || a.locale.localeCompare(b.locale));

  const run = (sql: string, params: unknown[]): { rows: unknown[]; affectedRows: number } => {
    const q = norm(sql);
    log.push(q);
    const p = params;

    if (q.startsWith('SELECT')) {
      if (q.includes('FROM metaverse_language ORDER BY position, locale')) {
        return { rows: languagesInOrder().map((l) => ({ ...l })), affectedRows: 0 };
      }
      if (q.includes('FROM metaverse_language WHERE locale = ?')) {
        return {
          rows: state.languages.filter((l) => l.locale === p[0]).map((l) => ({ ...l })),
          affectedRows: 0,
        };
      }
      if (q.includes('COUNT(DISTINCT message_key) AS n FROM metaverse_message GROUP BY namespace')) {
        const byNs = new Map<string, Set<string>>();
        for (const r of state.messages)
          byNs.set(r.namespace, (byNs.get(r.namespace) ?? new Set()).add(r.message_key));
        return {
          rows: [...byNs.entries()].sort().map(([namespace, keys]) => ({ namespace, n: keys.size })),
          affectedRows: 0,
        };
      }
      if (q.includes('WHERE COALESCE(custom, shipped) IS NOT NULL GROUP BY namespace, locale')) {
        const counts = new Map<string, number>();
        for (const r of state.messages) {
          if (effective(r) === null) continue;
          const k = `${r.namespace} ${r.locale}`;
          counts.set(k, (counts.get(k) ?? 0) + 1);
        }
        return {
          rows: [...counts.entries()].map(([k, n]) => {
            const [namespace, locale] = k.split(' ') as [string, string];
            return { namespace, locale, n };
          }),
          affectedRows: 0,
        };
      }
      if (
        q.includes('COALESCE(custom, shipped) AS value FROM metaverse_message WHERE namespace = ? ORDER BY')
      ) {
        return {
          rows: state.messages
            .filter((r) => r.namespace === p[0])
            .sort((a, b) => a.message_key.localeCompare(b.message_key) || a.locale.localeCompare(b.locale))
            .map((r) => ({ message_key: r.message_key, locale: r.locale, value: effective(r) })),
          affectedRows: 0,
        };
      }
      if (q.includes('AS value FROM metaverse_message WHERE namespace = ? AND message_key = ?')) {
        return {
          rows: state.messages
            .filter((r) => r.namespace === p[0] && r.message_key === p[1])
            .map((r) => ({ locale: r.locale, value: effective(r) })),
          affectedRows: 0,
        };
      }
    }

    if (q.startsWith('INSERT INTO metaverse_message')) {
      const [namespace, locale, key, custom, now] = p as [string, string, string, string, number];
      const row = state.messages.find(
        (r) => r.namespace === namespace && r.locale === locale && r.message_key === key,
      );
      if (row) {
        row.custom = custom;
        row.version += 1;
        row.updated_at = now;
        return { rows: [], affectedRows: 2 };
      }
      state.messages.push({
        namespace,
        locale,
        message_key: key,
        shipped: null,
        custom,
        version: 1,
        updated_at: now,
      });
      return { rows: [], affectedRows: 1 };
    }

    if (q.startsWith('INSERT INTO metaverse_language')) {
      const [locale, display, now] = p as [string, string, number];
      const position =
        state.languages.length === 0 ? 0 : Math.max(...state.languages.map((l) => l.position)) + 1;
      state.languages.push({
        locale,
        enabled: 0,
        display_name: display,
        head_texture: null,
        position,
        version: 1,
        updated_at: now,
      });
      return { rows: [], affectedRows: 1 };
    }

    if (q.startsWith('UPDATE metaverse_language SET display_name = ?, enabled = ?')) {
      const [display, enabled, now, locale] = p as [string, number, number, string];
      const row = state.languages.find((l) => l.locale === locale);
      if (!row) return { rows: [], affectedRows: 0 };
      row.display_name = display;
      row.enabled = enabled;
      row.version += 1;
      row.updated_at = now;
      return { rows: [], affectedRows: 1 };
    }

    if (q.startsWith('UPDATE metaverse_language SET position = ?')) {
      const [position, now, locale] = p as [number, number, string];
      const row = state.languages.find((l) => l.locale === locale);
      if (!row) return { rows: [], affectedRows: 0 };
      row.position = position;
      row.version += 1;
      row.updated_at = now;
      return { rows: [], affectedRows: 1 };
    }

    if (/^SET /.test(q)) return { rows: [], affectedRows: 0 };

    throw new Error(`il finto non conosce questa istruzione: ${q}`);
  };

  const rows = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => run(sql, params).rows as T[];

  return {
    state,
    log,
    rows,
    tx: async <T>(fn: (t: DuelsTx) => Promise<T>): Promise<T> => {
      const snapshot = structuredClone(state);
      try {
        return await fn({
          rows,
          run: async (sql: string, params: unknown[] = []) => ({
            affectedRows: run(sql, params).affectedRows,
          }),
        });
      } catch (err) {
        state.messages.length = 0;
        state.messages.push(...snapshot.messages);
        state.languages.length = 0;
        state.languages.push(...snapshot.languages);
        throw err;
      }
    },
    cap: () => 'mariadb' as const,
    close: async () => undefined,
  };
}
