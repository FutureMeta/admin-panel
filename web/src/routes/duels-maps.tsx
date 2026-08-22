// Duels · Maps. I metadati delle mappe, modificabili.
//
// LA GEOMETRIA DEI BLOCCHI NON E' QUI e non puo' esserlo: il mondo e' un blob
// SlimeWorld scritto dall'editor in gioco. Questa schermata cambia cio' che gli
// sta intorno — nome, tipo, contesto, quali modalita' ci si giocano, quali
// eventi, i settings della mappa — ed eliminare una mappa NON cancella il suo
// mondo.
//
// LE MISURE VENGONO DAL MOCKUP, non da una sua interpretazione: le tab, il
// pulsante accento che le chiude a destra, le righe delle modalita' con
// «Rimuovi» in rosso tenue. Vedi il commento in testa a `config-panels.tsx`
// per come mi era andata la prima volta.
//
// DUE COSE NON VENGONO DAL MOCKUP e sono state chieste dopo: le tab si chiamano
// Modalita'/Eventi/Settings invece dei nomi lunghi, e gli event type sono righe
// con un interruttore invece che pastiglie.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import {
  AccentBtn,
  ConfirmDelete,
  DangerBtn,
  DetailHead,
  ICON_CHECK,
  ICON_PLUS,
  MasterDetail,
  MenuFilter,
  ON_ACCENT,
  Picker,
  QuietBtn,
  RaisedBtn,
  SearchField,
  Section,
  SectionHead,
  Segmented,
  SettingRow,
  TextField,
  Toast,
  ToggleRow,
} from '../components/config-panels.tsx';
import { PageHeader } from '../components/page.tsx';
import { Icon, Modal, Notice, SkeletonRows } from '../components/ui.tsx';
import { ApiError, api, type Me } from '../lib/api.ts';
import { changedSettings, effectiveValues, sameSet, toggleIn, type Vocabulary } from '../lib/config-draft.ts';
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
};

const ALL = '__tutte__';
const TABS = ['Modalità', 'Eventi', 'Settings'] as const;
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
        sub="Metadati e riferimenti geometrici delle mappe · la geometria dei blocchi resta in-game"
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
              tagColors: [
                m.type === 'DUEL' ? 'var(--blu-viz)' : '#9B8FD9',
                m.context === 'EVENT' ? 'var(--ac-text)' : 'var(--tx-muted)',
              ],
              // Le mappe disattivate si attenuano: e' l'unica cosa che le
              // distingue nell'elenco, e senza sembrano attive come le altre.
              dim: !m.enabled,
            }))}
            selected={selected}
            onSelect={(id) => {
              setSelected(id);
              setError(undefined);
            }}
            empty="Nessuna mappa corrisponde ai filtri."
          >
            <SearchField value={search} onChange={setSearch} placeholder="Cerca mappa" label="Cerca mappa" />
            <MenuFilter
              label="Tipo"
              value={type}
              onChange={setType}
              width={120}
              options={[
                { value: ALL, label: 'Tutti' },
                ...vocab.matchTypes.map((v) => ({ value: v, label: v })),
              ]}
            />
            <MenuFilter
              label="Contesto"
              value={context}
              onChange={setContext}
              width={130}
              options={[
                { value: ALL, label: 'Tutti' },
                ...vocab.matchContexts.map((v) => ({ value: v, label: v })),
              ]}
            />
          </Picker>
        }
        detail={
          selected === null ? (
            <Section padded>
              <div style={{ fontSize: 12.5, color: 'var(--tx-muted)' }}>
                Nessuna mappa: si creano con l’editor in gioco, questa schermata ne modifica i metadati.
              </div>
            </Section>
          ) : (
            <MapPanel
              key={selected}
              id={selected}
              vocab={vocab}
              modes={modes.data?.modes ?? []}
              canSave={canOpen(me, 'duels_maps', 2)}
              canDelete={canOpen(me, 'duels_maps', 3)}
              onSaved={() => void qc.invalidateQueries({ queryKey: ['duels-config', 'maps'] })}
              onDeleted={() => {
                setSelected(null);
                void qc.invalidateQueries({ queryKey: ['duels-config', 'maps'] });
              }}
              onError={setError}
            />
          )
        }
      />
    </main>
  );
}

/**
 * Il messaggio di un salvataggio fallito.
 *
 * I PRIVILEGI MANCANTI SI DICONO PER NOME. In produzione il primo salvataggio è
 * morto con «DELETE command denied» e la schermata ha detto «il database del
 * gioco ha rifiutato la modifica»: vero, inutile, e indistinguibile da un
 * valore sbagliato. Chi legge deve capire che nella scheda non c'è niente da
 * correggere — manca una GRANT sul database del gioco, e la sistema qualcun
 * altro.
 */
function perche(err: unknown): string {
  if (err instanceof ApiError && err.code === 'privilegi_mancanti') {
    return 'Al pannello mancano i privilegi di scrittura sul database del gioco. Niente è stato scritto.';
  }
  return 'Il database del gioco ha rifiutato la modifica. Niente è stato scritto.';
}

type CoreDraft = { displayName: string; type: string; context: string };

function MapPanel({
  id,
  vocab,
  modes,
  canSave,
  canDelete,
  onSaved,
  onDeleted,
  onError,
}: {
  id: number;
  vocab: Vocabulary;
  modes: ConfigMode[];
  canSave: boolean;
  canDelete: boolean;
  onSaved: () => void;
  onDeleted: () => void;
  onError: (message: string | undefined) => void;
}) {
  const qc = useQueryClient();
  const detail = useQuery({
    queryKey: ['duels-config', 'map', id],
    queryFn: () => api<MapDetail>(`/api/duels/config/maps/${id}`),
  });

  const [core, setCore] = useState<CoreDraft | null>(null);
  const [values, setValues] = useState<Record<string, string> | null>(null);
  const [modeIds, setModeIds] = useState<number[] | null>(null);
  const [events, setEvents] = useState<string[] | null>(null);
  const [tab, setTab] = useState<Tab>('Modalità');
  const [editing, setEditing] = useState(false);
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

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ note: string }>(`/api/duels/config/maps/${id}`, { method: 'PATCH', body }),
    onSuccess: (res) => {
      onError(undefined);
      setEditing(false);
      setNote(res.note);
      void qc.invalidateQueries({ queryKey: ['duels-config', 'map', id] });
      onSaved();
    },
    onError: (err) => onError(perche(err)),
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

  const modesChanged = !sameSet(saved.modeIds, modeIds);
  const eventsChanged = !sameSet(saved.eventTypes, events);
  const configChanges = changedKeys.length + (modesChanged ? 1 : 0) + (eventsChanged ? 1 : 0);

  const cancelCore = () => {
    setCore({ displayName: saved.map.displayName, type: saved.map.type, context: saved.map.context });
    setEditing(false);
  };

  const saveConfig = () => {
    const settings: Record<string, string> = {};
    for (const key of changedKeys) settings[key] = values[key] ?? '';
    save.mutate({
      // Si manda SOLO cio' che e' cambiato: mandare tutto farebbe ricalcolare
      // al server differenze che si sanno gia' vuote, e ogni salvataggio
      // toccherebbe piu' tabelle del necessario.
      ...(changedKeys.length > 0 ? { settings } : {}),
      ...(modesChanged ? { modeIds } : {}),
      ...(eventsChanged ? { eventTypes: events } : {}),
    });
  };

  return (
    <>
      <Section padded>
        <DetailHead
          title={saved.map.displayName}
          name={saved.map.name}
          tags={[saved.map.type, saved.map.context]}
          tagColor={saved.map.type === 'DUEL' ? 'var(--blu-viz)' : '#9B8FD9'}
          actions={
            editing ? (
              <>
                <QuietBtn onClick={cancelCore} disabled={save.isPending}>
                  Annulla
                </QuietBtn>
                <AccentBtn
                  height={30}
                  disabled={save.isPending}
                  onClick={() =>
                    save.mutate({
                      displayName: core.displayName.trim(),
                      type: core.type,
                      context: core.context,
                    })
                  }
                >
                  Salva
                </AccentBtn>
              </>
            ) : (
              <>
                {canSave ? <RaisedBtn onClick={() => setEditing(true)}>Modifica</RaisedBtn> : null}
                {canDelete ? <DangerBtn onClick={() => setConfirming(true)}>Elimina</DangerBtn> : null}
              </>
            )
          }
        />

        {confirming ? (
          <ConfirmDelete
            what={saved.map.displayName}
            cascade="Rimuove a cascata modalità supportate, event type, settings, aree, location e team di questa mappa. Il mondo slime non viene toccato."
            busy={remove.isPending}
            onConfirm={() => remove.mutate()}
            onCancel={() => setConfirming(false)}
          />
        ) : null}

        {editing ? (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 14,
              marginTop: 18,
              paddingTop: 18,
              borderTop: '1px solid var(--bd-subtle)',
            }}
          >
            <div style={{ gridColumn: 'span 2' }}>
              <TextField
                label="Nome visualizzato"
                value={core.displayName}
                onChange={(v) => setCore({ ...core, displayName: v })}
              />
            </div>
            <Segmented
              label="Tipo"
              value={core.type}
              options={vocab.matchTypes}
              onChange={(v) => setCore({ ...core, type: v })}
            />
            <Segmented
              label="Contesto"
              value={core.context}
              options={vocab.matchContexts}
              onChange={(v) => setCore({ ...core, context: v })}
            />
          </div>
        ) : null}
      </Section>

      <Section>
        <SectionHead
          title="Configurazione mappa"
          sub="Modalità supportate, event type e settings"
          action={
            <AccentBtn
              onClick={saveConfig}
              disabled={save.isPending}
              style={{ visibility: canSave && configChanges > 0 ? 'visible' : 'hidden' }}
            >
              Salva
            </AccentBtn>
          }
        />

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            padding: '12px 20px',
            borderBottom: '1px solid var(--bd-subtle)',
          }}
        >
          {TABS.map((name) => {
            const on = name === tab;
            return (
              <button
                key={name}
                type="button"
                onClick={() => setTab(name)}
                style={{
                  border: 'none',
                  borderRadius: 'var(--r-sm)',
                  background: on ? 'var(--s-overlay)' : 'transparent',
                  color: on ? 'var(--tx-primary)' : 'var(--tx-muted)',
                  fontFamily: 'var(--font-ui)',
                  fontSize: 12.5,
                  fontWeight: 600,
                  padding: '7px 12px',
                  cursor: 'pointer',
                }}
              >
                {name}
              </button>
            );
          })}
          {tab === 'Modalità' && canSave ? (
            <AccentBtn height={28} onClick={() => setAdding(true)} style={{ marginLeft: 'auto' }}>
              <Icon path={ICON_PLUS} size={13} stroke={2} />
              Aggiungi modalità
            </AccentBtn>
          ) : null}
        </div>

        {tab === 'Modalità' ? (
          // OLTRE LE DIECI RIGHE SI SCORRE. Una mappa con trenta modalità
          // allungava il riquadro finché il pulsante Salva usciva dallo
          // schermo: si tolgono due modalità e poi si cerca dove è finito ciò
          // che le rende vere. Il taglio cade a metà dell'undicesima riga
          // apposta — una riga tagliata dice «ce n'è ancora» senza scriverlo.
          //
          // Niente margini laterali qui: le righe vanno a tutta larghezza e il
          // loro `20px` se lo portano dietro, come i settings di mappa.
          <div style={{ maxHeight: 460, overflowY: 'auto' }}>
            {modeIds.length === 0 && saved.modeIds.length === 0 ? (
              <div style={{ padding: '16px 20px', fontSize: 12.5, color: 'var(--tx-muted)' }}>
                Nessuna modalità supportata da questa mappa.
              </div>
            ) : null}

            {/* UNA LISTA SOLA, nell'ordine dell'elenco modalità: una riga tolta
                resta al suo posto invece di saltare in fondo, e ciò che cambia
                è il colore. Spostarla renderebbe due modifiche — quella fatta e
                il riordino — dove ce n'è una sola. */}
            {modes
              .filter((mode) => modeIds.includes(mode.id) || saved.modeIds.includes(mode.id))
              .map((mode) => {
                const aggiunta = !saved.modeIds.includes(mode.id);
                const tolta = !modeIds.includes(mode.id);
                return (
                  <ModeRow
                    key={mode.id}
                    name={mode.displayName}
                    type={mode.type}
                    tone={aggiunta ? 'added' : tolta ? 'removed' : 'plain'}
                    action={
                      aggiunta || tolta ? (
                        <RowUndoBtn onClick={() => setModeIds(toggleIn(modeIds, mode.id))} />
                      ) : canSave ? (
                        <RowRemoveBtn onClick={() => setModeIds(toggleIn(modeIds, mode.id))} />
                      ) : null
                    }
                  />
                );
              })}
          </div>
        ) : null}

        {tab === 'Eventi'
          ? vocab.eventTypes.map((eventType) => (
              <ToggleRow
                key={eventType}
                code={eventType}
                on={events.includes(eventType)}
                disabled={!canSave}
                onChange={() => setEvents(toggleIn(events, eventType))}
              />
            ))
          : null}

        {tab === 'Settings'
          ? vocab.mapSettings.map((spec) => (
              <SettingRow
                key={spec.key}
                spec={spec}
                value={values[spec.key] ?? spec.fallback}
                columns="1fr 60px 200px 110px"
                padding="10px 20px"
                variant="maps"
                onChange={(v) => setValues({ ...values, [spec.key]: v })}
              />
            ))
          : null}
      </Section>

      {adding ? (
        <AddModes
          modes={modes.filter((m) => !modeIds.includes(m.id) && !saved.modeIds.includes(m.id))}
          onClose={() => setAdding(false)}
          onAdd={(ids) => {
            setModeIds([...modeIds, ...ids]);
            setAdding(false);
          }}
        />
      ) : null}

      {note ? <Toast message={note} onDone={() => setNote(undefined)} /> : null}
    </>
  );
}

/**
 * I due pulsanti che stanno DENTRO una riga: 26px, misure del mockup.
 *
 * Non sono QuietBtn e DangerBtn con un'altezza diversa: il disegno li vuole
 * con dieci pixel di lato invece di dodici, e «Rimuovi» senza grassetto. Sono
 * differenze piccole ed è proprio il tipo di differenza che, messa accanto al
 * disegno, fa sembrare due schermate disegnate da due persone.
 */
function RowUndoBtn({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        height: 26,
        padding: '0 10px',
        border: '1px solid var(--bd-strong)',
        borderRadius: 'var(--r-sm)',
        background: 'var(--s-elevated)',
        color: 'var(--tx-primary)',
        fontFamily: 'var(--font-ui)',
        fontSize: 11.5,
        fontWeight: 500,
        cursor: 'pointer',
        flex: 'none',
      }}
    >
      Annulla
    </button>
  );
}

function RowRemoveBtn({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        height: 26,
        padding: '0 10px',
        border: '1px solid rgba(219,52,52,.4)',
        borderRadius: 'var(--r-sm)',
        background: 'var(--err-soft)',
        color: 'var(--err)',
        fontFamily: 'var(--font-ui)',
        fontSize: 11.5,
        cursor: 'pointer',
        flex: 'none',
      }}
    >
      Rimuovi
    </button>
  );
}

/** Una riga della tab «Modalità»: nome, tipo, e l'azione a destra. */
function ModeRow({
  name,
  type,
  tone,
  action,
}: {
  name: string;
  type: string;
  tone: 'plain' | 'added' | 'removed';
  action: React.ReactNode;
}) {
  // LA STESSA RIGA DEI SETTINGS DI MAPPA: a tutta larghezza, `10px 20px`, e un
  // filetto sotto invece di una scheda con il bordo tutt'intorno. Erano due
  // elenchi nello stesso riquadro disegnati in due modi, e la differenza si
  // vedeva passando da una tab all'altra.
  //
  // LO STATO RESTA IL FONDO, e il bordo se ne va. Il filetto separa le righe;
  // aggiungere anche una cornice colorata su una riga a tutta larghezza
  // significa disegnare due separatori sovrapposti. Il colore basta:
  // AGGIUNTA E' VERDE, non arancione — nel disegno l'arancione è l'accento
  // dell'interfaccia, i pulsanti e la selezione, e usarlo per uno stato dei
  // dati confonde le due cose su una schermata che ne mostra tre insieme.
  const background =
    tone === 'added' ? 'var(--ok-soft)' : tone === 'removed' ? 'var(--err-soft)' : 'transparent';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 20px',
        borderBottom: '1px solid var(--bd-subtle)',
        background,
      }}
    >
      <span style={{ fontSize: 13, flex: 1, color: 'var(--tx-primary)' }}>{name}</span>
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.04em', color: 'var(--tx-muted)' }}>
        {type}
      </span>
      {action}
    </div>
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
  const [type, setType] = useState(ALL);
  const [ranking, setRanking] = useState(ALL);
  const [picked, setPicked] = useState<number[]>([]);

  const q = search.trim().toLowerCase();
  const rows = modes.filter(
    (m) =>
      (type === ALL || m.type === type) &&
      (ranking === ALL || m.ranking === ranking) &&
      (q === '' || m.name.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q)),
  );

  return (
    <Modal
      title="Aggiungi modalità"
      width={440}
      dense
      onClose={onClose}
      footer={
        <>
          <QuietBtn onClick={onClose} height={34}>
            Annulla
          </QuietBtn>
          <AccentBtn height={34} disabled={picked.length === 0} onClick={() => onAdd(picked)}>
            {picked.length > 0 ? `Aggiungi (${picked.length})` : 'Aggiungi'}
          </AccentBtn>
        </>
      }
    >
      <div
        style={{
          display: 'flex',
          gap: 6,
          padding: '14px 20px',
          borderBottom: '1px solid var(--bd-subtle)',
          flex: 'none',
        }}
      >
        <SearchField
          value={search}
          onChange={setSearch}
          placeholder="Cerca modalità"
          label="Cerca modalità"
        />
        <MenuFilter
          label="Tipo"
          value={type}
          onChange={setType}
          width={120}
          options={[
            { value: ALL, label: 'Tutti' },
            { value: 'DUEL', label: 'DUEL' },
            { value: 'FFA', label: 'FFA' },
          ]}
        />
        <MenuFilter
          label="Ranking"
          value={ranking}
          onChange={setRanking}
          width={130}
          options={[
            { value: ALL, label: 'Tutti' },
            { value: 'RANKED', label: 'RANKED' },
            { value: 'UNRANKED', label: 'UNRANKED' },
          ]}
        />
      </div>

      {rows.length === 0 ? (
        <div style={{ padding: 20, textAlign: 'center', fontSize: 12.5, color: 'var(--tx-muted)' }}>
          Nessuna modalità corrisponde ai filtri.
        </div>
      ) : (
        <div
          style={{
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            padding: '4px 8px',
            flex: 1,
            minHeight: 0,
          }}
        >
          {rows.map((mode) => {
            const on = picked.includes(mode.id);
            return (
              <button
                key={mode.id}
                type="button"
                onClick={() => setPicked(toggleIn(picked, mode.id))}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '10px 8px',
                  border: 'none',
                  borderBottom: '1px solid var(--bd-subtle)',
                  borderRadius: 'var(--r-sm)',
                  background: on ? 'var(--ac-soft)' : 'transparent',
                  cursor: 'pointer',
                }}
              >
                <span
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 'var(--r-xs)',
                    border: `1.5px solid ${on ? 'transparent' : 'var(--bd-strong)'}`,
                    background: on ? 'var(--ac)' : 'transparent',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flex: 'none',
                    color: ON_ACCENT,
                  }}
                >
                  {on ? <Icon path={ICON_CHECK} size={11} stroke={3} /> : null}
                </span>
                <span style={{ fontSize: 13, color: 'var(--tx-primary)', flex: 1 }}>{mode.displayName}</span>
                <span
                  style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.04em', color: 'var(--tx-muted)' }}
                >
                  {mode.type}
                </span>
                <span style={{ fontSize: 10, color: 'var(--tx-muted)', width: 64, textAlign: 'right' }}>
                  {mode.ranking}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
