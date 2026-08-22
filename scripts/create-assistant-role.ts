// Crea il ruolo Postgres da cui legge Svetlana. UNA volta sola, da un superuser.
//
// PERCHE' UN RUOLO IN PIU' E NON `metamc_stats`. Quel ruolo e' stato ristretto
// apposta: la 011 gli REVOCA lo schema `auth` e lo schema `audit`
// (011_stats.sql:70-79). Svetlana deve poter cercare un utente del pannello e
// leggere le ultime voci del registro, quindi con quel ruolo non ci arriva —
// e allargarlo significherebbe dare gli utenti e il registro anche a tutte le
// rotte delle statistiche, che non li chiedono.
//
// PERCHE' NON `metamc_app`, che quei dati li ha gia'. Perche' `metamc_app`
// SCRIVE. La regola della v1 e' che nessun tool possa modificare niente, e una
// regola del genere vale quanto il posto in cui e' scritta: dentro il codice e'
// una promessa che il prossimo `INSERT` distratto rompe senza far rumore,
// dentro il database e' un errore alla prima riga scritta. Qui sta nel
// database: `default_transaction_read_only` sul RUOLO, e nessun GRANT di
// scrittura da nessuna parte.
//
// APPARTENENZA A `metamc_stats`, non una copia dei suoi GRANT. Le viste delle
// statistiche e dei duels sono trenta righe di GRANT nella 011 e nella 016,
// piu' una ALTER DEFAULT PRIVILEGES che copre quelle future. Ricopiarle qui
// vorrebbe dire che il giorno in cui ne nasce una nuova, Svetlana la vede o
// non la vede a seconda di quale dei due elenchi qualcuno si e' ricordato di
// aggiornare. L'appartenenza non puo' divergere.
//
// I `SET` DI RUOLO NON SI EREDITANO: `default_transaction_read_only` e i
// timeout si applicano al login del ruolo con cui ci si collega, quindi vanno
// ripetuti qui anche se `metamc_stats` li ha gia'.
//
// Il ruolo nasce SENZA password, come quelli della fase 2: con scram-sha-256
// un ruolo senza password non puo' autenticarsi, quindi il default e' chiuso.
//
// Uso:
//   node scripts/create-assistant-role.ts --print
//   DATABASE_SUPERUSER_URL=postgres://postgres:...@host:5432/metamc \
//     node scripts/create-assistant-role.ts

import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const ASSISTANT_ROLE = 'metamc_assistant';

export const ASSISTANT_ROLE_SQL = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metamc_assistant') THEN
    CREATE ROLE metamc_assistant LOGIN INHERIT;
  END IF;
END $$;

-- Tutto cio' che il ruolo di lettura delle statistiche puo' gia' leggere:
-- viste online, viste duels, dizionario delle modalita'. Per appartenenza,
-- cosi' non c'e' un secondo elenco da tenere allineato.
GRANT metamc_stats TO metamc_assistant;

-- SOLA LETTURA IMPOSTA DAL DATABASE. In v1 nessun tool scrive, e questa riga
-- e' il posto in cui quella frase e' verificabile invece che promessa.
-- RUNBOOK: con queste credenziali non si fa manutenzione. E' voluto.
ALTER ROLE metamc_assistant SET default_transaction_read_only = on;

-- Dieci secondi come il ruolo delle statistiche: una domanda in chat non vale
-- piu' di una schermata, e una query che dura di piu' e' un difetto da
-- vedere, non da aspettare.
ALTER ROLE metamc_assistant SET statement_timeout = '10s';
ALTER ROLE metamc_assistant SET lock_timeout      = '1s';
ALTER ROLE metamc_assistant SET search_path       = stats, public, pg_catalog;

-- CONNECT sta QUI e non nella migration: e' un privilegio di DATABASE, e
-- metamc_migrate possiede gli schemi, non il database. Senza, la 019 applica
-- i GRANT giusti e poi il pool non riesce nemmeno ad aprire una connessione —
-- un guasto che sembra una password sbagliata.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO metamc_assistant', current_database());
END $$;
`;

async function main(): Promise<void> {
  if (process.argv.includes('--print')) {
    console.log(ASSISTANT_ROLE_SQL.trim());
    return;
  }

  const url = process.env['DATABASE_SUPERUSER_URL'];
  if (!url) {
    console.error(
      'serve DATABASE_SUPERUSER_URL (un ruolo con CREATEROLE o superuser).\n' +
        "Per vedere l'SQL senza eseguirlo: node scripts/create-assistant-role.ts --print",
    );
    process.exitCode = 1;
    return;
  }

  const client = new pg.Client({ connectionString: url, application_name: 'metamc-assistant-role' });
  await client.connect();
  try {
    await client.query(ASSISTANT_ROLE_SQL);
    const res = await client.query<{ rolname: string }>('SELECT rolname FROM pg_roles WHERE rolname = $1', [
      ASSISTANT_ROLE,
    ]);
    if (res.rows.length === 0) throw new Error(`ruolo non creato: ${ASSISTANT_ROLE}`);
    console.log(`  ${ASSISTANT_ROLE} (login, senza password)`);
    console.log('ruolo pronto. Ora: pnpm run migrate');
  } finally {
    await client.end();
  }
}

const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
