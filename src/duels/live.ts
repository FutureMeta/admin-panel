// «Duels · Live»: cosa sta girando adesso, letto dal Redis di gioco.
//
// E' L'UNICA SCHERMATA DEI DUELS CHE NON PASSA DA POSTGRES. Trends e Ratings
// leggono lo storico gia' ingerito; qui non c'e' storico da leggere — la
// domanda e' «adesso», e «adesso» esiste solo dentro il Redis che i server di
// gioco tengono aggiornato. Passare da un'aggregazione intermedia
// significherebbe mostrare com'era mezzo minuto fa e chiamarlo live.
//
// COSA C'E' DENTRO IL REDIS DI GIOCO, e da dove viene questo elenco: e' il
// vecchio pannello `duels-dashboard`, che leggeva le stesse chiavi. Sono
// scritte dal plugin, non da noi, e questo file NON scrive niente.
//
//   duels:servers:all          SET   gli identificativi dei server
//   duels:servers:{id}         HASH  identifier,type,players,active,matches,
//                                    tps,mspt,cpu — le ultime tre sono serie
//                                    di campioni separate da virgola
//   duels:match:all            SET   gli identificativi delle partite in corso
//   duels:match:{id}           HASH  identifier,type,context,state,modeId,
//                                    mapId,createdAt
//   duels:queue:mode:{modeId}  ZSET  la coda di quella modalita'
//   duels:player:match:{name}  STR   la partita in cui e' quel giocatore
//   metaverse:player:{name}    HASH  il profilo online: server, ping, uuid
//
// TRE REGOLE CHE NON SI NEGOZIANO, e tutte e tre hanno lo stesso motivo — il
// Redis di gioco non e' nostro e regge una partita in corso:
//
//   1. MAI `KEYS`. Solo `SCAN` con un `COUNT` esplicito. `KEYS` su un Redis
//      sotto carico al picco blocca il server per tutta la scansione.
//   2. Client DEDICATO, con i suoi timeout. Il client del pannello regge le
//      sessioni: una lettura lenta verso il gioco che ne occupasse la coda si
//      vedrebbe come un login che non arriva.
//   3. Nessuna scrittura. Nemmeno una chiave di appoggio.
//
// I NOMI DEI GIOCATORI ESCONO SOLO DAL ROSTER, e solo su richiesta esplicita
// di una partita. La panoramica porta conteggi; l'elenco di chi sta giocando
// costa una `SCAN` in piu' e si paga solo quando qualcuno apre una partita.

import type { Redis } from 'ioredis';
import type { DuelsMysql } from './mysql.ts';

/** Le chiavi del plugin. Scritte da lui: qui si leggono e basta. */
export const LIVE_KEYS = {
  serversAll: 'duels:servers:all',
  server: (id: string) => `duels:servers:${id}`,
  matchAll: 'duels:match:all',
  match: (id: string) => `duels:match:${id}`,
  queueMode: (modeId: number) => `duels:queue:mode:${modeId}`,
  playerMatch: (name: string) => `duels:player:match:${name}`,
} as const;

const PLAYER_MATCH_PREFIX = 'duels:player:match:';
const METAVERSE_PREFIX = 'metaverse:player:';

/** Quante chiavi per giro di `SCAN`. Abbastanza da non fare mille giri. */
const SCAN_COUNT = 250;

/**
 * Il tetto di chiavi che una scansione accetta di attraversare.
 *
 * Non e' una paginazione: e' un fusibile. Se il prefisso esplodesse — chiavi
 * senza TTL, un bug del plugin — una scansione senza tetto girerebbe finche'
 * il timeout della richiesta non la ammazza, avendo gia' pesato per intero sul
 * Redis di gioco. Qui si smette, e chi legge lo viene a sapere.
 */
const SCAN_CEILING = 5_000;

export type LiveServer = {
  id: string;
  type: string;
  players: number;
  active: boolean;
  matches: number;
  /** Media dei campioni. `null` quando il server non ne ha pubblicato nessuno. */
  tps: number | null;
  mspt: number | null;
  /**
   * PERCENTUALE GIA' FATTA, 0..100, come la pubblica il plugin. Non una
   * frazione.
   *
   * Il mockup la moltiplica per cento perche' i suoi dati finti erano `0.41`,
   * ma i dati veri non sono quelli, e il vecchio pannello lo dice due volte in
   * due punti che non si conoscono fra loro: la mostrava con
   * `formatPercent(s.cpu)`, cioe' il numero cosi' com'e' con un `%` in fondo, e
   * nel calcolo del punteggio scriveva `1 - min(1, v / 100)` — che con una
   * frazione 0..1 darebbe sempre quasi 1 e non misurerebbe niente.
   *
   * Moltiplicarla qui e' il difetto piu' silenzioso possibile: un server al
   * 4% diventa un server al 400%, e nessuno sbaglia una riga di codice.
   */
  cpu: number | null;
};

export type LiveMatch = {
  id: string;
  context: string;
  server: string | null;
  modeId: number;
  /** Il nome leggibile, o `null` se il catalogo non conosce quell'id. */
  mode: string | null;
  mapId: number;
  map: string | null;
  /** Millisecondi dall'epoca, come li scrive il plugin. */
  createdAt: number;
  players: number;
};

export type LiveMode = {
  modeId: number;
  name: string;
  active: number;
  queued: number;
  /** `EVENT` oppure `NORMAL`: decide il colore del pallino nel grafico. */
  context: string;
};

export type LiveSnapshot = {
  /** Quando e' stato letto, in millisecondi. Serve a dire «di quando e'». */
  at: number;
  servers: LiveServer[];
  matches: LiveMatch[];
  modes: LiveMode[];
  /** `true` se una scansione ha incontrato il fusibile: i numeri sono parziali. */
  truncated: boolean;
};

export type LiveRosterPlayer = {
  name: string;
  /** Il server su cui il profilo dice che si trova. */
  server: string | null;
  ping: number | null;
};

/** La media dei campioni CSV che il plugin pubblica, o `null` se non ce ne sono. */
function meanOf(csv: string | undefined): number | null {
  if (!csv) return null;
  const seen: number[] = [];
  for (const part of csv.split(',')) {
    const value = Number.parseFloat(part);
    if (Number.isFinite(value)) seen.push(value);
  }
  if (seen.length === 0) return null;
  return seen.reduce((a, b) => a + b, 0) / seen.length;
}

function intOf(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * I tipi di server che questa schermata mostra. Gli altri non esistono, qui.
 *
 * E' un ELENCO CHIUSO e non una lista di esclusione, ed e' una decisione: il
 * titolo del riquadro dice «Server DUEL ed EVENT», quindi cio' che non e' ne'
 * l'uno ne' l'altro — FFA, e domani REPLAY o LOBBY — non e' materiale di
 * questa pagina. Un elenco di esclusione avrebbe fatto ricomparire il problema
 * al primo tipo nuovo che qualcuno introduce.
 *
 * IL PREZZO E' DICHIARATO: un tipo nuovo NON compare finche' non lo si scrive
 * qui. E' il verso giusto — meglio accorgersi che manca qualcosa che vedersi
 * arrivare in una schermata di operativita' dei server che non c'entrano — ma
 * e' un prezzo, e va saputo.
 */
export const LIVE_SERVER_TYPES: readonly string[] = ['DUEL', 'EVENT'];

/**
 * I server, e per ciascuno quali partite ospita.
 *
 * Il campo `matches` dell'hash e' un elenco di ID separati da virgola: e' anche
 * l'UNICO modo di sapere su quale server gira una partita — l'hash della
 * partita non lo dice. Si costruisce quindi l'indice inverso qui, una volta,
 * invece di cercarlo per ogni partita.
 *
 * L'INDICE SI COSTRUISCE SU TUTTI I SERVER, anche quelli che poi non si
 * mostrano. Serve a sapere che una partita gira su un FFA — e quindi a
 * scartarla. Costruendolo solo sui server tenuti, quella partita risulterebbe
 * «senza server» e resterebbe in pagina: filtrata a meta', che e' peggio di
 * non filtrata affatto.
 */
async function readServers(
  redis: Redis,
): Promise<{ servers: LiveServer[]; owner: Map<string, string>; hidden: Set<string> }> {
  const ids = await redis.smembers(LIVE_KEYS.serversAll);
  if (ids.length === 0) return { servers: [], owner: new Map(), hidden: new Set() };

  const pipe = redis.pipeline();
  for (const id of ids) pipe.hgetall(LIVE_KEYS.server(id));
  const replies = await pipe.exec();
  if (!replies) return { servers: [], owner: new Map(), hidden: new Set() };

  const servers: LiveServer[] = [];
  const owner = new Map<string, string>();
  const hidden = new Set<string>();

  for (const index of ids.keys()) {
    const reply = replies[index];
    if (!reply) continue;
    const [err, raw] = reply as [Error | null, Record<string, string> | null];
    // Un server che risponde con un errore o senza `identifier` non e' un
    // server: e' una chiave rimasta indietro. Si salta invece di disegnare una
    // riga vuota che sembra un server spento.
    if (err || !raw || !raw.identifier) continue;

    const matchIds = (raw.matches ?? '').split(',').filter((s) => s.length > 0);
    for (const matchId of matchIds) owner.set(matchId, raw.identifier);

    const type = raw.type ?? 'UNKNOWN';
    if (!LIVE_SERVER_TYPES.includes(type)) {
      // Fuori dall'elenco, ma NON dimenticato: il suo nome resta qui perche'
      // le partite che ospita vadano scartate insieme a lui.
      hidden.add(raw.identifier);
      continue;
    }

    servers.push({
      id: raw.identifier,
      type,
      players: intOf(raw.players),
      active: raw.active === 'true',
      matches: matchIds.length,
      tps: meanOf(raw.tps),
      mspt: meanOf(raw.mspt),
      cpu: meanOf(raw.cpu),
    });
  }

  servers.sort((a, b) => a.id.localeCompare(b.id));
  return { servers, owner, hidden };
}

/** Le partite in corso, con il nome della modalita' e della mappa quando c'e'. */
async function readMatches(
  redis: Redis,
  owner: Map<string, string>,
  hidden: Set<string>,
  modes: Map<number, { name: string; context: string }>,
  maps: Map<number, string>,
): Promise<LiveMatch[]> {
  const ids = await redis.smembers(LIVE_KEYS.matchAll);
  if (ids.length === 0) return [];

  const pipe = redis.pipeline();
  for (const id of ids) pipe.hgetall(LIVE_KEYS.match(id));
  const replies = await pipe.exec();
  if (!replies) return [];

  const matches: LiveMatch[] = [];
  for (const [index] of ids.entries()) {
    const reply = replies[index];
    if (!reply) continue;
    const [err, raw] = reply as [Error | null, Record<string, string> | null];
    if (err || !raw || !raw.identifier) continue;

    const server = owner.get(raw.identifier) ?? null;
    // Gira su un server che questa schermata non mostra: sparisce con lui.
    // Lasciarla dentro farebbe contare partite che non appartengono a nessuno
    // dei server elencati sotto, e la somma in alto non tornerebbe piu' con
    // quella dei riquadri.
    if (server !== null && hidden.has(server)) continue;

    const modeId = intOf(raw.modeId);
    const mapId = intOf(raw.mapId);
    matches.push({
      id: raw.identifier,
      context: raw.context ?? 'NORMAL',
      server,
      modeId,
      mode: modes.get(modeId)?.name ?? null,
      mapId,
      map: maps.get(mapId) ?? null,
      createdAt: intOf(raw.createdAt),
      // Riempito da `countPlayersPerMatch`: nell'hash della partita non c'e'.
      players: 0,
    });
  }

  // Dalla piu' recente: e' l'ordine in cui si guarda «cosa e' appena partito».
  matches.sort((a, b) => b.createdAt - a.createdAt);
  return matches;
}

/**
 * Partite in corso e giocatori in coda, per modalita'.
 *
 * Le partite si contano da quelle gia' lette — non si torna su Redis per una
 * cosa che si ha in mano. Le code invece sono una `ZCARD` per modalita', in
 * pipeline: sono decine di chiavi, non migliaia.
 */
async function readModes(
  redis: Redis,
  matches: readonly LiveMatch[],
  catalogue: Map<number, { name: string; context: string }>,
): Promise<LiveMode[]> {
  const ids = [...catalogue.keys()];
  const queued = new Map<number, number>();

  if (ids.length > 0) {
    const pipe = redis.pipeline();
    for (const id of ids) pipe.zcard(LIVE_KEYS.queueMode(id));
    const replies = await pipe.exec();
    if (replies) {
      for (const [index, id] of ids.entries()) {
        const reply = replies[index];
        if (!reply) continue;
        const [err, count] = reply as [Error | null, number | null];
        if (err) continue;
        queued.set(id, count ?? 0);
      }
    }
  }

  const active = new Map<number, number>();
  for (const match of matches) active.set(match.modeId, (active.get(match.modeId) ?? 0) + 1);

  const rows: LiveMode[] = [];
  for (const [modeId, mode] of catalogue) {
    rows.push({
      modeId,
      name: mode.name,
      context: mode.context,
      active: active.get(modeId) ?? 0,
      queued: queued.get(modeId) ?? 0,
    });
  }

  // Le modalita' ferme E senza coda non si mostrano: un elenco di trenta righe
  // a zero nasconde le tre che stanno girando.
  return rows
    .filter((r) => r.active > 0 || r.queued > 0)
    .sort((a, b) => b.active - a.active || b.queued - a.queued || a.name.localeCompare(b.name));
}

/**
 * Il catalogo delle modalita' e delle mappe, da MySQL.
 *
 * SENZA CATALOGO LA SCHERMATA VIVE LO STESSO. Redis conosce solo gli id
 * numerici; i nomi stanno nel database del gioco, che e' un'altra macchina e
 * puo' non rispondere. In quel caso i nomi restano `null` e la schermata mostra
 * l'id — che e' meno leggibile ma vero. Far fallire tutta la pagina perche' un
 * nome non si e' potuto tradurre sarebbe scambiare un'etichetta per un dato.
 */
async function readCatalogue(my: DuelsMysql | null): Promise<{
  modes: Map<number, { name: string; context: string }>;
  maps: Map<number, string>;
}> {
  const modes = new Map<number, { name: string; context: string }>();
  const maps = new Map<number, string>();
  if (!my) return { modes, maps };

  const [modeRows, mapRows] = await Promise.all([
    my.rows<{ id: number; display_name: string; type: string }>(
      `SELECT id, display_name, type FROM duels_mode ORDER BY id`,
    ),
    my.rows<{ id: number; display_name: string }>(`SELECT id, display_name FROM duels_map ORDER BY id`),
  ]);

  for (const row of modeRows) {
    modes.set(Number(row.id), { name: row.display_name, context: row.type ?? 'NORMAL' });
  }
  for (const row of mapRows) maps.set(Number(row.id), row.display_name);
  return { modes, maps };
}

/**
 * Quanti giocatori ci sono in ciascuna partita.
 *
 * UNA SCANSIONE SOLA PER TUTTE LE PARTITE, e questo e' il punto. L'indice e'
 * inverso — una chiave per giocatore che dice in quale partita si trova — e
 * l'istinto e' cercarla partita per partita: sarebbe una scansione per ognuna,
 * decine a ogni aggiornamento della schermata. Girando invece l'indice una
 * volta e contando, il conto per tutte costa quanto il conto per una.
 */
async function countPlayersPerMatch(
  redis: Redis,
): Promise<{ counts: Map<string, number>; truncated: boolean }> {
  const counts = new Map<string, number>();
  let cursor = '0';
  let seen = 0;
  let truncated = false;

  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${PLAYER_MATCH_PREFIX}*`, 'COUNT', SCAN_COUNT);
    cursor = next;
    if (keys.length > 0) {
      const pipe = redis.pipeline();
      for (const key of keys) pipe.get(key);
      const replies = await pipe.exec();
      for (const reply of replies ?? []) {
        const [err, matchId] = reply as [Error | null, string | null];
        if (err || !matchId) continue;
        counts.set(matchId, (counts.get(matchId) ?? 0) + 1);
      }
    }
    seen += keys.length;
    if (seen >= SCAN_CEILING) {
      truncated = true;
      break;
    }
  } while (cursor !== '0');

  return { counts, truncated };
}

/** La fotografia completa: server, partite, modalita'. Una sola per richiesta. */
export async function readLiveSnapshot(
  redis: Redis,
  my: DuelsMysql | null,
  now: Date,
): Promise<LiveSnapshot> {
  // Il catalogo e Redis in parallelo: sono due macchine diverse, e aspettare
  // l'una prima di interrogare l'altra raddoppia l'attesa per niente.
  const [catalogue, { servers, owner, hidden }, roster] = await Promise.all([
    readCatalogue(my).catch(() => ({
      modes: new Map<number, { name: string; context: string }>(),
      maps: new Map<number, string>(),
    })),
    readServers(redis),
    countPlayersPerMatch(redis),
  ]);

  const matches = await readMatches(redis, owner, hidden, catalogue.modes, catalogue.maps);
  for (const match of matches) match.players = roster.counts.get(match.id) ?? 0;

  const modes = await readModes(redis, matches, catalogue.modes);

  return { at: now.getTime(), servers, matches, modes, truncated: roster.truncated };
}

/**
 * Chi sta giocando quella partita.
 *
 * L'INDICE E' INVERSO, e non c'e' modo di girarlo: il plugin scrive una chiave
 * per GIOCATORE che dice in che partita si trova, non una chiave per partita
 * con dentro i giocatori. Quindi si scandisce il prefisso e si tengono le
 * chiavi il cui valore e' la partita chiesta.
 *
 * E' il motivo per cui il roster non arriva insieme alla panoramica: una
 * scansione per ogni partita in corso vorrebbe dire decine di scansioni a ogni
 * aggiornamento della schermata. Una sola, quando qualcuno apre una partita,
 * si paga volentieri.
 */
export async function readLiveRoster(
  redis: Redis,
  matchId: string,
): Promise<{ players: LiveRosterPlayer[]; truncated: boolean }> {
  const keys: string[] = [];
  let cursor = '0';
  let truncated = false;

  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', `${PLAYER_MATCH_PREFIX}*`, 'COUNT', SCAN_COUNT);
    cursor = next;
    for (const key of batch) keys.push(key);
    if (keys.length >= SCAN_CEILING) {
      truncated = true;
      break;
    }
  } while (cursor !== '0');

  if (keys.length === 0) return { players: [], truncated };

  const pipe = redis.pipeline();
  for (const key of keys) pipe.get(key);
  const replies = await pipe.exec();
  if (!replies) return { players: [], truncated };

  const names: string[] = [];
  for (const [index, key] of keys.entries()) {
    const reply = replies[index];
    if (!reply) continue;
    const [err, value] = reply as [Error | null, string | null];
    if (err || value !== matchId) continue;
    names.push(key.slice(PLAYER_MATCH_PREFIX.length));
  }
  if (names.length === 0) return { players: [], truncated };

  // Il profilo online porta server e ping. Se manca — il giocatore e' appena
  // uscito — restano `null`: il nome c'e' comunque, ed e' cio' che si e'
  // chiesto.
  const profiles = redis.pipeline();
  for (const name of names) profiles.hgetall(`${METAVERSE_PREFIX}${name}`);
  const profileReplies = await profiles.exec();

  const players: LiveRosterPlayer[] = names.map((name, index) => {
    const reply = profileReplies?.[index];
    const raw = reply ? (reply[1] as Record<string, string> | null) : null;
    const ping = Number.parseInt(raw?.ping ?? '', 10);
    return {
      name,
      server: raw?.server ?? null,
      ping: Number.isFinite(ping) ? ping : null,
    };
  });

  players.sort((a, b) => a.name.localeCompare(b.name));
  return { players, truncated };
}
