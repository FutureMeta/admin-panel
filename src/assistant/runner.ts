// Il ciclo di Svetlana: da una domanda a una risposta, in streaming.
//
// USA IL TOOL RUNNER DELL'SDK e non un ciclo scritto a mano: il ciclo
// richiesta → esecuzione → risultato → richiesta e' esattamente il genere di
// cosa che si riscrive peggio ogni volta. Quello che resta da fare a mano e'
// cio' che il runner non fa, ed e' scritto qui sotto.
//
// IL DIFETTO DOCUMENTATO CHE VA GESTITO: il runner NON riprende da solo un
// turno che si ferma con `stop_reason: "pause_turn"`. Continua solo dopo che un
// tool ha prodotto un risultato, quindi un turno in pausa chiude il ciclo e
// viene restituito come messaggio finale — senza errore, senza avviso, con la
// risposta troncata a meta'. In streaming il tranello e' doppio: ogni
// iterazione restituisce uno STREAM, non un messaggio, quindi un controllo su
// `message.stop_reason` non scatterebbe mai. Si risolve lo stream, poi si
// guarda.
//
// TETTO DI ITERAZIONI. Una domanda sola puo' chiamare l'API piu' volte, e il
// costo di una chat con i tool non e' intuitivo. `max_iterations` lo limita
// per costruzione; se il tetto morde, chi legge lo viene a sapere invece di
// ricevere una risposta che sembra completa.

import { Anthropic } from '@anthropic-ai/sdk';
import type { Logger } from 'pino';
import type { AuthzContext } from '#src/authz/context.ts';
import {
  ASSISTANT_BETAS,
  ASSISTANT_MODEL,
  addUsage,
  type Effort,
  MAX_ITERATIONS,
  MAX_TOKENS,
  MODEL_PARAMS,
  NO_TOKENS,
  type TokenUsage,
  usageOf,
} from './config.ts';
import { type PageContext, pageContext, SYSTEM_PROMPT } from './prompt.ts';
import type { AssistantData } from './reader.ts';
import type { Turn } from './store.ts';
import { type AssistantTool, buildTools, type ToolCall } from './tools.ts';

/** Cio' che il client riceve, un evento per riga SSE. */
export type AssistantEvent =
  | { type: 'start'; conversationId: string }
  | { type: 'text'; delta: string }
  /** Un tool sta per partire, oppure ha finito. La chat lo mostra in una riga. */
  | { type: 'tool'; name: string; outcome: 'running' | 'success' | 'denied' | 'failure' }
  /**
   * PREDISPOSTO PER LE SCRITTURE, e in v1 non si emette mai.
   *
   * Un tool di scrittura non si esegue: propone. L'operatore vede cosa
   * verrebbe fatto e conferma. Il percorso vive nel protocollo dal primo
   * giorno perche' aggiungerlo dopo vorrebbe dire cambiare il client, il
   * server e il formato insieme — cioe' riscrivere invece che estendere.
   */
  | { type: 'confirm'; name: string; args: unknown }
  | { type: 'done'; usage: TokenUsage; iterations: number; truncated: boolean }
  | { type: 'error'; code: string; message: string };

export type RunInput = {
  conversationId: string;
  actor: AuthzContext;
  /** Il testo scritto in chat. Diventa un turno `user` e nient'altro. */
  text: string;
  page: PageContext;
  /** I turni precedenti, dal server. Mai dal client. */
  history: Turn[];
  now: Date;
};

export type RunDeps = {
  client: Anthropic;
  data: AssistantData;
  effort: Effort;
  logger: Logger;
  /** Chiuso quando il client se ne va: le richieste in volo si annullano. */
  signal: AbortSignal;
};

/**
 * DOVE VA IL TEMPO di una risposta.
 *
 * Senza questi numeri «e' lenta» non e' una diagnosi: puo' essere l'API, i
 * giri del ciclo, o una query. Sono tre cause con tre rimedi diversi e
 * nessuna somiglianza fra loro, e sceglierne una a occhio significa
 * ottimizzare la parte sbagliata.
 *
 * `firstTextMs` e' la LATENZA PERCEPITA: quanto passa prima che compaia la
 * prima parola. In una chat conta piu' del totale — e con i tool arriva DOPO
 * le letture, non prima, perche' il modello parla quando ha i dati.
 */
export type RunTimings = {
  totalMs: number;
  /** Dalla domanda alla prima parola scritta. `null` se non ha scritto niente. */
  firstTextMs: number | null;
  /** Somma del tempo passato DENTRO i tool: query, cache, database. */
  toolMs: number;
};

export type RunResult = {
  /** I turni da conservare. Senza i messaggi di sistema: vedi `stripSystem`. */
  turns: Turn[];
  usage: TokenUsage;
  calls: ToolCall[];
  iterations: number;
  truncated: boolean;
  stopReason: string | null;
  timings: RunTimings;
};

/** Il client verso l'API. La chiave sta nell'ambiente del processo e non esce da qui. */
export function createAnthropic(apiKey: string, timeoutMs: number): Anthropic {
  return new Anthropic({
    apiKey,
    // In millisecondi in TypeScript. Esplicito perche' il default e' dieci
    // minuti: una chiamata appesa per dieci minuti e' una richiesta del
    // pannello appesa per dieci minuti.
    timeout: timeoutMs,
    // Un solo tentativo in piu'. Ritentare tre volte una richiesta che porta
    // una conversazione intera moltiplica il costo di un guasto.
    maxRetries: 1,
  });
}

/**
 * I messaggi di sistema NON si conservano.
 *
 * Il contesto della pagina si rigenera a ogni richiesta e va in coda. Se
 * quello vecchio restasse nella cronologia, la conversazione porterebbe in
 * giro l'ora di ieri e la schermata di prima — e il modello leggerebbe due
 * «Sta guardando» in disaccordo. Toglierli tiene anche il prefisso identico
 * fra un messaggio e l'altro, che e' cio' che la cache riconosce.
 */
function stripSystem(turns: readonly Turn[]): Turn[] {
  // Il ruolo si legge DESTRUTTURANDO e non con il punto. La guardia
  // `authz/no-role-field-read` cerca `.role` perche' in questo progetto quel
  // campo e' la colonna di better-auth che non esiste; qui e' il ruolo di un
  // messaggio dell'API, un'altra cosa con lo stesso nome. Scriverlo cosi'
  // costa una parentesi e non indebolisce una guardia che altrove serve.
  return turns.filter(({ role }) => role !== 'system');
}

/**
 * I punti di cache dei turni VECCHI si tolgono. Tutti.
 *
 * IL 400 DEL QUARTO MESSAGGIO, in produzione:
 *
 *   A maximum of 4 blocks with cache_control may be provided. Found 5.
 *
 * Il punto di cache si mette sull'ultimo turno dell'utente — e quel turno
 * finisce nella cronologia, con il suo marcatore addosso. Al messaggio dopo la
 * cronologia ne porta uno, piu' quello nuovo, piu' quello del prompt di
 * sistema: tre. Poi quattro. Al quarto messaggio sono cinque e la conversazione
 * muore, sempre allo stesso punto, dopo essere andata bene tre volte. Il
 * difetto non stava in cio' che scrivevamo: stava in cio' che RILEGGEVAMO.
 *
 * Si toglie in LETTURA e non prima di salvare, perche' cosi' guarisce anche le
 * conversazioni gia' dentro Valkey — che scadono in otto ore e nel frattempo
 * fallirebbero comunque.
 *
 * E toglierli e' anche la cosa giusta a prescindere dal tetto: un punto di
 * cache dice «scrivi fin qui», e riscrivere in mezzo a un prefisso gia' scritto
 * non serve a niente. Ne bastano due, e devono essere gli ultimi due.
 */
function stripCacheControl(turns: readonly Turn[]): Turn[] {
  return turns.map((turn) => {
    const { content } = turn;
    if (!Array.isArray(content)) return turn;
    return {
      ...turn,
      content: content.map((block) => {
        if (block === null || typeof block !== 'object' || !('cache_control' in block)) return block;
        const { cache_control: _senzaMarcatore, ...resto } = block;
        return resto;
      }),
    } as Turn;
  });
}

/**
 * Il testo dell'utente diventa un blocco, non una stringa.
 *
 * Serve a poterci appendere `cache_control`: il punto di cache va sull'ultimo
 * blocco del turno, e un contenuto stringa non ha blocchi.
 */
function userTurn(text: string, cached: boolean): Turn {
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text,
        ...(cached ? { cache_control: { type: 'ephemeral' as const } } : {}),
      },
    ],
  };
}

/**
 * Esegue una domanda e produce gli eventi da mandare al browser.
 *
 * E' un generatore asincrono e non una funzione che accumula: la risposta va
 * mostrata mentre si forma, ed e' una chat.
 */
export async function* runAssistant(
  deps: RunDeps,
  input: RunInput,
): AsyncGenerator<AssistantEvent, RunResult> {
  const calls: ToolCall[] = [];
  const tools = buildTools({ actor: input.actor, data: deps.data, calls, now: input.now });

  // Due passate, e ognuna toglie una cosa che la cronologia non deve portarsi
  // dietro: il contesto della pagina di ieri, e i punti di cache di ieri.
  const history = stripCacheControl(stripSystem(input.history));
  const messages: Turn[] = [
    ...history,
    // IL PUNTO DI CACHE NUMERO DUE. Copre i tool, il prompt di sistema, la
    // cronologia e la domanda appena scritta: e' il prefisso che il ciclo dei
    // tool rimanda identico a ogni iterazione, quindi si paga una volta sola
    // anche dentro la stessa risposta.
    userTurn(input.text, true),
    // IL CONTESTO VARIABILE STA DOPO, e fuori dalla cache. Un'ora e una
    // schermata dentro il prefisso lo cambierebbero a ogni messaggio,
    // facendo pagare per intero ogni turno di ogni conversazione.
    //
    // E' anche l'unico canale non falsificabile: il client non puo' scrivere
    // un messaggio `system`, puo' scrivere solo il proprio turno.
    { role: 'system', content: pageContext(input.page, input.now) },
  ];

  const runner = deps.client.beta.messages.toolRunner(
    {
      model: ASSISTANT_MODEL,
      max_tokens: MAX_TOKENS,
      // TUTTO cio' che dipende dal modello arriva da qui, e NIENTE si scrive a
      // mano accanto. `fallbacks` stava scritto qui sotto, non era legato a
      // niente, ed e' rimasto quando il modello e' cambiato: 400 su ogni
      // messaggio finche' non l'ha detto il log. Una riga che si spande non
      // puo' sopravvivere alla cosa da cui dipende.
      ...MODEL_PARAMS,
      betas: [...ASSISTANT_BETAS, 'compact-2026-01-12'],
      // Sul modello corrente il pensiero e' adattivo: decide da se' quanto
      // pensare. La PROFONDITA' si regola con l'effort, non con parametri di
      // campionamento — che su questo modello non esistono piu'.
      thinking: { type: 'adaptive' },
      output_config: { effort: deps.effort },
      // Le conversazioni lunghe si COMPATTANO lato server invece di essere
      // tagliate a mano: tagliare butta via l'inizio senza dirlo, riassumere
      // lo conserva. I blocchi di compattazione restano dentro `messages` e
      // vengono riconservati com'e', che e' cio' che li rende utili al giro
      // dopo.
      context_management: { edits: [{ type: 'compact_20260112' }] },
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          // IL PUNTO DI CACHE NUMERO UNO: copre i tool e il prompt. L'ordine
          // di composizione e' tool → system → messages, quindi un punto qui
          // conserva la parte piu' grossa e piu' stabile della richiesta.
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: tools.map((t) => t.tool),
      messages,
      max_iterations: MAX_ITERATIONS,
      stream: true,
    },
    { signal: deps.signal },
  );

  let usage: TokenUsage = NO_TOKENS;
  let iterations = 0;
  let drained = 0;
  const startedAt = Date.now();
  let firstTextAt: number | null = null;

  /** Gli esiti dei tool eseguiti dall'ultimo giro. */
  function* fresh(): Generator<AssistantEvent> {
    for (; drained < calls.length; drained += 1) {
      const call = calls[drained];
      if (call) yield { type: 'tool', name: call.name, outcome: call.outcome };
    }
  }

  yield { type: 'start', conversationId: input.conversationId };

  let stopReason: string | null = null;

  for await (const stream of runner) {
    iterations += 1;
    // I tool del giro precedente sono gia' stati eseguiti quando l'iteratore
    // avanza: e' qui che se ne conosce l'esito.
    yield* fresh();

    for await (const event of stream) {
      if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
        yield { type: 'tool', name: event.content_block.name, outcome: 'running' };
      }
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        firstTextAt ??= Date.now();
        yield { type: 'text', delta: event.delta.text };
      }
    }

    const message = await stream.finalMessage();
    usage = addUsage(usage, usageOf(message.usage));
    stopReason = message.stop_reason ?? null;

    if (message.stop_reason === 'pause_turn') {
      // Il runner non riprende da solo: senza queste due righe la risposta
      // finirebbe qui, troncata e senza che niente lo dica.
      runner.pushMessages({ role: 'assistant', content: message.content });
    }
  }

  yield* fresh();

  const final = await runner.done();
  // Il tetto ha morso se l'ultimo messaggio chiedeva ancora un tool. Non e'
  // un errore — e' una risposta incompleta, e chi legge deve saperlo.
  const truncated = final.stop_reason === 'tool_use' || final.stop_reason === 'pause_turn';

  if (final.stop_reason === 'refusal') {
    yield {
      type: 'error',
      code: 'rifiutato',
      message: 'La richiesta e` stata rifiutata dal fornitore. Prova a riformularla.',
    };
  }

  yield { type: 'done', usage, iterations, truncated };

  return {
    turns: withFinalAnswer(stripSystem(runner.params.messages as Turn[]), final.content as Turn['content']),
    usage,
    calls,
    iterations,
    truncated,
    stopReason,
    timings: {
      totalMs: Date.now() - startedAt,
      firstTextMs: firstTextAt === null ? null : firstTextAt - startedAt,
      // I tool si sommano da soli: ognuno si e' misurato in `guarded`.
      toolMs: calls.reduce((a, c) => a + c.ms, 0),
    },
  };
}

/**
 * La risposta finale finisce nella cronologia, comunque sia andata.
 *
 * IL RUNNER AGGIUNGE I TURNI CHE GLI SERVONO PER CONTINUARE, non quelli che
 * servono a noi per ricordare: dopo l'ultimo turno — quello senza tool, cioe'
 * la risposta vera — non c'e' nessun giro dopo, quindi puo' non finire in
 * `params.messages`.
 *
 * L'effetto era una conversazione che ricordava solo le domande. Il messaggio
 * dopo partiva con la cronologia di chi ha chiesto e senza quella di chi ha
 * risposto, e Svetlana si contraddiceva su cose che aveva appena detto — senza
 * nessun errore e senza che il difetto si vedesse in una risposta sola.
 *
 * Si guarda l'ultimo turno invece di aggiungere sempre: se il runner l'ha gia'
 * messo, aggiungerlo di nuovo lo direbbe due volte.
 */
function withFinalAnswer(turns: Turn[], content: Turn['content']): Turn[] {
  const last = turns.at(-1);
  const { role } = last ?? { role: '' };
  if (role === 'assistant') return turns;
  if (Array.isArray(content) && content.length === 0) return turns;
  return [...turns, { role: 'assistant', content }];
}

/** L'elenco dei tool, per i test e per le metriche. Non dipende da un attore. */
export function toolNames(tools: readonly AssistantTool[]): string[] {
  return tools.map((t) => t.name);
}
