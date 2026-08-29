// La riparazione dei config importati con la codepage sbagliata.
//
// COSA E' SUCCESSO. Lo script di import stampa SQL sullo standard output, e il
// comando che l'ha salvato passava dalla console di Windows — che non legge
// UTF-8, legge CP850. Ogni byte dei caratteri non ASCII e' diventato il
// carattere che CP850 gli assegna: `●` e' finito nel database come `ÔùÅ`.
//
// PERCHE' UN TEST, PER UNO SCRIPT CHE SI LANCIA UNA VOLTA. Perche' scrive sui
// contenuti veri dei config, e sbagliando li rovinerebbe una seconda volta —
// stavolta senza un originale da cui ripartire, perche' il primo giro l'ha
// gia' consumato. Le righe qui sotto sono quelle vere, copiate dal database
// com'erano dopo l'import.
//
// LA COSA CHE DEVE VALERE PIU' DI TUTTE e' che lanciarlo due volte non faccia
// danni: la seconda volta non c'e' piu' niente da riparare, e deve dirlo
// invece di rovinare quello che ha appena aggiustato.

import { describe, expect, it } from 'vitest';
import { repair } from '#scripts/fix-config-encoding.ts';

describe('il testo torna com`era', () => {
  it('le righe vere del menu della lobby', () => {
    // Copiate dal database dopo l'import, con accanto cio' che c'era scritto
    // nel file del plugin.
    const CASI: Array<[string, string]> = [
      ['<green>ÔùÅ %player_name% <#A8A8A8>(EU)', '<green>● %player_name% <#A8A8A8>(EU)'],
      ['<#A8A8A8>Use <#FF2121>­ƒùí <#A8A8A8>to queue', '<#A8A8A8>Use <#FF2121>🗡 <#A8A8A8>to queue'],
      ['<#686B74>ÔîÜ %server_time%', '<#686B74>⌚ %server_time%'],
      ['<#686B74>ÔåÆ eu-lobby1', '<#686B74>→ eu-lobby1'],
      ['<#FF2121>ß┤ìß┤ä.ß┤ìß┤çß┤øß┤Çß┤ìß┤ä.╔┤ß┤çß┤ø', '<#FF2121>ᴍᴄ.ᴍᴇᴛᴀᴍᴄ.ɴᴇᴛ'],
    ];
    for (const [rotto, giusto] of CASI) expect(repair(rotto)).toBe(giusto);
  });

  it('anche su piu` righe in un colpo solo', () => {
    const rotto = '  - "<green>ÔùÅ uno"\n  - ""\n  - "<#686B74>ÔåÆ due"';
    expect(repair(rotto)).toBe('  - "<green>● uno"\n  - ""\n  - "<#686B74>→ due"');
  });
});

describe('quello che non e` rotto lo lascia stare', () => {
  it('un testo tutto ASCII non si tocca', () => {
    // `null` vuol dire «niente da fare», e distingue «riparato» da «uguale a
    // prima»: senza, lo script riscriverebbe centosessanta versioni per
    // cambiare zero caratteri.
    expect(repair('lobby:\n  spawn: true')).toBeNull();
    expect(repair('')).toBeNull();
  });

  it('e nemmeno un accento scritto a mano dal pannello', () => {
    // `à` (U+00E0) in CP850 non c'e'. Se un domani qualcuno scrive «perché» in
    // un commento e lo script gli passa sopra, quel testo NON deve diventare
    // altro: la tabella non lo conosce, e la risposta giusta e' non toccarlo.
    expect(repair('# gia` così, con gli accenti')).toBeNull();
    expect(repair('msg: "città"')).toBeNull();
  });

  it('lanciarlo DUE VOLTE non fa danni', () => {
    // E` la garanzia che conta piu` di tutte. Dopo la prima riparazione i
    // caratteri sono emoji e frecce vere, che in CP850 non esistono: la
    // seconda passata li salta.
    const rotto = '<green>ÔùÅ %player_name% <#A8A8A8>(EU)';
    const giusto = repair(rotto) as string;
    expect(repair(giusto)).toBeNull();
  });

  it('e dei byte a caso non diventano testo per sbaglio', () => {
    // La prova del nove: dei byte qualunque non formano una sequenza UTF-8 per
    // caso. Quando non la formano, questo testo non e` rotto nel modo che lo
    // script sa riparare, e si lascia dov'e`.
    expect(repair('Ç')).toBeNull();
    expect(repair('½¼¡')).toBeNull();
  });
});
