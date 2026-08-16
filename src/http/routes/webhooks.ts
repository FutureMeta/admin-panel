// Webhook Resend. SEC-19, §17.5
//
// La rotta e' ESCLUSA da SEC-15/16/17 (Origin, Sec-Fetch-Site, CSRF): e'
// server-to-server, non ha un'origine da confrontare ne' una sessione da cui
// derivare un token. Al loro posto ci sono due controlli:
//   1. verifica della firma Svix sul RAW BODY (lo SPIKE-5 ha misurato che
//      riparsare il JSON rompe la firma: e' il test 17)
//   2. dedupe su `svix-id`, perche' i webhook si ripetono per progetto e una
//      consegna doppia non deve produrre due effetti

import type { FastifyInstance } from 'fastify';
import { Resend } from 'resend';
import { z } from 'zod';
import type { AppContext } from '#src/app-context.ts';
import { KEYS } from '#src/redis/client.ts';

/**
 * Zod QUI e' corretto (§0.7): il payload arriva da un servizio terzo e viene
 * validato DOPO la verifica della firma, non al confine HTTP. Al confine HTTP
 * valida AJV attraverso i JSON Schema di Fastify.
 */
const ResendEvent = z.object({
  type: z.string().max(64),
  created_at: z.string().optional(),
  data: z
    .object({
      email_id: z.string().max(128).optional(),
      to: z.union([z.string(), z.array(z.string())]).optional(),
    })
    .passthrough(),
});

const DEDUPE_TTL_SECONDS = 86_400;

export async function registerWebhookRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const secret = ctx.env.RESEND_WEBHOOK_SECRET;
  // La verifica della firma non chiama la rete: serve un client, non una
  // API key valida.
  const verifier = new Resend(ctx.env.RESEND_API_KEY ?? 're_verifica_firma_soltanto');

  app.post('/webhooks/resend', { bodyLimit: 65_536 }, async (request, reply) => {
    if (!secret) {
      // Senza segreto configurato non si accetta nulla: un webhook non
      // verificato e' solo un endpoint che chiunque puo' chiamare.
      request.log.warn('webhook Resend ricevuto ma RESEND_WEBHOOK_SECRET non e` configurato');
      return reply.code(503).send({ error: 'not_configured' });
    }

    const raw = request.rawBody;
    if (!raw || !Buffer.isBuffer(raw)) {
      request.log.error('raw body assente sul webhook: il content-type parser non ha ramificato');
      return reply.code(400).send({ error: 'bad_request' });
    }

    // Resend manda gli header sia con prefisso `svix-` (storico) sia con
    // `webhook-` (Standard Webhooks). Si accettano entrambi, con lo stesso
    // significato: e' lo stesso schema di firma.
    const header = (a: string, b: string): string | undefined => {
      const v = request.headers[a] ?? request.headers[b];
      return typeof v === 'string' ? v : undefined;
    };
    const svixId = header('svix-id', 'webhook-id');
    const svixTimestamp = header('svix-timestamp', 'webhook-timestamp');
    const svixSignature = header('svix-signature', 'webhook-signature');
    if (!svixId || !svixTimestamp || !svixSignature) {
      return reply.code(400).send({ error: 'bad_request' });
    }

    // 1. firma sul RAW BODY. `resend.webhooks.verify` incapsula
    //    standardwebhooks: niente `svix` come dipendenza separata (§3.5).
    let payload: unknown;
    try {
      payload = verifier.webhooks.verify({
        webhookSecret: secret,
        // La stringa passata e' il RAW: `raw.toString('utf8')` sui byte
        // ricevuti, non `JSON.stringify` di un oggetto riparsato. La
        // differenza e' il test 17.
        payload: raw.toString('utf8'),
        headers: { id: svixId, timestamp: svixTimestamp, signature: svixSignature },
      });
    } catch {
      request.log.warn({ svixId }, 'firma webhook Resend non valida');
      return reply.code(400).send({ error: 'bad_request' });
    }

    // 2. dedupe. `SET NX` e' l'intero meccanismo: la seconda consegna trova la
    //    chiave e non fa nulla.
    const first = await ctx.redis.set(KEYS.webhookSeen(svixId), '1', 'EX', DEDUPE_TTL_SECONDS, 'NX');
    if (first === null) {
      return reply.send({ ok: true, duplicate: true });
    }

    const parsed = ResendEvent.safeParse(payload);
    if (!parsed.success) {
      request.log.warn({ svixId }, 'payload webhook Resend non riconosciuto');
      return reply.send({ ok: true, ignored: true });
    }

    const event = parsed.data;
    const emailId = event.data.email_id;

    // In fase 1 il webhook serve a una cosa sola: sapere se l'email di invito
    // e' arrivata. Nessuna azione di dominio dipende da questo evento — un
    // servizio terzo non deve poter cambiare lo stato del pannello.
    if (emailId && (event.type === 'email.delivered' || event.type === 'email.bounced')) {
      const invite = await ctx.db
        .selectFrom('auth.invitation')
        .select(['id', 'email_lower'])
        .where('resend_message_id', '=', emailId)
        .executeTakeFirst();

      if (invite) {
        request.log.info({ inviteId: invite.id, type: event.type }, 'esito consegna invito');
      }
    }

    return reply.send({ ok: true });
  });
}
