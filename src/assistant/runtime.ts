// Tutto cio' che l'assistente ha di vivo, costruito una volta all'avvio.
//
// STA IN UN FILE SUO e non dentro `app-context.ts` per la stessa ragione per
// cui ci sta il resto: la radice di composizione deve poter dire «l'assistente
// e' questo oggetto oppure e' `null`» in due righe, senza portarsi dietro
// quattro campi che solo lui usa.
//
// SPENTO E' UNO STATO NORMALE. Senza `ANTHROPIC_API_KEY` non si costruisce
// niente, non si apre nessuna connessione e la rotta risponde 503: e'
// esattamente il comportamento delle statistiche senza il loro ruolo di
// lettura, ed e' quello che permette di installare il pannello senza dover
// prima decidere se si vuole un assistente.

import type { Anthropic } from '@anthropic-ai/sdk';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import type { Env } from '#src/config/env.ts';
import type { Database } from '#src/db/pool.ts';
import { createKysely, createPool } from '#src/db/pool.ts';
import type { DuelsProvider } from '#src/duels/provider.ts';
import type { StatsCache } from '#src/stats/cache.ts';
import type { Effort } from './config.ts';
import { AssistantMeter } from './metrics.ts';
import type { AssistantData } from './reader.ts';
import { createAnthropic } from './runner.ts';
import { ConversationStore, SpendLedger } from './store.ts';

export type AssistantRuntime = {
  client: Anthropic;
  data: AssistantData;
  conversations: ConversationStore;
  spend: SpendLedger;
  meter: AssistantMeter;
  effort: Effort;
  close: () => Promise<void>;
};

export type AssistantDeps = {
  env: Env;
  /** Il Redis PRINCIPALE: la cronologia e il contatore di spesa non vanno sfrattati. */
  redis: Redis;
  statsDb: Database | null;
  duels: DuelsProvider | null;
  cache: StatsCache;
};

export function createAssistant(deps: AssistantDeps): AssistantRuntime | null {
  const key = deps.env.ANTHROPIC_API_KEY;
  if (!key) return null;

  // Il pool di sola lettura su `auth` e `audit`. Puo' mancare: i due tool che
  // guardano il pannello rispondono «non disponibile» e gli altri tre
  // funzionano lo stesso. Meta' assistente e' meglio di nessun assistente, e
  // molto meglio di un assistente che legge con il ruolo che scrive.
  let panelPool: pg.Pool | null = null;
  if (deps.env.DATABASE_ASSISTANT_URL) {
    panelPool = createPool({
      connectionString: deps.env.DATABASE_ASSISTANT_URL,
      // DUE connessioni. I tool di questo pool sono due, girano uno alla
      // volta dentro una conversazione, e le conversazioni contemporanee su
      // un pannello di staff si contano sulle dita. Un pool largo qui
      // sarebbe capacita' ferma sottratta al resto.
      max: 2,
      applicationName: 'metamc-assistant-read',
      // Anche sul pool, non solo sul ruolo: chi legge il file deve vedere il
      // tetto senza dover andare a guardare `pg_roles`.
      statementTimeout: '10s',
    });
  }

  const data: AssistantData = {
    panelDb: panelPool ? createKysely(panelPool) : null,
    statsDb: deps.statsDb,
    duels: deps.duels,
    cache: deps.cache,
  };

  const runtime: AssistantRuntime = {
    client: createAnthropic(key, deps.env.ASSISTANT_TIMEOUT_MS),
    data,
    conversations: new ConversationStore(deps.redis),
    spend: new SpendLedger(deps.redis, deps.env.ASSISTANT_MONTHLY_BUDGET_USD),
    meter: new AssistantMeter(),
    effort: deps.env.ASSISTANT_EFFORT,
    close: async () => {
      await data.panelDb?.destroy().catch(() => undefined);
    },
  };
  return runtime;
}
