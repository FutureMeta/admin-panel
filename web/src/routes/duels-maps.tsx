// Duels · Maps. I metadati delle mappe, modificabili.
//
// LA GEOMETRIA DEI BLOCCHI NON E' QUI e non puo' esserlo: il mondo e' un blob
// SlimeWorld scritto dall'editor in gioco. Questa schermata cambia cio' che gli
// sta intorno — nome, tipo, contesto, quali modalita' ci si giocano, quali
// eventi, i settings della mappa — ed eliminare una mappa NON cancella il suo
// mondo.
//
// STESSA REGOLA DI MODES: tutto resta locale, e la barra del salvataggio
// compare solo quando la bozza si discosta da cio' che e' scritto. Qui conta
// anche di piu', perche' le tab nascondono le modifiche: si aggiunge una
// modalita', si passa a «Settings», e senza una barra che lo dica non ci
// sarebbe piu' niente sullo schermo che ricordi la modifica fatta prima.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import {
  BlockHeader,
  ConfirmDelete,
  MasterDetail,
  Picker,
  SaveBar,
  SettingRow,
} from '../components/config-panels.tsx';
import { FilterSelect, PageHeader, Panel, SearchBox } from '../components/page.tsx';
import { Button, EmptyState, Modal, Notice, SkeletonRows } from '../components/ui.tsx';
import { api, type Me } from '../lib/api.ts';
import {
  changedSettings,
  effectiveValues,
  looksValid,
  sameSet,
  toggleIn,
  type Vocabulary,
} from '../lib/config-draft.ts';
import { canOpen } from '../lib/modules.ts';

type ConfigMap = {
  id: number;
  name: string;
  displayName: string;
  type: string;
  context: string;
  enabled: boolean;
};

type ConfigMode = { id: number; name: string; displayName: string; type: string; ranking: string };

type MapDetail = {
  map: ConfigMap;
  modeIds: number[];
  eventTypes: string[];
  settings: Array<{ key: string; value: string }>;
  teams: Array<{ id: number; name: string; displayName: string; color: string }>;
};

const ALL = '__tutte__';
const TABS = ['Modalità', 'Event type', 'Settings', 'Team'] as const;
type Tab = (typeof TABS)[number];

export function DuelsMapsRoute({ me }: { me: Me }) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [type, setType] = useState(ALL);
  const [context, setContext] = useState(ALL);
  const [error, setError] = useState<string | undefined>();

  const vocabulary = useQuery({
    queryKey: ['duels-config', 'vocabulary'],
    queryFn: () => api<Vocabulary>('/api/duels/config/vocabulary'),
    staleTime: 5 * 60_000,
  });
  const list = useQuery({
    queryKey: ['duels-config', 'maps'],
    queryFn: () => api<{ maps: ConfigMap[] }>('/api/duels/config/maps'),
  });
  const modes = useQuery({
    queryKey: ['duels-config', 'modes'],
    queryFn: () => api<{ modes: ConfigMode[] }>('/api/duels/config/modes'),
  });

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (list.data?.maps ?? []).filter(
      (m) =>
        (type === ALL || m.type === type) &&
        (context === ALL || m.context === context) &&
        (q === '' || m.name.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q)),
    );
  }, [list.data, search, type, context]);

  useEffect(() => {
    if (selected === null && rows.length > 0) setSelected(rows[0]?.id ?? null);
  }, [rows, selected]);

  if (!canOpen(me, 'duels_maps')) {
    return (
      <>
        <PageHeader title="Duels · Maps" sub="Configurazione delle mappe" />
        <Notice
          tone="err"
          title="Non hai accesso a questa schermata"
          description="Serve almeno il livello «Lettura» sul modulo Maps."
        />
      </>
    );
  }

  if (list.isError || vocabulary.isError) {
    return (
      <>
        <PageHeader title="Duels · Maps" sub="Configurazione delle mappe" />
        <Notice
          tone="err"
          title="Configurazione non disponibile"
          description="Non è stato possibile leggere le mappe dal database del gioco. Riprova fra poco."
        />
      </>
    );
  }

  const vocab = vocabulary.data;
  if (!list.data || !vocab) {
    return (
      <>
        <PageHeader title="Duels · Maps" sub="Configurazione delle mappe" />
        <SkeletonRows rows={8} />
      </>
    );
  }

  return (
    <main style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <PageHeader
        title="Duels · Maps"
        sub={`${list.data.maps.length} mappe · la geometria dei blocchi resta in gioco`}
      />
      {error ? <Notice tone="err" title="Salvataggio non riuscito" description={error} /> : null}

      <MasterDetail
        list={
          <Picker
            rows={rows.map((m) => ({
              id: m.id,
              title: m.displayName,
              name: m.name,
              tags: [m.type, m.context],
            }))}
            selected={selected}
            onSelect={(id) => {
              setSelected(id);
              setError(undefined);
            }}
            empty="Nessuna mappa corrisponde ai filtri."
          >
            <SearchBox value={search} onChange={setSearch} placeholder="Cerca mappa" label="Cerca mappa" />
            <FilterSelect
              label="Tipo"
              value={type}
              onChange={setType}
              options={[
                { value: ALL, label: 'Tutti i tipi' },
                ...vocab.matchTypes.map((v) => ({ value: v, label: v })),
              ]}
            />
            <FilterSelect
              label="Contesto"
              value={context}
              onChange={setContext}
              options={[
                { value: ALL, label: 'Tutti' },
                ...vocab.matchContexts.map((v) => ({ value: v, label: v })),
              ]}
            />
          </Picker>
        }
        detail={
          selected === null ? (
            <Panel>
              <EmptyState
                title="Nessuna mappa"
                description="Le mappe si creano con l’editor in gioco: questa schermata ne modifica i metadati."
              />
            </Panel>
          ) : (
            <MapPanel
              key={selected}
              id={selected}
              vocab={vocab}
              modes={modes.data?.modes ?? []}
              onSaved={() => void qc.invalidateQueries({ queryKey: ['duels-config', 'maps'] })}
              onDeleted={() => {
                setSelected(null);
                void qc.invalidateQueries({ queryKey: ['duels-config', 'maps'] });
              }}
              onError={setError}
              // COSA PUO FARE, deciso una volta sola qui: 2 salva, 3 elimina.
              // Ricalcolarlo dentro il pannello vorrebbe dire due risposte alla
              // stessa domanda, e la seconda prima o poi diverge.
              canSave={canOpen(me, 'duels_maps', 2)}
              canDelete={canOpen(me, 'duels_maps', 3)}
            />
          )
        }
      />
    </main>
  );
}

function MapPanel({
  id,
  vocab,
  modes,
  onSaved,
  onDeleted,
  onError,
  canSave,
  canDelete,
}: {
  id: number;
  vocab: Vocabulary;
  modes: ConfigMode[];
  onSaved: () => void;
  onDeleted: () => void;
  onError: (message: string | undefined) => void;
  canSave: boolean;
  canDelete: boolean;
}) {
  const qc = useQueryClient();
  const detail = useQuery({
    queryKey: ['duels-config', 'map', id],
    queryFn: () => api<MapDetail>(`/api/duels/config/maps/${id}`),
  });

  const [core, setCore] = useState<{ displayName: string; type: string; context: string } | null>(null);
  const [values, setValues] = useState<Record<string, string> | null>(null);
  const [modeIds, setModeIds] = useState<number[] | null>(null);
  const [events, setEvents] = useState<string[] | null>(null);
  const [tab, setTab] = useState<Tab>('Modalità');
  const [editingCore, setEditingCore] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState<string | undefined>();

  const saved = detail.data;

  useEffect(() => {
    if (!saved) return;
    setCore({ displayName: saved.map.displayName, type: saved.map.type, context: saved.map.context });
    setValues(effectiveValues(vocab.mapSettings, saved.settings));
    setModeIds(saved.modeIds);
    setEvents(saved.eventTypes);
  }, [saved, vocab.mapSettings]);

  const savedValues = useMemo(
    () => (saved ? effectiveValues(vocab.mapSettings, saved.settings) : {}),
    [saved, vocab.mapSettings],
  );
  const changedKeys = useMemo(
    () => (values ? changedSettings(vocab.mapSettings, savedValues, values) : []),
    [values, savedValues, vocab.mapSettings],
  );

  const coreChanges = useMemo(() => {
    if (!saved || !core) return [] as string[];
    const out: string[] = [];
    if (core.displayName.trim() !== saved.map.displayName) out.push('displayName');
    if (core.type !== saved.map.type) out.push('type');
    if (core.context !== saved.map.context) out.push('context');
    return out;
  }, [saved, core]);

  const modesChanged = saved && modeIds ? !sameSet(saved.modeIds, modeIds) : false;
  const eventsChanged = saved && events ? !sameSet(saved.eventTypes, events) : false;

  const invalid = useMemo(
    () =>
      values
        ? vocab.mapSettings.filter((s) => !looksValid(s, values[s.key] ?? s.fallback)).map((s) => s.key)
        : [],
    [values, vocab.mapSettings],
  );

  const save = useMutation({
    mutationFn: async () => {
      if (!values || !core || !modeIds || !events) return null;
      const settings: Record<string, string> = {};
      for (const key of changedKeys) settings[key] = values[key] ?? '';
      return api<{ note: string }>(`/api/duels/config/maps/${id}`, {
        method: 'PATCH',
        body: {
          ...(coreChanges.includes('displayName') ? { displayName: core.displayName.trim() } : {}),
          ...(coreChanges.includes('type') ? { type: core.type } : {}),
          ...(coreChanges.includes('context') ? { context: core.context } : {}),
          ...(changedKeys.length > 0 ? { settings } : {}),
          // Si mandano SOLO se sono cambiati: mandarli sempre farebbe
          // ricalcolare al server una differenza che si sa gia' essere vuota,
          // e ogni salvataggio toccherebbe piu' tabelle del necessario.
          ...(modesChanged ? { modeIds } : {}),
          ...(eventsChanged ? { eventTypes: events } : {}),
        },
      });
    },
    onSuccess: (res) => {
      onError(undefined);
      setEditingCore(false);
      setNote(res?.note);
      void qc.invalidateQueries({ queryKey: ['duels-config', 'map', id] });
      onSaved();
    },
    onError: () => onError('Il database del gioco ha rifiutato la modifica. Niente è stato scritto.'),
  });

  const remove = useMutation({
    mutationFn: () => api(`/api/duels/config/maps/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      onError(undefined);
      onDeleted();
    },
    onError: () => onError('Eliminazione non riuscita.'),
  });

  if (detail.isError) return <Notice tone="err" title="Mappa non leggibile" />;
  if (!saved || !core || !values || !modeIds || !events) return <SkeletonRows rows={6} />;

  const changes = coreChanges.length + changedKeys.length + (modesChanged ? 1 : 0) + (eventsChanged ? 1 : 0);

  const reset = () => {
    setCore({ displayName: saved.map.displayName, type: saved.map.type, context: saved.map.context });
    setValues(effectiveValues(vocab.mapSettings, saved.settings));
    setModeIds(saved.modeIds);
    setEvents(saved.eventTypes);
    setEditingCore(false);
    setNote(undefined);
  };

  const byId = new Map(modes.map((m) => [m.id, m]));

  return (
    <>
      {/* CHI NON PUO SALVARE NON VEDE LA BARRA. Vedrebbe un pulsante che
          risponde 403, e su una schermata dove tutto e locale finche non si
          salva sarebbe anche peggio: le modifiche fatte sembrerebbero in
          attesa di essere scritte, e non lo sarebbero mai. */}
      <SaveBar
        changes={canSave && invalid.length === 0 ? changes : 0}
        saving={save.isPending}
        onSave={() => save.mutate()}
        onReset={reset}
      />
      {invalid.length > 0 ? (
        <Notice
          tone="err"
          title="Un valore non ha la forma giusta"
          description={`${invalid.join(', ')}: i decimali usano il punto, e gli interi non ammettono decimali.`}
        />
      ) : null}
      {note ? <Notice tone="info" title="Salvato" description={note} /> : null}

      <Panel>
        <BlockHeader
          title={saved.map.displayName}
          sub={`${saved.map.name} · ${saved.map.type} · ${saved.map.context}`}
        >
          {editingCore ? null : (
            <>
              {canSave ? (
                <Button size="sm" onClick={() => setEditingCore(true)}>
                  Modifica
                </Button>
              ) : null}
              {/* ELIMINARE STA UN GRADINO SOPRA: e la sola cosa irreversibile
                  di questa schermata, e chi puo cambiare un valore non per
                  questo puo portarsi via una riga e le sue cascate. */}
              {canDelete ? (
                <Button size="sm" variant="danger" onClick={() => setConfirming(true)}>
                  Elimina
                </Button>
              ) : null}
            </>
          )}
        </BlockHeader>

        {confirming ? (
          <ConfirmDelete
            what={saved.map.displayName}
            cascade="Rimuove a cascata modalità supportate, event type, settings, aree, location e team di questa mappa. Il mondo non viene toccato."
            busy={remove.isPending}
            onConfirm={() => remove.mutate()}
            onCancel={() => setConfirming(false)}
          />
        ) : null}

        {editingCore ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, padding: '0 14px 14px' }}>
            <label style={{ display: 'block', gridColumn: '1 / -1' }}>
              <span style={{ display: 'block', fontSize: 11.5, color: 'var(--tx-muted)', marginBottom: 5 }}>
                Nome visualizzato
              </span>
              <input
                className="input"
                value={core.displayName}
                onChange={(e) => setCore({ ...core, displayName: e.target.value })}
              />
            </label>
            <Choice
              label="Tipo"
              value={core.type}
              options={vocab.matchTypes}
              onChange={(v) => setCore({ ...core, type: v })}
            />
            <Choice
              label="Contesto"
              value={core.context}
              options={vocab.matchContexts}
              onChange={(v) => setCore({ ...core, context: v })}
            />
          </div>
        ) : null}
      </Panel>

      <Panel>
        <BlockHeader title="Configurazione mappa" sub="Modalità supportate, event type, settings e team">
          {tab === 'Modalità' ? (
            <Button size="sm" onClick={() => setAdding(true)}>
              Aggiungi modalità
            </Button>
          ) : null}
        </BlockHeader>

        <div style={{ display: 'flex', gap: 6, padding: '0 14px 12px' }}>
          {TABS.map((name) => (
            <Button
              key={name}
              size="sm"
              variant={name === tab ? 'primary' : 'ghost'}
              onClick={() => setTab(name)}
            >
              {name}
            </Button>
          ))}
        </div>

        {tab === 'Modalità' ? (
          modeIds.length === 0 ? (
            <div style={{ padding: '14px', fontSize: 12.5, color: 'var(--tx-muted)' }}>
              Nessuna modalità supportata da questa mappa.
            </div>
          ) : (
            modeIds.map((modeId) => {
              const mode = byId.get(modeId);
              const nuovo = !saved.modeIds.includes(modeId);
              return (
                <div
                  key={modeId}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '9px 14px',
                    borderTop: '1px solid var(--bd-subtle)',
                    background: nuovo ? 'var(--ac-soft)' : 'transparent',
                  }}
                >
                  <span style={{ fontSize: 13 }}>{mode?.displayName ?? `#${modeId}`}</span>
                  <span className="mono" style={{ fontSize: 11, color: 'var(--tx-muted)' }}>
                    {mode?.name ?? ''}
                  </span>
                  <span style={{ fontSize: 10.5, color: 'var(--tx-muted)' }}>{mode?.type ?? ''}</span>
                  <span style={{ marginLeft: 'auto' }}>
                    <Button size="sm" onClick={() => setModeIds(toggleIn(modeIds, modeId))}>
                      Rimuovi
                    </Button>
                  </span>
                </div>
              );
            })
          )
        ) : null}

        {/* Le modalita' TOLTE restano visibili finche' non si salva: sparendo,
            annullare vorrebbe dire ricordarsi quale si era tolta. */}
        {tab === 'Modalità'
          ? saved.modeIds
              .filter((m) => !modeIds.includes(m))
              .map((modeId) => (
                <div
                  key={`tolto-${modeId}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '9px 14px',
                    borderTop: '1px solid var(--bd-subtle)',
                    background: 'var(--err-soft)',
                  }}
                >
                  <span style={{ fontSize: 13, textDecoration: 'line-through', color: 'var(--tx-muted)' }}>
                    {byId.get(modeId)?.displayName ?? `#${modeId}`}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--tx-muted)' }}>da rimuovere</span>
                  <span style={{ marginLeft: 'auto' }}>
                    <Button size="sm" onClick={() => setModeIds(toggleIn(modeIds, modeId))}>
                      Annulla
                    </Button>
                  </span>
                </div>
              ))
          : null}

        {tab === 'Event type' ? (
          <div style={{ padding: 14 }}>
            <div style={{ fontSize: 11.5, color: 'var(--tx-muted)', marginBottom: 10 }}>
              Righe in <span className="mono">duels_map_event_type</span>. L’elenco contiene anche i valori
              già presenti nel database, per non toglierne uno che questo pannello non conosce.
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {vocab.eventTypes.map((type) => {
                const on = events.includes(type);
                return (
                  <Button
                    key={type}
                    size="sm"
                    variant={on ? 'primary' : 'secondary'}
                    onClick={() => setEvents(toggleIn(events, type))}
                  >
                    {type}
                  </Button>
                );
              })}
            </div>
          </div>
        ) : null}

        {tab === 'Settings'
          ? vocab.mapSettings.map((spec) => (
              <SettingRow
                key={spec.key}
                spec={spec}
                value={values[spec.key] ?? spec.fallback}
                changed={changedKeys.includes(spec.key)}
                onChange={(v) => setValues({ ...values, [spec.key]: v })}
              />
            ))
          : null}

        {tab === 'Team' ? (
          saved.teams.length === 0 ? (
            <div style={{ padding: 14, fontSize: 12.5, color: 'var(--tx-muted)' }}>
              Nessun team assegnato a questa mappa.
            </div>
          ) : (
            <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {/* SOLA LETTURA, come nel disegno: spawn e aree dei team si
                  posizionano in gioco, e un elenco che si potesse modificare
                  qui prometterebbe piu' di quello che fa. */}
              {saved.teams.map((team) => (
                <div key={team.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 3,
                      background: team.color,
                      flex: 'none',
                    }}
                  />
                  <span style={{ fontSize: 13 }}>{team.displayName}</span>
                  <span className="mono" style={{ fontSize: 11, color: 'var(--tx-muted)' }}>
                    {team.name}
                  </span>
                </div>
              ))}
            </div>
          )
        ) : null}
      </Panel>

      {adding ? (
        <AddModes
          modes={modes.filter((m) => !modeIds.includes(m.id))}
          onClose={() => setAdding(false)}
          onAdd={(ids) => {
            setModeIds([...modeIds, ...ids]);
            setAdding(false);
          }}
        />
      ) : null}
    </>
  );
}

function AddModes({
  modes,
  onClose,
  onAdd,
}: {
  modes: ConfigMode[];
  onClose: () => void;
  onAdd: (ids: number[]) => void;
}) {
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<number[]>([]);

  const q = search.trim().toLowerCase();
  const rows = modes.filter(
    (m) => q === '' || m.name.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q),
  );

  return (
    <Modal
      title="Aggiungi modalità"
      subtitle="La modifica resta locale: nel gioco arriva quando si salva."
      width={520}
      onClose={onClose}
      footer={
        <>
          <Button size="sm" onClick={onClose}>
            Annulla
          </Button>
          <Button size="sm" variant="primary" disabled={picked.length === 0} onClick={() => onAdd(picked)}>
            {picked.length > 0 ? `Aggiungi (${picked.length})` : 'Aggiungi'}
          </Button>
        </>
      }
    >
      <div style={{ marginBottom: 12 }}>
        <SearchBox value={search} onChange={setSearch} placeholder="Cerca modalità" label="Cerca modalità" />
      </div>
      {rows.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--tx-muted)' }}>Nessuna modalità da aggiungere.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 320, overflowY: 'auto' }}>
          {rows.map((mode) => {
            const on = picked.includes(mode.id);
            return (
              <button
                key={mode.id}
                type="button"
                onClick={() => setPicked(toggleIn(picked, mode.id))}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 10px',
                  border: 'none',
                  borderRadius: 'var(--r-sm)',
                  background: on ? 'var(--ac-soft)' : 'transparent',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <span
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: 'var(--r-xs)',
                    border: `1px solid ${on ? 'var(--ac)' : 'var(--bd-strong)'}`,
                    background: on ? 'var(--ac)' : 'transparent',
                    flex: 'none',
                  }}
                />
                <span style={{ fontSize: 13 }}>{mode.displayName}</span>
                <span className="mono" style={{ fontSize: 11, color: 'var(--tx-muted)' }}>
                  {mode.name}
                </span>
                <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--tx-muted)' }}>
                  {mode.type} · {mode.ranking}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

function Choice({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <span style={{ display: 'block', fontSize: 11.5, color: 'var(--tx-muted)', marginBottom: 5 }}>
        {label}
      </span>
      <div style={{ display: 'flex', gap: 6 }}>
        {options.map((option) => (
          <Button
            key={option}
            size="sm"
            variant={option === value ? 'primary' : 'secondary'}
            onClick={() => onChange(option)}
          >
            {option}
          </Button>
        ))}
      </div>
    </div>
  );
}
