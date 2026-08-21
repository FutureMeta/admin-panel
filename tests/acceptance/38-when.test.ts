// L'etichetta temporale del picco, e il cambio d'ora.
//
// IL DIFETTO DI PARTENZA: «Picco del periodo — alle 20:00». Sul range 24h,
// che e' una finestra scorrevole e non «da mezzanotte», quel picco letto a
// mezzogiorno e' di ieri sera, e l'etichetta e' identica a quella di un picco
// di stamattina. Si legge un numero di ieri credendolo di oggi, e non c'e'
// niente nella schermata che permetta di accorgersene.
//
// IL SECONDO DIFETTO, quello che si scriverebbe correggendo il primo di
// fretta: contare i giorni dividendo la differenza di millisecondi per
// 86.400.000. Sbaglia due volte l'anno, nei due giorni in cui i giorni non
// durano 24 ore — e sbaglia proprio nella direzione peggiore, chiamando
// «oggi» qualcosa di ieri.

import { describe, expect, it } from 'vitest';
import { axisLabel, dayAndTime } from '#web/lib/when.ts';

/** Secondi epoch da un istante UTC scritto per esteso. */
const sec = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000);

describe("il picco dice il giorno, non solo l'ora", () => {
  it('oggi, ieri e domani hanno un nome', () => {
    const now = new Date('2026-08-21T10:00:00Z'); // 12:00 a Roma
    expect(dayAndTime(sec('2026-08-21T06:30:00Z'), now)).toBe('oggi alle 08:30');
    // IL CASO DELLA SEGNALAZIONE: sono le 12:00 e il picco e` delle 20:00.
    // Senza «ieri» sembra un'ora che deve ancora arrivare.
    expect(dayAndTime(sec('2026-08-20T18:00:00Z'), now)).toBe('ieri alle 20:00');
    expect(dayAndTime(sec('2026-08-22T18:00:00Z'), now)).toBe('domani alle 20:00');
  });

  it('piu` indietro di ieri compare la data', () => {
    const now = new Date('2026-08-21T10:00:00Z');
    expect(dayAndTime(sec('2026-08-14T18:00:00Z'), now)).toBe('14 ago alle 20:00');
  });

  it("l'anno compare solo quando e` un altro", () => {
    const now = new Date('2026-08-21T10:00:00Z');
    // Su un range di un anno «19 ago» puo` essere di due agosti diversi: senza
    // l'anno la data sembra precisa pur non essendolo.
    expect(dayAndTime(sec('2025-08-19T18:00:00Z'), now)).toBe('19 ago 2025 alle 20:00');
  });

  it('il giorno di 25 ore non sposta niente di un giorno', () => {
    // 25 ottobre 2026, l'ora torna indietro alle 03:00 locali: quel giorno
    // civile romano dura 25 ore. Due istanti a 24 ore esatte di distanza
    // cadono nello STESSO giorno civile, e una divisione per 86.400.000
    // direbbe «ieri».
    const now = new Date('2026-10-25T21:00:00Z'); // 22:00 a Roma, ora solare
    expect(dayAndTime(sec('2026-10-24T21:00:00Z'), now)).toBe('ieri alle 23:00');
    // Le 00:30 locali del 25 sono a piu` di 24 ore da adesso e restano OGGI.
    expect(dayAndTime(sec('2026-10-24T22:30:00Z'), now)).toBe('oggi alle 00:30');
  });

  it('il giorno di 23 ore non fonde due giorni in uno', () => {
    // 29 marzo 2026, l'ora salta avanti alle 02:00: quel giorno dura 23 ore.
    // Due istanti a 23 ore di distanza sono in giorni civili DIVERSI, e la
    // divisione direbbe «oggi».
    const now = new Date('2026-03-29T20:00:00Z'); // 22:00 a Roma, ora legale
    expect(dayAndTime(sec('2026-03-28T21:00:00Z'), now)).toBe('ieri alle 22:00');
  });
});

describe("le tacche dell'asse dicono cosa cambia fra una e l'altra", () => {
  const T = Math.floor(new Date('2026-08-20T18:00:00Z').getTime() / 1000); // gio 20:00

  it('sul 24h basta l`ora: tre ore di passo', () => {
    expect(axisLabel(T, 300 * 36)).toBe('20:00');
  });

  it('sul 7g serve anche il giorno: ventuno ore di passo', () => {
    // Con sole ore, otto tacche a ventun ore di distanza coprono cinque
    // giorni diversi senza dirlo: sembrano un unico giorno letto male.
    expect(axisLabel(T, 3_600 * 21)).toBe('gio 20:00');
  });

  it('oltre due giorni di passo l`ora ha smesso di distinguere', () => {
    // IL DIFETTO DI PARTENZA: sul range 1y le tacche erano otto «00:00»
    // identiche, cioe` un asse che non ordina niente e sembra un errore di
    // caricamento.
    expect(axisLabel(T, 86_400 * 46)).toBe('20 ago');
    expect(axisLabel(T, 21_600 * 45)).toBe('20 ago'); // 90g
    expect(axisLabel(T, 7_200 * 45)).toBe('20 ago'); // 30g
  });
});
