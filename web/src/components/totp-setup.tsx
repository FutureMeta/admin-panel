// Il secondo fattore: il QR, il primo codice, i codici di recupero. §8.1.11-12
//
// DUE PORTE, UNA SCHERMATA. Ci arriva chi accetta un invito, dopo aver scelto
// la password, e ci arriva chi rientra dopo un reset del secondo fattore
// (§8.8), dal login. Il disegno e' quello di frontend/2-accettazione-invito:
// per il rientro non ce n'e' uno proprio, e una seconda versione della stessa
// cosa divergerebbe dalla prima al primo ritocco.
//
// I codici di recupero si mostrano UNA SOLA VOLTA, e il pulsante finale resta
// spento finche' non si conferma di averli salvati.

import qrcode from 'qrcode-generator';
import { type FormEvent, type ReactNode, useMemo, useState } from 'react';
import { Button, Notice } from './ui.tsx';

export function TotpSetup({
  totpUri,
  email,
  complete,
  finishLabel,
  onFinish,
}: {
  /** L'URI `otpauth://` coniato da better-auth; `undefined` mentre arriva. */
  totpUri: string | undefined;
  /** Finisce nel file dei codici, per sapere di quale account sono. */
  email: string;
  /** Verifica il primo codice e restituisce i codici di recupero. */
  complete: (code: string) => Promise<string[]>;
  finishLabel: string;
  onFinish: () => void;
}) {
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function activate(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    setBusy(true);
    try {
      setCodes(await complete(code.trim()));
    } catch {
      setError('Codice non valido. Controlla che l’orario del telefono sia sincronizzato.');
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  /**
   * I codici come testo. Numerati: un elenco di dieci stringhe uguali fra loro
   * e' esattamente il genere di cosa che si incolla a meta'.
   */
  function codesAsText(): string {
    return [
      'Codici di recupero MetaMC Admin',
      email,
      '',
      ...codes.map((c, i) => `${String(i + 1).padStart(2, ' ')}. ${c}`),
      '',
      'Ognuno vale una volta sola. Sono stati mostrati una volta e non si rivedono.',
    ].join('\n');
  }

  async function copyCodes() {
    try {
      await navigator.clipboard.writeText(codesAsText());
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Gli appunti possono essere negati dal browser. Non e' un errore da
      // mostrare: i codici sono li' sullo schermo, e c'e' il download.
    }
  }

  /**
   * Il file lo compone il browser da dati che ha gia': nessuna richiesta al
   * server, quindi questi codici non passano una seconda volta dalla rete.
   */
  function downloadCodes() {
    const blob = new Blob([codesAsText()], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'metamc-codici-di-recupero.txt';
    link.click();
    URL.revokeObjectURL(url);
  }

  const secret = totpUri ? new URLSearchParams(totpUri.split('?')[1] ?? '').get('secret') : null;

  return (
    <>
      {error ? (
        <div style={{ marginBottom: 18 }}>
          <Notice tone="err" title={error} />
        </div>
      ) : null}
      {codes.length === 0 ? (
        <form onSubmit={activate}>
          <h2
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 18,
              fontWeight: 600,
              margin: '0 0 20px',
            }}
          >
            Attiva la verifica a due fattori
          </h2>

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

            <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
              <QrBox uri={totpUri} preparing={busy && !totpUri} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, lineHeight: '19px', color: 'var(--tx-secondary)' }}>
                  Scansiona con Google Authenticator, 1Password o Authy, poi inserisci il primo codice.
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
                    {/* La chiave in chiaro non è ridondante: se la
                              fotocamera non collabora, è l'unico modo di
                              aggiungere l'account a mano. */}
                    {groupsOf(secret, 4)}
                  </div>
                ) : null}
              </div>
            </div>

            <OtpCells value={code} onChange={setCode} disabled={!totpUri} />
          </div>

          <Button type="submit" variant="primary" size="lg" loading={busy} disabled={code.length !== 6} block>
            Verifica e continua
          </Button>
        </form>
      ) : (
        <>
          {/* I codici di recupero restano DENTRO la card, come nel
                    disegno, e la barra dei passi non avanza a tre: sono il
                    secondo fattore visto dall'altro lato — cosa fai quando il
                    telefono non c'è più. */}
          <p style={{ margin: '0 0 18px', fontSize: 12.5, lineHeight: '19px', color: 'var(--tx-muted)' }}>
            2FA attiva. Salva questi codici: usali se perdi l'accesso all'app di autenticazione, ognuno
            funziona una sola volta e vengono mostrati solo adesso.
          </p>

          <div
            style={{
              border: '1px solid var(--bd-strong)',
              borderRadius: 'var(--r-md)',
              background: 'var(--s-inset)',
              padding: '16px 18px',
              marginBottom: 14,
            }}
          >
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 18px' }}>
              {codes.map((value, i) => (
                <div
                  key={value}
                  className="mono"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 9,
                    fontSize: 12.5,
                    color: 'var(--tx-primary)',
                    padding: '5px 0',
                    borderBottom: '1px solid var(--bd-subtle)',
                  }}
                >
                  <span style={{ width: 14, fontSize: 10.5, color: 'var(--tx-disabled)' }}>{i + 1}</span>
                  {value}
                </div>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
            <SmallButton onClick={copyCodes} path={ICON_COPY}>
              {copied ? 'Copiati' : 'Copia tutti'}
            </SmallButton>
            <SmallButton onClick={downloadCodes} path={ICON_DOWNLOAD}>
              Scarica .txt
            </SmallButton>
          </div>

          <label
            style={{
              position: 'relative',
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              marginBottom: 18,
              cursor: 'pointer',
            }}
          >
            {/* La casella vera è nascosta ma resta il controllo: tastiera
                      e screen reader lavorano su quella, il quadrato arancione
                      è soltanto come si vede. */}
            <input
              type="checkbox"
              checked={saved}
              onChange={(e) => setSaved(e.target.checked)}
              style={{ position: 'absolute', opacity: 0, width: 16, height: 16, margin: 0 }}
            />
            <span
              aria-hidden="true"
              style={{
                width: 16,
                height: 16,
                borderRadius: 'var(--r-xs)',
                background: saved ? 'var(--ac)' : 'transparent',
                border: saved ? 'none' : '1px solid var(--bd-strong)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flex: 'none',
                marginTop: 1,
              }}
            >
              {saved ? (
                <svg
                  viewBox="0 0 24 24"
                  width="11"
                  height="11"
                  fill="none"
                  stroke="var(--on-ac)"
                  strokeWidth="3"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="m5 13 4 4 10-10" />
                </svg>
              ) : null}
            </span>
            <span style={{ fontSize: 12, lineHeight: '18px', color: 'var(--tx-secondary)' }}>
              Ho salvato questi codici in un posto sicuro.
            </span>
          </label>

          <Button variant="primary" size="lg" disabled={!saved} onClick={onFinish} block>
            {finishLabel}
          </Button>
        </>
      )}
    </>
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

/** Le due icone del disegno: appunti e freccia in giu'. */
const ICON_COPY = (
  <>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </>
);
const ICON_DOWNLOAD = (
  <>
    <path d="M12 3v13m0 0-4-4m4 4 4-4" />
    <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
  </>
);

/** I due pulsanti sotto i codici: 34px, bordo pieno, icona a sinistra. */
function SmallButton({
  onClick,
  path,
  children,
}: {
  onClick: () => void;
  path: ReactNode;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: 1,
        height: 34,
        border: '1px solid var(--bd-strong)',
        borderRadius: 'var(--r-sm)',
        background: 'var(--s-elevated)',
        color: 'var(--tx-primary)',
        fontFamily: 'var(--font-ui)',
        fontSize: 12,
        fontWeight: 500,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
      }}
    >
      <svg
        viewBox="0 0 24 24"
        width="13"
        height="13"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {path}
      </svg>
      {children}
    </button>
  );
}
