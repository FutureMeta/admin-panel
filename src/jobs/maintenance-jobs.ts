// I corpi dei lavori periodici. §8.3, §10
//
// Stavano dentro `scripts/maintenance.ts`, che li stampava su stdout per un
// cron. Da qui li chiamano due committenti: lo scheduler in-process e lo
// stesso script, che resta come modo di lanciarli a mano — utile quando si sta
// indagando e non si vuole aspettare il giro successivo.
//
// Nessuno di questi scrive su console: restituiscono cosa e' successo, e chi
// li chiama decide se diventa una riga di log o una riga di terminale.

import { appendFileSync } from 'node:fs';
import { buildAnchors, markAnchored, verifyRecent } from '#src/audit/integrity.ts';
import type { Database } from '#src/db/pool.ts';

/**
 * §10 — ancoraggio esterno.
 *
 * Scrive l'hash di testa di ogni partizione, firmato, in un file destinato a
 * uno storage append-only FUORI dal database. Se l'ancoraggio vivesse nello
 * stesso database che deve verificare, chi puo' riscrivere l'uno puo'
 * riscrivere l'altro, e la catena tornerebbe coerente sulla storia riscritta.
 *
 * Il file locale e' il primo passo, non l'ultimo: portarlo fuori dalla
 * macchina resta una decisione infrastrutturale di chi gestisce il server.
 * Finche' vive qui, protegge da chi tocca il database ma non da chi ha la
 * macchina intera.
 */
export async function anchorHeads(
  db: Database,
  key: Buffer,
  destination: string,
): Promise<{ anchored: number; destination: string }> {
  const anchors = await buildAnchors(db, key);
  if (anchors.length === 0) return { anchored: 0, destination };

  // `appendFileSync` e non `writeFileSync` con flag: l'intenzione e'
  // aggiungere, e va detta dal nome della funzione.
  const lines = anchors.map((a) => JSON.stringify(a)).join('\n');
  appendFileSync(destination, `${lines}\n`);

  // Solo DOPO che i byte sono su disco: se il processo muore fra le due, al
  // giro successivo la partizione viene riancorata: una riga in piu' nel file
  // e' un problema molto piu' piccolo di una partizione segnata come ancorata
  // e mai scritta.
  await markAnchored(
    db,
    anchors.map((a) => a.partitionKey),
  );

  return { anchored: anchors.length, destination };
}

/**
 * §8.3 — enrollment TOTP mai confermati e token di verifica scaduti.
 *
 * Una riga `twoFactor` di un utente rimasto `pending_onboarding` e' un segreto
 * TOTP valido che nessuno ha mai usato: dopo 24 ore va via. I token di
 * verifica scaduti non sono pericolosi — la scadenza sta nella WHERE di ogni
 * consumo — ma non servono a niente.
 */
export async function cleanupAbandoned(
  db: Database,
): Promise<{ enrollments: number; verifications: number }> {
  const threshold = new Date(Date.now() - 24 * 3600_000);

  const abandoned = await db
    .deleteFrom('auth.twoFactor')
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('auth.user as u')
          .select('u.id')
          .whereRef('u.id', '=', 'auth.twoFactor.userId')
          .where('u.status', '=', 'pending_onboarding')
          .where('u.createdAt', '<', threshold),
      ),
    )
    .returning('id')
    .execute();

  const expired = await db
    .deleteFrom('auth.verification')
    .where('expiresAt', '<', new Date())
    .returning('id')
    .execute();

  return { enrollments: abandoned.length, verifications: expired.length };
}

export type ChainReport = {
  ok: boolean;
  checked: number;
  /** Le partizioni che non tornano, con il dettaglio del primo scarto. */
  broken: Array<{ partitionKey: string; detail: string | null }>;
};

/** §10 — ricalcola la catena della partizione corrente e delle due precedenti. */
export async function verifyChain(db: Database): Promise<ChainReport> {
  const verdicts = await verifyRecent(db);
  const broken = verdicts
    .filter((v) => !v.ok)
    .map((v) => ({ partitionKey: v.partitionKey, detail: v.detail }));
  return { ok: broken.length === 0, checked: verdicts.length, broken };
}
