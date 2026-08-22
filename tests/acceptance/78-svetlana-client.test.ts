// Il lato client: leggere lo stream e tenere lo stato della chat.
//
// PERCHE' QUESTO FILE ESISTE. Un pacchetto SSE spezzato fra due `chunk` della
// rete non produce nessun errore: produce un JSON incompleto che si butta via,
// cioe' una parola che manca in mezzo a una frase. In locale non succede mai —
// i pacchetti arrivano interi — e in produzione succede appena la risposta si
// allunga o la rete e' lenta. E' un difetto che si scopre leggendo una
// risposta che non torna, senza nessun indizio su dove guardare.
//
// Quindi i byte si tagliano nei punti peggiori, apposta.

import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  askedState,
  initialState,
  OPENING_TEXT,
  pageFilters,
  readChunk,
  type SvEvent,
  toolLabel,
} from '#web/lib/svetlana.ts';

function frame(event: SvEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

describe('lo stream si legge anche quando arriva a pezzi', () => {
  it('un pacchetto intero produce un evento', () => {
    const { events, carry } = readChunk('', frame({ type: 'text', delta: 'ciao' }));
    expect(events).toEqual([{ type: 'text', delta: 'ciao' }]);
    expect(carry).toBe('');
  });

  it('un pacchetto tagliato a meta` aspetta il resto', () => {
    const whole = frame({ type: 'text', delta: 'milleduecento' });
    const cut = Math.floor(whole.length / 2);

    const first = readChunk('', whole.slice(0, cut));
    // Niente eventi: il pacchetto non e' finito. Se `readChunk` provasse a
    // interpretarlo comunque, quella parola sparirebbe dalla frase.
    expect(first.events).toEqual([]);

    const second = readChunk(first.carry, whole.slice(cut));
    expect(second.events).toEqual([{ type: 'text', delta: 'milleduecento' }]);
  });

  it('tagliato in OGNI punto possibile, il testo che arriva e` sempre lo stesso', () => {
    const whole =
      frame({ type: 'start', conversationId: 'c-1' }) +
      frame({ type: 'text', delta: 'sono ' }) +
      frame({ type: 'text', delta: '1.240 ' }) +
      frame({ type: 'text', delta: 'di media' }) +
      frame({ type: 'done', usage: null, iterations: 1, truncated: false });

    for (let cut = 0; cut <= whole.length; cut += 1) {
      let carry = '';
      let text = '';
      for (const piece of [whole.slice(0, cut), whole.slice(cut)]) {
        const out = readChunk(carry, piece);
        carry = out.carry;
        for (const event of out.events) if (event.type === 'text') text += event.delta;
      }
      expect(text, `taglio a ${cut}`).toBe('sono 1.240 di media');
    }
  });

  it('piu` pacchetti in un chunk solo escono tutti, in ordine', () => {
    const { events } = readChunk(
      '',
      frame({ type: 'text', delta: 'a' }) + frame({ type: 'text', delta: 'b' }),
    );
    expect(events.map((e) => (e.type === 'text' ? e.delta : ''))).toEqual(['a', 'b']);
  });

  it('una riga storta non ferma la chat', () => {
    const { events } = readChunk('', `data: {non e' json}\n\n${frame({ type: 'text', delta: 'ok' })}`);
    // Una chat che smette di funzionare per una riga storta e' peggio di una
    // chat a cui manca una riga.
    expect(events).toEqual([{ type: 'text', delta: 'ok' }]);
  });
});

describe('lo stato della chat', () => {
  it('si apre con il messaggio del mockup', () => {
    expect(initialState().messages).toMatchObject([{ from: 'bot', text: OPENING_TEXT }]);
    expect(OPENING_TEXT).toContain('Ciao, sono Svetlana');
  });

  it('la domanda compare subito, prima di qualunque risposta', () => {
    const s = askedState(initialState(), 'quanti online?');
    expect(s.messages.at(-1)).toMatchObject({ from: 'user', text: 'quanti online?' });
    expect(s.busy).toBe(true);
  });

  it('il testo si accumula e diventa un messaggio solo alla fine', () => {
    let s = askedState(initialState(), 'quanti online?');
    s = applyEvent(s, { type: 'text', delta: 'sono ' });
    s = applyEvent(s, { type: 'text', delta: '1.240' });
    expect(s.streaming).toBe('sono 1.240');
    // Finche' si forma non e' ancora un messaggio: si disegna a parte, cosi'
    // non resta a meta' nell'elenco se la connessione cade.
    expect(s.messages).toHaveLength(2);

    s = applyEvent(s, { type: 'done', usage: null, iterations: 1, truncated: false });
    expect(s.messages.at(-1)).toMatchObject({ from: 'bot', text: 'sono 1.240' });
    expect(s.streaming).toBeNull();
    expect(s.busy).toBe(false);
  });

  it('una risposta troncata lo DICE', () => {
    let s = askedState(initialState(), 'una domanda difficile');
    s = applyEvent(s, { type: 'text', delta: 'ho guardato tre cose' });
    s = applyEvent(s, { type: 'done', usage: null, iterations: 6, truncated: true });
    // Una risposta incompleta che sembra completa e' peggio di un errore.
    expect(s.messages.at(-1)?.text).toContain('fermata prima di finire');
  });

  it('il tool in corso si accende e si spegne', () => {
    let s = askedState(initialState(), 'x');
    s = applyEvent(s, { type: 'tool', name: 'network_online', outcome: 'running' });
    expect(s.tool).toBe('network_online');
    s = applyEvent(s, { type: 'tool', name: 'network_online', outcome: 'success' });
    expect(s.tool).toBeNull();
  });

  it('un errore sblocca il campo di testo', () => {
    let s = askedState(initialState(), 'x');
    s = applyEvent(s, { type: 'error', code: 'x', message: 'non ce l`ho fatta' });
    // Senza, il campo resterebbe disabilitato per sempre e la chat sembrerebbe
    // rotta invece che momentaneamente in errore.
    expect(s.busy).toBe(false);
    expect(s.error).toBe('non ce l`ho fatta');
  });

  it('la conversazione la nomina il server, non il client', () => {
    const s = applyEvent(initialState(), { type: 'start', conversationId: 'c-9' });
    expect(s.conversationId).toBe('c-9');
  });

  it('i tool si chiamano per quello che fanno, non per come si chiamano', () => {
    expect(toolLabel('network_online')).toContain('online');
    // Un nome sconosciuto ripiega sul suo nome vero: meglio di «sto lavorando».
    expect(toolLabel('qualcosa_di_nuovo')).toContain('qualcosa_di_nuovo');
  });
});

describe('il contesto della pagina si deriva, non si passa in giro', () => {
  it('il periodo si manda solo dove governa qualcosa', () => {
    expect(pageFilters('/panoramica', '30d')).toEqual({ range: '30d' });
    // Su Modes il selettore non c'e': mandarlo direbbe a Svetlana che chi
    // scrive ha scelto un intervallo che invece non ha scelto.
    expect(pageFilters('/duels/modes', '30d')).toEqual({});
  });

  it('la modalita` esce dal percorso, se e` una chiave', () => {
    expect(pageFilters('/dettaglio-modalita/bedwars', '7d')).toEqual({ range: '7d', mode: 'bedwars' });
    // Fuori dall'alfabeto del contratto non e' una chiave, e il server la
    // rifiuterebbe comunque: non si manda.
    expect(pageFilters('/dettaglio-modalita/Bed Wars!', '7d')).toEqual({ range: '7d' });
  });
});
