import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Le suite di accettazione creano un database effimero a testa: girano in
    // processi separati ma non troppi, altrimenti il cluster di test diventa
    // il collo di bottiglia.
    pool: 'forks',
    maxWorkers: 4,
    testTimeout: 60_000,
    hookTimeout: 180_000,
    // Nessun setup globale: ogni suite dichiara le proprie risorse, cosi' un
    // test si puo' sempre eseguire da solo.
    reporters: ['default'],
    sequence: { hooks: 'stack' },
  },
});
