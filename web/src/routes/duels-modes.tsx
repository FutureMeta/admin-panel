// Duels · Modes. Le modalita' del gioco, modificabili.
//
// TUTTO RESTA LOCALE FINCHE' NON SI SALVA. Spegnere un interruttore, cambiare
// un numero, rinominare una modalita' non manda niente da nessuna parte: si
// modifica una bozza, e la barra del salvataggio compare solo quando quella
// bozza si discosta da cio' che e' scritto nel database.
//
// UN SOLO SALVA PER TUTTO IL DETTAGLIO, e non uno per riquadro come nel
// disegno. Due ragioni, e la seconda conta piu' della prima: il pulsante e' la
// risposta alla domanda «quello che ho fatto e' nel gioco o soltanto qui?», e
// con due pulsanti la risposta e' due risposte; e i campi e i settings di una
// modalita' finiscono cosi' in UNA transazione, invece di due scritture di cui
// la seconda puo' fallire lasciando la prima.
//
// SI LEGGE DAL MYSQL DEL GIOCO, non dall'aggregato di Postgres che disegna
// trends e ratings: quello ha trenta secondi di ritardo, e qui si
// modificherebbe una cosa guardandone un'altra.

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
import { Button, EmptyState, ICONS, Icon, Notice, SkeletonRows } from '../components/ui.tsx';
import { api, type Me } from '../lib/api.ts';
import {
  changedSettings,
  effectiveValues,
  looksValid,
  overrideCount,
  type SettingSpec,
  type Vocabulary,
} from '../lib/config-draft.ts';
import { canOpen } from '../lib/modules.ts';

type ConfigMode = {
  id: number;
  name: string;
  displayName: string;
  type: string;
  ranking: string;
  overrides: number;
};

type ModeDetail = { mode: ConfigMode; settings: Array<{ key: string; value: string }> };

const ALL = '__tutte__';

export function DuelsModesRoute({ me }: { me: Me }) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [type, setType] = useState(ALL);
  const [ranking, setRanking] = useState(ALL);
  const [error, setError] = useState<string | undefined>();

  const vocabulary = useQuery({
    queryKey: ['duels-config', 'vocabulary'],
    queryFn: () => api<Vocabulary>('/api/duels/config/vocabulary'),
    staleTime: 5 * 60_000,
  });
  const list = useQuery({
    queryKey: ['duels-config', 'modes'],
    queryFn: () => api<{ modes: ConfigMode[] }>('/api/duels/config/modes'),
  });

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (list.data?.modes ?? []).filter(
      (m) =>
        (type === ALL || m.type === type) &&
        (ranking === ALL || m.ranking === ranking) &&
        (q === '' || m.name.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q)),
    );
  }, [list.data, search, type, ranking]);

  // La prima della lista si apre da sola: una schermata elenco+dettaglio che
  // parte con il dettaglio vuoto chiede un clic per mostrare qualunque cosa.
  useEffect(() => {
    if (selected === null && rows.length > 0) setSelected(rows[0]?.id ?? null);
  }, [rows, selected]);

  if (!canOpen(me, 'duels', 3)) {
    return (
      <>
        <PageHeader title="Duels · Modes" sub="Configurazione delle modalità" />
        <Notice
          tone="err"
          title="Non hai accesso a questa schermata"
          description="Serve il livello «Gestione» sul modulo Duels: è quello che permette di cambiare le regole con cui si gioca."
        />
      </>
    );
  }

  if (list.isError || vocabulary.isError) {
    return (
      <>
        <PageHeader title="Duels · Modes" sub="Configurazione delle modalità" />
        <Notice
          tone="err"
          title="Configurazione non disponibile"
          description="Non è stato possibile leggere le modalità dal database del gioco. Riprova fra poco."
        />
      </>
    );
  }

  const vocab = vocabulary.data;
  if (!list.data || !vocab) {
    return (
      <>
        <PageHeader title="Duels · Modes" sub="Configurazione delle modalità" />
        <SkeletonRows rows={8} />
      </>
    );
  }

  return (
    <main style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <PageHeader
        title="Duels · Modes"
        sub={`${list.data.modes.length} modalità · lette dalla stessa tabella dei server di gioco`}
      />
      {error ? <Notice tone="err" title="Salvataggio non riuscito" description={error} /> : null}

      <MasterDetail
        list={
          <Picker
            rows={rows.map((m) => ({
              id: m.id,
              title: m.displayName,
              name: m.name,
              tags: [m.type, m.ranking],
            }))}
            selected={selected}
            onSelect={(id) => {
              setSelected(id);
              setError(undefined);
            }}
            empty="Nessuna modalità corrisponde ai filtri."
          >
            <SearchBox
              value={search}
              onChange={setSearch}
              placeholder="Cerca modalità"
              label="Cerca modalità"
            />
            <FilterSelect
              label="Tipo"
              value={type}
              onChange={setType}
              options={[
                { value: ALL, label: 'Tutti i tipi' },
                ...vocab.modeTypes.map((v) => ({ value: v, label: v })),
              ]}
            />
            <FilterSelect
              label="Ranking"
              value={ranking}
              onChange={setRanking}
              options={[
                { value: ALL, label: 'Tutti' },
                ...vocab.rankingTypes.map((v) => ({ value: v, label: v })),
              ]}
            />
          </Picker>
        }
        detail={
          selected === null ? (
            <Panel>
              <EmptyState
                title="Nessuna modalità"
                description="Le modalità si creano in gioco: questa schermata le modifica."
              />
            </Panel>
          ) : (
            <ModePanel
              key={selected}
              id={selected}
              vocab={vocab}
              onSaved={() => {
                void qc.invalidateQueries({ queryKey: ['duels-config', 'modes'] });
              }}
              onDeleted={() => {
                setSelected(null);
                void qc.invalidateQueries({ queryKey: ['duels-config', 'modes'] });
              }}
              onError={setError}
            />
          )
        }
      />
    </main>
  );
}

function ModePanel({
  id,
  vocab,
  onSaved,
  onDeleted,
  onError,
}: {
  id: number;
  vocab: Vocabulary;
  onSaved: () => void;
  onDeleted: () => void;
  onError: (message: string | undefined) => void;
}) {
  const qc = useQueryClient();
  const detail = useQuery({
    queryKey: ['duels-config', 'mode', id],
    queryFn: () => api<ModeDetail>(`/api/duels/config/modes/${id}`),
  });

  const [core, setCore] = useState<{ displayName: string; type: string; ranking: string } | null>(null);
  const [values, setValues] = useState<Record<string, string> | null>(null);
  const [editingCore, setEditingCore] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [note, setNote] = useState<string | undefined>();

  const saved = detail.data;

  // LA BOZZA SI RIPRENDE DA CIO' CHE ARRIVA, ogni volta che arriva. Senza
  // questo, dopo un salvataggio la schermata continuerebbe a mostrare la bozza
  // vecchia e il pulsante resterebbe acceso su modifiche gia' scritte.
  useEffect(() => {
    if (!saved) return;
    setCore({ displayName: saved.mode.displayName, type: saved.mode.type, ranking: saved.mode.ranking });
    setValues(effectiveValues(vocab.modeSettings, saved.settings));
  }, [saved, vocab.modeSettings]);

  const savedValues = useMemo(
    () => (saved ? effectiveValues(vocab.modeSettings, saved.settings) : {}),
    [saved, vocab.modeSettings],
  );

  const changedKeys = useMemo(
    () => (values ? changedSettings(vocab.modeSettings, savedValues, values) : []),
    [values, savedValues, vocab.modeSettings],
  );

  const coreChanges = useMemo(() => {
    if (!saved || !core) return [] as string[];
    const out: string[] = [];
    if (core.displayName.trim() !== saved.mode.displayName) out.push('displayName');
    if (core.type !== saved.mode.type) out.push('type');
    if (core.ranking !== saved.mode.ranking) out.push('ranking');
    return out;
  }, [saved, core]);

  const invalid = useMemo(
    () =>
      values
        ? vocab.modeSettings.filter((s) => !looksValid(s, values[s.key] ?? s.fallback)).map((s) => s.key)
        : [],
    [values, vocab.modeSettings],
  );

  const save = useMutation({
    mutationFn: async () => {
      if (!values || !core) return null;
      const settings: Record<string, string> = {};
      for (const key of changedKeys) settings[key] = values[key] ?? '';
      return api<{ note: string }>(`/api/duels/config/modes/${id}`, {
        method: 'PATCH',
        body: {
          ...(coreChanges.includes('displayName') ? { displayName: core.displayName.trim() } : {}),
          ...(coreChanges.includes('type') ? { type: core.type } : {}),
          ...(coreChanges.includes('ranking') ? { ranking: core.ranking } : {}),
          ...(changedKeys.length > 0 ? { settings } : {}),
        },
      });
    },
    onSuccess: (res) => {
      onError(undefined);
      setEditingCore(false);
      setNote(res?.note);
      void qc.invalidateQueries({ queryKey: ['duels-config', 'mode', id] });
      onSaved();
    },
    onError: () => onError('Il database del gioco ha rifiutato la modifica. Niente è stato scritto.'),
  });

  const remove = useMutation({
    mutationFn: () => api(`/api/duels/config/modes/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      onError(undefined);
      onDeleted();
    },
    onError: () => onError('Eliminazione non riuscita.'),
  });

  if (detail.isError) return <Notice tone="err" title="Modalità non leggibile" />;
  if (!saved || !core || !values) return <SkeletonRows rows={6} />;

  const changes = coreChanges.length + changedKeys.length;
  // I gruppi si ricavano dai settings e mantengono l'ordine in cui compaiono
  // nel registro: e' quello con cui il server li manda, ed e' l'ordine in cui
  // si leggono.
  const groups = new Map<string, SettingSpec[]>();
  for (const spec of vocab.modeSettings) {
    const bucket = groups.get(spec.group);
    if (bucket) bucket.push(spec);
    else groups.set(spec.group, [spec]);
  }
  const query = filter.trim().toLowerCase();
  const matches = (spec: SettingSpec) =>
    query === '' || spec.label.toLowerCase().includes(query) || spec.key.toLowerCase().includes(query);

  const reset = () => {
    setCore({ displayName: saved.mode.displayName, type: saved.mode.type, ranking: saved.mode.ranking });
    setValues(effectiveValues(vocab.modeSettings, saved.settings));
    setEditingCore(false);
    setNote(undefined);
  };

  return (
    <>
      <SaveBar
        changes={invalid.length > 0 ? 0 : changes}
        saving={save.isPending}
        onSave={() => save.mutate()}
        onReset={reset}
      />
      {invalid.length > 0 ? (
        <Notice
          tone="err"
          title="Un valore non ha la forma giusta"
          description={`${invalid.join(', ')}: i decimali usano il punto, e gli interi non ammettono decimali. Il plugin non saprebbe rileggerlo.`}
        />
      ) : null}
      {note ? <Notice tone="info" title="Salvato" description={note} /> : null}

      <Panel>
        <BlockHeader
          title={saved.mode.displayName}
          sub={`${saved.mode.name} · ${saved.mode.type} · ${saved.mode.ranking}`}
        >
          {editingCore ? null : (
            <>
              <Button size="sm" onClick={() => setEditingCore(true)}>
                Modifica
              </Button>
              <Button size="sm" variant="danger" onClick={() => setConfirming(true)}>
                Elimina
              </Button>
            </>
          )}
        </BlockHeader>

        {confirming ? (
          <ConfirmDelete
            what={saved.mode.displayName}
            cascade="Rimuove a cascata i suoi settings, i kit e i preferiti dei giocatori."
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
              options={vocab.modeTypes}
              onChange={(v) => setCore({ ...core, type: v })}
            />
            <Choice
              label="Ranking"
              value={core.ranking}
              options={vocab.rankingTypes}
              onChange={(v) => setCore({ ...core, ranking: v })}
            />
            {/* Il nome interno e l'icona non ci sono: il primo e' la chiave con
                cui i preferiti dei giocatori puntano a questa modalita'. */}
          </div>
        ) : null}
      </Panel>

      <Panel>
        <BlockHeader
          title="Impostazioni di modalità"
          sub={`${vocab.modeSettings.length} settings in ${groups.size} categorie · ${overrideCount(vocab.modeSettings, values)} personalizzati`}
        />
        <div style={{ padding: '0 14px 12px' }}>
          <SearchBox
            value={filter}
            onChange={setFilter}
            placeholder="Filtra tutti i settings"
            label="Filtra i settings"
          />
        </div>

        {[...groups.entries()].map(([group, specs]) => {
          const shown = specs.filter(matches);
          if (shown.length === 0) return null;
          // Con un filtro attivo i gruppi si aprono da soli: cercare e non
          // vedere niente perche' la sezione e' chiusa sembra «non c'e'».
          const isOpen = query !== '' || (open[group] ?? false);
          const custom = specs.filter((s) => (values[s.key] ?? s.fallback) !== s.fallback).length;

          return (
            <div key={group}>
              <button
                type="button"
                onClick={() => setOpen({ ...open, [group]: !isOpen })}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  padding: '9px 14px',
                  border: 'none',
                  borderTop: '1px solid var(--bd-subtle)',
                  background: 'var(--s-inset)',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <Icon
                  path={ICONS.chevron}
                  size={13}
                  style={{ transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform var(--dur)' }}
                />
                <span style={{ fontSize: 12.5, fontWeight: 500 }}>{group}</span>
                <span style={{ fontSize: 11, color: 'var(--tx-muted)' }}>{shown.length} settings</span>
                {custom > 0 ? (
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--ac-text)' }}>
                    {custom} personalizzati
                  </span>
                ) : null}
              </button>

              {isOpen
                ? shown.map((spec) => (
                    <SettingRow
                      key={spec.key}
                      spec={spec}
                      value={values[spec.key] ?? spec.fallback}
                      changed={changedKeys.includes(spec.key)}
                      onChange={(v) => setValues({ ...values, [spec.key]: v })}
                    />
                  ))
                : null}
            </div>
          );
        })}
      </Panel>
    </>
  );
}

/** Due o tre scelte affiancate: piu' corto di un elenco a discesa da leggere. */
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
