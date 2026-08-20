// Sonda sul Redis di gioco. Passo 0 della fase 2, e il suo cancello.
//
// PERCHE' PRIMA DEL CODICE, e non dopo. Due risposte cambiano il DISEGNO, non
// la configurazione:
//
//   1. il campo `ip` e' del giocatore o del proxy Velocity? Se e' del proxy,
//      la mappa geografica esce dal disegno: tutti i giocatori collasserebbero
//      su pochi indirizzi e la mappa continuerebbe a SEMBRARE corretta mentre
//      misura la topologia della rete. Un solo campione non e' una prova, per
//      questo la sonda va eseguita tre volte in ore diverse.
//   2. quanti server esistono e come si chiamano? E' il numero N da cui
//      dipendono il volume del grezzo e la soglia di `payload_bytes`, ed e'
//      l'elenco che l'operatore usera' per riempire il dizionario delle
//      modalita' dal pannello.
//
// COSA NON FA, ed e' la parte che conta:
//
//   * NON scrive niente. Nessun comando di scrittura, nessun file, nessuna
//     riga di database. Legge e stampa aggregati.
//   * NON stampa MAI un indirizzo IP ne' un nome giocatore. L'IP vive dentro
//     lo scope di una funzione e ne esce come conteggio. Non e' prudenza
//     generica: e' l'unico motivo per cui questo output si puo' incollare in
//     una chat.
//   * NON usa KEYS. SCAN con COUNT, su una connessione dedicata con i suoi
//     timeout: un Redis di gioco sotto carico al picco non deve accorgersi
//     che stiamo guardando.
//
// Uso, dalla console del pannello:
//   GAME_REDIS_URL=redis://:password@host:6379/0 node scripts/probe-game-redis.ts
//
// Opzionali:
//   GAME_REDIS_PATTERN   default `metaverse:player:*`
//   PROBE_TTL_SAMPLE     quante chiavi campionare per il PTTL, default 50

import { Redis } from 'ioredis';

/**
 * Il Redis di gioco puo' essere lo STESSO del pannello.
 *
 * Il disegno assumeva due istanze; in questa installazione e' una sola. Cambia
 * poco per la sonda — cambiano il pattern e il fatto che DBSIZE conta anche le
 * chiavi del pannello — ma cambia due cose a valle, ed e' meglio scriverle
 * dove si scoprono:
 *
 *   1. «un Redis di gioco lento non deve rallentare un login» non si ottiene
 *      piu' con la sola separazione delle connessioni: se l'istanza e' una, la
 *      contesa e' sul server. Le connessioni separate con timeout propri
 *      restano necessarie (evitano il blocco in testa alla coda lato client),
 *      ma non sono sufficienti;
 *   2. la cache dei payload non puo' vivere qui con `allkeys-lru`, perche' la
 *      prima pressione di memoria sfratterebbe le sessioni. O si separa
 *      l'istanza, o la cache prende un prefisso e un TTL e rinuncia alla LRU.
 */
const URL_ENV = 'GAME_REDIS_URL';
const FALLBACK_URL_ENV = 'REDIS_URL';
const PATTERN = process.env['GAME_REDIS_PATTERN'] ?? 'metaverse:player:*';
const TTL_SAMPLE = Number(process.env['PROBE_TTL_SAMPLE'] ?? 50);

/** Oltre 26 ore lo scarto non e' un fuso: e' un dato sporco. */
const MAX_TZ_MINUTES = 26 * 60;

type Percentiles = { min: number; p05: number; p50: number; p95: number; max: number };

function percentiles(values: number[]): Percentiles | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] as number;
  return { min: s[0] as number, p05: at(0.05), p50: at(0.5), p95: at(0.95), max: s[s.length - 1] as number };
}

/**
 * Lo scarto fra l'orologio del server di gioco e il nostro, misurato sul
 * giocatore entrato piu' di recente.
 *
 * `connection-time` e' epoch in millisecondi, quindi NON ambiguo. Su un
 * singolo campione non si sa chi e' appena entrato, ma il minimo dell'eta'
 * delle sessioni e' il candidato migliore: con centinaia di giocatori, il piu'
 * fresco ha pochi secondi. Se l'eta' minima e' NEGATIVA, un giocatore risulta
 * connesso nel futuro, e quello e' skew certo — non un'interpretazione.
 */
function skewVerdict(ages: Percentiles | null): string {
  if (!ages) return 'nessun dato';
  if (ages.min < -5) return `SKEW: un giocatore risulta connesso ${-ages.min}s nel FUTURO`;
  if (ages.min > 300) return `sospetto: la sessione piu' fresca ha ${ages.min}s, nessuno entra da 5 minuti`;
  return `plausibile (sessione piu' fresca: ${ages.min}s)`;
}

/**
 * Lo scarto fra `registrationDate` letto come UTC e `connection-time`.
 *
 * `registrationDate` arriva come '2024-07-20 09:46:17.0', cioe'
 * java.sql.Timestamp.toString(): l'ora locale della JVM, senza offset.
 * `connection-time` e' epoch in millisecondi, quindi non ambiguo.
 *
 * Lo scarto vale `offset - eta_account`, e l'eta' non e' mai negativa: quindi
 * ogni campione sta SOTTO l'offset vero, e chi si registra nell'istante in cui
 * si connette lo tocca esattamente. L'offset e' il bordo superiore della
 * distribuzione, non la sua mediana — per questo la sonda riporta la
 * distribuzione e non un numero gia' interpretato. Filtrare per «registrazione
 * fresca» richiederebbe di conoscere gia' l'offset, che e' proprio cio' che si
 * sta misurando.
 *
 * Il filtro a 26 ore tiene fuori gli account vecchi: per quelli lo scarto e'
 * l'eta' dell'account e non dice niente sul fuso.
 */
function registrationSkewMinutes(raw: string, connectionMs: number): number | null {
  const asUtc = Date.parse(
    `${raw
      .trim()
      .replace(' ', 'T')
      .replace(/\.\d+$/, '')}Z`,
  );
  if (!Number.isFinite(asUtc)) return null;
  const deltaMin = Math.round((asUtc - connectionMs) / 60_000);
  return Math.abs(deltaMin) > MAX_TZ_MINUTES ? null : deltaMin;
}

/** Un IPv6 e' pieno di due punti: `split(':')[0]` lo distruggerebbe. */
function hostOf(address: string): string {
  const a = address.trim();
  if (a.startsWith('[')) return a.slice(1, a.indexOf(']'));
  const last = a.lastIndexOf(':');
  // Piu' di un due punti e nessuna parentesi: e' un IPv6 nudo, senza porta.
  return last > 0 && a.indexOf(':') === last ? a.slice(0, last) : a;
}

async function main(): Promise<void> {
  const url = process.env[URL_ENV] ?? process.env[FALLBACK_URL_ENV];
  const source = process.env[URL_ENV] ? URL_ENV : FALLBACK_URL_ENV;
  if (!url) {
    console.error(
      `serve ${URL_ENV} (oppure ${FALLBACK_URL_ENV}, se il Redis di gioco e' lo stesso del pannello).`,
    );
    process.exitCode = 2;
    return;
  }

  const redis = new Redis(url, {
    // Connessione DEDICATA, con i suoi timeout: questa sonda non deve poter
    // rallentare niente, e se il Redis di gioco e' lento deve fallire in
    // fretta invece di restare appesa.
    enableAutoPipelining: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
    commandTimeout: 5_000,
    lazyConnect: true,
  });
  redis.on('error', (err: Error) => console.error(`[game-redis] ${err.message}`));

  try {
    await redis.connect();
    const startedAt = Date.now();
    const dbsize = await redis.dbsize();

    // --- lettura dell'insieme online -------------------------------------
    const keys: string[] = [];
    let cursor = '0';
    let iterations = 0;
    do {
      const [next, batch] = await redis.scan(cursor, 'MATCH', PATTERN, 'COUNT', 500);
      cursor = next;
      keys.push(...batch);
      iterations += 1;
      if (iterations > 2_000) break; // rete di sicurezza, non un limite atteso
    } while (cursor !== '0');

    const pipeline = redis.pipeline();
    for (const k of keys) pipeline.hgetall(k);
    const raw = await pipeline.exec();

    // --- aggregazione. Da qui in poi NIENTE di identificabile esce. -------
    const identities = new Set<string>();
    const serversSeen = new Map<string, number>();
    const ipCount = new Map<string, number>();
    const proxies = new Set<string>();
    const ages: number[] = [];
    const offsets: number[] = [];
    let malformed = 0;
    let missingIp = 0;
    let missingServer = 0;
    let missingRegistration = 0;
    const platforms = new Map<string, number>();

    for (const entry of raw ?? []) {
      const hash = entry?.[1] as Record<string, string> | undefined;
      const id = hash?.['identifier'];
      if (!hash || !id) {
        malformed += 1;
        continue;
      }
      identities.add(id);

      const server = hash['server']?.trim();
      if (server) serversSeen.set(server, (serversSeen.get(server) ?? 0) + 1);
      else missingServer += 1;

      const platform = hash['platform']?.trim() ?? 'ASSENTE';
      platforms.set(platform, (platforms.get(platform) ?? 0) + 1);

      const proxy = hash['proxy']?.trim();
      if (proxy) proxies.add(proxy);

      // L'indirizzo si riduce SUBITO a un conteggio e non viene mai stampato.
      const address = hash['ip']?.trim() || hash['address']?.trim();
      if (address) {
        const host = hostOf(address);
        ipCount.set(host, (ipCount.get(host) ?? 0) + 1);
      } else missingIp += 1;

      const connectionMs = Number(hash['connection-time']);
      if (Number.isFinite(connectionMs) && connectionMs > 0) {
        ages.push(Math.round((startedAt - connectionMs) / 1000));
        const reg = hash['registrationDate'];
        if (reg) {
          const skew = registrationSkewMinutes(reg, connectionMs);
          if (skew !== null) offsets.push(skew);
        } else missingRegistration += 1;
      }
    }

    // --- controincrocio con il conteggio per server del plugin -----------
    let serversPlayers: number | null = null;
    try {
      const serverKeys: string[] = [];
      let c = '0';
      do {
        const [next, batch] = await redis.scan(c, 'MATCH', 'duels:servers:*', 'COUNT', 200);
        c = next;
        serverKeys.push(...batch);
      } while (c !== '0' && serverKeys.length < 500);
      if (serverKeys.length > 0) {
        const p = redis.pipeline();
        for (const k of serverKeys) p.hget(k, 'players');
        const res = await p.exec();
        serversPlayers = (res ?? []).reduce((sum, r) => sum + (Number(r?.[1]) || 0), 0);
      }
    } catch {
      serversPlayers = null; // opzionale e parziale per costruzione
    }

    // --- TTL su un campione ----------------------------------------------
    const ttlKeys = keys.slice(0, TTL_SAMPLE);
    const ttlPipeline = redis.pipeline();
    for (const k of ttlKeys) ttlPipeline.pttl(k);
    const ttlRaw = await ttlPipeline.exec();
    const ttls = (ttlRaw ?? [])
      .map((r) => Number(r?.[1]))
      .filter((v) => Number.isFinite(v) && v > 0)
      .map((ms) => Math.round(ms / 1000));
    const noTtl = (ttlRaw ?? []).filter((r) => Number(r?.[1]) === -1).length;

    // --- il verdetto su ip vs proxy --------------------------------------
    const players = identities.size;
    const distinctIp = ipCount.size;
    const topShare = players > 0 && ipCount.size > 0 ? Math.max(...ipCount.values()) / players : 0;
    const ipPerProxy = distinctIp / Math.max(1, proxies.size);

    let geoVerdict: string;
    if (players === 0) {
      geoVerdict = 'INDECIDIBILE: nessun giocatore online, ripetere in una fascia popolata';
    } else if (players < 100 && distinctIp > proxies.size + 3 && topShare <= 0.5) {
      // Con pochi giocatori la soglia su topShare non discrimina: tre persone
      // dietro lo stesso NAT domestico su venti online fanno gia' il 15%, e il
      // verdetto uscirebbe «in mezzo» per sempre. Meglio dire che il campione
      // e' piccolo che dare una risposta che non regge.
      geoVerdict =
        `CAMPIONE PICCOLO (${players} giocatori): nessuna soglia e' affidabile sotto i 100. ` +
        `Indizio finora: ${distinctIp} indirizzi distinti su ${proxies.size || 1} proxy, ` +
        'compatibile con l indirizzo del giocatore. Ripetere in prime time.';
    } else if (distinctIp <= proxies.size + 3 || topShare > 0.5) {
      geoVerdict =
        "IL CAMPO E' DEL PROXY. La mappa geografica esce dal disegno: niente colonna country, " +
        'niente database MMDB, geo_enabled resta false.';
    } else if (ipPerProxy >= 20 && topShare <= 0.1) {
      geoVerdict = "VIA LIBERA: il campo sembra l'indirizzo del giocatore.";
    } else {
      geoVerdict =
        'IN MEZZO: ripetere in un altra fascia oraria e chiedere come e configurato il proxy ' +
        'prima di procedere.';
    }

    console.log(
      JSON.stringify(
        {
          quando: new Date(startedAt).toISOString(),
          // La variabile, non il suo valore: la stringa contiene la password.
          sorgente: source,
          pattern: PATTERN,
          // Se l'istanza e' condivisa col pannello, qui dentro ci sono anche
          // sessioni e marcatori TOTP: DBSIZE non e' il numero di giocatori.
          dbsize,
          scanIterations: iterations,
          chiavi: {
            lette: keys.length,
            malformate: malformed,
            // La differenza fra chiavi e identita' e' LA sonda che dice se il
            // plugin cancella davvero al quit: la chiave e' per username, e un
            // rename ne crea una seconda per lo stesso giocatore.
            identitaDistinte: players,
            // Le malformate NON sono duplicati: sommarle qui gonfierebbe la
            // sonda che deve dire se un rename lascia viva la vecchia chiave.
            // Se questo numero e' > 0, quel giocatore viene contato due volte
            // nel totale e una sola nelle sessioni: due numeri sullo stesso
            // schermo che si contraddicono.
            duplicati: keys.length - malformed - players,
          },
          server: {
            distinti: serversSeen.size,
            // Questo elenco serve a TE per riempire il dizionario dal pannello.
            elenco: [...serversSeen.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([name, n]) => `${name} (${n})`),
            senzaServer: missingServer,
            sommaDuelsServers: serversPlayers,
          },
          piattaforme: Object.fromEntries(platforms),
          ttlSecondi: { campione: ttls.length, senzaTtl: noTtl, ...(percentiles(ttls) ?? {}) },
          etaSessioniSecondi: percentiles(ages),
          orologio: skewVerdict(percentiles(ages)),
          registrationDate: {
            assente: missingRegistration,
            campioniRecenti: offsets.length,
            // L'offset e' il BORDO SUPERIORE: ogni campione vale
            // `offset - eta_account` e l'eta' non e' mai negativa.
            scartoMinuti: percentiles(offsets),
            istogrammaOre: Object.fromEntries(
              [
                ...offsets.reduce((m, d) => {
                  const h = String(Math.round(d / 60));
                  return m.set(h, (m.get(h) ?? 0) + 1);
                }, new Map<string, number>()),
              ].sort((a, b) => Number(a[0]) - Number(b[0])),
            ),
            nota:
              offsets.length < 30
                ? 'meno di 30 campioni recenti: non basta. Finche` e` cosi`, registered_at resta NULL e il widget «nuovi» non si mostra.'
                : 'campioni sufficienti: l`offset e` il massimo, non la mediana.',
          },
          geolocalizzazione: {
            indirizziDistinti: distinctIp,
            proxyDistinti: proxies.size,
            indirizziPerProxy: Number(ipPerProxy.toFixed(1)),
            quotaIndirizzoPiuFrequente: Number(topShare.toFixed(3)),
            senzaIndirizzo: missingIp,
            verdetto: geoVerdict,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    redis.disconnect();
  }
}

await main();
