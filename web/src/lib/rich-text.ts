// La formattazione delle risposte di Svetlana, ridotta all'osso.
//
// PERCHE' ESISTE. Il prompt le dice di scrivere in testo semplice, e lei lo
// fa quasi sempre — ma «quasi» qui significa che ogni tanto arrivano `**` e
// trattini, e la chat li mostrava tali e quali: `**1.240 di media**`. Un
// modello non si convince con una frase piu' severa; si convince meglio il
// lettore mostrandogli la cosa giusta. Quindi si legge il poco Markdown che
// produce davvero, invece di combatterlo.
//
// PERCHE' A MANO E NON UNA LIBRERIA. Una libreria Markdown porta dentro tutto
// il linguaggio, e di quel linguaggio la meta' non ci serve e una parte e'
// pericolosa: HTML grezzo, immagini, link. Qui la superficie e' chiusa per
// costruzione — quattro marcatori in linea e tre tipi di riga — e non c'e'
// nessuna sintassi che possa diventare qualcosa di piu' di testo.
//
// I LINK NON SI FANNO, ed e' una decisione di sicurezza, non una mancanza.
// Svetlana CITA testo scritto dai giocatori: nomi, motivazioni di ban,
// commenti. Se `[clicca](...)` diventasse un collegamento vero, chiunque possa
// scrivere in gioco potrebbe mettere un bersaglio cliccabile dentro la chat di
// un amministratore, e nessuna sanificazione dell'URL rende quella una buona
// idea. La sintassi resta li' com'e' scritta: si legge, non si clicca.
//
// E il risultato sono DATI, non elementi. Il componente li disegna con React,
// che scrive testo e mai marcatura: e' cio' che tiene la guardia
// `sec-35/no-innerHTML` soddisfatta senza doverci pensare, ed e' anche cio'
// che rende questo file provabile senza montare un browser.

/** Un pezzo di riga, con addosso il modo in cui va scritto. */
export type Span = {
  text: string;
  bold?: true;
  italic?: true;
  code?: true;
};

/**
 * Una riga.
 *
 * `bullet` e `numbered` sono elenchi; `heading` e' un titolo che il modello ha
 * scritto con i cancelletti. `blank` esiste perche' una riga vuota separa due
 * paragrafi, e buttarla via incollerebbe insieme cose che il modello aveva
 * deciso di staccare.
 */
export type Line =
  | { kind: 'text'; spans: Span[] }
  | { kind: 'heading'; spans: Span[] }
  | { kind: 'bullet'; spans: Span[] }
  | { kind: 'numbered'; marker: string; spans: Span[] }
  | { kind: 'blank' };

/**
 * I marcatori in linea. L'ordine conta solo A PARITA' DI POSIZIONE.
 *
 * Il grassetto sta prima del corsivo perche' `**x**` soddisfa tutte e due le
 * regole partendo dallo stesso carattere: con quella del corsivo si leggerebbe
 * come un corsivo il cui contenuto e' `*x*`, che non e' cio' che qualcuno ha
 * scritto.
 *
 * Ogni espressione pretende che il contenuto NON sia vuoto e non cominci con
 * uno spazio: `** ` a inizio riga e' un elenco puntato scritto male, non
 * l'apertura di un grassetto, e trattarlo come apertura mangerebbe mezzo
 * messaggio in attesa di una chiusura che non arriva.
 */
const INLINE: ReadonlyArray<{ re: RegExp; mark: keyof Omit<Span, 'text'> }> = [
  { re: /`([^`\n]+)`/, mark: 'code' },
  { re: /\*\*(\S(?:[^*\n]*\S)?)\*\*/, mark: 'bold' },
  { re: /(?:\*(\S(?:[^*\n]*\S)?)\*|_(\S(?:[^_\n]*\S)?)_)/, mark: 'italic' },
];

/**
 * Spezza una riga nei suoi pezzi.
 *
 * VINCE CHI COMINCIA PRIMA, e non chi sta piu' in alto nell'elenco. Provare i
 * marcatori in ordine fisso sembra piu' semplice e sbaglia: col codice provato
 * per primo, `**molto `veloce`**` si spezzava sul codice, e il grassetto —
 * che comincia sei caratteri prima e li contiene entrambi — restava fuori,
 * lasciando due asterischi visibili in mezzo alla frase. Guardando invece chi
 * apre per primo, il grassetto prende tutto e il codice si ritrova dentro,
 * che e' l'annidamento giusto.
 *
 * Il codice resta comunque protetto: in `la chiave `a**b` non cambia` il
 * grassetto non ha una seconda coppia di asterischi, quindi non c'e' proprio
 * gara — e a parita' di partenza il codice viene prima nell'elenco.
 *
 * IN STREAMING UN MARCATORE APERTO E' TESTO. La risposta arriva a pezzi, e a
 * meta' strada `**1.240 di me` non ha ancora la sua chiusura: qui resta cio'
 * che e', cioe' quello che si vede, e diventa grassetto quando la chiusura
 * arriva. L'alternativa — indovinare la chiusura — farebbe lampeggiare mezza
 * bolla a ogni pacchetto.
 */
function spansOf(text: string): Span[] {
  if (text === '') return [];

  let best: { hit: RegExpExecArray; mark: keyof Omit<Span, 'text'> } | null = null;
  for (const { re, mark } of INLINE) {
    const hit = re.exec(text);
    // `<` e non `<=`: a parita' di posizione tiene il primo trovato, cioe'
    // l'ordine dell'elenco qui sopra.
    if (hit && (best === null || hit.index < best.hit.index)) best = { hit, mark };
  }
  if (best === null) return [{ text }];

  const { hit, mark } = best;
  // Il corsivo ha due forme e quindi due gruppi: quello che ha acchiappato e'
  // l'unico dei due che non sia `undefined`.
  const inner = hit[1] ?? hit[2] ?? '';
  const start = hit.index;
  const end = start + hit[0].length;
  return [
    ...spansOf(text.slice(0, start)),
    // Dentro il codice non si cerca piu' niente: e' testo alla lettera, ed e'
    // esattamente per questo che qualcuno lo scrive.
    ...(mark === 'code' ? [{ text: inner, code: true as const }] : markAll(spansOf(inner), mark)),
    ...spansOf(text.slice(end)),
  ];
}

/** Aggiunge un modo a pezzi gia' spezzati: serve per grassetto che contiene codice. */
function markAll(spans: Span[], mark: keyof Omit<Span, 'text'>): Span[] {
  return spans.map((span) => ({ ...span, [mark]: true as const }));
}

const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,3})[.)]\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;

/**
 * Il testo di una risposta, riga per riga.
 *
 * Le righe si conservano TUTTE, vuote comprese: la bolla non usa piu'
 * `pre-wrap`, quindi gli a capo che prima venivano dal foglio di stile adesso
 * devono venire da qui. Perderne uno significa incollare due paragrafi.
 */
export function richText(text: string): Line[] {
  return text.split('\n').map((raw): Line => {
    if (raw.trim() === '') return { kind: 'blank' };

    const heading = HEADING.exec(raw);
    if (heading) return { kind: 'heading', spans: spansOf(heading[1] ?? '') };

    const numbered = NUMBERED.exec(raw);
    if (numbered) return { kind: 'numbered', marker: `${numbered[1]}.`, spans: spansOf(numbered[2] ?? '') };

    const bullet = BULLET.exec(raw);
    if (bullet) return { kind: 'bullet', spans: spansOf(bullet[1] ?? '') };

    return { kind: 'text', spans: spansOf(raw) };
  });
}
