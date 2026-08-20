// Il ritardo dell'event loop, misurato una volta sola per tutto il processo.
//
// E' L'UNICA METRICA CHE LEGA IL WORKER ALLA LATENZA DI LOGIN (§7.9), e serve
// a due chiamanti che non devono misurare per conto proprio: la
// contropressione del giro di warm (§7.5, regola 3) e /internal/metrics.
//
// PERCHE' NON `HashSemaphore.saturated`. Il semaforo conta gli hash in VOLO,
// non l'occupazione dei thread, ed e' strutturalmente cieco a Brotli, `fs` e
// `dns`: durante una compressione che tiene occupato un thread del pool libuv,
// `saturated` resta falso mentre l'event loop e' gia' in ritardo. Un
// indicatore che non vede la causa in esame non e' utilizzabile.

import { type IntervalHistogram, monitorEventLoopDelay } from 'node:perf_hooks';

let histogram: IntervalHistogram | null = null;

/** Accende il monitor. Idempotente: chiamarla due volte non raddoppia nulla. */
export function startEventLoopMonitor(): void {
  if (histogram) return;
  histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
}

/**
 * Il 99esimo percentile in MILLISECONDI.
 *
 * Zero quando il monitor non e' acceso: nei test e nei comandi di manutenzione
 * non c'e' un event loop da sorvegliare, e zero significa «nessuna pressione»,
 * che e' la risposta giusta per chi deve decidere se rimandare una
 * compressione.
 */
export function eventLoopDelayP99(): number {
  return histogram ? histogram.percentile(99) / 1e6 : 0;
}

/**
 * Azzera la finestra.
 *
 * L'istogramma accumula dall'accensione: senza reset il percentile porta per
 * sempre il picco dell'avvio a freddo, e una soglia tarata su quel numero non
 * scatta mai.
 */
export function resetEventLoopMonitor(): void {
  histogram?.reset();
}

/** Solo per i test: spegne e dimentica, cosi' ogni caso parte pulito. */
export function stopEventLoopMonitor(): void {
  histogram?.disable();
  histogram = null;
}
