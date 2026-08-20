// Il lettore geografico. Fase 2, §8.3 e §8.4 — passo 7.
//
// IL LOOKUP NON LANCIA MAI, ed e' l'unica cosa che questo modulo deve
// garantire davvero. `Reader.get()` SOLLEVA su input malformato: un solo `ip`
// sporco dentro un hash Redis farebbe saltare l'intero campione del ciclo, e
// quel ciclo diventerebbe uno slot `failed` — cioe' un buco nei grafici
// causato da un carattere di troppo in un campo che non controlliamo noi.
// `'XX'` e' un RISULTATO, non un errore.
//
// UNA CLASSE, NON STATO DI MODULO. Il documento lo schizza con un `let` a
// livello di file; qui vale la regola del §5.3 — niente singleton importati —
// perche' altrimenti due test in parallelo condividerebbero lo stesso
// database, e il pannello non avrebbe modo di girare senza geolocalizzazione
// se non azzerando una variabile globale.
//
// NESSUN `watchForUpdates`. Usa `fs.watch`, che perde gli eventi sui rename
// atomici e sui bind mount Docker: fallirebbe esattamente nel caso per cui
// esiste. L'aggiornamento passa da un job che ricarica esplicitamente.

import { isIP } from 'node:net';
import { type CountryResponse, open as openMmdb } from 'maxmind';

/**
 * La risoluzione geografica, come tipo.
 *
 * Esiste perche' la guardia di CI vieta l'identificatore `ip` fuori da
 * `src/geo` e da `game-redis.ts` — E LA VIETA GIUSTAMENTE, anche in una
 * firma: un nome che gira per il codice invita a farci passare un valore.
 * Chi ha bisogno di questa funzione ne nomina il TIPO, non il parametro.
 */
export type CountryLookup = (value: string | undefined) => string;

/** Non determinato. E' una barra della mappa, mai uno scarto. */
export const UNKNOWN_COUNTRY = 'XX';

/**
 * Il controllo di validita': un database di paesi DEVE sapere che 8.8.8.8 e'
 * negli Stati Uniti.
 *
 * Si valida PRIMA di promuovere il riferimento: un file troncato a meta'
 * download, o un city database messo li' per sbaglio, non deve mai diventare
 * quello in uso. Meglio continuare con il vecchio.
 */
const CANARY_IP = '8.8.8.8';
const CANARY_COUNTRY = 'US';

/**
 * Indirizzi che non sono di nessuno.
 *
 * Nel database non ci sarebbero comunque, quindi il risultato non cambia — ma
 * dirlo qui rende esplicito che un indirizzo privato non e' «sconosciuto per
 * ora», e' NON GEOLOCALIZZABILE per definizione.
 */
function isReservedV4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  const [a, b] = p as [number, number, number, number];
  if (a === 0 || a === 127 || a >= 224) return true; // this-network, loopback, multicast e riservati
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
  return false;
}

function isReservedV6(ip: string): boolean {
  const low = ip.toLowerCase();
  if (low === '::' || low === '::1') return true;
  // fc00::/7 unique-local, fe80::/10 link-local, ff00::/8 multicast.
  return /^(f[cd]|fe[89ab]|ff)/.test(low);
}

/**
 * L'indirizzo dal campo `address`, che arriva come `host:porta`.
 *
 * MAI `split(':')[0]`: un indirizzo IPv6 e' pieno di due punti, e quel
 * giocatore diventerebbe `XX` per sempre — in silenzio, perche' `XX` e' un
 * risultato legittimo e nessuno andrebbe a cercarne la causa.
 */
export function ipFromAddress(address: string | undefined): string | undefined {
  if (!address) return undefined;
  const trimmed = address.trim();
  if (trimmed.length === 0) return undefined;

  // Forma con parentesi quadre: `[2001:db8::1]:25565`.
  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']');
    return close > 1 ? trimmed.slice(1, close) : undefined;
  }

  const lastColon = trimmed.lastIndexOf(':');
  if (lastColon === -1) return trimmed;
  // Piu' di due punti senza parentesi: e' un IPv6 nudo, senza porta.
  if (trimmed.indexOf(':') !== lastColon) return trimmed;
  return trimmed.slice(0, lastColon);
}

export type GeoStatus = {
  /** Falso quando nessun database e' stato caricato: il payload avra' `geo: null`. */
  ready: boolean;
  /** Giorni dalla compilazione del database. Allarme a 45. */
  ageDays: number | null;
  buildEpoch: Date | null;
  databaseType: string | null;
};

export class GeoReader {
  #reader: Awaited<ReturnType<typeof openMmdb<CountryResponse>>> | null = null;
  #buildEpoch: Date | null = null;
  #databaseType: string | null = null;

  get ready(): boolean {
    return this.#reader !== null;
  }

  /**
   * Carica e PROMUOVE solo se il file e' valido.
   *
   * Lo scambio del riferimento e' atomico in JS e non serve nessun lock: i
   * lookup gia' in volo finiscono sul buffer vecchio, che il garbage collector
   * raccoglie subito dopo. Picco di memoria durante lo scambio: due database.
   */
  async load(path: string): Promise<GeoStatus> {
    // `open` e non `new Reader`: costruisce lui la cache LRU, e non attiva
    // nessuna sorveglianza sul file a meno che non gliela si chieda —
    // `watchForUpdates` usa fs.watch, che perde i rename atomici, cioe'
    // fallirebbe esattamente nel caso per cui esisterebbe.
    const next = await openMmdb<CountryResponse>(path, { cache: { max: 8_192 } });
    const canary = next.get(CANARY_IP)?.country?.iso_code;
    if (canary !== CANARY_COUNTRY) {
      throw new Error(
        `geo: il file ${path} non e' un database di paesi valido (${CANARY_IP} risulta ${canary ?? 'ignoto'})`,
      );
    }
    this.#reader = next;
    this.#buildEpoch = next.metadata.buildEpoch;
    this.#databaseType = next.metadata.databaseType;
    return this.status();
  }

  /** Dimentica il database. La geolocalizzazione torna spenta, non rotta. */
  unload(): void {
    this.#reader = null;
    this.#buildEpoch = null;
    this.#databaseType = null;
  }

  status(now = new Date()): GeoStatus {
    const epoch = this.#buildEpoch;
    return {
      ready: this.#reader !== null,
      // Un database che invecchia senza che nessuno se ne accorga riassegna
      // interi blocchi al paese sbagliato: l'allarme e' a 45 giorni.
      ageDays: epoch ? Math.floor((now.getTime() - epoch.getTime()) / 86_400_000) : null,
      buildEpoch: epoch,
      databaseType: this.#databaseType,
    };
  }

  /**
   * Il paese di un indirizzo. Restituisce sempre due lettere, mai un errore.
   *
   * Il `try` finale non e' pessimismo: `isIP` copre la sintassi, non tutto
   * cio' che una libreria puo' fare su un input inatteso, e il costo di
   * sbagliare qui e' un ciclo di campionamento intero.
   */
  countryOf(ip: string | undefined): string {
    if (!ip || !this.#reader) return UNKNOWN_COUNTRY;
    const version = isIP(ip);
    if (version === 0) return UNKNOWN_COUNTRY;
    if (version === 4 ? isReservedV4(ip) : isReservedV6(ip)) return UNKNOWN_COUNTRY;
    try {
      const found = this.#reader.get(ip);
      return found?.country?.iso_code ?? found?.registered_country?.iso_code ?? UNKNOWN_COUNTRY;
    } catch {
      return UNKNOWN_COUNTRY;
    }
  }
}
