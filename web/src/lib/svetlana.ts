// Il lato client di Svetlana: leggere lo stream e tenere lo stato della chat.
//
// STA FUORI DAL COMPONENTE perche' e' la parte che si puo' sbagliare in
// silenzio. Un pacchetto SSE spezzato a meta' fra due `chunk` della rete non
// produce un errore: produce un JSON non valido che si butta via, cioe' una
// parola che manca in mezzo a una frase. Non lo si nota leggendo il codice e
// non lo si nota nemmeno provando in locale, dove i pacchetti arrivano interi.
//
// Qui e' una funzione pura con un residuo esplicito, e c'e' un test che le
// manda i byte tagliati nei punti peggiori.

/** Gli eventi che il server manda. Copia della sua unione, tenuta uguale a mano. */
import { hasPeriod } from './nav.ts';

export type SvEvent =
  | { type: 'start'; conversationId: string }
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string; outcome: 'running' | 'success' | 'denied' | 'failure' }
  | { type: 'confirm'; name: string; args: unknown }
  | { type: 'done'; usage: unknown; iterations: number; truncated: boolean }
  | { type: 'error'; code: string; message: string };

export type SvChunk = { events: SvEvent[]; carry: string };

/**
 * Estrae gli eventi completi da un pezzo di stream.
 *
 * `carry` e' cio' che era avanzato dal pezzo precedente e va rimesso davanti:
 * un pacchetto SSE finisce con una riga vuota, e finche' quella non arriva il
 * pacchetto non e' finito. Buttare via il residuo e' il difetto che produce
 * frasi con un buco in mezzo.
 */
export function readChunk(carry: string, chunk: string): SvChunk {
  const buffer = carry + chunk;
  const parts = buffer.split('\n\n');
  // L'ultimo pezzo non e' terminato da una riga vuota: e' il residuo.
  const rest = parts.pop() ?? '';
  const events: SvEvent[] = [];

  for (const part of parts) {
    for (const line of part.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '') continue;
      try {
        events.push(JSON.parse(payload) as SvEvent);
      } catch {
        // Un pacchetto illeggibile si salta. Non e' un caso che ci si aspetta:
        // e' che una chat che smette di funzionare per una riga storta e'
        // peggio di una chat a cui manca una riga.
      }
    }
  }
  return { events, carry: rest };
}

/**
 * Un messaggio, con un'IDENTITA' e non solo una posizione.
 *
 * L'indice nell'elenco non basta come chiave di React: mentre una risposta si
 * forma l'elenco cresce in coda, e ogni ridisegno ricalcola la chiave di ogni
 * bolla dal posto che occupa. Un contatore che non torna mai indietro non ha
 * quel problema.
 */
export type ChatMessage = { id: number; from: 'bot' | 'user'; text: string };

let nextId = 0;
function withId(message: Omit<ChatMessage, 'id'>): ChatMessage {
  nextId += 1;
  return { id: nextId, ...message };
}

export type SvState = {
  messages: ChatMessage[];
  /** La risposta che si sta formando. `null` quando non ce n'e' una. */
  streaming: string | null;
  /** Il tool in corso, per la riga discreta sotto la risposta. */
  tool: string | null;
  conversationId: string | null;
  error: string | null;
  busy: boolean;
};

/**
 * Il messaggio d'apertura viene dal mockup, parola per parola.
 *
 * Non e' un segnaposto: dice in una riga le due cose che servono a capire cosa
 * si puo' chiedere — che vede la pagina, e che risponde con numeri e stati.
 */
export const OPENING_TEXT =
  'Ciao, sono Svetlana. Vedo che sei su questa pagina — chiedimi pure numeri, stati o dove trovare qualcosa.';

export function initialState(): SvState {
  return {
    messages: [withId({ from: 'bot', text: OPENING_TEXT })],
    streaming: null,
    tool: null,
    conversationId: null,
    error: null,
    busy: false,
  };
}

/** La domanda entra subito nell'elenco: chi scrive deve vedere cio' che ha scritto. */
export function askedState(state: SvState, text: string): SvState {
  return {
    ...state,
    messages: [...state.messages, withId({ from: 'user', text })],
    streaming: '',
    tool: null,
    error: null,
    busy: true,
  };
}

/**
 * Un evento alla volta. Nessuna scrittura sullo stato precedente: e' React, e
 * un oggetto modificato sul posto non ridisegna niente.
 */
export function applyEvent(state: SvState, event: SvEvent): SvState {
  switch (event.type) {
    case 'start':
      return { ...state, conversationId: event.conversationId };
    case 'text':
      return { ...state, streaming: (state.streaming ?? '') + event.delta };
    case 'tool':
      return { ...state, tool: event.outcome === 'running' ? event.name : null };
    case 'confirm':
      // In v1 non arriva mai: nessun tool scrive. Il ramo c'e' perche' il
      // giorno in cui arrivera' la conferma dev'essere gia' un caso che il
      // client conosce, non un evento che finisce nel ramo `default`.
      return state;
    case 'error':
      return { ...state, error: event.message, busy: false };
    case 'done': {
      const text = (state.streaming ?? '').trim();
      const messages = text === '' ? state.messages : [...state.messages, withId({ from: 'bot', text })];
      return {
        ...state,
        messages: event.truncated
          ? [
              ...messages,
              // Una risposta incompleta che sembra completa e' peggio di un
              // errore: chi legge prenderebbe per finita una ricerca che si e'
              // fermata a meta'.
              withId({
                from: 'bot',
                text: 'Mi sono fermata prima di finire: la domanda ha richiesto troppi passaggi. Prova a spezzarla.',
              }),
            ]
          : messages,
        streaming: null,
        tool: null,
        busy: false,
      };
    }
    default:
      return state;
  }
}

/**
 * Come si chiama un tool quando lo si mostra in chat.
 *
 * Il nome tecnico non dice niente a chi guarda, e nasconderlo del tutto
 * toglierebbe l'unica cosa utile: che Svetlana sta guardando un dato invece
 * di inventarlo. Un nome sconosciuto ripiega sul suo nome vero, che e' meglio
 * di «sto lavorando».
 */
const TOOL_LABELS: Record<string, string> = {
  audit_recent: 'sta leggendo il registro attività',
  duels_summary: 'sta guardando i duels',
  network_countries: 'sta guardando da dove vengono',
  network_online: 'sta guardando chi è online',
  network_trend: 'sta guardando l’andamento',
  panel_user_search: 'sta cercando nel pannello',
};

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? `sta usando ${name}`;
}

/**
 * Il periodo e la modalita' che governano QUESTA schermata, se ne ha.
 *
 * SI DERIVA, non si passa in giro. Il periodo e' nella URL e la modalita' e'
 * nel percorso: sono gia' scritti, e farli viaggiare come props attraverso il
 * guscio vorrebbe dire tenerli allineati a mano in un terzo posto.
 *
 * Il periodo si manda SOLO dove governa qualcosa. Su Modes e Maps il selettore
 * non c'e' — lo dice `hasPeriod`, la stessa tabella della barra laterale — e
 * mandarlo comunque direbbe a Svetlana che chi scrive ha scelto un intervallo
 * che invece non ha scelto.
 */
export function pageFilters(pathname: string, range: string): { range?: string; mode?: string } {
  const out: { range?: string; mode?: string } = {};
  if (hasPeriod(pathname)) out.range = range;

  // La modalita' e' il segmento dopo il dettaglio. L'alfabeto e' quello del
  // contratto delle statistiche: fuori da li' non e' una chiave, e il server
  // la rifiuterebbe comunque.
  const prefix = '/dettaglio-modalita/';
  if (pathname.startsWith(prefix)) {
    const mode = pathname.slice(prefix.length).split('/')[0] ?? '';
    if (/^[a-z0-9_]{1,32}$/.test(mode)) out.mode = mode;
  }
  return out;
}
