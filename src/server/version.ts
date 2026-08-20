// Quale commit sta girando. §17
//
// PERCHE' ESISTE. Due volte di fila un rilascio non ha attecchito e ce ne
// siamo accorti dal comportamento: prima perche' il clone era rimasto su un
// branch vecchio, poi perche' non era chiaro se il riavvio fosse avvenuto dopo
// il push. In entrambi i casi la domanda era la stessa — «quale versione sta
// girando?» — e il pannello non sapeva rispondere.
//
// Si legge da `.git`, senza lanciare `git`: il processo gira in un container
// dove non e' detto che il binario ci sia, e comunque avviare un processo per
// una stringa che sta in un file e' lavoro sprecato.
//
// Se `.git` non c'e' — un'immagine costruita da un COPY, per esempio — la
// risposta e' `null`. Non e' un errore: e' un'installazione che non e' un
// clone, e dirlo e' meglio che inventare un valore.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Il commit su cui gira questo processo, in forma breve. `null` se non e' un clone. */
export function currentCommit(root: string = process.cwd()): string | null {
  try {
    const head = readFileSync(join(root, '.git', 'HEAD'), 'utf8').trim();

    // HEAD detached: contiene direttamente lo sha.
    if (/^[0-9a-f]{40}$/i.test(head)) return head.slice(0, 7);

    const ref = /^ref:\s*(.+)$/.exec(head)?.[1];
    if (!ref) return null;

    // Il caso normale: il ref ha il suo file.
    try {
      const sha = readFileSync(join(root, '.git', ...ref.split('/')), 'utf8').trim();
      if (/^[0-9a-f]{40}$/i.test(sha)) return sha.slice(0, 7);
    } catch {
      // Il ref puo' essere impacchettato: dopo un `git gc` i file singoli
      // spariscono e restano tutti dentro `packed-refs`.
    }

    const packed = readFileSync(join(root, '.git', 'packed-refs'), 'utf8');
    for (const line of packed.split('\n')) {
      const [sha, name] = line.trim().split(/\s+/);
      if (name === ref && sha && /^[0-9a-f]{40}$/i.test(sha)) return sha.slice(0, 7);
    }
    return null;
  } catch {
    return null;
  }
}

/** Il branch su cui gira, quando HEAD non e' detached. */
export function currentBranch(root: string = process.cwd()): string | null {
  try {
    const head = readFileSync(join(root, '.git', 'HEAD'), 'utf8').trim();
    return /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1] ?? null;
  } catch {
    return null;
  }
}
