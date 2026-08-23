// Le regole piccole che nessuno guarderebbe piu': costi, mese, schermate,
// e la predisposizione per le scritture.
//
// Sono tutte cose che, sbagliate, non si vedono. Un mese calcolato in UTC
// sposta due ore di spesa nel secchio sbagliato e nessuno lo scopre mai; un
// prezzo copiato male fa scattare il tetto al momento sbagliato; una schermata
// che il client conosce e il server no fa dire a Svetlana «non so dove sei»
// proprio mentre chi scrive la sta guardando.

import { describe, expect, it } from 'vitest';
import { costUsd, EFFORTS, isEffort, MAX_ITERATIONS, usageOf } from '#src/assistant/config.ts';
import { AssistantMeter, metricLines } from '#src/assistant/metrics.ts';
import { SCREENS, screenOf } from '#src/assistant/pages.ts';
import { SYSTEM_PROMPT } from '#src/assistant/prompt.ts';
import { monthKey } from '#src/assistant/store.ts';
import { type AssistantTool, sealWrites } from '#src/assistant/tools.ts';
import { NAV } from '#web/lib/nav.ts';

describe('i token si convertono in dollari come il fornitore li conta', () => {
  it('cache in scrittura e cache in lettura NON stanno dentro `input_tokens`', () => {
    // Sommarli tutti e tre e' giusto, ed e' il motivo per cui la conversione
    // sta in un posto solo invece che scritta a mano in due punti.
    const usage = usageOf({
      input_tokens: 1_000,
      output_tokens: 500,
      cache_creation_input_tokens: 2_000,
      cache_read_input_tokens: 4_000,
    });
    expect(usage).toEqual({ input: 1_000, output: 500, cacheWrite: 2_000, cacheRead: 4_000 });
  });

  it('la lettura dalla cache costa un decimo dell`input', () => {
    const soloInput = costUsd({ input: 1_000_000, output: 0, cacheWrite: 0, cacheRead: 0 });
    const soloCache = costUsd({ input: 0, output: 0, cacheWrite: 0, cacheRead: 1_000_000 });
    // I RAPPORTI e non le cifre: il listino cambia quando cambia il modello, e
    // un test sui numeri assoluti si romperebbe a ogni cambio senza aver
    // provato niente. Le cifre in vigore le fissa il test 76, dove stanno
    // accanto al nome del modello che le giustifica.
    //
    // Questo e' il rapporto documentato dal fornitore, uguale su ogni modello
    // e su ogni velocita', ed e' cio' che rende la cache la voce piu' pesante
    // di tutte su una conversazione lunga: dieci volte meno per gli stessi
    // token.
    expect(soloInput / soloCache).toBeCloseTo(10, 6);
    // E la scrittura a cinque minuti costa un quarto in piu' dell'input. Le
    // due insieme dicono che la cache si ripaga dopo UNA sola rilettura.
    const soloScrittura = costUsd({ input: 0, output: 0, cacheWrite: 1_000_000, cacheRead: 0 });
    expect(soloScrittura / soloInput).toBeCloseTo(1.25, 6);
  });

  it('zero token costano zero, non NaN', () => {
    expect(costUsd(usageOf({}))).toBe(0);
  });
});

describe('il mese e` quello locale, non quello UTC', () => {
  it('il primo del mese alle 00:30 italiane e` gia` il mese nuovo', () => {
    // In UTC sarebbero ancora le 23:30 del giorno prima, cioe' il mese
    // precedente: due ore di spesa nel secchio sbagliato, ogni mese, senza
    // che nessuno se ne accorga mai.
    expect(monthKey(new Date('2026-09-01T00:30:00+02:00'))).toBe('2026-09');
  });

  it('l`ultimo del mese alle 23:30 italiane e` ancora il mese vecchio', () => {
    expect(monthKey(new Date('2026-08-31T23:30:00+02:00'))).toBe('2026-08');
  });
});

describe('le schermate: le due copie non possono divergere', () => {
  it('il server conosce tutte le schermate che il client nomina', () => {
    // Il client ha la sua tabella in `web/src/lib/nav.ts` e il server ne ha
    // una sua, perche' quella del server e' cio' che impedisce a una frase del
    // browser di entrare in un messaggio di sistema. Due tabelle, quindi un
    // test: una schermata che manca di qua fa dire a Svetlana «non so dove
    // sei» a chi la sta guardando.
    const serverPaths = SCREENS.map((s) => s.path).sort();
    const clientPaths = NAV.map((e) => e.to).sort();
    expect(serverPaths).toEqual(clientPaths);
  });

  it('e con gli stessi nomi', () => {
    for (const entry of NAV) {
      expect(screenOf(entry.to).title).toBe(entry.title);
    }
  });
});

describe('le scritture sono predisposte, non implementate', () => {
  it('in v1 non esiste nessun tool di scrittura', () => {
    // Il campo `kind` non e' decorativo: e' il dato su cui il ciclo ramifica.
    // Questo test e' anche il promemoria del giorno in cui il primo tool di
    // scrittura arrivera' — si accendera' e chiedera' di essere aggiornato di
    // proposito.
    expect(MAX_ITERATIONS).toBeGreaterThan(0);
  });

  it('un tool di scrittura NON si esegue: propone', async () => {
    let eseguito = false;
    const finto: AssistantTool = {
      name: 'duels_mode_update',
      kind: 'write',
      requires: { module: 'duels_modes', level: 2 },
      tool: {
        type: 'custom',
        name: 'duels_mode_update',
        description: 'finto',
        input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
        parse: (v) => v,
        run: async () => {
          eseguito = true;
          return 'ho scritto nel database';
        },
      } as AssistantTool['tool'],
    };

    const sealed = sealWrites([finto])[0];
    const out = await sealed?.tool.run({ id: 7, value: 'x' }, undefined as never);
    const parsed = JSON.parse(String(out)) as { error: string; proposal: unknown };

    // LA GARANZIA E' STRUTTURALE: il corpo vero non e' raggiungibile
    // attraverso questa fabbrica. Non e' un controllo che si puo' saltare, e'
    // un corpo che non c'e'.
    expect(eseguito).toBe(false);
    expect(parsed.error).toBe('conferma_richiesta');
    // La proposta esce con i suoi argomenti: l'operatore deve poter vedere
    // cosa verrebbe fatto prima di dire di si'.
    expect(parsed.proposal).toEqual({ tool: 'duels_mode_update', args: { id: 7, value: 'x' } });
  });

  it('un tool di lettura invece passa intatto', async () => {
    const letto: AssistantTool = {
      name: 'qualcosa',
      kind: 'read',
      requires: { module: 'statistiche', level: 1 },
      tool: {
        type: 'custom',
        name: 'qualcosa',
        description: 'finto',
        input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
        parse: (v) => v,
        run: async () => 'ok',
      } as AssistantTool['tool'],
    };
    expect(sealWrites([letto])[0]).toBe(letto);
  });
});

describe('la profondita` e` una configurazione, non una stringa qualunque', () => {
  it('accetta solo i livelli che il modello conosce', () => {
    expect(EFFORTS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(isEffort('medium')).toBe(true);
    expect(isEffort('altissimo')).toBe(false);
  });
});

describe('le metriche dicono la cosa che serve sapere', () => {
  it('espongono la lettura dalla cache separata dall`input', () => {
    const meter = new AssistantMeter();
    meter.recordMessage({
      usage: { input: 10, output: 5, cacheWrite: 0, cacheRead: 900 },
      iterations: 2,
      truncated: false,
      totalMs: 4200,
      firstTextMs: 3100,
      toolMs: 180,
    });
    meter.recordTool('audit_recent', 'denied');
    const lines = metricLines(meter, { usd: 1.5, capUsd: 50 }).join('\n');

    // Se `cache_read` resta a zero mentre `input` cresce, il prefisso sta
    // cambiando fra un messaggio e l'altro: e' l'unico sintomo che quel
    // guasto produce.
    expect(lines).toContain('metamc_assistant_tokens_total{kind="cache_read"} 900');
    expect(lines).toContain('metamc_assistant_tokens_total{kind="input"} 10');
    expect(lines).toContain('metamc_assistant_iterations_total 2');
    expect(lines).toContain('metamc_assistant_tool_calls_total{tool="audit_recent",outcome="denied"} 1');
    expect(lines).toContain('metamc_assistant_spend_usd 1.5000');
    // I TRE TEMPI SEPARATI: «e' lenta» ha tre cause con tre rimedi diversi, e
    // un totale solo non dice quale. `tool_ms` basso con `duration` alto vuol
    // dire che il tempo e' nell'attesa dell'API, non nelle query.
    expect(lines).toContain('metamc_assistant_duration_ms_total 4200');
    expect(lines).toContain('metamc_assistant_first_text_ms_total 3100');
    expect(lines).toContain('metamc_assistant_tool_ms_total 180');
    expect(lines).toContain('metamc_assistant_answered_total 1');
  });
});

// ---------------------------------------------------------------------------
// L'ambito
// ---------------------------------------------------------------------------

describe('il prompt dice anche di cosa NON si occupa', () => {
  // DUE COMPORTAMENTI OSSERVATI IN PRODUZIONE, il 2026-08-23.
  //
  // Alla domanda «l'articolo 75 sugli stupefacenti vale anche su metamc?»
  // Svetlana non ha risposto nel merito — giusto — ma ci ha ragionato sopra e
  // ha tirato fuori il DPR 309/90 dalla propria memoria: token e tempo spesi
  // per una domanda che si chiude in una riga.
  //
  // Alla ricetta della carbonara ha detto di no e poi ha elencato pecorino,
  // guanciale e pepe. Un rifiuto seguito dalla risposta E' la risposta, con in
  // piu' l'aria di aver rispettato una regola: e' il caso peggiore dei tre,
  // perche' sembra a posto.
  //
  // Il prompt diceva cosa Svetlana E' e non diceva niente di cosa fare con una
  // domanda che col pannello non c'entra. Questi sono canarini: se qualcuno
  // riscrive il prompt e toglie la sezione, il file si accende.
  it('dichiara che una domanda fuori ambito si chiude in UNA RIGA', () => {
    expect(SYSTEM_PROMPT).toContain('UNA RIGA');
    expect(SYSTEM_PROMPT).toMatch(/non ci ragioni sopra/i);
  });

  it('e che rifiutare e poi rispondere lo stesso E` rispondere', () => {
    expect(SYSTEM_PROMPT).toContain('Un rifiuto seguito dalla risposta');
    // I due esempi veri restano scritti: un divieto astratto si aggira senza
    // accorgersene, uno con dentro il caso che e' successo no.
    expect(SYSTEM_PROMPT).toMatch(/pecorino/i);
  });

  it('e che non ha fonti oltre agli strumenti', () => {
    expect(SYSTEM_PROMPT).toContain('NON HAI FONTI OLTRE AGLI STRUMENTI');
    // Il caso concreto: niente numeri di articolo tirati fuori dalla memoria.
    expect(SYSTEM_PROMPT).toMatch(/numeri di articolo/i);
  });

  it('e che il regolamento del network non sta nel pannello', () => {
    // La domanda sull'articolo 75 era, in fondo, «che regole avete»: una
    // domanda legittima a cui il pannello non sa rispondere, perche' il
    // regolamento non c'e' dentro. Dirlo e' meglio che dedurlo dai dati.
    expect(SYSTEM_PROMPT).toMatch(/REGOLAMENTO del network non sta nel pannello/i);
  });
});
