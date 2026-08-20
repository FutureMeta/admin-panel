// I quattro lavori periodici, avviati insieme. §8.3, §10, §17
//
// Le cadenze vengono dal documento normativo: ancoraggio e verifica
// dell'integrita' giornalieri (§10), partizioni con largo anticipo (§17). La
// pulizia la decide il codice che esegue — vedi il commento sopra CLEANUP_MS.

import type { Logger } from 'pino';
import { ensurePartitions } from '#src/audit/partitions.ts';
import type { Database } from '#src/db/pool.ts';
import { anchorHeads, cleanupAbandoned, verifyChain } from './maintenance-jobs.ts';
import { JobRegistry, type RunningJob, startJob } from './scheduler.ts';

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;

/**
 * La pulizia gira ogni ora, non ogni giorno.
 *
 * La soglia dentro `cleanupAbandoned` e' 24 ore: un enrollment TOTP
 * abbandonato e' un segreto valido che nessuno sorveglia. Girando una volta al
 * giorno, quella soglia diventa in pratica «fra 24 e 48 ore», perche' dipende
 * da quanto manca al prossimo giro. Ogni ora la riporta a cio' che dice di
 * essere, e costa due DELETE indicizzate.
 */
const CLEANUP_MS = HOUR;

export type MaintenanceKeeper = {
  registry: JobRegistry;
  /**
   * `false` appena la verifica trova una partizione che non torna.
   *
   * NON torna `true` da sola. Una catena rotta e' un fatto storico: la
   * partizione compromessa esce dalla finestra di verifica dopo tre mesi, e
   * senza questa vischiosita' la metrica tornerebbe verde da sola, che e'
   * esattamente il modo in cui un allarme smette di essere un allarme.
   */
  chainOk: () => boolean;
  stop: () => void;
};

export function startMaintenance(opts: {
  db: Database;
  anchorKey: Buffer;
  anchorPath: string;
  logger: Logger;
  /**
   * Falso nei test: il keeper esiste, le metriche rispondono, ma nessun timer
   * parte. Senza, ogni suite lancerebbe ancoraggio e verifica contro il
   * proprio database effimero senza verificare niente in piu'.
   */
  enabled: boolean;
}): MaintenanceKeeper {
  const { db, anchorKey, anchorPath, logger } = opts;
  const registry = new JobRegistry();
  let chainOk = true;

  if (!opts.enabled) {
    return { registry, chainOk: () => chainOk, stop: () => undefined };
  }

  const running: RunningJob[] = [
    startJob(
      {
        name: 'partitions',
        intervalMs: DAY,
        retryMs: HOUR,
        run: async () => ({ partitions: (await ensurePartitions(db)).length }),
        successMessage: 'partizioni audit verificate',
        failureMessage: 'partizioni audit NON verificate: se scadono, ogni scrittura del pannello fallisce',
      },
      logger,
      registry,
    ),

    startJob(
      {
        name: 'anchor',
        intervalMs: DAY,
        retryMs: HOUR,
        run: () => anchorHeads(db, anchorKey, anchorPath),
        successMessage: 'teste di partizione ancorate',
        failureMessage: 'ancoraggio NON scritto: la catena resta verificabile solo contro se stessa',
      },
      logger,
      registry,
    ),

    startJob(
      {
        name: 'cleanup',
        intervalMs: CLEANUP_MS,
        retryMs: 15 * 60 * 1_000,
        run: () => cleanupAbandoned(db),
        successMessage: 'pulizia periodica eseguita',
        failureMessage: 'pulizia NON eseguita: restano segreti TOTP mai confermati e token scaduti',
      },
      logger,
      registry,
    ),

    startJob(
      {
        name: 'verify',
        intervalMs: DAY,
        retryMs: HOUR,
        run: async () => {
          const report = await verifyChain(db);
          if (!report.ok) {
            chainOk = false;
            // `fatal`, non `error`. Il §10 non ha niente di piu' grave da
            // segnalare: significa che qualcuno ha riscritto il registro
            // passando dal database, cioe' aggirando ogni difesa
            // dell'applicazione.
            //
            // Il processo NON viene abbattuto e la readiness non cambia: un
            // registro compromesso e' un fatto sull'integrita' dei dati, non
            // sulla capacita' di servire. Spegnere il pannello trasformerebbe
            // un allarme in un disservizio, e cancellerebbe la possibilita' di
            // leggere il registro proprio quando serve. La metrica
            // `metamc_audit_chain_ok` va agganciata all'alerting.
            logger.fatal(
              { job: 'verify', broken: report.broken },
              'CATENA AUDIT COMPROMESSA: il registro e` stato riscritto fuori dall`applicazione',
            );
          }
          return { checked: report.checked, ok: report.ok, broken: report.broken.length };
        },
        successMessage: 'integrita` della catena audit verificata',
        failureMessage: 'verifica dell`integrita` NON eseguita: una manomissione passerebbe inosservata',
      },
      logger,
      registry,
    ),
  ];

  return {
    registry,
    chainOk: () => chainOk,
    stop: () => {
      for (const job of running) job.stop();
    },
  };
}
