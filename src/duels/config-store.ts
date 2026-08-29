// I file di configurazione che i server scaricano all'avvio.
//
// COSA C'E' QUI E COSA NO. Qui c'e' solo l'accesso ai dati: leggere l'albero,
// leggere un file, salvare una bozza, cambiare i legami, pubblicare, costruire
// il bundle. Le autorizzazioni stanno nelle rotte, dove sta l'attore.
//
// IL MODELLO IN UNA RIGA: un PERCORSO ha una o piu' VERSIONI, e ogni MODULO e'
// legato a esattamente una di quelle versioni. Una versione sola legata a tutti
// = file condiviso; una versione per modulo = file separati. Il vincolo «un
// modulo, una versione» non e' controllato qui: e' la chiave primaria di
// `duels_config_binding`, e quindi non si puo' aggirare nemmeno sbagliando.
//
// BOZZA E PUBBLICATO SONO DUE COLONNE. `published` e' cio' che i server
// ricevono, `draft` cio' che qualcuno sta scrivendo. Salvare non pubblica mai,
// e questa e' l'unica ragione per cui si puo' lavorare su una modifica per
// giorni senza che il gioco se ne accorga.

import { sql } from 'kysely';
import type { Database } from '#src/db/pool.ts';

/**
 * I moduli del plugin. Vivono qui e non in una tabella.
 *
 * Un vincolo di dominio in SQL vorrebbe dire una migration per ogni modulo
 * nuovo, e questa schermata esiste proprio per togliere quel genere di
 * attrito. Il prezzo — un modulo scritto male non viene rifiutato dal
 * database — lo paga il controllo qui sotto, che sta sulla rotta.
 */
export const CONFIG_MODULES = [
  'lobby',
  'game',
  'ffa',
  'event',
  'replay',
  'setup',
  'duel-command',
  'event-command',
] as const;

export type ConfigModule = (typeof CONFIG_MODULES)[number];

export function isConfigModule(value: string): value is ConfigModule {
  return (CONFIG_MODULES as readonly string[]).includes(value);
}

/**
 * I percorsi che il pannello si rifiuta di gestire, qualunque cosa si chieda.
 *
 * `credentials.yml` porta utente e password SQL e l'URI Redis. Gestirlo dal
 * pannello vorrebbe dire tenere le password del gioco nel nostro database e
 * spedirle in HTTP a ogni avvio di ogni server. Non e' una scelta di
 * interfaccia — «non lo mostriamo» — e' l'API che dice di no.
 *
 * `plugin.yml` e' il manifest che Bukkit legge per caricare il plugin: non e'
 * una configurazione, e sovrascriverlo rompe l'avvio.
 */
export const CONFIG_FORBIDDEN: readonly string[] = ['credentials.yml', 'plugin.yml'];

export class ForbiddenPath extends Error {
  constructor(path: string) {
    super(`percorso non gestibile dal pannello: ${path}`);
    this.name = 'ForbiddenPath';
  }
}

export class UnknownPath extends Error {
  constructor(path: string) {
    super(`percorso sconosciuto: ${path}`);
    this.name = 'UnknownPath';
  }
}

export class PathExists extends Error {
  constructor(path: string) {
    super(`percorso già presente: ${path}`);
    this.name = 'PathExists';
  }
}

/**
 * Un percorso e' relativo, con le barre in avanti, e non risale.
 *
 * IL CONTROLLO CHE CONTA E' `..`. Il plugin scrive questi file sul disco del
 * server partendo dalla propria cartella dati: un percorso che risale uscirebbe
 * da li' e finirebbe dove decide chi ha scritto il percorso. Il database ha il
 * suo CHECK, ma quello non conosce `..` — questo si'.
 */
export function isConfigPath(value: string): boolean {
  if (value.length === 0 || value.length > 240) return false;
  if (value.startsWith('/') || value.includes('\\')) return false;
  if (!value.endsWith('.yml')) return false;
  if (value.split('/').some((part) => part === '' || part === '.' || part === '..')) return false;
  // Niente caratteri che su un filesystem significano qualcosa d'altro.
  return /^[A-Za-z0-9._/-]+$/.test(value);
}

/**
 * Una cartella dell'albero: le stesse regole di un percorso, senza `.yml`.
 *
 * LA STRINGA VUOTA E' RIFIUTATA, ed e' il controllo che conta. Le cartelle non
 * esistono nel database — sono un prefisso — e cancellare «la cartella vuota»
 * vorrebbe dire cancellare ogni percorso che comincia per `/`, cioe' tutti.
 * Non e' un caso che si presenti cliccando: e' un caso che si presenta con una
 * richiesta scritta a mano, ed e' l'unica in cui l'errore e' irreparabile.
 */
export function isConfigDir(value: string): boolean {
  if (value.length === 0 || value.length > 240) return false;
  if (value.startsWith('/') || value.endsWith('/') || value.includes('\\')) return false;
  if (value.split('/').some((part) => part === '' || part === '.' || part === '..')) return false;
  return /^[A-Za-z0-9._/-]+$/.test(value);
}

export type ConfigVersion = {
  id: number;
  /** I moduli legati a QUESTA versione. Mai vuoto dopo un salvataggio riuscito. */
  modules: string[];
  published: string | null;
  publishedAt: string | null;
  publishedBy: string | null;
  draft: string | null;
  draftAt: string | null;
  draftBy: string | null;
};

export type ConfigFileSummary = {
  path: string;
  /** Tutti i moduli legati al percorso, di qualunque versione. */
  modules: string[];
  /** `true` quando ogni modulo ha la sua versione. */
  split: boolean;
  versions: number;
  hasDraft: boolean;
  /** Chi e quando, dell'ultimo movimento — bozza o pubblicazione. */
  by: string | null;
  at: string | null;
};

type VersionRow = {
  id: number;
  path: string;
  published: string | null;
  published_at: Date | null;
  published_by: string | null;
  draft: string | null;
  draft_at: Date | null;
  draft_by: string | null;
  modules: string[] | null;
};

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

function toVersion(row: VersionRow): ConfigVersion {
  return {
    id: row.id,
    // `array_agg` su un LEFT JOIN senza righe da' `{NULL}`, non `{}`: senza il
    // filtro, una versione senza legami arriverebbe con un modulo chiamato
    // `null`. Succede solo in mezzo a un cambio di legami, ed e' esattamente
    // quando fa piu' danno.
    modules: (row.modules ?? []).filter((m): m is string => typeof m === 'string').sort(),
    published: row.published,
    publishedAt: iso(row.published_at),
    publishedBy: row.published_by,
    draft: row.draft,
    draftAt: iso(row.draft_at),
    draftBy: row.draft_by,
  };
}

/** L'albero: un riepilogo per percorso, SENZA i contenuti. */
export async function listConfigFiles(db: Database): Promise<ConfigFileSummary[]> {
  // I contenuti non entrano qui e non e' un dettaglio: sono circa un megabyte
  // in tutto, e l'albero si ridisegna a ogni apertura della schermata.
  const rows = await sql<{
    path: string;
    versions: number;
    modules: string[] | null;
    has_draft: boolean;
    by: string | null;
    at: Date | null;
  }>`
    SELECT p.path,
           count(DISTINCT v.id)::int                                        AS versions,
           array_remove(array_agg(DISTINCT b.module), NULL)                 AS modules,
           bool_or(v.draft IS NOT NULL)                                     AS has_draft,
           (array_agg(coalesce(v.draft_by, v.published_by)
                      ORDER BY coalesce(v.draft_at, v.published_at) DESC NULLS LAST))[1] AS by,
           max(coalesce(v.draft_at, v.published_at))                        AS at
      FROM stats.duels_config_path p
      LEFT JOIN stats.duels_config_version v ON v.path_id = p.id
      LEFT JOIN stats.duels_config_binding b ON b.version_id = v.id
     GROUP BY p.path
     ORDER BY p.path
  `.execute(db);

  return rows.rows.map((r) => {
    const modules = (r.modules ?? []).filter((m): m is string => typeof m === 'string').sort();
    return {
      path: r.path,
      modules,
      // Diviso quando le versioni sono piu' d'una. Con un modulo solo legato
      // non c'e' differenza fra le due modalita', ed e' giusto che dica «non
      // diviso»: non c'e' niente da dividere.
      split: r.versions > 1,
      versions: r.versions,
      hasDraft: r.has_draft ?? false,
      by: r.by,
      at: iso(r.at),
    };
  });
}

/** Un percorso con tutte le sue versioni e i contenuti. */
export async function readConfigFile(
  db: Database,
  path: string,
): Promise<{ path: string; split: boolean; versions: ConfigVersion[] }> {
  const rows = await sql<VersionRow>`
    SELECT v.id, p.path, v.published, v.published_at, v.published_by,
           v.draft, v.draft_at, v.draft_by,
           array_remove(array_agg(b.module), NULL) AS modules
      FROM stats.duels_config_path p
      JOIN stats.duels_config_version v ON v.path_id = p.id
      LEFT JOIN stats.duels_config_binding b ON b.version_id = v.id
     WHERE p.path = ${path}
     GROUP BY v.id, p.path
     ORDER BY v.id
  `.execute(db);

  if (rows.rows.length === 0) throw new UnknownPath(path);
  const versions = rows.rows.map(toVersion);
  return { path, split: versions.length > 1, versions };
}

/**
 * Crea un percorso, legato ai moduli scelti, con una versione sola e vuota.
 *
 * NASCE VUOTO ED E' VOLUTO: il plugin legge con i propri default, quindi un
 * file senza chiavi non sovrascrive niente e non rompe niente. E' cio' che
 * permette di aggiungere un config nuovo dopo un aggiornamento senza portarsi
 * dietro mille righe di YAML.
 */
export async function createConfigPath(
  db: Database,
  input: { path: string; modules: readonly string[]; author: string },
): Promise<void> {
  if (CONFIG_FORBIDDEN.includes(input.path)) throw new ForbiddenPath(input.path);

  await db.transaction().execute(async (trx) => {
    const existing = await sql<{ id: number }>`
      SELECT id FROM stats.duels_config_path WHERE path = ${input.path}
    `.execute(trx);
    if (existing.rows.length > 0) throw new PathExists(input.path);

    const created = await sql<{ id: number }>`
      INSERT INTO stats.duels_config_path (path, created_by)
      VALUES (${input.path}, ${input.author})
      RETURNING id
    `.execute(trx);
    const pathId = created.rows[0]?.id as number;

    const version = await sql<{ id: number }>`
      INSERT INTO stats.duels_config_version (path_id, draft, draft_at, draft_by)
      VALUES (${pathId}, '', now(), ${input.author})
      RETURNING id
    `.execute(trx);
    const versionId = version.rows[0]?.id as number;

    for (const module of input.modules) {
      await sql`
        INSERT INTO stats.duels_config_binding (path_id, module, version_id)
        VALUES (${pathId}, ${module}, ${versionId})
      `.execute(trx);
    }
  });
}

export type DeleteSummary = {
  /** I percorsi cancellati, in ordine. */
  paths: string[];
  /** I moduli che li ricevevano: quelli che al prossimo avvio non li avranno. */
  modules: string[];
};

/**
 * Cancella un percorso, o tutti i percorsi sotto una cartella.
 *
 * CANCELLA UNA RIGA SOLA, e il resto se ne va da se': versioni, legami e
 * cronologia hanno tutti `ON DELETE CASCADE` verso `duels_config_path`.
 * Cancellarli a mano qui vorrebbe dire ripetere in TypeScript una regola che
 * il database gia' applica — e le due copie divergono il giorno in cui si
 * aggiunge una tabella.
 *
 * LA BARRA IN FONDO AL PREFISSO NON E' UN DETTAGLIO. Senza, cancellare
 * `inventories` porterebbe via anche `inventories_old/config.yml`, che e' un
 * altro ramo dell'albero: `starts_with(path, 'inventories/')` non lo tocca.
 *
 * NON C'E' UNA BOZZA DI UNA CANCELLAZIONE. Il percorso sparisce dal bundle
 * subito, e i server se ne accorgono al primo riavvio: e' il motivo per cui la
 * rotta chiede il livello 3, lo stesso di «Pubblica».
 */
export async function deleteConfigPaths(
  db: Database,
  input: { path: string; folder: boolean },
): Promise<DeleteSummary> {
  return db.transaction().execute(async (trx) => {
    const found = await sql<{ id: number; path: string }>`
      SELECT id, path
        FROM stats.duels_config_path
       WHERE ${input.folder ? sql`starts_with(path, ${`${input.path}/`})` : sql`path = ${input.path}`}
       ORDER BY path
    `.execute(trx);
    if (found.rows.length === 0) throw new UnknownPath(input.path);

    const ids = found.rows.map((r) => r.id);
    // I moduli si leggono PRIMA: dopo la cancellazione i legami non ci sono
    // piu', e chi legge il registro non saprebbe piu' chi ha perso cosa.
    const modules = await sql<{ module: string }>`
      SELECT DISTINCT module
        FROM stats.duels_config_binding
       WHERE path_id = ANY(${ids}::int[])
       ORDER BY module
    `.execute(trx);

    await sql`DELETE FROM stats.duels_config_path WHERE id = ANY(${ids}::int[])`.execute(trx);

    return { paths: found.rows.map((r) => r.path), modules: modules.rows.map((r) => r.module) };
  });
}

/** Salva la bozza di una versione. Non tocca `published`. */
export async function saveConfigDraft(
  db: Database,
  input: { versionId: number; content: string; author: string },
): Promise<void> {
  await sql`
    UPDATE stats.duels_config_version
       SET draft = ${input.content}, draft_at = now(), draft_by = ${input.author}
     WHERE id = ${input.versionId}
  `.execute(db);
}

/**
 * Cambia i moduli legati a un percorso e il modo — condiviso o diviso.
 *
 * `keep` E' LA VERSIONE CHE SOPRAVVIVE, e la manda il client perche' e' quella
 * che chi guarda ha davanti. Passando da diviso a condiviso i contenuti degli
 * altri si perdono: e' inevitabile — restano N testi e ne serve uno — ma
 * QUALE resta non puo' deciderlo il database tirando a sorte. Il modo giusto
 * di scegliere e' «quello che stavo guardando quando ho premuto Salva».
 *
 * Il verso opposto non perde niente: da condiviso a diviso si copia lo stesso
 * contenuto in una versione per modulo.
 */
export async function setConfigLinks(
  db: Database,
  input: { path: string; modules: readonly string[]; split: boolean; keepVersionId: number; author: string },
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const found = await sql<{ id: number }>`
      SELECT id FROM stats.duels_config_path WHERE path = ${input.path}
    `.execute(trx);
    const pathId = found.rows[0]?.id;
    if (pathId === undefined) throw new UnknownPath(input.path);

    const versions = await sql<{ id: number; published: string | null; draft: string | null }>`
      SELECT id, published, draft FROM stats.duels_config_version
       WHERE path_id = ${pathId} ORDER BY id
    `.execute(trx);

    const keep = versions.rows.find((v) => v.id === input.keepVersionId) ?? versions.rows[0];
    if (!keep) throw new UnknownPath(input.path);

    // I legami di PRIMA, letti prima di toccarli. Sono ciò che permette di
    // distinguere un modulo che c'era già — e che deve tenersi la sua versione
    // — da uno appena aggiunto. Senza questa riga la funzione non sa la
    // differenza, ed è esattamente il difetto che aveva.
    const existing = await sql<{ module: string; version_id: number }>`
      SELECT module, version_id FROM stats.duels_config_binding WHERE path_id = ${pathId}
    `.execute(trx);

    // I legami si rifanno da zero. Aggiornarli in differenza — quali togliere,
    // quali aggiungere, quali spostare — significherebbe passare per stati in
    // cui un modulo e' legato due volte, e la chiave primaria li rifiuterebbe
    // a meta' strada.
    await sql`DELETE FROM stats.duels_config_binding WHERE path_id = ${pathId}`.execute(trx);

    if (!input.split) {
      await sql`
        DELETE FROM stats.duels_config_version
         WHERE path_id = ${pathId} AND id <> ${keep.id}
      `.execute(trx);
      for (const module of input.modules) {
        await sql`
          INSERT INTO stats.duels_config_binding (path_id, module, version_id)
          VALUES (${pathId}, ${module}, ${keep.id})
        `.execute(trx);
      }
      return;
    }

    // -----------------------------------------------------------------------
    // Diviso.
    //
    // OGNI MODULO GIA' LEGATO TIENE LA SUA VERSIONE. Sembra ovvio e non lo era:
    // la prima versione di questa funzione cancellava tutte le versioni tranne
    // quella aperta e le ricreava come copie, perche' era stata scritta
    // pensando solo al passaggio da condiviso a diviso. L'effetto era che
    // AGGIUNGERE UN MODULO a un file gia' diviso appiattiva lobby, ffa e game
    // sul contenuto che chi guardava aveva davanti — senza chiedere niente,
    // sull'azione piu' innocua della schermata.
    //
    // Si copia solo per i moduli che una versione non ce l'hanno ancora.
    // -----------------------------------------------------------------------

    /** Da modulo alla versione che aveva prima. Vuota se prima non era legato. */
    const previous = new Map(existing.rows.map((b) => [b.module, b.version_id]));

    /**
     * Quante volte una versione resta usata dopo questo giro. Serve a due cose
     * in fondo: sapere quali versioni sfaldare, e quali sono rimaste orfane.
     */
    const used = new Map<number, string[]>();

    for (const module of input.modules) {
      const before = previous.get(module);
      if (before === undefined) continue;
      used.set(before, [...(used.get(before) ?? []), module]);
    }

    for (const module of input.modules) {
      const before = previous.get(module);
      if (before !== undefined) {
        // Aveva gia' una versione: si rimette il legame com'era. La versione
        // non si tocca — e' il punto di tutta questa riscrittura.
        await sql`
          INSERT INTO stats.duels_config_binding (path_id, module, version_id)
          VALUES (${pathId}, ${module}, ${before})
        `.execute(trx);
        continue;
      }
      // Modulo nuovo: parte da una copia di quella che si sta guardando, che e'
      // l'unica sorgente sensata. Un file vuoto sarebbe una sorpresa.
      const copyId = await copyVersion(trx, pathId, keep, input.author);
      await sql`
        INSERT INTO stats.duels_config_binding (path_id, module, version_id)
        VALUES (${pathId}, ${module}, ${copyId})
      `.execute(trx);
      used.set(copyId, [module]);
    }

    // Una versione condivisa da piu' moduli, in modalita' divisa, va sfaldata:
    // uno la tiene, gli altri ne ricevono una copia. E' il passaggio da
    // condiviso a diviso, ed e' l'unico caso in cui qui si creano copie di
    // qualcosa che esisteva gia'.
    for (const [versionId, modules] of used) {
      if (modules.length < 2) continue;
      const source = versions.rows.find((v) => v.id === versionId) ?? keep;
      for (const module of modules.slice(1)) {
        const copyId = await copyVersion(trx, pathId, source, input.author);
        await sql`
          UPDATE stats.duels_config_binding SET version_id = ${copyId}
           WHERE path_id = ${pathId} AND module = ${module}
        `.execute(trx);
      }
    }

    // Le versioni rimaste senza nessun modulo. Sono irraggiungibili — nessuna
    // schermata sa mostrare una versione che non riceve nessuno — e lasciarle
    // vorrebbe dire righe che si accumulano per sempre. Si cancellano, ed e'
    // perdita di contenuto: e' il prezzo di togliere un modulo da un file
    // diviso, e la schermata lo dice prima.
    //
    // `keep` non e' protetta: se e' rimasta senza moduli va via come le altre.
    // L'unica eccezione e' quando NON RESTA NESSUN LEGAME — si sono tolti tutti
    // i moduli — perche' allora cancellarle tutte lascerebbe un percorso senza
    // nemmeno una versione, cioe' una riga che la schermata non sa aprire. In
    // quel caso sopravvive quella che si stava guardando, e il file torna
    // modificabile appena gli si rilega un modulo.
    await sql`
      DELETE FROM stats.duels_config_version v
       WHERE v.path_id = ${pathId}
         AND NOT EXISTS (
           SELECT 1 FROM stats.duels_config_binding b WHERE b.version_id = v.id
         )
         AND (
           v.id <> ${keep.id}
           OR EXISTS (
             SELECT 1 FROM stats.duels_config_binding b2 WHERE b2.path_id = ${pathId}
           )
         )
    `.execute(trx);
  });
}

/** Una versione identica a quella data, senza legami: chi chiama li mette. */
async function copyVersion(
  trx: Database,
  pathId: number,
  source: { published: string | null; draft: string | null },
  author: string,
): Promise<number> {
  const copy = await sql<{ id: number }>`
    INSERT INTO stats.duels_config_version
      (path_id, published, published_at, published_by, draft, draft_at, draft_by)
    VALUES (${pathId}, ${source.published}, ${source.published === null ? null : sql`now()`},
            ${source.published === null ? null : author},
            ${source.draft}, ${source.draft === null ? null : sql`now()`},
            ${source.draft === null ? null : author})
    RETURNING id
  `.execute(trx);
  return copy.rows[0]?.id as number;
}

export type PublishSummary = {
  /** Quanti percorsi sono cambiati. */
  files: number;
  /** I moduli toccati, per dire a chi arriva. */
  modules: string[];
};

/**
 * Pubblica TUTTE le bozze, in una transazione sola.
 *
 * Tutte insieme e non una per volta: due file che si parlano — un menu e i
 * messaggi che nomina — pubblicati a distanza di secondi darebbero ai server
 * uno stato intermedio che nessuno ha mai voluto. O passa tutto, o non passa
 * niente.
 */
export async function publishConfigDrafts(db: Database, author: string): Promise<PublishSummary> {
  return db.transaction().execute(async (trx) => {
    const pending = await sql<{ id: number; path: string; draft: string }>`
      SELECT v.id, p.path, v.draft
        FROM stats.duels_config_version v
        JOIN stats.duels_config_path p ON p.id = v.path_id
       WHERE v.draft IS NOT NULL
       ORDER BY p.path
       FOR UPDATE OF v
    `.execute(trx);

    if (pending.rows.length === 0) return { files: 0, modules: [] };

    const ids = pending.rows.map((r) => r.id);

    // La cronologia si scrive PRIMA di spostare la bozza: se andasse dopo, un
    // guasto in mezzo lascerebbe una pubblicazione senza modo di tornare
    // indietro. Dentro la stessa transazione l'ordine non cambia il risultato,
    // ma cambia cosa si legge in questo file fra un anno.
    await sql`
      INSERT INTO stats.duels_config_revision (version_id, content, published_by)
      SELECT id, draft, ${author} FROM stats.duels_config_version
       WHERE id = ANY(${ids}::int[])
    `.execute(trx);

    await sql`
      UPDATE stats.duels_config_version
         SET published = draft, published_at = now(), published_by = ${author},
             draft = NULL, draft_at = NULL, draft_by = NULL
       WHERE id = ANY(${ids}::int[])
    `.execute(trx);

    const touched = await sql<{ module: string }>`
      SELECT DISTINCT module FROM stats.duels_config_binding
       WHERE version_id = ANY(${ids}::int[]) ORDER BY module
    `.execute(trx);

    return {
      files: new Set(pending.rows.map((r) => r.path)).size,
      modules: touched.rows.map((r) => r.module),
    };
  });
}

export type ConfigBundle = {
  module: string;
  /** L'impronta del contenuto: cambia solo se cambia un file. E' l'ETag. */
  version: string;
  files: Array<{ path: string; content: string }>;
};

/**
 * Cio' che un server di quel modulo deve scrivere sul disco.
 *
 * SOLO IL PUBBLICATO. Una bozza che finisse in un bundle sarebbe una modifica
 * mai confermata arrivata in produzione, cioe' l'esatto contrario del motivo
 * per cui bozza e pubblicato sono due colonne.
 *
 * L'IMPRONTA LA CALCOLA POSTGRES sui contenuti veri, invece di essere un
 * contatore che qualcuno incrementa. Un contatore si dimentica di crescere —
 * e allora i server restano indietro senza che nulla lo dica — oppure cresce
 * a vuoto, e allora ogni avvio riscarica tutto. Qui l'impronta non puo'
 * divergere dai dati perche' E' i dati.
 */
export async function readConfigBundle(db: Database, module: string): Promise<ConfigBundle> {
  const rows = await sql<{ path: string; content: string }>`
    SELECT p.path, v.published AS content
      FROM stats.duels_config_binding b
      JOIN stats.duels_config_version v ON v.id = b.version_id
      JOIN stats.duels_config_path p    ON p.id = b.path_id
     WHERE b.module = ${module} AND v.published IS NOT NULL
     ORDER BY p.path
  `.execute(db);

  const digest = await sql<{ version: string }>`
    SELECT coalesce(
      encode(sha256(convert_to(string_agg(p.path || E'\n' || v.published, E'\n' ORDER BY p.path), 'UTF8')), 'hex'),
      'vuoto'
    ) AS version
      FROM stats.duels_config_binding b
      JOIN stats.duels_config_version v ON v.id = b.version_id
      JOIN stats.duels_config_path p    ON p.id = b.path_id
     WHERE b.module = ${module} AND v.published IS NOT NULL
  `.execute(db);

  return {
    module,
    version: (digest.rows[0]?.version ?? 'vuoto').slice(0, 16),
    files: rows.rows,
  };
}
