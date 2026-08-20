// Sessioni, presenze giornaliere e unici. Fase 2, passo 6.
//
// L'IDENTITA' DI UNA SESSIONE e' `(player_id, connection-time GREZZO)`, e
// `started_at` non viene MAI clampato, mai sostituito con l'istante corrente,
// mai ricalcolato. E' l'unico modo in cui la domanda «e' ancora la stessa
// sessione?» resta stabile fra due tick anche con l'orologio del gioco fuori
// fase. Lo skew si misura e si registra; non tocca l'identita'.
//
// `ended_at` E' SEMPRE L'ULTIMO ISTANTE PER CUI ESISTE UNA PROVA, cioe'
// l'ultimo tick in cui il giocatore e' stato visto. Mai `now()`: con `now()`
// ogni durata si gonfierebbe della grazia, e dopo un'interruzione del pannello
// di ore.
//
// I SECONDI SI VERSANO DAL SEGNALIBRO IN AVANTI, mai dall'inizio. Una sessione
// aperta versa periodicamente, e senza `accounted_through` ogni versamento
// riconterebbe tutto il tempo gia' contato.
//
// LE SESSIONI SI CONTANO ALL'APERTURA, sul giorno in cui iniziano. Contarle
// alla chiusura sembrerebbe piu' naturale e perderebbe quelle che non si
// chiudono mai — e in un giorno vivo sono tutte quelle ancora in corso.

import { sql } from 'kysely';
import type { Database } from '#src/db/pool.ts';
import type { OnlinePlayer } from './game-redis.ts';
import { TRANSIT_SERVER_ID } from './ingest.ts';

export type EndReason = 'quit' | 'gap' | 'reaper' | 'skew';

type OpenSession = {
  playerId: number;
  startedAt: Date;
  lastSeenAt: Date;
  accountedThrough: Date;
  serverIdFirst: number;
  serverIdLast: number;
  legs: number;
  seenTicks: number;
  /**
   * Codice paese della PRIMA osservazione, o null a geolocalizzazione spenta.
   *
   * Viaggia con la sessione perche' la regola del §8.5 e' deterministica —
   * vince la prima osservazione del giorno — e senza un valore da confrontare
   * non ci sarebbe niente da far vincere.
   */
  country: string | null;
  /** Tick consecutivi in cui non l'abbiamo visto. La grazia copre i trasferimenti. */
  missing: number;
  /** `last_seen_at` in memoria e` avanti rispetto al database. */
  dirty: boolean;
};

export type SessionSettings = {
  /** Quanti tick di assenza si tollerano prima di chiudere. */
  graceTicks: number;
  /** Dopo quanti secondi il reaper chiude una sessione mai piu' vista. */
  reaperAfterS: number;
};

/** Ogni quanti cicli riversare `last_seen_at` e i secondi delle sessioni aperte. */
const FLUSH_EVERY = 20;
/** Oltre 24 ore di scarto il `connection-time` non e' credibile. */
const MAX_SKEW_MS = 24 * 60 * 60 * 1_000;

type Closing = OpenSession & { endedAt: Date; reason: EndReason };

export class SessionTracker {
  readonly #open = new Map<number, OpenSession>();
  #settings: SessionSettings = { graceTicks: 3, reaperAfterS: 900 };
  #cycles = 0;
  /**
   * Al riavvio le sessioni riaperte da `session_open` vanno riconciliate.
   *
   * Non all'avvio: al PRIMO CICLO RIUSCITO, perche' solo li' si sa chi c'e'
   * ancora. Chi non c'e' piu' si chiude con `gap` — il pannello era fermo fra
   * l'ultima osservazione e il riavvio, e quel tempo non e' osservato.
   */
  #pendingGapCheck = false;

  get openCount(): number {
    return this.#open.size;
  }

  /** Ricarica le sessioni aperte. Va chiamata all'avvio, prima del primo ciclo. */
  async load(db: Database, settings: SessionSettings): Promise<void> {
    this.#settings = settings;
    const res = await sql<{
      player_id: number;
      started_at: Date;
      last_seen_at: Date;
      accounted_through: Date;
      server_id_first: number;
      server_id_last: number;
      legs: number;
      seen_ticks: number;
      country: string | null;
    }>`
      SELECT player_id, started_at, last_seen_at, accounted_through,
             server_id_first, server_id_last, legs, seen_ticks, country
        FROM stats.session_open
    `.execute(db);

    this.#open.clear();
    for (const r of res.rows) {
      this.#open.set(Number(r.player_id), {
        playerId: Number(r.player_id),
        startedAt: r.started_at,
        lastSeenAt: r.last_seen_at,
        accountedThrough: r.accounted_through,
        serverIdFirst: Number(r.server_id_first),
        serverIdLast: Number(r.server_id_last),
        legs: Number(r.legs),
        seenTicks: Number(r.seen_ticks),
        country: r.country,
        missing: 0,
        dirty: false,
      });
    }
    this.#pendingGapCheck = this.#open.size > 0;
  }

  /**
   * Un ciclo riuscito. Apre, chiude e versa.
   *
   * `serverIdOf` risolve un nome in id usando il dizionario che l'ingest ha
   * gia' popolato in questo stesso ciclo: qui non si creano server.
   */
  async observe(
    db: Database,
    tickAt: Date,
    players: Map<number, OnlinePlayer>,
    serverIdOf: (key: string) => number | undefined,
  ): Promise<{ opened: number; closed: number }> {
    this.#cycles += 1;

    const opening: OpenSession[] = [];
    const closing: Closing[] = [];
    /** Chi ha cambiato server: la presenza va segnata anche sul nuovo. */
    const moved: Array<{ playerId: number; serverId: number }> = [];

    for (const p of players.values()) {
      const serverId = serverIdOf(p.serverKey) ?? TRANSIT_SERVER_ID;
      const startedAt = this.#startOf(p, tickAt);
      const existing = this.#open.get(p.playerId);

      if (existing && existing.startedAt.getTime() === startedAt.getTime()) {
        existing.lastSeenAt = tickAt;
        existing.seenTicks += 1;
        existing.missing = 0;
        existing.dirty = true;
        // Un trasferimento fra server NON spezza la sessione: cambia la
        // permanenza e basta. Spezzarla renderebbe la durata media il tempo
        // passato su una singola istanza, che non e' quello che chiede
        // nessuno.
        if (existing.serverIdLast !== serverId) {
          existing.serverIdLast = serverId;
          existing.legs += 1;
          moved.push({ playerId: p.playerId, serverId });
        }
        continue;
      }

      if (existing) {
        // Stesso giocatore, `connection-time` diverso: si e' riconnesso. La
        // vecchia sessione finisce all'ultimo istante per cui c'e' una prova.
        closing.push({ ...existing, endedAt: existing.lastSeenAt, reason: 'quit' });
        this.#open.delete(p.playerId);
      }

      const fresh: OpenSession = {
        playerId: p.playerId,
        startedAt,
        lastSeenAt: tickAt,
        accountedThrough: startedAt,
        serverIdFirst: serverId,
        serverIdLast: serverId,
        legs: 1,
        seenTicks: 1,
        country: p.country,
        missing: 0,
        dirty: false,
      };
      this.#open.set(p.playerId, fresh);
      opening.push(fresh);
    }

    // Chi c'era e adesso non c'e'. La grazia copre il tick in cui un
    // trasferimento fa sparire la chiave per un attimo.
    for (const [playerId, session] of this.#open) {
      if (players.has(playerId)) continue;
      session.missing += 1;
      if (session.missing > this.#settings.graceTicks) {
        closing.push({ ...session, endedAt: session.lastSeenAt, reason: 'quit' });
        this.#open.delete(playerId);
      }
    }

    // Riconciliazione dopo un riavvio: al primo ciclo riuscito, non prima.
    if (this.#pendingGapCheck) {
      this.#pendingGapCheck = false;
      for (const [playerId, session] of this.#open) {
        if (players.has(playerId)) continue;
        closing.push({ ...session, endedAt: session.lastSeenAt, reason: 'gap' });
        this.#open.delete(playerId);
      }
    }

    // PRIMA si chiude, poi si apre. Una riconnessione chiude e riapre lo
    // STESSO giocatore nello stesso ciclo, e `session_open` ha una riga per
    // giocatore: aprendo per primo, la cancellazione della chiusura porterebbe
    // via la riga appena inserita e la nuova sessione sparirebbe dalla tabella
    // calda — invisibile finche' non si riavvia il processo.
    if (closing.length > 0) await this.#close(db, closing);
    if (opening.length > 0) await this.#persistOpen(db, tickAt, opening);
    // Un trasferimento non apre una sessione ma aggiunge una presenza: senza,
    // gli unici della modalita' di destinazione perderebbero chi ci e'
    // arrivato da un'altra.
    if (moved.length > 0) await this.#persistMoved(db, tickAt, moved);
    if (this.#cycles % FLUSH_EVERY === 0) await this.#flush(db);

    return { opened: opening.length, closed: closing.length };
  }

  /**
   * Chiude le sessioni non piu' viste da troppo tempo.
   *
   * La grazia copre i buchi brevi; questo copre il caso in cui il giocatore e'
   * sparito e nessun tick lo ha piu' mostrato — tipicamente perche' il
   * pannello era fermo. `end_reason` lo distingue: una durata media calcolata
   * su queste sessioni sarebbe una stima, e la vista `v_session_observed` le
   * esclude apposta.
   */
  async reap(db: Database, now: Date): Promise<number> {
    const cutoff = now.getTime() - this.#settings.reaperAfterS * 1_000;
    const closing: Closing[] = [];
    for (const [playerId, session] of this.#open) {
      if (session.lastSeenAt.getTime() > cutoff) continue;
      closing.push({ ...session, endedAt: session.lastSeenAt, reason: 'reaper' });
      this.#open.delete(playerId);
    }
    if (closing.length > 0) await this.#close(db, closing);
    return closing.length;
  }

  /**
   * L'istante di inizio: `connection-time` così com'è.
   *
   * Fuori da 24 ore il valore non e' credibile — un NTP sballato sul server di
   * gioco — e si ripiega sul tick, marcando la sessione come `skew` alla
   * chiusura. Non si clampa il valore buono: si scarta quello impossibile.
   */
  #startOf(p: OnlinePlayer, tickAt: Date): Date {
    if (p.connectionMs === null) return tickAt;
    if (Math.abs(p.connectionMs - tickAt.getTime()) > MAX_SKEW_MS) return tickAt;
    return new Date(p.connectionMs);
  }

  /**
   * Apre le sessioni e segna le presenze del giorno.
   *
   * `player_day` si scrive QUI, all'apertura, e non alla chiusura: cosi'
   * l'unico e' esatto anche per chi la sessione non la chiude mai, e gli unici
   * del giorno vivo non perdono tutti i giocatori ancora connessi.
   */
  async #persistOpen(db: Database, tickAt: Date, sessions: OpenSession[]): Promise<void> {
    await db.transaction().execute(async (tx) => {
      await sql`
        INSERT INTO stats.session_open
          (player_id, started_at, last_seen_at, accounted_through,
           server_id_first, server_id_last, legs, seen_ticks, country)
        SELECT * FROM unnest(
          ${sessions.map((s) => s.playerId)}::int[],
          ${sessions.map((s) => s.startedAt)}::timestamptz[],
          ${sessions.map((s) => s.lastSeenAt)}::timestamptz[],
          ${sessions.map((s) => s.accountedThrough)}::timestamptz[],
          ${sessions.map((s) => s.serverIdFirst)}::smallint[],
          ${sessions.map((s) => s.serverIdLast)}::smallint[],
          ${sessions.map((s) => s.legs)}::smallint[],
          ${sessions.map((s) => s.seenTicks)}::int[],
          ${sessions.map((s) => s.country)}::stats.country_code[])
        -- Una riga gia' presente per lo stesso giocatore non porta un nuovo
        -- inizio: si aggiorna solo cio' che avanza.
        ON CONFLICT (player_id) DO UPDATE SET
          last_seen_at   = EXCLUDED.last_seen_at,
          server_id_last = EXCLUDED.server_id_last,
          seen_ticks     = stats.session_open.seen_ticks + 1
      `.execute(tx);

      // Le sessioni si contano sul giorno in cui INIZIANO, e si contano
      // adesso. Il giorno e' quello civile di Roma ricavato dal tick: nessun
      // timer di mezzanotte, nessuna dipendenza dal fuso del processo.
      await sql`
        INSERT INTO stats.player_day AS t
          (day, player_id, first_seen_at, last_seen_at, sessions, country)
        SELECT stats.civil_day(${tickAt}), x.p, ${tickAt}, ${tickAt}, 1, x.c
          FROM unnest(
            ${sessions.map((s) => s.playerId)}::int[],
            ${sessions.map((s) => s.country)}::stats.country_code[]
          ) AS x(p, c)
        ON CONFLICT (day, player_id) DO UPDATE SET
          first_seen_at = LEAST(t.first_seen_at, EXCLUDED.first_seen_at),
          last_seen_at  = GREATEST(t.last_seen_at, EXCLUDED.last_seen_at),
          sessions      = t.sessions + 1,
          -- VINCE LA PRIMA OSSERVAZIONE DEL GIORNO, e la regola va scritta
          -- perche' senza il conteggio balla: un giocatore su rete mobile che
          -- salta su un PoP diverso riscriverebbe il proprio paese a ogni
          -- riconnessione, e la mappa cambierebbe da sola durante la
          -- giornata. Il COALESCE tiene anche il caso opposto: se la prima
          -- osservazione era a geolocalizzazione spenta (NULL), la seconda la
          -- riempie invece di lasciare un buco per sempre.
          country       = COALESCE(t.country, EXCLUDED.country)
      `.execute(tx);

      await this.#persistServerPresence(
        tx,
        tickAt,
        sessions.map((s) => ({ playerId: s.playerId, serverId: s.serverIdLast })),
      );
    });
  }

  /**
   * Un trasferimento: presenza sul nuovo server e riga calda aggiornata.
   *
   * I trasferimenti sono rari — poche decine al minuto — quindi si scrivono
   * subito invece di aspettare il riversamento periodico: `legs` tenuto solo
   * in memoria si perderebbe al riavvio, e la sessione chiusa dopo un riavvio
   * riporterebbe meno permanenze di quelle vere.
   */
  async #persistMoved(
    db: Database,
    tickAt: Date,
    moved: Array<{ playerId: number; serverId: number }>,
  ): Promise<void> {
    await db.transaction().execute(async (tx) => {
      await this.#persistServerPresence(tx, tickAt, moved);
      await sql`
        UPDATE stats.session_open AS o
           SET server_id_last = x.server_id, legs = o.legs + 1
          FROM unnest(${moved.map((m) => m.playerId)}::int[],
                      ${moved.map((m) => m.serverId)}::smallint[]) AS x(player_id, server_id)
         WHERE o.player_id = x.player_id
      `.execute(tx);
    });
  }

  async #persistServerPresence(
    db: Database,
    tickAt: Date,
    rows: Array<{ playerId: number; serverId: number }>,
  ): Promise<void> {
    if (rows.length === 0) return;
    // Solo PRESENZA: niente secondi, niente sessioni. Attribuire i secondi di
    // una sessione all'ultimo server produce la classifica di cio' che si
    // tocca per ultimo prima di sloggare.
    await sql`
      INSERT INTO stats.player_day_server (day, server_id, player_id)
      SELECT stats.civil_day(${tickAt}), s, p
        FROM unnest(${rows.map((r) => r.serverId)}::smallint[],
                    ${rows.map((r) => r.playerId)}::int[]) AS x(s, p)
      ON CONFLICT DO NOTHING
    `.execute(db);
  }

  /**
   * Chiude, versa i secondi e libera la tabella calda.
   *
   * L'upsert ESTENDE `ended_at` invece di ignorare il conflitto: sotto guasto
   * il reaper puo' aver gia' chiuso la sessione, e con un `DO NOTHING` la
   * seconda meta' sparirebbe senza traccia.
   */
  async #close(db: Database, sessions: Closing[]): Promise<void> {
    await db.transaction().execute(async (tx) => {
      await sql`
        INSERT INTO stats.session AS s
          (started_at, player_id, ended_at, seen_ticks,
           server_id_first, server_id_last, legs, end_reason, country)
        SELECT * FROM unnest(
          ${sessions.map((x) => x.startedAt)}::timestamptz[],
          ${sessions.map((x) => x.playerId)}::int[],
          ${sessions.map((x) => x.endedAt)}::timestamptz[],
          ${sessions.map((x) => x.seenTicks)}::int[],
          ${sessions.map((x) => x.serverIdFirst)}::smallint[],
          ${sessions.map((x) => x.serverIdLast)}::smallint[],
          ${sessions.map((x) => x.legs)}::smallint[],
          ${sessions.map((x) => x.reason)}::stats.session_end[],
          ${sessions.map((x) => x.country)}::stats.country_code[])
        ON CONFLICT (started_at, player_id) DO UPDATE SET
          ended_at   = EXCLUDED.ended_at,
          seen_ticks = EXCLUDED.seen_ticks,
          legs       = EXCLUDED.legs,
          end_reason = EXCLUDED.end_reason
        WHERE EXCLUDED.ended_at > s.ended_at
      `.execute(tx);

      await this.#pour(tx, sessions);

      // Si cancella la sessione CHIUSA, non il giocatore: la coppia
      // (player_id, started_at) e' l'identita' di una sessione, e restringere
      // qui rende la cancellazione innocua qualunque sia l'ordine delle
      // operazioni.
      await sql`
        DELETE FROM stats.session_open AS o
         USING unnest(${sessions.map((x) => x.playerId)}::int[],
                      ${sessions.map((x) => x.startedAt)}::timestamptz[]) AS x(player_id, started_at)
         WHERE o.player_id = x.player_id AND o.started_at = x.started_at
      `.execute(tx);
    });
  }

  /**
   * Versa i secondi in `player_day`, affettati sui giorni civili attraversati.
   *
   * Una sessione a cavallo della mezzanotte deposita su due giorni. Fortuna di
   * progetto: a Roma la mezzanotte non e' mai un'ora ambigua — il cambio e'
   * alle 02:00/03:00 — quindi l'affettatura e' sicura anche nei giorni di ora
   * legale. Vale per Roma, non in generale.
   */
  async #pour(db: Database, sessions: Closing[]): Promise<void> {
    await sql`
      WITH c AS (
        SELECT * FROM unnest(
          ${sessions.map((x) => x.playerId)}::int[],
          ${sessions.map((x) => x.accountedThrough)}::timestamptz[],
          ${sessions.map((x) => x.endedAt)}::timestamptz[],
          ${sessions.map((x) => x.country)}::stats.country_code[]) AS c(player_id, from_at, to_at, country)
        WHERE to_at > from_at
      ),
      slices AS (
        SELECT c.player_id,
               c.country,
               g::date AS day,
               GREATEST(c.from_at, ( g            ::timestamp AT TIME ZONE 'Europe/Rome')) AS lo,
               LEAST   (c.to_at,   ((g + interval '1 day') AT TIME ZONE 'Europe/Rome')) AS hi
          FROM c, generate_series(stats.civil_day(c.from_at)::timestamp,
                                  stats.civil_day(c.to_at)::timestamp,
                                  interval '1 day') g
      )
      INSERT INTO stats.player_day AS t
        (day, player_id, first_seen_at, last_seen_at, seconds_online, country)
      SELECT day, player_id, lo, hi, GREATEST(0, extract(epoch FROM (hi - lo)))::int, country
        FROM slices WHERE hi > lo
      ON CONFLICT (day, player_id) DO UPDATE SET
        first_seen_at  = LEAST(t.first_seen_at, EXCLUDED.first_seen_at),
        last_seen_at   = GREATEST(t.last_seen_at, EXCLUDED.last_seen_at),
        seconds_online = t.seconds_online + EXCLUDED.seconds_online,
        country        = COALESCE(t.country, EXCLUDED.country)
    `.execute(db);
  }

  /**
   * Riversa `last_seen_at` e i secondi maturati delle sessioni ANCORA APERTE.
   *
   * Non a ogni tick: a P=800 sarebbero milioni di versioni di riga al giorno
   * su poche centinaia di righe vive, e un worker di autovacuum incollato a
   * quella tabella per sempre. Ogni venti cicli — dieci minuti — un crash
   * costa al massimo dieci minuti di secondi, che e' quanto `end_reason`
   * dichiara come approssimato.
   */
  async #flush(db: Database): Promise<void> {
    const dirty = [...this.#open.values()].filter((s) => s.dirty);
    if (dirty.length === 0) return;

    await db.transaction().execute(async (tx) => {
      await sql`
        UPDATE stats.session_open AS o SET
          last_seen_at      = x.last_seen_at,
          accounted_through = x.last_seen_at,
          seen_ticks        = x.seen_ticks,
          legs              = x.legs,
          server_id_last    = x.server_id_last
        FROM unnest(
          ${dirty.map((s) => s.playerId)}::int[],
          ${dirty.map((s) => s.lastSeenAt)}::timestamptz[],
          ${dirty.map((s) => s.seenTicks)}::int[],
          ${dirty.map((s) => s.legs)}::smallint[],
          ${dirty.map((s) => s.serverIdLast)}::smallint[]
        ) AS x(player_id, last_seen_at, seen_ticks, legs, server_id_last)
        WHERE o.player_id = x.player_id
      `.execute(tx);

      // I secondi maturati dal segnalibro in poi entrano SUBITO in
      // player_day: senza, il tempo di chi non chiude mai la sessione non
      // comparirebbe fino alla chiusura, e il giorno vivo sarebbe sempre
      // vuoto.
      await this.#pour(
        tx,
        dirty.map((s) => ({ ...s, endedAt: s.lastSeenAt, reason: 'quit' as const })),
      );
    });

    for (const s of dirty) {
      s.accountedThrough = s.lastSeenAt;
      s.dirty = false;
    }
  }
}
