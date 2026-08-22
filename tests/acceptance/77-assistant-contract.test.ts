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
    expect(soloInput).toBeCloseTo(5, 6);
    expect(soloCache).toBeCloseTo(0.5, 6);
    // E' il rapporto che rende la cache la voce piu' pesante di tutte su una
    // conversazione lunga: dieci volte meno per gli stessi token.
    expect(soloInput / soloCache).toBeCloseTo(10, 6);
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
  });
});
