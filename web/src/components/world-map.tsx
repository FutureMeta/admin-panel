// La mappa coropletica. Fase 2, §8.9 — passo 8.
//
// Segue `frontend/4-panoramica-network.dc.html`: griglia `1fr 260px`, mappa a
// sinistra, «Primi 10 paesi» a destra. Nel mockup la mappa e' un segnaposto
// tratteggiato — il disegno vero e' questo file.
//
// IL COLORE VIENE DAL VALORE, e c'e' voluto un giro sbagliato per arrivarci.
// Veniva dalla POSIZIONE IN CLASSIFICA, per una ragione che sembrava buona:
// con l'Italia in testa e una coda lunga sotto il 5%, una scala lineare
// dipinge l'Italia e lascia il pianeta di un grigio unico. Il rimedio era
// pero' peggiore del male — un paese da 900 giocatori e uno da 1.200 finivano
// identici perche' erano secondo e primo, e quindici paesi con lo STESSO
// numero finivano di quindici colori diversi perche' la classifica li mette
// comunque in fila. La scala sta in `lib/heat.ts` (`mapPosition`), e' una
// radice quadrata sul valore, e ha i suoi test.
//
// LA LEGENDA NON E' ORNAMENTO: senza, un colore si puo' solo confrontare a
// occhio con un altro colore. Con i due estremi scritti, diventa leggibile.
//
// I NON ATTRIBUITI NON SONO NELL'ELENCO, ma nemmeno spariscono: stanno in una
// riga sotto la mappa, col loro numero. Toglierli e basta farebbe sembrare la
// mappa completa mentre misura meno gente di quanta ce ne sia — ed e'
// esattamente il modo in cui un pannello mente senza dire una parola falsa.
//
// «PROVENIENZA APPROSSIMATA» E' OBBLIGATORIO, e non e' una excusatio: nessun
// database gratuito segnala VPN, proxy e datacenter, quindi una fetta di
// traffico apparira' da NL, DE o US per ragioni che non hanno niente a che
// vedere con la provenienza. Questa mappa non va usata come prova in una
// decisione di moderazione, e chi la guarda deve poterlo leggere.
//
// L'ATTRIBUZIONE A DB-IP E' UN REQUISITO DI LICENZA (CC BY 4.0), e va nel
// footer di QUESTA schermata, non nel README. E' quello che si dimentica.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ALPHA2_TO_NUMERIC } from '../lib/country-codes.ts';
import { numberFmt } from '../lib/format.ts';
import { MAP_GRADIENT, mapPosition, rampColour } from '../lib/heat.ts';
import { type CountryShape, loadWorld, MAP_HEIGHT, MAP_WIDTH, pathOf } from '../lib/world.ts';
import { HoverTip, useHoverTip } from './hover-tip.tsx';

export type GeoData = { cc: string[]; v: number[]; asOf: number; exact: boolean };

/** Codici che non sono paesi: fuori dall'elenco e fuori dal denominatore. */
const UNATTRIBUTED: Record<string, string> = {
  XX: 'non determinati',
  '--': 'non rilevati',
};

// `numberFmt` è condiviso con il resto del pannello (import in testa al file):
// una seconda istanza con le stesse opzioni è solo un altro posto in cui la
// punteggiatura può divergere, ed è già successo dentro la ciambella.

/**
 * I nomi dei paesi in italiano, dal browser.
 *
 * Una tabella di 250 nomi sarebbe 250 stringhe da tradurre, tenere aggiornate
 * e sbagliare. `Intl.DisplayNames` ce l'ha gia' dentro.
 */
const NAMES = new Intl.DisplayNames(['it'], { type: 'region', fallback: 'none' });

function nameOf(cc: string): string {
  try {
    return NAMES.of(cc) ?? cc;
  } catch {
    return cc;
  }
}

// ---------------------------------------------------------------------------
// Navigazione
// ---------------------------------------------------------------------------

type View = { x: number; y: number; w: number; h: number };

const FULL: View = { x: 0, y: 0, w: MAP_WIDTH, h: MAP_HEIGHT };
/** Oltre questo la 110m non ha piu' dettaglio da mostrare: sono poligoni. */
const MAX_ZOOM = 12;

/**
 * Tiene la vista DENTRO la carta.
 *
 * Senza, trascinando si finisce nel vuoto e non c'e' modo di capire dove si e'
 * andati: una mappa in cui ci si puo' perdere e' peggio di una mappa ferma.
 */
function clampView(v: View): View {
  const w = Math.min(MAP_WIDTH, Math.max(MAP_WIDTH / MAX_ZOOM, v.w));
  const h = w * (MAP_HEIGHT / MAP_WIDTH);
  return {
    w,
    h,
    x: Math.min(Math.max(0, v.x), MAP_WIDTH - w),
    y: Math.min(Math.max(0, v.y), MAP_HEIGHT - h),
  };
}

// ---------------------------------------------------------------------------

export function WorldMap({ geo, label }: { geo: GeoData; label: string }) {
  const [shapes, setShapes] = useState<CountryShape[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState<View>(FULL);
  const [grabbing, setGrabbing] = useState(false);
  /** Solo il codice: il riquadro lo tiene `useHoverTip`. */
  const [lit, setLit] = useState<string | null>(null);

  const hover = useHoverTip();
  const boxRef = hover.boxRef;
  const drag = useRef<{ px: number; py: number; view: View } | null>(null);

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

  // --- i numeri -----------------------------------------------------------

  const { rows, resolved, missing } = useMemo(() => {
    const all = geo.cc.map((cc, i) => ({ cc, v: geo.v[i] ?? 0 }));
    const known = all.filter((x) => !(x.cc in UNATTRIBUTED));
    return {
      rows: known.sort((a, b) => b.v - a.v),
      resolved: known.reduce((a, x) => a + x.v, 0),
      missing: all.filter((x) => x.cc in UNATTRIBUTED).sort((a, b) => b.v - a.v),
    };
  }, [geo]);

  /**
   * Il tetto della scala: il paese con più giocatori.
   *
   * `rows` è già ordinato per valore decrescente, quindi è il primo. Con zero
   * paesi è zero, e `mapPosition` se ne accorge da sé.
   */
  const top = rows[0]?.v ?? 0;

  const byNumeric = useMemo(() => {
    const m = new Map<string, { cc: string; v: number; fill: string }>();
    for (const r of rows) {
      const numeric = ALPHA2_TO_NUMERIC[r.cc];
      // Un codice che la topologia non conosce — `XK` (Kosovo) e' il caso vero
      // — degrada a «non disegnato». Resta nell'elenco a destra, dove il numero
      // si legge lo stesso.
      if (numeric) {
        m.set(numeric, { cc: r.cc, v: r.v, fill: rampColour(mapPosition(r.v, top)) });
      }
    }
    return m;
  }, [rows, top]);

  const pct = useCallback(
    (v: number) => (resolved > 0 ? `${((v / resolved) * 100).toFixed(1).replace('.', ',')}%` : '—'),
    [resolved],
  );

  // --- navigazione --------------------------------------------------------

  // `wheel` a mano e non via React: il listener di React e' passivo, quindi
  // `preventDefault` non avrebbe effetto e la pagina scorrerebbe sotto il
  // cursore mentre si prova a ingrandire.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = box.getBoundingClientRect();
      const fx = (e.clientX - rect.left) / rect.width;
      const fy = (e.clientY - rect.top) / rect.height;
      setView((v) => {
        const next = clampView({ ...v, w: v.w * (e.deltaY < 0 ? 0.82 : 1 / 0.82), h: v.h });
        // Si ingrandisce INTORNO AL CURSORE: zoomare sempre al centro
        // costringe a inseguire il punto che si stava guardando.
        return clampView({
          ...next,
          x: v.x + (v.w - next.w) * fx,
          y: v.y + (v.h - next.h) * fy,
        });
      });
    };
    box.addEventListener('wheel', onWheel, { passive: false });
    return () => box.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      drag.current = { px: e.clientX, py: e.clientY, view };
      setGrabbing(true);
      setLit(null);
      hover.clear();
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [view, hover],
  );

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const rect = e.currentTarget.getBoundingClientRect();
    // Lo spostamento si converte in unita' della carta: se no, trascinare da
    // ingranditi sposterebbe molto piu' di quanto il dito ha percorso.
    const dx = ((e.clientX - d.px) / rect.width) * d.view.w;
    const dy = ((e.clientY - d.py) / rect.height) * d.view.h;
    setView(clampView({ ...d.view, x: d.view.x - dx, y: d.view.y - dy }));
  }, []);

  const endDrag = useCallback(() => {
    drag.current = null;
    setGrabbing(false);
  }, []);

  const zoomed = view.w < MAP_WIDTH - 0.5;

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
            Giocatori unici · {label} · scala a radice, sul valore
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* LA LEGENDA. Senza, un colore non si può leggere: si può solo
              confrontare con un altro colore, a occhio, a due centimetri di
              distanza sulla carta. Con i due estremi scritti, una tinta
              diventa un ordine di grandezza — ed è la risposta vera a «questi
              due mi sembrano uguali»: la mappa mostra il disegno, il numero si
              legge qui, nel riquadro al passaggio del mouse e nell'elenco a
              destra. Stessa forma della legenda della heatmap, stessa rampa. */}
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--tx-muted)' }}
          >
            <span>1</span>
            {/* Il gradiente parte da `MAP_FLOOR`, non da zero: sotto quella
                soglia nessun paese viene mai disegnato, e una legenda che
                mostrasse anche quel tratto prometterebbe colori che sulla
                carta non esistono. */}
            <span style={{ width: 96, height: 8, borderRadius: 4, background: MAP_GRADIENT }} />
            <span>{top > 0 ? numberFmt.format(top) : '—'}</span>
          </div>
          {zoomed ? (
            <button
              type="button"
              onClick={() => setView(FULL)}
              style={{
                border: '1px solid var(--bd-subtle)',
                borderRadius: 'var(--r-xs)',
                background: 'var(--s-inset)',
                color: 'var(--tx-secondary)',
                fontFamily: 'var(--font-ui)',
                fontSize: 11.5,
                padding: '4px 9px',
                cursor: 'pointer',
              }}
            >
              Tutto il mondo
            </button>
          ) : null}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 260px', gap: 18 }}>
        <div
          ref={boxRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerLeave={() => {
            endDrag();
            setLit(null);
            hover.clear();
          }}
          style={{
            position: 'relative',
            border: '1px solid var(--bd-subtle)',
            borderRadius: 'var(--r-md)',
            background: 'var(--s-inset)',
            minHeight: 260,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
            cursor: grabbing ? 'grabbing' : 'grab',
            touchAction: 'none',
          }}
        >
          {shapes ? (
            <svg
              viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
              style={{ width: '100%', height: 'auto', display: 'block' }}
              role="img"
              aria-label="Mappa dei giocatori unici per paese"
            >
              <title>Giocatori unici per paese</title>
              {shapes.map((s) => {
                const hit = byNumeric.get(s.id);
                const active = hit !== undefined && lit === hit.cc;
                return (
                  <path
                    key={s.id || s.name}
                    d={pathOf(s)}
                    fill={hit?.fill ?? 'var(--s-elevated)'}
                    stroke={active ? 'var(--tx-primary)' : 'var(--bd-subtle)'}
                    // Il tratto si assottiglia zoomando: a spessore costante,
                    // da vicino i confini coprirebbero i paesi piccoli.
                    strokeWidth={(active ? 1.4 : 0.4) * (view.w / MAP_WIDTH)}
                    onPointerMove={(e) => {
                      if (drag.current) return;
                      if (!hit) {
                        setLit(null);
                        hover.clear();
                        return;
                      }
                      setLit(hit.cc);
                      hover.at(e, nameOf(hit.cc), `${numberFmt.format(hit.v)} giocatori · ${pct(hit.v)}`);
                    }}
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

          <HoverTip tip={hover.tip} boxRef={boxRef} />
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
            {rows.slice(0, 10).map((c) => (
              <div key={c.cc} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 2,
                    // Lo stesso colore che ha sulla carta, dalla stessa
                    // funzione: il quadratino dell'elenco è il ponte fra un
                    // nome e una tinta, e se i due divergessero servirebbe a
                    // sbagliare invece che a leggere.
                    background: rampColour(mapPosition(c.v, top)),
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
                  {numberFmt.format(c.v)}
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
                  {pct(c.v)}
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
          {/* I non attribuiti non stanno nell'elenco, ma il loro numero si
              dice: senza, le percentuali sarebbero calcolate su una
              popolazione piu' piccola senza che si veda quanto. */}
          {missing.length > 0
            ? `${missing.map((m) => `${numberFmt.format(m.v)} ${UNATTRIBUTED[m.cc]}`).join(', ')} · fuori dalle percentuali. `
            : ''}
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
