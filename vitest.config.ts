import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Le suite di accettazione creano un database effimero a testa: girano in
    // processi separati ma non troppi, altrimenti il cluster di test diventa
    // il collo di bottiglia.
    //
    // DUE, E NON QUATTRO, PER UNA RAGIONE MISURATA. Su questa macchina il
    // postmaster accetta le connessioni UNA ALLA VOLTA, ~750 ms ciascuna:
    // `postgres.exe --version` impiega 700-870 ms mentre `psql.exe` nella
    // stessa cartella ne impiega 30, quindi non e' il disco — e' una
    // scansione antivirus on-access mirata a quel binario. Quattro worker
    // che aprono i loro pool insieme fanno venti secondi di coda e i pool
    // scadono in blocco, con errori che sembrano di autenticazione.
    //
    // La cura vera e' escludere postgres.exe dalla scansione, e non e' una
    // modifica che sta in questo repository. Finche' non e' fatta, due
    // worker tengono la raffica sotto la soglia. `TEST_MAX_WORKERS` permette
    // di rialzarli dove il difetto non c'e'.
    pool: 'forks',
    maxWorkers: Number(process.env.TEST_MAX_WORKERS ?? 2),
    testTimeout: 60_000,
    hookTimeout: 180_000,
    // Nessun setup globale: ogni suite dichiara le proprie risorse, cosi' un
    // test si puo' sempre eseguire da solo.
    reporters: ['default'],
    sequence: { hooks: 'stack' },
  },
});
