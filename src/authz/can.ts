// §7 — UNICO punto di enforcement.
//
// `can()` legge esclusivamente i permessi effettivi risolti in AuthzContext.
// Non legge la sessione, non legge nomi di ruolo, non interroga il database.
// Se un giorno una decisione di autorizzazione dovesse guardare qualcos'altro,
// va aggiunta qui e in nessun altro posto — la guardia di CI
// (scripts/check-guards.ts) fallisce la build se ci si prova altrove.

import type { AuthzContext } from './context.ts';
import type { Level, ModuleKey, RequiredLevel } from './modules.ts';

export function levelOf(actor: AuthzContext, module: ModuleKey): Level {
  return actor.permissions[module] ?? 0;
}

export function can(actor: AuthzContext, module: ModuleKey, level: RequiredLevel): boolean {
  return levelOf(actor, module) >= level;
}

/** Errore di autorizzazione. La rotta lo traduce nella risposta giusta. */
export class Forbidden extends Error {
  readonly module: ModuleKey;
  readonly required: RequiredLevel;
  readonly had: Level;

  constructor(module: ModuleKey, required: RequiredLevel, had: Level) {
    // Nessun dettaglio nel messaggio esposto al client: il messaggio serve ai
    // log. La risposta HTTP la costruisce il gestore d'errore, che per SEC-31
    // deve restituire lo stesso status di una risorsa inesistente.
    super(`autorizzazione negata su ${module}: richiesto ${required}, disponibile ${had}`);
    this.name = 'Forbidden';
    this.module = module;
    this.required = required;
    this.had = had;
  }
}

/** Variante che lancia. E' quella che gli handler usano quasi sempre. */
export function require(actor: AuthzContext, module: ModuleKey, level: RequiredLevel): void {
  if (!can(actor, module, level)) {
    throw new Forbidden(module, level, levelOf(actor, module));
  }
}

/**
 * I moduli visibili nella sidebar. §frontend: si mostrano SOLO quelli a cui
 * l'utente ha accesso — nessuna voce disabilitata, nessun lucchetto, perche'
 * l'elenco stesso dei moduli e' informazione.
 */
export function visibleModules(actor: AuthzContext): ModuleKey[] {
  return (Object.keys(actor.permissions) as ModuleKey[])
    .filter((m) => (actor.permissions[m] ?? 0) >= 1)
    .sort();
}
