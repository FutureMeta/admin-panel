// La lettura di «Duels · Live» dal Redis di gioco.
//
// COSA PROVA E COSA NO, detto subito. Non c'e' nessun Redis vero qui dentro:
// `mini-redis` non conosce i SET (`SADD`/`SMEMBERS`), che sono meta' di quello
// che questo lettore usa, e un Redis in container non c'e' su ogni macchina.
// Al suo posto c'e' un doppio che rispetta il CONTRATTO di ioredis nei tre
// punti che contano — `smembers` restituisce un elenco, `pipeline().exec()`
// restituisce coppie `[errore, valore]`, `scan` restituisce `[cursore,
// chiavi]` — e non prova niente sul protocollo.
//
// Quello che prova e' la LOGICA, cioe' dove stanno i difetti veri: le medie
// dei campioni CSV, l'indice inverso partita → server, il conteggio dei
// giocatori con una scansione sola, le modalita' ferme che spariscono, e i
// campi che restano `null` invece di diventare zero.
//
// LO ZERO E IL NULL SONO LA COPPIA PIU' PERICOLOSA di tutta la schermata. Un
// server che non ha ancora pubblicato un campione di TPS non ha TPS «zero»: ha
// TPS ignoto. Confonderli dipinge di rosso un server sano, e chi guarda la
// pagina va a cercare un guasto che non esiste.

import { describe, expect, it } from 'vitest';
import { readLiveRoster, readLiveSnapshot } from '#src/duels/live.ts';

type Hash = Record<string, string>;

/**
 * Il doppio: un Redis di gioco finto, con dentro quello che gli si mette.
 *
 * Implementa i quattro comandi che il lettore usa e nient'altro. Se un giorno
 * il lettore ne chiamasse un quinto, qui fallirebbe con un errore che dice
 * quale — che e' meglio di un doppio permissivo che risponde `undefined` a
 * tutto e lascia passare una lettura sbagliata.
 */
function fakeRedis(seed: {
  sets?: Record<string, string[]>;
  hashes?: Record<string, Hash>;
  strings?: Record<string, string>;
}) {
  const sets = seed.sets ?? {};
  const hashes = seed.hashes ?? {};
  const strings = seed.strings ?? {};
  const calls: string[] = [];

  const run = (cmd: string, key: string): [null, unknown] => {
    calls.push(`${cmd} ${key}`);
    if (cmd === 'hgetall') return [null, hashes[key] ?? {}];
    if (cmd === 'get') return [null, strings[key] ?? null];
    if (cmd === 'zcard') return [null, (sets[key] ?? []).length];
    throw new Error(`comando non previsto dal doppio: ${cmd}`);
  };

  const client = {
    calls,
    async smembers(key: string): Promise<string[]> {
      calls.push(`smembers ${key}`);
      return sets[key] ?? [];
    },
    // Una `SCAN` sola che restituisce tutto e chiude il cursore: il lettore
    // deve funzionare con qualunque numero di giri, e il caso a un giro e'
    // quello che un Redis piccolo produce davvero.
    async scan(_cursor: string, _match: string, pattern: string): Promise<[string, string[]]> {
      calls.push(`scan ${pattern}`);
      const prefix = pattern.replace(/\*$/, '');
      return ['0', Object.keys(strings).filter((k) => k.startsWith(prefix))];
    },
    pipeline() {
      const queued: Array<[string, string]> = [];
      const api = {
        hgetall: (key: string) => {
          queued.push(['hgetall', key]);
          return api;
        },
        get: (key: string) => {
          queued.push(['get', key]);
          return api;
        },
        zcard: (key: string) => {
          queued.push(['zcard', key]);
          return api;
        },
        async exec(): Promise<Array<[Error | null, unknown]>> {
          return queued.map(([cmd, key]) => run(cmd, key));
        },
      };
      return api;
    },
  };
  // Il lettore vuole un `Redis`; qui ce n'e' la fetta che usa davvero.
  return client as unknown as Parameters<typeof readLiveSnapshot>[0] & { calls: string[] };
}

const NOW = new Date('2026-08-29T12:00:00Z');

/** Due server DUEL, uno EVENT, tre partite, due giocatori per partita. */
function seed() {
  return {
    sets: {
      'duels:servers:all': ['duels_1', 'duels_2', 'duels_event_1', 'duels_ffa_1'],
      'duels:match:all': ['m-1', 'm-2', 'm-3', 'm-4'],
      'duels:queue:mode:1': ['a', 'b', 'c'],
      'duels:queue:mode:2': [],
      'duels:queue:mode:9': ['z'],
    },
    hashes: {
      'duels:servers:duels_1': {
        identifier: 'duels_1',
        type: 'DUEL',
        players: '148',
        active: 'true',
        matches: 'm-1,m-2',
        tps: '19.8,19.9,20.0',
        mspt: '6.0,6.8',
        // PERCENTUALI, 0..100: e' cosi' che il plugin le pubblica.
        cpu: '40.0,42.0',
      },
      'duels:servers:duels_2': {
        identifier: 'duels_2',
        type: 'DUEL',
        players: '88',
        active: 'true',
        matches: '',
        // Nessun campione: il server e' su ma non ha ancora pubblicato niente.
        tps: '',
        mspt: '',
        cpu: '',
      },
      'duels:servers:duels_event_1': {
        identifier: 'duels_event_1',
        type: 'EVENT',
        players: '61',
        active: 'true',
        matches: 'm-3',
        tps: '19.6',
        mspt: '7.1',
        cpu: '34.0',
      },
      'duels:match:m-1': {
        identifier: 'm-1',
        context: 'NORMAL',
        modeId: '1',
        mapId: '10',
        createdAt: String(NOW.getTime() - 125_000),
      },
      'duels:match:m-2': {
        identifier: 'm-2',
        context: 'NORMAL',
        modeId: '1',
        mapId: '11',
        createdAt: String(NOW.getTime() - 30_000),
      },
      'duels:servers:duels_ffa_1': {
        identifier: 'duels_ffa_1',
        type: 'FFA',
        players: '30',
        active: 'true',
        matches: 'm-4',
        tps: '19.9',
        mspt: '4.0',
        cpu: '20.0',
      },
      'duels:match:m-4': {
        identifier: 'm-4',
        context: 'NORMAL',
        modeId: '1',
        mapId: '10',
        createdAt: String(NOW.getTime() - 10_000),
      },
      'duels:match:m-3': {
        identifier: 'm-3',
        context: 'EVENT',
        modeId: '9',
        mapId: '12',
        createdAt: String(NOW.getTime() - 600_000),
      },
      'metaverse:player:Lorenzo_98': { server: 'duels_1', ping: '34' },
      'metaverse:player:Giadaaa': { server: 'duels_1', ping: '58' },
    },
    strings: {
      'duels:player:match:Lorenzo_98': 'm-1',
      'duels:player:match:Giadaaa': 'm-1',
      'duels:player:match:MatteoRossi': 'm-2',
      'duels:player:match:Sbrodino': 'm-2',
      'duels:player:match:Miky88': 'm-3',
    },
  };
}

describe('la fotografia: server, partite, modalita`', () => {
  it('i campioni CSV diventano medie, e il server senza campioni resta ignoto', async () => {
    const snap = await readLiveSnapshot(fakeRedis(seed()), null, NOW);
    const one = snap.servers.find((s) => s.id === 'duels_1');
    const two = snap.servers.find((s) => s.id === 'duels_2');

    expect(one?.tps).toBeCloseTo((19.8 + 19.9 + 20.0) / 3, 6);
    expect(one?.mspt).toBeCloseTo(6.4, 6);
    expect(one?.cpu).toBeCloseTo(41, 6);

    // LA RIGA CHE CONTA. Zero e ignoto non sono la stessa cosa: con zero
    // questo server verrebbe dipinto di rosso — TPS 0 — e chi guarda andrebbe
    // a cercare un guasto che non c'e'.
    expect(two?.tps).toBeNull();
    expect(two?.mspt).toBeNull();
    expect(two?.cpu).toBeNull();
  });

  it('ogni partita sa su quale server gira, e il server sa quante ne ha', async () => {
    // L'hash della partita NON dice il server: si ricava dall'elenco `matches`
    // dell'hash del server. E' l'unica strada, ed e' il pezzo che si romperebbe
    // in silenzio — le partite comparirebbero tutte senza server.
    const snap = await readLiveSnapshot(fakeRedis(seed()), null, NOW);
    const byId = new Map(snap.matches.map((m) => [m.id, m]));
    expect(byId.get('m-1')?.server).toBe('duels_1');
    expect(byId.get('m-2')?.server).toBe('duels_1');
    expect(byId.get('m-3')?.server).toBe('duels_event_1');

    expect(snap.servers.find((s) => s.id === 'duels_1')?.matches).toBe(2);
    expect(snap.servers.find((s) => s.id === 'duels_2')?.matches).toBe(0);
  });

  it('le partite arrivano dalla piu` recente', async () => {
    const snap = await readLiveSnapshot(fakeRedis(seed()), null, NOW);
    expect(snap.matches.map((m) => m.id)).toEqual(['m-2', 'm-1', 'm-3']);
  });

  it('i giocatori per partita si contano con UNA scansione, non una per partita', async () => {
    // E' la decisione di progetto piu' importante del lettore. L'indice e'
    // inverso — una chiave per giocatore — e cercarlo partita per partita
    // sarebbe una scansione per ognuna, a ogni aggiornamento della schermata.
    const redis = fakeRedis(seed());
    const snap = await readLiveSnapshot(redis, null, NOW);

    const byId = new Map(snap.matches.map((m) => [m.id, m]));
    expect(byId.get('m-1')?.players).toBe(2);
    expect(byId.get('m-2')?.players).toBe(2);
    expect(byId.get('m-3')?.players).toBe(1);

    const scans = redis.calls.filter((c) => c.startsWith('scan'));
    expect(scans).toHaveLength(1);
  });

  it('senza catalogo i nomi restano nulli, e la schermata vive lo stesso', async () => {
    // Il MySQL del gioco e' un'altra macchina e puo' non rispondere. Far
    // fallire tutta la pagina perche' un'etichetta non si e' potuta tradurre
    // sarebbe scambiare un nome per un dato.
    const snap = await readLiveSnapshot(fakeRedis(seed()), null, NOW);
    expect(snap.matches.every((m) => m.mode === null && m.map === null)).toBe(true);
    expect(snap.matches.every((m) => m.modeId > 0 && m.mapId > 0)).toBe(true);
  });
});

describe('le modalita`: quelle ferme non si mostrano', () => {
  it('conta le partite in corso e i giocatori in coda, e scarta le modalita` a zero', async () => {
    const catalogue = {
      rows: async <T>(sql: string): Promise<T[]> => {
        if (sql.includes('duels_mode')) {
          return [
            { id: 1, display_name: 'NoDebuff', type: 'NORMAL' },
            { id: 2, display_name: 'Sumo', type: 'NORMAL' },
            // Una modalita' senza partite E senza coda: non deve comparire.
            { id: 3, display_name: 'Gapple', type: 'NORMAL' },
            { id: 9, display_name: 'Crystal Royale', type: 'EVENT' },
          ] as T[];
        }
        return [{ id: 10, display_name: 'Ancient Ashes' }] as T[];
      },
    };
    const snap = await readLiveSnapshot(
      fakeRedis(seed()),
      catalogue as unknown as Parameters<typeof readLiveSnapshot>[1],
      NOW,
    );

    // `Sumo` ha zero partite e zero in coda: fuori. `Gapple` idem. Un elenco
    // di trenta righe a zero nasconde le tre che stanno girando.
    expect(snap.modes.map((m) => m.name)).toEqual(['NoDebuff', 'Crystal Royale']);

    const nodebuff = snap.modes.find((m) => m.name === 'NoDebuff');
    expect(nodebuff).toMatchObject({ active: 2, queued: 3, context: 'NORMAL' });
    expect(snap.modes.find((m) => m.name === 'Crystal Royale')).toMatchObject({
      active: 1,
      queued: 1,
      context: 'EVENT',
    });
  });

  it('e con il catalogo i nomi compaiono', async () => {
    const catalogue = {
      rows: async <T>(sql: string): Promise<T[]> =>
        (sql.includes('duels_mode')
          ? [{ id: 1, display_name: 'NoDebuff', type: 'NORMAL' }]
          : [{ id: 10, display_name: 'Ancient Ashes' }]) as T[],
    };
    const snap = await readLiveSnapshot(
      fakeRedis(seed()),
      catalogue as unknown as Parameters<typeof readLiveSnapshot>[1],
      NOW,
    );
    const m1 = snap.matches.find((m) => m.id === 'm-1');
    expect(m1?.mode).toBe('NoDebuff');
    expect(m1?.map).toBe('Ancient Ashes');
    // Una modalita' che il catalogo non conosce resta senza nome invece di
    // sparire: la partita c'e' comunque, ed e' quello che si sta guardando.
    expect(snap.matches.find((m) => m.id === 'm-3')?.mode).toBeNull();
  });
});

describe('il roster: solo la partita chiesta', () => {
  it('tiene i giocatori di quella partita e nessun altro', async () => {
    const { players } = await readLiveRoster(fakeRedis(seed()), 'm-1');
    expect(players.map((p) => p.name)).toEqual(['Giadaaa', 'Lorenzo_98']);
    expect(players.find((p) => p.name === 'Lorenzo_98')).toEqual({
      name: 'Lorenzo_98',
      server: 'duels_1',
      ping: 34,
    });
  });

  it('un giocatore senza profilo online resta nell`elenco, senza ping', async () => {
    // Succede davvero: chi e' appena uscito ha ancora la chiave della partita
    // ma non piu' il profilo. Il nome c'e', ed e' quello che si e' chiesto.
    const { players } = await readLiveRoster(fakeRedis(seed()), 'm-2');
    expect(players.map((p) => p.name)).toEqual(['MatteoRossi', 'Sbrodino']);
    expect(players.every((p) => p.ping === null && p.server === null)).toBe(true);
  });

  it('una partita senza nessuno da` un elenco vuoto, non un errore', async () => {
    const { players } = await readLiveRoster(fakeRedis(seed()), 'm-inesistente');
    expect(players).toEqual([]);
  });
});

describe('i server che non sono DUEL ne` EVENT non esistono, qui', () => {
  it('un server FFA non compare fra i server', async () => {
    const snap = await readLiveSnapshot(fakeRedis(seed()), null, NOW);
    expect(snap.servers.map((s) => s.id)).toEqual(['duels_1', 'duels_2', 'duels_event_1']);
    expect(snap.servers.some((s) => s.type === 'FFA')).toBe(false);
  });

  it('e SPARISCONO anche le sue partite, o il totale non tornerebbe', async () => {
    // E' la meta` che si dimentica. Filtrare solo l'elenco dei server lascia
    // `m-4` fra le partite attive: comparirebbe nella griglia senza appartenere
    // a nessuno dei riquadri sotto, e il numerone in alto conterebbe una
    // partita che nessuna riga spiega.
    const snap = await readLiveSnapshot(fakeRedis(seed()), null, NOW);
    expect(snap.matches.map((m) => m.id)).toEqual(['m-2', 'm-1', 'm-3']);
    expect(snap.matches.some((m) => m.server === 'duels_ffa_1')).toBe(false);
  });

  it('e non contano nemmeno nelle partite per modalita`', async () => {
    // `m-4` e` sulla modalita` 1, la stessa di `m-1` e `m-2`. Se sopravvivesse
    // al filtro, «NoDebuff» direbbe tre partite invece di due — un numero
    // sbagliato che nessuno saprebbe da dove viene.
    const catalogue = {
      rows: async <T>(sql: string): Promise<T[]> =>
        (sql.includes('duels_mode')
          ? [{ id: 1, display_name: 'NoDebuff', type: 'NORMAL' }]
          : [{ id: 10, display_name: 'Ancient Ashes' }]) as T[],
    };
    const snap = await readLiveSnapshot(
      fakeRedis(seed()),
      catalogue as unknown as Parameters<typeof readLiveSnapshot>[1],
      NOW,
    );
    expect(snap.modes.find((m) => m.name === 'NoDebuff')?.active).toBe(2);
  });

  it('una partita di cui non si sa il server resta: non e` la stessa cosa', async () => {
    // «Su un server che non mostriamo» e «non si sa su quale server» sono due
    // cose diverse. La prima si scarta, la seconda no: e` una partita vera che
    // non siamo riusciti ad attribuire, e nasconderla sarebbe inventare.
    const base = seed();
    const orfana = {
      ...base,
      sets: { ...base.sets, 'duels:match:all': [...base.sets['duels:match:all'], 'm-orfana'] },
      hashes: {
        ...base.hashes,
        'duels:match:m-orfana': {
          identifier: 'm-orfana',
          context: 'NORMAL',
          modeId: '1',
          mapId: '10',
          createdAt: String(NOW.getTime() - 5_000),
        },
      },
    };
    const snap = await readLiveSnapshot(fakeRedis(orfana), null, NOW);
    expect(snap.matches.find((m) => m.id === 'm-orfana')?.server).toBeNull();
  });
});

describe('la CPU e` gia` una percentuale, e non si moltiplica', () => {
  it('quaranta per cento resta quaranta, non quattromila', async () => {
    // IL DIFETTO CHE QUESTA RIGA IMPEDISCE e` invisibile in una code review:
    // moltiplicare per cento una percentuale gia` fatta non rompe niente, non
    // solleva niente, e trasforma un server al 41% in un server al 4100%.
    //
    // La prova che il plugin pubblica gia` percentuali sta nel vecchio
    // pannello, in due punti che non si conoscono fra loro: la mostrava con
    // `formatPercent(s.cpu)` — il numero cosi` com'e` con un `%` in fondo — e
    // nel punteggio scriveva `1 - min(1, v / 100)`, che con una frazione 0..1
    // darebbe sempre quasi 1 e non misurerebbe niente.
    const snap = await readLiveSnapshot(fakeRedis(seed()), null, NOW);
    const one = snap.servers.find((s) => s.id === 'duels_1');
    expect(one?.cpu).toBeCloseTo(41, 6);
    // Il lettore NON tocca la scala: media dei campioni e basta. La
    // percentuale la scrive la schermata, e la scrive cosi` com'e`.
    expect(one?.cpu).toBeGreaterThan(1);
    expect(one?.cpu).toBeLessThanOrEqual(100);
  });
});
