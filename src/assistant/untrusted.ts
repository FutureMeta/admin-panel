// Il testo scritto da terzi, e cosa gli si fa prima di spedirlo al modello.
//
// ----------------------------------------------------------------------------
// COSA C'E' DENTRO IL PANNELLO CHE NON ABBIAMO SCRITTO NOI.
//
// Nomi di giocatori, commenti alle valutazioni dei duels, motivazioni di ban,
// nomi di modalita' e mappe presi dal database del gioco, etichette di
// bersaglio nel registro, nomi visualizzati dello staff. Sono campi in cui
// qualcuno che non siamo noi scrive quello che vuole, e finiscono tutti in un
// risultato di tool, cioe' dentro il contesto del modello.
//
// ----------------------------------------------------------------------------
// LA DIFESA PRINCIPALE NON E' QUI, ED E' IMPORTANTE DIRLO.
//
// La difesa e' STRUTTURALE e sta altrove: le istruzioni operative viaggiano
// solo come messaggi `role: "system"`, che il client non puo' scrivere; il
// titolo della schermata lo sceglie il server da una tabella chiusa; la
// cronologia sta sul server; ogni tool ricontrolla i permessi per conto suo.
// Nessuna di quelle cose dipende da come e' fatto il testo.
//
// Questo file e' il secondo strato, e serve a due cose diverse che vanno
// tenute distinte:
//
//   1. TOGLIERE AL TESTO LA CAPACITA' DI FINGERSI STRUTTURA. Caratteri di
//      controllo, spazi a larghezza zero, override di direzionalita' e i tag
//      invisibili del piano 14 di Unicode servono a far vedere una cosa e
//      contenerne un'altra. Nessuno di loro ha una ragione legittima di stare
//      nel nome di un giocatore, e toglierli non toglie informazione.
//   2. RENDERE VISIBILE UN TENTATIVO. `looksLikeInjection` e' un'ANNOTAZIONE,
//      non un filtro: non blocca niente, non cambia niente, aggiunge un
//      campo. Serve perche' il prompt di sistema chiede di segnalare
//      all'operatore le istruzioni trovate dentro i dati, e una spia rende
//      quella segnalazione probabile invece che sperata.
//
// SU (2) VA DETTA UNA COSA CHIARA: e' un elenco di parole, quindi si puo'
// aggirare. Non e' un controllo di sicurezza e nessuna decisione dipende da
// lui — se fosse un filtro, il giorno in cui qualcuno scrive la stessa cosa
// con parole diverse la difesa sarebbe passata senza che nessuno lo sappia.
// Come spia invece un elenco parziale e' meglio di niente, perche' non c'e'
// niente che possa peggiorare.
//
// ----------------------------------------------------------------------------
// PERCHE' UN TIPO CON IL MARCHIO.
//
// `Untrusted` e' una stringa marchiata: TypeScript non accetta una `string`
// normale dove ne serve una. I tipi dei risultati dichiarano `Untrusted` su
// ogni campo di testo di terzi, quindi non si puo' scrivere `comment: row.text`
// — bisogna passare da `untrusted()`.
//
// E' la stessa idea del ruolo di sola lettura in Postgres: non «ricordati di
// sanificare», ma «non si compila se non lo fai».

/** Una stringa che qualcun altro ha scritto, gia' ripulita. */
export type Untrusted = string & { readonly __untrusted: unique symbol };

/**
 * Quanto testo di terzi entra al massimo in un campo.
 *
 * Non e' solo costo: un commento da diecimila caratteri e' anche il posto
 * comodo in cui nascondere una frase in mezzo, sperando che chi legge la
 * risposta non arrivi in fondo.
 */
export const UNTRUSTED_MAX = 400;

/**
 * Cosa fare di un codepoint. Le due categorie non sono la stessa cosa.
 *
 * `space` — i caratteri di CONTROLLO (C0, DEL, C1). Erano separatori: una
 * newline stava fra due parole, e sostituirla con uno spazio conserva quel
 * confine. E' la stessa scelta dell'audit, per la stessa ragione.
 *
 * `drop` — gli INVISIBILI che stanno DENTRO una parola per spezzarla senza che
 * si veda: «ig​nora» con uno spazio a larghezza zero in mezzo. Sostituirli con
 * uno spazio lascerebbe «ig nora», cioe' proprio la separazione che chi li ha
 * messi voleva. Vanno tolti del tutto: le due meta' tornano una parola sola,
 * e un confronto o un occhio la ritrovano.
 *
 * Scritto per codepoint e non con una regex letterale: una classe di caratteri
 * invisibili scritta nel sorgente e' invisibile anche a chi rilegge il file.
 */
function classify(code: number): 'keep' | 'space' | 'drop' {
  if (code <= 0x1f) return 'space';
  if (code >= 0x7f && code <= 0x9f) return 'space';
  // Spazi a larghezza zero e marcatori di direzionalita': U+200B..U+200F.
  if (code >= 0x200b && code <= 0x200f) return 'drop';
  // Override e isolamenti bidirezionali: U+202A..U+202E e U+2066..U+2069.
  // Fanno leggere una stringa al contrario di com'e' scritta.
  if (code >= 0x202a && code <= 0x202e) return 'drop';
  if (code >= 0x2066 && code <= 0x2069) return 'drop';
  // Giunzioni invisibili: U+2060..U+2064.
  if (code >= 0x2060 && code <= 0x2064) return 'drop';
  // BOM in mezzo al testo.
  if (code === 0xfeff) return 'drop';
  // I TAG DEL PIANO 14: U+E0000..U+E007F. Sono una copia invisibile
  // dell'ASCII, e servono a UNA cosa sola — scrivere un testo che si legge
  // solo a macchina. In un nome di giocatore non hanno nessun uso legittimo.
  if (code >= 0xe0000 && code <= 0xe007f) return 'drop';
  return 'keep';
}

/**
 * Ripulisce e marchia una stringa di terzi. `null` se non resta niente.
 *
 * Il taglio si DICHIARA con un carattere di continuazione: un commento
 * troncato in silenzio e' un commento di cui chi legge non sa di aver visto
 * solo l'inizio.
 */
export function untrusted(value: unknown, max: number = UNTRUSTED_MAX): Untrusted | null {
  if (value === null || value === undefined) return null;
  const raw = typeof value === 'string' ? value : String(value);

  let out = '';
  for (const ch of raw) {
    const kind = classify(ch.codePointAt(0) ?? 0);
    if (kind === 'keep') out += ch;
    else if (kind === 'space') out += ' ';
    // `drop`: niente, e le due meta' della parola si ricongiungono.
  }
  const cleaned = out.replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return null;
  const capped = cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
  return capped as Untrusted;
}

/**
 * Le forme che un tentativo di dirottamento prende piu' spesso.
 *
 * ELENCO PARZIALE PER COSTRUZIONE, e va bene cosi' perche' non decide niente.
 * Vedi la nota in testa al file: se questo fosse un filtro, un elenco
 * parziale sarebbe una falla; come spia e' informazione in piu' che non
 * toglie nulla a nessuno.
 */
const INJECTION_SHAPES: readonly RegExp[] = [
  /\bignor(a|are|e|ing)\b[^.]{0,40}\b(istruzion|instruction|regol|rules|prompt)/i,
  /\b(prompt di sistema|system prompt|initial prompt)\b/i,
  /\b(sei|agisci come|you are|act as)\b[^.]{0,30}\b(assistente|assistant|ai|modello|model)\b/i,
  /\b(rivela|mostra|dimmi|reveal|show me|repeat)\b[^.]{0,30}\b(istruzion|instruction|prompt|regol|rules)\b/i,
  /^\s*(system|assistant|user)\s*[:>]/im,
  /<\|[^|]*\|>/,
  /\b(esegui|chiama|invoca|call|run|execute)\b[^.]{0,30}\b(strumento|tool|funzione|function|comando|command)\b/i,
  /\bnew instructions?\b|\bnuove istruzioni\b/i,
  // I jailbreak con un nome: «do anything now» (DAN) e i suoi parenti. Il nome
  // cambia in continuazione, la formula «puoi fare qualsiasi cosa / non hai
  // regole» meno.
  /\bdo anything now\b|\bjailbreak\b|\b(senza|nessun[ae]?)\s+(regol|restrizion|limit|filtr)/i,
];

/** `true` se il testo SEMBRA rivolto al modello. Annotazione, non verdetto. */
export function looksLikeInjection(value: string | null): boolean {
  if (value === null || value.length === 0) return false;
  return INJECTION_SHAPES.some((re) => re.test(value));
}

/**
 * Un campo di testo di terzi, pronto per il risultato di un tool.
 *
 * Porta il testo e, quando serve, la spia. `suspicious` compare SOLO quando e'
 * vero: un campo che dice `false` su ogni riga diventa rumore, e la riga in
 * cui dice `true` si perde in mezzo.
 */
export type UntrustedField = { text: Untrusted; suspicious?: true };

export function field(value: unknown, max: number = UNTRUSTED_MAX): UntrustedField | null {
  const text = untrusted(value, max);
  if (text === null) return null;
  return looksLikeInjection(text) ? { text, suspicious: true } : { text };
}
