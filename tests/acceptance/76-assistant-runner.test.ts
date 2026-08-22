// Il ciclo: la richiesta che costruiamo e gli eventi che ne escono.
//
// Il modello non si prova. Si prova cio' che sta intorno, che e' tutto nostro:
// dove cadono i punti di cache, cosa finisce nel canale di sistema, come si
// comporta un turno in pausa, cosa succede quando il tetto di iterazioni morde.
//
// Sono le quattro cose che, sbagliate, non producono nessun errore: una cache
// che non lavora si vede solo in bolletta, un turno in pausa non ripreso e' una
// risposta troncata senza avviso, e un tetto che morde in silenzio e' una
// risposta incompleta che sembra completa.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_ITERATIONS } from '#src/assistant/config.ts';
import { SYSTEM_PROMPT } from '#src/assistant/prompt.ts';
import type { AssistantData } from '#src/assistant/reader.ts';
import { type AssistantEvent, type RunResult, runAssistant } from '#src/assistant/runner.ts';
import { UNSUPPORTED_BY_STRICT } from '#src/assistant/tools.ts';
import type { AuthzContext } from '#src/authz/context.ts';
import { type Level, MODULES, type ModuleKey } from '#src/authz/modules.ts';
import { StatsCache } from '#src/stats/cache.ts';
import { emptyCapture, type FakeTurn, fakeAnthropic } from '#tests/support/fake-anthropic.ts';
import { type RedisHarness, startRedis } from '#tests/support/redis.ts';

let redis: RedisHarness;

beforeAll(async () => {
  redis = await startRedis();
});
afterAll(async () => {
  await redis?.stop();
});

function actorWith(permissions: Partial<Record<ModuleKey, Level>>): AuthzContext {
  const full = Object.fromEntries(MODULES.map((m) => [m, permissions[m] ?? 0])) as Record<ModuleKey, Level>;
  return {
    userId: 'u-1',
    sessionId: 's-1',
    permissions: full,
    permissionsVersion: 1,
    aal: 2,
    authenticatedAt: new Date(),
    actorEmail: 'attore@metamc.it',
    actorDisplayName: 'Attore',
  };
}

function data(): AssistantData {
  // Nessuna sorgente: i tool rispondono «non disponibile». Qui si prova il
  // ciclo, non le letture — quelle hanno il loro file.
  return { panelDb: null, statsDb: null, duels: null, cache: new StatsCache({ redis: redis.client() }) };
}

const NOW = new Date('2026-08-23T12:00:00Z');

type Run = { events: AssistantEvent[]; result: RunResult; capture: ReturnType<typeof emptyCapture> };

async function run(
  script: FakeTurn[],
  opts: {
    actor?: AuthzContext;
    text?: string;
    history?: RunResult['turns'];
  } = {},
): Promise<Run> {
  const capture = emptyCapture();
  const client = fakeAnthropic(script, capture);
  const generator = runAssistant(
    {
      client,
      data: data(),
      effort: 'medium',
      logger: { error: () => undefined, warn: () => undefined } as never,
      signal: new AbortController().signal,
    },
    {
      conversationId: 'c-1',
      actor: opts.actor ?? actorWith({ statistiche: 1 }),
      text: opts.text ?? 'quanti giocatori ci sono adesso?',
      page: { path: '/panoramica', title: 'Panoramica network', range: '24h' },
      history: opts.history ?? [],
      now: NOW,
    },
  );

  const events: AssistantEvent[] = [];
  for (;;) {
    const step = await generator.next();
    if (step.done) return { events, result: step.value, capture };
    events.push(step.value);
  }
}

describe('la richiesta e` costruita perche` la cache possa lavorare', () => {
  it('il prompt di sistema porta il punto di cache, e non cambia mai', async () => {
    const { capture } = await run([{ text: 'ciao' }]);
    const system = capture.params?.system as Array<Record<string, unknown>>;
    expect(system[0]?.text).toBe(SYSTEM_PROMPT);
    // Punto numero uno: copre i tool e il prompt, che sono la parte piu'
    // grossa e piu' stabile della richiesta.
    expect(system[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('il turno dell`utente porta il secondo punto di cache', async () => {
    const { capture } = await run([{ text: 'ciao' }]);
    const messages = capture.params?.messages as Array<{ role: string; content: unknown }>;
    const user = messages.find(({ role }) => role === 'user');
    const blocks = user?.content as Array<Record<string, unknown>>;
    // Copre cronologia e domanda: e' il prefisso che il ciclo dei tool
    // rimanda identico a ogni iterazione, quindi si paga una volta sola anche
    // dentro la stessa risposta.
    expect(blocks[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('il contesto variabile sta DOPO, fuori dalla cache', async () => {
    const { capture } = await run([{ text: 'ciao' }]);
    const messages = capture.params?.messages as Array<{ role: string; content: unknown }>;
    const { role: lastRole, content } = messages.at(-1) ?? { role: '', content: '' };
    expect(lastRole).toBe('system');
    expect(String(content)).toContain('Panoramica network');
    // Nessun punto di cache qui: l'ora cambia a ogni messaggio, e un punto di
    // cache su qualcosa che cambia sempre e' una scrittura pagata e mai letta.
    expect(String(content)).not.toContain('cache_control');
  });

  it('i tool sono in ordine alfabetico, sempre lo stesso', async () => {
    const { capture } = await run([{ text: 'ciao' }]);
    const tools = capture.params?.tools as Array<{ name: string }>;
    const names = tools.map((t) => t.name);
    expect(names).toEqual([...names].sort());
    // I tool stanno in posizione zero del prefisso: riordinarli invalida la
    // cache di ogni conversazione in corso.
    expect(names).toEqual([
      'audit_recent',
      'duels_summary',
      'network_online',
      'network_trend',
      'panel_user_search',
    ]);
  });

  it('ogni tool ha uno schema `strict` e chiuso', async () => {
    const { capture } = await run([{ text: 'ciao' }]);
    const tools = capture.params?.tools as Array<Record<string, unknown>>;
    for (const tool of tools) {
      expect(tool.strict).toBe(true);
      const schema = tool.input_schema as Record<string, unknown>;
      expect(schema.additionalProperties).toBe(false);
      // `strict` vuole ogni proprieta' dichiarata anche fra le obbligatorie:
      // un parametro facoltativo diventa un ramo che il modello puo'
      // sorprenderci a prendere.
      const declared = Object.keys((schema.properties ?? {}) as object).sort();
      const required = [...((schema.required ?? []) as string[])].sort();
      expect(required).toEqual(declared);
    }
  });

  it('e nessuno schema usa parole che `strict` non accetta', async () => {
    // IL 400 CHE HA FERMATO IL PRIMO MESSAGGIO IN PRODUZIONE, il 2026-08-23:
    //
    //   tools.0.custom: For 'integer' type, properties maximum, minimum are
    //   not supported
    //
    // `strict: true` accetta un SOTTOINSIEME di JSON Schema. Un vincolo di
    // valore dentro lo schema non rende la richiesta piu' severa: la fa
    // rifiutare intera, e la chat non parte affatto. I limiti stanno nel
    // codice dei tool, dove per giunta non si possono aggirare.
    //
    // L'elenco e' di NEGAZIONE, come le altre guardie del progetto: non prova
    // che lo schema sia valido — quello lo dice solo l'API — impedisce di
    // ripetere questa classe esatta di errore.
    const { capture } = await run([{ text: 'ciao' }]);
    const tools = capture.params?.tools as Array<Record<string, unknown>>;

    const trovate: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const [i, child] of node.entries()) walk(child, `${path}[${i}]`);
        return;
      }
      for (const [key, value] of Object.entries(node)) {
        if ((UNSUPPORTED_BY_STRICT as readonly string[]).includes(key)) trovate.push(`${path}.${key}`);
        walk(value, `${path}.${key}`);
      }
    };
    for (const tool of tools) walk(tool.input_schema, String(tool.name));

    expect(trovate).toEqual([]);
  });

  it('modello, pensiero, profondita` e ripiego sono quelli decisi', async () => {
    const { capture } = await run([{ text: 'ciao' }]);
    expect(capture.params?.model).toBe('claude-opus-5');
    // Adattivo: sul modello corrente un budget fisso di token e' un 400.
    expect(capture.params?.thinking).toEqual({ type: 'adaptive' });
    // La profondita' si regola con l'effort, non con la temperatura — che su
    // questo modello non esiste piu'.
    expect(capture.params?.output_config).toEqual({ effort: 'medium' });
    expect(capture.params?.temperature).toBeUndefined();
    expect(capture.params?.fallbacks).toBe('default');
    expect(capture.params?.betas).toContain('server-side-fallback-2026-07-01');
    expect(capture.params?.max_iterations).toBe(MAX_ITERATIONS);
  });
});

describe('la cronologia non porta in giro i messaggi di sistema', () => {
  it('quelli vecchi si buttano: si rigenerano a ogni richiesta', async () => {
    const history = [
      { role: 'user', content: [{ type: 'text', text: 'e ieri?' }] },
      { role: 'system', content: 'Sta guardando: una schermata di tre ore fa' },
      { role: 'assistant', content: [{ type: 'text', text: 'ieri erano 900' }] },
    ] as unknown as RunResult['turns'];

    const { capture, result } = await run([{ text: 'ok' }], { history });
    const messages = capture.params?.messages as Array<{ role: string }>;
    // Uno solo, ed e' quello nuovo in coda.
    expect(messages.filter(({ role }) => role === 'system')).toHaveLength(1);
    expect(messages.at(-1)).toMatchObject({ role: 'system' });
    // E nemmeno si riconserva: la cronassa che si salva e' fatta di turni,
    // non di contesto scaduto.
    expect(result.turns.some(({ role }) => role === 'system')).toBe(false);
  });
});

describe('i tool si eseguono davvero, e l`esito arriva al browser', () => {
  it('un tool negato non porta dati, e la chat lo mostra', async () => {
    const { events, capture } = await run(
      [
        { toolUses: [{ id: 't1', name: 'panel_user_search', input: { query: 'mario', limit: 3 } }] },
        { text: 'Non ho accesso agli utenti del pannello.' },
      ],
      { actor: actorWith({ statistiche: 1 }) },
    );

    expect(capture.toolResults[0]).toContain('permesso_negato');
    const tool = events.filter((e) => e.type === 'tool');
    expect(tool.map((e) => e.outcome)).toEqual(['running', 'denied']);
    // Il testo che il browser riceve e' quello del turno finale, a pezzi.
    const text = events
      .filter((e) => e.type === 'text')
      .map((e) => e.delta)
      .join('');
    expect(text).toBe('Non ho accesso agli utenti del pannello.');
  });

  it('una sorgente spenta e` un esito, non un`eccezione', async () => {
    const { events, capture } = await run([
      { toolUses: [{ id: 't1', name: 'network_online', input: {} }] },
      { text: 'Le statistiche non sono configurate.' },
    ]);
    expect(capture.toolResults[0]).toContain('non_disponibile');
    expect(events.filter((e) => e.type === 'tool').at(-1)?.outcome).toBe('failure');
  });
});

describe('il turno in pausa si riprende, il tetto si dichiara', () => {
  it('`pause_turn` non chiude il ciclo in silenzio', async () => {
    // E' il difetto documentato del runner: non riprende da solo, e in
    // streaming un controllo su `message.stop_reason` non scatterebbe mai
    // perche' ogni iterazione restituisce uno stream, non un messaggio.
    const { result } = await run([
      { text: 'sto lavorando… ', stopReason: 'pause_turn' },
      { text: 'ecco la risposta.' },
    ]);
    expect(result.iterations).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('una risposta fermata dal tetto lo dice', async () => {
    // Piu' turni con tool di quanti il tetto ne consenta: alla fine il
    // modello stava ancora chiedendo qualcosa, e chi legge deve saperlo.
    const script: FakeTurn[] = Array.from({ length: MAX_ITERATIONS + 3 }, () => ({
      toolUses: [{ id: 't', name: 'network_online', input: {} }],
    }));
    const { events, result } = await run(script);
    expect(result.iterations).toBe(MAX_ITERATIONS);
    expect(result.truncated).toBe(true);
    const done = events.find((e) => e.type === 'done');
    expect(done && done.type === 'done' && done.truncated).toBe(true);
  });
});

describe('i token si contano, perche` senza misura la prima bolletta e` una sorpresa', () => {
  it('si sommano su tutte le iterazioni', async () => {
    const { result } = await run([
      {
        toolUses: [{ id: 't1', name: 'network_online', input: {} }],
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 4000 },
      },
      { text: 'fatto', usage: { input_tokens: 30, output_tokens: 50, cache_read_input_tokens: 4100 } },
    ]);
    expect(result.usage.input).toBe(130);
    expect(result.usage.output).toBe(70);
    // Il numero che conta di piu': se resta a zero fra un messaggio e l'altro,
    // il prefisso sta cambiando e ogni turno si paga per intero.
    expect(result.usage.cacheRead).toBe(8100);
  });
});
