// Ripara i contenuti importati con la codepage sbagliata.
//
// COSA E' SUCCESSO. `import-duels-configs.ts` stampa SQL sullo standard
// output; il comando che l'ha salvato passava da una redirezione della console
// di Windows, e quella console non legge UTF-8: legge CP850. Ogni byte dei
// caratteri non ASCII e' diventato il carattere che CP850 gli assegna, ed e'
// stato riscritto in UTF-8 — cioe' `●` (E2 97 8F) e' finito nel database come
// `ÔùÅ`, tre caratteri al posto di uno.
//
//   ●   E2 97 8F   ->  ÔùÅ
//   🗡   F0 9F 97 A1  ->  ­ƒùí
//   ⌚   E2 8C 9A   ->  ÔîÜ
//   ᴍ   E1 B4 8D   ->  ß┤ì
//
// E' UNA TRASFORMAZIONE INVERTIBILE, ed e' l'unica ragione per cui questo
// script puo' esistere: CP850 assegna un carattere a TUTTI i 256 byte, quindi
// nessuna informazione e' andata persa. Si rifa' la strada al contrario —
// carattere -> byte di CP850 -> testo UTF-8 — e si riottiene l'originale.
//
// PERCHE' NON SI RIFA' L'IMPORT. Perche' cancellerebbe quello che nel
// frattempo e' stato modificato dal pannello. Questo invece tocca solo le
// righe che sono davvero rovinate, e le riconosce da sole (vedi `repair`).
//
// Uso:
//   node scripts/fix-config-encoding.ts
//       DICE cosa farebbe, e non tocca niente. Sempre per primo.
//
//   DATABASE_URL=postgres://... node scripts/fix-config-encoding.ts --apply
//       lo esegue, una riga alla volta, in una transazione sola.

import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * CP850, la meta' alta: quale carattere la console ha messo al posto di ogni
 * byte da 0x80 a 0xFF.
 *
 * SCRITTA E NON CALCOLATA perche' Node non conosce CP850 — `TextDecoder`
 * arriva alle codifiche del web, e le codepage DOS non ci sono. E' la tabella
 * di IBM 850, quella che una console italiana usa di default; due caselle
 * bastano a distinguerla dalla sua cugina CP437, che qui darebbe un risultato
 * diverso: 0xF0 e' un trattino morbido e non `≡`, 0xFF e' uno spazio unificatore
 * e non uno spazio normale.
 */
const CP850 =
  'ÇüéâäàåçêëèïîìÄÅ' + // 80-8F
  'ÉæÆôöòûùÿÖÜø£Ø×ƒ' + // 90-9F
  'áíóúñÑªº¿®¬½¼¡«»' + // A0-AF
  '░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐' + // B0-BF
  '└┴┬├─┼ãÃ╚╔╩╦╠═╬¤' + // C0-CF
  'ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀' + // D0-DF
  'ÓßÔÒõÕµþÞÚÛÙýÝ¯´' + // E0-EF
  '­±‗¾¶§÷¸°¨·¹³²■ '; // F0-FF

/** Da carattere di CP850 al byte che rappresentava. */
const BYTE_OF = new Map<string, number>();
for (const [i, ch] of [...CP850].entries()) BYTE_OF.set(ch, 0x80 + i);

/**
 * Il testo com'era prima che la console lo rovinasse, o `null` se non c'e'
 * niente da riparare.
 *
 * TRE CONDIZIONI, E SERVONO TUTTE E TRE. Insieme dicono «questo testo e'
 * passato per CP850», e sono il motivo per cui lo script si puo' lanciare due
 * volte senza fare danni:
 *
 *   1. c'e' almeno un carattere non ASCII — se e' tutto ASCII non e' successo
 *      niente e non c'e' niente da fare;
 *   2. OGNI carattere non ASCII sta nella tabella CP850. Un testo scritto a
 *      mano nel pannello contiene `à` (U+00E0) che in CP850 non c'e': lo
 *      script lo lascia stare invece di rovinarlo;
 *   3. i byte che ne escono sono UTF-8 valido. E' la prova del nove: dei byte
 *      qualunque non formano una sequenza UTF-8 per caso, e un testo gia'
 *      riparato non la forma piu'.
 */
export function repair(text: string): string | null {
  const bytes: number[] = [];
  let high = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    if (code < 0x80) {
      bytes.push(code);
      continue;
    }
    const byte = BYTE_OF.get(ch);
    if (byte === undefined) return null;
    high += 1;
    bytes.push(byte);
  }
  if (high === 0) return null;

  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes));
  // `�` e' il carattere che il decodificatore mette dove non capisce: se
  // ce n'e' uno, quei byte UTF-8 non erano, e questo testo non e' rotto nel
  // modo che questo script sa riparare.
  if (decoded.includes('�')) return null;
  return decoded === text ? null : decoded;
}

type Row = { id: number; path: string; published: string | null; draft: string | null };

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const url = process.env.DATABASE_URL;
  if (url === undefined) {
    // Nel container la variabile sta nel `.env` che legge il processo del
    // pannello, non nell'ambiente della shell: chi arriva qui ha quasi sempre
    // il file sotto il naso e gli manca la riga per dirlo a Node.
    console.error('Serve DATABASE_URL, e nel container sta nel .env:');
    console.error('  node --env-file=.env scripts/fix-config-encoding.ts');
    console.error('\nSenza --apply dice soltanto cosa farebbe.');
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();

  const found = await client.query<Row>(`
    SELECT v.id, p.path, v.published, v.draft
      FROM stats.duels_config_version v
      JOIN stats.duels_config_path p ON p.id = v.path_id
     ORDER BY p.path, v.id
  `);

  const fixes = found.rows
    .map((row) => ({
      id: row.id,
      path: row.path,
      published: row.published === null ? null : repair(row.published),
      draft: row.draft === null ? null : repair(row.draft),
    }))
    .filter((f) => f.published !== null || f.draft !== null);

  console.log(`${found.rows.length} versioni lette, ${fixes.length} da riparare.\n`);

  // Un assaggio di cio' che cambia, per guardarlo prima di applicarlo: su
  // centosessanta versioni, un conteggio da solo non dice se e' giusto.
  for (const fix of fixes.slice(0, 3)) {
    const before = (found.rows.find((r) => r.id === fix.id)?.published ?? '').split('\n');
    const after = (fix.published ?? '').split('\n');
    const at = before.findIndex((line, i) => line !== after[i]);
    if (at === -1) continue;
    console.log(`  ${fix.path}:${at + 1}`);
    console.log(`    prima: ${before[at]}`);
    console.log(`    dopo : ${after[at]}\n`);
  }

  if (!apply) {
    console.log('Niente e` stato scritto. Rilancia con --apply per farlo davvero.');
    await client.end();
    return;
  }

  // TUTTO IN UNA TRANSAZIONE: a meta' strada il database avrebbe una parte dei
  // file riparati e una parte no, e nessuno saprebbe quale.
  await client.query('BEGIN');
  try {
    for (const fix of fixes) {
      await client.query(
        `UPDATE stats.duels_config_version
            SET published = coalesce($2, published), draft = coalesce($3, draft)
          WHERE id = $1`,
        [fix.id, fix.published, fix.draft],
      );
    }
    await client.query('COMMIT');
    console.log(`Riparate ${fixes.length} versioni.`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
