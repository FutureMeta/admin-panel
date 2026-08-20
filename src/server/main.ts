// Entrypoint. §5.1, §13
//
// UV_THREADPOOL_SIZE va impostata PRIMA che libuv inizializzi il pool, cioe'
// prima di qualunque operazione asincrona di fs, dns o crypto. Impostarla piu'
// tardi non ha effetto e il processo gira per sempre con i 4 thread di
// default, che e' esattamente il problema che il §5.1 descrive.

import { fileURLToPath } from 'node:url';
import closeWithGrace from 'close-with-grace';
import { buildContext, startStatsWarming } from '#src/app-context.ts';
import { parseEnv } from '#src/config/env.ts';
import { InMemoryMailer, type Mailer, ResendMailer } from '#src/email/mailer.ts';
import { loadIndexHtml } from '#src/http/index-html.ts';
import { createLogger } from '#src/http/logger.ts';
import { buildServer } from '#src/http/server.ts';
import { startEventLoopMonitor } from '#src/observability/event-loop.ts';
import { currentBranch, currentCommit } from './version.ts';

const env = parseEnv();

// Il valore arriva da env perche' il numero di core reali lo conosce chi
// dimensiona la macchina, non il processo.
if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = String(env.UV_THREADPOOL_SIZE);
}

const logger = createLogger(env.LOG_LEVEL, env.NODE_ENV !== 'production');

/**
 * Senza API key non si spedisce.
 *
 * In sviluppo le email restano in memoria e il link viene stampato sul
 * terminale: è l'unico modo di provare il flusso di invito senza un dominio
 * verificato. SEC-43 vieta di loggare token, e quella regola resta valida —
 * la stampa avviene SOLO fuori produzione, e in produzione questo ramo non
 * viene nemmeno costruito.
 */
function createDevMailer(): Mailer {
  const memory = new InMemoryMailer();
  return {
    async send(request) {
      const result = await memory.send(request);
      const link = /https?:\/\/\S+/.exec(request.text)?.[0];
      // `process.stdout` e non `console`: questa e' un'uscita destinata a
      // essere letta da chi sviluppa, non una traccia di debug dimenticata.
      const lines = [
        '',
        `  [email di sviluppo] a: ${request.to}`,
        `  soggetto: ${request.subject}`,
        ...(link ? [`  link:     ${link}`] : []),
        '',
        '',
      ];
      process.stdout.write(lines.join('\n'));
      return result;
    },
  };
}

const mailer: Mailer =
  env.RESEND_API_KEY !== undefined
    ? new ResendMailer({ apiKey: env.RESEND_API_KEY, from: env.MAIL_FROM, logger })
    : env.NODE_ENV === 'production'
      ? new InMemoryMailer()
      : createDevMailer();

if (env.NODE_ENV === 'production' && !env.RESEND_API_KEY) {
  logger.error('RESEND_API_KEY assente in produzione: gli inviti non partiranno.');
}

const indexHtmlPath = fileURLToPath(new URL('../../dist/index.html', import.meta.url));
const indexHtml = loadIndexHtml(indexHtmlPath);
logger.info({ slots: indexHtml.slots }, 'index.html caricato in memoria e pre-splittato');

// RATE_LIMIT_IN_MEMORY: scorciatoia di SVILUPPO per le macchine senza un Redis
// vero. Il server RESP2 minimale non implementa EVAL, e rate-limiter-flexible
// su Redis gira uno script Lua. La politica non cambia: cambia dove sta il
// contatore — che in produzione deve essere condiviso, e infatti li' la
// scorciatoia è vietata.
const rateLimitInMemory = process.env.RATE_LIMIT_IN_MEMORY === '1';
if (rateLimitInMemory && env.NODE_ENV === 'production') {
  throw new Error(
    'RATE_LIMIT_IN_MEMORY non è ammessa in produzione: un contatore per-processo non è un limite condiviso.',
  );
}

// Il ritardo dell'event loop si misura sul processo intero, e va acceso prima
// di qualunque lavoro: e' cio' su cui il giro di warm decide se rimandare una
// compressione, ed e' l'unica metrica che lega quel giro alla latenza di login.
startEventLoopMonitor();

// `startJobs`: i quattro lavori periodici partono con il server e si
// fermano con `ctx.close()`. Il primo giro di ognuno e' immediato, perche' le
// partizioni servono prima della prima scrittura e l'integrita' va saputa
// subito, non fra ventiquattro ore.
const ctx = await buildContext({
  env,
  mailer,
  indexHtml,
  logger,
  rateLimitInMemory,
  startJobs: true,
});
const app = await buildServer(ctx);

await app.listen({ host: env.HOST, port: env.PORT });
logger.info(
  {
    host: env.HOST,
    port: env.PORT,
    threadpool: process.env.UV_THREADPOOL_SIZE,
    // Quale versione sta girando: due rilasci di fila non hanno attecchito e
    // ce ne siamo accorti dal comportamento invece che da una riga di log.
    commit: currentCommit(),
    branch: currentBranch(),
    argon2Limit: ctx.semaphore.limit,
  },
  'MetaMC Admin avviato',
);

// Il riempimento della cache statistiche parte ADESSO, a porta gia' aperta e
// senza essere atteso: /health/ready non deve mai dipendere da un rollup.
startStatsWarming(ctx);

// §13 — SIGTERM: readiness a 503 SUBITO, poi drenaggio.
//
// L'ordine conta. Se il drenaggio iniziasse prima di far cadere la readiness,
// il load balancer continuerebbe a mandare richieste a un processo che sta
// chiudendo, e quelle richieste morirebbero a meta'.
closeWithGrace({ delay: 15_000, logger }, async ({ signal, err }) => {
  if (err) logger.error({ err }, 'chiusura per errore');
  else logger.info({ signal }, 'chiusura richiesta');

  ctx.shuttingDown.value = true;
  // Un istante perche' la sonda successiva veda il 503 prima che le
  // connessioni comincino a cadere.
  await new Promise((r) => setTimeout(r, 500));

  await app.close();
  await ctx.close();
  logger.info('chiusura completata');
});
