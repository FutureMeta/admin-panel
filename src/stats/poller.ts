// Il ciclo di campionamento. Fase 2, passo 2.
//
// Legge l'insieme online, deduplica per `player_id`, conta per SERVER e
// scrive una riga di registro piu' le righe del grezzo. Niente sessioni,
// niente geolocalizzazione, niente filtro sui fantasmi: quelli sono passi
// successivi, e questo deve stare in piedi da solo per 48 ore prima che ne
// valga la pena aggiungerne.
//
// NIENTE BACKOFF SUGLI SLOT, ed e' una correzione consapevole al materiale di
// progetto. Il documento prevedeva un circuit breaker che allungasse
// l'intervallo fino a 300 s con Redis giu'. Ma la griglia di lettura si regge
// su una distinzione precisa: «Redis giu' un'ora produce 120 righe failed,
// Postgres giu' un'ora produce 120 slot mancanti». Con il backoff, un'ora di
// Redis giu' produrrebbe una ventina di righe e ottanta slot MANCANTI — cioe'
// il guasto di Redis si travestirebbe da guasto di Postgres, e l'invariante
// che conta i buchi diventerebbe illeggibile. Ogni slot si tenta e ogni slot
// lascia la sua riga.
//
// Cio' che va davvero smorzato e' il LOG: 2.880 cicli al giorno moltiplicano
// tutto, e un Redis giu' per una notte scriverebbe migliaia di righe identiche.
// Si registra una riga per TRANSIZIONE di stato, piu' un riassunto ogni 60
// cicli.

import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { Database } from '#src/db/pool.ts';
import type { CountryLookup } from '#src/geo/reader.ts';
import { type OnlinePlayer, readOnline } from './game-redis.ts';
import {
  type CycleRow,
  type IngestSettings,
  readSettings,
  type ServerCount,
  ServerDictionary,
  TRANSIT_SERVER_ID,
  writeCycle,
} from './ingest.ts';
import { SessionTracker } from './sessions.ts';

/** Oltre questo il ciclo ha sforato il proprio slot e va chiuso. */
const CYCLE_BUDGET_MS = 8_000;
/** Quanti cicli non scritti tenere in memoria mentre Postgres non c'e'. */
const PENDING_MAX = 20;
/** Ogni quanti cicli pagare il controincrocio e rinfrescare `last_seen_at`. */
const SLOW_EVERY = 20;
/** Quante chiavi campionare per il PTTL. */
const TTL_SAMPLE = 50;
/** Riassunto periodico, per non lasciare il log muto quando va tutto bene. */
const SUMMARY_EVERY = 60;
/** Oltre 24 ore, `connection-time` non e' skew: e' un dato sporco. */
const MAX_SKEW_S = 24 * 60 * 60;
/** Quante righe `skipped` scrivere al massimo per un buco. */
const MAX_SKIPPED_ROWS = 20;

export type PollerOptions = {
  db: Database;
  redis: Redis;
  logger: Logger;
  /** Il pattern delle chiavi dell'insieme online. */
  pattern: string;
  /**
   * La risoluzione geografica. Assente = geolocalizzazione spenta, e il
   * paese resta null su ogni riga invece di diventare XX: sono due cose
   * diverse, e il payload deve poterle distinguere.
   */
  countryOf?: CountryLookup;
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? null;
}

export class StatsPoller {
  /** Cambia a ogni riavvio: e' cosi' che si individuano i riavvii nel registro. */
  readonly #runId = randomUUID();
  readonly #opts: PollerOptions;
  readonly #dictionary = new ServerDictionary();
  readonly #sessions = new SessionTracker();
  // `geoEnabled: false` come default: la geolocalizzazione si accende solo
  // quando il database lo dice, mai per assenza di informazione.
  #settings: IngestSettings = {
    nominalDeltaS: 30,
    maxDeltaS: 60,
    graceTicks: 3,
    reaperAfterS: 900,
    geoEnabled: false,
  };

  /** L'ultimo tick RIUSCITO: e' da qui che si misura la copertura. */
  #lastOkTickAt: number | null = null;
  /** L'ultimo tick TENTATO in questo processo: serve a riconoscere gli slot saltati. */
  #lastAttemptAt: number | null = null;
  /** Chi c'era al giro prima: i nuovi arrivati sono la sola popolazione su cui lo skew ha senso. */
  #previousIds = new Set<number>();
  /** Cicli che Postgres non ha accettato. Cap rigido: oltre, si perdono e si vede. */
  readonly #pending: Array<{ cycle: CycleRow; samples: ServerCount[] }> = [];

  #healthy = true;
  #cycles = 0;

  constructor(opts: PollerOptions) {
    this.#opts = opts;
  }

  get runId(): string {
    return this.#runId;
  }
  /** Le sessioni aperte: il reaper e le metriche passano da qui. */
  get sessions(): SessionTracker {
    return this.#sessions;
  }

  /** Le impostazioni lette all'avvio: chi cabla ha bisogno di dirle nel log. */
  get settings(): IngestSettings {
    return this.#settings;
  }

  /**
   * Chiude le sessioni che nessun tick mostra piu'.
   *
   * La grazia copre i buchi brevi; questo copre il caso in cui il giocatore e'
   * sparito e nessuno lo ha piu' visto — tipicamente perche' il pannello era
   * fermo. Gira come job a se' perche' deve girare anche quando il
   * campionamento non riesce: e' proprio allora che serve.
   */
  async reapSessions(now = new Date()): Promise<Record<string, unknown>> {
    const closed = await this.#sessions.reap(this.#opts.db, now);
    return { chiuse: closed, inCorso: this.#sessions.openCount };
  }
  get intervalMs(): number {
    return this.#settings.nominalDeltaS * 1_000;
  }

  /** Carica parametri e dizionario. Va chiamata prima del primo ciclo. */
  async start(): Promise<void> {
    this.#settings = await readSettings(this.#opts.db);
    await this.#dictionary.load(this.#opts.db);
    await this.#sessions.load(this.#opts.db, {
      graceTicks: this.#settings.graceTicks,
      reaperAfterS: this.#settings.reaperAfterS,
    });
  }

  /**
   * Un ciclo. Non lancia per un guasto di Redis: scrive `failed` e torna.
   *
   * Lancia solo quando non e' riuscito a SCRIVERE, perche' quello e' l'unico
   * caso in cui non resta traccia da nessuna parte e il chiamante deve saperlo.
   */
  async runOnce(now = Date.now()): Promise<Record<string, unknown>> {
    const align = this.intervalMs;
    const tickMs = Math.floor(now / align) * align;
    const tickAt = new Date(tickMs);
    const started = Date.now();
    this.#cycles += 1;

    const skipped = this.#slotsSkipped(tickMs, align);
    this.#lastAttemptAt = tickMs;

    const controller = new AbortController();
    const budget = setTimeout(() => controller.abort(), CYCLE_BUDGET_MS);

    let read: Awaited<ReturnType<typeof readOnline>> | undefined;
    let errorKind: string | null = null;
    try {
      read = await readOnline(this.#opts.redis, {
        pattern: this.#opts.pattern,
        signal: controller.signal,
        ttlSample: TTL_SAMPLE,
        withServersCrosscheck: this.#cycles % SLOW_EVERY === 1,
        // DUE CONDIZIONI, non una. `countryOf` esiste se e' configurato un
        // file .mmdb; `geoEnabled` dice che qualcuno ha VERIFICATO, con la
        // sonda del passo 0, che il campo dell'indirizzo sia del giocatore e
        // non del proxy. Senza la seconda, un proxy Velocity farebbe risolvere
        // ogni giocatore sul datacenter: 95% da un paese solo, I5 verde, XX a
        // zero. Plausibile e falso.
        ...(this.#opts.countryOf && this.#settings.geoEnabled ? { countryOf: this.#opts.countryOf } : {}),
      });
    } catch (err) {
      errorKind = controller.signal.aborted
        ? 'cycle_timeout'
        : err instanceof Error
          ? err.message.slice(0, 80)
          : 'unknown';
    } finally {
      clearTimeout(budget);
    }

    if (!read) {
      this.#transition(false, errorKind);
      await this.#persist(this.#blankCycle(tickAt, 'failed', started, errorKind), [], skipped);
      return { status: 'failed', errorKind };
    }

    // Uno SCAN troncato significa che abbiamo visto una PARTE dell'insieme:
    // i conteggi sarebbero sottostimati, quindi non entrano nel grezzo e non
    // coprono tempo. Sottostimare in silenzio e' peggio che non sapere.
    if (read.scanTruncated) {
      this.#transition(false, 'scan_truncated');
      const row = this.#blankCycle(tickAt, 'partial', started, 'scan_truncated');
      row.keysRead = read.keysRead;
      row.scanIterations = read.scanIterations;
      row.scanTruncated = true;
      row.dbsize = read.dbsize;
      await this.#persist(row, [], skipped);
      return { status: 'partial', keysRead: read.keysRead };
    }

    const { samples, serversSeen } = await this.#countByServer(read.players);
    const { skewS, skewRejected } = this.#skewOf(read.players, tickMs);

    const cycle: CycleRow = {
      tickAt,
      runId: this.#runId,
      status: 'ok',
      deltaS: this.#deltaOf(tickMs),
      durationMs: Date.now() - started,
      players: read.players.size,
      keysRead: read.keysRead,
      keysSkipped: read.keysSkipped,
      serversSeen,
      scanIterations: read.scanIterations,
      scanTruncated: false,
      dbsize: read.dbsize,
      pttlMinS: read.pttlMinS,
      pttlMaxS: read.pttlMaxS,
      skewS,
      skewRejected,
      serversPlayers: read.serversPlayers,
      errorKind: null,
    };

    await this.#persist(cycle, samples, skipped);

    if (read.serverNamesRejected > 0) {
      // Non entra in keys_skipped: quei giocatori sono contati, sono solo
      // finiti sul transito invece che sul loro server. Va detto perche' i 22
      // nomi osservati in produzione passano tutti: se questo numero smette
      // di essere zero, e' cambiato qualcosa nel plugin e il breakdown sta
      // gia' attribuendo male qualcuno.
      this.#opts.logger.warn(
        { job: 'stats-ingest', rifiutati: read.serverNamesRejected },
        'nomi di server non scrivibili: quei giocatori risultano in transito',
      );
    }

    // Le sessioni si aggiornano DOPO che il ciclo e' stato registrato: se la
    // scrittura del grezzo fallisce, non si apre nessuna sessione per un tick
    // che non esiste.
    const sessions = await this.#sessions.observe(this.#opts.db, tickAt, read.players, (key) =>
      this.#dictionary.idOf(key),
    );

    this.#lastOkTickAt = tickMs;
    this.#previousIds = new Set(read.players.keys());
    this.#transition(true, null);

    if (this.#cycles % SLOW_EVERY === 1) {
      // Fuori dalla transazione e senza attesa del risultato: e' cosmesi per
      // il pannello, non deve poter allungare un ciclo.
      void this.#dictionary
        .touch(
          this.#opts.db,
          samples.map((s) => s.serverId),
        )
        .catch(() => undefined);
    }

    return {
      status: 'ok',
      players: read.players.size,
      servers: serversSeen,
      deltaS: cycle.deltaS,
      aperte: sessions.opened,
      chiuse: sessions.closed,
      inCorso: this.#sessions.openCount,
      ms: cycle.durationMs,
      ...(this.#cycles % SUMMARY_EVERY === 0 ? { cicliDaAvvio: this.#cycles } : {}),
    };
  }

  /**
   * I secondi coperti da questo tick.
   *
   * E' il tempo dall'ultimo tick RIUSCITO, tagliato a `max_delta_s`. Il taglio
   * e' la differenza fra «tenere l'ultimo valore per un tick saltato» e
   * «accreditare tre ore di buco a un solo campione»: il tempo oltre il taglio
   * resta scoperto, ed e' la verita'.
   */
  #deltaOf(tickMs: number): number {
    const { nominalDeltaS, maxDeltaS } = this.#settings;
    if (this.#lastOkTickAt === null) return nominalDeltaS;
    const elapsed = Math.round((tickMs - this.#lastOkTickAt) / 1_000);
    return Math.min(maxDeltaS, Math.max(1, elapsed));
  }

  /**
   * Lo skew, misurato sui SOLI giocatori comparsi adesso.
   *
   * Su tutta la popolazione questo numero sarebbe l'eta' mediana delle
   * sessioni, che e' un'altra cosa e non dice niente sugli orologi. Chi e'
   * appena entrato ha `connection-time` di pochi secondi fa: lo scarto dal
   * nostro istante E' lo sfasamento fra i due orologi.
   */
  #skewOf(
    players: Map<number, OnlinePlayer>,
    tickMs: number,
  ): {
    skewS: number | null;
    skewRejected: number;
  } {
    const fresh: number[] = [];
    let skewRejected = 0;
    for (const p of players.values()) {
      if (p.connectionMs === null || this.#previousIds.has(p.playerId)) continue;
      const delta = Math.round((p.connectionMs - tickMs) / 1_000);
      if (Math.abs(delta) > MAX_SKEW_S) skewRejected += 1;
      else fresh.push(delta);
    }
    // Al primo ciclo tutti sono «nuovi» e la mediana e' l'eta' delle sessioni,
    // non lo skew: si tace invece di scrivere un numero che significa altro.
    if (this.#previousIds.size === 0) return { skewS: null, skewRejected };
    return { skewS: median(fresh), skewRejected };
  }

  /** Da giocatori a righe del grezzo. La stringa vuota e' il transito. */
  async #countByServer(players: Map<number, OnlinePlayer>): Promise<{
    samples: ServerCount[];
    serversSeen: number;
  }> {
    const byKey = new Map<string, number>();
    for (const p of players.values()) byKey.set(p.serverKey, (byKey.get(p.serverKey) ?? 0) + 1);

    await this.#dictionary.resolve(this.#opts.db, byKey.keys());

    const samples: ServerCount[] = [];
    for (const [key, count] of byKey) {
      const serverId = this.#dictionary.idOf(key) ?? TRANSIT_SERVER_ID;
      samples.push({ serverId, players: count });
    }
    return { samples, serversSeen: samples.length };
  }

  /** Gli slot passati mentre il ciclo precedente era ancora in corso. */
  #slotsSkipped(tickMs: number, align: number): Date[] {
    if (this.#lastAttemptAt === null) return [];
    const out: Date[] = [];
    for (let t = this.#lastAttemptAt + align; t < tickMs && out.length < MAX_SKIPPED_ROWS; t += align) {
      out.push(new Date(t));
    }
    return out;
  }

  #blankCycle(tickAt: Date, status: CycleRow['status'], started: number, errorKind: string | null): CycleRow {
    return {
      tickAt,
      runId: this.#runId,
      status,
      // Solo un ciclo `ok` copre del tempo: e' il vincolo della 011, e qui e'
      // la stessa regola scritta due volte apposta.
      deltaS: null,
      durationMs: Date.now() - started,
      players: null,
      keysRead: null,
      keysSkipped: null,
      serversSeen: null,
      scanIterations: null,
      scanTruncated: false,
      dbsize: null,
      pttlMinS: null,
      pttlMaxS: null,
      skewS: null,
      skewRejected: 0,
      serversPlayers: null,
      errorKind,
    };
  }

  /**
   * Scrive, e se non ci riesce mette da parte.
   *
   * Con Postgres irraggiungibile non c'e' dove scrivere che non si poteva
   * scrivere: quegli slot restano MANCANTI e la lettura li distingue dai
   * `failed`. L'anello recupera i piu' recenti al ritorno; oltre il cap si
   * perdono, ed e' corretto che si veda.
   */
  async #persist(cycle: CycleRow, samples: ServerCount[], skipped: Date[]): Promise<void> {
    for (const at of skipped) {
      this.#pending.push({ cycle: this.#blankCycle(at, 'skipped', Date.now(), 'overlap'), samples: [] });
    }
    this.#pending.push({ cycle, samples });
    while (this.#pending.length > PENDING_MAX) this.#pending.shift();

    const queue = [...this.#pending];
    this.#pending.length = 0;
    for (const [i, item] of queue.entries()) {
      try {
        await writeCycle(this.#opts.db, item.cycle, item.samples);
      } catch (err) {
        // Rimette in coda cio' che resta, incluso questo, e rilancia: il
        // chiamante deve sapere che il ciclo non e' finito nel registro.
        this.#pending.push(...queue.slice(i));
        while (this.#pending.length > PENDING_MAX) this.#pending.shift();
        throw err;
      }
    }
  }

  /** Una riga di log per CAMBIO di stato, non per ciclo. */
  #transition(ok: boolean, errorKind: string | null): void {
    if (ok === this.#healthy) return;
    this.#healthy = ok;
    if (ok) {
      this.#opts.logger.info({ job: 'stats-ingest' }, 'campionamento tornato a raccogliere');
    } else {
      this.#opts.logger.error(
        { job: 'stats-ingest', errorKind },
        'campionamento fermo: i grafici avranno un buco, non uno zero',
      );
    }
  }
}
