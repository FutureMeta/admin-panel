// Accettazione invito: password, enrollment TOTP, recovery code.
//
// La pagina si apre DOPO il redirect a URL pulito (§8.1.7): qui il token non
// c'e' piu', c'e' un cookie di onboarding. Se manca, l'invito non e'
// spendibile — e la pagina non dice se era scaduto, consumato o inventato
// (SEC-32).
//
// I recovery code si mostrano UNA SOLA VOLTA. La schermata lo dice prima di
// mostrarli e non lascia proseguire finche' non si conferma di averli salvati.
//
// Impaginazione del prototipo: campo di esagoni a piena pagina sotto, card
// centrata da 940px divisa in due — a sinistra cosa stai per ricevere, a
// destra cosa devi fare.

import { useNavigate } from '@tanstack/react-router';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { HexField } from '../components/hex-field.tsx';
import { Button, Field, Notice } from '../components/ui.tsx';
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
type Step = 'caricamento' | 'scaduto' | 'password' | 'totp' | 'codici';

const LEVEL_LABEL = ['Nessuno', 'Lettura', 'Scrittura', 'Gestione'] as const;
const LEVEL_TONE = [
  { color: 'var(--tx-muted)', soft: 'var(--s-inset)' },
  { color: 'var(--info)', soft: 'var(--info-soft)' },
  { color: 'var(--ok)', soft: 'var(--ok-soft)' },
  { color: 'var(--ac-text)', soft: 'var(--ac-soft)' },
] as const;

export function AcceptPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('caricamento');
  const [invite, setInvite] = useState<Onboarding | undefined>();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [totpUri, setTotpUri] = useState<string | undefined>();
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Onboarding>('/api/invites/onboarding')
      .then((data) => {
        setInvite(data);
        setStep('password');
      })
      .catch(() => setStep('scaduto'));
  }, []);

  async function submitPassword(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError('Le due password non coincidono.');
      return;
    }
    setError(undefined);
    setBusy(true);
    try {
      const res = await api<{ totpURI: string | null }>('/api/invites/accept', {
        method: 'POST',
        body: { password },
      });
      setTotpUri(res.totpURI ?? undefined);
      setStep('totp');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PASSWORD_COMPROMISED') {
        setError('Questa password compare in una violazione nota. Scegline un’altra.');
      } else if (err instanceof ApiError && err.code === 'HIBP_UNAVAILABLE') {
        // Fail-closed dichiarato: si spiega perche' non si prosegue, invece di
        // accettare una password non verificata (§8.6).
        setError(
          'Non riusciamo a verificare che la password non sia compromessa. ' +
            'Per sicurezza non proseguiamo: riprova fra qualche minuto.',
        );
      } else {
        setError('Non è stato possibile completare l’accettazione.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function submitTotp(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    setBusy(true);
    try {
      const res = await api<{ recoveryCodes: string[] }>('/api/invites/complete', {
        method: 'POST',
        body: { code: code.trim() },
      });
      setCodes(res.recoveryCodes);
      setStep('codici');
    } catch {
      setError('Codice non valido. Controlla che l’orario del telefono sia sincronizzato.');
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  const secret = totpUri ? new URLSearchParams(totpUri.split('?')[1] ?? '').get('secret') : null;
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

      {step === 'caricamento' ? (
        <p className="t-lead" style={{ position: 'relative', color: 'var(--tx-muted)', margin: 0 }}>
          Verifica dell'invito…
        </p>
      ) : step === 'scaduto' ? (
        <Shell single>
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
            Invito non più valido
          </h1>
          {/* SEC-32 — scaduto, già usato, revocato o mai esistito: stessa frase. */}
          <p style={{ margin: '0 0 24px', fontSize: 13.5, lineHeight: '21px', color: 'var(--tx-secondary)' }}>
            Il link non è utilizzabile. Chiedi a chi ti ha invitato di emetterne uno nuovo.
          </p>
          <Button variant="secondary" onClick={() => navigate({ to: '/login' })}>
            Vai al login
          </Button>
        </Shell>
      ) : step === 'codici' ? (
        <Shell single>
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
            Salva i codici di recupero
          </h1>
          <p style={{ margin: '0 0 20px', fontSize: 13.5, lineHeight: '21px', color: 'var(--tx-secondary)' }}>
            Sono l'unico modo di rientrare se perdi il telefono. Vengono mostrati{' '}
            <strong style={{ color: 'var(--tx-primary)' }}>ora e mai più</strong>: senza, l'unica via è una
            procedura che richiede due owner e ventiquattro ore.
          </p>

          <div
            className="mono"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: '6px 20px',
              background: 'var(--s-inset)',
              border: '1px solid var(--bd-subtle)',
              borderRadius: 'var(--r-sm)',
              padding: 18,
              marginBottom: 18,
              fontSize: 13,
              color: 'var(--tx-primary)',
            }}
          >
            {codes.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>

          <label
            style={{
              display: 'flex',
              gap: 10,
              alignItems: 'flex-start',
              marginBottom: 20,
              fontSize: 12.5,
              lineHeight: '19px',
              color: 'var(--tx-secondary)',
            }}
          >
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            Li ho salvati in un posto sicuro, fuori da questo browser.
          </label>

          <Button variant="primary" size="lg" disabled={!saved} onClick={() => navigate({ to: '/' })} block>
            Entra nel pannello
          </Button>
        </Shell>
      ) : (
        <Shell>
          {/* Colonna sinistra: cosa stai per ricevere. */}
          <div style={{ padding: 40, borderRight: '1px solid var(--bd-subtle)' }}>
            <Logo />
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
              Ciao,
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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

          {/* Colonna destra: cosa devi fare. */}
          <div style={{ padding: 40 }}>
            <h2
              style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600, margin: '0 0 20px' }}
            >
              {step === 'password' ? 'Attiva il tuo accesso' : 'Attiva la verifica in due passaggi'}
            </h2>

            {error ? (
              <div style={{ marginBottom: 18 }}>
                <Notice tone="err" title={error} />
              </div>
            ) : null}

            {step === 'password' ? (
              <form onSubmit={submitPassword} style={{ display: 'grid', gap: 18 }}>
                <div className="field">
                  <label className="label" htmlFor="accept-email">
                    Email
                  </label>
                  {/* L'indirizzo viene dalla riga invito e non è modificabile:
                      il campo lo mostra, non lo raccoglie (§8.1.9). */}
                  <input id="accept-email" className="input" value={invite?.email ?? ''} disabled />
                </div>

                <div className="field">
                  <label className="label" htmlFor="accept-name">
                    Nome account
                  </label>
                  {/* Anche il nome viene dalla riga invito: lo ha scelto chi ti
                      ha invitato, e comparirà nel registro accanto a ogni tua
                      azione. Qui si mostra, non si raccoglie. */}
                  <input id="accept-name" className="input" value={invite?.name ?? ''} disabled />
                </div>
                <Field
                  label="Nuova password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={12}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  hint="Almeno 12 caratteri. Nessuna regola di composizione: la lunghezza conta più dei simboli."
                />
                <Field
                  label="Conferma password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={12}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
                <Button type="submit" variant="primary" size="lg" loading={busy} block>
                  Continua
                </Button>
              </form>
            ) : (
              <>
                <div
                  style={{
                    padding: 16,
                    border: '1px solid var(--bd-subtle)',
                    borderRadius: 'var(--r-md)',
                    background: 'var(--s-elevated)',
                    marginBottom: 24,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      marginBottom: 14,
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 600 }}>Autenticazione a due fattori</div>
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        padding: '3px 8px',
                        borderRadius: 'var(--r-full)',
                        background: 'var(--err-soft)',
                        color: 'var(--err)',
                      }}
                    >
                      Obbligatoria
                    </span>
                  </div>
                  <div style={{ fontSize: 12, lineHeight: '19px', color: 'var(--tx-secondary)' }}>
                    Aggiungi un account nella tua app di autenticazione (Aegis, 1Password, Bitwarden…)
                    inserendo a mano la chiave qui sotto, poi digita il primo codice.
                  </div>
                  {secret ? (
                    <div
                      className="mono"
                      style={{
                        fontSize: 11.5,
                        color: 'var(--tx-primary)',
                        marginTop: 10,
                        wordBreak: 'break-all',
                      }}
                    >
                      {secret}
                    </div>
                  ) : null}
                </div>

                <form onSubmit={submitTotp} style={{ display: 'grid', gap: 16 }}>
                  <Field
                    label="Codice a sei cifre"
                    className="input input-mono"
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    required
                    autoFocus
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  />
                  <Button
                    type="submit"
                    variant="primary"
                    size="lg"
                    loading={busy}
                    disabled={code.length !== 6}
                    block
                  >
                    Attiva account ed entra
                  </Button>
                </form>
              </>
            )}

            <p
              style={{
                margin: '14px 0 0',
                fontSize: 11.5,
                lineHeight: '18px',
                color: 'var(--tx-muted)',
                textAlign: 'center',
              }}
            >
              Attivando l'account accetti il regolamento interno dello staff.
            </p>
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

function Logo() {
  return (
    <img
      src="/assets/logo.png"
      alt="MetaMC"
      width={34}
      height={34}
      style={{ objectFit: 'contain', marginBottom: 22, display: 'block' }}
    />
  );
}
