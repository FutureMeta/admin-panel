// Accettazione invito: password, enrollment TOTP, recovery code.
//
// La pagina si apre DOPO il redirect a URL pulito (§8.1.7): qui il token non
// c'e' piu', c'e' un cookie di onboarding. Se manca, l'invito non e'
// spendibile — e la pagina non dice se era scaduto, consumato o inventato
// (SEC-32).
//
// I recovery code si mostrano UNA SOLA VOLTA. La schermata lo dice prima di
// mostrarli e non lascia proseguire finche' non si conferma di averli salvati.

import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Badge, Banner, Button, Field } from '../components/ui.tsx';
import { ApiError, api } from '../lib/api.ts';

type Onboarding = { email: string; roleName: string | null };
type Step = 'caricamento' | 'scaduto' | 'password' | 'totp' | 'codici';

export function AcceptPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('caricamento');
  const [invite, setInvite] = useState<Onboarding | undefined>();
  const [name, setName] = useState('');
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

  async function submitPassword(e: React.FormEvent) {
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
        body: { password, name: name.trim() },
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

  async function submitTotp(e: React.FormEvent) {
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
      <div className="surface" style={{ width: 'min(560px, 100%)', padding: 'var(--sp8)' }}>
        {step === 'caricamento' ? (
          <p className="t-sm" style={{ color: 'var(--tx-muted)', margin: 0 }}>
            Verifica dell'invito…
          </p>
        ) : step === 'scaduto' ? (
          <>
            <h1 className="t-h1" style={{ margin: '0 0 var(--sp3)' }}>
              Invito non più valido
            </h1>
            <p className="t-body" style={{ color: 'var(--tx-secondary)', margin: '0 0 var(--sp6)' }}>
              Il link non è utilizzabile. Può essere scaduto, già usato o revocato: chiedi a chi ti ha
              invitato di emetterne uno nuovo.
            </p>
            <Button variant="secondary" onClick={() => navigate({ to: '/login' })}>
              Vai al login
            </Button>
          </>
        ) : step === 'password' ? (
          <>
            <header style={{ marginBottom: 'var(--sp6)' }}>
              <h1 className="t-h1" style={{ margin: '0 0 var(--sp2)' }}>
                Benvenuto in MetaMC Admin
              </h1>
              <p className="t-sm" style={{ margin: 0, color: 'var(--tx-muted)' }}>
                {invite?.email}
              </p>
              {invite?.roleName ? (
                <div style={{ marginTop: 'var(--sp3)' }}>
                  <Badge tone="ac">{invite.roleName}</Badge>
                </div>
              ) : null}
            </header>

            {error ? (
              <div style={{ marginBottom: 'var(--sp5)' }}>
                <Banner tone="err" title={error} />
              </div>
            ) : null}

            <form onSubmit={submitPassword} style={{ display: 'grid', gap: 'var(--sp4)' }}>
              <Field
                label="Come ti chiami"
                required
                maxLength={120}
                value={name}
                onChange={(e) => setName(e.target.value)}
                hint="Comparirà nel registro attività accanto a ogni tua azione."
              />
              <Field
                label="Password"
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                hint="Almeno 12 caratteri. Nessuna regola di composizione: la lunghezza conta più dei simboli."
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
                Continua
              </Button>
            </form>
          </>
        ) : step === 'totp' ? (
          <>
            <h1 className="t-h1" style={{ margin: '0 0 var(--sp2)' }}>
              Attiva la verifica in due passaggi
            </h1>
            <p className="t-sm" style={{ margin: '0 0 var(--sp6)', color: 'var(--tx-muted)' }}>
              È obbligatoria: senza, l'accesso al pannello non si apre.
            </p>

            {error ? (
              <div style={{ marginBottom: 'var(--sp5)' }}>
                <Banner tone="err" title={error} />
              </div>
            ) : null}

            <ol className="t-body" style={{ margin: '0 0 var(--sp5)', paddingLeft: 'var(--sp5)' }}>
              <li>Apri la tua app di autenticazione (Aegis, 1Password, Bitwarden…).</li>
              <li>Aggiungi un account inserendo a mano la chiave qui sotto.</li>
              <li>Digita il codice a sei cifre che l'app mostra.</li>
            </ol>

            {secret ? (
              <div
                className="mono"
                style={{
                  background: 'var(--s-inset)',
                  border: '1px solid var(--bd-subtle)',
                  borderRadius: 'var(--r-md)',
                  padding: 'var(--sp4)',
                  wordBreak: 'break-all',
                  marginBottom: 'var(--sp5)',
                  color: 'var(--tx-primary)',
                }}
              >
                {secret}
              </div>
            ) : null}

            <form onSubmit={submitTotp} style={{ display: 'grid', gap: 'var(--sp4)' }}>
              <Field
                label="Codice a sei cifre"
                className="input-otp"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
              <Button type="submit" variant="primary" size="lg" loading={busy} disabled={code.length !== 6}>
                Attiva e completa
              </Button>
            </form>
          </>
        ) : (
          <>
            <h1 className="t-h1" style={{ margin: '0 0 var(--sp2)' }}>
              Salva i codici di recupero
            </h1>
            <p className="t-body" style={{ margin: '0 0 var(--sp5)', color: 'var(--tx-secondary)' }}>
              Sono l'unico modo di rientrare se perdi il telefono. Vengono mostrati{' '}
              <strong>ora e mai più</strong>: senza, l'unica via è una procedura che richiede due owner e
              ventiquattro ore.
            </p>

            <div
              className="mono"
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(2, 1fr)',
                gap: 'var(--sp2) var(--sp4)',
                background: 'var(--s-inset)',
                border: '1px solid var(--bd-subtle)',
                borderRadius: 'var(--r-md)',
                padding: 'var(--sp5)',
                marginBottom: 'var(--sp5)',
                fontSize: 13,
                color: 'var(--tx-primary)',
              }}
            >
              {codes.map((c) => (
                <span key={c}>{c}</span>
              ))}
            </div>

            <label
              className="t-sm"
              style={{
                display: 'flex',
                gap: 'var(--sp3)',
                alignItems: 'flex-start',
                marginBottom: 'var(--sp5)',
              }}
            >
              <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
              Li ho salvati in un posto sicuro, fuori da questo browser.
            </label>

            <Button
              variant="primary"
              size="lg"
              disabled={!saved}
              onClick={() => navigate({ to: '/' })}
              style={{ width: '100%' }}
            >
              Entra nel pannello
            </Button>
          </>
        )}
      </div>
    </main>
  );
}
