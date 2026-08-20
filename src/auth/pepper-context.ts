// Chi sta verificando la password, e con quale pepper. SEC-40
//
// PERCHE' UN CONTESTO IMPLICITO, che di norma e' una cattiva idea. better-auth
// chiama il nostro callback come `verify({ hash, password })` e non passa
// nient'altro: verificato empiricamente, non dedotto dal tipo. Non c'e' l'id
// dell'utente, quindi non c'e' modo di sapere con quale pepper quell'hash e'
// stato prodotto — e senza quel dato, ruotare il pepper significa invalidare
// tutti gli hash in un colpo solo.
//
// Le alternative, e perche' sono peggiori:
//
//   - provare il pepper corrente e poi i precedenti: raddoppia il costo di
//     Argon2 proprio sul percorso della password sbagliata, cioe' quello che
//     un attaccante controlla, e introduce una differenza di tempo fra utenti
//     migrati e non (SEC-30);
//   - mettere la versione dentro la PHC string: renderebbe la riga
//     auto-descrittiva, ma ignorerebbe la colonna `pepper_version` che esiste
//     gia' ed e' cio' che il runbook promette di usare.
//
// Il contesto si imposta in UN posto solo — il proxy di `/api/auth/*` — e
// copre le rotte che verificano una password esistente. Se manca, si usa il
// pepper CORRENTE: e' la scelta giusta oggi, perche' ogni riga esistente e'
// alla versione corrente, ed e' anche quella che non puo' chiudere fuori
// nessuno finche' non si ruota davvero.

import { AsyncLocalStorage } from 'node:async_hooks';

export type PepperSubject = {
  /** L'utente di cui si sta verificando la password. */
  userId: string;
  /** La versione del pepper con cui il suo hash e' stato prodotto. */
  pepperVersion: number;
};

const storage = new AsyncLocalStorage<PepperSubject>();

/** Esegue `fn` sapendo di chi e' la password che si sta per verificare. */
export function withPepperSubject<T>(subject: PepperSubject, fn: () => Promise<T>): Promise<T> {
  return storage.run(subject, fn);
}

/** Il soggetto corrente, se il chiamante lo ha dichiarato. */
export function currentPepperSubject(): PepperSubject | undefined {
  return storage.getStore();
}
