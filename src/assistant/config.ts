// Le costanti di Svetlana, in un posto solo.
//
// Un tetto deciso dentro un handler e' un tetto che nessuno ritrova quando
// serve cambiarlo: e' la stessa ragione per cui i limiti di frequenza stanno
// tutti in `src/ratelimit/limiter.ts`. Qui ci sono i numeri che governano
// quanto una chat puo' costare e quanto puo' durare.

/**
 * Il modello. NON e' una variabile d'ambiente.
 *
 * Cambiarlo cambia i prezzi qui sotto, il comportamento dei tool e la validita'
 * della cache: e' una modifica di codice che qualcuno rivede, non una riga di
 * configurazione che si tocca alle undici di sera.
 */
export const ASSISTANT_MODEL = 'claude-opus-5';

/**
 * `fallbacks: 'default'` per il rifiuto lato server.
 *
 * Senza, una richiesta declinata da un classificatore si ferma e basta: la
 * chat non riceve niente e non c'e' niente da dire all'operatore. Con questo,
 * l'API rigira la stessa richiesta su un modello di ripiego dentro la stessa
 * chiamata. La forma scalare `'default'` sceglie il ripiego per categoria e non
 * richiede un elenco di modelli da tenere aggiornato — e va con QUESTO header,
 * non con quello della forma ad array: accoppiarli al contrario e' un 400.
 */
export const ASSISTANT_BETAS = ['server-side-fallback-2026-07-01'];

/**
 * Quante chiamate all'API una sola domanda puo' fare.
 *
 * Ogni giro e' una richiesta pagata, e il costo di una chat con i tool non e'
 * intuitivo: sei bastano per «leggi due cose e rispondi», e mettono un tetto a
 * un ciclo che si incarta. Un giro consumato da un `pause_turn` conta come gli
 * altri — vedi `runner.ts`.
 */
export const MAX_ITERATIONS = 6;

/**
 * Il tetto per risposta. Le risposte sono frasi, non relazioni.
 *
 * In streaming il timeout HTTP non e' un problema, quindi il numero puo'
 * essere generoso senza costare niente: `max_tokens` e' un tetto, non una
 * prenotazione.
 */
export const MAX_TOKENS = 8_192;

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export function isEffort(value: string): value is Effort {
  return (EFFORTS as readonly string[]).includes(value);
}

/**
 * Quanto vive una conversazione. Otto ore: una giornata di lavoro.
 *
 * LA CRONOLOGIA STA SUL SERVER e non nel browser, e non e' una comodita'. Se
 * il client rimandasse i turni precedenti, i turni dell'ASSISTENTE
 * arriverebbero dal client — cioe' chiunque controlli quella pagina potrebbe
 * fabbricare cose che Svetlana «ha detto» e usarle come contesto. Le
 * istruzioni operative viaggiano solo come messaggi `system`, che il client
 * non puo' scrivere; questa e' la meta' che rende vera quella frase.
 */
export const CONVERSATION_TTL_SECONDS = 8 * 60 * 60;

/**
 * Quanti turni si conservano. Oltre, i piu' vecchi cadono.
 *
 * E' un tetto di SICUREZZA sulla memoria, non la gestione del contesto: quella
 * la fa la compattazione lato server, che riassume invece di tagliare. Qui si
 * evita solo che una chiave di Valkey cresca all'infinito.
 */
export const MAX_STORED_TURNS = 60;

/**
 * Prezzi per milione di token del modello sopra, in dollari.
 *
 * Servono a UNA cosa: il tetto di spesa mensile e la metrica. Non si mostrano
 * a nessuno e non entrano in una fattura — la fattura la fa il fornitore.
 * Sono qui perche' un tetto che non sa contare non e' un tetto.
 *
 * La scrittura in cache costa circa 1,25 volte l'input e la lettura circa un
 * decimo: e' quella differenza che rende la cache la voce piu' importante di
 * tutte su una conversazione lunga.
 */
export const PRICE_USD_PER_MTOK = {
  input: 5,
  output: 25,
  cacheWrite: 6.25,
  cacheRead: 0.5,
} as const;

export type TokenUsage = {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
};

export const NO_TOKENS: TokenUsage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheRead: a.cacheRead + b.cacheRead,
  };
}

/** Quanto e' costata questa manciata di token, in dollari. */
export function costUsd(usage: TokenUsage): number {
  return (
    (usage.input * PRICE_USD_PER_MTOK.input +
      usage.output * PRICE_USD_PER_MTOK.output +
      usage.cacheWrite * PRICE_USD_PER_MTOK.cacheWrite +
      usage.cacheRead * PRICE_USD_PER_MTOK.cacheRead) /
    1_000_000
  );
}

/**
 * I token di una risposta, dai campi che l'API restituisce.
 *
 * `cache_creation_input_tokens` e `cache_read_input_tokens` NON sono compresi
 * in `input_tokens`: sommarli tutti e tre e' giusto, ed e' il motivo per cui
 * questa conversione sta qui invece che scritta a mano in due punti.
 */
export function usageOf(usage: {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}): TokenUsage {
  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
  };
}
