// Reset password. §8.7 — impaginazione di frontend/9-reset-password.dc.html
//
// Cinque stati, due componenti: la richiesta e la conferma d'invio stanno in
// `ForgotPasswordPage`, la scelta della nuova password, il link scaduto e la
// conclusione in `ResetPasswordPage`.
//
// Il principio che regge la prima metà: la risposta è IDENTICA per un'email
// registrata e per una che non esiste. Non c'è un «ti abbiamo mandato il link»
// e un «questo indirizzo non risulta» — c'è una frase sola, e la schermata lo
// dice apertamente invece di lasciarlo intuire.
//
// Al completamento NON viene emessa alcuna sessione: si torna al login e si
// supera comunque il TOTP. Il reset della password non sostituisce il secondo
// fattore, ed è scritto in fondo a ogni stato perché nessuno lo scopra dopo.

import { Link, useNavigate } from '@tanstack/react-router';
import { type FormEvent, useEffect, useState } from 'react';
import { AuthFootnote, AuthHeading, AuthIcon, AuthShell } from '../components/auth-shell.tsx';
import { Button, Field, Notice } from '../components/ui.tsx';
import { ApiError, api } from '../lib/api.ts';

const HEADLINE = ['Recupera', "l'accesso."];
const DESCRIPTION =
  'Il link di reset vale 30 minuti e può essere usato una volta sola. La 2FA resta attiva: dopo il reset serve comunque il codice a 6 cifre.';

const FOOTNOTE = (
  <>
    Il reset non modifica la 2FA. Se hai perso anche l'app di autenticazione, serve un owner: solo lui può
    azzerare il secondo fattore dal modulo Utenti &amp; Ruoli.
  </>
);

function BackToLogin() {
  return (
    <Link
      to="/login"
      style={{
        display: 'block',
        marginTop: 16,
        textAlign: 'center',
        fontSize: 12,
        color: 'var(--tx-secondary)',
      }}
    >
      ← Torna all'accesso
    </Link>
  );
}

// ---------------------------------------------------------------------------

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // Il disegno mostra un conto alla rovescia sul reinvio. Non è cosmetico: è
  // il limite di frequenza reso visibile, così chi aspetta sa quanto.
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  async function send() {
    setBusy(true);
    setError(undefined);
    try {
      await api('/api/account/forgot-password', { method: 'POST', body: { email: email.trim() } });
      setSent(true);
      // Lo stesso valore del limite di frequenza lato server: un contatore che
      // finisce prima di quello vero inviterebbe a riprovare per prendere 429.
      setCooldown(180);
    } catch (err) {
      setError(
        err instanceof ApiError && err.isRateLimited
          ? 'Troppe richieste. Riprova fra qualche minuto.'
          : 'Qualcosa non ha funzionato. Riprova.',
      );
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void send();
  }

  const mmss = `${String(Math.floor(cooldown / 60)).padStart(2, '0')}:${String(cooldown % 60).padStart(2, '0')}`;

  return (
    <AuthShell headline={HEADLINE} description={DESCRIPTION}>
      {sent ? (
        <>
          <AuthIcon
            tone="ac"
            path={
              <>
                <rect x="3" y="5" width="18" height="14" rx="2" />
                <path d="m3 7 9 6 9-6" />
              </>
            }
          />
          <AuthHeading title="Controlla la posta">
            Se{' '}
            <span className="mono" style={{ color: 'var(--tx-secondary)' }}>
              {email}
            </span>{' '}
            corrisponde a un account staff, il link è già in arrivo. Vale 30 minuti.
          </AuthHeading>

          <Button block size="lg" disabled={cooldown > 0 || busy} loading={busy} onClick={() => void send()}>
            {cooldown > 0 ? (
              <>
                Invia di nuovo tra <span className="mono">{mmss}</span>
              </>
            ) : (
              'Invia di nuovo'
            )}
          </Button>
          <BackToLogin />
        </>
      ) : (
        <>
          <AuthHeading title="Reimposta la password">
            Inserisci l'email del tuo account staff. Se esiste, ricevi un link per impostare una nuova
            password.
          </AuthHeading>

          {error ? (
            <div style={{ marginBottom: 20 }}>
              <Notice tone="err" title={error} />
            </div>
          ) : null}

          <form onSubmit={submit}>
            <div style={{ marginBottom: 22 }}>
              <Field
                label="Email"
                type="email"
                required
                placeholder="nome@metamc.it"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <Button type="submit" variant="primary" size="lg" block loading={busy}>
              Invia il link di reset
            </Button>
          </form>
          <BackToLogin />
        </>
      )}

      <AuthFootnote>{FOOTNOTE}</AuthFootnote>
    </AuthShell>
  );
}

// ---------------------------------------------------------------------------

/** Le quattro barre di robustezza. Misurano la lunghezza, e la riga sotto lo dice. */
function StrengthMeter({ password }: { password: string }) {
  const filled = [12, 16, 20, 24].filter((n) => password.length >= n).length;
  const label = ['Troppo corta', 'Sufficiente', 'Buona', 'Ottima', 'Ottima'][filled] ?? '';
  const color = filled === 0 ? 'var(--err)' : filled === 1 ? 'var(--warn)' : 'var(--ok)';
  return (
    <>
      <div style={{ display: 'flex', gap: 5, margin: '10px 0 8px' }}>
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            style={{
              flex: 1,
              height: 4,
              borderRadius: 2,
              background: i < filled ? color : 'var(--bd-subtle)',
            }}
          />
        ))}
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 11.5,
          color: 'var(--tx-muted)',
          marginBottom: 20,
        }}
      >
        <span>Robustezza · conta la lunghezza</span>
        <span style={{ color, fontWeight: 600 }}>{label}</span>
      </div>
    </>
  );
}

/** L'elenco dei requisiti. Sono i controlli VERI, non consigli generici. */
function Rules({ password, confirm }: { password: string; confirm: string }) {
  const rules = [
    { ok: password.length >= 12, label: 'Almeno 12 caratteri' },
    { ok: password.length > 0 && password === confirm, label: 'Le due password coincidono' },
    { ok: null, label: 'Non compare in una violazione nota — verificato al salvataggio' },
  ];
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: 14,
        border: '1px solid var(--bd-subtle)',
        borderRadius: 'var(--r-sm)',
        background: 'var(--s-inset)',
        marginBottom: 22,
      }}
    >
      {rules.map((r) => (
        <div
          key={r.label}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            fontSize: 12,
            color: r.ok === true ? 'var(--tx-primary)' : 'var(--tx-secondary)',
          }}
        >
          <span
            style={{
              width: 15,
              height: 15,
              borderRadius: '50%',
              background: r.ok === true ? 'var(--ok-soft)' : 'var(--s-elevated)',
              color: r.ok === true ? 'var(--ok)' : 'var(--tx-muted)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 10,
              fontWeight: 700,
              flex: 'none',
            }}
          >
            {r.ok === true ? '✓' : r.ok === null ? '·' : ''}
          </span>
          {r.label}
        </div>
      ))}
    </div>
  );
}

export function ResetPasswordPage() {
  const navigate = useNavigate();
  const [token, setToken] = useState<string | undefined>();
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [doneAt, setDoneAt] = useState<Date | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  // SEC-21 — il token si legge dalla URL e la URL si ripulisce SUBITO con un
  // replaceState: senza, resta nella cronologia e nel Referer della prima
  // risorsa esterna che la pagina dovesse caricare.
  useEffect(() => {
    const found = new URLSearchParams(window.location.search).get('t');
    if (found) {
      setToken(found);
      window.history.replaceState(null, '', '/reset');
    }
    setReady(true);
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError('Le due password non coincidono.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await api('/api/account/reset-password', { method: 'POST', body: { token, password } });
      setDoneAt(new Date());
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
  }

  const when = doneAt
    ? new Intl.DateTimeFormat('it-IT', {
        dateStyle: 'short',
        timeStyle: 'short',
        timeZone: 'Europe/Rome',
      }).format(doneAt)
    : '';

  return (
    <AuthShell headline={HEADLINE} description={DESCRIPTION}>
      {doneAt ? (
        <>
          <AuthIcon tone="ok" path={<path d="m5 13 4 4 10-10" />} />
          <AuthHeading title="Password aggiornata">
            La nuova password è attiva dal{' '}
            <span className="mono" style={{ color: 'var(--tx-secondary)' }}>
              {when}
            </span>
            . Le altre sessioni sono state terminate.
          </AuthHeading>
          <Button variant="primary" size="lg" block onClick={() => void navigate({ to: '/login' })}>
            Vai alla console
          </Button>
        </>
      ) : ready && !token ? (
        <>
          <AuthIcon
            tone="warn"
            path={
              <>
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" />
              </>
            }
          />
          {/* SEC-32 — scaduto, già usato o mai esistito danno la stessa
              schermata: distinguerli direbbe se quel token è esistito. */}
          <AuthHeading title="Link non valido">
            Questo link è scaduto, è già stato usato oppure non è mai esistito. I link di reset valgono 30
            minuti: richiedine uno nuovo.
          </AuthHeading>
          <div
            style={{
              display: 'flex',
              gap: 10,
              padding: '12px 14px',
              border: '1px solid rgba(224,163,46,.35)',
              background: 'var(--warn-soft)',
              borderRadius: 'var(--r-sm)',
              marginBottom: 22,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: 'var(--warn)',
                marginTop: 7,
                flex: 'none',
              }}
            />
            <div style={{ fontSize: 12, lineHeight: '18px', color: 'var(--tx-secondary)' }}>
              Se non hai richiesto tu il reset, avvisa un owner: il tentativo è registrato nel registro
              attività.
            </div>
          </div>
          <Button
            variant="primary"
            size="lg"
            block
            onClick={() => void navigate({ to: '/password-dimenticata' })}
          >
            Richiedi un nuovo link
          </Button>
          <BackToLogin />
        </>
      ) : (
        <>
          <AuthHeading title="Scegli una nuova password">
            Il link è valido. Dopo il salvataggio dovrai accedere di nuovo, secondo fattore compreso.
          </AuthHeading>

          {error ? (
            <div style={{ marginBottom: 20 }}>
              <Notice tone="err" title={error} />
            </div>
          ) : null}

          <form onSubmit={submit}>
            <Field
              label="Nuova password"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              className="input-mono"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <StrengthMeter password={password} />

            <div style={{ marginBottom: 18 }}>
              <Field
                label="Ripeti la password"
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                className="input-mono"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>

            <Rules password={password} confirm={confirm} />

            <Button type="submit" variant="primary" size="lg" block loading={busy}>
              Salva e accedi
            </Button>
          </form>
          <div
            style={{
              marginTop: 14,
              fontSize: 11.5,
              lineHeight: '18px',
              color: 'var(--tx-muted)',
              textAlign: 'center',
            }}
          >
            Tutte le altre sessioni verranno terminate.
          </div>
        </>
      )}

      <AuthFootnote>{FOOTNOTE}</AuthFootnote>
    </AuthShell>
  );
}
