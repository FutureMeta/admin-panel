// I testi che i giocatori vedono in gioco, letti e scritti dove li tiene
// Metaverse.
//
// NON C'E' UNA COPIA NEL PANNELLO. Le due tabelle — `metaverse_message` e
// `metaverse_language`, su MariaDB, nel database `metamc` — le possiede il
// plugin: le riempie all'avvio con i testi del jar, le rilegge ogni minuto
// guardando un'impronta (righe, somma delle versioni, ultimo aggiornamento),
// e le scrive dalla console con `/langadmin`. Il pannello entra dalla stessa
// porta e fa le stesse scritture, con lo stesso SQL: e' l'unico modo perche'
// l'impronta cambi e i server se ne accorgano senza toccare una riga di Java.
//
// IL MODELLO CHE IL PANNELLO MOSTRA e' piu' semplice di quello che le tabelle
// tengono. Ogni riga ha `shipped` (il jar) e `custom` (lo staff), e il gioco
// usa `custom` se c'e', altrimenti `shipped`. Per chi traduce non esiste un
// default e una modifica: esiste IL testo, e la modifica va in `custom`. Non
// c'e' un «torna al jar» ed e' deliberato: sarebbe la seconda verita' che la
// specifica dice di non reintrodurre.
//
// LE CHIAVI LE CREANO I PLUGIN. Una riga per (bundle, lingua, chiave) nasce
// all'avvio del server o traducendo una chiave che l'inglese ha gia'. Il
// pannello non scrive mai una chiave che nessuna lingua conosce: sarebbe un
// testo che nessuno leggera' mai.
//
// L'UNICA CANCELLAZIONE E' QUELLA DI UNA LINGUA, con i suoi testi. Metaverse
// non ne ha una: da console una lingua si spegne e basta. Qui si toglie del
// tutto, e i server se ne accorgono dall'impronta — il numero di righe cala.
// Chi la usava in gioco vede l'inglese, come per una lingua spenta.
//
// `updated_at` E' IN MILLISECONDI, come lo scrive Java (`System
// .currentTimeMillis()`), e `version` sale di uno a ogni scrittura: sono le
// due cose che l'impronta guarda, e scriverle diversamente da Metaverse
// vorrebbe dire modifiche che i server non vedono mai.

import type { DuelsMysql } from '#src/duels/mysql.ts';
import { TAG } from '#web/lib/minimessage.ts';

export type Language = {
  code: string;
  /** MiniMessage: il nome nel menu in gioco. */
  display: string;
  position: number;
  active: boolean;
};

export type BundleSummary = {
  /** `owner.bundle`, com'e' scritto ovunque. */
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

export class UnknownBundle extends Error {
  constructor(ns: string) {
    super(`bundle sconosciuto: ${ns}`);
    this.name = 'UnknownBundle';
  }
}

export class UnknownKey extends Error {
  constructor(ns: string, key: string) {
    super(`chiave sconosciuta: ${ns} ${key}`);
    this.name = 'UnknownKey';
  }
}

export class UnknownLanguage extends Error {
  constructor(code: string) {
    super(`lingua sconosciuta: ${code}`);
    this.name = 'UnknownLanguage';
  }
}

/**
 * Un comando cliccabile che il plugin non spedisce per quella chiave.
 *
 * `<click:run_command:…>` fa eseguire il comando a chi clicca, con i SUOI
 * permessi: in un messaggio che legge lo staff, un traduttore potrebbe far
 * lanciare a un admin un comando che lui non ha. Da console lo puo' fare solo
 * chi ha `/langadmin`; dal pannello, i comandi restano quelli del jar.
 */
export class UnsafeClick extends Error {
  readonly command: string;
  constructor(command: string) {
    super(`comando non previsto: ${command}`);
    this.name = 'UnsafeClick';
    this.command = command;
  }
}

export class LanguageExists extends Error {
  constructor(code: string) {
    super(`lingua già presente: ${code}`);
    this.name = 'LanguageExists';
  }
}

const SEGMENT = /^[a-z0-9_-]+$/;
export const KEY_SHAPE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** MariaDB: chiave primaria gia' presente. */
const ER_DUP_ENTRY = 1062;

/** `duels.uhc` → le sue due parti. Un punto solo, com'e' che i plugin le chiamano. */
export function parseNamespace(ns: string): { owner: string; bundle: string } | null {
  const dot = ns.indexOf('.');
  if (dot <= 0 || dot === ns.length - 1) return null;
  const owner = ns.slice(0, dot);
  const bundle = ns.slice(dot + 1);
  if (!SEGMENT.test(owner) || !SEGMENT.test(bundle)) return null;
  return { owner, bundle };
}

type LanguageRow = { locale: string; enabled: number; display_name: string; position: number };

const toLanguage = (r: LanguageRow): Language => ({
  code: r.locale,
  display: r.display_name,
  position: r.position,
  active: r.enabled === 1,
});

export async function listLanguages(db: DuelsMysql): Promise<Language[]> {
  const rows = await db.rows<LanguageRow>(
    'SELECT locale, enabled, display_name, position FROM metaverse_language ORDER BY position, locale',
  );
  return rows.map(toLanguage);
}

export async function readOverview(db: DuelsMysql): Promise<Overview> {
  // Tre letture indipendenti, insieme: il pool ha quattro connessioni.
  const [languages, bundles, done] = await Promise.all([
    listLanguages(db),
    // Una chiave esiste nel bundle se ESISTE UNA RIGA per lei, in qualunque
    // lingua: il jar la pubblica per le lingue che ha, e la prima traduzione
    // ne aggiunge un'altra.
    db.rows<{ namespace: string; n: number | string }>(
      'SELECT namespace, COUNT(DISTINCT message_key) AS n FROM metaverse_message GROUP BY namespace ORDER BY namespace',
    ),
    // Tradotta = ha un testo che il gioco userebbe: `custom`, o `shipped` se
    // non c'e' un `custom`. Una riga con tutt'e due a NULL e' un residuo, e
    // non conta. I conteggi arrivano come stringhe (`bigNumberStrings`).
    db.rows<{ namespace: string; locale: string; n: number | string }>(
      'SELECT namespace, locale, COUNT(*) AS n FROM metaverse_message WHERE COALESCE(custom, shipped) IS NOT NULL GROUP BY namespace, locale',
    ),
  ]);
  const byNs = new Map<string, Record<string, number>>();
  for (const row of done) {
    const map = byNs.get(row.namespace) ?? {};
    map[row.locale] = Number(row.n);
    byNs.set(row.namespace, map);
  }

  return {
    languages,
    bundles: bundles.flatMap((b) => {
      const parsed = parseNamespace(b.namespace);
      // Un nome che non e' `owner.bundle` non e' un bundle: il pannello non
      // lo mostra invece di mostrarlo storto.
      if (parsed === null) return [];
      return [{ ns: b.namespace, ...parsed, keys: Number(b.n), done: byNs.get(b.namespace) ?? {} }];
    }),
  };
}

export async function readBundleKeys(db: DuelsMysql, ns: string): Promise<BundleKeys> {
  if (parseNamespace(ns) === null) throw new UnknownBundle(ns);

  const rows = await db.rows<{ message_key: string; locale: string; value: string | null }>(
    'SELECT message_key, locale, COALESCE(custom, shipped) AS value FROM metaverse_message WHERE namespace = ? ORDER BY message_key, locale',
    [ns],
  );
  if (rows.length === 0) throw new UnknownBundle(ns);

  const keys = new Map<string, Record<string, string>>();
  for (const row of rows) {
    const values = keys.get(row.message_key) ?? {};
    if (row.value !== null) values[row.locale] = row.value;
    keys.set(row.message_key, values);
  }
  return { ns, keys: [...keys.entries()].map(([key, values]) => ({ key, values })) };
}

/** Le righe di una chiave, una per lingua, con il testo che il gioco usa. */
const KEY_ROWS =
  'SELECT locale, COALESCE(custom, shipped) AS value, shipped FROM metaverse_message WHERE namespace = ? AND message_key = ?';
type KeyRow = { locale: string; value: string | null; shipped: string | null };

/** I `<click:…>` di un testo, com'e' scritto. Quelli dentro un hover non si cliccano, e il TAG li salta. */
function clicksOf(text: string): string[] {
  return [...text.matchAll(TAG)].map((m) => m[0]).filter((tag) => /^<click:/i.test(tag));
}

/** I testi di una chiave, per lingua. Serve all'AI: l'inglese lo legge il server, non lo manda il client. */
export async function readKey(db: DuelsMysql, ns: string, key: string): Promise<Record<string, string>> {
  if (parseNamespace(ns) === null) throw new UnknownBundle(ns);
  const rows = await db.rows<KeyRow>(KEY_ROWS, [ns, key]);
  if (rows.length === 0) throw new UnknownKey(ns, key);
  const values: Record<string, string> = {};
  for (const row of rows) if (row.value !== null) values[row.locale] = row.value;
  return values;
}

/**
 * Scrive il testo di una chiave in una lingua. Restituisce quello di prima,
 * perche' e' l'unico posto in cui lo si puo' ancora leggere: finisce nel
 * registro, che per questi valori e' tutto lo storico che c'e'.
 *
 * LO STESSO SQL DI `MessageDatabase.setCustom` in Metaverse: e' quello che il
 * gioco usa da console, e imitarlo alla lettera — `shipped` a NULL sulla riga
 * nuova, `version + 1`, `updated_at` adesso — e' cio' che fa cambiare
 * l'impronta che i server guardano.
 */
export async function setValue(
  db: DuelsMysql,
  input: { ns: string; key: string; code: string; value: string; author: string },
): Promise<{ before: string | null }> {
  if (parseNamespace(input.ns) === null) throw new UnknownBundle(input.ns);

  return db.tx(async (t) => {
    // La chiave deve esistere gia' in QUALCHE lingua. E' la differenza fra
    // tradurre e inventare: l'inglese ha `event.full` e l'italiano no, si
    // traduce; nessuno ha `event.fulll`, e' un refuso che non deve entrare.
    // Una lettura sola: le righe della chiave dicono sia che esiste sia
    // com'era nella lingua che si sta scrivendo.
    const rows = await t.rows<KeyRow>(KEY_ROWS, [input.ns, input.key]);
    if (rows.length === 0) throw new UnknownKey(input.ns, input.key);

    // I comandi cliccabili sono quelli del jar, in una lingua qualunque: la
    // traduzione cambia le parole, non cosa succede cliccandole.
    const shipped = new Set(rows.flatMap((r) => clicksOf(r.shipped ?? '')));
    const unexpected = clicksOf(input.value).find((c) => !shipped.has(c));
    if (unexpected !== undefined) throw new UnsafeClick(unexpected);

    const language = await t.rows<{ locale: string }>(
      'SELECT locale FROM metaverse_language WHERE locale = ?',
      [input.code],
    );
    if (language.length === 0) throw new UnknownLanguage(input.code);

    await t.run(
      `INSERT INTO metaverse_message (namespace, locale, message_key, shipped, custom, version, updated_at)
       VALUES (?, ?, ?, NULL, ?, 1, ?)
       ON DUPLICATE KEY UPDATE custom = VALUES(custom), version = version + 1, updated_at = VALUES(updated_at)`,
      [input.ns, input.code, input.key, input.value, Date.now()],
    );

    return { before: rows.find((r) => r.locale === input.code)?.value ?? null };
  });
}

/**
 * Una lingua nuova nasce DISATTIVATA e vuota, in fondo al menu.
 *
 * Metaverse da console la accenderebbe subito; il pannello no. Accenderla la
 * mostra a tutti i giocatori, e con zero chiavi tradotte vedrebbero l'inglese
 * dentro un menu che promette un'altra lingua.
 */
export async function createLanguage(
  db: DuelsMysql,
  input: { code: string; display: string; author: string },
): Promise<Language> {
  return db.tx(async (t) => {
    const existing = await t.rows<{ locale: string }>(
      'SELECT locale FROM metaverse_language WHERE locale = ?',
      [input.code],
    );
    if (existing.length > 0) throw new LanguageExists(input.code);

    try {
      await t.run(
        `INSERT INTO metaverse_language (locale, enabled, display_name, head_texture, position, version, updated_at)
         SELECT ?, 0, ?, NULL, COALESCE(MAX(position) + 1, 0), 1, ? FROM metaverse_language`,
        [input.code, input.display, Date.now()],
      );
    } catch (err) {
      // 1062, chiave doppia: due creazioni insieme, e l'altra e' arrivata
      // prima. Per chi ha cliccato e' la stessa cosa del controllo qui sopra.
      if ((err as { errno?: number }).errno === ER_DUP_ENTRY) throw new LanguageExists(input.code);
      throw err;
    }
    const created = await t.rows<LanguageRow>(
      'SELECT locale, enabled, display_name, position FROM metaverse_language WHERE locale = ?',
      [input.code],
    );
    return toLanguage(created[0] as LanguageRow);
  });
}

export async function updateLanguage(
  db: DuelsMysql,
  code: string,
  patch: { display?: string; active?: boolean },
): Promise<Language> {
  return db.tx(async (t) => {
    // FOR UPDATE: una rinomina e un'accensione contemporanee si mettono in
    // fila, invece di riscrivere ognuna il campo dell'altra con quello vecchio.
    const current = await t.rows<LanguageRow>(
      'SELECT locale, enabled, display_name, position FROM metaverse_language WHERE locale = ? FOR UPDATE',
      [code],
    );
    const row = current[0];
    if (row === undefined) throw new UnknownLanguage(code);

    const display = patch.display ?? row.display_name;
    const enabled = patch.active === undefined ? row.enabled : patch.active ? 1 : 0;
    // Niente da cambiare, niente scrittura: una version che sale a vuoto e' un
    // giro di rilettura dei server per niente.
    if (display === row.display_name && enabled === row.enabled) return toLanguage(row);
    await t.run(
      'UPDATE metaverse_language SET display_name = ?, enabled = ?, version = version + 1, updated_at = ? WHERE locale = ?',
      [display, enabled, Date.now(), code],
    );
    return toLanguage({ ...row, display_name: display, enabled });
  });
}

/**
 * Cancella una lingua e tutti i suoi testi. Restituisce quanti testi c'erano:
 * finiscono nel registro, che e' l'unico posto in cui resta scritto quanto
 * lavoro se n'e' andato.
 *
 * I TESTI SI CANCELLANO INSIEME, non si lasciano. Righe di una lingua che non
 * esiste piu' sarebbero una seconda verita': non si vedono, contano nelle
 * percentuali, e ricomparirebbero ricreando la lingua senza che nessuno se lo
 * aspetti. Quelli del jar tornano da soli al prossimo avvio dei server.
 */
export async function deleteLanguage(
  db: DuelsMysql,
  code: string,
): Promise<{ display: string; texts: number }> {
  return db.tx(async (t) => {
    const current = await t.rows<LanguageRow>(
      'SELECT locale, enabled, display_name, position FROM metaverse_language WHERE locale = ?',
      [code],
    );
    const row = current[0];
    if (row === undefined) throw new UnknownLanguage(code);

    const texts = await t.run('DELETE FROM metaverse_message WHERE locale = ?', [code]);
    await t.run('DELETE FROM metaverse_language WHERE locale = ?', [code]);
    return { display: row.display_name, texts: texts.affectedRows };
  });
}

/**
 * Sposta una lingua di un posto nel menu, scambiandola con la vicina.
 *
 * UNO SCAMBIO E NON UN INDICE: due righe cambiano e le altre no, e non c'e'
 * modo di lasciare un buco o un doppione. Ai bordi non succede niente.
 */
export async function moveLanguage(db: DuelsMysql, code: string, direction: 'up' | 'down'): Promise<void> {
  await db.tx(async (t) => {
    const ordered = await t.rows<{ locale: string; position: number }>(
      'SELECT locale, position FROM metaverse_language ORDER BY position, locale FOR UPDATE',
    );
    const i = ordered.findIndex((r) => r.locale === code);
    if (i === -1) throw new UnknownLanguage(code);
    const j = direction === 'up' ? i - 1 : i + 1;
    const moved = ordered[i];
    const other = ordered[j];
    if (moved === undefined || other === undefined) return;
    // Le posizioni si riscrivono TUTTE dall'ordine, 0..n-1, non solo le due
    // scambiate: una lingua cancellata lascia un buco, due inserite a mano
    // possono avere lo stesso numero, e scambiare due numeri fra buchi o
    // doppioni sposterebbe la lingua di piu' posti. Si scrivono solo le righe
    // il cui numero non e' gia' quello giusto.
    ordered[i] = other;
    ordered[j] = moved;
    const now = Date.now();
    for (const [index, row] of ordered.entries()) {
      if (Number(row.position) === index) continue;
      await t.run(
        'UPDATE metaverse_language SET position = ?, version = version + 1, updated_at = ? WHERE locale = ?',
        [index, now, row.locale],
      );
    }
  });
}
