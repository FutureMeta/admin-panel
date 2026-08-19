// Skin Minecraft: dal nome del giocatore ai byte del PNG.
//
// Perche' passiamo dal nostro server invece di puntare l'<img> al CDN delle
// skin. La CSP dichiara `img-src 'self' data:` (§5.1). Aggiungere un host
// esterno significherebbe tre cose, tutte permanenti: quel dominio vedrebbe
// l'IP di chi guarda e il nome di chi viene guardato — riga per riga del
// registro, cioe' chi sta indagando su chi; il pannello smetterebbe di
// mostrare le facce quando quel CDN e' giu'; e la direttiva resterebbe larga
// anche per tutto il resto. Il proxy costa una rotta e tiene la CSP chiusa.
//
// Il percorso e' in tre salti, tutti su host ufficiali Mojang:
//
//   1. api.mojang.com          nome    -> UUID
//   2. sessionserver.mojang.com UUID   -> profilo, con la URL della texture
//                                          dentro una proprieta' base64
//   3. textures.minecraft.net   texture -> i byte della skin (PNG 64x64)
//
// Nessun servizio di rendering di terze parti: la faccia la ritaglia il
// browser dalla skin intera con `background-position`, quindi non serve ne'
// una libreria di immagini sul server ne' fidarsi di un quarto dominio.
//
// SULLE QUOTE. sessionserver accetta UNA richiesta al minuto per profilo.
// Non e' un dettaglio da ottimizzare dopo: una pagina del registro con
// cinquanta righe la brucerebbe al primo caricamento, e la faccia sparirebbe
// a meta' tabella. Per questo la cache non e' un miglioramento ma parte del
// funzionamento, e per questo esiste anche la deduplica delle richieste in
// volo: cinquanta righe dello stesso attore devono valere una chiamata sola.

import { createHash } from 'node:crypto';
import { Agent } from 'node:https';
import type { Redis } from 'ioredis';

/**
 * Le regole di Mojang per un nome: lettere, cifre e trattino basso, da 3 a 16
 * caratteri. Non e' cosmesi — questo nome finisce dentro una URL verso
 * l'esterno, e senza il controllo un `..%2F` o una `@` cambierebbero l'host
 * interrogato. Si valida PRIMA di toccare la rete.
 */
const USERNAME = /^[A-Za-z0-9_]{3,16}$/;

/** L'UUID come lo restituisce Mojang: 32 esadecimali, senza trattini. */
const MOJANG_UUID = /^[0-9a-f]{32}$/i;

/** L'unico host da cui accettiamo byte di immagine, e l'unica forma di percorso. */
const TEXTURE_HOST = 'textures.minecraft.net';
const TEXTURE_PATH = /^\/texture\/[0-9a-f]{16,128}$/i;

const PROFILES_ENDPOINT = 'https://api.mojang.com/users/profiles/minecraft/';
const SESSION_ENDPOINT = 'https://sessionserver.mojang.com/session/minecraft/profile/';

/** Una skin e' 64x64 in PNG: qualche kilobyte. Oltre questo non e' una skin. */
const MAX_SKIN_BYTES = 128 * 1024;

const TIMEOUT_MS = 3_000;

/** Quanto teniamo un esito buono. Un cambio di nome si vede entro un giorno. */
const TTL_FOUND = 24 * 60 * 60;
/**
 * Quanto teniamo un «non esiste». Piu' corto del positivo perche' e' il caso
 * che si risolve da solo: qualcuno registra il nome, o lo corregge nel
 * pannello. Ma va tenuto: senza, ogni render di una riga con un nome che non
 * e' un account Minecraft ripartirebbe da capo con due chiamate.
 */
const TTL_UNKNOWN = 6 * 60 * 60;

/** Sentinella del negativo in cache. Non e' una URL valida, quindi non collide. */
const NONE = 'none';

const agent = new Agent({ keepAlive: true, maxSockets: 4, keepAliveMsecs: 30_000 });

export type SkinResult =
  | { status: 'found'; bytes: Buffer }
  /** Il nome non e' valido, il giocatore non esiste, o il profilo non ha skin. */
  | { status: 'unknown' }
  /** Mojang non ha risposto. NON si mette in cache: e' temporaneo. */
  | { status: 'unavailable'; reason: string };

export type MinecraftSkinsOptions = {
  redis: Redis;
  timeoutMs?: number;
  /** Iniettabile nei test: nessuna chiamata reale esce durante la suite. */
  fetchImpl?: typeof fetch;
};

/** true se il nome puo' essere un account Minecraft. Esportata: la usa anche la rotta. */
export function isMinecraftUsername(name: string): boolean {
  return USERNAME.test(name);
}

export class MinecraftSkins {
  readonly #redis: Redis;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  /** Richieste gia' in volo, per nome: cinquanta righe uguali = una chiamata. */
  readonly #inFlight = new Map<string, Promise<SkinResult>>();

  constructor(opts: MinecraftSkinsOptions) {
    this.#redis = opts.redis;
    this.#timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  /**
   * I byte della skin del giocatore. NON lancia: chi chiama decide cosa
   * mostrare, e per un avatar la risposta giusta a un guasto e' le iniziali,
   * non un errore.
   */
  async skin(username: string): Promise<SkinResult> {
    if (!isMinecraftUsername(username)) return { status: 'unknown' };

    const key = username.toLowerCase();
    const running = this.#inFlight.get(key);
    if (running) return running;

    const work = this.#resolve(key).finally(() => this.#inFlight.delete(key));
    this.#inFlight.set(key, work);
    return work;
  }

  async #resolve(key: string): Promise<SkinResult> {
    const cachedTexture = await this.#get(`mc:texture:${key}`);
    if (cachedTexture === NONE) return { status: 'unknown' };

    let texture = cachedTexture;
    if (texture === null) {
      const found = await this.#lookupTexture(key);
      if (found.status !== 'ok') return found;
      texture = found.url;
      await this.#set(`mc:texture:${key}`, texture ?? NONE, texture === null ? TTL_UNKNOWN : TTL_FOUND);
      if (texture === null) return { status: 'unknown' };
    }

    return this.#bytes(texture);
  }

  /** I due salti verso Mojang. `url: null` significa «esiste ma non ha skin». */
  async #lookupTexture(
    username: string,
  ): Promise<{ status: 'ok'; url: string | null } | { status: 'unavailable'; reason: string }> {
    const profile = await this.#json(`${PROFILES_ENDPOINT}${encodeURIComponent(username)}`);
    if (profile.status !== 'ok') return profile;
    // 404: il nome non e' registrato. E' una risposta, non un guasto.
    if (profile.code === 404 || profile.body === null) return { status: 'ok', url: null };

    const id = (profile.body as { id?: unknown }).id;
    if (typeof id !== 'string' || !MOJANG_UUID.test(id)) return { status: 'ok', url: null };

    const session = await this.#json(`${SESSION_ENDPOINT}${id}`);
    if (session.status !== 'ok') return session;
    if (session.code === 404 || session.body === null) return { status: 'ok', url: null };

    return { status: 'ok', url: textureUrlOf(session.body) };
  }

  /** I byte, dalla cache o dal CDN, con il limite di dimensione applicato. */
  async #bytes(textureUrl: string): Promise<SkinResult> {
    const digest = createHash('sha256').update(textureUrl).digest('hex').slice(0, 32);
    const cacheKey = `mc:skin:${digest}`;

    const cached = await this.#get(cacheKey);
    if (cached === NONE) return { status: 'unknown' };
    if (cached !== null) return { status: 'found', bytes: Buffer.from(cached, 'base64') };

    const res = await this.#raw(textureUrl);
    if (res.status !== 'ok') return res;
    if (res.bytes === null) {
      await this.#set(cacheKey, NONE, TTL_UNKNOWN);
      return { status: 'unknown' };
    }

    await this.#set(cacheKey, res.bytes.toString('base64'), TTL_FOUND);
    return { status: 'found', bytes: res.bytes };
  }

  /** GET che si aspetta JSON. `code` distingue il 404 dal successo. */
  async #json(
    url: string,
  ): Promise<{ status: 'ok'; code: number; body: unknown } | { status: 'unavailable'; reason: string }> {
    const res = await this.#request(url, 'application/json');
    if (res.status !== 'ok') return res;
    if (res.response.status === 404) return { status: 'ok', code: 404, body: null };
    if (!res.response.ok) {
      return { status: 'unavailable', reason: `http ${res.response.status}` };
    }
    try {
      return { status: 'ok', code: res.response.status, body: await res.response.json() };
    } catch {
      return { status: 'unavailable', reason: 'json illeggibile' };
    }
  }

  /** GET dei byte della texture. `bytes: null` = non e' una skin utilizzabile. */
  async #raw(
    url: string,
  ): Promise<{ status: 'ok'; bytes: Buffer | null } | { status: 'unavailable'; reason: string }> {
    const res = await this.#request(url, 'image/png');
    if (res.status !== 'ok') return res;
    if (!res.response.ok) {
      return res.response.status === 404
        ? { status: 'ok', bytes: null }
        : { status: 'unavailable', reason: `http ${res.response.status}` };
    }

    // Il limite si controlla due volte: sull'intestazione, per non scaricare
    // inutilmente, e sui byte davvero letti, perche' `content-length` puo'
    // mancare o mentire.
    const declared = Number(res.response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > MAX_SKIN_BYTES) return { status: 'ok', bytes: null };

    const bytes = Buffer.from(await res.response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_SKIN_BYTES) return { status: 'ok', bytes: null };
    // La firma PNG. Serviamo questi byte come `image/png`: che lo siano
    // davvero lo decidiamo noi, non l'intestazione di chi ce li ha dati.
    if (!bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
      return { status: 'ok', bytes: null };
    }
    return { status: 'ok', bytes };
  }

  async #request(
    url: string,
    accept: string,
  ): Promise<{ status: 'ok'; response: Response } | { status: 'unavailable'; reason: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(url, {
        method: 'GET',
        headers: { Accept: accept, 'User-Agent': 'MetaMC-Admin/1.0' },
        signal: controller.signal,
        // @ts-expect-error `agent` non e' nei tipi di fetch ma undici lo
        // accetta; il keep-alive evita una `dns.lookup` per ogni faccia, e
        // quella gira sul threadpool che serve Argon2.
        agent,
      });
      return { status: 'ok', response };
    } catch (err) {
      const reason =
        err instanceof Error && err.name === 'AbortError'
          ? `timeout ${this.#timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : 'errore sconosciuto';
      return { status: 'unavailable', reason };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Redis non deve poter far fallire un avatar: un guasto vale un miss. */
  async #get(key: string): Promise<string | null> {
    try {
      return await this.#redis.get(key);
    } catch {
      return null;
    }
  }

  async #set(key: string, value: string, ttlSeconds: number): Promise<void> {
    try {
      await this.#redis.set(key, value, 'EX', ttlSeconds);
    } catch {
      // Senza cache il pannello funziona lo stesso, solo piu' vicino alla
      // quota di Mojang. Non e' un motivo per non mostrare la faccia.
    }
  }
}

/**
 * La URL della texture dentro il profilo.
 *
 * Mojang la annega in una proprieta' `textures` codificata in base64, e la
 * restituisce in `http`. Qui viene promossa a `https` e l'host viene
 * verificato: e' l'unico punto in cui una URL decisa da qualcun altro
 * potrebbe diventare una nostra richiesta in uscita.
 */
function textureUrlOf(profile: unknown): string | null {
  const properties = (profile as { properties?: unknown }).properties;
  if (!Array.isArray(properties)) return null;

  const textures = properties.find(
    (p): p is { name: string; value: string } =>
      typeof p === 'object' &&
      p !== null &&
      (p as { name?: unknown }).name === 'textures' &&
      typeof (p as { value?: unknown }).value === 'string',
  );
  if (!textures) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(textures.value, 'base64').toString('utf8'));
  } catch {
    return null;
  }

  const raw = (decoded as { textures?: { SKIN?: { url?: unknown } } }).textures?.SKIN?.url;
  if (typeof raw !== 'string') return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.hostname !== TEXTURE_HOST) return null;
  if (!TEXTURE_PATH.test(parsed.pathname)) return null;

  return `https://${TEXTURE_HOST}${parsed.pathname}`;
}
