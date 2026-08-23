// Le costanti di Svetlana, in un posto solo.
//
// Un tetto deciso dentro un handler e' un tetto che nessuno ritrova quando
// serve cambiarlo: e' la stessa ragione per cui i limiti di frequenza stanno
// tutti in `src/ratelimit/limiter.ts`. Qui ci sono i numeri che governano
// quanto una chat puo' costare e quanto puo' durare.

/**
 * I modelli fra cui questo codice sa scegliere, con i loro prezzi.
 *
 * NON E' UN CATALOGO. C'e' dentro solo cio' che sta in piedi con la richiesta
 * che `runner.ts` costruisce davvero: pensiero adattivo ed `effort`. Haiku 4.5
 * il pensiero adattivo non ce l'ha, quindi metterlo qui non darebbe una scelta
 * in piu' — darebbe un 400 in produzione al primo messaggio.
 *
 * I PREZZI STANNO ACCANTO AL MODELLO, e non in una costante per conto loro.
 * Erano separati, ed erano separati male: cambiare modello lasciava il tetto
 * di spesa a contare con il listino di quello di prima. Nessun errore, nessun
 * sintomo, un tetto che non morde piu' quando dovrebbe. Qui la coppia
 * modello + velocita' sceglie i prezzi da se'.
 *
 * Ogni voce segue il listino ufficiale: scrittura in cache a 5 minuti = 1,25
 * volte l'input, lettura = un decimo. E' quella differenza a rendere la cache
 * la voce piu' importante di tutte su una conversazione lunga.
 *
 * `extras` E' L'ALTRA META', e la lezione e' costata un 400 in produzione il
 * 2026-08-23: `'claude-sonnet-5' does not support the `fallbacks` parameter`.
 * `speed` era legato al modello, `fallbacks` era una riga fissa dentro
 * `runner.ts` — ed e' sopravvissuta al cambio di modello, perche' niente la
 * teneva legata a quello vecchio. Adesso OGNI parametro che dipende dal
 * modello sta qui, insieme all'header beta che lo accompagna: chi cambia
 * modello si porta dietro l'elenco giusto senza doverselo ricordare.
 */
const MODELS = {
  // `fast` esiste SOLO qui e su Opus 4.8: e' anteprima di ricerca (l'accesso
  // si chiede), raddoppia il listino, e accelera i token in uscita — NON il
  // tempo che passa prima della prima parola.
  'claude-opus-5': {
    prices: {
      standard: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
      fast: { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
    },
    // `fallbacks` rimedia al rifiuto di un CLASSIFICATORE, e il classificatore
    // ce l'hanno solo i modelli di classe Opus e Fable: e' per questo che il
    // parametro non e' universale. La forma scalare `'default'` sceglie il
    // ripiego per categoria e non richiede un elenco di modelli da tenere
    // aggiornato — e va con QUESTO header, non con quello della forma ad
    // array: accoppiarli al contrario e' un altro 400.
    extras: { params: { fallbacks: 'default' }, betas: ['server-side-fallback-2026-07-01'] },
  },
  // Niente `extras`: che Opus 4.8 accetti `fallbacks` non l'ha detto nessuno.
  // Questa tabella elenca cio' che e' PROVATO, non cio' che e' plausibile —
  // l'ultima volta che si e' dato per scontato, il conto l'ha pagato la chat.
  'claude-opus-4-8': {
    prices: {
      standard: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
      fast: { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
    },
    extras: { params: {}, betas: [] },
  },
  // Qui `fast` non c'e', e non e' una dimenticanza: l'API la rifiuta su questo
  // modello al momento della richiesta. La voce ASSENTE e' cio' che rende la
  // coppia sbagliata un errore di compilazione invece che un 400.
  //
  // Nemmeno `fallbacks`. Sonnet 5 puo' comunque rifiutare — e' il primo Sonnet
  // con le salvaguardie cyber in tempo reale, e un rifiuto arriva come 200 con
  // `stop_reason: "refusal"` — solo che qui non c'e' nessun ripiego automatico
  // a rimediare. Il ramo che avvisa l'operatore, in `runner.ts`, serve ancora:
  // adesso e' l'unica cosa che sta fra un rifiuto e una chat muta.
  'claude-sonnet-5': {
    prices: {
      standard: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
    },
    extras: { params: {}, betas: [] },
  },
} as const;

type ModelKey = keyof typeof MODELS;
/** Le velocita' che QUEL modello accetta davvero. Su Sonnet 5 e' solo `standard`. */
type SpeedFor<K extends ModelKey> = keyof (typeof MODELS)[K]['prices'] & string;

/**
 * Il modello. NON e' una variabile d'ambiente.
 *
 * Cambiarlo cambia i prezzi qui sopra, il comportamento dei tool e la validita'
 * della cache: e' una modifica di codice che qualcuno rivede, non una riga di
 * configurazione che si tocca alle undici di sera.
 *
 * PERCHE' SONNET 5 E NON OPUS 5. Le domande di un pannello sono ricerche su
 * dati gia' aggregati, non ragionamenti lunghi: e' il lavoro su cui Sonnet 5
 * sta nella classe di latenza «veloce» dove Opus 5 sta in «moderata». Costa
 * anche 2 e 10 dollari per milione invece di 5 e 25. Le due cose che si
 * volevano — meno attesa e meno spesa — arrivano insieme, dalla stessa riga.
 */
export const ASSISTANT_MODEL = 'claude-sonnet-5' satisfies ModelKey;

/**
 * Standard o `fast`. La coppia sbagliata NON COMPILA.
 *
 * `SpeedFor` legge le velocita' dal modello scelto sopra: scrivere `'fast'`
 * con Sonnet 5 e' un errore di tipo, non una richiesta rifiutata in
 * produzione. E' la stessa lezione degli schemi `strict` — il vincolo dell'API
 * si porta dentro il linguaggio, oppure lo si scopre dai log.
 *
 * COSA FA E COSA NON FA. `fast` alza i token al secondo in uscita fino a 2,5
 * volte, ma la documentazione e' esplicita: il guadagno sta sulla velocita' di
 * scrittura, non sul tempo fino alla prima parola. In una chat con i tool la
 * prima parola arriva DOPO le letture, quindi e' proprio la parte che `fast`
 * non tocca. In cambio raddoppia il listino.
 *
 * Per provarla servono due righe: `claude-opus-5` sopra e `'fast'` qui.
 */
export const ASSISTANT_SPEED = 'standard' satisfies SpeedFor<typeof ASSISTANT_MODEL>;

/**
 * Cosa aggiungere alla richiesta per la velocita' scelta.
 *
 * Una TABELLA e non un `if`: con le costanti sopra fissate a un valore
 * letterale, un confronto `=== 'fast'` sarebbe codice che il compilatore sa
 * gia' morto. Cosi' invece resta una ricerca, e cambiare la costante si porta
 * dietro l'header beta e il parametro senza toccare altro.
 *
 * `speed: 'standard'` non si manda: e' il comportamento normale, e mandarlo
 * vorrebbe dire spedire un parametro in anteprima senza il suo header.
 */
const SPEED_REQUEST = {
  standard: { betas: [], params: {} },
  fast: { betas: ['fast-mode-2026-02-01'], params: { speed: 'fast' } },
} as const;

/**
 * TUTTI i parametri che dipendono dal modello o dalla velocita', in un oggetto
 * solo, pronto da spandere dentro la richiesta.
 *
 * UNO E UNO SOLO, e non uno per famiglia. Con due export separati la
 * tentazione — quella che e' costata il 400 — e' scrivere il terzo parametro a
 * mano dentro `runner.ts`, dove nessuno lo lega piu' al modello. Qui il runner
 * non sceglie: spande, e non ha modo di dimenticarsi un pezzo.
 *
 * L'ELENCO DEI NOMI E' `MODEL_DEPENDENT`, qui sotto: e' cio' che permette a un
 * test di guardare la richiesta vera e accorgersi se qualcuno ha ricominciato
 * a scriverli a mano.
 */
export const MODEL_PARAMS: Readonly<Record<string, unknown>> = {
  ...MODELS[ASSISTANT_MODEL].extras.params,
  ...SPEED_REQUEST[ASSISTANT_SPEED].params,
};

/**
 * I nomi dei parametri che vivono o muoiono col modello.
 *
 * Serve a un test, e serve a una cosa sola: pretendere che nella richiesta ce
 * ne sia esattamente quanti ne mette `MODEL_PARAMS`, e nessuno di piu'.
 * Aggiungerne uno nuovo vuol dire aggiungerlo QUI, ed e' il promemoria che il
 * 2026-08-23 non c'era.
 */
export const MODEL_DEPENDENT = ['fallbacks', 'speed'] as const;

/**
 * Gli header beta, sempre quelli dei parametri che stiamo davvero mandando.
 *
 * Un header senza il suo parametro e' un giro a vuoto; un parametro senza il
 * suo header e' un campo sconosciuto, cioe' un 400 su OGNI messaggio. Vengono
 * dalla stessa tabella per non potersi separare.
 */
export const ASSISTANT_BETAS: readonly string[] = [
  ...MODELS[ASSISTANT_MODEL].extras.betas,
  ...SPEED_REQUEST[ASSISTANT_SPEED].betas,
];

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
 * Prezzi per milione di token, in dollari, del modello E della velocita' scelti.
 *
 * Servono a UNA cosa: il tetto di spesa mensile e la metrica. Non si mostrano
 * a nessuno e non entrano in una fattura — la fattura la fa il fornitore.
 * Sono qui perche' un tetto che non sa contare non e' un tetto.
 *
 * Si LEGGONO dalla tabella invece di essere riscritti: cambiare modello senza
 * cambiare i prezzi era il modo silenzioso di rompere il tetto di spesa.
 */
export const PRICE_USD_PER_MTOK = MODELS[ASSISTANT_MODEL].prices[ASSISTANT_SPEED];

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
