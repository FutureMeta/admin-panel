// Svetlana deve saper stimare, e il metodo con cui stima deve essere eseguibile.
//
// IL DIFETTO DI PARTENZA. A «quanti duels faremo nei prossimi giorni» rispondeva
// che non poteva dare previsioni affidabili. Non era timidezza del modello: era
// scritto nel prompt. La riga contro i numeri inventati diceva «riferisci quello
// invece di STIMARE un numero», e quella parola non distingue le due cose che
// vanno distinte:
//
//   * inventare un dato che non si e' letto — resta il danno peggiore possibile
//     in un pannello di amministrazione, e resta vietato;
//   * fare i conti su dati letti davvero — che e' esattamente il mestiere, e
//     rifiutarsi di farlo non e' prudenza: e' non aver risposto.
//
// Un rifiuto suona sempre piu' sicuro di una stima, e per questo e' la risposta
// che un modello sceglie quando gli si lascia un appiglio. Gli appigli erano
// tre, sparsi in tre sezioni diverse, e i test qui sotto li tengono chiusi.
//
// COSA PUO' E COSA NON PUO' PROVARE QUESTO FILE. Nessun test parla con l'API,
// quindi non si prova che la risposta sia buona — quello si vede in chat. Si
// prova cio' che e' nostro: che il prompt insegni un metodo, e — la parte che
// conta di piu' — che i dati su cui quel metodo poggia esistano davvero nei
// payload che gli strumenti restituiscono. Un'istruzione che chiede un campo
// che nessuno manda e' peggio di nessuna istruzione: manda a inventare.

import { describe, expect, it } from 'vitest';
import { SYSTEM_PROMPT } from '#src/assistant/prompt.ts';
import type { DuelsSummary, NetworkTrend } from '#src/assistant/reader.ts';

describe('il prompt insegna a stimare, non a scappare', () => {
  it('c`e` una sezione sulle stime, e dice di rispondere con un numero', () => {
    expect(SYSTEM_PROMPT).toContain('## Stime e proiezioni');
    // Il canarino: e' la frase che nomina il modo esatto di sbagliare. Se
    // qualcuno riscrive la sezione perdendola per strada, questo test lo dice.
    expect(SYSTEM_PROMPT).toContain("non e' prudenza: e' non aver risposto");
  });

  it('e NON dice piu` di riferire il guasto «invece di stimare»', () => {
    // LA RIGA CHE HA CAUSATO IL DIFETTO. Rimetterla riaccende il rifiuto, e
    // nient'altro in questo file se ne accorgerebbe: la parola sta in una
    // sezione, l'effetto si vede in un'altra.
    expect(SYSTEM_PROMPT).not.toContain('invece di stimare');
    // Il divieto vero, quello che deve restare, e' sull'INVENTARE.
    expect(SYSTEM_PROMPT).toContain('Inventare un dato che non hai letto');
  });

  it('una stima sui dati del pannello non e` «fuori ambito»', () => {
    // Il secondo appiglio: la sezione su cio' di cui non si occupa elenca
    // «consigli» e «opinioni», e una previsione somiglia a tutte e due. Senza
    // questa riga, la domanda finiva chiusa in una riga come una ricetta.
    expect(SYSTEM_PROMPT).toContain("Una stima sui dati del pannello NON e' fuori ambito");
  });

  it('e «circa 1.200» resta vietato per la ragione giusta', () => {
    // Il terzo appiglio, il piu' subdolo: la regola sui numeri verificabili
    // faceva da esempio negativo proprio a un valore approssimato. Letta di
    // fianco a una richiesta di stima, diceva «non dare numeri approssimati».
    // Adesso dice perche': manca il periodo, non manca la precisione.
    expect(SYSTEM_PROMPT).toContain("non perche' sia approssimato");
    expect(SYSTEM_PROMPT).toContain("Una stima e' approssimata per natura e va benissimo");
  });
});

describe('il metodo che insegna e` eseguibile con i dati che riceve', () => {
  it('divide per i giorni COPERTI, e i due campi per saperlo esistono', () => {
    // L'ERRORE CHE QUESTA RIGA EVITA e' silenzioso: un periodo di sette giorni
    // che ne contiene tre di dati, diviso per sette, da' un ritmo poco piu' di
    // meta' di quello vero. La stima esce plausibile e sbagliata — cioe' il
    // danno che tutto il resto del prompt cerca di impedire.
    expect(SYSTEM_PROMPT).toContain('Giorni COPERTI, non giorni nominali');

    // I due campi che servono a saperlo. Il controllo e' a livello di tipo:
    // se un domani un payload dimagrisse, questo file non compilerebbe piu' —
    // e il prompt chiederebbe al modello un dato che nessuno gli manda, cioe'
    // lo manderebbe a indovinare.
    const since: DuelsSummary extends { since: unknown } ? true : false = true;
    const coverage: NetworkTrend extends { coverage: number } ? true : false = true;
    expect(since && coverage).toBe(true);
  });

  it('confronta due periodi, e i periodi chiesti sono periodi che esistono', () => {
    // «7d e 30d» non sono nomi inventati nel prompt: sono due dei valori che
    // lo schema degli strumenti accetta. Un prompt che nominasse un periodo
    // inesistente produrrebbe una chiamata rifiutata a ogni stima.
    expect(SYSTEM_PROMPT).toContain('di solito 7d, e 30d accanto');
    const ranges: Array<NetworkTrend['range']> = ['7d', '30d'];
    expect(ranges).toEqual(['7d', '30d']);
  });

  it('i limiti si dicono DOPO il numero, e in una riga', () => {
    // Senza questo vincolo il modello scrive tre righe di cautela e poi la
    // stima — che si legge come un rifiuto con un numero in fondo. L'ordine e'
    // meta' della risposta.
    expect(SYSTEM_PROMPT).toContain('I limiti si dicono in UNA riga, dopo il numero');
    expect(SYSTEM_PROMPT).toContain('non si chiude una risposta con un avvertimento al posto della stima');
  });

  it('ci si ferma solo quando manca davvero la base', () => {
    // Il rifiuto resta possibile: dev'esserlo, o si torna a inventare. Ma
    // dev'essere specifico — quale delle tre cose manca — e non la formula
    // generica da cui e' partito tutto.
    expect(SYSTEM_PROMPT).toContain('Ci si ferma davvero solo quando manca la base');
    expect(SYSTEM_PROMPT).toContain('non «non posso fare previsioni»');
  });
});
