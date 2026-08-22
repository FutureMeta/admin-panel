// Da «com'e' adesso» e «come lo vuole chi salva» a «cosa scrivere».
//
// PERCHE' E' UNA FUNZIONE PURA E NON DELL'SQL. Le regole che contano qui non
// sono di database: sono di significato. Una riga assente vuol dire «default»,
// quindi riportare un setting al default e' una DELETE e non una UPDATE; un
// valore che non e' cambiato non va riscritto; e una riga che non conosciamo
// non e' una riga da cancellare. Sbagliarne una non produce un errore — produce
// una tabella del gioco leggermente diversa da quella che qualcuno ha chiesto,
// e lo si scopre al riavvio di un server.
//
// Separandole dall'esecuzione si provano tutte senza un MySQL, e cio' che
// resta da eseguire e' abbastanza sottile da guardarlo e capirlo.

import { isDefaultValue, type SettingSpec } from './settings.ts';

export type SettingPlan = {
  /** Righe da scrivere: `INSERT ... ON DUPLICATE KEY UPDATE`. */
  upserts: Array<{ key: string; value: string }>;
  /** Righe da togliere, perche' il valore e' tornato al default. */
  deletes: string[];
};

/**
 * Cosa cambiare nella tabella dei settings.
 *
 * `current` sono le righe che ci sono ORA; `desired` i valori scelti nella
 * schermata. Un setting assente da `desired` non e' stato toccato: vale quello
 * che vale oggi, e non compare nel piano.
 *
 * LE CHIAVI CHE NON CONOSCIAMO NON SI TOCCANO. Se il database porta un setting
 * che il registro non ha — una versione del plugin piu' nuova di questo
 * pannello — cancellarlo sarebbe togliere una configurazione che qualcuno ha
 * messo apposta, mentre il pannello si limita a non saperla disegnare. Le due
 * cose sono molto diverse e solo la seconda e' onesta.
 */
export function planSettings(
  specs: readonly SettingSpec[],
  current: ReadonlyMap<string, string>,
  desired: ReadonlyMap<string, string>,
): SettingPlan {
  const upserts: Array<{ key: string; value: string }> = [];
  const deletes: string[] = [];

  for (const spec of specs) {
    const wanted = desired.get(spec.key);
    if (wanted === undefined) continue;

    const existing = current.get(spec.key);

    if (isDefaultValue(spec, wanted)) {
      // Torna al default: la riga se ne va. Scriverci sopra il valore di
      // default lascerebbe una riga che dice quello che direbbe il silenzio, e
      // il giorno in cui il plugin cambia quel default questa modalita' non lo
      // seguirebbe.
      if (existing !== undefined) deletes.push(spec.key);
      continue;
    }

    // Niente riscritture inutili: `1.0` e `1` sono lo stesso valore, e
    // riscriverlo sporcherebbe il registro di audit di modifiche che non
    // hanno cambiato niente.
    if (existing !== undefined && sameValue(spec, existing, wanted)) continue;

    upserts.push({ key: spec.key, value: wanted });
  }

  return { upserts, deletes };
}

function sameValue(spec: SettingSpec, a: string, b: string): boolean {
  if (spec.kind === 'int' || spec.kind === 'double') return Number(a) === Number(b);
  return a === b;
}

export type SetPlan<T> = { add: T[]; remove: T[] };

/**
 * Cosa cambiare in una tabella di appartenenza: modalita' di una mappa, event
 * type di una mappa.
 *
 * SI CALCOLA UNA DIFFERENZA, non si cancella tutto e si riscrive. «DELETE poi
 * INSERT» e' piu' corto da scrivere e dice una cosa falsa al database: ogni
 * salvataggio toglierebbe e rimetterebbe righe che nessuno ha toccato, e su
 * una tabella con chiavi esterne in cascata quella e' una finestra in cui
 * qualcos'altro puo' vedere lo stato vuoto.
 */
export function planSet<T extends string | number>(current: readonly T[], desired: readonly T[]): SetPlan<T> {
  const has = new Set<T>(current);
  const wants = new Set<T>(desired);
  return {
    add: [...wants].filter((v) => !has.has(v)),
    remove: [...has].filter((v) => !wants.has(v)),
  };
}

/** Il piano non chiede niente al database. */
export function isEmptySettingPlan(plan: SettingPlan): boolean {
  return plan.upserts.length === 0 && plan.deletes.length === 0;
}

export function isEmptySetPlan<T extends string | number>(plan: SetPlan<T>): boolean {
  return plan.add.length === 0 && plan.remove.length === 0;
}
