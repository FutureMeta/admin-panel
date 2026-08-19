// Login. A PIENA PAGINA, due pannelli.
//
// Nel prototipo questa schermata è dentro un riquadro con bordo e ombra, ma
// quello è il telaio della vetrina — sopra ha l'intestazione "02 — Accesso" e
// i bottoni per cambiare stato. La schermata vera occupa tutto il viewport:
// niente cornice, niente raggio, niente `max-width` sul contenitore.
//
// SEC-20 — dopo il login si va a `/`, sempre. Nessun parametro di ritorno
// viene letto dalla URL.

import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { AuthFootnote, AuthShell } from '../components/auth-shell.tsx';
import { Button, Field, Notice } from '../components/ui.tsx';
import { ApiError, api } from '../lib/api.ts';

type Step = 'credenziali' | 'totp' | 'recovery';

/** Le sei celle del codice: il prototipo le tiene separate, non un campo unico. */
function OtpCells({ value }: { value: string }) {
  return (
    <div className="otp-row" aria-hidden="true">
      {Array.from({ length: 6 }, (_, i) => `cell-${i}`).map((id, i) => (
        <div key={id} className="otp-cell" data-filled={value.length > i} data-active={value.length === i}>
          {value[i] ?? ''}
        </div>
      ))}
    </div>
  );
}

export function LoginPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('credenziali');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [error, setError] = useState<{ title: string; body?: string } | undefined>();
  const [busy, setBusy] = useState(false);

  function describe(err: unknown): { title: string; body?: string } {
    if (err instanceof ApiError) {
      if (err.isRateLimited) {
        return {
          title: 'Troppi tentativi',
          body: 'Riprova fra qualche minuto: il blocco cresce a ogni errore.',
        };
      }
      if (err.isOverloaded) return { title: 'Server sotto carico', body: 'Riprova fra un istante.' };
      if (err.status === 401 || err.status === 400) {
        // Credenziali sbagliate e account inesistente danno lo STESSO
        // messaggio: distinguerli direbbe quali email sono registrate (SEC-30).
        return { title: 'Credenziali non valide', body: 'Controlla email e password e riprova.' };
      }
      if (err.isForbidden) return { title: 'Accesso non consentito da questa origine' };
    }
    return { title: 'Qualcosa non ha funzionato', body: 'Riprova fra un momento.' };
  }

  async function submitCredentials(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    setBusy(true);
    try {
      const res = await api<{ twoFactorRedirect?: boolean; token?: string }>('/api/auth/sign-in/email', {
        method: 'POST',
        body: { email: email.trim(), password },
      });
      // Con il 2FA attivo il sign-in NON emette una sessione: emette una
      // challenge. È il comportamento voluto — la password da sola non apre nulla.
      if (res.twoFactorRedirect || !res.token) setStep('totp');
      else await navigate({ to: '/' });
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitTotp(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    setBusy(true);
    try {
      await api('/api/auth/two-factor/verify-totp', { method: 'POST', body: { code: code.trim() } });
      await navigate({ to: '/' });
    } catch (err) {
      setError(
        err instanceof ApiError && err.isRateLimited
          ? {
              title: 'Troppi tentativi',
              body: 'Il blocco raddoppia a ogni errore: aspetta prima di riprovare.',
            }
          : { title: 'Codice non valido', body: "Controlla che l'orario del telefono sia sincronizzato." },
      );
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  async function submitRecovery(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    setBusy(true);
    try {
      await api('/api/auth/recovery-code', { method: 'POST', body: { code: recoveryCode.trim() } });
      await navigate({ to: '/' });
    } catch {
      setError({
        title: 'Codice di recupero non valido',
        body: 'Può essere già stato speso: ognuno vale una volta sola.',
      });
      setRecoveryCode('');
    } finally {
      setBusy(false);
    }
  }

  const linkButton = {
    border: 'none',
    background: 'none',
    padding: 0,
    fontFamily: 'var(--font-ui)',
    fontSize: 12,
    cursor: 'pointer',
  } as const;

  return (
    <AuthShell>
      {step === 'totp' ? (
        <div
          className="pill pill-ac"
          style={{ marginBottom: 18, display: 'inline-flex', height: 24, gap: 8 }}
        >
          Passaggio 2 di 2
        </div>
      ) : null}

      <h1 className="t-title" style={{ marginBottom: 6 }}>
        {step === 'credenziali'
          ? 'Accedi alla console'
          : step === 'totp'
            ? 'Verifica in due passaggi'
            : 'Codice di recupero'}
      </h1>

      <p className="t-lead" style={{ margin: '0 0 28px' }}>
        {step === 'credenziali' ? (
          'Usa le credenziali associate al tuo invito.'
        ) : step === 'totp' ? (
          <>
            Inserisci il codice a 6 cifre generato dall'app di autenticazione per{' '}
            <span className="mono" style={{ color: 'var(--tx-secondary)' }}>
              {email || 'il tuo account'}
            </span>
            .
          </>
        ) : (
          'Usa uno dei codici salvati durante la configurazione. Ognuno vale una volta sola.'
        )}
      </p>

      {error ? (
        <div style={{ marginBottom: 20 }}>
          <Notice tone="err" title={error.title} {...(error.body ? { description: error.body } : {})} />
        </div>
      ) : null}

      {step === 'credenziali' ? (
        <form onSubmit={submitCredentials}>
          <div style={{ marginBottom: 18 }}>
            <Field
              label="Email"
              type="email"
              name="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div style={{ marginBottom: 24 }}>
            <Field
              label="Password"
              type="password"
              name="password"
              autoComplete="current-password"
              required
              minLength={12}
              className="input-mono"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aside={
                <Link to="/password-dimenticata" style={{ fontSize: 12 }}>
                  Password dimenticata?
                </Link>
              }
            />
          </div>
          <Button type="submit" variant="primary" size="lg" block loading={busy}>
            Continua
          </Button>
        </form>
      ) : step === 'totp' ? (
        <form onSubmit={submitTotp}>
          <div style={{ position: 'relative', marginBottom: 22 }}>
            <OtpCells value={code} />
            {/* Il campo vero copre le celle ed è trasparente: le sei
                    caselle sono la rappresentazione, non il controllo. Così
                    restano incolla-e-vai e leggibili dallo screen reader. */}
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              aria-label="Codice a sei cifre"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                opacity: 0,
                border: 0,
                background: 'transparent',
                cursor: 'text',
              }}
            />
          </div>
          <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={code.length !== 6}>
            Verifica e accedi
          </Button>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: 12,
              marginTop: 16,
              fontSize: 12,
              color: 'var(--tx-muted)',
            }}
          >
            <button
              type="button"
              style={{ ...linkButton, color: 'var(--tx-secondary)' }}
              onClick={() => {
                setStep('credenziali');
                setCode('');
                setError(undefined);
              }}
            >
              ← Torna indietro
            </button>
            <span>
              Codice non funzionante?{' '}
              <button
                type="button"
                style={{ ...linkButton, color: 'var(--ac-text)' }}
                onClick={() => {
                  setStep('recovery');
                  setError(undefined);
                }}
              >
                Usa un codice di recupero
              </button>
            </span>
          </div>
        </form>
      ) : (
        <form onSubmit={submitRecovery}>
          <div style={{ marginBottom: 24 }}>
            <Field
              label="Codice di recupero"
              hint="26 caratteri. I trattini sono facoltativi."
              className="input-mono"
              required
              value={recoveryCode}
              onChange={(e) => setRecoveryCode(e.target.value.toUpperCase())}
            />
          </div>
          <Button type="submit" variant="primary" size="lg" block loading={busy}>
            Entra
          </Button>
          <div style={{ marginTop: 16 }}>
            <button
              type="button"
              style={{ ...linkButton, color: 'var(--tx-secondary)' }}
              onClick={() => {
                setStep('totp');
                setError(undefined);
              }}
            >
              ← Torna al codice dell'app
            </button>
          </div>
        </form>
      )}

      <AuthFootnote>
        L'accesso alla console è riservato allo staff ed è possibile solo su invito. Se ti serve un accesso,
        chiedilo a un owner indicando ruolo e moduli necessari.
      </AuthFootnote>
    </AuthShell>
  );
}
