// I tipi e le funzioni pure di «Lingue».
//
// STANNO IN UN MODULO SENZA JSX perche' le usano quattro schermate e perche'
// l'albero delle chiavi e la traduzione in blocco si provano senza montare
// React. Sono le due sole logiche vere della sezione: tutto il resto e' dato
// che arriva dal server e si disegna.

export type Language = { code: string; display: string; position: number; active: boolean };

export type BundleSummary = {
  ns: string;
  owner: string;
  bundle: string;
  keys: number;
  /** Quante chiavi hanno un testo, per lingua. Assente = zero. */
  done: Record<string, number>;
};

export type Overview = { languages: Language[]; bundles: BundleSummary[] };

export type KeyValues = { key: string; values: Record<string, string> };
export type BundleKeys = { ns: string; keys: KeyValues[] };

/** Il ripiego del gioco: la lingua contro cui si misurano le altre. */
export const REFERENCE = 'en';

/** La percentuale, intera. Su zero chiavi e' zero, non una divisione. */
export function pctOf(done: number, total: number): number {
  return total === 0 ? 0 : Math.round((done / total) * 100);
}

/**
 * Il colore di un completamento. Le soglie sono quelle del mockup, e a zero
 * la barra e' vuota — nessun colore, non «rosso»: non e' cominciato, non e'
 * andato male.
 */
export function heat(pct: number): string {
  if (pct >= 95) return 'var(--ok)';
  if (pct >= 70) return 'var(--warn)';
  if (pct > 0) return 'var(--err)';
  return 'var(--s-inset)';
}

/** I bundle per proprietario, nell'ordine in cui arrivano (gia' per nome). */
export function groupBundles(bundles: readonly BundleSummary[]): Array<[string, BundleSummary[]]> {
  const map = new Map<string, BundleSummary[]>();
  for (const b of bundles) map.set(b.owner, [...(map.get(b.owner) ?? []), b]);
  return [...map.entries()];
}

export type TreeNode = {
  kind: 'dir' | 'key';
  label: string;
  /** La chiave intera, o il prefisso intero. */
  full: string;
  depth: number;
  /** Solo sulle cartelle: quante chiavi ci stanno sotto, e se e' aperta. */
  count: number;
  open: boolean;
};

/**
 * Dalle chiavi puntate a UN albero solo, con le chiavi sotto il loro prefisso.
 *
 * SI SCENDE PER LIVELLI, come per i percorsi dei config: a ogni livello prima
 * le chiavi, poi i prefissi, entrambi in ordine alfabetico. Un prefisso chiuso
 * non scrive niente sotto di se' — e' cosi' che un bundle da centodieci chiavi
 * si legge in una colonna senza scorrere.
 *
 * `match.starting-title` e `match` non possono coesistere come chiave e come
 * prefisso? Possono. In quel caso `match` e' una chiave del livello sopra E
 * una cartella: si scrivono tutt'e due, e la chiave viene prima.
 */
export function keyTree(keys: readonly string[], open: ReadonlySet<string>): TreeNode[] {
  const out: TreeNode[] = [];

  const walk = (prefix: string, members: readonly string[], depth: number): void => {
    const leaves: string[] = [];
    const dirs = new Map<string, string[]>();
    for (const key of members) {
      const rest = prefix === '' ? key : key.slice(prefix.length + 1);
      const dot = rest.indexOf('.');
      if (dot === -1) leaves.push(rest);
      else {
        const head = rest.slice(0, dot);
        dirs.set(head, [...(dirs.get(head) ?? []), key]);
      }
    }
    for (const leaf of leaves.sort((a, b) => a.localeCompare(b))) {
      const full = prefix === '' ? leaf : `${prefix}.${leaf}`;
      out.push({ kind: 'key', label: leaf, full, depth, count: 0, open: false });
    }
    for (const [head, inside] of [...dirs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const full = prefix === '' ? head : `${prefix}.${head}`;
      const isOpen = open.has(full);
      out.push({ kind: 'dir', label: head, full, depth, count: inside.length, open: isOpen });
      if (isOpen) walk(full, inside, depth + 1);
    }
  };

  walk('', keys, 0);
  return out;
}

/** I prefissi sopra una chiave: quelli da aprire perche' si veda. */
export function prefixesOf(key: string): string[] {
  const parts = key.split('.');
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('.'));
}

/** Il nome di una lingua, da mostrare accanto al codice. */
export function languageName(code: string): string {
  return NAMES[code] ?? code.toUpperCase();
}

const NAMES: Record<string, string> = {
  en: 'English',
  it: 'Italiano',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  pt: 'Português',
  pl: 'Polski',
  nl: 'Nederlands',
  ru: 'Русский',
  tr: 'Türkçe',
};

// ---------------------------------------------------------------------------
// Tradurre un bundle intero con l'AI.
// ---------------------------------------------------------------------------

/**
 * Le chiavi che l'AI puo' tradurre: quelle ancora senza testo nella lingua, e
 * mai quelle senza un testo inglese — l'AI traduce dall'inglese, e senza non
 * ha niente da cui partire.
 */
export function bulkTargets(keys: readonly KeyValues[], code: string): string[] {
  return keys
    .filter((k) => (k.values[REFERENCE] ?? '').trim() !== '' && (k.values[code] ?? '') === '')
    .map((k) => k.key);
}

export type BulkState = {
  total: number;
  done: number;
  /** Le chiavi saltate, col perche': restano da tradurre a mano. */
  failed: Array<{ key: string; reason: string }>;
  /** Perche' il lavoro si e' fermato prima della fine. `null` = e' arrivato in fondo. */
  stopped: string | null;
};

/**
 * Passa le chiavi a `work`, `concurrency` alla volta.
 *
 * DUE SPECIE DI ERRORE, e `classify` dice quale. Una chiave che non si
 * traduce — formato cambiato, rifiuto — si segna e si va avanti. Un guasto
 * che vale per tutte — budget finito, sessione scaduta, AI giu' — ferma il
 * giro: provare le altre cento chiavi vorrebbe dire cento errori uguali.
 *
 * FERMARSI NON INTERROMPE quelle in corso: sono gia' pagate, e buttarle
 * vorrebbe dire aver speso per niente. Non ne parte nessuna nuova.
 */
export async function runBulk(
  keys: readonly string[],
  work: (key: string) => Promise<void>,
  opts: {
    concurrency: number;
    signal: AbortSignal;
    classify: (err: unknown) => { fatal: boolean; reason: string };
    onProgress?: (state: BulkState) => void;
  },
): Promise<BulkState> {
  const state: BulkState = { total: keys.length, done: 0, failed: [], stopped: null };
  const report = (): void => opts.onProgress?.({ ...state, failed: [...state.failed] });
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < keys.length && state.stopped === null && !opts.signal.aborted) {
      const key = keys[next] as string;
      next += 1;
      try {
        await work(key);
        state.done += 1;
      } catch (err) {
        const { fatal, reason } = opts.classify(err);
        if (!fatal) state.failed.push({ key, reason });
        else if (state.stopped === null) state.stopped = reason;
      }
      report();
    }
  };

  await Promise.all(Array.from({ length: Math.min(opts.concurrency, keys.length) }, worker));
  if (state.stopped === null && state.done + state.failed.length < keys.length) {
    state.stopped = 'Fermata a mano.';
  }
  report();
  return state;
}
