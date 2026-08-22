// I contatori di Svetlana, per /internal/metrics.
//
// PERCHE' NON BASTA GUARDARE LA FATTURA. Una fattura arriva a fine mese, dice
// un numero solo e non dice quale domanda lo ha prodotto. Questi contatori
// dicono quanti messaggi, quanti token per tipo, quante iterazioni e quanti
// tool per esito — cioe' abbastanza per accorgersi di un ciclo che si incarta
// prima che diventi una cifra.
//
// IL NUMERO CHE CONTA DI PIU' E' `cache_read`. Se resta a zero fra un
// messaggio e l'altro della stessa conversazione, qualcosa nel prefisso sta
// cambiando e ogni turno si paga per intero. E' un guasto che non produce
// nessun errore e nessun sintomo visibile: si vede solo qui.
//
// In processo e non in Redis: sono contatori dall'avvio, come tutti gli altri
// del pannello. La spesa mensile invece sta in Redis, perche' quella deve
// sopravvivere a un riavvio — vedi `SpendLedger`.

import type { TokenUsage } from './config.ts';

export type AssistantMetrics = {
  messages: number;
  errors: number;
  /** Risposte fermate dal tetto di iterazioni: una risposta incompleta. */
  truncated: number;
  /** Messaggi rifiutati perche' il tetto di spesa del mese e' finito. */
  overBudget: number;
  iterations: number;
  tokens: TokenUsage;
  /** Chiamate per tool e per esito: `bySucceeded['audit_recent']`, e cosi' via. */
  toolCalls: Map<string, number>;
};

function empty(): AssistantMetrics {
  return {
    messages: 0,
    errors: 0,
    truncated: 0,
    overBudget: 0,
    iterations: 0,
    tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    toolCalls: new Map(),
  };
}

export class AssistantMeter {
  #state: AssistantMetrics = empty();

  get snapshot(): Readonly<AssistantMetrics> {
    return this.#state;
  }

  recordMessage(opts: { usage: TokenUsage; iterations: number; truncated: boolean }): void {
    const s = this.#state;
    s.messages += 1;
    s.iterations += opts.iterations;
    if (opts.truncated) s.truncated += 1;
    s.tokens = {
      input: s.tokens.input + opts.usage.input,
      output: s.tokens.output + opts.usage.output,
      cacheWrite: s.tokens.cacheWrite + opts.usage.cacheWrite,
      cacheRead: s.tokens.cacheRead + opts.usage.cacheRead,
    };
  }

  recordTool(name: string, outcome: string): void {
    const key = `${name}|${outcome}`;
    this.#state.toolCalls.set(key, (this.#state.toolCalls.get(key) ?? 0) + 1);
  }

  recordError(): void {
    this.#state.errors += 1;
  }

  recordOverBudget(): void {
    this.#state.overBudget += 1;
  }
}

/**
 * Le righe in formato Prometheus.
 *
 * Sta qui e non nella rotta perche' la rotta delle metriche e' gia' lunga e
 * perche' cosi' si puo' provare senza montare un server.
 */
export function metricLines(meter: AssistantMeter, spend: { usd: number; capUsd: number }): string[] {
  const s = meter.snapshot;
  const lines = [
    '# HELP metamc_assistant_messages_total messaggi risposti dall`avvio',
    '# TYPE metamc_assistant_messages_total counter',
    `metamc_assistant_messages_total ${s.messages}`,
    '# HELP metamc_assistant_iterations_total chiamate all`API, somma su tutti i messaggi',
    '# TYPE metamc_assistant_iterations_total counter',
    `metamc_assistant_iterations_total ${s.iterations}`,
    '# HELP metamc_assistant_truncated_total risposte fermate dal tetto di iterazioni',
    '# TYPE metamc_assistant_truncated_total counter',
    `metamc_assistant_truncated_total ${s.truncated}`,
    '# HELP metamc_assistant_errors_total messaggi finiti in errore',
    '# TYPE metamc_assistant_errors_total counter',
    `metamc_assistant_errors_total ${s.errors}`,
    '# HELP metamc_assistant_over_budget_total messaggi rifiutati dal tetto di spesa',
    '# TYPE metamc_assistant_over_budget_total counter',
    `metamc_assistant_over_budget_total ${s.overBudget}`,
    '# HELP metamc_assistant_tokens_total token consumati, per tipo',
    '# TYPE metamc_assistant_tokens_total counter',
    `metamc_assistant_tokens_total{kind="input"} ${s.tokens.input}`,
    `metamc_assistant_tokens_total{kind="output"} ${s.tokens.output}`,
    `metamc_assistant_tokens_total{kind="cache_write"} ${s.tokens.cacheWrite}`,
    // Se questo resta a zero mentre `input` cresce, il prefisso sta cambiando
    // fra un messaggio e l'altro: la cache non lavora e ogni turno si paga per
    // intero. E' l'unico sintomo che quel guasto produce.
    `metamc_assistant_tokens_total{kind="cache_read"} ${s.tokens.cacheRead}`,
    '# HELP metamc_assistant_spend_usd stima della spesa del mese corrente, in dollari',
    '# TYPE metamc_assistant_spend_usd gauge',
    `metamc_assistant_spend_usd ${spend.usd.toFixed(4)}`,
    '# HELP metamc_assistant_budget_usd tetto mensile configurato. 0 = nessun tetto',
    '# TYPE metamc_assistant_budget_usd gauge',
    `metamc_assistant_budget_usd ${spend.capUsd}`,
  ];

  if (s.toolCalls.size > 0) {
    lines.push(
      '# HELP metamc_assistant_tool_calls_total chiamate ai tool, per tool ed esito',
      '# TYPE metamc_assistant_tool_calls_total counter',
    );
    // Ordinate: due letture consecutive delle metriche non devono differire
    // solo per l'ordine delle righe.
    for (const [key, count] of [...s.toolCalls.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const [name, outcome] = key.split('|');
      lines.push(`metamc_assistant_tool_calls_total{tool="${name}",outcome="${outcome}"} ${count}`);
    }
  }

  return lines;
}
