// Server RESP2 minimale, SOLO per i test.
//
// Perche' esiste. Il §14 prescrive un Redis/Valkey effimero in container. Su
// una macchina senza container runtime quel requisito non e' soddisfabile, e
// senza uno store i test 3 e 7 — utente bannato che cade entro un secondo,
// codice TOTP non riutilizzabile — non sono eseguibili affatto.
//
// Questo NON e' un mock: ioredis ci si collega davvero, parla davvero RESP2,
// e il codice sotto test non sa che esiste. Implementa il sottoinsieme di
// comandi che il pannello usa: GET/SET(+EX,PX,NX,XX)/DEL/EXISTS/MGET/EXPIRE/
// TTL/PTTL/INCR/INCRBY/TYPE/KEYS/SCAN/FLUSHDB.
//
// NON implementa EVAL. rate-limiter-flexible su Redis gira uno script Lua, e
// un interprete Lua qui sarebbe una seconda implementazione da mantenere.
// Nei test il rate limiter usa quindi RateLimiterMemory, che e' un backend di
// prima classe della stessa libreria: cambia dove sta il contatore, non la
// politica che si sta verificando.
//
// Quando `TEST_REDIS_URL` e' presente (CI, o una macchina con Redis vero)
// questo file non viene nemmeno caricato.

import { createServer, type Server, type Socket } from 'node:net';

type Entry = { value: Buffer; expiresAt: number | null };

const CRLF = '\r\n';

function encodeSimple(s: string): Buffer {
  return Buffer.from(`+${s}${CRLF}`);
}
function encodeError(s: string): Buffer {
  return Buffer.from(`-ERR ${s}${CRLF}`);
}
function encodeInteger(n: number): Buffer {
  return Buffer.from(`:${n}${CRLF}`);
}
function encodeBulk(b: Buffer | null): Buffer {
  if (b === null) return Buffer.from(`$-1${CRLF}`);
  return Buffer.concat([Buffer.from(`$${b.length}${CRLF}`), b, Buffer.from(CRLF)]);
}
function encodeArray(items: Buffer[]): Buffer {
  return Buffer.concat([Buffer.from(`*${items.length}${CRLF}`), ...items]);
}

/** Parser RESP2 incrementale: restituisce i comandi completi e cio' che resta. */
function parseCommands(buf: Buffer): { commands: string[][]; rest: Buffer } {
  const commands: string[][] = [];
  let offset = 0;

  for (;;) {
    if (offset >= buf.length) break;
    if (buf[offset] !== 0x2a /* '*' */) {
      // Comando inline (usato solo da telnet): si ignora fino al CRLF.
      const end = buf.indexOf(CRLF, offset);
      if (end === -1) break;
      offset = end + 2;
      continue;
    }
    const headerEnd = buf.indexOf(CRLF, offset);
    if (headerEnd === -1) break;
    const argc = Number.parseInt(buf.subarray(offset + 1, headerEnd).toString('latin1'), 10);
    let cursor = headerEnd + 2;
    const args: string[] = [];
    let incomplete = false;

    for (let i = 0; i < argc; i += 1) {
      if (cursor >= buf.length || buf[cursor] !== 0x24 /* '$' */) {
        incomplete = true;
        break;
      }
      const lenEnd = buf.indexOf(CRLF, cursor);
      if (lenEnd === -1) {
        incomplete = true;
        break;
      }
      const len = Number.parseInt(buf.subarray(cursor + 1, lenEnd).toString('latin1'), 10);
      const start = lenEnd + 2;
      if (start + len + 2 > buf.length) {
        incomplete = true;
        break;
      }
      args.push(buf.subarray(start, start + len).toString('utf8'));
      cursor = start + len + 2;
    }

    if (incomplete) break;
    commands.push(args);
    offset = cursor;
  }

  return { commands, rest: buf.subarray(offset) };
}

export class MiniRedis {
  readonly #store = new Map<string, Entry>();
  #server: Server | undefined;
  #port = 0;
  readonly #sockets = new Set<Socket>();

  get port(): number {
    return this.#port;
  }
  get url(): string {
    return `redis://127.0.0.1:${this.#port}`;
  }

  #live(key: string): Entry | undefined {
    const e = this.#store.get(key);
    if (!e) return undefined;
    if (e.expiresAt !== null && e.expiresAt <= Date.now()) {
      this.#store.delete(key);
      return undefined;
    }
    return e;
  }

  #dispatch(args: string[]): Buffer {
    const cmd = (args[0] ?? '').toUpperCase();
    const a = args.slice(1);

    switch (cmd) {
      case 'PING':
        return a[0] === undefined ? encodeSimple('PONG') : encodeBulk(Buffer.from(a[0]));
      case 'QUIT':
        return encodeSimple('OK');
      case 'AUTH':
      case 'SELECT':
      case 'CLIENT':
      case 'HELLO':
        return encodeSimple('OK');
      case 'INFO':
        // ioredis fa un ready check leggendo `loading:0` da qui.
        return encodeBulk(Buffer.from('# Server\r\nredis_version:7.4.0\r\n# Persistence\r\nloading:0\r\n'));

      case 'SET': {
        const key = a[0];
        const value = a[1];
        if (key === undefined || value === undefined) return encodeError('wrong number of arguments');
        let ttlMs: number | null = null;
        let nx = false;
        let xx = false;
        let keepTtl = false;
        for (let i = 2; i < a.length; i += 1) {
          const opt = (a[i] ?? '').toUpperCase();
          if (opt === 'EX') ttlMs = Number(a[++i]) * 1000;
          else if (opt === 'PX') ttlMs = Number(a[++i]);
          else if (opt === 'NX') nx = true;
          else if (opt === 'XX') xx = true;
          else if (opt === 'KEEPTTL') keepTtl = true;
        }
        const existing = this.#live(key);
        if (nx && existing) return encodeBulk(null);
        if (xx && !existing) return encodeBulk(null);
        this.#store.set(key, {
          value: Buffer.from(value),
          expiresAt: ttlMs !== null ? Date.now() + ttlMs : keepTtl ? (existing?.expiresAt ?? null) : null,
        });
        return encodeSimple('OK');
      }

      case 'SETEX': {
        const [key, seconds, value] = a;
        if (key === undefined || seconds === undefined || value === undefined) {
          return encodeError('wrong number of arguments');
        }
        this.#store.set(key, { value: Buffer.from(value), expiresAt: Date.now() + Number(seconds) * 1000 });
        return encodeSimple('OK');
      }

      case 'GET': {
        const key = a[0];
        if (key === undefined) return encodeError('wrong number of arguments');
        return encodeBulk(this.#live(key)?.value ?? null);
      }

      case 'GETDEL': {
        // Usato da @better-auth/redis-storage per il consumo one-shot dei
        // token: senza, la libreria ripiega su EVAL, che qui non esiste.
        const key = a[0];
        if (key === undefined) return encodeError('wrong number of arguments');
        const e = this.#live(key);
        if (e) this.#store.delete(key);
        return encodeBulk(e?.value ?? null);
      }

      case 'MGET':
        return encodeArray(a.map((k) => encodeBulk(this.#live(k)?.value ?? null)));

      case 'DEL':
      case 'UNLINK': {
        let n = 0;
        for (const k of a) if (this.#store.delete(k)) n += 1;
        return encodeInteger(n);
      }

      case 'EXISTS': {
        let n = 0;
        for (const k of a) if (this.#live(k)) n += 1;
        return encodeInteger(n);
      }

      case 'TYPE': {
        const key = a[0];
        return encodeSimple(key !== undefined && this.#live(key) ? 'string' : 'none');
      }

      case 'EXPIRE':
      case 'PEXPIRE': {
        const key = a[0];
        const amount = Number(a[1]);
        if (key === undefined || !Number.isFinite(amount)) return encodeInteger(0);
        const e = this.#live(key);
        if (!e) return encodeInteger(0);
        e.expiresAt = Date.now() + (cmd === 'EXPIRE' ? amount * 1000 : amount);
        return encodeInteger(1);
      }

      case 'TTL':
      case 'PTTL': {
        const key = a[0];
        if (key === undefined) return encodeInteger(-2);
        const e = this.#live(key);
        if (!e) return encodeInteger(-2);
        if (e.expiresAt === null) return encodeInteger(-1);
        const ms = e.expiresAt - Date.now();
        return encodeInteger(cmd === 'TTL' ? Math.ceil(ms / 1000) : ms);
      }

      case 'INCR':
      case 'INCRBY':
      case 'DECRBY': {
        const key = a[0];
        if (key === undefined) return encodeError('wrong number of arguments');
        const delta = cmd === 'INCR' ? 1 : cmd === 'INCRBY' ? Number(a[1]) : -Number(a[1]);
        const e = this.#live(key);
        const current = e ? Number.parseInt(e.value.toString('utf8'), 10) : 0;
        if (e && Number.isNaN(current)) return encodeError('value is not an integer or out of range');
        const next = current + delta;
        this.#store.set(key, { value: Buffer.from(String(next)), expiresAt: e?.expiresAt ?? null });
        return encodeInteger(next);
      }

      case 'KEYS': {
        const pattern = a[0] ?? '*';
        const re = new RegExp(
          `^${pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.')}$`,
        );
        const keys = [...this.#store.keys()].filter((k) => this.#live(k) && re.test(k));
        return encodeArray(keys.map((k) => encodeBulk(Buffer.from(k))));
      }

      case 'SCAN': {
        // Cursore sempre 0: l'insieme di un test sta in una pagina sola.
        // MATCH viene rispettato, perche' chi chiama SCAN con un prefisso poi
        // ci fa qualcosa (tipicamente un DEL) e restituirgli tutto sarebbe
        // peggio che non rispondere.
        const matchIdx = a.findIndex((x) => x.toUpperCase() === 'MATCH');
        const pattern = matchIdx >= 0 ? (a[matchIdx + 1] ?? '*') : '*';
        const re = new RegExp(
          `^${pattern
            .replace(/[.+^${}()|[\]]/g, '\\$&')
            .replace(/\\\\/g, '')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.')}$`,
        );
        const keys = [...this.#store.keys()].filter((k) => this.#live(k) && re.test(k));
        return encodeArray([
          encodeBulk(Buffer.from('0')),
          encodeArray(keys.map((k) => encodeBulk(Buffer.from(k)))),
        ]);
      }

      case 'FLUSHDB':
      case 'FLUSHALL':
        this.#store.clear();
        return encodeSimple('OK');

      case 'EVAL':
      case 'EVALSHA':
      case 'SCRIPT':
        // Deliberatamente non implementato: vedi l'intestazione del file.
        return encodeError('EVAL non e` supportato da mini-redis: usa RateLimiterMemory nei test');

      default:
        return encodeError(`comando non implementato in mini-redis: ${cmd}`);
    }
  }

  async start(): Promise<void> {
    this.#server = createServer((socket) => {
      this.#sockets.add(socket);
      let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        const { commands, rest } = parseCommands(buffer);
        buffer = rest;
        if (commands.length === 0) return;
        socket.write(Buffer.concat(commands.map((c) => this.#dispatch(c))));
      });
      socket.on('error', () => socket.destroy());
      socket.on('close', () => this.#sockets.delete(socket));
    });

    await new Promise<void>((resolve, reject) => {
      this.#server?.once('error', reject);
      this.#server?.listen(0, '127.0.0.1', () => {
        const addr = this.#server?.address();
        if (addr && typeof addr === 'object') this.#port = addr.port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const s of this.#sockets) s.destroy();
    this.#sockets.clear();
    await new Promise<void>((resolve) => {
      if (!this.#server) return resolve();
      this.#server.close(() => resolve());
    });
    this.#store.clear();
  }
}
