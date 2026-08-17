// Impalcatura delle schermate fuori dal pannello: login e reset password.
//
// Sono la stessa schermata con contenuti diversi — due pannelli, il campo di
// esagoni a sinistra col lockup e tre cifre in fondo, il modulo a destra
// largo 372px. Tenerle come due file separati significherebbe che fra un mese
// una ha il bordo e l'altra no.
//
// Metriche di frontend/9-reset-password.dc.html, con UNA deviazione: il file
// del disegno limita il contenitore a 1440px e lo centra, perché la tavola è
// disegnata a quella larghezza. Su uno schermo più largo quel limite diventa
// un riquadro centrato con due bande vuote ai lati — l'effetto sbagliato per
// una pagina che non ha altro contenuto attorno. Qui la schermata riempie la
// finestra; il resto (colonne 1.05:1, padding 48, modulo 372) è quello.

import type { ReactNode } from 'react';
import { HexField } from './hex-field.tsx';

export type AuthStat = { value: string; label: string };

export function AuthShell({
  headline,
  description,
  stats,
  children,
}: {
  /** Le righe del titolo grande: nel disegno vanno a capo a mano. */
  headline: string[];
  description: string;
  stats: AuthStat[];
  children: ReactNode;
}) {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1.05fr) minmax(0, 1fr)',
        background: 'var(--s-surface)',
      }}
    >
      <div
        style={{
          position: 'relative',
          background: 'linear-gradient(155deg,#0E222D 0%,#0A161D 62%,#0E1F28 100%)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: 48,
        }}
      >
        <HexField />

        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 12 }}>
          <img src="/assets/logo.png" alt="" width={40} height={40} style={{ objectFit: 'contain' }} />
          <div>
            <div
              style={{
                fontFamily: 'var(--font-display)',
                fontWeight: 700,
                fontSize: 16,
                letterSpacing: '.14em',
                textTransform: 'uppercase',
                color: '#E9F1F5',
              }}
            >
              MetaMC
            </div>
            <div
              style={{
                fontSize: 11,
                letterSpacing: '.1em',
                textTransform: 'uppercase',
                color: '#718996',
                marginTop: 2,
              }}
            >
              Console operativa
            </div>
          </div>
        </div>

        <div style={{ position: 'relative', maxWidth: 400 }}>
          <div
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 30,
              lineHeight: '40px',
              fontWeight: 700,
              letterSpacing: '-.02em',
              color: '#E9F1F5',
            }}
          >
            {headline.map((line, i) => (
              <span key={line}>
                {line}
                {i < headline.length - 1 ? <br /> : null}
              </span>
            ))}
          </div>
          <p style={{ margin: '16px 0 0', fontSize: 14, lineHeight: '22px', color: '#A9BEC9' }}>
            {description}
          </p>
        </div>

        <div style={{ position: 'relative', display: 'flex', gap: 28, flexWrap: 'wrap' }}>
          {stats.map((s) => (
            <div key={s.label}>
              <div
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 20,
                  fontWeight: 700,
                  color: '#E9F1F5',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {s.value}
              </div>
              <div
                style={{
                  fontSize: 11,
                  letterSpacing: '.08em',
                  textTransform: 'uppercase',
                  color: '#718996',
                  marginTop: 4,
                }}
              >
                {s.label}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 48,
          background: 'var(--s-surface)',
        }}
      >
        <div style={{ width: '100%', maxWidth: 372 }}>{children}</div>
      </div>
    </main>
  );
}

/** Il titolo delle schermate: 24/32 display, con la riga di spiegazione sotto. */
export function AuthHeading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <>
      <h1
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 24,
          lineHeight: '32px',
          fontWeight: 700,
          letterSpacing: '-.01em',
          margin: '0 0 6px',
        }}
      >
        {title}
      </h1>
      {children ? (
        <p style={{ margin: '0 0 26px', fontSize: 13, lineHeight: '20px', color: 'var(--tx-muted)' }}>
          {children}
        </p>
      ) : null}
    </>
  );
}

/** Il quadrato da 40px con l'icona, sopra il titolo degli stati conclusivi. */
export function AuthIcon({ tone, path }: { tone: 'ac' | 'warn' | 'ok'; path: ReactNode }) {
  const bg = tone === 'ac' ? 'var(--ac-soft)' : tone === 'warn' ? 'var(--warn-soft)' : 'var(--ok-soft)';
  const fg = tone === 'ac' ? 'var(--ac-text)' : tone === 'warn' ? 'var(--warn)' : 'var(--ok)';
  return (
    <div
      style={{
        width: 40,
        height: 40,
        borderRadius: 'var(--r-md)',
        background: bg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 18,
      }}
    >
      <svg
        viewBox="0 0 24 24"
        width="20"
        height="20"
        fill="none"
        stroke={fg}
        strokeWidth={tone === 'ok' ? 2 : 1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {path}
      </svg>
    </div>
  );
}

/** La nota in fondo alla colonna, sopra il bordo. */
export function AuthFootnote({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        marginTop: 30,
        paddingTop: 20,
        borderTop: '1px solid var(--bd-subtle)',
        fontSize: 12,
        lineHeight: '19px',
        color: 'var(--tx-muted)',
      }}
    >
      {children}
    </div>
  );
}
