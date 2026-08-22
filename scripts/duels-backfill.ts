// L'importazione dello storico dei duels, a mano e una volta sola.
//
// NON E' UN JOB. Il giro da trenta secondi vive nel pannello e si occupa del
// presente; questo si occupa dei 166 giorni che c'erano gia' prima che il
// pannello esistesse, e gira quando lo si lancia. Tenerli separati significa
// che l'importazione dello storico non puo' rallentare il pannello nemmeno
// per sbaglio: e' un altro processo, con un'altra connessione, in un altro
// momento.
//
// Uso:
//   DATABASE_INGEST_URL=... DUELS_MYSQL_URL=... node scripts/duels-backfill.ts
//
// Si puo' interrompere con Ctrl-C e rilanciare: riprende dal lotto dopo.
// Esce con 1 se i conti con la sorgente non tornano — ed e' quello il segnale
// che conta, non il fatto che sia arrivato in fondo.

import { fileURLToPath } from 'node:url';
import { createKysely, createPool } from '#src/db/pool.ts';
import { type BackfillProgress, PartitionsMissing, runDuelsBackfill } from '#src/duels/backfill.ts';
import { DEFAULT_SOURCE_TZ, WatermarkMoved } from '#src/duels/ingest.ts';
import { BACKFILL_MAX_EXECUTION_MS, createDuelsMysql } from '#src/duels/mysql.ts';

function requireEnv(name: string, hint: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} non impostata (${hint}).`);
    process.exit(2);
  }
  return value;
}

/** Una riga per lotto: si guarda scorrere, e dice se sta rallentando. */
function printProgress(p: BackfillProgress): void {
  const what = p.source === 'match' ? 'partite' : 'valutazioni';
  console.log(
    `  ${what} lotto ${p.batch}: +${p.read} (totale ${p.total}) ` + `fino a id ${p.lastId} in ${p.ms} ms`,
  );
}

function line(label: string, source: number, stored: number, ok: boolean, extra = ''): string {
  const verdict = ok ? 'ok' : 'NON TORNA';
  return `${label}: sorgente ${source}, importate ${stored}${extra} — ${verdict}`;
}

async function main(): Promise<void> {
  const databaseUrl = requireEnv('DATABASE_INGEST_URL', 'ruolo di scrittura su stats, non metamc_app');
  const mysqlUrl = requireEnv('DUELS_MYSQL_URL', 'sola lettura sul MySQL del gioco');
  // Il fuso della sorgente: un FUSO, non un offset. Vedi `DEFAULT_SOURCE_TZ`.
  const tz = process.env['DUELS_SOURCE_TZ'] ?? DEFAULT_SOURCE_TZ;

  const pool = createPool({
    connectionString: databaseUrl,
    // Il giro e' sequenziale: una connessione lavora, la seconda non serve
    // quasi mai ma evita che una riconnessione fermi tutto.
    max: 2,
    applicationName: 'metamc-duels-backfill',
    // Un lotto scrive fino a diecimila righe aggregate e ricalcola i giorni
    // toccati: non e' il percorso di richiesta e non ha i suoi tempi.
    statementTimeout: '120s',
    searchPath: 'stats, public',
  });
  const db = createKysely(pool);
  // Il tetto lungo: la verifica finale conta due milioni e mezzo di righe
  // apposta, ed e' l'unica lettura pesante che questo processo fa.
  const my = createDuelsMysql(mysqlUrl, BACKFILL_MAX_EXECUTION_MS);

  try {
    console.log('importazione storico duels: inizio.');
    const report = await runDuelsBackfill(db, my, { onProgress: printProgress, tz });

    if (report.resumedFrom.match !== '0' || report.resumedFrom.rating !== '0') {
      console.log(
        `ripreso da: partite id ${report.resumedFrom.match}, valutazioni id ${report.resumedFrom.rating}.`,
      );
    }
    console.log(`catalogo: ${report.modes} modalita', ${report.maps} mappe.`);
    console.log(line('partite', report.matches.source, report.matches.stored, report.matches.ok));
    console.log(
      line(
        'valutazioni',
        report.ratings.source,
        report.ratings.stored,
        report.ratings.ok,
        report.ratings.discarded > 0 ? `, ${report.ratings.discarded} scartate` : '',
      ),
    );
    console.log(
      `aggregato giornaliero: ${report.days.stored} voti su ${report.days.expected} righe — ` +
        (report.days.ok ? 'ok' : 'NON TORNA'),
    );
    console.log(`durata: ${(report.ms / 1000).toFixed(1)} s.`);

    if (!report.ok) {
      // Il messaggio dice cosa fare, perche' chi lo legge lo legge di notte.
      console.error(
        '\nI CONTI NON TORNANO: lo storico importato non coincide con la sorgente.\n' +
          "Non accendere DUELS_INGEST_ENABLED finche' non si sa perche'.\n" +
          "Se le partite importate sono PIU' di quelle alla sorgente, il backfill ha girato " +
          'due volte sullo stesso intervallo: svuotare stats.duels_match_hour, riportare a ' +
          'zero il watermark della sorgente «match», e rifarlo da capo.',
      );
      process.exit(1);
    }
    console.log('\nstorico importato e verificato contro la sorgente.');
  } catch (err) {
    if (err instanceof PartitionsMissing) {
      console.error(err.message);
      process.exit(3);
    }
    if (err instanceof WatermarkMoved) {
      console.error(
        `${err.message}\nIl pannello sta ingerendo mentre questo importa. ` +
          "Spegnere DUELS_INGEST_ENABLED, rilanciare, riaccenderlo dopo: niente e' andato " +
          "perso, il lotto in conflitto e' tornato indietro intero.",
      );
      process.exit(4);
    }
    throw err;
  } finally {
    await my.close().catch(() => undefined);
    await db.destroy();
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
