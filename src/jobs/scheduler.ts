// I lavori periodici del pannello, tenuti dal processo che protegge. §10, §17
//
// PERCHE' NON UN CRON, di nuovo. La scelta era gia' stata fatta per le
// partizioni e vale identica per gli altri tre: un cron esterno regge finche'
// qualcuno lo configura e finche' nessuno ricostruisce la macchina
// dimenticandosene. E' una dipendenza che non si vede leggendo il repository
// e che si scopre rotta il giorno del guasto. Qui il lavoro vive accanto alla
// cosa che protegge: se gira il pannello, girano i job.
//
// Il prezzo va detto: se il processo e' fermo, i job non girano. Per
// l'ancoraggio e la pulizia non e' un problema — a processo fermo non si
// scrive niente da ancorare e non nascono enrollment da ripulire — e al
// riavvio la prima cosa che ognuno fa e' recuperare.
//
// ISTANZA SINGOLA. Il §1.2 fissa una sola istanza, quindi non serve elezione
// del leader. Se un domani diventassero due, il punto in cui prendere un lock
// e' qui dentro, in `run()`, prima di chiamare `job.run`: basta un
// `pg_try_advisory_lock` con un id per nome di job, e chi non lo ottiene salta
// il giro. Non lo implemento adesso perche' un lock che nessuno esercita e'
// codice che nessuno verifica.

import type { Logger } from 'pino';

/** Esito di un giro, per il registro che alimenta /internal/metrics. */
export type JobState = {
  /** Millisecondi epoch dell'ultimo successo, 0 se non e' mai riuscito. */
  lastSuccessAt: number;
  /** Millisecondi epoch dell'ultimo fallimento, 0 se non e' mai fallito. */
  lastFailureAt: number;
  /** Fallimenti dall'avvio del processo. */
  failures: number;
  /** Giri completati con successo dall'avvio. */
  successes: number;
};

export type JobDefinition = {
  /** Nome esposto nelle metriche e nei log. Minuscolo, senza spazi. */
  name: string;
  /** Intervallo a regime. */
  intervalMs: number;
  /**
   * Attesa dopo un fallimento. Piu' corta dell'intervallo: un lavoro che non
   * e' riuscito e' una cosa da risolvere, non da rimandare al giro dopo.
   */
  retryMs: number;
  /** Il lavoro. Cio' che restituisce finisce nel log come contesto. */
  run: () => Promise<Record<string, unknown>>;
  /** Messaggio quando va bene. */
  successMessage: string;
  /** Messaggio quando fallisce: deve dire la CONSEGUENZA, non «errore». */
  failureMessage: string;
};

export type RunningJob = { stop: () => void };

/**
 * Il registro degli stati, condiviso con /internal/metrics.
 *
 * Un job che fallisce in silenzio e' peggio di un job che non esiste: chi
 * legge il codice lo vede scritto e lo da' per fatto. Qui ogni giro lascia una
 * traccia interrogabile da fuori.
 */
export class JobRegistry {
  readonly #states = new Map<string, JobState>();

  state(name: string): JobState {
    const existing = this.#states.get(name);
    if (existing) return existing;
    const fresh: JobState = { lastSuccessAt: 0, lastFailureAt: 0, failures: 0, successes: 0 };
    this.#states.set(name, fresh);
    return fresh;
  }

  entries(): Array<[string, JobState]> {
    return [...this.#states.entries()].sort(([a], [b]) => a.localeCompare(b));
  }
}

/**
 * Avvia un lavoro periodico. Parte SUBITO, poi si ripianifica da solo.
 *
 * Non lancia mai e non blocca l'avvio del server: un guasto qui non deve
 * impedire al pannello di rispondere alle sonde e servire le letture.
 */
export function startJob(job: JobDefinition, logger: Logger, registry: JobRegistry): RunningJob {
  const state = registry.state(job.name);
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const run = async (): Promise<void> => {
    if (stopped) return;
    let delay = job.intervalMs;
    try {
      const context = await job.run();
      state.lastSuccessAt = Date.now();
      state.successes += 1;
      logger.info({ job: job.name, ...context }, job.successMessage);
    } catch (err) {
      delay = job.retryMs;
      state.lastFailureAt = Date.now();
      state.failures += 1;
      logger.error({ job: job.name, err }, job.failureMessage);
    }
    if (stopped) return;
    // `unref` perche' questo timer non e' un motivo per tenere in piedi il
    // processo: se non resta altro da fare, Node deve poter uscire, e lo
    // spegnimento del §13 non deve restare appeso.
    timer = setTimeout(() => void run(), delay);
    timer.unref();
  };

  void run();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
