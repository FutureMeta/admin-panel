// Login. Composizione a due pannelli, con il lato brand costruito sul motivo
// esagonale del logo.
//
// Due passi: password, poi 2FA a sei cifre. Nessun link di registrazione —
// l'accesso e' solo su invito, e al suo posto c'e' una riga che spiega come
// chiederlo.
//
// SEC-20 — dopo il login si va a `/`, sempre. Nessun parametro di ritorno
// viene letto dalla URL.

import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { Banner, Button, Field } from '../components/ui.tsx';
import { ApiError, api } from '../lib/api.ts';

type Step = 'credenziali' | 'totp' | 'recovery';

export function LoginPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('credenziali');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  function describe(err: unknown): string {
    if (err instanceof ApiError) {
      if (err.isRateLimited) return 'Troppi tentativi. Riprova fra qualche minuto.';
      if (err.isOverloaded) return 'Il server è sotto carico. Riprova fra un istante.';
      // Credenziali sbagliate e account inesistente danno lo stesso messaggio:
      // distinguerli direbbe quali email sono registrate (SEC-30).
      if (err.status === 401 || err.status === 400) return 'Credenziali non valide.';
      if (err.isForbidden) return 'Accesso non consentito da questa origine.';
    }
    return 'Qualcosa non ha funzionato. Riprova.';
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
      // challenge. E' il comportamento voluto — la password da sola non apre
      // nulla.
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
          ? 'Troppi tentativi. Il blocco cresce a ogni errore: aspetta prima di riprovare.'
          : 'Codice non valido.',
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
      const res = await api<{ remaining: number }>('/api/auth/recovery-code', {
        method: 'POST',
        body: { code: recoveryCode.trim() },
      });
      if (res.remaining < 3) {
        // Non blocca: l'avviso arriva anche per email, ma vederlo subito
        // aumenta la probabilita' che qualcuno li rigeneri davvero.
        window.sessionStorage.setItem('recoveryCodesLow', String(res.remaining));
      }
      await navigate({ to: '/' });
    } catch {
      setError('Codice di recupero non valido o già speso.');
      setRecoveryCode('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ display: 'flex', minHeight: '100vh' }}>
      {/* Lato brand: motivo esagonale, nessun testo di marketing. */}
      <aside
        className="hex-panel"
        style={{
          flex: '1 1 46%',
          display: 'none',
          padding: 'var(--sp16)',
          flexDirection: 'column',
          justifyContent: 'space-between',
        }}
        data-brand-panel
      >
        <div style={{ position: 'relative' }}>
          <p className="t-display" style={{ margin: 0 }}>
            <span style={{ color: 'var(--ac)' }}>Meta</span>
            <span style={{ color: 'var(--blu-viz)' }}>MC</span>
          </p>
          <p className="t-h3" style={{ margin: 'var(--sp2) 0 0', color: 'var(--tx-secondary)' }}>
            Pannello di amministrazione
          </p>
        </div>
        <p className="t-sm" style={{ position: 'relative', color: 'var(--tx-muted)', maxWidth: 380 }}>
          Strumento interno. Ogni azione finisce nel registro attività, con chi l'ha fatta, quando e da quale
          indirizzo.
        </p>
      </aside>

      <section
        style={{
          flex: '1 1 54%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 'var(--sp8)',
        }}
      >
        <div style={{ width: 'min(400px, 100%)' }}>
          <h1 className="t-h1" style={{ margin: '0 0 var(--sp2)' }}>
            {step === 'credenziali'
              ? 'Accedi'
              : step === 'totp'
                ? 'Verifica in due passaggi'
                : 'Codice di recupero'}
          </h1>
          <p className="t-sm" style={{ margin: '0 0 var(--sp6)', color: 'var(--tx-muted)' }}>
            {step === 'credenziali'
              ? "L'accesso è riservato allo staff e avviene solo su invito."
              : step === 'totp'
                ? 'Inserisci il codice a sei cifre della tua app di autenticazione.'
                : 'Usa uno dei codici che hai salvato durante la configurazione.'}
          </p>

          {error ? (
            <div style={{ marginBottom: 'var(--sp5)' }}>
              <Banner tone="err" title={error} />
            </div>
          ) : null}

          {step === 'credenziali' ? (
            <form onSubmit={submitCredentials} style={{ display: 'grid', gap: 'var(--sp4)' }}>
              <Field
                label="Email"
                type="email"
                name="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <Field
                label="Password"
                type="password"
                name="password"
                autoComplete="current-password"
                required
                minLength={12}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <Button type="submit" variant="primary" size="lg" loading={busy}>
                Continua
              </Button>
              <a
                href="/password-dimenticata"
                className="t-sm"
                style={{ color: 'var(--tx-muted)', textAlign: 'center' }}
              >
                Password dimenticata
              </a>
            </form>
          ) : step === 'totp' ? (
            <form onSubmit={submitTotp} style={{ display: 'grid', gap: 'var(--sp4)' }}>
              <Field
                label="Codice a sei cifre"
                className="input-otp"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
              <Button type="submit" variant="primary" size="lg" loading={busy} disabled={code.length !== 6}>
                Entra
              </Button>
              <Button type="button" variant="ghost" onClick={() => setStep('recovery')}>
                Non ho accesso all'app
              </Button>
            </form>
          ) : (
            <form onSubmit={submitRecovery} style={{ display: 'grid', gap: 'var(--sp4)' }}>
              <Field
                label="Codice di recupero"
                hint="26 caratteri, i trattini sono facoltativi."
                className="mono"
                required
                autoFocus
                value={recoveryCode}
                onChange={(e) => setRecoveryCode(e.target.value.toUpperCase())}
              />
              <Button type="submit" variant="primary" size="lg" loading={busy}>
                Entra
              </Button>
              <Button type="button" variant="ghost" onClick={() => setStep('totp')}>
                Torna al codice dell'app
              </Button>
            </form>
          )}

          <p
            className="t-sm"
            style={{
              margin: 'var(--sp8) 0 0',
              paddingTop: 'var(--sp5)',
              borderTop: '1px solid var(--bd-subtle)',
              color: 'var(--tx-muted)',
            }}
          >
            Non hai un accesso? Il pannello non ha registrazione: chiedi a un owner di invitarti.
          </p>
        </div>
      </section>
    </main>
  );
}
