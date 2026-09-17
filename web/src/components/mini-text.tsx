// Il sorgente di un testo MiniMessage, com'e' scritto e com'e' vestito.
//
// LA CONVENZIONE E' QUELLA DELL'EDITOR DEI CONFIG, e va tenuta identica
// ovunque: i tag sono tutti dello stesso grigio (`--yml-tag`) e il colore ce
// l'ha il testo che vestono. `<red>Errore</red>` mostra il tag in grigio e la
// parola in rosso. Cosi' struttura e risultato convivono nella stessa riga
// senza contendersi l'occhio, e chi legge non deve chiedersi «questo e' quello
// che scrivo o quello che vede il giocatore?».
//
// DUE COSE IN PIU' rispetto all'editor, perche' qui i testi sono messaggi:
//
//   - i SEGNAPOSTO `%player%` hanno uno stile loro, diverso da tag e testo.
//     Non sono MiniMessage: li sostituisce il plugin, e vanno riconosciuti
//     come tali da chi traduce, perche' devono restare uguali;
//   - un tag ROTTO si segnala inline, con lo stile d'errore del pannello, dove
//     sta. Un elenco di errori sotto il campo dice «c'e' un problema»; il
//     rosso sulla riga dice dove.

import { useMemo } from 'react';
import { lineSpans } from '../lib/mini-spans.ts';

/**
 * Un testo, riga per riga. Le righe vanno a capo da sole (`pre-wrap`): qui
 * non c'e' una textarea da tenere incolonnata, e una riga di scoreboard lunga
 * si legge meglio spezzata che tagliata.
 */
export function MiniSource({
  text,
  size = 12.5,
  tags = true,
}: {
  text: string;
  size?: number;
  tags?: boolean;
}) {
  const lines = useMemo(
    () => text.split('\n').map((line) => lineSpans(line, size, tags)),
    [text, size, tags],
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
      {lines.map((spans, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: la riga E' la sua posizione
        <div key={i} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline' }}>
          {spans.length === 0 ? <span style={{ fontSize: size, lineHeight: '21px' }}>&nbsp;</span> : null}
          {spans.map((s, j) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: idem, il pezzo e' la sua posizione nella riga
              key={j}
              title={s.title}
              style={{
                fontFamily: 'var(--font-mono)',
                lineHeight: '21px',
                borderRadius: 2,
                whiteSpace: 'pre-wrap',
                ...(s.style as React.CSSProperties),
              }}
            >
              {s.text}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
