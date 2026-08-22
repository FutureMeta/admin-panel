// L'avvio dell'ingestione dei duels, accanto agli altri lavori periodici.
//
// TRENTA SECONDI, non i cinque minuti che la specifica proponeva. La decisione
// e' del 22 agosto 2026 e sostituisce il §1.4: una valutazione lasciata da un
// giocatore deve comparire nel pannello mentre lo staff sta ancora guardando
// quella partita, non al giro dopo la pausa caffe'.
//
// CHE COSTA TRENTA SECONDI. A regime un ciclo legge qualche decina di righe
// per chiave primaria e finisce in millisecondi: e' il RECUPERO che va tenuto
// a bada, ed e' per quello che c'e' il budget dentro `runDuelsIngest`. Dopo un
// fermo di ore l'arretrato si smaltisce su cicli consecutivi, cinque secondi
// per volta, invece che in una corsa unica che tiene occupato un database che
// non e' nostro.
//
// RISORSE PROPRIE, come per il campionamento: pool Postgres separato, pool
// MySQL separato, timeout propri. Il vincolo e' esplicito e vale la pena
// ripeterlo: il job non deve poter rallentare il pannello. Se una lettura
// verso il MySQL del gioco occupasse una delle connessioni che reggono i
// login, si vedrebbe come un login che non arriva — e nessuno andrebbe a
// cercare la causa in un'importazione di partite.

import type { Logger } from 'pino';
import { createKysely, createPool, type Database } from '#src/db/pool.ts';
import type { JobRegistry, RunningJob } from '#src/jobs/scheduler.ts';
import { startJob } from '#src/jobs/scheduler.ts';
import { runDuelsIngest } from './ingest.ts';
import { createDuelsMysql, type DuelsMysql, missingSourceColumns } from './mysql.ts';
import { type DuelsWarmDeps, type DuelsWarmResult, warmDuelsLive } from './warm.ts';

/** La cadenza, che e' anche quella con cui il browser richiede. */
export const DUELS_INTERVAL_MS = 30_000;

export type DuelsIngestOptions = {
  /** Il ruolo che scrive su `stats`: `metamc_ingest`, mai `metamc_app`. */
  databaseUrl: string;
  /** Il MySQL del gioco, in sola lettura. */
  mysqlUrl: string;
  logger: Logger;
  registry: JobRegistry;
  /** Falso nei test: si costruisce tutto e si chiama `runOnce` a mano. */
  schedule?: boolean;
  /**
   * La connessione al MySQL, per i test.
   *
   * Senza questa cucitura l'unico modo di provare che il job sia davvero
   * REGISTRATO sarebbe puntare un test al database del gioco, che e' vietato.
   * E un job scritto ma mai registrato e' precisamente la classe di difetto
   * che questo pannello insegue: si legge nel codice e si da' per fatto.
   */
  mysql?: DuelsMysql;
  /**
   * Cosa serve per riscaldare la fetta viva, se la si vuole riscaldare.
   *
   * NON E' UN SECONDO TIMER, ed e' il punto: lo stesso ciclo che ingerisce
   * ricostruisce il payload del 24h e lo scrive su Valkey. Assente — nei test
   * dell'ingestione, per esempio — il ciclo ingerisce e basta, e i payload si
   * costruiscono alla prima richiesta.
   */
  warm?: DuelsWarmDeps;
};

export type DuelsIngest = {
  db: Database;
  my: DuelsMysql;
  /** Un ciclo, per i test e per il comando a mano. */
  runOnce: () => Promise<Record<string, unknown>>;
  stop: () => Promise<void>;
};

export async function startDuelsIngest(opts: DuelsIngestOptions): Promise<DuelsIngest> {
  const pool = createPool({
    connectionString: opts.databaseUrl,
    // Due: una che lavora e una di riserva. Il ciclo e' sequenziale.
    max: 2,
    applicationName: 'metamc-duels-ingest',
    // Piu' dei 5s del campionamento: un lotto di recupero scrive fino a
    // diecimila righe aggregate in una transazione sola. Meno dei 120s del
    // backfill: qui un giro che dura mezzo minuto ha gia' mangiato la
    // cadenza, e va interrotto invece di accavallarsi al successivo.
    statementTimeout: '20s',
    searchPath: 'stats, public',
  });
  const db = createKysely(pool);
  const my = opts.mysql ?? createDuelsMysql(opts.mysqlUrl);

  // Si prova la connessione SUBITO e lo si dice.
  //
  // Un MySQL irraggiungibile non tiene giu' il pannello — lo storico gia'
  // ingerito continua a disegnarsi e le schermate dichiarano da quando sono
  // ferme — ma dev'essere una riga di log all'avvio, non una scoperta fatta
  // settimane dopo davanti a un grafico che si e' fermato in un giorno
  // qualunque.
  try {
    await my.rows('SELECT 1');
    const cap = my.cap();
    if (cap === 'none') {
      // Nessuna delle due variabili esiste: si legge lo stesso, ma una query
      // fuori controllo su una macchina che non e' nostra non ha piu' niente
      // che la fermi lato server. Va detto forte, non nascosto in un info.
      opts.logger.warn(
        { job: 'duels-ingest', cap },
        'nessun tetto di esecuzione lato server: il database del gioco non conosce ne` max_execution_time ne` max_statement_time',
      );
    } else {
      opts.logger.info({ job: 'duels-ingest', cap }, 'MySQL del gioco raggiungibile');
    }

    // LE COLONNE SI CHIEDONO UNA VOLTA SOLA, E ALL'AVVIO.
    //
    // Non cambia niente in base alla risposta — quello sarebbe `hasColumn` a
    // runtime, che e' fra le cose da non replicare. Serve a non scoprire le
    // colonne mancanti UNA PER DEPLOY: e' esattamente cosi' che sono usciti
    // `max_execution_time` e `duels_mode.color`, uno per riavvio.
    const missing = await missingSourceColumns(my);
    if (missing.length > 0) {
      opts.logger.error(
        { job: 'duels-ingest', mancanti: missing },
        'la sorgente non ha tutto cio` che l`ingestione legge: ogni ciclo fallira` finche` non si allinea',
      );
    }
  } catch (err) {
    opts.logger.error(
      { job: 'duels-ingest', err },
      'MySQL del gioco NON raggiungibile: le schermate duels resteranno allo storico gia` importato',
    );
  }

  /**
   * L'ora dell'ultima ricostruzione della fetta viva.
   *
   * Serve perche' la finestra del 24h SCORRE: anche senza una partita nuova,
   * allo scoccare dell'ora la piu' vecchia esce e il payload cambia. Senza
   * questo, in una notte tranquilla il grafico resterebbe fermo su ventiquattro
   * ore che non sono piu' le ultime ventiquattro.
   */
  let warmedHour = -1;

  const runOnce = async (): Promise<Record<string, unknown>> => {
    const res = await runDuelsIngest(db, my);
    if (res.contended) {
      // Quasi sempre e' il backfill lanciato a mano, ed e' una condizione
      // legittima che passa da sola. Se resta accesa senza che nessuno abbia
      // lanciato niente, allora c'e' un secondo pannello vivo.
      opts.logger.warn(
        { job: 'duels-ingest' },
        'un altro ingeritore sta scrivendo: il lotto e` tornato indietro, si riprende al giro dopo',
      );
    }
    // SI RICOSTRUISCE SOLO SE QUALCOSA E' CAMBIATO. `builtAt` sta nel payload,
    // quindi rifarne uno identico ne cambia l'ETag, e un ETag nuovo fa
    // riscaricare tutto a ogni schermata aperta invece di farle rispondere
    // 304. In una notte senza partite non si ricostruisce niente, e le
    // schermate continuano a ricevere trentaquattro byte a richiesta.
    const hour = Math.floor(Date.now() / 3_600_000);
    const changed = res.matches > 0 || res.ratings > 0;
    let warmed: DuelsWarmResult | null = null;
    if (opts.warm && (changed || hour !== warmedHour)) {
      try {
        warmed = await warmDuelsLive(opts.warm);
        warmedHour = hour;
      } catch (err) {
        // L'ingestione e' riuscita: il dato c'e', e' il payload pronto che
        // manca. Non si fa fallire il giro — il watermark si e' mosso e
        // ripeterlo non recupererebbe niente — ma lo si dice forte, perche'
        // una schermata ferma senza una riga di log si scopre tardi.
        opts.logger.error(
          { job: 'duels-ingest', err },
          'payload duels non ricostruito: le schermate serviranno numeri vecchi finche` non li chiede qualcuno',
        );
      }
    }

    return {
      partite: res.matches,
      valutazioni: res.ratings,
      degradate: res.degraded,
      indietro: res.behind,
      conteso: res.contended,
      scaldati: warmed?.payloads ?? 0,
      rimandati: warmed?.deferred ?? 0,
      ms: res.ms,
    };
  };

  const jobs: RunningJob[] = [];
  if (opts.schedule !== false) {
    jobs.push(
      startJob(
        {
          name: 'duels-ingest',
          intervalMs: DUELS_INTERVAL_MS,
          // Stessa attesa: un giro fallito qui non lascia un buco da riempire
          // — il watermark non si e' mosso — quindi ritentare prima non
          // recupera niente e aggiunge solo pressione su un database altrui.
          retryMs: DUELS_INTERVAL_MS,
          // NESSUN `alignMs`, a differenza del campionamento. La' i tick
          // devono cadere sui multipli perche' un invariante conta gli slot
          // mai tentati su una griglia; qui la ripresa e' un watermark, e uno
          // scarto di qualche millisecondo non significa niente.
          run: runOnce,
          successMessage: 'ciclo di ingestione duels',
          failureMessage:
            'ingestione duels ferma: le schermate continueranno a mostrare lo storico gia` importato e a dichiarare da quando',
        },
        opts.logger,
        opts.registry,
      ),
    );
  }

  return {
    db,
    my,
    runOnce,
    stop: async () => {
      for (const job of jobs) job.stop();
      await my.close().catch(() => undefined);
      await db.destroy().catch(() => undefined);
    },
  };
}
