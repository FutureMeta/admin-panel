// Le tre finestre di «Duels · Configs»: legami, nuovo file, pubblica.
//
// STANNO FUORI DALLA SCHERMATA perche' la schermata e' gia' lunga e perche'
// queste tre sono l'unico punto in cui si prendono decisioni che cambiano piu'
// di un file alla volta. Tenerle insieme rende leggibile in un posto solo
// l'unica domanda che conta: quanti moduli tocca quello che sto per fare.

import { useMutation } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import { type ConfigFile, type ConfigFileSummary, moduleHue, titleOf } from '../lib/duels-config.ts';

export function pillStyle(module: string, small = false): React.CSSProperties {
  const hue = moduleHue(module);
  return {
    padding: small ? '2px 7px' : '3px 9px',
    borderRadius: 'var(--r-xs)',
    background: `color-mix(in srgb, ${hue} 14%, transparent)`,
    color: hue,
    fontFamily: 'var(--font-mono)',
    fontSize: small ? 10.5 : 11,
  };
}

/**
 * La cornice comune. Lo sfondo e' un PULSANTE, come negli altri dialoghi del
 * pannello: «clicca fuori per chiudere» su un div funziona solo col mouse, e
 * chi naviga da tastiera non lo raggiunge.
 */
function Dialog({
  title,
  sub,
  width,
  onClose,
  children,
  footer,
}: {
  title: string;
  sub?: string;
  width: number;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 80,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 40,
      }}
    >
      <button
        type="button"
        aria-label="Chiudi"
        onClick={onClose}
        style={{
          position: 'absolute',
          inset: 0,
          border: 'none',
          background: 'rgba(4,10,14,.66)',
          backdropFilter: 'blur(3px)',
          cursor: 'default',
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          position: 'relative',
          width,
          maxWidth: '100%',
          maxHeight: '100%',
          overflowY: 'auto',
          border: '1px solid var(--bd-strong)',
          borderRadius: 'var(--r-lg)',
          background: 'var(--s-overlay)',
          boxShadow: 'var(--e3)',
        }}
      >
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--bd-subtle)' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 700 }}>{title}</div>
          {sub === undefined ? null : (
            <div style={{ marginTop: 4, fontSize: 12.5, color: 'var(--tx-muted)' }}>{sub}</div>
          )}
        </div>
        {children}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            padding: '14px 20px',
            borderTop: '1px solid var(--bd-subtle)',
            background: 'var(--s-inset)',
          }}
        >
          {footer}
        </div>
      </div>
    </div>
  );
}

function GhostButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        height: 34,
        padding: '0 14px',
        border: '1px solid var(--bd-subtle)',
        borderRadius: 'var(--r-sm)',
        background: 'transparent',
        color: 'var(--tx-secondary)',
        fontFamily: 'var(--font-ui)',
        fontSize: 12.5,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}

function PrimaryButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        height: 34,
        padding: '0 16px',
        border: '1px solid transparent',
        borderRadius: 'var(--r-sm)',
        background: disabled ? 'var(--s-elevated)' : 'var(--ac)',
        color: disabled ? 'var(--tx-disabled)' : '#160A02',
        fontFamily: 'var(--font-ui)',
        fontSize: 12.5,
        fontWeight: 700,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      {label}
    </button>
  );
}

const FIELD: React.CSSProperties = {
  width: '100%',
  height: 34,
  padding: '0 11px',
  border: '1px solid var(--bd-subtle)',
  borderRadius: 'var(--r-sm)',
  background: 'var(--s-inset)',
  color: 'var(--tx-primary)',
  fontFamily: 'var(--font-mono)',
  fontSize: 12.5,
  outline: 'none',
};

const LABEL: React.CSSProperties = {
  display: 'block',
  marginBottom: 6,
  fontSize: 10.5,
  fontWeight: 600,
  letterSpacing: '.12em',
  textTransform: 'uppercase',
  color: 'var(--tx-muted)',
};

/** Le pastiglie dei moduli, cliccabili. La usano i due dialoghi che li scelgono. */
function ModulePicker({
  modules,
  selected,
  onToggle,
}: {
  modules: readonly string[];
  selected: readonly string[];
  onToggle: (module: string) => void;
}) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {modules.map((m) => {
        const on = selected.includes(m);
        return (
          <button
            key={m}
            type="button"
            onClick={() => onToggle(m)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              height: 30,
              padding: '0 11px',
              border: `1px solid ${on ? 'rgba(219,110,25,.45)' : 'var(--bd-subtle)'}`,
              borderRadius: 'var(--r-sm)',
              background: on ? 'var(--ac-soft)' : 'var(--s-inset)',
              color: on ? 'var(--ac-text)' : 'var(--tx-secondary)',
              fontFamily: 'var(--font-mono)',
              fontSize: 11.5,
              cursor: 'pointer',
            }}
          >
            <span
              style={{
                width: 11,
                height: 11,
                borderRadius: 3,
                border: `1px solid ${on ? 'rgba(219,110,25,.45)' : 'var(--bd-subtle)'}`,
                background: on ? 'var(--ac)' : 'transparent',
                flex: 'none',
              }}
            />
            {m}
          </button>
        );
      })}
    </div>
  );
}

export function LinksDialog({
  file,
  modules,
  current,
  keepVersionId,
  onClose,
  onSaved,
}: {
  file: ConfigFile;
  modules: readonly string[];
  current: readonly string[];
  keepVersionId: number;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [picked, setPicked] = useState<string[]>([...current]);
  const [split, setSplit] = useState(file.split);

  const save = useMutation({
    mutationFn: () =>
      api<{ ok: true }>('/api/duels/config/links', {
        method: 'PUT',
        body: { path: file.path, modules: picked, split, keepVersionId },
      }),
    onSuccess: onSaved,
  });

  // DUE modi di perdere contenuto, e nessun altro. Un avviso che comparisse a
  // ogni salvataggio non lo leggerebbe piu' nessuno, quindi si calcolano
  // esattamente i casi in cui qualcosa sparisce davvero.
  //
  // Il primo: riunire versioni che dicono cose diverse. Ne resta una.
  const contents = new Set(file.versions.map((v) => v.draft ?? v.published ?? ''));
  const collapsing = file.split && !split && contents.size > 1;
  const kept = file.versions.find((v) => v.id === keepVersionId)?.modules ?? [];

  // Il secondo: togliere un modulo da un file diviso. La sua versione non e'
  // legata a nessun altro, quindi va via con lui — e nessuna schermata sa
  // mostrare una versione che non riceve nessuno.
  const dropped = file.split && split ? current.filter((m) => !picked.includes(m)) : [];
  const losing = dropped.filter((m) => {
    const version = file.versions.find((v) => v.modules.includes(m));
    return version !== undefined && version.modules.every((x) => !picked.includes(x));
  });

  const modes = [
    {
      id: 'shared' as const,
      label: 'Una versione condivisa',
      desc: 'Un solo file per tutti i moduli scelti. Lo modifichi una volta e vale per tutti.',
    },
    {
      id: 'split' as const,
      label: 'Una versione per legame',
      desc: 'Un file separato per ogni modulo. Si modificano in modo indipendente.',
    },
  ];

  return (
    <Dialog
      title="Versioni e legami"
      sub={file.path}
      width={560}
      onClose={onClose}
      footer={
        <>
          <GhostButton label="Annulla" onClick={onClose} />
          <PrimaryButton
            label={save.isPending ? 'Salvo…' : 'Salva'}
            disabled={save.isPending}
            onClick={() => save.mutate()}
          />
        </>
      }
    >
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--bd-subtle)' }}>
        <span style={LABEL}>Moduli legati</span>
        <ModulePicker
          modules={modules}
          selected={picked}
          onToggle={(m) =>
            setPicked((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]))
          }
        />
        {picked.length === 0 ? (
          <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--warn)' }}>
            Senza moduli il file resta nel pannello e non lo riceve nessun server.
          </div>
        ) : null}
      </div>
      <div style={{ padding: '14px 20px' }}>
        <span style={LABEL}>Contenuto</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {modes.map((mode) => {
            const on = (split ? 'split' : 'shared') === mode.id;
            return (
              <button
                key={mode.id}
                type="button"
                onClick={() => setSplit(mode.id === 'split')}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 11,
                  padding: '12px 13px',
                  border: `1px solid ${on ? 'var(--ac)' : 'var(--bd-subtle)'}`,
                  borderRadius: 'var(--r-md)',
                  background: on ? 'var(--ac-soft)' : 'var(--s-inset)',
                  textAlign: 'left',
                  cursor: 'pointer',
                }}
              >
                <span
                  style={{
                    width: 13,
                    height: 13,
                    marginTop: 2,
                    borderRadius: 'var(--r-full)',
                    border: `1px solid ${on ? 'var(--ac)' : 'var(--bd-subtle)'}`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flex: 'none',
                  }}
                >
                  <span
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: 'var(--r-full)',
                      background: on ? 'var(--ac)' : 'transparent',
                    }}
                  />
                </span>
                <span style={{ minWidth: 0 }}>
                  <span
                    style={{
                      display: 'block',
                      fontSize: 13,
                      fontWeight: 600,
                      color: on ? 'var(--tx-primary)' : 'var(--tx-secondary)',
                    }}
                  >
                    {mode.label}
                  </span>
                  <span
                    style={{
                      display: 'block',
                      marginTop: 3,
                      fontSize: 11.5,
                      color: 'var(--tx-muted)',
                      lineHeight: '17px',
                    }}
                  >
                    {mode.desc}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        {collapsing ? (
          // L'AVVISO CHE SERVE DAVVERO. Riunire N versioni diverse ne tiene
          // una sola: quale resta non puo' deciderlo il pannello a caso, e chi
          // preme Salva deve sapere quale ha davanti.
          <div
            style={{
              marginTop: 12,
              padding: '11px 13px',
              border: '1px solid rgba(224,163,46,.35)',
              borderRadius: 'var(--r-md)',
              background: 'var(--warn-soft)',
              fontSize: 12,
              color: 'var(--tx-primary)',
              lineHeight: '18px',
            }}
          >
            Le {file.versions.length} versioni hanno contenuti diversi. Riunendole resta quella che stai
            guardando
            {kept.length > 0 ? (
              <>
                {' — '}
                <span style={{ fontFamily: 'var(--font-mono)' }}>{kept.join(', ')}</span>
              </>
            ) : null}
            , e le altre si perdono.
          </div>
        ) : null}
        {losing.length > 0 ? (
          <div
            style={{
              marginTop: 12,
              padding: '11px 13px',
              border: '1px solid rgba(224,163,46,.35)',
              borderRadius: 'var(--r-md)',
              background: 'var(--warn-soft)',
              fontSize: 12,
              color: 'var(--tx-primary)',
              lineHeight: '18px',
            }}
          >
            {losing.length === 1 ? 'Il modulo ' : 'I moduli '}
            <span style={{ fontFamily: 'var(--font-mono)' }}>{losing.join(', ')}</span>
            {losing.length === 1 ? ' perde la sua versione' : ' perdono le loro versioni'}: nessun altro
            modulo {losing.length === 1 ? 'la' : 'le'} usa, quindi{' '}
            {losing.length === 1 ? 'sparisce' : 'spariscono'} insieme al legame.
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

export function NewFileDialog({
  modules,
  onClose,
  onCreated,
}: {
  modules: readonly string[];
  onClose: () => void;
  onCreated: (path: string) => Promise<void>;
}) {
  const [dir, setDir] = useState('');
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const cleanDir = dir.replace(/^\/+|\/+$/g, '');
  const cleanName = name.replace(/\.yml$/, '');
  const path = `${cleanDir === '' ? '' : `${cleanDir}/`}${cleanName === '' ? 'nuovo_file' : cleanName}.yml`;

  const create = useMutation({
    mutationFn: () =>
      api<{ path: string }>('/api/duels/config/path', {
        method: 'POST',
        body: { path, modules: picked },
      }),
    onSuccess: () => onCreated(path),
    onError: (err: Error) => setError(err.message),
  });

  return (
    <Dialog
      title="Nuovo file di configurazione"
      sub="Il file nasce vuoto: i valori non impostati restano ai default del jar."
      width={520}
      onClose={onClose}
      footer={
        <>
          <GhostButton label="Annulla" onClick={onClose} />
          <PrimaryButton
            label={create.isPending ? 'Creo…' : 'Crea file'}
            disabled={create.isPending || cleanName === '' || picked.length === 0}
            onClick={() => {
              setError(null);
              create.mutate();
            }}
          />
        </>
      }
    >
      <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <span style={LABEL}>Cartella</span>
          <input
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            placeholder="es. inventories/event/"
            style={FIELD}
          />
          <div style={{ marginTop: 6, fontSize: 11.5, color: 'var(--tx-muted)' }}>
            Vuoto = radice del modulo.
          </div>
        </div>
        <div>
          <span style={LABEL}>Nome del file</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="es. crystal_royale.yml"
            style={FIELD}
          />
        </div>
        <div>
          <span style={LABEL}>Moduli</span>
          <ModulePicker
            modules={modules}
            selected={picked}
            onToggle={(m) =>
              setPicked((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]))
            }
          />
        </div>
        {/* Il percorso finale, sempre visibile: cartella e nome sono due campi
            e il risultato e' uno solo, e non si indovina da due caselle. */}
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--tx-muted)' }}>{path}</div>
        {error === null ? null : <div style={{ fontSize: 12, color: 'var(--err)' }}>{error}</div>}
      </div>
    </Dialog>
  );
}

export function PublishDialog({
  pending,
  busy,
  onClose,
  onConfirm,
}: {
  pending: readonly ConfigFileSummary[];
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const modules = [...new Set(pending.flatMap((f) => f.modules))].sort();

  return (
    <Dialog
      title={`Pubblicare ${pending.length} file?`}
      sub="Il cambiamento arriva ai server al loro prossimo avvio."
      width={640}
      onClose={onClose}
      footer={
        <>
          <GhostButton label="Annulla" onClick={onClose} />
          <PrimaryButton label={busy ? 'Pubblico…' : 'Pubblica'} disabled={busy} onClick={onConfirm} />
        </>
      }
    >
      <div>
        {pending.map((f) => (
          <div key={f.path} style={{ padding: '14px 20px', borderBottom: '1px solid var(--bd-subtle)' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>{titleOf(f.path)}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--tx-muted)' }}>
                {f.path}
              </span>
              <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--tx-secondary)' }}>
                {f.by ?? '—'}
              </span>
            </div>
            <div style={{ marginTop: 9, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {f.modules.map((m) => (
                <span key={m} style={pillStyle(m, true)}>
                  {m}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
      {/* IL CONTO IN FONDO, e non in cima: e' la riga che si legge un attimo
          prima di premere, ed e' l'unica che dice quanto e' grande la cosa che
          si sta per fare. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '16px 20px',
          background: 'var(--ac-soft)',
          borderTop: '1px solid rgba(219,110,25,.35)',
        }}
      >
        <span style={{ fontSize: 13, color: 'var(--tx-primary)' }}>
          In totale la pubblicazione tocca{' '}
          <span
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 17,
              fontWeight: 700,
              color: 'var(--ac-text)',
            }}
          >
            {modules.length} {modules.length === 1 ? 'modulo' : 'moduli'}
          </span>
          {modules.length === 0 ? null : <> — {modules.join(', ')}</>}.
        </span>
      </div>
    </Dialog>
  );
}
