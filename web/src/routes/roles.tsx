// Ruoli: l'editor del ruolo scelto dalla tendina in testa, con la matrice dei
// permessi — moduli in riga raggruppati per area, livelli in colonna, un
// pallino per casella. Le modifiche restano in sospeso finche' non si
// confermano, e si confermano tutte insieme.
//
// Le azioni che l'utente non può compiere NON compaiono: la stessa regola
// della sidebar.

import { useMutation, useQuery } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { FilterSelect, PageHeader, Panel } from '../components/page.tsx';
import { Button, Field, Modal, Notice, SkeletonRows } from '../components/ui.tsx';
import { ApiError, api, type Me, type RolesMatrix } from '../lib/api.ts';
import { areaOfModule, LEVEL_LABELS } from '../lib/modules.ts';

const UNSAVED = 'Conferma o annulla prima le modifiche alla matrice.';

/**
 * I rifiuti del server sui ruoli, detti in una riga che spiega cosa fare.
 * Una Map e non un oggetto: le chiavi sono codici del server, e scritte come
 * stringhe il controllo sugli identificatori non le scambia per nomi di codice.
 */
const ROLE_ERRORS = new Map<string, string>([
  ['LIVELLO_NON_CONCEDIBILE', 'Non puoi impostare un livello superiore al tuo.'],
  ['RUOLO_DI_SISTEMA', 'Il ruolo di sistema non è modificabile: lo impedisce il database, non la schermata.'],
  ['RUOLO_NON_GESTIBILE', 'Questo ruolo dà più di quanto hai tu: può modificarlo solo chi sta più in alto.'],
  [
    'CONCESSO_DA_CHI_NON_PUO',
    'Qualcuno ha questo ruolo (o un invito lo offre) da chi non può concedere i livelli nuovi: riassegnalo tu, o revoca l’invito, prima di alzarlo.',
  ],
  [
    'RUOLO_ASSEGNATO',
    'Il ruolo è ancora assegnato a qualcuno: toglilo prima a tutte le persone che ce l’hanno.',
  ],
  [
    'RUOLO_IN_INVITI',
    'Un invito ancora valido offre questo ruolo: revocalo, o aspetta che scada, prima di eliminarlo.',
  ],
  ['NOME_IN_USO', 'Esiste già un ruolo con questo nome.'],
  ['NOME_NON_VALIDO', 'Il nome vuole almeno due lettere o cifre.'],
]);

function roleErrorText(err: unknown, fallback: string): string {
  return (
    (err instanceof ApiError && err.code !== undefined ? ROLE_ERRORS.get(err.code) : undefined) ?? fallback
  );
}

export function RolesPage({ me }: { me: Me }) {
  const [error, setError] = useState<string | undefined>();
  const [roleId, setRoleId] = useState<number | undefined>();
  // Bozza locale: cambiare la matrice declassa tutti quelli che hanno il
  // ruolo, quindi si conferma in blocco. Una PUT per pallino significherebbe
  // anche una challenge di step-up per pallino.
  const [draft, setDraft] = useState<Record<number, number>>({});
  /** Il popup del nome: un ruolo nuovo, o quello aperto da rinominare. */
  const [naming, setNaming] = useState<'create' | 'rename' | null>(null);
  const matrix = useQuery({ queryKey: ['roles'], queryFn: () => api<RolesMatrix>('/api/roles') });
  const canEdit = (me.permissions.ruoli ?? 0) >= 3;

  const pick = (id: number | undefined): void => {
    setRoleId(id);
    setDraft({});
    setError(undefined);
  };

  const remove = useMutation({
    mutationFn: (id: number) => api(`/api/roles/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      pick(undefined);
      await matrix.refetch();
    },
    onError: (err) => setError(roleErrorText(err, 'Eliminazione non riuscita.')),
  });

  const save = useMutation({
    mutationFn: (input: { roleId: number; entries: Array<{ moduleId: number; level: number }> }) =>
      api(`/api/roles/${input.roleId}/permissions`, {
        method: 'PUT',
        body: { entries: input.entries },
      }),
    onSuccess: () => {
      setError(undefined);
      setDraft({});
      void matrix.refetch();
    },
    onError: (err) => setError(roleErrorText(err, 'Modifica non riuscita.')),
  });

  if (matrix.isPending) return <SkeletonRows rows={10} />;
  if (matrix.isError || !matrix.data) {
    return <Notice tone="err" title="Non è stato possibile caricare la matrice dei permessi" />;
  }

  const { modules, roles, permissions } = matrix.data;
  const current = roles.find((r) => r.id === roleId) ?? roles[0];
  if (!current) return <Notice tone="err" title="Nessun ruolo configurato" />;

  const savedLevelOf = (module: number) =>
    permissions.find((p) => p.role_id === current.id && p.module_id === module)?.level ?? 0;
  const levelOf = (module: number) => draft[module] ?? savedLevelOf(module);

  const areas = [...new Set(modules.map((m) => areaOfModule(m.key)))];
  const editable = canEdit && current.editable;
  const pending = Object.entries(draft)
    .map(([module, level]) => ({ moduleId: Number(module), level }))
    .filter((e) => e.level !== savedLevelOf(e.moduleId));

  return (
    <>
      <PageHeader
        title="Ruoli e permessi"
        sub={`${roles.length} ruoli · ${modules.length} moduli · il livello più alto vince quando i ruoli si sommano`}
      />

      {error ? <Notice tone="err" title={error} /> : null}

      <Panel>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 20,
            padding: '18px 20px 14px',
          }}
        >
          <div>
            <h3
              style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 600, margin: '0 0 4px' }}
            >
              Editor del ruolo · {current.name}
            </h3>
            <div style={{ fontSize: 12, color: 'var(--tx-muted)' }}>
              Moduli in riga, livelli in colonna. Un modulo su «Nessuno» sparisce dalla sidebar di chi ha
              questo ruolo.
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 'none' }}>
            {/* La pastiglia del registro, non un campo di modulo: qui la
                tendina sta in un'intestazione, accanto al conteggio. */}
            <FilterSelect
              label="Ruolo da modificare"
              value={String(current.id)}
              onChange={(v) => pick(Number(v))}
              options={roles.map((r) => ({ value: String(r.id), label: r.name }))}
            />
            <span style={{ fontSize: 11.5, color: 'var(--tx-muted)', whiteSpace: 'nowrap' }}>
              {current.members} {current.members === 1 ? 'utente' : 'utenti'}
            </span>
            {editable ? (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending.length > 0}
                  title={pending.length > 0 ? UNSAVED : undefined}
                  onClick={() => setNaming('rename')}
                >
                  Rinomina
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  loading={remove.isPending}
                  // Toglierlo alle persone e' un'azione su di loro: si fa dalla
                  // loro scheda, una per una. Qui si elimina un ruolo vuoto.
                  disabled={current.members > 0 || pending.length > 0}
                  title={
                    pending.length > 0
                      ? UNSAVED
                      : current.members > 0
                        ? 'Assegnato ad almeno una persona: toglilo prima a tutti.'
                        : undefined
                  }
                  onClick={() => {
                    if (window.confirm(`Eliminare il ruolo «${current.name}»?`)) remove.mutate(current.id);
                  }}
                >
                  Elimina
                </Button>
              </>
            ) : null}
            {canEdit ? (
              <Button
                size="sm"
                variant="primary"
                disabled={pending.length > 0}
                title={pending.length > 0 ? UNSAVED : undefined}
                onClick={() => setNaming('create')}
              >
                Nuovo ruolo
              </Button>
            ) : null}
          </div>
        </div>

        <div style={{ maxHeight: 420, overflow: 'auto' }}>
          <table className="table" style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ background: 'var(--s-inset)', paddingLeft: 20 }}>Modulo</th>
                {LEVEL_LABELS.map((l) => (
                  <th key={l} style={{ background: 'var(--s-inset)', width: 110, textAlign: 'center' }}>
                    {l}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {areas.map((area) => (
                <Fragment key={area}>
                  <tr>
                    <td
                      colSpan={5}
                      className="t-group"
                      style={{ background: 'var(--s-base)', padding: '8px 20px', letterSpacing: '.1em' }}
                    >
                      {area}
                    </td>
                  </tr>
                  {modules
                    .filter((m) => areaOfModule(m.key) === area)
                    .map((m) => {
                      const level = levelOf(m.id);
                      return (
                        <tr key={m.id}>
                          <td style={{ paddingLeft: 20 }}>{m.name}</td>
                          {LEVEL_LABELS.map((label, value) => {
                            const on = level === value;
                            const changed = draft[m.id] !== undefined && draft[m.id] !== savedLevelOf(m.id);
                            const dot = on
                              ? changed
                                ? 'var(--ac)'
                                : 'var(--tx-secondary)'
                              : 'var(--bd-strong)';
                            return (
                              <td
                                key={label}
                                style={{
                                  textAlign: 'center',
                                  padding: '9px 8px',
                                  background: changed ? 'var(--ac-soft)' : undefined,
                                }}
                              >
                                <button
                                  type="button"
                                  disabled={!editable || save.isPending}
                                  aria-label={`${m.name}: ${label}`}
                                  aria-pressed={on}
                                  onClick={() => setDraft((d) => ({ ...d, [m.id]: value }))}
                                  style={{
                                    width: 13,
                                    height: 13,
                                    padding: 0,
                                    borderRadius: '50%',
                                    border: `1.5px solid ${dot}`,
                                    background: 'transparent',
                                    boxShadow: on
                                      ? `inset 0 0 0 2.5px var(--s-surface), inset 0 0 0 9px ${dot}`
                                      : 'none',
                                    cursor: editable ? 'pointer' : 'not-allowed',
                                  }}
                                />
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            padding: '14px 20px',
            borderTop: '1px solid var(--bd-subtle)',
            background: 'var(--s-inset)',
            fontSize: 12,
            color: 'var(--tx-muted)',
          }}
        >
          <span>
            {!editable
              ? current.isSystem
                ? 'Ruolo di sistema: non modificabile. Lo impedisce il database, non questa schermata.'
                : 'Serve il livello «Gestione» sul modulo Ruoli per modificare la matrice.'
              : pending.length === 0
                ? 'Nessuna modifica in sospeso.'
                : `${pending.length} ${pending.length === 1 ? 'modulo modificato' : 'moduli modificati'} · alla conferma cambia l'accesso di ${current.members} ${current.members === 1 ? 'persona' : 'persone'}.`}
          </span>
          {editable ? (
            <span style={{ display: 'flex', gap: 8 }}>
              <Button
                size="sm"
                disabled={pending.length === 0 || save.isPending}
                onClick={() => setDraft({})}
              >
                Annulla
              </Button>
              <Button
                size="sm"
                variant="primary"
                loading={save.isPending}
                disabled={pending.length === 0}
                onClick={() => save.mutate({ roleId: current.id, entries: pending })}
              >
                Conferma modifiche
              </Button>
            </span>
          ) : null}
        </div>
      </Panel>

      {naming !== null ? (
        <RoleNameDialog
          role={naming === 'rename' ? current : undefined}
          onClose={() => setNaming(null)}
          onSaved={async (id) => {
            setNaming(null);
            // Prima i dati, poi la scelta: il ruolo nuovo deve gia' esserci
            // quando lo si seleziona, o per un attimo si vede il primo.
            await matrix.refetch();
            if (naming === 'create') pick(id);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Il nome di un ruolo: nuovo, o da cambiare. Un ruolo nuovo nasce senza
 * permessi, e si apre subito nella matrice per darglieli.
 */
function RoleNameDialog({
  role,
  onClose,
  onSaved,
}: {
  role: { id: number; name: string } | undefined;
  onClose: () => void;
  onSaved: (id: number) => Promise<void>;
}) {
  const [name, setName] = useState(role?.name ?? '');
  const ready = name.trim().length >= 2 && name.trim() !== role?.name;

  const save = useMutation({
    mutationFn: async (): Promise<number> => {
      if (role === undefined) {
        const created = await api<{ id: number }>('/api/roles', { method: 'POST', body: { name } });
        return created.id;
      }
      await api(`/api/roles/${role.id}`, { method: 'PATCH', body: { name } });
      return role.id;
    },
    onSuccess: (id) => onSaved(id),
  });

  const error = save.error ? roleErrorText(save.error, 'Salvataggio non riuscito.') : undefined;

  return (
    <Modal
      title={role === undefined ? 'Nuovo ruolo' : `Rinomina «${role.name}»`}
      {...(role === undefined
        ? { subtitle: 'Nasce senza permessi: li dai subito dopo, nella matrice.' }
        : {})}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Annulla</Button>
          <Button variant="primary" loading={save.isPending} disabled={!ready} onClick={() => save.mutate()}>
            {role === undefined ? 'Crea ruolo' : 'Salva'}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !save.isPending) save.mutate();
        }}
      >
        <Field
          label="Nome"
          id="role-name"
          value={name}
          maxLength={40}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          placeholder="es. Staff eventi"
          error={error}
        />
      </form>
    </Modal>
  );
}
