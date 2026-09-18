// «Lingue · Bundle». Le misure vengono da `frontend/15-lingue-panoramica.dc.html`.
//
// DUE PANNELLI: a sinistra le lingue, una per riga, con il completamento su
// tutto il network; a destra i bundle per la lingua scelta, raggruppati per
// proprietario, con «Traduci ›» in fondo a ogni riga che non e' completa.
//
// LE LINGUE STANNO IN VERTICALE DI PROPOSITO. Aggiungerne una non allarga la
// tabella: una colonna per lingua, con sette lingue, e' una griglia che non
// entra piu' nello schermo — ed e' la forma che il disegno ha scartato.
//
// DUE DESTINAZIONI PER RIGA, e non si somigliano: cliccare la riga apre le
// chiavi del bundle (si legge, si corregge); cliccare «Traduci» apre la
// traduzione sequenziale (si scorre solo cio' che manca). Sono due modi di
// lavorare, e mescolarli in un clic solo obbligherebbe a scegliere dopo.

import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { CompletionBar, Eyebrow, overviewQuery, RetryBanner } from '../components/lang-bits.tsx';
import { PageHeader } from '../components/page.tsx';
import { ICONS, Icon, SkeletonRows } from '../components/ui.tsx';
import type { Me } from '../lib/api.ts';
import { groupBundles, heat, languageName, pctOf, REFERENCE } from '../lib/lang.ts';
import { canOpen } from '../lib/modules.ts';

export function LangOverviewPage({ me }: { me: Me }) {
  // «Traduci ›» porta a una schermata che serve solo a chi scrive.
  const canTranslate = canOpen(me, 'lingue', 2);
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<string | null>(null);

  const overview = useQuery(overviewQuery);
  const languages = overview.data?.languages ?? [];
  const bundles = overview.data?.bundles ?? [];

  // La lingua scelta: quella cliccata, o la prima che non sia l'inglese —
  // e' quella su cui c'e' lavoro da fare. `en` resta scegliibile: e' una
  // lingua come le altre, e si puo' correggere.
  const focus =
    picked ?? languages.find((l) => l.code !== REFERENCE)?.code ?? languages[0]?.code ?? REFERENCE;

  const totalKeys = bundles.reduce((sum, b) => sum + b.keys, 0);
  const totals = useMemo(
    () =>
      languages.map((l) => {
        const done = bundles.reduce((sum, b) => sum + (b.done[l.code] ?? 0), 0);
        return { ...l, done, pct: pctOf(done, totalKeys) };
      }),
    [languages, bundles, totalKeys],
  );

  const needle = search.trim().toLowerCase();
  const shown = totals.filter(
    (l) => needle === '' || l.code.includes(needle) || languageName(l.code).toLowerCase().includes(needle),
  );
  const groups = groupBundles(bundles);

  return (
    <>
      <PageHeader title="Lingue · Bundle" sub="I testi che i giocatori vedono in gioco" />

      {overview.isError ? (
        <RetryBanner
          title="Non riesco a leggere le lingue"
          body="Il pannello non risponde. I server continuano a usare i testi che hanno."
          onRetry={() => void overview.refetch()}
        />
      ) : null}

      <div
        style={{ display: 'grid', gridTemplateColumns: '320px minmax(0,1fr)', gap: 16, alignItems: 'start' }}
      >
        <section style={PANEL}>
          <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--bd-subtle)' }}>
            <div style={SEARCH}>
              <Icon path={ICONS.search} size={14} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Cerca lingua"
                style={INPUT}
              />
            </div>
          </div>
          <div
            style={{
              padding: 8,
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              maxHeight: 420,
              overflowY: 'auto',
            }}
          >
            {overview.isLoading ? <SkeletonRows rows={4} /> : null}
            {shown.map((l) => {
              const on = l.code === focus;
              return (
                <button
                  key={l.code}
                  type="button"
                  onClick={() => setPicked(l.code)}
                  aria-pressed={on}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 7,
                    padding: '10px 11px',
                    border: `1px solid ${on ? 'rgba(219,110,25,.45)' : 'var(--bd-subtle)'}`,
                    borderRadius: 'var(--r-sm)',
                    background: on ? 'var(--ac-soft)' : 'transparent',
                    textAlign: 'left',
                    cursor: 'pointer',
                  }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 13,
                        fontWeight: 600,
                        color: on ? 'var(--ac-text)' : 'var(--tx-primary)',
                      }}
                    >
                      {l.code}
                    </span>
                    {l.active ? null : (
                      <span style={{ fontSize: 10.5, color: 'var(--tx-muted)' }}>disattivata</span>
                    )}
                    <span
                      style={{
                        marginLeft: 'auto',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11.5,
                        color: 'var(--tx-secondary)',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {l.pct}%
                    </span>
                  </span>
                  <span
                    style={{
                      display: 'block',
                      width: '100%',
                      height: 5,
                      borderRadius: 3,
                      background: 'var(--s-inset)',
                      overflow: 'hidden',
                    }}
                  >
                    <span
                      style={{
                        display: 'block',
                        height: '100%',
                        background: heat(l.pct),
                        width: `${l.pct}%`,
                      }}
                    />
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--tx-muted)' }}>
                    {l.pct >= 100 ? 'completa' : `${totalKeys - l.done} chiavi da fare`}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section style={PANEL}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '14px 18px',
              borderBottom: '1px solid var(--bd-subtle)',
              flexWrap: 'wrap',
            }}
          >
            <div>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 600 }}>
                Bundle · <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14 }}>{focus}</span>
              </div>
              <div style={{ marginTop: 3, fontSize: 11.5, color: 'var(--tx-muted)' }}>
                Completamento di {focus.toUpperCase()} bundle per bundle · cambia lingua a sinistra
              </div>
            </div>
          </div>

          {overview.isLoading ? (
            <div style={{ padding: 18 }}>
              <SkeletonRows rows={6} />
            </div>
          ) : null}

          {overview.isSuccess && bundles.length === 0 ? (
            <div
              style={{
                padding: '70px 24px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 10,
                textAlign: 'center',
              }}
            >
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 'var(--r-md)',
                  border: '1px dashed var(--bd-strong)',
                }}
              />
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 600 }}>
                Nessun bundle
              </div>
              <div style={{ maxWidth: 420, fontSize: 12.5, color: 'var(--tx-muted)', lineHeight: '19px' }}>
                Nessun server si è ancora avviato con questo plugin. I bundle compaiono da soli al primo
                avvio: non si creano da qui.
              </div>
            </div>
          ) : null}

          {bundles.length > 0 ? (
            <div>
              <div style={{ ...ROW, padding: '11px 18px' }}>
                <Eyebrow>Bundle</Eyebrow>
                {/* Un flex e non un `text-align`: cosi' la scritta e' un blocco come le
                    altre due, e non un inline che siede piu' in basso sulla riga. */}
                <span style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <Eyebrow>Chiavi</Eyebrow>
                </span>
                <Eyebrow>Completamento</Eyebrow>
                <span />
              </div>
              {groups.map(([owner, rows]) => (
                <div key={owner}>
                  <div
                    style={{
                      padding: '10px 18px',
                      background: 'var(--s-inset)',
                      borderBottom: '1px solid var(--bd-subtle)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                    }}
                  >
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11.5,
                        color: 'var(--tx-primary)',
                        fontWeight: 500,
                      }}
                    >
                      {owner}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--tx-muted)' }}>{rows.length} bundle</span>
                  </div>
                  {rows.map((r) => {
                    const pct = pctOf(r.done[focus] ?? 0, r.keys);
                    return (
                      <div
                        key={r.ns}
                        style={{ ...ROW, position: 'relative', alignItems: 'center', padding: '12px 18px' }}
                      >
                        {/* La riga intera e' un link, e i pulsanti sopra di lei
                            stanno su uno strato piu' alto: due destinazioni,
                            nessuna delle due nascosta dall'altra. */}
                        <Link
                          to="/lingue/b/$ns"
                          params={{ ns: r.ns }}
                          title="Apri le chiavi del bundle"
                          style={{ position: 'absolute', inset: 0, zIndex: 1 }}
                        />
                        <span
                          style={{
                            position: 'relative',
                            zIndex: 2,
                            pointerEvents: 'none',
                            fontFamily: 'var(--font-mono)',
                            fontSize: 12.5,
                            minWidth: 0,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {r.ns}
                        </span>
                        <span
                          style={{
                            textAlign: 'right',
                            fontFamily: 'var(--font-mono)',
                            fontSize: 12,
                            fontVariantNumeric: 'tabular-nums',
                            color: 'var(--tx-secondary)',
                          }}
                        >
                          {r.keys}
                        </span>
                        <CompletionBar pct={pct} />
                        <span
                          style={{
                            position: 'relative',
                            zIndex: 2,
                            display: 'flex',
                            justifyContent: 'flex-end',
                          }}
                        >
                          {pct >= 100 ? (
                            <span
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                height: 20,
                                padding: '0 8px',
                                fontSize: 11.5,
                                color: 'var(--tx-disabled)',
                              }}
                            >
                              completo
                            </span>
                          ) : !canTranslate ? null : (
                            <button
                              type="button"
                              onClick={() =>
                                void navigate({
                                  to: '/lingue/b/$ns/traduci/$code',
                                  params: { ns: r.ns, code: focus },
                                })
                              }
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 5,
                                height: 20,
                                padding: '0 8px',
                                border: '1px solid rgba(219,110,25,.45)',
                                borderRadius: 'var(--r-sm)',
                                background: 'var(--ac-soft)',
                                fontFamily: 'var(--font-ui)',
                                fontSize: 11.5,
                                fontWeight: 600,
                                color: 'var(--ac-text)',
                                cursor: 'pointer',
                              }}
                            >
                              Traduci
                              <Icon path={ICONS.chevron} size={11} />
                            </button>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          ) : null}
        </section>
      </div>
    </>
  );
}

const PANEL: React.CSSProperties = {
  border: '1px solid var(--bd-subtle)',
  borderRadius: 'var(--r-lg)',
  background: 'var(--s-surface)',
  overflow: 'hidden',
};

const ROW: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(180px,1.6fr) 74px minmax(160px,1fr) 108px',
  gap: '12px 18px',
  alignItems: 'center',
  borderBottom: '1px solid var(--bd-subtle)',
};

export const SEARCH: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  height: 32,
  padding: '0 10px',
  border: '1px solid var(--bd-subtle)',
  borderRadius: 'var(--r-sm)',
  background: 'var(--s-inset)',
  color: 'var(--tx-muted)',
};

export const INPUT: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  border: 'none',
  background: 'transparent',
  outline: 'none',
  color: 'var(--tx-primary)',
  fontFamily: 'var(--font-ui)',
  fontSize: 12.5,
};
