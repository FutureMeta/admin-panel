// Passo 9 — lo scenario di carico di fase 2. §9.3.
//
// LO SCENARIO CHE NON ESISTEVA DA NESSUNA PARTE, e l'unico che dice se questo
// disegno rispetta il proprio contratto: poller alla P reale, rollup, giro di
// warm e venti login concorrenti, TUTTI INSIEME.
//
// Perche' insieme e non uno per volta. Ognuno di questi pezzi, misurato da
// solo, e' rapido — e lo sono tutti anche adesso. Il rischio non e' nella
// somma dei tempi: e' che si contendano la stessa risorsa scarsa. Il threadpool
// di libuv e' uno solo, e ci vivono sia Argon2 dei login sia la compressione
// Brotli dei payload; l'event loop e' uno solo, e una compressione sincrona lo
// bloccherebbe per tutti. Sono difetti che non si vedono in nessun test in cui
// un pezzo gira da solo.
//
// LE DUE SOGLIE SONO DI NATURA DIVERSA, e vale la pena dirlo.
//
// «login p95 sotto 400 ms» e' il budget di fase 1, ma e' un numero assoluto su
// una macchina ignota: su un portatile impegnato ingiallisce per ragioni che
// non c'entrano con la fase 2, e un test che ingiallisce non lo crede piu'
// nessuno. Quindi si misura anche il DEGRADO: gli stessi venti login, prima da
// soli e poi con tutto acceso. Il contratto vero e' quello — la fase 2 non
// deve rallentare il login — ed e' l'unica forma della domanda che sia
// indipendente dalla macchina che la esegue.
//
// Le altre verifiche restano assolute perche' non dipendono dalla velocita':
// `/health/ready` che risponde 503 e' un guasto a qualunque frequenza, e un
// ciclo di poll che sfora il proprio slot lo e' altrettanto.

import { Redis } from 'ioredis';
import type pg from 'pg';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKysely, createPool, type Database } from '#src/db/pool.ts';
import { eventLoopDelayP99, resetEventLoopMonitor } from '#src/observability/event-loop.ts';
import { RANGES } from '#src/stats/contract.ts';
import { createGameRedis } from '#src/stats/game-redis.ts';
import { StatsPoller } from '#src/stats/poller.ts';
import { runRollup } from '#src/stats/rollup.ts';
import { warmOnBoot, warmRange } from '#src/stats/warm.ts';
import { seedUser } from '#tests/support/actors.ts';
import { sameOriginHeaders, startTestApp, type TestApp } from '#tests/support/app.ts';
import { MiniRedis } from '#tests/support/mini-redis.ts';
import { connect } from '#tests/support/postgres.ts';

const PASSWORD = 'password-di-test-lunghissima';
/** Venti login concorrenti, come chiede il §9.3. */
const LOGIN = 20;
/** La P dichiarata dal committente: fra 650 e 800 giocatori. */
const P = 700;
const PATTERN = 'metaverse:player:*';
const SERVERS = Array.from({ length: 19 }, (_, i) => `srv_${i + 1}`);

let t: TestApp;
let mini: MiniRedis;
let seed: Redis;
let game: Redis;
let ingestPool: pg.Pool;
let ingestDb: Database;
let poller: StatsPoller;
let sql: pg.Client;

const silent = pino({ level: 'silent' });

beforeAll(async () => {
  t = await startTestApp({ label: 'carico', statsDb: true });
  sql = await connect(t.db.migrateUrl, 'metamc-test-carico-sql');

  // Venti account distinti: venti login concorrenti dello STESSO account
  // sbatterebbero sul limitatore per account e misurerebbero quello.
  for (let i = 0; i < LOGIN; i += 1) {
    await seedUser(t, { email: `carico-${i}@metamc.it`, password: PASSWORD, roleKey: 'moderatore' });
  }

  // Il Redis di gioco, con P giocatori sparsi su diciannove server.
  mini = new MiniRedis();
  await mini.start();
  seed = new Redis(mini.url, { enableAutoPipelining: false });
  game = createGameRedis(mini.url, 'carico');
  const now = Date.now();
  for (let i = 0; i < P; i += 1) {
    await seed.hset(`metaverse:player:Player${i}`, {
      identifier: String(i),
      server: `${SERVERS[i % SERVERS.length]}`,
      'connection-time': String(now - (i % 3_600) * 1_000),
    });
  }

  // Il poller scrive col ruolo di ingest, MAI con quello del pannello: e' la
  // separazione che si vuole mettere sotto carico, non aggirare.
  ingestPool = createPool({
    connectionString: t.db.ingestUrl,
    max: 2,
    applicationName: 'metamc-test-carico-ingest',
    statementTimeout: '5s',
    searchPath: 'stats, public',
  });
  ingestDb = createKysely(ingestPool);
  poller = new StatsPoller({ db: ingestDb, redis: game, logger: silent, pattern: PATTERN });
  await poller.start();
}, 300_000);

afterAll(async () => {
  game?.disconnect();
  await seed?.quit().catch(() => undefined);
  await mini?.stop().catch(() => undefined);
  await ingestDb?.destroy().catch(() => undefined);
  await sql?.end().catch(() => undefined);
  await t?.close();
});

function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] as number;
}

/** Venti login in parallelo. Torna le durate, in millisecondi. */
async function loginBurst(): Promise<number[]> {
  const runs = Array.from({ length: LOGIN }, async (_, i) => {
    const t0 = process.hrtime.bigint();
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: sameOriginHeaders(),
      payload: { email: `carico-${i}@metamc.it`, password: PASSWORD },
    });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return { ms, code: res.statusCode };
  });
  const results = await Promise.all(runs);
  // Un login che fallisce e' veloce: misurare quello significherebbe misurare
  // il percorso sbagliato e concludere che va tutto bene.
  for (const e of results) expect(e.code, 'un login e` fallito: la misura non vale').toBe(200);
  await t.ctx.rateLimit.reward('loginIp', '127.0.0.1');
  await t.ctx.rateLimit.reward('loginGlobal', 'rotta');
  return results.map((e) => e.ms);
}

/** Trenta colpi su `/health/ready`, raccolti in `into`. */
async function probeReadiness(into: number[]): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    const res = await t.app.inject({ method: 'GET', url: '/health/ready' });
    into.push(res.statusCode);
  }
}

function deps() {
  const statsDb = t.ctx.statsDb;
  if (!statsDb) throw new Error('il pool di lettura non e` configurato');
  return { statsDb, cache: t.ctx.statsCache, redis: t.ctx.cacheRedis, logger: t.ctx.logger };
}

describe('§9.3 — poller, rollup, warm e venti login tutti insieme', () => {
  it('il budget del login regge con tutta la fase 2 accesa', async () => {
    // 1. La linea di base: gli stessi venti login, da soli, con la stessa
    //    sonda di readiness accanto. Serve anche quella: venti login insieme
    //    saturano il semaforo di Argon2 (sei posti, vedi SEC-28) e la
    //    readiness risponde 503 di proposito — indipendentemente dalla fase 2.
    //    Confrontare i 503 «con» contro i 503 «senza» e` l'unico modo di
    //    chiedere davvero se questo disegno peggiora la disponibilita`.
    await loginBurst(); // a vuoto, per pagare le cache fredde
    const baseReadiness: number[] = [];
    const [baseDurations] = await Promise.all([loginBurst(), probeReadiness(baseReadiness)]);
    const base = percentile(baseDurations, 0.95);
    const baseNotOk = baseReadiness.filter((c) => c !== 200).length;

    // 2. Ora tutto insieme. Il poller gira, i tre livelli di rollup girano, il
    //    giro di warm costruisce e comprime cinque payload, e nel frattempo
    //    arrivano venti login.
    resetEventLoopMonitor();
    const readiness: number[] = [];

    const [durations] = await Promise.all([
      loginBurst(),
      (async () => {
        await poller.runOnce(Date.now());
        await runRollup(ingestDb, '5m');
        await runRollup(ingestDb, '1h');
        await runRollup(ingestDb, '1d');
      })(),
      warmOnBoot(deps()),
      probeReadiness(readiness),
    ]);

    const loaded = percentile(durations, 0.95);

    // IL CONTRATTO VERO, e l'unico indipendente dalla macchina: la fase 2 non
    // deve raddoppiare la latenza del login. Se Argon2 e Brotli si
    // contendessero il threadpool, e' qui che si vedrebbe.
    expect(loaded, `base ${base.toFixed(0)} ms, sotto carico ${loaded.toFixed(0)} ms`).toBeLessThan(
      base * 2 + 50,
    );

    // LA READINESS NON DEVE PEGGIORARE PER COLPA DELLA FASE 2.
    //
    // Non «mai 503», che sarebbe una domanda a cui questo pannello risponde no
    // gia' senza fase 2: venti login insieme saturano il semaforo di Argon2 e
    // il 503 e' voluto (SEC-28, «un processo con tutti i thread occupati da
    // Argon2 ha un event loop perfettamente reattivo», quindi la saturazione
    // va segnalata altrove). La domanda giusta e' se il poller, i rollup e il
    // giro di warm ne aggiungano dei loro.
    const loadedNotOk = readiness.filter((c) => c !== 200).length;
    expect(
      loadedNotOk,
      `readiness non-200: ${baseNotOk} da soli, ${loadedNotOk} sotto carico`,
    ).toBeLessThanOrEqual(baseNotOk);

    // Il budget assoluto di fase 1. Generoso il doppio, perche' su una macchina
    // di sviluppo impegnata 400 ms si sforano per ragioni che non c'entrano
    // con la fase 2 — ma un ordine di grandezza sbagliato va visto.
    expect(loaded, `p95 sotto carico ${loaded.toFixed(0)} ms`).toBeLessThan(800);

    // L'event loop: una compressione sincrona lo bloccherebbe per tutti, e
    // sarebbe invisibile in ogni test in cui il warm gira da solo.
    expect(eventLoopDelayP99(), 'event loop bloccato durante il giro di warm').toBeLessThan(250);
  }, 300_000);

  it('nessun ciclo di poll sfora il proprio slot', async () => {
    await poller.runOnce(Date.now());
    const r = await sql.query(
      `SELECT max(duration_ms)::int AS worst_ms, count(*)::int AS cycles
         FROM stats.poll_cycle WHERE status = 'ok'`,
    );
    const row = r.rows[0] as { worst_ms: number | null; cycles: number };
    expect(row.cycles).toBeGreaterThan(0);
    // Lo slot nominale e' 30 s. Un ciclo che lo sfora accavalla il successivo,
    // e da li' in poi il ritardo non si riassorbe piu' da solo.
    expect(row.worst_ms ?? 0, `ciclo piu` + '` lungo ' + `${row.worst_ms} ms`).toBeLessThan(30_000);
  }, 300_000);

  it('una sola compressione per volta, anche con venti login addosso', async () => {
    // L'INVARIANTE PIU' IMPORTANTE DI QUESTO FILE, e l'unico posto in cui si
    // possa davvero verificare.
    //
    // Il §7.5 vuole una compressione Brotli per volta, perche' il threadpool
    // di libuv e' lo stesso su cui gira Argon2: N compressioni concorrenti
    // rubano i thread al login. La sequenzialita' e' STRUTTURALE in
    // `StatsCache` — una catena di promesse, non un commento — e
    // `compressPeak` la misura. Ma un contatore che vale 1 mentre il warm gira
    // da solo non prova niente: deve valere 1 mentre succede tutto il resto.
    const warming = RANGES.map((range) => warmRange(deps(), range));
    const [outcomes] = await Promise.all([Promise.all(warming), loginBurst()]);

    expect(t.ctx.statsCache.metrics.compressPeak, 'due compressioni insieme: §7.5 rotto').toBe(1);

    // E il giro non rimanda niente: `deferred` cresce quando il budget finisce
    // prima delle modalita' calde, e a hot-set vuoto non ce n'e' nessuna da
    // scaldare. Diverso da zero vorrebbe dire che il giro arranca gia' senza
    // che nessuno gli abbia chiesto niente.
    for (const o of outcomes) expect(o.deferred).toBe(0);
  }, 300_000);
});
