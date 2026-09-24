// Il dizionario delle modalita': etichette, colori, ordine e bandiere,
// letti una volta per giro e ripresi da ogni payload.

import { sql } from 'kysely';
import type { Database } from '#src/db/pool.ts';

export async function modeLabels(db: Database): Promise<ModeDictionary> {
  const res = await sql<{
    mode_key: string;
    display_name: string;
    sort_order: number;
    color: string | null;
    hidden: boolean;
    in_breakdown: boolean;
  }>`
    -- L'ORDINE E' PARTE DEL DATO, non una comodita'. Le modalita' senza
    -- colore proprio lo prendono dalla loro POSIZIONE in questo elenco: senza
    -- ORDER BY, PostgreSQL non promette nulla sull'ordine di un DISTINCT, e
    -- due esecuzioni identiche potrebbero ricolorare la schermata.
    SELECT DISTINCT mode_key, display_name, sort_order, color, hidden, in_breakdown
      FROM stats.v_server_mode
     ORDER BY sort_order, mode_key
  `.execute(db);
  return new Map(
    res.rows.map((r) => [
      r.mode_key,
      {
        label: r.display_name,
        order: Number(r.sort_order),
        color: r.color,
        hidden: r.hidden,
        inBreakdown: r.in_breakdown,
      },
    ]),
  );
}

type ModeDictionary = Map<
  string,
  { label: string; order: number; color: string | null; hidden: boolean; inBreakdown: boolean }
>;

/**
 * I nomi di TUTTE le modalita' conosciute, non solo di quelle nel range.
 *
 * Il ritaglio sul range e' il difetto: su un periodo il cui storico non esiste
 * ancora l'elenco e' vuoto, la schermata ripiega sulla chiave grezza, e si
 * legge «arena» minuscolo dove ovunque altrove c'e' «Arena». Sembra un
 * problema di dati e invece e' una proiezione fatta nel posto sbagliato.
 *
 * `__transit__` e `__unknown__` CI SONO, perche' sono serie visibili: la torta
 * deve chiudere sul totale, e senza di loro il primo che se ne accorge
 * normalizza le percentuali — cioe' spalma i non classificati sulle modalita'
 * vere. `v_server_mode` gli da' gia' un nome («In transito», «Non
 * classificata»), che e' esattamente quello che qui serve.
 *
 * `__network__` no: e' il totale, non una modalita'. Nessun riquadro lo
 * disegna come serie, e lasciarlo in elenco sposterebbe di un posto i colori
 * di ripiego, che si scelgono per posizione.
 */
export function dictionaryLabels(dict: ModeDictionary): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, v] of dict) if (key !== '__network__') out[key] = v.label;
  return out;
}

/**
 * I colori scelti dall'operatore, per chiave.
 *
 * Solo quelli davvero impostati: una modalita' senza colore non entra, e la
 * schermata ripiega. Riempire qui i buchi con un colore inventato farebbe
 * sembrare deciso cio' che non lo e', e nessuno andrebbe piu' a impostarlo.
 */
export function dictionaryColors(dict: ModeDictionary): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, v] of dict) if (v.color) out[key] = v.color;
  return out;
}

/**
 * Le modalita' che non si disegnano, e quelle che non sono una fetta.
 *
 * NESSUNO DEI DUE TOCCA UN TOTALE, ed e' il vincolo che li tiene onesti. La
 * riga di rete e' misurata, non sommata dalle modalita': togliere una serie
 * dal disegno non puo' spostarla di un giocatore. Se potesse, «nascondi»
 * sarebbe un altro nome per «falsifica», e chi guarda non avrebbe modo di
 * accorgersene.
 *
 * Erano impostabili dal pannello dal primo giorno e non letti da nessuna
 * parte: due interruttori che non facevano niente. Un comando che non ha
 * effetto e' peggio di un comando assente — chi lo usa crede di aver deciso.
 *
 * `__network__` resta fuori da entrambi: non e' una modalita', e infatti la
 * migration gli mette `in_breakdown = false` proprio perche' e' il totale.
 */
export function dictionaryFlags(dict: ModeDictionary): { hidden: string[]; outOfBreakdown: string[] } {
  const hidden: string[] = [];
  const outOfBreakdown: string[] = [];
  for (const [key, v] of dict) {
    if (key === '__network__') continue;
    if (v.hidden) hidden.push(key);
    if (!v.inBreakdown) outOfBreakdown.push(key);
  }
  return { hidden, outOfBreakdown };
}
