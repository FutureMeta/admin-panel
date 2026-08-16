// Entrypoint. §5.1, §13
//
// UV_THREADPOOL_SIZE va impostata PRIMA che libuv inizializzi il pool, cioe'
// prima di qualunque operazione asincrona di fs, dns o crypto. Impostarla piu'
// tardi non ha effetto e il processo gira per sempre con i 4 thread di
// default, che e' esattamente il problema che il §5.1 descrive.

import { fileURLToPath } from 'node:url';
import closeWithGrace from 'close-with-grace';
import { buildContext } from '#src/app-context.ts';
import { parseEnv } from '#src/config/env.ts';
import { InMemoryMailer, type Mailer, ResendMailer } from '#src/email/mailer.ts';
import { loadIndexHtml } from '#src/http/index-html.ts';
import { createLogger } from '#src/http/logger.ts';
import { buildServer } from '#src/http/server.ts';

const env = parseEnv();

// Il valore arriva da env perche' il numero di core reali lo conosce chi
// dimensiona la macchina, non il processo.
if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = String(env.UV_THREADPOOL_SIZE);
}

const logger = createLogger(env.LOG_LEVEL, env.NODE_ENV !== 'production');

const mailer: Mailer =
  env.RESEND_API_KEY !== undefined
    ? new ResendMailer({ apiKey: env.RESEND_API_KEY, from: env.MAIL_FROM, logger })
    : // Senza API key non si spedisce: in sviluppo le email finiscono in
      // memoria e si leggono dai log. In produzione la validazione dell'env
      // deve garantirne la presenza, e il runbook lo dice.
      new InMemoryMailer();

if (env.NODE_ENV === 'production' && !env.RESEND_API_KEY) {
  logger.error('RESEND_API_KEY assente in produzione: gli inviti non partiranno.');
}

const indexHtmlPath = fileURLToPath(new URL('../../dist/index.html', import.meta.url));
const indexHtml = loadIndexHtml(indexHtmlPath);
logger.info({ slots: indexHtml.slots }, 'index.html caricato in memoria e pre-splittato');

const ctx = await buildContext({ env, mailer, indexHtml, logger });
const app = await buildServer(ctx);

await app.listen({ host: env.HOST, port: env.PORT });
logger.info(
  {
    host: env.HOST,
    port: env.PORT,
    threadpool: process.env.UV_THREADPOOL_SIZE,
    argon2Limit: ctx.semaphore.limit,
  },
  'MetaMC Admin avviato',
);

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
