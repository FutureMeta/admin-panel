// «Genera con l'AI»: il formato che non si tocca, i tentativi, la rotta.
//
// NESSUN TEST PARLA CON L'API. Il client e' finto, risponde con le traduzioni
// che gli si danno e ricorda cosa gli e' stato chiesto: e' da li' che si vede
// se il modello giusto riceve il testo giusto — e se un formato rotto torna
// indietro invece di finire in un campo.

import { Anthropic } from '@anthropic-ai/sdk';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AiTranslationFailed, frameDiff, TRANSLATE_MODEL, translateWithAi } from '#src/lang/ai.ts';
import { loginAs, seedUser } from '#tests/support/actors.ts';
import { startTestApp, type TestApp } from '#tests/support/app.ts';
import {
  type FakeMetaverseMysql,
  fakeMetaverseMysql,
  publish,
  seededState,
} from '#tests/support/metaverse-mysql.ts';

type Params = Record<string, unknown> & { messages: Array<{ content: string }> };

/** Risponde con le traduzioni date, una per chiamata, e ricorda le richieste. */
function fakeClient(answers: Array<string | 'refusal' | Error>) {
  const seen: Params[] = [];
  const client = {
    beta: {
      messages: {
        parse: async (params: Params) => {
          seen.push(params);
          const answer = answers[seen.length - 1];
          if (answer === undefined) throw new Error('una chiamata in piu` che nessuno aspettava');
          if (answer instanceof Error) throw answer;
          return answer === 'refusal'
            ? { stop_reason: 'refusal', parsed_output: null, usage: { input_tokens: 50, output_tokens: 0 } }
            : {
                stop_reason: 'end_turn',
                parsed_output: { translation: answer },
                usage: { input_tokens: 400, output_tokens: 60 },
              };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, seen };
}

const EN = '<gray>%host% starts the event in <white>%time%';
const IT = '<gray>%host% avvia l’evento tra <white>%time%';
const SAME = { missing: [], extra: [] };

describe('il formato che la traduzione non puo` toccare', () => {
  it('le parole cambiano, tag e segnaposto no', () => {
    expect(frameDiff(EN, IT)).toEqual(SAME);
  });

  it('un tag tradotto, uno perso, un segnaposto rinominato: si vede cosa', () => {
    expect(frameDiff(EN, '<grigio>%host% avvia l’evento tra %tempo%')).toEqual({
      missing: ['<gray>', '<white>', '%time%'],
      extra: ['<grigio>', '%tempo%'],
    });
  });

  it('i segnaposto a tag, <player> e <server>, sono tag come gli altri', () => {
    expect(frameDiff('<white><player></white> left', '<white><giocatore></white> è uscito').missing).toEqual([
      '<player>',
    ]);
  });

  it('il comando di un click resta com`e`, il testo di un hover si traduce', () => {
    const en =
      "<click:run_command:'/event join %host%'><hover:show_text:'<#C4CED6>Click to join'><yellow>Join now</yellow></hover></click>";
    const it_ =
      "<click:run_command:'/event join %host%'><hover:show_text:'<#C4CED6>Clicca per entrare'><yellow>Entra ora</yellow></hover></click>";
    expect(frameDiff(en, it_)).toEqual(SAME);
    expect(frameDiff(en, it_.replace('/event join', '/evento entra')).missing).toEqual([
      "<click:run_command:'/event join %host%'>",
    ]);
  });

  it('un apostrofo dritto dentro l`hover chiude le virgolette, e si vede', () => {
    const en = "<hover:show_text:'<gray>Click to join the event'>x</hover>";
    expect(
      frameDiff(en, "<hover:show_text:'<gray>Clicca per entrare nell'evento'>x</hover>").missing,
    ).toContain("<hover:show_text:'…'>");
    expect(frameDiff(en, "<hover:show_text:'<gray>Clicca per entrare nell’evento'>x</hover>")).toEqual(SAME);
  });

  it('le righe restano quelle', () => {
    expect(frameDiff('<gray>One\n<white>Two', '<gray>Uno <white>Due').missing).toEqual(['\n']);
  });

  it('l`ordine puo` cambiare, se la lingua lo vuole', () => {
    expect(frameDiff('%killer% killed %victim%', '%victim%を%killer%が倒した')).toEqual(SAME);
  });
});

describe('la chiamata', () => {
  const input = { ns: 'duels.uhc', key: 'event.countdown', code: 'it', source: EN };

  it('Sonnet 5, uscita strutturata, niente parametri che non accetta, e l`inglese nel messaggio', async () => {
    const { client, seen } = fakeClient([IT]);
    const out = await translateWithAi(client, input);
    expect(out).toMatchObject({ text: IT, attempts: 1, usage: { input: 400, output: 60 } });

    const req = seen[0] as Params;
    expect(req).toMatchObject({
      model: 'claude-sonnet-5',
      betas: [],
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
    });
    // `fallbacks` su Sonnet 5 e' un 400: non deve partire.
    expect(req).not.toHaveProperty('fallbacks');
    expect((req.output_config as { format?: unknown }).format).toBeDefined();
    expect(JSON.parse(req.messages[0]?.content ?? '')).toEqual({
      bundle: 'duels.uhc',
      key: 'event.countdown',
      to: 'Italian (it)',
      text: EN,
    });
  });

  it('un formato rotto si riprova una volta, dicendo cosa manca', async () => {
    const { client, seen } = fakeClient(['<grigio>%host% avvia l’evento tra <white>%time%', IT]);
    const out = await translateWithAi(client, input);
    expect(out).toMatchObject({ text: IT, attempts: 2, usage: { input: 800, output: 120 } });
    const note = JSON.parse(seen[1]?.messages[0]?.content ?? '').note as string;
    expect(note).toContain('<gray>');
    expect(note).toContain('<grigio>');
  });

  it('rotto due volte: la proposta si butta, e la spesa resta contata', async () => {
    const { client } = fakeClient(['<grigio>x', '<grigio>x']);
    const err = await translateWithAi(client, input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiTranslationFailed);
    expect(err).toMatchObject({ code: 'formato_cambiato', usage: { input: 800, output: 120 } });
  });

  it('un rifiuto non si riprova', async () => {
    const { client, seen } = fakeClient(['refusal']);
    await expect(translateWithAi(client, input)).rejects.toMatchObject({ code: 'rifiuto' });
    expect(seen).toHaveLength(1);
  });
});

describe('la rotta', () => {
  let t: TestApp;
  let my: FakeMetaverseMysql;
  let sviluppatore: Awaited<ReturnType<typeof loginAs>>;
  let moderatore: Awaited<ReturnType<typeof loginAs>>;

  beforeAll(async () => {
    t = await startTestApp({ label: 'lang-ai', assistant: true });
    sviluppatore = await loginAs(t, await seedUser(t, { email: 'dev-ai@metamc.it', roleKey: 'dev' }));
    moderatore = await loginAs(t, await seedUser(t, { email: 'mod-ai@metamc.it', roleKey: 'moderatore' }));
  }, 180_000);

  afterAll(async () => {
    await t?.close();
  });

  beforeEach(() => {
    const state = seededState();
    publish(state, 'duels.uhc', { en: { 'event.countdown': EN }, it: { 'solo.it': '<gray>Solo italiano' } });
    my = fakeMetaverseMysql(state);
    (t.ctx as { metaverseMysql: unknown }).metaverseMysql = my;
  });

  const useClient = (answers: Array<string | 'refusal' | Error>) => {
    const fake = fakeClient(answers);
    if (t.ctx.assistant === null) throw new Error('assistente non costruito');
    t.ctx.assistant.client = fake.client;
    return fake;
  };

  const translate = (
    actor: Awaited<ReturnType<typeof loginAs>>,
    payload: Record<string, unknown> = { ns: 'duels.uhc', key: 'event.countdown', code: 'it' },
  ) => t.app.inject({ method: 'POST', url: '/api/lang/translate', headers: actor.headers(), payload });

  async function auditRows(): Promise<Array<{ outcome: string; meta: Record<string, unknown> }>> {
    const res = await sql<{ outcome: string; meta: Record<string, unknown> }>`
      SELECT outcome, meta FROM audit.audit_log WHERE action = 'lang.value.ai' ORDER BY id
    `.execute(t.ctx.db);
    return res.rows;
  }

  it('chi legge soltanto non genera, e l`API non viene chiamata', async () => {
    const { seen } = useClient([IT]);
    expect((await translate(moderatore)).statusCode).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('una proposta torna al campo e NON si salva; registro e spesa la contano', async () => {
    useClient([IT]);
    const before = await t.ctx.assistant?.spend.spentThisMonth(new Date());
    const res = await translate(sviluppatore);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ text: IT });

    expect(my.state.messages.some((r) => r.locale === 'it' && r.message_key === 'event.countdown')).toBe(
      false,
    );
    expect((await auditRows()).at(-1)).toEqual({
      outcome: 'success',
      meta: { ns: 'duels.uhc', key: 'event.countdown', code: 'it', model: TRANSLATE_MODEL, attempts: 1 },
    });
    expect(await t.ctx.assistant?.spend.spentThisMonth(new Date())).toBeGreaterThan(before ?? 0);
  });

  it('l`inglese e` il riferimento: non si traduce', async () => {
    const { seen } = useClient([IT]);
    const res = await translate(sviluppatore, { ns: 'duels.uhc', key: 'event.countdown', code: 'en' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('riferimento');
    expect(seen).toHaveLength(0);
  });

  it('senza un testo inglese non c`e` niente da tradurre; una chiave che non c`e` e` 404', async () => {
    const { seen } = useClient([IT]);
    const empty = await translate(sviluppatore, { ns: 'duels.uhc', key: 'solo.it', code: 'it' });
    expect(empty.statusCode).toBe(409);
    expect(empty.json().code).toBe('niente_da_tradurre');
    expect((await translate(sviluppatore, { ns: 'duels.uhc', key: 'nope', code: 'it' })).statusCode).toBe(
      404,
    );
    expect(seen).toHaveLength(0);
  });

  it('formato rotto due volte: 422, e il registro scrive il fallimento', async () => {
    useClient(['<grigio>x', '<grigio>x']);
    const res = await translate(sviluppatore);
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('formato_cambiato');
    expect((await auditRows()).at(-1)).toMatchObject({
      outcome: 'failure',
      meta: { failure: 'formato_cambiato' },
    });
  });

  it('l`API che non risponde e` un 503 che si puo` riprovare', async () => {
    useClient([new Anthropic.APIConnectionError({ message: 'rete giu` (simulato)' })]);
    const res = await translate(sviluppatore);
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('ai_non_raggiungibile');
  });

  it('senza chiave AI la rotta c`e` e lo dice', async () => {
    const assistant = t.ctx.assistant;
    (t.ctx as { assistant: unknown }).assistant = null;
    try {
      const res = await translate(sviluppatore);
      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe('ai_non_configurata');
    } finally {
      (t.ctx as { assistant: unknown }).assistant = assistant;
    }
  });
});
