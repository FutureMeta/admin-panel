// La mappa coropletica. Fase 2, §8.9 — passo 8.
//
// Segue `frontend/4-panoramica-network.dc.html`: griglia `1fr 260px`, mappa a
// sinistra, «Primi 10 paesi» a destra. Nel mockup la mappa e' un segnaposto
// tratteggiato — il disegno vero e' questo file.
//
// SCALA PER QUANTILI, NON LINEARE, ed e' scritto nel sottotitolo del design
// perche' e' una decisione, non un dettaglio: con l'Italia al 71% e tutto il
// resto sotto il 5%, una scala lineare colorerebbe l'Italia e lascerebbe
// l'intero pianeta dello stesso identico grigio. Il colore qui dice la
// POSIZIONE IN CLASSIFICA, non il valore assoluto — e la classifica e' quello
// che si guarda su una mappa.
//
// «PROVENIENZA APPROSSIMATA» E' OBBLIGATORIO, e non e' una excusatio: nessun
// database gratuito segnala VPN, proxy e datacenter, quindi una fetta di
// traffico apparira' da NL, DE o US per ragioni che non hanno niente a che
// vedere con la provenienza. Questa mappa non va usata come prova in una
// decisione di moderazione, e chi la guarda deve poterlo leggere.
//
// L'ATTRIBUZIONE A DB-IP E' UN REQUISITO DI LICENZA (CC BY 4.0), e va nel
// footer di QUESTA schermata, non nel README. E' quello che si dimentica.

import { useEffect, useState } from 'react';
import { ALPHA2_TO_NUMERIC } from '../lib/country-codes.ts';
import { type CountryShape, loadWorld, MAP_HEIGHT, MAP_WIDTH, pathOf } from '../lib/world.ts';

export type GeoData = { cc: string[]; v: number[]; asOf: number; exact: boolean };

/** La rampa del design system, la stessa della heatmap. */
const RAMP = ['#0F212A', '#16394B', '#1E5670', '#4C6E72', '#8A7147', '#C08129', '#F0A63F'];

const numero = new Intl.NumberFormat('it-IT');

/**
 * I nomi dei paesi in italiano, dal browser.
 *
 * Una tabella di 250 nomi sarebbe 250 stringhe da tradurre, tenere aggiornate
 * e sbagliare. `Intl.DisplayNames` ce l'ha gia' dentro.
 */
const NAMES = new Intl.DisplayNames(['it'], { type: 'region', fallback: 'none' });

function nameOf(cc: string): string {
  // `XX` non e' un paese: e' il secchiello dei non risolti, e deve avere un
  // nome leggibile perche' e' una barra visibile come le altre.
  if (cc === 'XX') return 'Non determinato';
  try {
    return NAMES.of(cc) ?? cc;
  } catch {
    return cc;
  }
}

function lerp(a: string, b: string, t: number): string {
  const hex = (s: string, i: number) => Number.parseInt(s.slice(1 + i * 2, 3 + i * 2), 16);
  const mix = (i: number) => Math.round(hex(a, i) + (hex(b, i) - hex(a, i)) * t);
  return `#${[0, 1, 2].map((i) => mix(i).toString(16).padStart(2, '0')).join('')}`;
}

function rampColor(t: number): string {
  const x = Math.max(0, Math.min(1, t)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(x));
  return lerp(RAMP[i] as string, RAMP[i + 1] as string, x - i);
}

// ---------------------------------------------------------------------------

export function WorldMap({ geo, label }: { geo: GeoData; label: string }) {
  const [shapes, setShapes] = useState<CountryShape[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    loadWorld().then(
      (s) => alive && setShapes(s),
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, []);

  const total = geo.v.reduce((a, b) => a + b, 0);

  // La scala per quantili: il colore dipende dalla POSIZIONE fra i paesi con
  // dati, non dal valore. Con un paese solo, quel paese e' in cima.
  const ranked = geo.cc
    .map((cc, i) => ({ cc, v: geo.v[i] ?? 0 }))
    .filter((x) => x.cc !== 'XX')
    .sort((a, b) => a.v - b.v);
  const rankOf = new Map(ranked.map((x, i) => [x.cc, ranked.length > 1 ? i / (ranked.length - 1) : 1]));

  const fillFor = new Map<string, string>();
  for (const [cc, t] of rankOf) {
    const numeric = ALPHA2_TO_NUMERIC[cc];
    // Un codice che la topologia non conosce — `XK` (Kosovo) e' il caso vero —
    // degrada a «non disegnato». Resta nell'elenco a destra, dove il numero si
    // legge lo stesso: perdere la sagoma non deve significare perdere il dato.
    if (numeric) fillFor.set(numeric, rampColor(0.15 + t * 0.85));
  }

  const top = geo.cc
    .map((cc, i) => ({ cc, v: geo.v[i] ?? 0 }))
    .sort((a, b) => b.v - a.v)
    .slice(0, 10);

  return (
    <section
      style={{
        border: '1px solid var(--bd-subtle)',
        borderRadius: 'var(--r-lg)',
        background: 'var(--s-surface)',
        padding: '18px 20px',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          marginBottom: 16,
        }}
      >
        <div>
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 600, margin: '0 0 4px' }}>
            Provenienza geografica
          </h3>
          <div style={{ fontSize: 12, color: 'var(--tx-muted)' }}>
            Giocatori unici · {label} · scala per quantili, non lineare
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 260px', gap: 18 }}>
        <div
          style={{
            border: '1px solid var(--bd-subtle)',
            borderRadius: 'var(--r-md)',
            background: 'var(--s-inset)',
            minHeight: 260,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
          }}
        >
          {shapes ? (
            <svg
              viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
              style={{ width: '100%', height: 'auto', display: 'block' }}
              role="img"
              aria-label="Mappa dei giocatori unici per paese"
            >
              <title>Giocatori unici per paese</title>
              {shapes.map((s) => {
                const fill = fillFor.get(s.id);
                return (
                  <path
                    key={s.id || s.name}
                    d={pathOf(s)}
                    fill={fill ?? 'var(--s-elevated)'}
                    stroke="var(--bd-subtle)"
                    strokeWidth={0.4}
                  />
                );
              })}
            </svg>
          ) : (
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11.5,
                color: failed ? 'var(--err)' : 'var(--tx-muted)',
                padding: 20,
                textAlign: 'center',
              }}
            >
              {failed ? 'contorni non disponibili — l`elenco a destra resta valido' : 'caricamento contorni…'}
            </div>
          )}
        </div>

        <div>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '.1em',
              textTransform: 'uppercase',
              color: 'var(--tx-muted)',
              marginBottom: 10,
            }}
          >
            Primi 10 paesi
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {top.map((c) => (
              <div key={c.cc} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 2,
                    background:
                      c.cc === 'XX' ? 'var(--tx-disabled)' : rampColor(0.15 + (rankOf.get(c.cc) ?? 0) * 0.85),
                    flex: 'none',
                  }}
                />
                <span
                  style={{
                    fontSize: 12,
                    flex: 1,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {nameOf(c.cc)}
                </span>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11.5,
                    color: 'var(--tx-secondary)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {numero.format(c.v)}
                </span>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11.5,
                    color: 'var(--tx-muted)',
                    width: 46,
                    textAlign: 'right',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {total > 0 ? `${((c.v / total) * 100).toFixed(1).replace('.', ',')}%` : '—'}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div
        style={{
          marginTop: 14,
          paddingTop: 12,
          borderTop: '1px solid var(--bd-subtle)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          fontSize: 11,
          color: 'var(--tx-muted)',
        }}
      >
        <span>
          Provenienza approssimata: VPN, proxy e datacenter non sono distinguibili. Non usare come prova in
          una decisione di moderazione.
        </span>
        {/* Requisito di licenza CC BY 4.0, non una cortesia. */}
        <a
          href="https://db-ip.com"
          target="_blank"
          rel="noreferrer noopener"
          style={{ color: 'var(--tx-muted)', whiteSpace: 'nowrap' }}
        >
          IP Geolocation by DB-IP
        </a>
      </div>
    </section>
  );
}
