// SEC-28 — semaforo sugli hash Argon2 concorrenti.
//
// Il threadpool libuv (4 thread di default) e' condiviso da Argon2, `fs`,
// `dns.lookup` e `zlib`: e' la risorsa piu' contesa dell'intero sistema, e
// nessuna metrica standard la osserva. @fastify/under-pressure e'
// strutturalmente cieco su di essa, perche' misura event loop e memoria.
//
// Il semaforo NON accoda: rifiuta. Accodare sposterebbe soltanto la
// saturazione dalla CPU alla memoria, e con un tempo di attesa che il client
// non puo' distinguere da un blocco.
//
// Il conteggio e' esposto come condizione di readiness (§13).

export class Overloaded extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super('troppi hash in volo');
    this.name = 'Overloaded';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class HashSemaphore {
  readonly #limit: number;
  #inFlight = 0;
  #total = 0;
  #rejected = 0;
  #peak = 0;

  constructor(threadpoolSize: number) {
    // -2 lascia respiro a fs e dns, che condividono lo stesso pool. Con un
    // threadpool da 4 e nessun margine, un singolo picco di login bloccherebbe
    // anche la lettura di un file e la risoluzione DNS di Resend.
    this.#limit = Math.max(1, threadpoolSize - 2);
  }

  get limit(): number {
    return this.#limit;
  }
  get inFlight(): number {
    return this.#inFlight;
  }
  get stats(): { inFlight: number; limit: number; total: number; rejected: number; peak: number } {
    return {
      inFlight: this.#inFlight,
      limit: this.#limit,
      total: this.#total,
      rejected: this.#rejected,
      peak: this.#peak,
    };
  }

  /** true se il sistema e' sopra la soglia: usato dalla sonda di readiness. */
  get saturated(): boolean {
    return this.#inFlight >= this.#limit;
  }

  readonly #waiting: Array<() => void> = [];
  /**
   * Attesa massima per uno slot. Non e' una coda vera: e' il cuscinetto che
   * assorbe la corsa fra il controllo di saturazione fatto alla porta (il
   * ponte HTTP) e il momento in cui l'hash parte davvero. Senza, una raffica
   * produce eccezioni dentro l'handler di better-auth, che le trasforma in
   * 500 — e il 503 con Retry-After che SEC-28 prescrive non arriva mai al
   * client.
   */
  readonly #maxWaitMs = 2_000;

  /**
   * Esegue `fn` occupando uno slot. Attende brevemente se non ce ne sono, e
   * lancia `Overloaded` solo se l'attesa scade.
   *
   * Va usato ANCHE sul percorso hash-esca (utente inesistente): se l'esca
   * girasse senza semaforo, un attaccante saprebbe di aver trovato un'email
   * valida ogni volta che riceve 503 invece di 401 — l'oracolo di timing
   * tornerebbe dalla finestra.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#inFlight >= this.#limit) {
      const entrato = await this.#attendiSlot();
      if (!entrato) {
        this.#rejected += 1;
        throw new Overloaded(1);
      }
    }
    this.#inFlight += 1;
    this.#total += 1;
    if (this.#inFlight > this.#peak) this.#peak = this.#inFlight;
    try {
      return await fn();
    } finally {
      this.#inFlight -= 1;
      this.#waiting.shift()?.();
    }
  }

  #attendiSlot(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let risolto = false;
      const timer = setTimeout(() => {
        if (risolto) return;
        risolto = true;
        const i = this.#waiting.indexOf(sveglia);
        if (i >= 0) this.#waiting.splice(i, 1);
        resolve(false);
      }, this.#maxWaitMs);

      const sveglia = () => {
        if (risolto) return;
        risolto = true;
        clearTimeout(timer);
        resolve(true);
      };
      this.#waiting.push(sveglia);
    });
  }
}
