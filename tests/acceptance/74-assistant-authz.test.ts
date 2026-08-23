// IL TEST CHE CONTA PIU' DI TUTTI GLI ALTRI MESSI INSIEME.
//
// Un assistente dentro un pannello di amministrazione e' un moltiplicatore di
// privilegi se sbagliato, e il modo di sbagliarlo e' uno solo e preciso: i tool
// leggono con i permessi del PROCESSO invece che con quelli della persona che
// ha scritto in chat. Non e' un caso di scuola — e' cio' che viene naturale,
// perche' il processo una connessione al database ce l'ha e l'utente no.
//
// L'effetto sarebbe che un moderatore con accesso ai soli duels chiede a
// Svetlana chi c'e' fra gli utenti del pannello, e lo ottiene. Nessun errore,
// nessuna riga rossa: una risposta cortese con dentro dati che quella persona
// non puo' vedere.
//
// COME E' COSTRUITA LA PROVA. Il database contiene davvero le persone che si
// cercano, e il ruolo di lettura ha davvero il privilegio di leggerle: se il
// controllo dentro il tool sparisse, la chiamata riuscirebbe e restituirebbe
// quelle righe. Non basta quindi verificare che il risultato sia un rifiuto —
// si verifica anche che il testo del risultato NON contenga l'indirizzo che si
// e' cercato. E' la differenza fra «ha detto di no» e «non ha guardato».
//
// (Provata a rovescio prima di essere scritta: togliendo la riga `can(...)` da
// `guarded()` questi test falliscono, e falliscono sull'asserzione giusta —
// l'indirizzo compare nel risultato.)

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AssistantData } from '#src/assistant/reader.ts';
import { NotConfigured } from '#src/assistant/reader.ts';
import { buildTools, type ToolCall } from '#src/assistant/tools.ts';
import type { AuthzContext } from '#src/authz/context.ts';
import { type Level, MODULES, type ModuleKey } from '#src/authz/modules.ts';
import { createKysely, createPool, type Database } from '#src/db/pool.ts';
import { StatsCache } from '#src/stats/cache.ts';
import { connect, createTestDatabase, type TestDatabase } from '#tests/support/postgres.ts';
import { type RedisHarness, startRedis } from '#tests/support/redis.ts';

let db: TestDatabase;
let panelDb: Database;
let redis: RedisHarness;
let closePool: () => Promise<void>;

const VITTIMA = 'bersaglio-da-non-vedere@metamc.it';

beforeAll(async () => {
  db = await createTestDatabase('assistant-authz');
  redis = await startRedis();

  // Le persone esistono davvero. Senza, un rifiuto e una tabella vuota
  // sarebbero indistinguibili e il test passerebbe anche col controllo tolto.
  const owner = await connect(db.adminUrl, 'metamc-test-seed');
  try {
    await owner.query(
      `INSERT INTO auth."user" (id, name, email, "emailVerified", status)
       VALUES ('u-bersaglio', 'Bersaglio', $1, true, 'active'),
              ('u-attore',    'Attore',    'attore@metamc.it', true, 'active')`,
      [VITTIMA],
    );
    await owner.query(
      `INSERT INTO audit.audit_log (action, outcome, actor_email, module_key, target_label)
       VALUES ('user.banned', 'success', $1, 'utenti', 'una riga che non si deve vedere')`,
      [VITTIMA],
    );
    // Trenta righe in piu': servono a vedere il tetto mordere. Con una sola,
    // «al massimo venticinque» e «una» sono indistinguibili.
    await owner.query(
      `INSERT INTO audit.audit_log (action, outcome, module_key)
       SELECT 'auth.login.success', 'success', 'audit' FROM generate_series(1, 30)`,
    );
  } finally {
    await owner.end();
  }

  const pool = createPool({
    connectionString: db.assistantUrl,
    max: 2,
    applicationName: 'metamc-test-assistant-tools',
    statementTimeout: '10s',
  });
  panelDb = createKysely(pool);
  closePool = () => panelDb.destroy();
}, 120_000);

afterAll(async () => {
  await closePool?.().catch(() => undefined);
  await redis?.stop();
  await db?.drop();
});

/** Un attore con ESATTAMENTE i permessi indicati e zero su tutto il resto. */
function actorWith(permissions: Partial<Record<ModuleKey, Level>>): AuthzContext {
  const full = Object.fromEntries(MODULES.map((m) => [m, permissions[m] ?? 0])) as Record<ModuleKey, Level>;
  return {
    userId: 'u-attore',
    sessionId: 'sessione-di-prova',
    permissions: full,
    permissionsVersion: 1,
    aal: 2,
    authenticatedAt: new Date(),
    actorEmail: 'attore@metamc.it',
    actorDisplayName: 'Attore',
  };
}

function dataFor(): AssistantData {
  // Le statistiche NON sono configurate in questa suite: i due tool che le
  // usano rispondono «non disponibile», e non e' cio' che si sta provando qui.
  return {
    panelDb,
    statsDb: null,
    duels: null,
    cache: new StatsCache({ redis: redis.client() }),
  };
}

type Parsed = { ok: boolean; error?: string; detail?: string; data?: unknown };

/** Esegue un tool come lo eseguirebbe il ciclo: prima `parse`, poi `run`. */
async function callTool(
  actor: AuthzContext,
  name: string,
  args: unknown,
): Promise<{ parsed: Parsed; raw: string; calls: ToolCall[] }> {
  const calls: ToolCall[] = [];
  const tools = buildTools({ actor, data: dataFor(), calls, now: new Date() });
  const entry = tools.find((t) => t.name === name);
  if (!entry) throw new Error(`tool inesistente: ${name}`);
  const input = entry.tool.parse(args);
  const raw = await entry.tool.run(input, {
    toolUse: { id: 'x', name, input, type: 'tool_use' },
    toolUseBlock: { id: 'x', name, input, type: 'tool_use' },
  });
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  return { parsed: JSON.parse(text) as Parsed, raw: text, calls };
}

describe('senza il permesso, il dato non esce — e non viene nemmeno letto', () => {
  it('un moderatore dei soli duels non ottiene gli utenti del pannello', async () => {
    const { parsed, raw, calls } = await callTool(actorWith({ duels: 1 }), 'panel_user_search', {
      query: 'bersaglio',
      limit: 5,
    });

    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe('permesso_negato');
    // L'asserzione che conta: il dato non c'e'. Con il controllo tolto, questa
    // riga fallisce mentre le due sopra passerebbero comunque su un rifiuto
    // scritto altrove.
    expect(raw).not.toContain(VITTIMA);
    // `toMatchObject` e non `toEqual`: la chiamata porta anche quanto ci ha
    // messo, e un test che fissasse i millisecondi fallirebbe a caso.
    expect(calls).toMatchObject([
      { name: 'panel_user_search', outcome: 'denied', args: { query: 'bersaglio', limit: 5 } },
    ]);
    // Il tempo c'e' e su un rifiuto e' quasi zero: e' cio' che permette di
    // dire che la lentezza NON sta nei tool.
    expect(calls[0]?.ms).toBeGreaterThanOrEqual(0);
  });

  it('e nemmeno il registro attivita`', async () => {
    const { parsed, raw } = await callTool(actorWith({ duels: 1 }), 'audit_recent', {
      action: null,
      moduleKey: null,
      outcome: null,
      actorEmail: null,
      limit: 10,
    });
    expect(parsed.error).toBe('permesso_negato');
    expect(raw).not.toContain('una riga che non si deve vedere');
  });

  it('e nemmeno le statistiche di rete', async () => {
    const { parsed } = await callTool(actorWith({ duels: 1 }), 'network_online', {});
    // «permesso negato» e non «non disponibile»: il controllo viene PRIMA di
    // qualunque considerazione su cosa sia configurato. Al contrario, chi non
    // ha il permesso imparerebbe quali sorgenti esistono su questa
    // installazione.
    expect(parsed.error).toBe('permesso_negato');
  });

  it('il rifiuto nomina il modulo, non il livello che manca', async () => {
    const { parsed } = await callTool(actorWith({}), 'panel_user_search', { query: 'x', limit: 1 });
    expect(parsed.detail).toContain('utenti');
    // Sapere quale gradino manca descrive la matrice a chi non deve vederla.
    expect(parsed.detail).not.toMatch(/livello|level|\b[123]\b/);
  });
});

describe('con il permesso, il dato esce', () => {
  it('chi ha `utenti` trova la persona che ha cercato', async () => {
    const { parsed, raw, calls } = await callTool(actorWith({ utenti: 1 }), 'panel_user_search', {
      query: 'bersaglio',
      limit: 5,
    });
    expect(parsed.ok).toBe(true);
    expect(raw).toContain(VITTIMA);
    expect(calls[0]?.outcome).toBe('success');

    // La stessa chiamata, con e senza il permesso, e' la prova che il rifiuto
    // di sopra non era una tabella vuota travestita da controllo.
    const rows = parsed.data as Array<{ email: string; canManage: boolean }>;
    expect(rows.map((r) => r.email)).toContain(VITTIMA);
    // Nessuno dei due domina l'altro: entrambi hanno zero permessi nel
    // database, quindi la dominanza e' vera. Cio' che conta e' che il campo
    // ci sia — senza, Svetlana suggerirebbe operazioni che il pannello
    // rifiuterebbe.
    expect(typeof rows[0]?.canManage).toBe('boolean');
  });

  it('chi ha `audit` legge il registro, senza indirizzi IP', async () => {
    // Filtrato per attore: il registro porta anche trenta righe di
    // riempimento, e cercare proprio quella e' anche il modo di provare il
    // filtro.
    const { parsed, raw } = await callTool(actorWith({ audit: 1 }), 'audit_recent', {
      action: null,
      moduleKey: null,
      outcome: null,
      actorEmail: VITTIMA,
      limit: 10,
    });
    expect(parsed.ok).toBe(true);
    expect(raw).toContain('una riga che non si deve vedere');
    // MINIMIZZAZIONE: le colonne ci sono nella tabella e il GRANT le
    // comprende — non si puo' concedere per colonna senza rendere illeggibile
    // la migration. La barriera e' la SELECT scritta a mano, e questa riga e'
    // cio' che la tiene tale.
    expect(raw).not.toContain('actor_ip');
    expect(raw).not.toContain('userAgent');
    expect(raw).not.toContain('socketIp');
  });
});

describe('i limiti sui valori li applica il codice, non lo schema', () => {
  // `strict: true` non accetta `minimum`/`maximum` — l'API rifiuta l'intera
  // richiesta, e la chat non parte. I limiti sono quindi scesi nel corpo dei
  // tool: e' un posto migliore, perche' li' non si possono aggirare.

  it('un `limit` fuori scala si taglia, non si rifiuta', async () => {
    const { parsed } = await callTool(actorWith({ audit: 1 }), 'audit_recent', {
      action: null,
      moduleKey: null,
      outcome: null,
      actorEmail: null,
      limit: 999,
    });
    expect(parsed.ok).toBe(true);
    expect((parsed.data as unknown[]).length).toBe(25);
  });

  it('e uno sotto il minimo pure', async () => {
    const { parsed } = await callTool(actorWith({ audit: 1 }), 'audit_recent', {
      action: null,
      moduleKey: null,
      outcome: null,
      actorEmail: null,
      limit: 0,
    });
    expect((parsed.data as unknown[]).length).toBe(1);
  });

  it('una ricerca vuota non e` una ricerca', async () => {
    // `ILIKE '%%'` restituirebbe l'elenco completo dello staff, che finirebbe
    // a un fornitore esterno al posto di una riga. Prima lo impediva `min(1)`
    // nello schema.
    const { parsed, raw } = await callTool(actorWith({ utenti: 1 }), 'panel_user_search', {
      query: '   ',
      limit: 5,
    });
    expect(parsed.error).toBe('argomento_non_valido');
    expect(raw).not.toContain(VITTIMA);
  });

  it('una chiave di modalita` inventata non costruisce una chiave di cache', async () => {
    const { parsed } = await callTool(actorWith({ statistiche: 1 }), 'network_trend', {
      range: '24h',
      mode: 'Bed Wars!!',
    });
    // Il controllo viene PRIMA della lettura: infatti la risposta non e'
    // «sorgente non configurata», che sarebbe l'esito di questa suite se si
    // fosse arrivati a leggere.
    expect(parsed.error).toBe('argomento_non_valido');
  });
});

describe('una sorgente spenta si distingue da un permesso mancante', () => {
  it('chi ha `statistiche` ma non ha il pool sente dire «non disponibile»', async () => {
    const { parsed } = await callTool(actorWith({ statistiche: 1 }), 'network_online', {});
    expect(parsed.ok).toBe(false);
    // Due frasi diverse per due situazioni diverse: «non ti e` permesso» manda
    // a chiedere un permesso, «non e` configurato» manda a guardare
    // l'installazione. Confonderle fa perdere un pomeriggio.
    expect(parsed.error).toBe('non_disponibile');
  });

  it('e l`errore che lo produce e` tipizzato, non una stringa da confrontare', () => {
    expect(new NotConfigured('statistiche').what).toBe('statistiche');
  });
});
