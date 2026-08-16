// Reset password. §8.7
//
// Due schermate, un principio: la risposta è IDENTICA per un'email registrata
// e per una che non esiste. Non c'è un "ti abbiamo mandato il link" e un
// "questo indirizzo non risulta": c'è una sola frase, sempre la stessa.
//
// Al completamento NON viene emessa alcuna sessione. Si torna al login e si
// supera comunque il TOTP: il reset della password non sostituisce il secondo
// fattore, e dirlo qui evita che qualcuno lo scopra e lo consideri un bug.

import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Notice as Banner, Button, Field } from '../components/ui.tsx';
import { ApiError, api } from '../lib/api.ts';

function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--sp8)',
      }}
    >
      <div style={{ width: 'min(400px, 100%)' }}>
        <h1 className="t-title" style={{ margin: '0 0 var(--sp6)' }}>
          {title}
        </h1>
        {children}
      </div>
    </main>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  if (sent) {
    return (
      <Frame title="Controlla la posta">
        <Banner
          tone="info"
          title="Se quell'indirizzo è registrato, il link è partito."
          description="Vale 30 minuti e funziona una volta sola. Non diciamo se l'indirizzo esiste: sarebbe un modo di scoprire chi ha accesso al pannello."
        />
        <div style={{ marginTop: 'var(--sp5)' }}>
          <Button variant="secondary" onClick={() => window.location.assign('/login')}>
            Torna al login
          </Button>
        </div>
      </Frame>
    );
  }

  return (
    <Frame title="Password dimenticata">
      <p className="t-lead" style={{ margin: '0 0 var(--sp5)', color: 'var(--tx-muted)' }}>
        Ti mandiamo un link per reimpostarla. Dopo dovrai comunque accedere con il tuo secondo fattore.
      </p>

      {error ? (
        <div style={{ marginBottom: 'var(--sp4)' }}>
          <Banner tone="err" title={error} />
        </div>
      ) : null}

      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(undefined);
          try {
            await api('/api/account/forgot-password', { method: 'POST', body: { email: email.trim() } });
            setSent(true);
          } catch (err) {
            setError(
              err instanceof ApiError && err.isRateLimited
                ? 'Troppe richieste. Riprova fra qualche minuto.'
                : 'Qualcosa non ha funzionato. Riprova.',
            );
          } finally {
            setBusy(false);
          }
        }}
        style={{ display: 'grid', gap: 'var(--sp4)' }}
      >
        <Field
          label="Email"
          type="email"
          required
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Button type="submit" variant="primary" size="lg" loading={busy}>
          Mandami il link
        </Button>
      </form>
    </Frame>
  );
}

// ---------------------------------------------------------------------------

export function ResetPasswordPage() {
  const navigate = useNavigate();
  const [token, setToken] = useState<string | undefined>();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  // SEC-21 — il token si legge dalla URL e la URL si ripulisce SUBITO, con un
  // replaceState: senza, resta nella cronologia e nel Referer della prima
  // risorsa esterna che la pagina dovesse caricare.
  useEffect(() => {
    const found = new URLSearchParams(window.location.search).get('t');
    if (found) {
      setToken(found);
      window.history.replaceState(null, '', '/reset');
    }
  }, []);

  if (done) {
    return (
      <Frame title="Password reimpostata">
        <Banner
          tone="info"
          title="Tutte le sessioni sono state chiuse."
          description="Accedi di nuovo. Ti verrà chiesto anche il codice a sei cifre: il reset della password non sostituisce il secondo fattore."
        />
        <div style={{ marginTop: 'var(--sp5)' }}>
          <Button variant="primary" onClick={() => void navigate({ to: '/login' })}>
            Vai al login
          </Button>
        </div>
      </Frame>
    );
  }

  if (!token) {
    return (
      <Frame title="Link non valido">
        <p className="t-lead" style={{ color: 'var(--tx-secondary)', margin: '0 0 var(--sp5)' }}>
          Il link è scaduto, è già stato usato, oppure non è mai esistito. Chiedine uno nuovo dal login.
        </p>
        <Button variant="secondary" onClick={() => void navigate({ to: '/login' })}>
          Torna al login
        </Button>
      </Frame>
    );
  }

  return (
    <Frame title="Scegli una nuova password">
      {error ? (
        <div style={{ marginBottom: 'var(--sp4)' }}>
          <Banner tone="err" title={error} />
        </div>
      ) : null}

      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (password !== confirm) {
            setError('Le due password non coincidono.');
            return;
          }
          setBusy(true);
          setError(undefined);
          try {
            await api('/api/account/reset-password', { method: 'POST', body: { token, password } });
            setDone(true);
          } catch (err) {
            if (err instanceof ApiError && err.code === 'PASSWORD_COMPROMISED') {
              setError('Questa password compare in una violazione nota. Scegline un’altra.');
            } else if (err instanceof ApiError && err.code === 'HIBP_UNAVAILABLE') {
              setError(
                'Non riusciamo a verificare che la password non sia compromessa. ' +
                  'Per sicurezza non proseguiamo: riprova fra qualche minuto.',
              );
            } else {
              setError('Il link non è più valido. Chiedine uno nuovo dal login.');
            }
          } finally {
            setBusy(false);
          }
        }}
        style={{ display: 'grid', gap: 'var(--sp4)' }}
      >
        <Field
          label="Nuova password"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          hint="Almeno 12 caratteri. Nessuna regola di composizione."
        />
        <Field
          label="Ripeti la password"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        <Button type="submit" variant="primary" size="lg" loading={busy}>
          Reimposta
        </Button>
      </form>
    </Frame>
  );
}
