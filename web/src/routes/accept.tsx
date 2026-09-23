// Accettazione invito: password, secondo fattore e recovery code.
//
// La pagina si apre DOPO il redirect a URL pulito (§8.1.7): qui il token non
// c'e' piu', c'e' un cookie di onboarding. Se manca, l'invito non e'
// spendibile — e la pagina non dice se era scaduto, consumato o inventato
// (SEC-32).
//
// Impaginazione di frontend/2-accettazione-invito.dc.html: campo di esagoni a
// piena pagina sotto, card centrata da 940px divisa in due. A sinistra cosa
// stai per ricevere, e non cambia mai; a destra i due passi piu' i codici di
// recupero, che restano dentro la stessa card invece di prendersi una pagina.
//
// La barra dei passi si ferma a due anche quando compaiono i codici: non sono
// un terzo passo ma il secondo fattore visto dall'altro lato — che cosa fai
// quando il telefono non ce l'hai piu'.
//
// UNA COSA DEL DISEGNO NON C'E': il pulsante «← Torna alla password» del passo
// 2. Il passo 1 non e' reversibile. Il segreto TOTP lo conia better-auth, e
// per coniarlo gli serve la password: premendo «Continua» l'account viene
// creato e l'invito consumato, ed e' l'unico modo di avere il segreto da cui
// nasce il QR. Un pulsante che riportasse indietro troverebbe la password gia'
// impostata e non potrebbe cambiarla.
//
// I recovery code si mostrano UNA SOLA VOLTA, e il pulsante finale resta
// spento finche' non si conferma di averli salvati.

import { useNavigate } from '@tanstack/react-router';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { HexField } from '../components/hex-field.tsx';
import { TotpSetup } from '../components/totp-setup.tsx';
import { Button, Field, Notice, StrengthMeter } from '../components/ui.tsx';
import { ApiError, api } from '../lib/api.ts';

type OnboardingModule = { key: string; name: string; level: number };
type Onboarding = {
  email: string;
  name: string | null;
  roleName: string | null;
  expiresAt: string | null;
  invitedByName: string | null;
  modules: OnboardingModule[];
};
type Phase = 'caricamento' | 'scaduto' | 'attiva';

const LEVEL_LABEL = ['Nessuno', 'Lettura', 'Scrittura', 'Gestione'] as const;
const LEVEL_TONE = [
  { color: 'var(--tx-muted)', soft: 'var(--s-inset)' },
  { color: 'var(--info)', soft: 'var(--info-soft)' },
  { color: 'var(--ok)', soft: 'var(--ok-soft)' },
  { color: 'var(--ac-text)', soft: 'var(--ac-soft)' },
] as const;

/** Il §8.6 chiede lunghezza, non composizione: e' l'unica soglia che esiste. */
const MIN_PASSWORD = 12;

export function AcceptPage() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>('caricamento');
  const [invite, setInvite] = useState<Onboarding | undefined>();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [totpUri, setTotpUri] = useState<string | undefined>();
  const [step, setStep] = useState<1 | 2>(1);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Onboarding>('/api/invites/onboarding')
      .then((data) => {
        setInvite(data);
        setPhase('attiva');
      })
      .catch(() => setPhase('scaduto'));
  }, []);

  const passwordReady = password.length >= MIN_PASSWORD && password === confirm;

  /**
   * Il passo 1 NON e' reversibile, ed e' il motivo per cui non c'e' un
   * pulsante per tornare indietro dal passo 2.
   *
   * Il segreto TOTP lo conia better-auth, e per coniarlo gli serve la
   * password: il QR del passo 2 non puo' esistere prima che l'account esista.
   * Quindi «Continua» crea l'account e consuma l'invito. Da li' in poi la
   * password e' impostata, e nessuna schermata di questa pagina puo' piu'
   * cambiarla.
   */
  async function submitPassword(e: FormEvent) {
    e.preventDefault();
    if (!passwordReady) return;
    setError(undefined);
    setBusy(true);
    try {
      const res = await api<{ totpURI: string | null }>('/api/invites/accept', {
        method: 'POST',
        body: { password },
      });
      setTotpUri(res.totpURI ?? '');
      setStep(2);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PASSWORD_COMPROMISED') {
        setError('Questa password compare in una violazione nota. Scegline un’altra.');
      } else if (err instanceof ApiError && err.code === 'HIBP_UNAVAILABLE') {
        // Fail-closed dichiarato: si spiega perche' non si prosegue, invece
        // di accettare una password non verificata (§8.6).
        setError(
          'Non riusciamo a verificare che la password non sia compromessa. ' +
            'Per sicurezza non proseguiamo: riprova fra qualche minuto.',
        );
      } else {
        setError('Non è stato possibile impostare la password. Riprova.');
      }
    } finally {
      setBusy(false);
    }
  }

  const expires = invite?.expiresAt
    ? new Intl.DateTimeFormat('it-IT', {
        dateStyle: 'short',
        timeStyle: 'short',
        timeZone: 'Europe/Rome',
      }).format(new Date(invite.expiresAt))
    : null;

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '56px 32px',
        background: 'var(--s-base)',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <HexField width={1440} height={840} opacity={0.5} />

      {phase === 'caricamento' ? (
        <p className="t-lead" style={{ position: 'relative', color: 'var(--tx-muted)', margin: 0 }}>
          Verifica dell'invito…
        </p>
      ) : phase === 'scaduto' ? (
        <Shell single>
          <Title>Invito non più valido</Title>
          {/* SEC-32 — scaduto, già usato, revocato o mai esistito: stessa frase. */}
          <p style={{ margin: '0 0 24px', fontSize: 13.5, lineHeight: '21px', color: 'var(--tx-secondary)' }}>
            Il link non è utilizzabile. Chiedi a chi ti ha invitato di emetterne uno nuovo.
          </p>
          <Button variant="secondary" onClick={() => navigate({ to: '/login' })}>
            Vai al login
          </Button>
        </Shell>
      ) : (
        <Shell>
          {/* Colonna sinistra: cosa stai per ricevere. */}
          <div style={{ padding: 40, borderRight: '1px solid var(--bd-subtle)' }}>
            <img
              src="/assets/logo.png"
              alt="MetaMC"
              width={34}
              height={34}
              style={{ objectFit: 'contain', marginBottom: 22, display: 'block' }}
            />
            <h1
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 24,
                lineHeight: '32px',
                fontWeight: 700,
                letterSpacing: '-.01em',
                margin: '0 0 8px',
              }}
            >
              {/* Il nome sta QUI e non in un campo: lo ha scelto chi ti ha
                  invitato, non e' modificabile, e comparira' nel registro
                  accanto a ogni tua azione. Un campo disabilitato con dentro
                  il tuo nome sembra una cosa da compilare; un saluto no. */}
              Ciao{invite?.name ? ` ${invite.name}` : ''},
              <br />
              sei stato invitato.
            </h1>
            <p
              style={{ margin: '0 0 24px', fontSize: 13.5, lineHeight: '21px', color: 'var(--tx-secondary)' }}
            >
              {invite?.invitedByName ? (
                <>
                  Invito da{' '}
                  <span style={{ color: 'var(--tx-primary)', fontWeight: 600 }}>{invite.invitedByName}</span>
                  {expires ? ' · ' : ''}
                </>
              ) : null}
              {expires ? (
                <>
                  scade il{' '}
                  <span className="mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {expires}
                  </span>{' '}
                  (Europe/Rome).
                </>
              ) : null}
            </p>

            {invite?.roleName ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '12px 14px',
                  border: '1px solid rgba(219,110,25,.35)',
                  background: 'var(--ac-soft)',
                  borderRadius: 'var(--r-sm)',
                  marginBottom: 26,
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    letterSpacing: '.1em',
                    textTransform: 'uppercase',
                    color: 'var(--ac-text)',
                  }}
                >
                  Ruolo
                </span>
                <span
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 15,
                    fontWeight: 700,
                    color: 'var(--tx-primary)',
                  }}
                >
                  {invite.roleName}
                </span>
              </div>
            ) : null}

            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: '.1em',
                textTransform: 'uppercase',
                color: 'var(--tx-muted)',
                marginBottom: 12,
              }}
            >
              Moduli inclusi
            </div>
            {/* Oltre tre moduli la colonna scorre invece di allungare la card:
                150px sono tre righe da 42 piu' i due spazi. Il padding a
                destra piu' il margine negativo tengono la barra staccata dalle
                righe senza restringerle — senza, la barra ci finisce sopra. */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                maxHeight: 150,
                overflowY: 'auto',
                paddingRight: 10,
                marginRight: -10,
              }}
            >
              {(invite?.modules ?? []).map((m) => {
                const tone = LEVEL_TONE[m.level] ?? LEVEL_TONE[0];
                return (
                  <div
                    key={m.key}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '10px 12px',
                      border: '1px solid var(--bd-subtle)',
                      borderRadius: 'var(--r-sm)',
                      background: 'var(--s-elevated)',
                    }}
                  >
                    <span style={{ fontSize: 13, fontWeight: 500 }}>{m.name}</span>
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        padding: '3px 8px',
                        borderRadius: 'var(--r-full)',
                        background: tone.soft,
                        color: tone.color,
                      }}
                    >
                      {LEVEL_LABEL[m.level] ?? m.level}
                    </span>
                  </div>
                );
              })}
            </div>
            <p style={{ margin: '20px 0 0', fontSize: 12, lineHeight: '19px', color: 'var(--tx-muted)' }}>
              I moduli non elencati non compaiono nel pannello. Un owner può ampliare l'accesso in qualsiasi
              momento.
            </p>
          </div>

          {/* Colonna destra: l'unica parte che cambia fra i due passi. */}
          <div style={{ padding: 40 }}>
            <StepBar step={step} />

            {error ? (
              <div style={{ marginBottom: 18 }}>
                <Notice tone="err" title={error} />
              </div>
            ) : null}

            {step === 1 ? (
              <form onSubmit={submitPassword}>
                <h2
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 18,
                    fontWeight: 600,
                    margin: '0 0 20px',
                  }}
                >
                  Imposta la password
                </h2>

                <div className="field" style={{ marginBottom: 18 }}>
                  <label className="label" htmlFor="accept-email">
                    Email
                  </label>
                  {/* L'indirizzo viene dalla riga invito e non è modificabile:
                      il campo lo mostra, non lo raccoglie (§8.1.9). */}
                  <input id="accept-email" className="input" value={invite?.email ?? ''} disabled />
                </div>

                <Field
                  label="Nuova password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={MIN_PASSWORD}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <StrengthMeter password={password} />
                <Field
                  label="Conferma password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={MIN_PASSWORD}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  {...(confirm.length > 0 && confirm !== password
                    ? { hint: 'Le due password non coincidono.' }
                    : {})}
                />

                <div style={{ marginTop: 28 }}>
                  <Button
                    type="submit"
                    variant="primary"
                    size="lg"
                    loading={busy}
                    disabled={!passwordReady}
                    block
                  >
                    Continua
                  </Button>
                </div>
                <Footnote>
                  Al passo successivo attivi la verifica a due fattori, obbligatoria per tutto lo staff.
                </Footnote>
              </form>
            ) : (
              <TotpSetup
                totpUri={totpUri}
                email={invite?.email ?? ''}
                complete={async (code) =>
                  (
                    await api<{ recoveryCodes: string[] }>('/api/invites/complete', {
                      method: 'POST',
                      body: { code },
                    })
                  ).recoveryCodes
                }
                finishLabel="Attiva account ed entra"
                onFinish={() => navigate({ to: '/' })}
              />
            )}
          </div>
        </Shell>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------

/** La card centrata: due colonne nel flusso normale, una sola per gli esiti. */
function Shell({ single = false, children }: { single?: boolean; children: ReactNode }) {
  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        maxWidth: single ? 520 : 940,
        display: 'grid',
        gridTemplateColumns: single ? '1fr' : 'repeat(auto-fit, minmax(360px, 1fr))',
        border: '1px solid var(--bd-subtle)',
        borderRadius: 'var(--r-lg)',
        background: 'var(--s-surface)',
        boxShadow: 'var(--e3)',
        overflow: 'hidden',
        ...(single ? { padding: 40 } : {}),
      }}
    >
      {children}
    </div>
  );
}

function Title({ children }: { children: ReactNode }) {
  return (
    <h1
      style={{
        fontFamily: 'var(--font-display)',
        fontSize: 24,
        lineHeight: '32px',
        fontWeight: 700,
        letterSpacing: '-.01em',
        margin: '0 0 8px',
      }}
    >
      {children}
    </h1>
  );
}

/**
 * L'indicatore dei due passi.
 *
 * Colori e simboli sono quelli del disegno: il passo fatto diventa un segno
 * di spunta verde, quello corrente e' arancione, quello che deve ancora
 * venire resta spento. Serve a dire quanto manca — due passi, non tre — prima
 * che qualcuno si chieda quanto durera'.
 */
function StepBar({ step }: { step: 1 | 2 }) {
  const dot = (background: string, color: string, mark: string) => (
    <span
      style={{
        width: 20,
        height: 20,
        borderRadius: '50%',
        background,
        color,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 11,
        flex: 'none',
      }}
    >
      {mark}
    </span>
  );

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 22 }}>
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          fontSize: 12,
          fontWeight: 600,
          color: step === 1 ? 'var(--tx-primary)' : 'var(--tx-muted)',
        }}
      >
        {dot(step > 1 ? 'var(--ok)' : 'var(--ac)', 'var(--on-ac)', step > 1 ? '✓' : '1')}
        Password
      </span>
      <span style={{ flex: 1, height: 1, background: 'var(--bd-subtle)' }} />
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          fontSize: 12,
          fontWeight: 600,
          color: step === 2 ? 'var(--tx-primary)' : 'var(--tx-muted)',
        }}
      >
        {dot(
          step === 2 ? 'var(--ac)' : 'var(--s-elevated)',
          step === 2 ? 'var(--on-ac)' : 'var(--tx-muted)',
          '2',
        )}
        Verifica a due fattori
      </span>
    </div>
  );
}

/** La riga sotto il pulsante, centrata e smorzata. */
function Footnote({ children }: { children: ReactNode }) {
  return (
    <p
      style={{
        margin: '14px 0 0',
        fontSize: 11.5,
        lineHeight: '18px',
        color: 'var(--tx-muted)',
        textAlign: 'center',
      }}
    >
      {children}
    </p>
  );
}
