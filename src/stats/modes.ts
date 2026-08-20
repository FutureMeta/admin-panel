// Il dizionario delle modalita': un modulo del pannello. Fase 2, E4.
//
// COS'E' UNA MODALITA', e perche' non e' un server. Un server e' la singola
// istanza Minecraft, come la nomina il Redis di gioco: `duels_6`, `sandbox7`,
// `lobby_1`. Una modalita' e' il RAGGRUPPAMENTO che decide l'operatore:
// «Bedwars» tiene insieme `bedwars_solo_1..4` e `bedwars_team_1..2`.
//
// Il dizionario nasce VUOTO e non ha seed. Nessuno sa a priori come questa
// rete vuole raggruppare i propri server, e indovinarlo in una migration
// significa che il primo che apre il pannello trova nomi che non riconosce.
//
// PERCHE' SI PUO' CAMBIARE IDEA. Il grezzo e i rollup sono chiavati sul
// SERVER: riclassificare non tocca una riga di storico, cambia solo la lettura
// del giro di warm successivo. Se il grano fosse per modalita', spostare
// `sandbox7` da «Sandbox» a «Creativa» richiederebbe di riscrivere `mode_id`
// su tutte le partizioni — e nessuno lo farebbe, quindi la classificazione
// sbagliata resterebbe per sempre.

import { sql } from 'kysely';
import type { Database } from '#src/db/pool.ts';

export type MatchKind = 'server' | 'prefix' | 'suffix' | 'contains';

export const MATCH_KINDS: readonly MatchKind[] = ['server', 'prefix', 'suffix', 'contains'];

export type Alias = { matchKind: MatchKind; matchValue: string };

export type Mode = {
  modeId: number;
  modeKey: string;
  displayName: string;
  color: string | null;
  inBreakdown: boolean;
  hidden: boolean;
  sortOrder: number;
  aliases: Alias[];
  /** I server che questa modalita' cattura ADESSO, gia' risolti. */
  servers: string[];
};

export type Dictionary = {
  modes: Mode[];
  /**
   * I server che nessuna regola cattura.
   *
   * Non e' una lista di errori: finiscono nel secchiello `__unknown__`, che e'
   * una serie visibile del grafico. Ma e' la lista da cui l'operatore parte, e
   * un `__unknown__` che cresce e' il primo segnale che la rete ha server
   * nuovi.
   */
  unclassified: string[];
  /** Avvisi sui colori. AVVISI, non divieti: vedi `colourWarnings`. */
  warnings: ColourWarning[];
};

export type ColourWarning =
  | { kind: 'simile'; modeKey: string; otherKey: string; distance: number }
  | { kind: 'contrasto'; modeKey: string; ratio: number };

/** Il fondo scuro del pannello, da `design/tokens.css` (`--s-surface`). */
const SURFACE_DARK = '#0e1f28';
/**
 * Sotto 3:1 un colore di serie non si distingue dal fondo.
 *
 * Non e' decorazione: il colore e' l'unica cosa che separa due linee su un
 * grafico. Il valore rimosso dai token di progetto, `#1F6E95`, stava a 2,99:1.
 */
const MIN_CONTRAST = 3;
/**
 * Sotto questa distanza due serie si confondono a colpo d'occhio.
 *
 * CALIBRATA SULLA PALETTE che il pannello offre: i suoi venti colori distano
 * fra loro almeno 35, quindi una soglia piu' alta farebbe segnalare due
 * suggerimenti dello strumento stesso. Un avviso che scatta su una scelta
 * offerta dal pannello e' rumore, e il rumore fa disattivare gli avvisi.
 *
 * A 30 resta larghissimo il margine su cio' che conta: due colori davvero
 * confondibili, come #e8822b e #e9852f, distano 9.
 */
const MIN_DISTANCE = 30;

function rgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Distanza percettiva approssimata («redmean»).
 *
 * Non e' CIEDE2000 e non pretende di esserlo: serve a dire «questi due si
 * confondono», non a certificare una differenza. Un'approssimazione onesta
 * dichiarata e' meglio di una formula esatta usata per una soglia inventata.
 */
export function colourDistance(a: string, b: string): number {
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  const rMean = (r1 + r2) / 2;
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt((2 + rMean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rMean) / 256) * db * db);
}

/**
 * Gli avvisi sui colori. AVVISI, non divieti.
 *
 * Chi assegna i colori sa cose che il calcolo non sa: che due modalita' non
 * compaiono mai insieme, che una e' in via di dismissione. Un divieto lo
 * costringerebbe a combattere con lo strumento; un avviso gli dice quello che
 * vede il grafico e lo lascia decidere.
 */
export function colourWarnings(
  modes: Array<{ modeKey: string; color: string | null; hidden: boolean }>,
): ColourWarning[] {
  const visible = modes.filter((m) => m.color !== null && !m.hidden) as Array<{
    modeKey: string;
    color: string;
  }>;
  const out: ColourWarning[] = [];
  for (const m of visible) {
    const ratio = contrastRatio(m.color, SURFACE_DARK);
    if (ratio < MIN_CONTRAST) {
      out.push({ kind: 'contrasto', modeKey: m.modeKey, ratio: Math.round(ratio * 100) / 100 });
    }
  }
  for (let i = 0; i < visible.length; i += 1) {
    for (let j = i + 1; j < visible.length; j += 1) {
      const a = visible[i] as { modeKey: string; color: string };
      const b = visible[j] as { modeKey: string; color: string };
      const d = colourDistance(a.color, b.color);
      if (d < MIN_DISTANCE) {
        out.push({
          kind: 'simile',
          modeKey: a.modeKey,
          otherKey: b.modeKey,
          distance: Math.round(d),
        });
      }
    }
  }
  return out;
}

type ModeRow = {
  mode_id: number;
  mode_key: string;
  display_name: string;
  color: string | null;
  in_breakdown: boolean;
  hidden: boolean;
  sort_order: number;
};

/** Il dizionario com'e' adesso, con l'effetto gia' risolto su ogni server. */
export async function readDictionary(db: Database): Promise<Dictionary> {
  const modes = await sql<ModeRow>`
    SELECT mode_id, mode_key, display_name, color, in_breakdown, hidden, sort_order
      FROM stats.mode ORDER BY sort_order, mode_key
  `.execute(db);

  const aliases = await sql<{ mode_id: number; match_kind: MatchKind; match_value: string }>`
    SELECT mode_id, match_kind, match_value FROM stats.mode_alias
     ORDER BY mode_id, match_kind, match_value
  `.execute(db);

  // L'effetto si legge dalla VISTA, che usa la funzione di riferimento: qui
  // non si riscrive la regola di risoluzione, si guarda cosa ha deciso.
  const resolved = await sql<{ server_key: string; mode_key: string }>`
    SELECT server_key, mode_key FROM stats.v_server_mode
     WHERE server_id > 1 ORDER BY server_key
  `.execute(db);

  const byMode = new Map<number, Alias[]>();
  for (const a of aliases.rows) {
    const list = byMode.get(a.mode_id) ?? [];
    list.push({ matchKind: a.match_kind, matchValue: a.match_value });
    byMode.set(a.mode_id, list);
  }
  const serversByKey = new Map<string, string[]>();
  for (const r of resolved.rows) {
    const list = serversByKey.get(r.mode_key) ?? [];
    list.push(r.server_key);
    serversByKey.set(r.mode_key, list);
  }

  const out: Mode[] = modes.rows.map((m) => ({
    modeId: Number(m.mode_id),
    modeKey: m.mode_key,
    displayName: m.display_name,
    color: m.color,
    inBreakdown: m.in_breakdown,
    hidden: m.hidden,
    sortOrder: Number(m.sort_order),
    aliases: byMode.get(Number(m.mode_id)) ?? [],
    servers: serversByKey.get(m.mode_key) ?? [],
  }));

  return {
    modes: out,
    unclassified: serversByKey.get('__unknown__') ?? [],
    warnings: colourWarnings(out),
  };
}

export type PreviewRow = {
  serverKey: string;
  /** Dove sta adesso. `__unknown__` se nessuna regola lo cattura. */
  before: string;
  /** Dove starebbe con la regola candidata. */
  after: string;
};

class Rollback extends Error {}

/**
 * L'effetto di una regola PRIMA di salvarla.
 *
 * Serve perche' l'effetto non e' ovvio: su questa rete un prefisso `duels_`
 * cattura anche `duels_lobby_1` e `duels_event_1`, che l'operatore vuole
 * separati. Vederlo dopo aver salvato significa accorgersene da un grafico
 * sbagliato, giorni dopo.
 *
 * NON RISCRIVE IL MATCHER. La regola candidata si INSERISCE davvero, si
 * rilegge la vista, e poi si annulla la transazione: cosi' l'anteprima usa per
 * costruzione la stessa identica logica del vero, e non puo' divergerne. Una
 * seconda copia dell'ordinamento qui dentro sarebbe la stessa trappola che il
 * documento descrive per il matcher in TypeScript.
 */
export async function previewAlias(db: Database, modeKey: string, alias: Alias): Promise<PreviewRow[]> {
  const before = await sql<{ server_key: string; mode_key: string }>`
    SELECT server_key, mode_key FROM stats.v_server_mode WHERE server_id > 1
  `.execute(db);
  const beforeBy = new Map(before.rows.map((r) => [r.server_key, r.mode_key]));

  let after = new Map<string, string>();
  try {
    await db.transaction().execute(async (trx) => {
      await sql`
        INSERT INTO stats.mode_alias (match_kind, match_value, mode_id)
        SELECT ${alias.matchKind}, ${alias.matchValue}, mode_id
          FROM stats.mode WHERE mode_key = ${modeKey}
        ON CONFLICT (match_kind, match_value) DO UPDATE
          SET mode_id = EXCLUDED.mode_id
      `.execute(trx);
      const res = await sql<{ server_key: string; mode_key: string }>`
        SELECT server_key, mode_key FROM stats.v_server_mode WHERE server_id > 1
      `.execute(trx);
      after = new Map(res.rows.map((r) => [r.server_key, r.mode_key]));
      // L'unico modo di annullare: la transazione non deve lasciare niente.
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }

  return [...beforeBy.keys()].sort().map((serverKey) => ({
    serverKey,
    before: beforeBy.get(serverKey) ?? '__unknown__',
    after: after.get(serverKey) ?? '__unknown__',
  }));
}
