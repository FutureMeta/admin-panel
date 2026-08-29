// MiniMessage: quello che il giocatore vedra', dentro l'editor.
//
// LA DOMANDA A CUI RISPONDE QUESTO FILE e' sempre la stessa: dopo un tag, di
// che colore e' il testo? Non il tag — quello e' facile — il testo dopo. E'
// tutta la differenza fra vedere il messaggio e leggerne il codice, e finora
// per saperlo bisognava avviare il server e farlo comparire in chat.
//
// LE TRE COSE CHE SBAGLIATE NON SI VEDONO SUBITO:
//
//   1. la CHIUSURA. `</red>` deve riportare al colore di prima, non spegnere
//      tutto: in un messaggio con sei tag annidati, spegnere tutto vuol dire
//      che meta' riga si vede grigia e nessuno capisce perche';
//   2. la SFUMATURA, che dipende da quanti caratteri copre. Contare anche i
//      tag — che in gioco non si vedono — la fa finire a meta' strada, e il
//      colore che si legge nel pannello non e' quello che uscira';
//   3. la riga DOPO. Un tag lasciato aperto colora fino a fine riga e basta:
//      senza quel confine, una dimenticanza in cima a un file di seicento
//      righe le tinge tutte.

import { describe, expect, it } from 'vitest';
import { gradientAt, paint, renderMiniMessage } from '#web/lib/minimessage.ts';

/** Il colore del testo — non dei tag — pezzo per pezzo. */
function colours(source: string): Array<[string, string | undefined]> {
  return renderMiniMessage(source)
    .filter((p) => !p.tag)
    .map((p) => [p.text, p.style.colour]);
}

/** Lo stile del testo che segue un tag, che e' la domanda di quasi ogni prova. */
function styleOf(source: string, text: string) {
  return renderMiniMessage(source).find((p) => !p.tag && p.text === text)?.style;
}

describe('un tag veste il testo che viene dopo', () => {
  it('il colore continua fino alla fine', () => {
    expect(colours('<red>perso')).toEqual([['perso', '#FF5555']]);
  });

  it('e il tag successivo prende il posto del precedente', () => {
    expect(colours('<red>a<green>b')).toEqual([
      ['a', '#FF5555'],
      ['b', '#55FF55'],
    ]);
  });

  it('l`esadecimale vale come un nome', () => {
    expect(colours('<#FF5C5C>x')).toEqual([['x', '#FF5C5C']]);
    expect(colours('<color:#FF5C5C>x')).toEqual([['x', '#FF5C5C']]);
    expect(colours('<c:red>x')).toEqual([['x', '#FF5555']]);
  });

  it('il testo prima del primo tag non ha colore', () => {
    // Nessun colore vuol dire «quello che avresti visto comunque»: il pezzo
    // resta del colore del suo genere YAML, e non di un grigio inventato.
    expect(colours('ciao <red>rosso')).toEqual([
      ['ciao ', undefined],
      ['rosso', '#FF5555'],
    ]);
  });
});

describe('la chiusura riporta a com`era, non spegne tutto', () => {
  it('dopo `</green>` si torna al rosso di prima', () => {
    // IL DIFETTO CHE QUESTA RIGA IMPEDISCE: chiudere azzerando invece che
    // tornando indietro. In un messaggio con sei tag annidati vuol dire meta`
    // riga grigia, e in gioco quella meta` riga sarebbe rossa.
    expect(colours('<red>a<green>b</green>c')).toEqual([
      ['a', '#FF5555'],
      ['b', '#55FF55'],
      ['c', '#FF5555'],
    ]);
  });

  it('e `</red>` chiude il colore anche se il nome non combacia', () => {
    // MiniMessage chiude il colore piu` recente: `</white>` su un `<red>`
    // aperto lo chiude lo stesso, e il testo torna a com'era.
    expect(colours('<red>a</white>b')).toEqual([
      ['a', '#FF5555'],
      ['b', undefined],
    ]);
  });

  it('una chiusura che non trova niente non fa danni', () => {
    // E` testo scritto male, non un motivo per spegnere il colore di tutto il
    // resto della riga.
    expect(colours('</bold>a<red>b')).toEqual([
      ['a', undefined],
      ['b', '#FF5555'],
    ]);
  });

  it('`<reset>` invece spegne davvero tutto', () => {
    expect(styleOf('<red><bold>a<reset>b', 'b')).toEqual({});
  });
});

describe('grassetto e corsivo, con tutti i nomi che hanno', () => {
  it('`<b>` e `<bold>` sono lo stesso tag', () => {
    expect(styleOf('<b>x', 'x')).toEqual({ bold: true });
    expect(styleOf('<bold>x', 'x')).toEqual({ bold: true });
  });

  it('`<i>`, `<italic>` e `<em>` pure', () => {
    for (const tag of ['<i>', '<italic>', '<em>']) {
      expect(styleOf(`${tag}x`, 'x')).toEqual({ italic: true });
    }
  });

  it('si sommano fra loro e al colore', () => {
    expect(styleOf('<red><bold><italic>x', 'x')).toEqual({
      colour: '#FF5555',
      bold: true,
      italic: true,
    });
  });

  it('e si chiudono uno alla volta', () => {
    expect(styleOf('<bold><italic>a</italic>b', 'b')).toEqual({ bold: true });
  });

  it('sottolineato, barrato e offuscato ci sono tutti', () => {
    expect(styleOf('<u>x', 'x')).toEqual({ underlined: true });
    expect(styleOf('<st>x', 'x')).toEqual({ strikethrough: true });
    expect(styleOf('<obf>x', 'x')).toEqual({ obfuscated: true });
  });
});

describe('le sfumature dipendono da quanti caratteri coprono', () => {
  it('il primo carattere e` il primo estremo, l`ultimo il secondo', () => {
    const pezzi = colours('<gradient:#000000:#FFFFFF>abc</gradient>');
    expect(pezzi[0]).toEqual(['a', '#000000']);
    expect(pezzi.at(-1)).toEqual(['c', '#FFFFFF']);
    expect(pezzi).toHaveLength(3);
  });

  it('i tag in mezzo NON contano fra i caratteri', () => {
    // IL DIFETTO CHE QUESTA RIGA IMPEDISCE. Contando anche `<bold>` — undici
    // caratteri che in gioco non si vedono — la sfumatura arriverebbe a meta`
    // strada sull'ultima lettera, e il pannello mostrerebbe colori che dal
    // gioco non escono.
    const pezzi = colours('<gradient:#000000:#FFFFFF>a<bold>bc</gradient>');
    expect(pezzi.at(-1)?.[1]).toBe('#FFFFFF');
  });

  it('si ferma dove la chiudono', () => {
    const pezzi = colours('<gradient:#000000:#FFFFFF>ab</gradient>cd');
    expect(pezzi.at(-1)).toEqual(['cd', undefined]);
  });

  it('e senza chiusura arriva in fondo alla riga', () => {
    const pezzi = colours('<gradient:#000000:#FFFFFF>abcd');
    expect(pezzi.at(-1)?.[1]).toBe('#FFFFFF');
  });

  it('un colore dentro la sfumatura vince, ma non la fa ripartire', () => {
    // I caratteri che si porta via contano lo stesso: altrimenti dopo di lui
    // la sfumatura ricomincerebbe dal primo estremo, e si vedrebbe un salto.
    const pezzi = colours('<gradient:#000000:#FFFFFF>ab<red>cd</red>ef');
    expect(pezzi.find((p) => p[0] === 'cd')?.[1]).toBe('#FF5555');
    expect(pezzi.at(-1)?.[1]).toBe('#FFFFFF');
  });

  it('tre estremi si dividono il percorso', () => {
    expect(gradientAt(['#000000', '#FF0000', '#FFFFFF'], 0)).toBe('#000000');
    expect(gradientAt(['#000000', '#FF0000', '#FFFFFF'], 0.5)).toBe('#FF0000');
    expect(gradientAt(['#000000', '#FF0000', '#FFFFFF'], 1)).toBe('#FFFFFF');
  });

  it('anche con i nomi al posto degli esadecimali', () => {
    expect(colours('<gradient:red:blue>a')[0]?.[1]).toBe('#FF5555');
  });
});

describe('i vecchi codici valgono ancora, con le loro regole', () => {
  it('`&a` colora quello che viene dopo', () => {
    expect(colours('&averde')).toEqual([['verde', '#55FF55']]);
  });

  it('e sono gli stessi colori dei nomi', () => {
    // La tavolozza e` una sola: i codici legacy si ricavano dai nomi invece di
    // essere riscritti, o le due potrebbero divergere restando plausibili.
    expect(colours('&ax')).toEqual(colours('<green>x'));
    expect(colours('§cx')).toEqual(colours('<red>x'));
  });

  it('un colore legacy azzera lo stile, come nel gioco', () => {
    // NON E` UNA NOSTRA REGOLA: nei codici legacy un colore spegne grassetto e
    // corsivo. Chi scrive `&l&aciao` si aspetta verde grassetto, chi scrive
    // `&a&lciao` pure — ma `&lgrassetto&averde` da` verde e basta.
    expect(styleOf('&l&averde', 'verde')).toEqual({ colour: '#55FF55' });
    expect(styleOf('&a&lverde', 'verde')).toEqual({ colour: '#55FF55', bold: true });
  });

  it('`&r` spegne tutto', () => {
    expect(styleOf('&a&lx&ry', 'y')).toEqual({});
  });
});

describe('i tag che non vestono niente', () => {
  it('click, hover, sprite e segnaposto lasciano il testo com`era', () => {
    for (const tag of ["<click:run_command:'/event join'>", '<sprite:gui:icon/link>', '<player>']) {
      expect(colours(`<red>a${tag}b`).at(-1)?.[1]).toBe('#FF5555');
    }
  });

  it('e il tag DENTRO un hover non colora la riga', () => {
    // IL PEZZO CHE CONTA. `<hover:show_text:'<#C4CED6>Ciao'>` porta un tag
    // dentro il proprio argomento: senza saltare le parti fra virgolette, la
    // ricerca si fermerebbe al `<` interno e da li` in poi la riga prenderebbe
    // il colore del suggerimento — che in gioco si vede solo col mouse sopra.
    const pezzi = colours("<red>a<hover:show_text:'<#C4CED6>Ciao'>b");
    expect(pezzi.at(-1)).toEqual(['b', '#FF5555']);
  });

  it('un tag sconosciuto non fa niente, invece di rompere', () => {
    expect(colours('<red>a<domani>b').at(-1)?.[1]).toBe('#FF5555');
  });

  it('e il tag stesso non ha un colore suo', () => {
    // IL COLORE CE L'HA IL TESTO, non il tag. Dipingere anche il tag del suo
    // colore metteva due colori nella stessa riga a contendersi l'occhio
    // proprio dove serve leggere il messaggio: chi disegna da` a tutti i tag
    // lo stesso grigio, e per farlo gli basta sapere che sono tag.
    expect(renderMiniMessage('<red>x')[0]).toEqual({ text: '<red>', tag: true, style: {} });
    expect(renderMiniMessage('<gradient:#FFF3C4:#FFD27A>x')[0]?.style).toEqual({});
    expect(renderMiniMessage('&ax')[0]).toEqual({ text: '&a', tag: true, style: {} });
  });

  it('e si riconosce dal fatto che e` un tag, non dal testo', () => {
    // E` cio` che permette di spegnerli tutti insieme per leggere il messaggio
    // come uscira` in gioco: chi disegna non deve indovinare che `<red>` e` un
    // tag guardando le parentesi.
    const pezzi = renderMiniMessage('<bold>ciao</bold>');
    expect(pezzi.map((p) => p.tag)).toEqual([true, false, true]);
    expect(pezzi.filter((p) => !p.tag).map((p) => p.text)).toEqual(['ciao']);
  });
});

describe('rimettendo insieme i pezzi si riottiene il testo', () => {
  it('carattere per carattere, tag compresi', () => {
    // E` L'INVARIANTE DI TUTTO L'EDITOR: questi pezzi finiscono in uno strato
    // disegnato dietro a una textarea trasparente, e un solo carattere perso
    // sposta di una colonna tutto il resto della riga.
    const CASI = [
      '',
      'niente tag',
      '<red>a</red>',
      '<gradient:#000000:#FFFFFF>abc</gradient>',
      "<hover:show_text:'<#C4CED6>Ciao'>x",
      '<#FFD27A>💎 <bold>MODE</bold> <dark_gray>» <white>%mode%',
      '&a&lvecchio &rstile',
      '< non e` un tag',
      '<>',
    ];
    for (const caso of CASI) {
      expect(
        renderMiniMessage(caso)
          .map((p) => p.text)
          .join(''),
      ).toBe(caso);
    }
  });

  it('anche con le emoji, che sono due caratteri e vanno tenute insieme', () => {
    // Dentro una sfumatura si va un carattere alla volta: spezzare una emoji
    // a meta` darebbe due simboli rotti al posto suo.
    const source = '<gradient:#000000:#FFFFFF>💎👑</gradient>';
    expect(
      renderMiniMessage(source)
        .map((p) => p.text)
        .join(''),
    ).toBe(source);
    expect(colours(source).map((p) => p[0])).toEqual(['💎', '👑']);
  });
});

describe('i colori troppo scuri si portano dietro una velatura', () => {
  it('altrimenti `<black>` sarebbe un pezzo di riga che sparisce', () => {
    expect(paint('#000000').background).toBeDefined();
    expect(paint('#0000AA').background).toBeDefined();
    expect(paint('#FFFFFF').background).toBeUndefined();
    // E il colore resta quello vero: cambia il dietro, non il davanti.
    expect(paint('#000000').color).toBe('#000000');
  });
});
