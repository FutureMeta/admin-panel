// Un finto client Anthropic, per provare cio' che il pannello CONTROLLA.
//
// COSA PROVA E COSA NO. Non prova il modello: quello e' di qualcun altro e non
// si verifica con un test. Prova le due cose che sono nostre e che nessun'altra
// prova tocca:
//
//   1. la RICHIESTA che costruiamo — quali messaggi, con che ruolo, dove
//      cadono i punti di cache, cosa finisce nel canale di sistema;
//   2. cosa succede alle RISPOSTE — l'esecuzione dei tool, il turno in pausa,
//      il tetto di iterazioni, gli eventi che escono verso il browser.
//
// Il finto runner esegue i tool DAVVERO, chiamando `parse` e poi `run` come fa
// quello vero. Serve: un finto che restituisse risultati inventati proverebbe
// il finto, non i tool.

import type Anthropic from '@anthropic-ai/sdk';

/** Un turno che il finto modello produce, in ordine. */
export type FakeTurn = {
  /** Il testo che il turno «scrive». Esce come `text_delta`, un pezzo per parola. */
  text?: string;
  /** I tool che il turno chiede. Vengono eseguiti davvero. */
  toolUses?: Array<{ id: string; name: string; input: unknown }>;
  stopReason?: 'end_turn' | 'tool_use' | 'pause_turn' | 'refusal' | 'max_tokens';
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
};

export type Capture = {
  /** I parametri dell'ultima costruzione del runner. */
  params?: Record<string, unknown>;
  /** I risultati che i tool hanno prodotto, in ordine di esecuzione. */
  toolResults: string[];
  /** Quanti turni il finto modello ha prodotto: serve a provare il tetto. */
  turns: number;
};

type Block = Record<string, unknown>;

function blocksOf(turn: FakeTurn): Block[] {
  const blocks: Block[] = [];
  if (turn.text !== undefined) blocks.push({ type: 'text', text: turn.text });
  for (const use of turn.toolUses ?? []) {
    blocks.push({ type: 'tool_use', id: use.id, name: use.name, input: use.input });
  }
  return blocks;
}

/** Uno stream che si comporta come quello dell'SDK per cio' che il ciclo usa. */
function fakeStream(turn: FakeTurn, message: Record<string, unknown>) {
  async function* events(): AsyncGenerator<Record<string, unknown>> {
    for (const block of blocksOf(turn)) {
      yield { type: 'content_block_start', content_block: block };
      if (block.type === 'text') {
        // A pezzi, perche' e' una chat: se il ciclo accumulasse invece di
        // inoltrare, un test su un testo intero non se ne accorgerebbe.
        for (const piece of String(block.text).split(/(?<=\s)/)) {
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: piece } };
        }
      }
      yield { type: 'content_block_stop' };
    }
  }
  return {
    [Symbol.asyncIterator]: () => events(),
    finalMessage: async () => message,
  };
}

/**
 * Il finto client.
 *
 * `script` sono i turni, in ordine. Il finto runner si ferma quando il turno
 * non chiede tool, quando lo script finisce, o quando `max_iterations` morde —
 * le stesse tre condizioni di quello vero.
 */
export function fakeAnthropic(script: FakeTurn[], capture: Capture): Anthropic {
  const toolRunner = (params: Record<string, unknown>) => {
    capture.params = params;
    const messages = [...((params.messages as unknown[]) ?? [])];
    const tools = (params.tools as Array<Record<string, unknown>>) ?? [];
    const maxIterations = (params.max_iterations as number) ?? 10;

    let index = 0;
    // Il runner vero riprende un turno in pausa SOLO se qualcuno gli rimette
    // dentro il turno dell'assistente. Il finto modella la stessa regola: e'
    // esattamente cio' che il ciclo del pannello deve ricordarsi di fare, e un
    // finto che ripartisse da solo nasconderebbe il difetto invece di provarlo.
    let pushed = false;
    let last: Record<string, unknown> = {
      content: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
    };

    async function* iterate(): AsyncGenerator<unknown> {
      while (index < script.length && index < maxIterations) {
        const turn = script[index];
        if (!turn) break;
        index += 1;
        capture.turns += 1;

        const content = blocksOf(turn);
        const message = {
          content,
          stop_reason: turn.stopReason ?? (turn.toolUses?.length ? 'tool_use' : 'end_turn'),
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            ...turn.usage,
          },
        };
        last = message;

        pushed = false;
        yield fakeStream(turn, message);

        if (!turn.toolUses?.length) {
          if (!pushed) break;
          continue;
        }

        messages.push({ role: 'assistant', content });
        const results: unknown[] = [];
        for (const use of turn.toolUses) {
          const tool = tools.find((t) => t.name === use.name);
          if (!tool) throw new Error(`il finto modello ha chiesto un tool inesistente: ${use.name}`);
          const parse = tool.parse as (v: unknown) => unknown;
          const run = tool.run as (v: unknown, c: unknown) => Promise<string>;
          const parsed = parse(use.input);
          const output = await run(parsed, {
            toolUse: { id: use.id, name: use.name, input: parsed, type: 'tool_use' },
            toolUseBlock: { id: use.id, name: use.name, input: parsed, type: 'tool_use' },
          });
          capture.toolResults.push(output);
          results.push({ type: 'tool_result', tool_use_id: use.id, content: output });
        }
        messages.push({ role: 'user', content: results });
      }
    }

    const runner = {
      [Symbol.asyncIterator]: () => iterate(),
      done: async () => last,
      pushMessages: (...m: unknown[]) => {
        messages.push(...m);
        pushed = true;
      },
      get params() {
        return { ...params, messages };
      },
    };
    return runner;
  };

  return { beta: { messages: { toolRunner } } } as unknown as Anthropic;
}

export function emptyCapture(): Capture {
  return { toolResults: [], turns: 0 };
}
