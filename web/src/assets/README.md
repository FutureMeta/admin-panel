# Dati congelati

`countries-110m.json` — world-atlas 2.0.2, contorni dei paesi a 1:110M, id ISO
3166-1 numerico. **Non e' una dipendenza**: `world-atlas` e `topojson-client`
sono fermi al 2019 e i confini del mondo si muovono meno spesso di una minor
version. Il file sta qui, il decodificatore e' `web/src/lib/world.ts`.

Minificato apposta: la versione pretty-printed pesa 182 kB contro 108, e
nessuno lo legge a mano.

Non entra nel bundle JavaScript: `web/src/lib/world.ts` lo prende con
`new URL(..., import.meta.url)` e `fetch`, cosi' passa da `JSON.parse` invece
che dal parser JS. La verifica e' in `tests/acceptance/35-world-map.test.ts`.

Rigenerare (raro):

    curl -sL https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json \
      | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.stringify(JSON.parse(s))))" \
      > web/src/assets/countries-110m.json

`web/src/lib/country-codes.ts` — alpha-2 -> numerico, 249 voci, generata da
ISO-3166-Countries-with-Regional-Codes. Non si modifica a mano.
