# Policy di aggiornamento delle dipendenze

§12. Numeri, non buone intenzioni.

| Tipo | Finestra |
|---|---|
| Patch di sicurezza | entro **72 ore** |
| Minor | finestra **mensile fissa** |
| Major | **mai** senza una settimana di soak e una issue dedicata |
| Cooldown Renovate | **7 giorni** sulle release nuove |

## Regole non negoziabili

- Versioni **esatte** in `package.json`: niente `^`, niente `~`. La CI fallisce
  se ne compare una.
- Lockfile committato. In CI: `pnpm install --frozen-lockfile --ignore-scripts`.
- **Nessun floor di versione entra in `package.json` o nel Dockerfile sulla
  base di un CVE non verificato** con una chiamata a
  `cveawg.mitre.org/api/cve/<ID>` o `api.osv.dev/v1/vulns/<GHSA>`.
  Tre dei diciassette identificativi citati nella ricerca originale erano
  inventati, e sono stati scoperti proprio così.
- La provenance npm firmata **non basta**: nella campagna ChainDrop le versioni
  avvelenate avevano provenance valida, perché era la pipeline stessa a essere
  compromessa.
- Renovate/Dependabot su **tutto** lo scope `@better-auth/*`, e una regola di CI
  che fallisce se compare un pacchetto di quello scope fuori dalla allowlist
  (`better-auth`, `@better-auth/redis-storage`).

## Bus factor — da sapere, non da temere

Non è motivo di scarto: è motivo di policy. Se uno di questi si ferma, si sa
già dove guardare.

| Pacchetto | Situazione |
|---|---|
| `helmet` | unico committer |
| `@simplewebauthn/*` | unico committer (fase 1.5) |
| `@node-rs/argon2` | 1 release in 12 mesi |
| `rate-limiter-flexible` | 1 maintainer |
| `better-auth` | 1 maintainer npm, 211 release/anno, 13 advisory dal 2026-01-01 |

`better-auth` è quello che pesa di più: è nel percorso di autenticazione, si
muove in fretta, e ha già prodotto advisory di sicurezza in questo ciclo. Il
pin è esatto, il cooldown è di 7 giorni, e ogni aggiornamento passa dai 17 test
di accettazione prima di essere considerato.

## Floor attuali, con il CVE che li giustifica

Ogni riga è stata verificata contro l'API primaria durante l'implementazione.

| Componente | Floor | Verificato | Bypass chiuso |
|---|---|---|---|
| Node.js | 24.19.0 | ✓ MITRE | CVE-2026-56846, CVE-2026-56848 (HTTP/2), CVE-2026-58043 (permission model) |
| fastify | 5.8.5 (pin 5.12.0) | ✓ MITRE | CVE-2026-33806 — validazione del body saltata con uno spazio nel Content-Type |
| better-auth | 1.6.11 (pin 1.6.29) | ✓ MITRE + OSV | CVE-2026-67336 (crypto defaults), GHSA-2vg6-77g8-24mp (sessioni stale dopo delete) |
| kysely | 0.28.17 (pin 0.29.5) | ✓ MITRE | CVE-2026-44635 — JSON path injection, 0.26.0–0.28.16 |
| PostgreSQL | 18.6 | ✓ postgresql.org | 28 CVE del 2026-08-13 |
| PgBouncer (se mai) | 1.25.2 | ✓ MITRE | CVE-2026-6664/6665/6666/6667 |

### Identificativi che NON esistono

Verificati 404 su MITRE **e** su OSV. Non sono usati come motivazione di
nessun floor, e se ricompaiono in una discussione è perché qualcuno li ha
ricopiati senza verificarli.

- `CVE-2026-56684` (attribuito a Valkey)
- `CVE-2026-63639` (attribuito a Valkey)
- `GHSA-6hxq-p678-4hr2` (attribuito a `@simplewebauthn/server`)

### Due imprecisioni nella ricerca originale

- `CVE-2026-53513` riguarda **`@better-auth/sso`**, non il core: non regge il
  floor di `better-auth`. Lo reggono `CVE-2026-67336` e `GHSA-2vg6-77g8-24mp`.
- `GHSA-8pvw-jcv7-9cmj` aliassa **`CVE-2026-7120`**, non `CVE-2026-6414`: sono
  tre advisory distinte di `@fastify/static` (`CVE-2026-15074`,
  `CVE-2026-6414`, `CVE-2026-7120`), non una.
