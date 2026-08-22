// La bozza locale delle schermate Modes e Maps.
//
// COME FUNZIONANO QUESTE DUE SCHERMATE. Tutto quello che si tocca resta QUI:
// spegnere un interruttore, cambiare un numero, aggiungere una modalita' a una
// mappa non manda niente da nessuna parte. Solo «Salva» scrive nel database del
// gioco, e il pulsante Salva compare SOLO quando c'e' qualcosa da salvare.
//
// PERCHE' IL PULSANTE DEVE SPARIRE. Un Salva sempre acceso non e' un dettaglio
// estetico: e' un pulsante che non distingue «ho fatto una modifica» da «non ho
// fatto niente», quindi chi guarda la schermata non sa in quale dei due stati
// si trova. Su una schermata che modifica la configurazione del GIOCO quella
// distinzione e' l'informazione piu' importante che ci sia — e la si perde
// proprio quando si e' distratti, che e' quando serve.
//
// DA CUI: sapere se c'e' una modifica e' una regola, non un dettaglio di
// disegno, e vive qui dove si puo' provare.

export type SettingKind = 'bool' | 'int' | 'double' | 'enum';

/** Lo stesso oggetto che il server manda nel vocabolario. */
export type SettingSpec = {
  key: string;
  kind: SettingKind;
  fallback: string;
  options?: readonly string[];
  /** Assente sui settings di mappa, che sono un elenco unico. */
  group?: string;
};

export type Vocabulary = {
  modeSettings: SettingSpec[];
  /** I sei gruppi nell ordine in cui vanno mostrati. */
  modeSettingGroups: readonly string[];
  mapSettings: SettingSpec[];
  modeTypes: readonly string[];
  rankingTypes: readonly string[];
  matchTypes: readonly string[];
  matchContexts: readonly string[];
  eventTypes: readonly string[];
};

/**
 * Due valori sono lo STESSO valore?
 *
 * I numeri si confrontano come numeri: `1` e `1.0` sono lo stesso valore
 * scritto in due modi. Confrontandoli come stringhe il pulsante Salva
 * comparirebbe per una modifica che non e' una modifica, e premerlo non
 * cambierebbe niente — cioe' esattamente il pulsante che non si sa cosa fa.
 *
 * E' LA STESSA REGOLA DEL SERVER, che decide se scrivere la riga. Le due
 * implementazioni non possono divergere senza che una schermata dica «da
 * salvare» su cose che il server considera gia' salvate: c'e' un test che le
 * confronta, ed e' quello che rende sicura la copia.
 */
export function sameValue(kind: SettingKind, a: string, b: string): boolean {
  if (kind === 'int' || kind === 'double') return Number(a) === Number(b);
  return a === b;
}

/**
 * Il valore IN VIGORE per un setting: la riga se c'e', altrimenti il default.
 *
 * La schermata mostra sempre un valore, perche' un valore c'e' sempre — quello
 * che cambia e' se qualcuno lo ha scelto. La differenza fra «impostato a 10» e
 * «vale 10 perche' e' il default» la porta `isOverride`, non questo.
 */
export function effectiveValues(
  specs: readonly SettingSpec[],
  rows: ReadonlyArray<{ key: string; value: string }>,
): Record<string, string> {
  const present = new Map(rows.map((r) => [r.key, r.value]));
  const out: Record<string, string> = {};
  for (const spec of specs) out[spec.key] = present.get(spec.key) ?? spec.fallback;
  return out;
}

/** Il valore e' stato scelto da qualcuno, o e' solo il default? */
export function isOverride(spec: SettingSpec, value: string): boolean {
  return !sameValue(spec.kind, value, spec.fallback);
}

export function overrideCount(specs: readonly SettingSpec[], values: Record<string, string>): number {
  return specs.filter((s) => isOverride(s, values[s.key] ?? s.fallback)).length;
}

/** Quali settings la bozza cambia rispetto a cio' che e' salvato. */
export function changedSettings(
  specs: readonly SettingSpec[],
  saved: Record<string, string>,
  draft: Record<string, string>,
): string[] {
  return specs
    .filter((spec) => {
      const a = saved[spec.key] ?? spec.fallback;
      const b = draft[spec.key] ?? spec.fallback;
      return !sameValue(spec.kind, a, b);
    })
    .map((s) => s.key);
}

/**
 * Due insiemi hanno gli stessi elementi?
 *
 * L'ORDINE NON CONTA e i doppioni nemmeno: sono righe di una tabella di
 * appartenenza, non una sequenza. Confrontando gli array cosi' come sono, il
 * pulsante Salva comparirebbe per aver tolto e rimesso la stessa modalita'.
 */
export function sameSet<T extends string | number>(a: readonly T[], b: readonly T[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const v of left) if (!right.has(v)) return false;
  return true;
}

/** Accende o spegne un elemento di un insieme, senza toccare l'originale. */
export function toggleIn<T extends string | number>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/**
 * Il valore ha una forma che il server accettera'?
 *
 * NON SOSTITUISCE IL CONTROLLO DEL SERVER e non prova a: quello resta l'unico
 * che conta, perche' quello che arriva dal client non e' fidato nemmeno quando
 * arriva dalla nostra schermata. Serve a non far premere Salva per farsi dire
 * di no — un campo numerico con dentro «3,5» si vede prima di mandarlo.
 */
export function looksValid(spec: SettingSpec, value: string): boolean {
  switch (spec.kind) {
    case 'bool':
      return value === '1' || value === '0';
    case 'int':
      return /^-?\d+$/.test(value);
    case 'double':
      return /^-?\d+(\.\d+)?$/.test(value);
    case 'enum':
      return (spec.options ?? []).includes(value);
  }
}
