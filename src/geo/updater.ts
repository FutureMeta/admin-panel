// L'aggiornamento del database geografico. Fase 2, §8.3 — passo 7.
//
// SORGENTE: DB-IP «IP to Country Lite», formato MMDB, licenza CC BY 4.0.
// Scelta su un criterio solo: e' l'unica gratuita che sia insieme SENZA
// ShareAlike, SENZA account e con un URL costruibile da un job. Lo ShareAlike
// (GeoLite2, IPinfo Lite, IP2Location LITE) copre anche i «database adattati»,
// e le tabelle aggregate sono derivate riga per riga dal database: CC BY 4.0
// chiude la questione senza doverla argomentare. GeoLite2 imporrebbe in piu'
// di distruggere le versioni superate entro trenta giorni da ogni rilascio,
// cioe' vieterebbe di congelare il file.
//
// ATTRIBUZIONE OBBLIGATORIA: «IP Geolocation by DB-IP» va nel footer della
// schermata mappa, non nel README. E' il requisito che si dimentica, e arriva
// col passo 8 insieme alla mappa.
//
// UN FALLIMENTO NON E' FATALE. Il reader in memoria resta quello di prima: un
// database di ieri e' preferibile a nessun database, e molto preferibile a uno
// scaricato a meta'. Per questo si valida su file temporaneo e si promuove con
// un rename, che e' atomico: non esiste un istante in cui il file di
// destinazione e' mezzo scritto.

import { createWriteStream } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import type { Logger } from 'pino';
import { GeoReader } from './reader.ts';

const BASE = 'https://download.db-ip.com/free';

/** Oltre questa eta' il database e' da considerare vecchio: §8.3. */
export const MAX_AGE_DAYS = 45;

/** `dbip-country-lite-2026-08.mmdb.gz` */
function urlFor(year: number, month: number): string {
  return `${BASE}/dbip-country-lite-${year}-${String(month).padStart(2, '0')}.mmdb.gz`;
}

/**
 * Il mese corrente e quello precedente.
 *
 * Il file di settembre non esiste il 1° settembre alle 00:01, e un job che
 * provasse solo il mese corrente fallirebbe ogni primo del mese — cioe'
 * proprio quando c'e' la versione nuova da prendere.
 */
export function candidateUrls(now: Date): string[] {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;
  return [urlFor(y, m), urlFor(prevY, prevM)];
}

export type UpdateResult = {
  /** Falso quando il database in uso era gia' quello giusto. */
  downloaded: boolean;
  url: string | null;
  bytes: number;
  ageDays: number | null;
  ms: number;
};

export type UpdateOptions = {
  path: string;
  reader: GeoReader;
  logger: Logger;
  now?: Date;
  /** Iniettabile nei test: nessuna chiamata reale esce durante la suite. */
  fetchImpl?: typeof fetch;
};

/**
 * Scarica, valida e promuove. Solleva se non e' riuscita.
 *
 * Chi la chiama e' `startJob`, che trasforma il sollevamento in una riga di
 * log e in un contatore: cosi' «il database geografico non si aggiorna da
 * settimane» diventa una cosa che si vede, invece di un numero che smette
 * lentamente di essere vero.
 */
export async function updateGeoDb(opts: UpdateOptions): Promise<UpdateResult> {
  const t0 = Date.now();
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? new Date();
  const tmp = join(dirname(opts.path), '.country.mmdb.tmp');

  let lastError = 'nessun tentativo';
  for (const url of candidateUrls(now)) {
    let response: Response;
    try {
      response = await doFetch(url);
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'richiesta fallita';
      continue;
    }
    if (!response.ok || !response.body) {
      // 404 sul mese corrente e' NORMALE nei primi giorni: si prova il
      // precedente senza alzare la voce.
      lastError = `HTTP ${response.status} su ${url}`;
      continue;
    }

    try {
      // Scompattato direttamente su disco: il file supera i sette megabyte e
      // tenerlo in memoria insieme al database gia' caricato non serve a
      // niente.
      await pipeline(response.body, createGunzip(), createWriteStream(tmp));

      // SI VALIDA PRIMA DI PROMUOVERE. Un file troncato a meta' download, o un
      // city database messo li' per sbaglio, non deve mai diventare quello in
      // uso: qui si apre con un lettore usa e getta, e se non sa dove sta
      // 8.8.8.8 non arriva alla destinazione.
      const probe = new GeoReader();
      const status = await probe.load(tmp);
      const bytes = (await stat(tmp)).size;

      // Rename e non copia: atomico, quindi nessun istante in cui il file di
      // destinazione e' mezzo scritto e un riavvio lo troverebbe rotto.
      await rename(tmp, opts.path);
      await opts.reader.load(opts.path);

      return { downloaded: true, url, bytes, ageDays: status.ageDays, ms: Date.now() - t0 };
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      lastError = err instanceof Error ? err.message : 'scompattazione o validazione fallita';
    }
  }

  throw new Error(`aggiornamento del database geografico non riuscito: ${lastError}`);
}
