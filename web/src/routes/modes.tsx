// Modalità: il dizionario che decide come i server si raggruppano nei grafici.
//
// PERCHÉ QUESTA SCHERMATA HA UN'ANTEPRIMA. Su questa rete esistono `duels_1..6`,
// `duels_lobby_1..2` e `duels_event_1`. Una regola «inizia per duels_» le prende
// tutte e nove, e chi voleva tenere separate arene, lobby ed evento se ne
// accorgerebbe giorni dopo, da un grafico sbagliato. Qui l'effetto si vede
// prima di salvare, e si vede sui nomi veri dei server — non su un esempio.
//
// L'anteprima la calcola il server inserendo davvero la regola e annullando la
// transazione, così non esiste una seconda copia della logica di risoluzione
// che possa divergere da quella vera.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { PageHeader, Panel, PanelBar, SelectField } from '../components/page.tsx';
import { Banner, Button, EmptyState, Field, SkeletonRows } from '../components/ui.tsx';
import { api, type Me } from '../lib/api.ts';

type MatchKind = 'server' | 'prefix' | 'suffix' | 'contains';
type Alias = { matchKind: MatchKind; matchValue: string };

type Mode = {
  modeId: number;
  modeKey: string;
  displayName: string;
  color: string | null;
  inBreakdown: boolean;
  hidden: boolean;
  sortOrder: number;
  aliases: Alias[];
  servers: string[];
};

type ColourWarning =
  | { kind: 'simile'; modeKey: string; otherKey: string; distance: number }
  | { kind: 'contrasto'; modeKey: string; ratio: number };

type Dictionary = { modes: Mode[]; unclassified: string[]; warnings: ColourWarning[] };

type PreviewChange = { serverKey: string; before: string; after: string };
type Preview = { alias: Alias; changes: PreviewChange[]; captured: number; unchanged: number };

const KIND_LABEL: Record<MatchKind, string> = {
  server: 'è esattamente',
  prefix: 'inizia per',
  suffix: 'finisce per',
  contains: 'contiene',
};

function Swatch({ color }: { color: string | null }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: 12,
        height: 12,
        borderRadius: 3,
        background: color ?? 'transparent',
        border: color ? 'none' : '1px dashed var(--tx-muted)',
        flex: '0 0 auto',
      }}
    />
  );
}

/**
 * Gli avvisi sui colori sono AVVISI.
 *
 * Chi assegna i colori sa cose che il calcolo non sa: che due modalità non
 * compaiono mai insieme, che una è in dismissione. Un divieto lo costringerebbe
 * a combattere con lo strumento; un avviso gli dice cosa vede il grafico.
 */
function ColourNotices({ warnings }: { warnings: ColourWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <Banner
      tone="warn"
      title="Colori da rivedere"
      description={warnings
        .map((w) =>
          w.kind === 'contrasto'
            ? `«${w.modeKey}» ha un contrasto di ${w.ratio}:1 sul fondo scuro: sotto 3:1 la sua linea sparisce nel grafico.`
            : `«${w.modeKey}» e «${w.otherKey}» hanno colori quasi identici: sul grafico le due linee non si distinguono.`,
        )
        .join(' ')}
    />
  );
}

function PreviewResult({ preview }: { preview: Preview }) {
  if (preview.changes.length === 0) {
    return (
      <Banner
        tone="info"
        title="Questa regola non cambierebbe niente"
        description="Nessun server si sposterebbe: o non ne cattura nessuno, o quelli che tocca sono già assegnati da una regola più specifica."
      />
    );
  }
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <span style={{ fontSize: 12.5, color: 'var(--tx-secondary)' }}>
        {preview.changes.length}{' '}
        {preview.changes.length === 1 ? 'server cambierebbe' : 'server cambierebbero'} modalità.{' '}
        {preview.unchanged} restano dove sono.
      </span>
      <table className="table" style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ background: 'var(--s-inset)' }}>
            <th style={{ paddingLeft: 12 }}>Server</th>
            <th>Adesso</th>
            <th>Diventerebbe</th>
          </tr>
        </thead>
        <tbody>
          {preview.changes.map((c) => (
            <tr key={c.serverKey}>
              <td className="mono" style={{ paddingLeft: 12 }}>
                {c.serverKey}
              </td>
              <td style={{ color: 'var(--tx-muted)' }}>{c.before}</td>
              <td>{c.after}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ModeEditor({ mode, canManage }: { mode: Mode; canManage: boolean }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<MatchKind>('prefix');
  const [value, setValue] = useState('');
  const [preview, setPreview] = useState<Preview | undefined>();
  const [error, setError] = useState<string | undefined>();

  const invalidate = () => {
    setPreview(undefined);
    setValue('');
    void qc.invalidateQueries({ queryKey: ['stats-modes'] });
  };

  const tryIt = useMutation({
    mutationFn: () =>
      api<Preview>(`/api/stats/modes/${mode.modeKey}/preview`, {
        method: 'POST',
        body: { matchKind: kind, matchValue: value.trim().toLowerCase() },
      }),
    onSuccess: (p) => {
      setError(undefined);
      setPreview(p);
    },
    onError: () => setError('Anteprima non riuscita.'),
  });

  const saveRules = useMutation({
    mutationFn: (aliases: Alias[]) =>
      api(`/api/stats/modes/${mode.modeKey}/aliases`, { method: 'PUT', body: { aliases } }),
    onSuccess: invalidate,
    onError: () => setError('Salvataggio non riuscito.'),
  });

  const setColour = useMutation({
    mutationFn: (color: string) =>
      api(`/api/stats/modes/${mode.modeKey}`, { method: 'PATCH', body: { color } }),
    onSuccess: invalidate,
    onError: () => setError('Colore non salvato.'),
  });

  const add = () => {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === '') return;
    saveRules.mutate([...mode.aliases, { matchKind: kind, matchValue: trimmed }]);
  };

  return (
    <div style={{ display: 'grid', gap: 14, padding: 16 }}>
      {error ? <Banner tone="err" title={error} /> : null}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Swatch color={mode.color} />
        <input
          type="color"
          aria-label={`Colore di ${mode.displayName}`}
          value={mode.color ?? '#e8822b'}
          disabled={!canManage}
          onChange={(e) => setColour.mutate(e.target.value.toLowerCase())}
        />
        <span style={{ fontSize: 12.5, color: 'var(--tx-secondary)' }}>
          {mode.servers.length} {mode.servers.length === 1 ? 'server' : 'server'} catturati
        </span>
      </div>

      <div>
        <span style={{ fontSize: 12.5, color: 'var(--tx-secondary)' }}>Regole</span>
        {mode.aliases.length === 0 ? (
          <p style={{ fontSize: 12.5, color: 'var(--tx-muted)', margin: '6px 0 0' }}>
            Nessuna regola: questa modalità non cattura ancora nessun server, e non compare nei grafici.
          </p>
        ) : (
          <ul style={{ listStyle: 'none', margin: '6px 0 0', padding: 0, display: 'grid', gap: 4 }}>
            {mode.aliases.map((a) => (
              <li
                key={`${a.matchKind}:${a.matchValue}`}
                style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}
              >
                <span style={{ color: 'var(--tx-muted)' }}>{KIND_LABEL[a.matchKind]}</span>
                <span className="mono">{a.matchValue}</span>
                {canManage ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    style={{ marginLeft: 'auto' }}
                    onClick={() =>
                      saveRules.mutate(
                        mode.aliases.filter(
                          (x) => !(x.matchKind === a.matchKind && x.matchValue === a.matchValue),
                        ),
                      )
                    }
                  >
                    Rimuovi
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {canManage ? (
        <div style={{ display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <SelectField
              label="Il nome del server"
              value={kind}
              onChange={(v) => setKind(v as MatchKind)}
              options={(Object.keys(KIND_LABEL) as MatchKind[]).map((k) => ({
                value: k,
                label: KIND_LABEL[k],
              }))}
            />
            <Field
              label="Valore"
              value={value}
              placeholder="duels_"
              onChange={(e) => setValue(e.target.value)}
            />
            <Button size="sm" onClick={() => tryIt.mutate()} disabled={value.trim() === ''}>
              Prova
            </Button>
            <Button size="sm" variant="primary" onClick={add} disabled={value.trim() === ''}>
              Aggiungi
            </Button>
          </div>
          {/* Provare prima di aggiungere non è obbligatorio, ma è il motivo per
              cui questa schermata esiste: `duels_` prende anche le lobby. */}
          {preview ? <PreviewResult preview={preview} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function NewMode() {
  const qc = useQueryClient();
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | undefined>();

  const create = useMutation({
    mutationFn: () =>
      api('/api/stats/modes', {
        method: 'POST',
        body: { modeKey: key.trim().toLowerCase(), displayName: name.trim() },
      }),
    onSuccess: () => {
      setKey('');
      setName('');
      setError(undefined);
      void qc.invalidateQueries({ queryKey: ['stats-modes'] });
    },
    onError: () => setError('Non creata: la chiave è già usata, riservata o non valida.'),
  });

  return (
    <div style={{ display: 'grid', gap: 8, padding: 16 }}>
      {error ? <Banner tone="err" title={error} /> : null}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Field label="Nome" value={name} placeholder="Bedwars" onChange={(e) => setName(e.target.value)} />
        <Field
          label="Chiave"
          hint="minuscolo, senza spazi"
          value={key}
          placeholder="bedwars"
          onChange={(e) => setKey(e.target.value)}
        />
        <Button
          size="sm"
          variant="primary"
          onClick={() => create.mutate()}
          disabled={key.trim() === '' || name.trim() === ''}
        >
          Crea
        </Button>
      </div>
    </div>
  );
}

export function ModesPage({ me }: { me: Me }) {
  const [selected, setSelected] = useState<string | undefined>();
  const canManage = (me.permissions.statistiche ?? 0) >= 3;

  const dict = useQuery({
    queryKey: ['stats-modes'],
    queryFn: () => api<Dictionary>('/api/stats/modes'),
  });

  const modes = dict.data?.modes ?? [];
  const current = modes.find((m) => m.modeKey === selected);

  return (
    <>
      <PageHeader
        title="Modalità"
        sub="Come i server della rete si raggruppano nei grafici. Cambiare una regola cambia i numeri per modalità dal giro successivo, e non tocca lo storico: si può cambiare idea."
      />

      {dict.data ? <ColourNotices warnings={dict.data.warnings} /> : null}

      {/* I non classificati per primi: è la lista da cui si parte, e un
          `__unknown__` che cresce è il primo segnale che la rete ha server
          nuovi. Non sono errori — restano nel totale come serie visibile. */}
      <Panel>
        <PanelBar>
          <span style={{ fontSize: 12.5, color: 'var(--tx-secondary)' }}>Server non classificati</span>
          <span className="mono" style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--tx-muted)' }}>
            {dict.data?.unclassified.length ?? 0}
          </span>
        </PanelBar>
        {dict.isPending ? (
          <SkeletonRows rows={2} />
        ) : (dict.data?.unclassified.length ?? 0) === 0 ? (
          <EmptyState
            title="Ogni server ha una modalità"
            description="Quando la rete ne aggiunge uno nuovo comparirà qui, e nel frattempo finirà nella serie «Non classificata» dei grafici."
          />
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: 16 }}>
            {dict.data?.unclassified.map((s) => (
              <span key={s} className="mono" style={{ fontSize: 12, color: 'var(--tx-secondary)' }}>
                {s}
              </span>
            ))}
          </div>
        )}
      </Panel>

      <Panel>
        <PanelBar>
          <span style={{ fontSize: 12.5, color: 'var(--tx-secondary)' }}>Modalità</span>
          <span className="mono" style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--tx-muted)' }}>
            {modes.length}
          </span>
        </PanelBar>

        {dict.isPending ? (
          <SkeletonRows />
        ) : modes.length === 0 ? (
          <EmptyState
            title="Il dizionario è vuoto"
            description="Nessuno sa a priori come questa rete vuole raggruppare i propri server: le modalità le crei tu, e finché non esistono i grafici mostrano una serie sola."
          />
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {modes.map((m) => (
              <li key={m.modeKey} style={{ borderTop: '1px solid var(--s-line)' }}>
                <button
                  type="button"
                  onClick={() => setSelected(selected === m.modeKey ? undefined : m.modeKey)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    width: '100%',
                    padding: '12px 16px',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    textAlign: 'left',
                    color: 'inherit',
                  }}
                  aria-expanded={selected === m.modeKey}
                >
                  <Swatch color={m.color} />
                  <span>{m.displayName}</span>
                  <span className="mono" style={{ fontSize: 11.5, color: 'var(--tx-muted)' }}>
                    {m.modeKey}
                  </span>
                  <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--tx-secondary)' }}>
                    {m.servers.length === 0 ? 'nessun server' : `${m.servers.length} server`}
                  </span>
                </button>
                {selected === m.modeKey && current ? (
                  <ModeEditor mode={current} canManage={canManage} />
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {canManage ? <NewMode /> : null}
      </Panel>
    </>
  );
}
