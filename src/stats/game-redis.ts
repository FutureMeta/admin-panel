// La lettura dell'insieme online dal Redis di gioco. Fase 2, passo 2.
//
// CONNESSIONE DEDICATA, e non e' zelo. In questa installazione il Redis di
// gioco e' la STESSA istanza che tiene le sessioni del pannello, quindi:
//
//   * niente `enableAutoPipelining`. Il client del pannello ce l'ha acceso
//     apposta, per fondere sessione + authz + rate limit in un round trip
//     solo. Se il ciclo di campionamento condividesse quel client, una
//     pipeline da 250 comandi finirebbe davanti al round trip di
//     autorizzazione di un login;
//   * timeout propri e piu' corti dell'intervallo. Una lettura appesa non
//     deve poter accavallare due cicli;
//   * blocchi da 250. Con 841 giocatori una pipeline unica sarebbe un solo
//     round trip, ma anche una risposta da centinaia di kB costruita in un
//     colpo, e nessun punto in cui accorgersi che il ciclo e' stato annullato.
//
// Va detto chiaro perche' non si dimentichi: con un'istanza sola la contesa
// resta sul SERVER. Separare le connessioni evita il blocco in testa alla coda
// lato client, che e' la parte che possiamo controllare da qui; non rende
// gratis una lettura pesante.

import { Redis } from 'ioredis';
import { ipFromAddress } from '#src/geo/reader.ts';

/** Un giocatore osservato in un ciclo, ridotto a cio' che il passo 2 usa. */
export type OnlinePlayer = {
  /** `identifier` del plugin: la sola definizione di «un giocatore». */
  playerId: number;
  /**
   * Nome del server, minuscolo. Stringa vuota quando il campo manca: il
   * giocatore sta passando fra due istanze e finisce sul sentinella del
   * transito.
   */
  serverKey: string;
  /** `connection-time` grezzo, in millisecondi epoch. Mai clampato qui. */
  connectionMs: number | null;
  /**
   * Codice paese ISO a due lettere, oppure `null`.
   *
   * `null` significa «geolocalizzazione non attiva»; `'XX'` significa «attiva
   * e non risolta». Sono due cose diverse e non vanno confuse: la prima e' una
   * funzione spenta, la seconda un dato che manca.
   *
   * L'INDIRIZZO NON ARRIVA FIN QUI. Si risolve dentro il ciclo che legge
   * l'hash e non esce da quello scope: quello che viaggia da qui in poi sono
   * due lettere, che non sono un dato personale.
   */
  country: string | null;
};

export type OnlineRead = {
  /** Deduplicati per `playerId`: la chiave e' per username, un rename ne crea due. */
  players: Map<number, OnlinePlayer>;
  keysRead: number;
  /**
   * Chiavi che NON hanno prodotto un'identita': pattern giusto, schema
   * sbagliato.
   *
   * Deve significare esattamente questo, perche' il conteggio dei duplicati si
   * ricava per sottrazione — `keys_read - keys_skipped - players` — ed e' la
   * sonda che dice se un rename lascia viva la vecchia chiave. Metterci dentro
   * anche i nomi di server rifiutati, che un'identita' la producono eccome,
   * farebbe uscire zero duplicati proprio quando ce ne sono.
   */
  keysSkipped: number;
  /**
   * Giocatori il cui `server` non e' scrivibile nel dizionario.
   *
   * Separato, e non sommato sopra: il giocatore c'e' ed e' contato: e' solo
   * finito sul transito invece che sul suo server. In produzione i 22 nomi
   * osservati passano tutti, quindi questo numero deve restare zero — e se
   * smette di esserlo e' cambiato qualcosa nel plugin.
   */
  serverNamesRejected: number;
  scanIterations: number;
  scanTruncated: boolean;
  dbsize: number;
  pttlMinS: number | null;
  pttlMaxS: number | null;
  /** Somma di `duels:servers:*.players`, quando e' stata raccolta in questo giro. */
  serversPlayers: number | null;
};

export type ReadOptions = {
  pattern: string;
  signal: AbortSignal;
  /** Quante chiavi campionare per il PTTL. Zero lo salta. */
  ttlSample?: number;
  /** Se raccogliere il controincrocio `duels:servers:*`, che costa uno SCAN in piu'. */
  withServersCrosscheck?: boolean;
  /**
   * La risoluzione geografica, INIETTATA. §8.5
   *
   * Assente significa geolocalizzazione spenta, e il paese resta `null` su
   * ogni giocatore. Iniettarla invece di importare un modulo globale non e'
   * gusto: e' cio' che permette di provare questo ciclo senza un database da
   * otto megabyte, e di spegnere la funzione senza toccare il codice.
   */
  countryOf?: (ip: string | undefined) => string;
};

/** Blocchi della pipeline: limita la risposta e da' un punto dove annullare. */
const BATCH = 250;
/** Rete di sicurezza sullo SCAN. A questo DBSIZE non deve mai scattare. */
const MAX_SCAN_ITERATIONS = 500;

/**
 * I nomi di server ammessi da `stats.server.server_key`.
 *
 * Deve combaciare con il CHECK della migration 011: un nome che passa di qui
 * e non passa di la' fa fallire l'INSERT, e con esso l'intero ciclo — cioe'
 * un buco nei dati per tutti a causa di un server.
 */
const SERVER_KEY = /^[a-z0-9_.:-]{1,64}$/;

export function createGameRedis(url: string, label = 'game'): Redis {
  const client = new Redis(url, {
    enableAutoPipelining: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 3_000,
    commandTimeout: 3_000,
    // Il ciclo decide quando ritentare, con il suo backoff: qui una coda di
    // riconnessioni infinite terrebbe in volo comandi di cicli gia' chiusi.
    retryStrategy: (times) => Math.min(30_000, times * 2_000),
    lazyConnect: false,
  });
  client.on('error', (err: Error) => {
    // Silenzioso di proposito: a Redis giu' questo evento arriva a raffica, e
    // il ciclo lo racconta gia' una volta per TRANSIZIONE di stato. 2.880
    // cicli al giorno moltiplicano tutto.
    void err;
  });
  client.setMaxListeners(20);
  void label;
  return client;
}

function assertLive(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('ciclo annullato: ha sforato il proprio slot');
}

/**
 * Legge l'insieme online una volta.
 *
 * Non lancia per un dato sporco: una chiave malformata o un nome di server
 * strano diventano un contatore, non un'eccezione. L'unica cosa che fa fallire
 * la lettura e' Redis irraggiungibile o il ciclo annullato — cioe' i due casi
 * in cui il campione NON esiste, ed e' giusto che il registro dei cicli lo
 * dica invece di scrivere numeri parziali.
 */
export async function readOnline(redis: Redis, opts: ReadOptions): Promise<OnlineRead> {
  const dbsize = await redis.dbsize();
  assertLive(opts.signal);

  const keys: string[] = [];
  let cursor = '0';
  let scanIterations = 0;
  let scanTruncated = false;
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', opts.pattern, 'COUNT', 500);
    cursor = next;
    keys.push(...batch);
    scanIterations += 1;
    assertLive(opts.signal);
    if (scanIterations >= MAX_SCAN_ITERATIONS) {
      scanTruncated = true;
      break;
    }
  } while (cursor !== '0');

  const players = new Map<number, OnlinePlayer>();
  let keysSkipped = 0;
  let serverNamesRejected = 0;

  for (let i = 0; i < keys.length; i += BATCH) {
    assertLive(opts.signal);
    const slice = keys.slice(i, i + BATCH);
    const pipeline = redis.pipeline();
    for (const k of slice) pipeline.hgetall(k);
    const replies = await pipeline.exec();

    for (const reply of replies ?? []) {
      const hash = reply?.[1] as Record<string, string> | undefined;
      const playerId = Number(hash?.['identifier']);
      if (!hash || !Number.isInteger(playerId) || playerId <= 0) {
        keysSkipped += 1;
        continue;
      }

      const rawServer = hash['server']?.trim().toLowerCase() ?? '';
      let serverKey = rawServer;
      if (rawServer !== '' && !SERVER_KEY.test(rawServer)) {
        // Il nome non e' scrivibile nel dizionario. Il giocatore NON si perde
        // — sparirebbe dal totale e l'invariante I1 salterebbe — ma finisce
        // sul transito, che e' una serie visibile. Attribuzione sbagliata al
        // posto di un buco, contata a parte perche' se accade si veda.
        serverNamesRejected += 1;
        serverKey = '';
      }

      const connection = Number(hash['connection-time']);
      const connectionMs = Number.isFinite(connection) && connection > 0 ? connection : null;

      // QUI NASCE E QUI MUORE. L'indirizzo si legge, si converte in due
      // lettere e non viene assegnato a niente che sopravviva a questo giro:
      // non a una variabile di funzione, non a un campo, non a un log. §8.5
      //
      // `address` come ripiego quando `ip` manca — e mai `split(':')[0]` su
      // di esso: un IPv6 e' pieno di due punti e quel giocatore diventerebbe
      // `XX` per sempre, in silenzio, perche' `XX` e' un risultato legittimo.
      const country = opts.countryOf
        ? opts.countryOf(hash['ip']?.trim() || ipFromAddress(hash['address']))
        : null;

      // Un rename lascia viva la vecchia chiave per la durata del TTL: due
      // chiavi, stessa identita'. Vince la piu' recente, cosi' il server
      // riportato e' quello attuale e non quello di due minuti fa.
      const seen = players.get(playerId);
      if (seen && (seen.connectionMs ?? 0) >= (connectionMs ?? 0)) continue;
      players.set(playerId, { playerId, serverKey, connectionMs, country });
    }
  }

  // --- TTL: sentinella sui fantasmi ---------------------------------------
  // Il TTL misurato in produzione e' ~104 s. Se un giorno sparisse, le chiavi
  // dei giocatori usciti non scadrebbero piu' e il conteggio crescerebbe da
  // solo, in modo perfettamente plausibile.
  let pttlMinS: number | null = null;
  let pttlMaxS: number | null = null;
  const sample = keys.slice(0, opts.ttlSample ?? 0);
  if (sample.length > 0) {
    assertLive(opts.signal);
    const pipeline = redis.pipeline();
    for (const k of sample) pipeline.pttl(k);
    const ttls = ((await pipeline.exec()) ?? [])
      .map((r) => Number(r?.[1]))
      .filter((ms) => Number.isFinite(ms) && ms > 0)
      .map((ms) => Math.round(ms / 1000));
    if (ttls.length > 0) {
      pttlMinS = Math.min(...ttls);
      pttlMaxS = Math.max(...ttls);
    }
  }

  // --- controincrocio, opzionale e parziale --------------------------------
  // Copre le sole modalita' duels e in produzione da' 462 contro i 527 che
  // contiamo noi: e' in ritardo per costruzione. Resta una metrica, non un
  // allarme, e per questo non si paga a ogni ciclo.
  let serversPlayers: number | null = null;
  if (opts.withServersCrosscheck) {
    try {
      const serverKeys: string[] = [];
      let c = '0';
      do {
        const [next, batch] = await redis.scan(c, 'MATCH', 'duels:servers:*', 'COUNT', 200);
        c = next;
        serverKeys.push(...batch);
      } while (c !== '0' && serverKeys.length < 500);
      if (serverKeys.length > 0) {
        const pipeline = redis.pipeline();
        for (const k of serverKeys) pipeline.hget(k, 'players');
        serversPlayers = ((await pipeline.exec()) ?? []).reduce((sum, r) => sum + (Number(r?.[1]) || 0), 0);
      }
    } catch {
      // Un controincrocio assente e' meno grave di un ciclo perso.
      serversPlayers = null;
    }
  }

  return {
    players,
    keysRead: keys.length,
    keysSkipped,
    serverNamesRejected,
    scanIterations,
    scanTruncated,
    dbsize,
    pttlMinS,
    pttlMaxS,
    serversPlayers,
  };
}
