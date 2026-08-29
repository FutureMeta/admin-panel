// I file di configurazione: percorsi, versioni, legami, pubblicazione, bundle.
//
// PERCHE' CONTRO UN POSTGRES VERO e non contro un doppio. Meta' delle regole di
// questo modello non stanno nel codice: stanno nei vincoli della migration —
// la chiave primaria che impedisce a un modulo di ricevere due versioni dello
// stesso file, la chiave esterna composita che impedisce di legare a un
// percorso la versione di un altro, i CHECK che tengono insieme i tre campi di
// una pubblicazione. Un doppio in memoria li accetterebbe tutti e direbbe che
// va bene.
//
// LE DUE COSE CHE FANNO PIU' DANNO SE SBAGLIATE, e hanno un test ciascuna:
//
//   1. la bozza che finisce nel bundle. Sarebbe una modifica mai confermata
//      arrivata in produzione — l'esatto contrario del motivo per cui bozza e
//      pubblicato sono due colonne;
//   2. l'impronta del bundle che non cambia quando cambia un file. I server
//      resterebbero indietro all'infinito senza che niente lo dica, perche' un
//      ETag uguale significa «non e' cambiato nulla».

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKysely, createPool, type Database } from '#src/db/pool.ts';
import {
  CONFIG_FORBIDDEN,
  createConfigPath,
  ForbiddenPath,
  isConfigPath,
  listConfigFiles,
  PathExists,
  publishConfigDrafts,
  readConfigBundle,
  readConfigFile,
  saveConfigDraft,
  setConfigLinks,
} from '#src/duels/config-store.ts';
import { createTestDatabase, type TestDatabase } from '#tests/support/postgres.ts';

let testDb: TestDatabase;
let db: Database;
let close: () => Promise<void>;

beforeAll(async () => {
  testDb = await createTestDatabase('duelscfg');
  const pool = createPool({
    connectionString: testDb.appUrl,
    max: 4,
    applicationName: 'metamc-test-duels-config',
    statementTimeout: '10s',
  });
  db = createKysely(pool);
  close = () => db.destroy();
}, 180_000);

afterAll(async () => {
  await close?.().catch(() => undefined);
  await testDb?.drop();
});

/** Il percorso in prova, con i moduli che lo useranno. */
async function seedShared(path: string, modules: string[]): Promise<number> {
  await createConfigPath(db, { path, modules, author: 'vally90@metamc.it' });
  const file = await readConfigFile(db, path);
  return file.versions[0]?.id as number;
}

describe('un percorso e` relativo, finisce in .yml, e non risale', () => {
  it('accetta i percorsi veri del plugin', () => {
    expect(isConfigPath('config.yml')).toBe(true);
    expect(isConfigPath('inventories/event/tnt_run.yml')).toBe(true);
    expect(isConfigPath('inventories/ffa/ffa_sword.yml')).toBe(true);
  });

  it('e rifiuta quelli che uscirebbero dalla cartella del plugin', () => {
    // IL CONTROLLO CHE CONTA. Il plugin scrive questi file partendo dalla
    // propria cartella dati: `..` uscirebbe da li' e finirebbe dove decide chi
    // ha scritto il percorso.
    expect(isConfigPath('../plugins/altro/config.yml')).toBe(false);
    expect(isConfigPath('inventories/../../config.yml')).toBe(false);
    expect(isConfigPath('/etc/passwd')).toBe(false);
    expect(isConfigPath('inventories\\event\\uhc.yml')).toBe(false);
    expect(isConfigPath('config.yaml')).toBe(false);
    expect(isConfigPath('')).toBe(false);
  });
});

describe('credentials.yml non entra, e non e` una scelta dell`interfaccia', () => {
  it('l`API si rifiuta di crearlo', async () => {
    // Porta utente e password SQL e l'URI Redis. Gestirlo dal pannello vorrebbe
    // dire tenere le password del gioco nel nostro database e spedirle in HTTP
    // a ogni avvio di ogni server. Non basta non mostrarlo: deve dire di no.
    await expect(
      createConfigPath(db, { path: 'credentials.yml', modules: ['lobby'], author: 'x@metamc.it' }),
    ).rejects.toBeInstanceOf(ForbiddenPath);
    expect(CONFIG_FORBIDDEN).toContain('credentials.yml');
    // `plugin.yml` e' il manifest che Bukkit legge per caricare il plugin:
    // sovrascriverlo rompe l'avvio.
    expect(CONFIG_FORBIDDEN).toContain('plugin.yml');
  });
});

describe('un percorso condiviso: una versione, piu` moduli', () => {
  it('nasce vuoto e legato ai moduli scelti', async () => {
    await seedShared('inventories/event/tnt_run.yml', ['lobby', 'ffa']);
    const file = await readConfigFile(db, 'inventories/event/tnt_run.yml');

    expect(file.split).toBe(false);
    expect(file.versions).toHaveLength(1);
    expect(file.versions[0]?.modules).toEqual(['ffa', 'lobby']);
    // Vuoto e non nullo: il plugin legge con i propri default, quindi un file
    // senza chiavi non sovrascrive niente. E' cio' che permette di aggiungere
    // un config nuovo senza incollare mille righe.
    expect(file.versions[0]?.draft).toBe('');
    expect(file.versions[0]?.published).toBeNull();
  });

  it('lo stesso percorso non si crea due volte', async () => {
    await expect(
      createConfigPath(db, {
        path: 'inventories/event/tnt_run.yml',
        modules: ['game'],
        author: 'x@metamc.it',
      }),
    ).rejects.toBeInstanceOf(PathExists);
  });
});

describe('la bozza non arriva ai server finche` non si pubblica', () => {
  it('il bundle di un percorso mai pubblicato e` vuoto', async () => {
    const id = await seedShared('scoreboards.yml', ['lobby', 'game']);
    await saveConfigDraft(db, { versionId: id, content: 'title: prova', author: 'vally90@metamc.it' });

    const bundle = await readConfigBundle(db, 'lobby');
    expect(bundle.files.map((f) => f.path)).not.toContain('scoreboards.yml');
  });

  it('e ci arriva dopo, con il contenuto della bozza', async () => {
    const summary = await publishConfigDrafts(db, 'vally90@metamc.it');
    expect(summary.files).toBeGreaterThan(0);

    const bundle = await readConfigBundle(db, 'lobby');
    const file = bundle.files.find((f) => f.path === 'scoreboards.yml');
    expect(file?.content).toBe('title: prova');

    // E la bozza non c'e' piu': pubblicare la consuma, o il tasto Pubblica
    // resterebbe acceso per sempre.
    const after = await readConfigFile(db, 'scoreboards.yml');
    expect(after.versions[0]?.draft).toBeNull();
    expect(after.versions[0]?.publishedBy).toBe('vally90@metamc.it');
  });

  it('un percorso condiviso arriva a TUTTI i moduli legati', async () => {
    const game = await readConfigBundle(db, 'game');
    expect(game.files.find((f) => f.path === 'scoreboards.yml')?.content).toBe('title: prova');
  });

  it('e non arriva a un modulo che non e` legato', async () => {
    const setup = await readConfigBundle(db, 'setup');
    expect(setup.files.map((f) => f.path)).not.toContain('scoreboards.yml');
  });
});

describe('l`impronta del bundle segue i contenuti, non un contatore', () => {
  it('cambia quando cambia un file, e resta ferma quando non cambia niente', async () => {
    const prima = await readConfigBundle(db, 'lobby');
    const uguale = await readConfigBundle(db, 'lobby');
    // Due letture di fila: se l'impronta ballasse da sola, ogni avvio di ogni
    // server riscaricherebbe tutto.
    expect(uguale.version).toBe(prima.version);

    const file = await readConfigFile(db, 'scoreboards.yml');
    await saveConfigDraft(db, {
      versionId: file.versions[0]?.id as number,
      content: 'title: cambiata',
      author: 'matty@metamc.it',
    });
    // Ancora ferma: la bozza non e' nel bundle.
    expect((await readConfigBundle(db, 'lobby')).version).toBe(prima.version);

    await publishConfigDrafts(db, 'matty@metamc.it');
    const dopo = await readConfigBundle(db, 'lobby');
    // IL TEST CHE CONTA: se questa non cambiasse, i server resterebbero
    // indietro all'infinito e nessun errore lo direbbe — un ETag uguale
    // significa «non e' cambiato nulla».
    expect(dopo.version).not.toBe(prima.version);
  });
});

describe('da condiviso a diviso, e ritorno', () => {
  it('dividere copia il contenuto: nessun modulo parte da un file vuoto', async () => {
    const path = 'inventories/event_settings.yml';
    const id = await seedShared(path, ['lobby', 'ffa', 'duel-command']);
    await saveConfigDraft(db, { versionId: id, content: 'title: comune', author: 'vally90@metamc.it' });
    await publishConfigDrafts(db, 'vally90@metamc.it');

    await setConfigLinks(db, {
      path,
      modules: ['lobby', 'ffa', 'duel-command'],
      split: true,
      keepVersionId: id,
      author: 'vally90@metamc.it',
    });

    const file = await readConfigFile(db, path);
    expect(file.split).toBe(true);
    expect(file.versions).toHaveLength(3);
    // Tutte e tre partono dal contenuto che c'era: dividere non e' ricominciare.
    expect(file.versions.every((v) => v.published === 'title: comune')).toBe(true);
    // E ogni modulo e' legato a una versione sola.
    expect(file.versions.flatMap((v) => v.modules).sort()).toEqual(['duel-command', 'ffa', 'lobby']);
  });

  it('ogni modulo riceve la SUA versione, e non quella di un altro', async () => {
    const path = 'inventories/event_settings.yml';
    const file = await readConfigFile(db, path);
    const ffa = file.versions.find((v) => v.modules.includes('ffa'));
    await saveConfigDraft(db, {
      versionId: ffa?.id as number,
      content: 'title: solo ffa',
      author: 'matty@metamc.it',
    });
    await publishConfigDrafts(db, 'matty@metamc.it');

    const bundleFfa = await readConfigBundle(db, 'ffa');
    const bundleLobby = await readConfigBundle(db, 'lobby');
    expect(bundleFfa.files.find((f) => f.path === path)?.content).toBe('title: solo ffa');
    expect(bundleLobby.files.find((f) => f.path === path)?.content).toBe('title: comune');
  });

  it('riunire tiene la versione che si stava guardando', async () => {
    // QUALE resta non puo' deciderlo il database tirando a sorte: restano N
    // testi e ne serve uno. Il client manda quella che chi guarda ha davanti.
    const path = 'inventories/event_settings.yml';
    const before = await readConfigFile(db, path);
    const ffa = before.versions.find((v) => v.modules.includes('ffa'));

    await setConfigLinks(db, {
      path,
      modules: ['lobby', 'ffa', 'duel-command'],
      split: false,
      keepVersionId: ffa?.id as number,
      author: 'vally90@metamc.it',
    });

    const after = await readConfigFile(db, path);
    expect(after.split).toBe(false);
    expect(after.versions).toHaveLength(1);
    expect(after.versions[0]?.published).toBe('title: solo ffa');
    expect(after.versions[0]?.modules).toEqual(['duel-command', 'ffa', 'lobby']);
  });

  it('togliere un modulo dai legami gli toglie il file', async () => {
    const path = 'inventories/event_settings.yml';
    const file = await readConfigFile(db, path);
    await setConfigLinks(db, {
      path,
      modules: ['lobby'],
      split: false,
      keepVersionId: file.versions[0]?.id as number,
      author: 'vally90@metamc.it',
    });

    const ffa = await readConfigBundle(db, 'ffa');
    expect(ffa.files.map((f) => f.path)).not.toContain(path);
    const lobby = await readConfigBundle(db, 'lobby');
    expect(lobby.files.map((f) => f.path)).toContain(path);
  });
});

describe('l`albero: un riepilogo per percorso, senza i contenuti', () => {
  it('dice i moduli, se e` diviso, e se ha una bozza in sospeso', async () => {
    const files = await listConfigFiles(db);
    const sb = files.find((f) => f.path === 'scoreboards.yml');
    expect(sb?.modules).toEqual(['game', 'lobby']);
    expect(sb?.split).toBe(false);
    expect(sb?.hasDraft).toBe(false);

    // Ordinato per percorso: l'albero si costruisce da qui, e un ordine che
    // cambia a ogni richiesta farebbe ballare la barra laterale.
    expect(files.map((f) => f.path)).toEqual([...files.map((f) => f.path)].sort());
  });

  it('e una bozza salvata accende la spia', async () => {
    const file = await readConfigFile(db, 'scoreboards.yml');
    await saveConfigDraft(db, {
      versionId: file.versions[0]?.id as number,
      content: 'title: terza',
      author: 'matty@metamc.it',
    });
    const files = await listConfigFiles(db);
    expect(files.find((f) => f.path === 'scoreboards.yml')?.hasDraft).toBe(true);
    // Ed e' quella spia ad accendere il tasto Pubblica.
    expect(files.some((f) => f.hasDraft)).toBe(true);
  });
});
