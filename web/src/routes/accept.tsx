// Accettazione invito: password, secondo fattore e recovery code.
//
// La pagina si apre DOPO il redirect a URL pulito (§8.1.7): qui il token non
// c'e' piu', c'e' un cookie di onboarding. Se manca, l'invito non e'
// spendibile — e la pagina non dice se era scaduto, consumato o inventato
// (SEC-32).
//
// Impaginazione di frontend/2-accettazione-invito.dc.html: campo di esagoni a
// piena pagina sotto, card centrata da 940px divisa in due — a sinistra cosa
// stai per ricevere, a destra tutto quello che devi fare, in una schermata
// sola.
//
// UNA COSA IL DISEGNO NON PUO' MOSTRARE, ed e' il motivo per cui il riquadro
// del QR ha due stati. Il segreto TOTP lo produce better-auth, e per produrlo
// gli serve la password: prima che la password sia impostata quel QR non
// esiste da nessuna parte, e disegnarlo vuoto sarebbe una bugia. Quindi la
// pagina resta una, ma il riquadro si accende da solo appena le due password
// coincidono — non c'e' un secondo pulsante e non si cambia schermata.
//
// I recovery code si mostrano UNA SOLA VOLTA, e per quelli la schermata a
// parte resta: sono l'unica cosa in tutto il flusso che non si puo' recuperare
// e meritano una pagina che non abbia altro sopra.

import { useNavigate } from '@tanstack/react-router';
import qrcode from 'qrcode-generator';
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { HexField } from '../components/hex-field.tsx';
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
type Phase = 'caricamento' | 'scaduto' | 'attiva' | 'codici';

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
  const [preparing, setPreparing] = useState(false);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  /**
   * L'accettazione non e' idempotente: la seconda chiamata troverebbe
   * l'account gia' creato. Il flag impedisce che una battitura in piu' la
   * faccia partire due volte, e torna false solo se e' fallita davvero.
   */
  const accepting = useRef(false);
  const accepted = totpUri !== undefined;

  useEffect(() => {
    api<Onboarding>('/api/invites/onboarding')
      .then((data) => {
        setInvite(data);
        setPhase('attiva');
      })
      .catch(() => setPhase('scaduto'));
  }, []);

  const passwordReady = password.length >= MIN_PASSWORD && password === confirm;

  // Appena le due password coincidono si crea l'account e arriva il segreto.
  // Mezzo secondo di attesa: senza, chi digita la conferma un carattere alla
  // volta la farebbe partire su una coincidenza di passaggio.
  useEffect(() => {
    if (!passwordReady || accepted || accepting.current) return;
    const timer = setTimeout(() => {
      accepting.current = true;
      setPreparing(true);
      setError(undefined);
      api<{ totpURI: string | null }>('/api/invites/accept', {
        method: 'POST',
        body: { password },
      })
        .then((res) => setTotpUri(res.totpURI ?? ''))
        .catch((err: unknown) => {
          accepting.current = false;
          if (err instanceof ApiError && err.code === 'PASSWORD_COMPROMISED') {
            setError('Questa password compare in una violazione nota. Scegline un’altra.');
          } else if (err instanceof ApiError && err.code === 'HIBP_UNAVAILABLE') {
            // Fail-closed dichiarato: si spiega perche' non si prosegue,
            // invece di accettare una password non verificata (§8.6).
            setError(
              'Non riusciamo a verificare che la password non sia compromessa. ' +
                'Per sicurezza non proseguiamo: riprova fra qualche minuto.',
            );
          } else {
            setError('Non è stato possibile impostare la password. Riprova.');
          }
        })
        .finally(() => setPreparing(false));
    }, 500);
    return () => clearTimeout(timer);
  }, [passwordReady, accepted, password]);

  async function activate(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    setBusy(true);
    try {
      const res = await api<{ recoveryCodes: string[] }>('/api/invites/complete', {
        method: 'POST',
        body: { code: code.trim() },
      });
      setCodes(res.recoveryCodes);
      setPhase('codici');
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
      ) : phase === 'codici' ? (
        <Shell single>
          <Title>Salva i codici di recupero</Title>
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

          {/* Colonna destra: tutto quello che devi fare, in una volta. */}
          <form onSubmit={activate} style={{ padding: 40 }}>
            <h2
              style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600, margin: '0 0 20px' }}
            >
              Attiva il tuo accesso
            </h2>

            {error ? (
              <div style={{ marginBottom: 18 }}>
                <Notice tone="err" title={error} />
              </div>
            ) : null}

            <div className="field" style={{ marginBottom: 18 }}>
              <label className="label" htmlFor="accept-email">
                Email
              </label>
              {/* L'indirizzo viene dalla riga invito e non è modificabile: il
                  campo lo mostra, non lo raccoglie (§8.1.9). */}
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
              // Impostata la password, l'account esiste: lasciare il campo
              // modificabile prometterebbe un cambio che questa pagina non fa
              // piu'.
              disabled={accepted}
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
              disabled={accepted}
              {...(confirm.length > 0 && confirm !== password
                ? { hint: 'Le due password non coincidono.' }
                : {})}
            />

            <div
              style={{
                padding: 16,
                border: '1px solid var(--bd-subtle)',
                borderRadius: 'var(--r-md)',
                background: 'var(--s-elevated)',
                margin: '26px 0 24px',
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

              <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                <QrBox uri={totpUri} preparing={preparing} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, lineHeight: '19px', color: 'var(--tx-secondary)' }}>
                    {accepted
                      ? 'Scansiona con Google Authenticator, 1Password o Authy, poi inserisci il primo codice.'
                      : 'Scegli la password qui sopra: il codice QR compare appena è impostata.'}
                  </div>
                  {secret ? (
                    <div
                      className="mono"
                      style={{
                        fontSize: 11,
                        color: 'var(--tx-muted)',
                        marginTop: 8,
                        wordBreak: 'break-all',
                      }}
                    >
                      {/* La chiave in chiaro non è ridondante: se la fotocamera
                          non collabora, è l'unico modo di aggiungere l'account
                          a mano. */}
                      {groupsOf(secret, 4)}
                    </div>
                  ) : null}
                </div>
              </div>

              <OtpCells value={code} onChange={setCode} disabled={!accepted} />
            </div>

            <Button
              type="submit"
              variant="primary"
              size="lg"
              loading={busy}
              disabled={!accepted || code.length !== 6}
              block
            >
              Attiva account ed entra
            </Button>

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
          </form>
        </Shell>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------

/**
 * Il QR, disegnato come nodi SVG e non come stringa di markup.
 *
 * SEC-35 — `createSvgTag()` della libreria restituisce HTML da iniettare, e
 * qui l'innerHTML e' vietato senza eccezioni. Dai moduli si costruisce un
 * `path`: un rettangolo per modulo scuro, in un `<path>` solo.
 *
 * Fondo bianco e bordo di quiete di due moduli: un QR chiaro su scuro molti
 * lettori non lo prendono, e senza margine nemmeno.
 */
function QrBox({ uri, preparing }: { uri: string | undefined; preparing: boolean }) {
  const drawing = useMemo(() => {
    if (!uri) return null;
    const qr = qrcode(0, 'M');
    qr.addData(uri);
    qr.make();
    const count = qr.getModuleCount();
    let path = '';
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) path += `M${col} ${row}h1v1h-1z`;
      }
    }
    return { count, path };
  }, [uri]);

  const frame: React.CSSProperties = {
    width: 96,
    height: 96,
    borderRadius: 'var(--r-sm)',
    border: '1px solid var(--bd-subtle)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 'none',
    overflow: 'hidden',
  };

  if (!drawing) {
    return (
      <div
        style={{
          ...frame,
          background: 'var(--s-inset)',
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          color: 'var(--tx-muted)',
          textAlign: 'center',
        }}
      >
        {preparing ? 'attendi…' : 'QR'}
      </div>
    );
  }

  const quiet = 2;
  const span = drawing.count + quiet * 2;
  return (
    <div style={{ ...frame, background: '#ffffff' }}>
      {/* Riempie il contenitore invece di dichiarare 96 fissi: il riquadro
          e' 96 BORDER-BOX, quindi dentro il bordo restano 94, e un SVG da 96
          si stringe in larghezza ma non in altezza. Due pixel di differenza
          bastano a rendere i moduli rettangolari. */}
      <svg
        viewBox={`${-quiet} ${-quiet} ${span} ${span}`}
        width="100%"
        height="100%"
        style={{ display: 'block' }}
        role="img"
        aria-label="Codice QR per l'app di autenticazione"
      >
        <rect x={-quiet} y={-quiet} width={span} height={span} fill="#ffffff" />
        <path d={drawing.path} fill="#000000" />
      </svg>
    </div>
  );
}

/**
 * Le sei celle del codice, sulle misure del disegno (40px, non le 52 del
 * login). Il campo vero e' trasparente sopra: le caselle sono la
 * rappresentazione, non il controllo, cosi' restano incolla-e-vai e leggibili
 * da uno screen reader.
 */
function OtpCells({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <div style={{ position: 'relative', marginTop: 14 }}>
      <div style={{ display: 'flex', gap: 7 }} aria-hidden="true">
        {Array.from({ length: 6 }, (_, i) => `cell-${i}`).map((id, i) => (
          <div
            key={id}
            style={{
              flex: 1,
              height: 40,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: `1px solid ${!disabled && value.length === i ? 'var(--ac)' : 'var(--bd-subtle)'}`,
              boxShadow: !disabled && value.length === i ? '0 0 0 3px var(--ac-soft)' : undefined,
              borderRadius: 'var(--r-xs)',
              background: 'var(--s-inset)',
              fontFamily: 'var(--font-mono)',
              fontSize: 16,
              color: disabled ? 'var(--tx-disabled)' : 'var(--tx-primary)',
            }}
          >
            {value[i] ?? ''}
          </div>
        ))}
      </div>
      <input
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        maxLength={6}
        aria-label="Codice a sei cifre"
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          opacity: 0,
          border: 0,
          background: 'transparent',
          cursor: disabled ? 'not-allowed' : 'text',
        }}
      />
    </div>
  );
}

/** La chiave a gruppi: si trascrive a mano molto piu' facilmente. */
function groupsOf(value: string, size: number): string {
  return (value.match(new RegExp(`.{1,${size}}`, 'g')) ?? [value]).join(' ');
}

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
