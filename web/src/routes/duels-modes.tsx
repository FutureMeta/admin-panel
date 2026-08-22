// Duels · Modes. Le modalita' del gioco, modificabili.
//
// TUTTO RESTA LOCALE FINCHE' NON SI SALVA, e i due Salva sono due perche' il
// disegno ne ha due: quello del riquadro principale compare entrando in
// modifica, quello dei settings compare solo quando un setting e' cambiato —
// nel mockup e' `visibility`, quindi lo spazio resta occupato e l'intestazione
// non si muove.
//
// SI LEGGE DAL MYSQL DEL GIOCO, non dall'aggregato di Postgres che disegna
// trends e ratings: quello ha trenta secondi di ritardo, e qui si
// modificherebbe una cosa guardandone un'altra.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import {
  AccentBtn,
  ConfirmDelete,
  DangerBtn,
  DetailHead,
  MasterDetail,
  MenuFilter,
  Picker,
  prettyKey,
  QuietBtn,
  RaisedBtn,
  SearchField,
  Section,
  SectionHead,
  Segmented,
  SettingRow,
  TextField,
  Toast,
} from '../components/config-panels.tsx';
import { PageHeader } from '../components/page.tsx';
import { ICONS, Icon, Notice, SkeletonRows } from '../components/ui.tsx';
import { ApiError, api, type Me } from '../lib/api.ts';
import {
  changedSettings,
  effectiveValues,
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

  // La prima della lista si apre da sola: un elenco+dettaglio che parte con il
  // dettaglio vuoto chiede un clic per mostrare qualunque cosa.
  useEffect(() => {
    if (selected === null && rows.length > 0) setSelected(rows[0]?.id ?? null);
  }, [rows, selected]);

  if (!canOpen(me, 'duels_modes')) {
    return (
      <>
        <PageHeader title="Duels · Modes" sub="Configurazione delle modalità" />
        <Notice
          tone="err"
          title="Non hai accesso a questa schermata"
          description="Serve almeno il livello «Lettura» sul modulo Modes."
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
        sub="Modalità Duel/FFA · lette dalla stessa cache in memoria dei server di gioco"
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
              tagColors: [
                m.type === 'DUEL' ? 'var(--blu-viz)' : '#9B8FD9',
                m.ranking === 'RANKED' ? 'var(--ac-text)' : 'var(--tx-muted)',
              ],
            }))}
            selected={selected}
            onSelect={(id) => {
              setSelected(id);
              setError(undefined);
            }}
            empty="Nessuna modalità corrisponde ai filtri."
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
                ...vocab.modeTypes.map((v) => ({ value: v, label: v })),
              ]}
            />
            <MenuFilter
              label="Ranking"
              value={ranking}
              onChange={setRanking}
              width={130}
              options={[
                { value: ALL, label: 'Tutti' },
                // RANKED prima di UNRANKED, come nel disegno: l'ordine del
                // vocabolario e' quello del database, non quello del menu.
                ...['RANKED', 'UNRANKED'].map((v) => ({ value: v, label: v })),
              ]}
            />
          </Picker>
        }
        detail={
          selected === null ? (
            <Section padded>
              <div style={{ fontSize: 12.5, color: 'var(--tx-muted)' }}>
                Nessuna modalità: si creano in gioco, questa schermata le modifica.
              </div>
            </Section>
          ) : (
            <ModePanel
              key={selected}
              id={selected}
              vocab={vocab}
              canSave={canOpen(me, 'duels_modes', 2)}
              canDelete={canOpen(me, 'duels_modes', 3)}
              onSaved={() => void qc.invalidateQueries({ queryKey: ['duels-config', 'modes'] })}
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

type CoreDraft = { displayName: string; type: string; ranking: string };

function ModePanel({
  id,
  vocab,
  canSave,
  canDelete,
  onSaved,
  onDeleted,
  onError,
}: {
  id: number;
  vocab: Vocabulary;
  canSave: boolean;
  canDelete: boolean;
  onSaved: () => void;
  onDeleted: () => void;
  onError: (message: string | undefined) => void;
}) {
  const qc = useQueryClient();
  const detail = useQuery({
    queryKey: ['duels-config', 'mode', id],
    queryFn: () => api<ModeDetail>(`/api/duels/config/modes/${id}`),
  });

  const [core, setCore] = useState<CoreDraft | null>(null);
  const [values, setValues] = useState<Record<string, string> | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [note, setNote] = useState<string | undefined>();

  const saved = detail.data;

  // LA BOZZA SI RIPRENDE DA CIO' CHE ARRIVA, ogni volta che arriva. Senza,
  // dopo un salvataggio la schermata continuerebbe a mostrare la bozza vecchia
  // e il Salva resterebbe acceso su modifiche gia' scritte.
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

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ note: string }>(`/api/duels/config/modes/${id}`, { method: 'PATCH', body }),
    onSuccess: (res) => {
      onError(undefined);
      setEditing(false);
      setNote(res.note);
      void qc.invalidateQueries({ queryKey: ['duels-config', 'mode', id] });
      onSaved();
    },
    onError: (err) => onError(perche(err)),
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

  const query = filter.trim().toLowerCase();
  // Cerca sia nella costante sia nell'etichetta: chi legge «Shield Stun»
  // scrive «shield stun», e non trovare niente sembra «non esiste».
  const matches = (spec: SettingSpec) =>
    query === '' ||
    spec.key.toLowerCase().includes(query) ||
    prettyKey(spec.key).toLowerCase().includes(query);

  // CON LA RICERCA ATTIVA I SEI GRUPPI SPARISCONO e resta una sezione sola,
  // «Risultati», sempre aperta. È ciò che fa il mockup, ed è anche l'unica
  // cosa sensata: cercando fra sei sezioni che si aprono tutte da sole
  // restano sei intestazioni in mezzo ai risultati, ognuna con un conteggio
  // che è quello dei risultati e non quello del gruppo.
  const groups = new Map<string, SettingSpec[]>();
  if (query === '') {
    for (const group of vocab.modeSettingGroups) groups.set(group, []);
    for (const spec of vocab.modeSettings) {
      // Un setting con un gruppo che l'elenco non dichiara non sparisce:
      // finisce in fondo, in una sezione con il suo nome. Sparire sarebbe il
      // modo silenzioso di rendere immodificabile un setting.
      const key = spec.group ?? 'Altri';
      const bucket = groups.get(key);
      if (bucket) bucket.push(spec);
      else groups.set(key, [spec]);
    }
  } else {
    groups.set('Risultati', vocab.modeSettings.filter(matches));
  }

  const cancelCore = () => {
    setCore({ displayName: saved.mode.displayName, type: saved.mode.type, ranking: saved.mode.ranking });
    setEditing(false);
  };

  return (
    <>
      <Section padded>
        <DetailHead
          title={saved.mode.displayName}
          name={saved.mode.name}
          tags={[saved.mode.type, saved.mode.ranking]}
          tagColor={saved.mode.type === 'DUEL' ? 'var(--blu-viz)' : '#9B8FD9'}
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
                      ranking: core.ranking,
                    })
                  }
                >
                  Salva
                </AccentBtn>
              </>
            ) : (
              <>
                {canSave ? <RaisedBtn onClick={() => setEditing(true)}>Modifica</RaisedBtn> : null}
                {/* ELIMINARE STA UN GRADINO SOPRA: è la sola cosa irreversibile
                    di questa schermata, e chi può cambiare un valore non per
                    questo può portarsi via una riga e le sue cascate. */}
                {canDelete ? <DangerBtn onClick={() => setConfirming(true)}>Elimina</DangerBtn> : null}
              </>
            )
          }
        />

        {confirming ? (
          <ConfirmDelete
            what={saved.mode.displayName}
            cascade="Rimuove a cascata i suoi settings, i kit e i preferiti dei giocatori. Non è reversibile."
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
            <TextField
              label="Nome visualizzato"
              value={core.displayName}
              onChange={(v) => setCore({ ...core, displayName: v })}
            />
            <Segmented
              label="Tipo"
              value={core.type}
              options={vocab.modeTypes}
              onChange={(v) => setCore({ ...core, type: v })}
            />
            <Segmented
              label="Ranking"
              value={core.ranking}
              options={vocab.rankingTypes}
              onChange={(v) => setCore({ ...core, ranking: v })}
            />
            {/* Il nome interno e l'icona non ci sono, come nel disegno: il primo
                è la chiave con cui i preferiti dei giocatori puntano qui. */}
          </div>
        ) : null}
      </Section>

      <Section>
        <SectionHead
          title="Impostazioni di modalità"
          sub={`${vocab.modeSettings.length} settings in ${vocab.modeSettingGroups.length} categorie · ${overrideCount(vocab.modeSettings, values)} personalizzati`}
          action={
            <AccentBtn
              onClick={() => {
                const settings: Record<string, string> = {};
                for (const key of changedKeys) settings[key] = values[key] ?? '';
                save.mutate({ settings });
              }}
              disabled={save.isPending}
              // `visibility` E NON UN RAMO: e' quello che fa il mockup, e tiene
              // ferma l'altezza dell'intestazione. Con il pulsante che entra ed
              // esce dal flusso, il titolo si sposterebbe a ogni modifica.
              style={{ visibility: canSave && changedKeys.length > 0 ? 'visible' : 'hidden' }}
            >
              Salva
            </AccentBtn>
          }
        />

        <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--bd-subtle)' }}>
          <SearchField
            value={filter}
            onChange={setFilter}
            placeholder="Filtra tutti i settings"
            label="Filtra i settings"
            maxWidth={320}
          />
        </div>

        <div style={{ maxHeight: 560, overflowY: 'auto' }}>
          {[...groups.entries()].map(([group, specs]) => {
            const shown = specs.filter(matches);
            if (shown.length === 0) return null;
            // Con un filtro attivo i gruppi si aprono da soli: cercare e non
            // vedere niente perche' la sezione e' chiusa sembra «non c'e'».
            const isOpen = query !== '' || (open[group] ?? false);
            const custom = overrideCount(specs, values);

            return (
              <div key={group} style={{ borderBottom: '1px solid var(--bd-subtle)' }}>
                <button
                  type="button"
                  onClick={() => setOpen({ ...open, [group]: !isOpen })}
                  aria-expanded={isOpen}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 11,
                    width: '100%',
                    padding: '12px 20px',
                    border: 'none',
                    cursor: 'pointer',
                    background: 'var(--s-base)',
                    textAlign: 'left',
                  }}
                >
                  <span
                    style={{
                      color: 'var(--tx-muted)',
                      display: 'flex',
                      transform: isOpen ? 'rotate(90deg)' : 'none',
                      transition: 'transform var(--dur-fast) var(--ease)',
                      flex: 'none',
                    }}
                  >
                    <Icon path={ICONS.chevron} size={13} />
                  </span>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--tx-primary)', flex: 1 }}>
                    {group}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--tx-muted)' }}>{shown.length} settings</span>
                  {custom > 0 ? (
                    <span
                      style={{
                        fontSize: 10.5,
                        fontWeight: 600,
                        padding: '2px 7px',
                        borderRadius: 'var(--r-xs)',
                        background: 'var(--ac-soft)',
                        color: 'var(--ac-text)',
                      }}
                    >
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
                        columns="1fr 56px 190px 100px"
                        padding="9px 20px 9px 44px"
                        variant="modes"
                        onChange={(v) => setValues({ ...values, [spec.key]: v })}
                      />
                    ))
                  : null}
              </div>
            );
          })}
        </div>
      </Section>

      {note ? <Toast message={note} onDone={() => setNote(undefined)} /> : null}
    </>
  );
}
