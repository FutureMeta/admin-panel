// Stati di sistema: 401, 403, 404, manutenzione, feed disconnesso.
//
// Nessuno di questi dice più di quanto il server abbia detto. In particolare
// il 403 non elenca i moduli a cui NON si ha accesso: l'elenco stesso dei
// moduli è informazione (SEC-31 e la regola della sidebar sono la stessa cosa
// vista da due lati).

import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Notice as Banner, Button } from '../components/ui.tsx';

function SystemState({
  code,
  title,
  description,
  action,
}: {
  code: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
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
      <div style={{ maxWidth: 460, textAlign: 'center' }}>
        <p
          className="tabular"
          style={{
            margin: 0,
            color: 'var(--ac)',
            fontFamily: 'var(--font-display)',
            fontWeight: 700,
            fontSize: 56,
            lineHeight: '60px',
            letterSpacing: '-.02em',
          }}
        >
          {code}
        </p>
        <h1 className="t-title" style={{ margin: 'var(--sp4) 0 var(--sp3)' }}>
          {title}
        </h1>
        <p className="t-lead" style={{ margin: '0 0 var(--sp6)', color: 'var(--tx-secondary)' }}>
          {description}
        </p>
        {action}
      </div>
    </main>
  );
}

export function UnauthorizedPage() {
  return (
    <SystemState
      code="401"
      title="Sessione non valida"
      description="La sessione è scaduta, è stata chiusa da un'altra postazione, oppure il tuo accesso è stato sospeso. Rientra dal login."
      action={
        <Button variant="primary" onClick={() => window.location.assign('/login')}>
          Vai al login
        </Button>
      }
    />
  );
}

export function ForbiddenPage() {
  return (
    <SystemState
      code="403"
      title="Non hai accesso a questo modulo"
      description="Se ti serve, chiedi a un owner di concedertelo: il pannello non mostra i moduli a cui non hai accesso, quindi anche il nome di questa pagina è un'informazione."
      action={
        <Link to="/">
          <Button variant="secondary">Torna alla home</Button>
        </Link>
      }
    />
  );
}

export function NotFoundPage() {
  return (
    <SystemState
      code="404"
      title="Pagina inesistente"
      description="Questo indirizzo non corrisponde a nulla. Può darsi che la risorsa sia stata rimossa, o che non sia tua da vedere: il pannello risponde allo stesso modo nei due casi."
      action={
        <Link to="/">
          <Button variant="secondary">Torna alla home</Button>
        </Link>
      }
    />
  );
}

export function MaintenancePage() {
  return (
    <SystemState
      code="503"
      title="Manutenzione in corso"
      description="Il pannello è temporaneamente non disponibile. Le sessioni aperte restano valide: al ritorno non dovrai rifare il login."
    />
  );
}

/** Banner non bloccante: il resto della pagina continua a funzionare. */
export function FeedDisconnectedBanner({ onRetry }: { onRetry: () => void }) {
  return (
    <Banner
      tone="warn"
      title="Feed in tempo reale disconnesso"
      description="I dati mostrati potrebbero non essere aggiornati. Il pannello resta utilizzabile."
      action={
        <Button size="sm" onClick={onRetry}>
          Riprova
        </Button>
      }
    />
  );
}
