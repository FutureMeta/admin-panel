// Lo store delle Lingue, contro il MariaDB finto di Metaverse.
//
// COSA CONTA QUI: che il pannello scriva ESATTAMENTE come Metaverse — `custom`
// e non `shipped`, `version + 1`, `updated_at` in millisecondi — perche' e' da
// quelle tre cose che i server capiscono che c'e' qualcosa di nuovo. Un
// pannello che scrivesse il testo giusto senza toccare l'impronta avrebbe
// «salvato» e nessun giocatore lo vedrebbe mai.

import { describe, expect, it } from 'vitest';
import {
  createLanguage,
  deleteLanguage,
  LanguageExists,
  listLanguages,
  moveLanguage,
  parseNamespace,
  readBundleKeys,
  readOverview,
  setValue,
  UnknownBundle,
  UnknownKey,
  UnknownLanguage,
  UnsafeClick,
  updateLanguage,
} from '#src/lang/store.ts';
import { fakeMetaverseMysql, publish, seededState } from '#tests/support/metaverse-mysql.ts';

const author = 'test@metamc.it';

function withDuels() {
  const state = seededState();
  publish(state, 'duels.uhc', {
    en: {
      'event.countdown': '<gray>%host% starts the event in <white>%time%',
      'event.full': '<red>The event is full',
      'match.starting-title': '<gold>Starting',
    },
    it: { 'event.countdown': '<gray>%host% avvia tra <white>%time%' },
  });
  publish(state, 'duels.bridge', { en: { 'goal.scored': '<green>%player% scored!' } });
  return fakeMetaverseMysql(state);
}

describe('parseNamespace', () => {
  it('owner.bundle, e il resto no', () => {
    expect(parseNamespace('duels.uhc')).toEqual({ owner: 'duels', bundle: 'uhc' });
    for (const bad of ['duels', '.uhc', 'duels.', 'Duels.uhc', 'duels uhc', 'duels.uhc.extra'])
      expect(parseNamespace(bad)).toBeNull();
  });
});

describe('la panoramica', () => {
  it('conta le chiavi per bundle e i testi per lingua', async () => {
    const overview = await readOverview(withDuels());
    expect(overview.languages.map((l) => l.code)).toEqual(['en', 'it']);
    expect(overview.bundles).toEqual([
      { ns: 'duels.bridge', owner: 'duels', bundle: 'bridge', keys: 1, done: { en: 1 } },
      { ns: 'duels.uhc', owner: 'duels', bundle: 'uhc', keys: 3, done: { en: 3, it: 1 } },
    ]);
  });

  it('un nome che non e` owner.bundle non e` un bundle', async () => {
    const my = withDuels();
    publish(my.state, 'orphan', { en: { x: 'y' } });
    const overview = await readOverview(my);
    expect(overview.bundles.map((b) => b.ns)).toEqual(['duels.bridge', 'duels.uhc']);
  });

  it('una riga senza testo non conta come tradotta', async () => {
    const my = withDuels();
    my.state.messages.push({
      namespace: 'duels.uhc',
      locale: 'it',
      message_key: 'event.full',
      shipped: null,
      custom: null,
      version: 0,
      updated_at: 1,
    });
    const overview = await readOverview(my);
    expect(overview.bundles.find((b) => b.ns === 'duels.uhc')?.done).toEqual({ en: 3, it: 1 });
  });
});

describe('le chiavi di un bundle', () => {
  it('una riga per chiave, un valore per lingua che ce l`ha', async () => {
    const bundle = await readBundleKeys(withDuels(), 'duels.uhc');
    expect(bundle.keys).toEqual([
      {
        key: 'event.countdown',
        values: {
          en: '<gray>%host% starts the event in <white>%time%',
          it: '<gray>%host% avvia tra <white>%time%',
        },
      },
      { key: 'event.full', values: { en: '<red>The event is full' } },
      { key: 'match.starting-title', values: { en: '<gold>Starting' } },
    ]);
  });

  it('un bundle che nessun server ha pubblicato non esiste', async () => {
    await expect(readBundleKeys(withDuels(), 'duels.nope')).rejects.toBeInstanceOf(UnknownBundle);
    await expect(readBundleKeys(withDuels(), 'nope')).rejects.toBeInstanceOf(UnknownBundle);
  });
});

describe('scrivere un testo', () => {
  it('va in custom, alza version, e restituisce quello di prima', async () => {
    const my = withDuels();
    const t0 = Date.now();
    const { before } = await setValue(my, {
      ns: 'duels.uhc',
      key: 'event.countdown',
      code: 'it',
      value: '<gray>%host% avvia l’evento tra <white>%time%',
      author,
    });
    expect(before).toBe('<gray>%host% avvia tra <white>%time%');

    const row = my.state.messages.find((r) => r.locale === 'it' && r.message_key === 'event.countdown');
    expect(row).toMatchObject({
      shipped: '<gray>%host% avvia tra <white>%time%',
      custom: '<gray>%host% avvia l’evento tra <white>%time%',
      version: 1,
    });
    expect(row?.updated_at).toBeGreaterThanOrEqual(t0);

    // Il gioco legge custom: e' quello che la lettura restituisce.
    const bundle = await readBundleKeys(my, 'duels.uhc');
    expect(bundle.keys[0]?.values.it).toBe('<gray>%host% avvia l’evento tra <white>%time%');
  });

  it('tradurre una chiave che l`italiano non ha crea la riga, con shipped a NULL', async () => {
    const my = withDuels();
    const { before } = await setValue(my, {
      ns: 'duels.uhc',
      key: 'event.full',
      code: 'it',
      value: '<red>L’evento è pieno',
      author,
    });
    expect(before).toBeNull();
    expect(my.state.messages.find((r) => r.locale === 'it' && r.message_key === 'event.full')).toMatchObject({
      shipped: null,
      custom: '<red>L’evento è pieno',
      version: 1,
    });
  });

  it('una chiave che nessuna lingua conosce non entra', async () => {
    const my = withDuels();
    await expect(
      setValue(my, { ns: 'duels.uhc', key: 'event.fulll', code: 'it', value: 'x', author }),
    ).rejects.toBeInstanceOf(UnknownKey);
    await expect(
      setValue(my, { ns: 'duels.nope', key: 'event.full', code: 'it', value: 'x', author }),
    ).rejects.toBeInstanceOf(UnknownKey);
    await expect(
      setValue(my, { ns: 'nope', key: 'event.full', code: 'it', value: 'x', author }),
    ).rejects.toBeInstanceOf(UnknownBundle);
    await expect(
      setValue(my, { ns: 'duels.uhc', key: 'event.full', code: 'xx', value: 'x', author }),
    ).rejects.toBeInstanceOf(UnknownLanguage);
    expect(my.state.messages).toHaveLength(5);
  });

  it('un comando di click entra solo se una lingua lo ha gia` di suo', async () => {
    const state = seededState();
    const join = "<click:run_command:'/event join'>";
    publish(state, 'duels.uhc', { en: { 'event.join': `${join}<yellow>Join` } });
    const my = fakeMetaverseMysql(state);
    const write = (value: string) =>
      setValue(my, { ns: 'duels.uhc', key: 'event.join', code: 'it', value, author });

    await write(`${join}<yellow>Entra`);
    const planted = await write("<click:run_command:'/op tizio'><yellow>Entra").catch((e: unknown) => e);
    expect(planted).toBeInstanceOf(UnsafeClick);
    expect(planted).toMatchObject({ command: "<click:run_command:'/op tizio'>" });
    // Il testo di prima resta.
    expect(my.state.messages.find((r) => r.locale === 'it')?.custom).toBe(`${join}<yellow>Entra`);
  });
});

describe('le lingue', () => {
  it('una lingua nuova nasce spenta, vuota, in fondo', async () => {
    const my = withDuels();
    const language = await createLanguage(my, { code: 'es', display: '<white>Español', author });
    expect(language).toEqual({ code: 'es', display: '<white>Español', position: 2, active: false });
    expect((await listLanguages(my)).map((l) => l.code)).toEqual(['en', 'it', 'es']);
    expect(my.state.languages.find((l) => l.locale === 'es')).toMatchObject({ enabled: 0, version: 1 });

    await expect(createLanguage(my, { code: 'es', display: 'x', author })).rejects.toBeInstanceOf(
      LanguageExists,
    );
  });

  it('accendere e rinominare alzano version', async () => {
    const my = withDuels();
    await createLanguage(my, { code: 'es', display: '<white>Español', author });
    const on = await updateLanguage(my, 'es', { active: true });
    expect(on).toMatchObject({ code: 'es', active: true, display: '<white>Español' });
    const renamed = await updateLanguage(my, 'es', { display: '<yellow>Español' });
    expect(renamed).toMatchObject({ active: true, display: '<yellow>Español' });
    expect(my.state.languages.find((l) => l.locale === 'es')).toMatchObject({ enabled: 1, version: 3 });

    await expect(updateLanguage(my, 'xx', { active: true })).rejects.toBeInstanceOf(UnknownLanguage);
  });

  it('cancellare una lingua porta via i suoi testi, e dice quanti', async () => {
    const my = withDuels();
    const gone = await deleteLanguage(my, 'it');
    expect(gone).toEqual({ display: '<white>Italiano', texts: 1 });
    expect((await listLanguages(my)).map((l) => l.code)).toEqual(['en']);
    expect(my.state.messages.some((r) => r.locale === 'it')).toBe(false);
    // Gli altri restano tutti.
    expect(my.state.messages).toHaveLength(4);

    await expect(deleteLanguage(my, 'xx')).rejects.toBeInstanceOf(UnknownLanguage);
  });

  it('spostare scambia due posizioni, e ai bordi non fa niente', async () => {
    const my = withDuels();
    await createLanguage(my, { code: 'es', display: 'Español', author });

    await moveLanguage(my, 'es', 'up');
    expect((await listLanguages(my)).map((l) => l.code)).toEqual(['en', 'es', 'it']);
    await moveLanguage(my, 'en', 'up');
    expect((await listLanguages(my)).map((l) => l.code)).toEqual(['en', 'es', 'it']);
    await moveLanguage(my, 'en', 'down');
    expect((await listLanguages(my)).map((l) => l.code)).toEqual(['es', 'en', 'it']);
    expect(my.state.languages.map((l) => l.position).sort()).toEqual([0, 1, 2]);

    await expect(moveLanguage(my, 'xx', 'up')).rejects.toBeInstanceOf(UnknownLanguage);
  });

  it('con buchi e doppioni nelle posizioni, spostare sposta di un posto solo', async () => {
    const my = withDuels();
    await createLanguage(my, { code: 'es', display: 'Español', author });
    await createLanguage(my, { code: 'fr', display: 'Français', author });
    // A mano, nel database: en 0, es 5, it 5, fr 9.
    for (const [locale, position] of [
      ['it', 5],
      ['es', 5],
      ['fr', 9],
    ] as const) {
      const row = my.state.languages.find((l) => l.locale === locale);
      if (row !== undefined) row.position = position;
    }
    await moveLanguage(my, 'fr', 'up');
    expect((await listLanguages(my)).map((l) => l.code)).toEqual(['en', 'es', 'fr', 'it']);
    expect(my.state.languages.map((l) => l.position).sort()).toEqual([0, 1, 2, 3]);
  });
});
