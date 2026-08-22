// I formattatori dei numeri, in un posto solo.
//
// PERCHE'. Nella stessa ciambella la legenda scriveva `38.5%` e il tooltip
// `38,5%`: stesso numero, stesso riquadro, due punteggiature. Erano due
// espressioni in linea scritte a sessantacinque righe di distanza, e nessuna
// delle due sapeva dell'altra. Di formattatori di percentuale ne erano nati
// quattro in tre file.
//
// La lingua e' UNA, ed e' l'italiano: `it-IT` mette il punto alle migliaia e
// la virgola ai decimali. Il legacy aveva `'12.4K'` e `'Jul 28, 2026'`
// cablati, che e' un'interfaccia inglese dentro un pannello italiano.

/** Interi con il separatore delle migliaia. `tabular-nums` lo fa il CSS. */
export const numberFmt = new Intl.NumberFormat('it-IT');

/** Una quota con UNA cifra decimale: `66,7%`. */
export function shareLabel(share: number): string {
  return `${share.toFixed(1).replace('.', ',')}%`;
}

/**
 * Una quota INTERA, per i KPI: `38%`.
 *
 * Il denominatore a zero non e' zero per cento — non e' niente — ma un KPI
 * deve scrivere qualcosa: si dichiara `0%` e accanto c'e' sempre il «N di M»
 * che dice che M vale zero.
 */
export function pctLabel(part: number, whole: number): string {
  if (whole <= 0) return '0%';
  return `${Math.round((part / whole) * 100)}%`;
}
