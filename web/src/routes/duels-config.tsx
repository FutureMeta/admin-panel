// «Duels · Configs». Le misure vengono da
// `frontend/14-duels-configurazioni.dc.html`.
//
// DUE COLONNE: a sinistra l'albero dei percorsi con la ricerca e il tasto
// «Nuovo», a destra il file scelto — intestazione con i moduli legati, editor
// YAML, e la barra della bozza in fondo. Due finestre: i legami e la
// pubblicazione.
//
// IL MODELLO IN UNA RIGA. Un percorso ha una versione condivisa fra i moduli
// che lo usano, oppure una versione per modulo. Quando ne ha piu' d'una compare
// il selettore «Versione» in testa all'editor, e si modifica quella scelta.
//
// LA COSA CHE LA SCHERMATA DEVE RENDERE OVVIA e' quanti moduli tocca una
// modifica: un file condiviso salvato una volta arriva a tutti quelli legati, e
// scoprirlo dopo aver premuto Pubblica e' tardi. Per questo le pastiglie dei
// moduli stanno accanto al nome, e il dialogo di pubblicazione conta i moduli
// prima di chiedere conferma.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DeleteDialog,
  LinksDialog,
  NewFileDialog,
  PublishDialog,
  pillStyle,
  RowMenu,
} from '../components/duels-config-dialogs.tsx';
import { PageHeader } from '../components/page.tsx';
import type { Me } from '../lib/api.ts';
import { api } from '../lib/api.ts';
import {
  buildTree,
  type ConfigFile,
  type ConfigTree,
  type ConfigVersion,
  filesUnder,
  isHidden,
  type TreeRow,
  titleOf,
} from '../lib/duels-config.ts';
import { canOpen } from '../lib/modules.ts';

export function DuelsConfigRoute({ me }: { me: Me }) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [versionIndex, setVersionIndex] = useState(0);
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [versionMenu, setVersionMenu] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  // Il menu del tasto destro: la riga su cui si e' aperto e dove disegnarlo.
  const [menu, setMenu] = useState<{ row: TreeRow; x: number; y: number } | null>(null);
  const [toDelete, setToDelete] = useState<{ path: string; folder: boolean } | null>(null);

  const canWrite = canOpen(me, 'duels_config', 2);
  const canPublish = canOpen(me, 'duels_config', 3);
  // ELIMINARE E' DI LIVELLO 3 come pubblicare, e per la stessa ragione: non
  // esiste una bozza di una cancellazione. Il file esce dal bundle subito, e i
  // server se ne accorgono al primo riavvio.
  const canDelete = canPublish;

  const tree = useQuery({
    queryKey: ['duels-config'],
    queryFn: () => api<ConfigTree>('/api/duels/config'),
  });

  const file = useQuery({
    queryKey: ['duels-config-file', selected],
    queryFn: () => api<ConfigFile>(`/api/duels/config/file?path=${encodeURIComponent(selected ?? '')}`),
    enabled: selected !== null,
  });

  const files = tree.data?.files ?? [];
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return needle === '' ? files : files.filter((f) => f.path.toLowerCase().includes(needle));
  }, [files, search]);
  const rows = useMemo(() => buildTree(filtered), [filtered]);
  // Le righe che si vedono davvero. La ricerca NON tiene conto delle cartelle
  // chiuse: chi cerca vuole trovare, e nascondere un risultato dietro una
  // cartella chiusa sarebbe rispondere «non c'e'».
  const visible = useMemo(
    () => (search.trim() === '' ? rows.filter((r) => !isHidden(r, collapsed)) : rows),
    [rows, collapsed, search],
  );

  const version = file.data?.versions[Math.min(versionIndex, (file.data?.versions.length ?? 1) - 1)];
  const summary = files.find((f) => f.path === selected);
  const pending = files.filter((f) => f.hasDraft);

  // Il testo nell'editor viene dalla bozza se c'e', dal pubblicato altrimenti.
  // `content` resta `null` finche' non si scrive: cosi' si distingue «non ho
  // toccato niente» da «ho cancellato tutto», che sono due salvataggi diversi.
  const base = version?.draft ?? version?.published ?? '';
  const text = content ?? base;
  const dirty = content !== null && content !== base;

  // biome-ignore lint/correctness/useExhaustiveDependencies: si azzera quando cambia il file o la versione, non a ogni render
  useEffect(() => {
    setContent(null);
  }, [selected, version?.id]);

  /**
   * Apre il menu su una riga.
   *
   * LE COORDINATE POSSONO ESSERE ZERO. `onContextMenu` scatta anche col tasto
   * «menu» della tastiera e con Shift+F10, e in quel caso non c'e' nessun
   * puntatore: il menu finirebbe nell'angolo in alto a sinistra dello schermo,
   * lontano dalla riga di cui parla. Quando succede si prende il bordo della
   * riga, che e' dove l'utente sta guardando.
   */
  const openMenu = (e: React.MouseEvent<HTMLButtonElement>, row: TreeRow): void => {
    if (!canDelete) return;
    e.preventDefault();
    const fromPointer = e.clientX !== 0 || e.clientY !== 0;
    const box = e.currentTarget.getBoundingClientRect();
    setMenu({
      row,
      x: fromPointer ? e.clientX : box.left + 12,
      y: fromPointer ? e.clientY : box.bottom,
    });
  };

  // I file che una cancellazione porta via: uno, o tutti quelli sotto la
  // cartella. E' lo stesso conto che fa il server, e serve a mostrarlo PRIMA.
  const doomed = useMemo(() => {
    if (toDelete === null) return [];
    return toDelete.folder ? filesUnder(files, toDelete.path) : files.filter((f) => f.path === toDelete.path);
  }, [files, toDelete]);

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['duels-config'] });
    await queryClient.invalidateQueries({ queryKey: ['duels-config-file'] });
  };

  const saveDraft = useMutation({
    mutationFn: (input: { versionId: number; content: string }) =>
      api<{ ok: true }>('/api/duels/config/draft', { method: 'PUT', body: input }),
    onSuccess: async () => {
      setContent(null);
      await invalidate();
    },
  });

  const publish = useMutation({
    mutationFn: () =>
      api<{ files: number; modules: string[] }>('/api/duels/config/publish', { method: 'POST' }),
    onSuccess: async () => {
      setPublishOpen(false);
      await invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: (input: { path: string; folder: boolean }) =>
      api<{ paths: string[]; modules: string[] }>(
        `/api/duels/config/path?path=${encodeURIComponent(input.path)}&folder=${input.folder}`,
        { method: 'DELETE' },
      ),
    onSuccess: async (result) => {
      // La schermata a destra mostrava uno dei file cancellati: senza questo
      // resterebbe li' con il suo editor, a modificare un percorso che non
      // esiste piu' — e il salvataggio fallirebbe senza spiegare perche'.
      if (selected !== null && result.paths.includes(selected)) setSelected(null);
      setToDelete(null);
      await invalidate();
    },
  });

  return (
    <>
      <PageHeader
        title="Duels · Configs"
        sub={`File YAML e legami fra moduli · ${files.length} percorsi su ${tree.data?.modules.length ?? 0} moduli`}
        action={
          pending.length > 0 && canPublish ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 'none' }}>
              <span style={{ fontSize: 12, color: 'var(--tx-muted)' }}>
                {pending.length} {pending.length === 1 ? 'modifica' : 'modifiche'} in bozza
              </span>
              <button
                type="button"
                onClick={() => setPublishOpen(true)}
                style={{
                  height: 34,
                  padding: '0 18px',
                  border: 'none',
                  borderRadius: 'var(--r-sm)',
                  background: 'var(--ac)',
                  color: '#160A02',
                  fontFamily: 'var(--font-ui)',
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                Pubblica
              </button>
            </div>
          ) : undefined
        }
      />

      <div
        style={{ display: 'grid', gridTemplateColumns: '360px minmax(0,1fr)', gap: 16, alignItems: 'start' }}
      >
        <section
          style={{
            border: '1px solid var(--bd-subtle)',
            borderRadius: 'var(--r-lg)',
            background: 'var(--s-surface)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              padding: '12px 14px',
              borderBottom: '1px solid var(--bd-subtle)',
              display: 'flex',
              gap: 6,
            }}
          >
            <div
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                height: 32,
                padding: '0 10px',
                border: '1px solid var(--bd-subtle)',
                borderRadius: 'var(--r-sm)',
                background: 'var(--s-inset)',
                color: 'var(--tx-muted)',
                minWidth: 0,
              }}
            >
              <svg
                viewBox="0 0 24 24"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16zM21 21l-4.3-4.3" />
              </svg>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Cerca percorso"
                style={{
                  border: 'none',
                  background: 'transparent',
                  outline: 'none',
                  color: 'var(--tx-primary)',
                  fontFamily: 'var(--font-ui)',
                  fontSize: 12.5,
                  flex: 1,
                  minWidth: 0,
                }}
              />
            </div>
            {canWrite ? (
              <button
                type="button"
                onClick={() => setNewOpen(true)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  boxSizing: 'border-box',
                  height: 32,
                  padding: '0 10px',
                  border: '1px solid transparent',
                  borderRadius: 'var(--r-sm)',
                  background: 'var(--ac)',
                  color: '#160A02',
                  fontFamily: 'var(--font-ui)',
                  fontSize: 12,
                  fontWeight: 600,
                  lineHeight: 1,
                  cursor: 'pointer',
                  flex: 'none',
                  whiteSpace: 'nowrap',
                }}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="12"
                  height="12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M12 5v14M5 12h14" />
                </svg>
                Nuovo
              </button>
            ) : null}
          </div>
          <div
            style={{
              padding: '6px 6px 10px',
              display: 'flex',
              flexDirection: 'column',
              gap: 1,
              maxHeight: 560,
              overflowY: 'auto',
            }}
          >
            {visible.map((row) =>
              row.kind === 'dir' ? (
                <button
                  key={`d:${row.key}`}
                  type="button"
                  aria-expanded={!collapsed.has(row.key)}
                  onClick={() =>
                    setCollapsed((prev) => {
                      const next = new Set(prev);
                      if (!next.delete(row.key)) next.add(row.key);
                      return next;
                    })
                  }
                  onContextMenu={(e) => openMenu(e, row)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    // NON SI RESTRINGE. In una colonna flex con un'altezza
                    // massima, `height` e' solo un desiderio: le righe si
                    // schiacciavano man mano che se ne aggiungevano, e con
                    // centoventi percorsi erano alte la meta' che con dieci.
                    flex: 'none',
                    height: 25,
                    paddingRight: 9,
                    paddingLeft: 12 + row.depth * 14,
                    border: 'none',
                    borderRadius: 'var(--r-sm)',
                    background: 'transparent',
                    color: 'var(--tx-secondary)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11.5,
                    fontWeight: 600,
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  {/* IL NOME PRIMA, LA FRECCIA DOPO: cosi' le cartelle
                      cominciano dove cominciano i file dello stesso livello, e
                      il rientro dice la profondita' da solo. Con la freccia
                      davanti, ogni cartella partiva dodici pixel piu' a destra
                      dei suoi vicini e l'allineamento raccontava una gerarchia
                      che non c'era. */}
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {row.label}
                  </span>
                  <svg
                    viewBox="0 0 24 24"
                    width="11"
                    height="11"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    aria-hidden="true"
                    style={{
                      flex: 'none',
                      transform: collapsed.has(row.key) ? 'none' : 'rotate(90deg)',
                      transition: 'transform var(--dur-fast) var(--ease)',
                    }}
                  >
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                </button>
              ) : (
                <button
                  key={`f:${row.key}`}
                  type="button"
                  onClick={() => {
                    setSelected(row.path ?? null);
                    setVersionIndex(0);
                  }}
                  onContextMenu={(e) => openMenu(e, row)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    // Vedi la riga della cartella: senza, l'altezza di una riga
                    // dipenderebbe da quante altre righe si vedono.
                    flex: 'none',
                    height: 25,
                    paddingRight: 9,
                    paddingLeft: 12 + row.depth * 14,
                    border: 'none',
                    borderRadius: 'var(--r-sm)',
                    background: row.path === selected ? 'var(--ac-soft)' : 'transparent',
                    color: row.path === selected ? 'var(--ac-text)' : 'var(--tx-primary)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11.5,
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <span
                    style={{
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {row.label}
                  </span>
                  {/* Il numero di versioni: quando e' piu' di uno, quel file e'
                      diviso per modulo. Si vede dall'albero senza aprirlo. */}
                  <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--tx-muted)' }}>
                    {(row.versions ?? 1) > 1 ? row.versions : ''}
                  </span>
                </button>
              ),
            )}
            {visible.length === 0 ? (
              <div style={{ padding: '18px 12px', fontSize: 12.5, color: 'var(--tx-muted)' }}>
                {tree.isLoading ? 'Caricamento…' : 'Nessun percorso'}
              </div>
            ) : null}
          </div>
        </section>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
          {selected === null || !file.data || !version ? (
            <div
              style={{
                border: '1px solid var(--bd-subtle)',
                borderRadius: 'var(--r-lg)',
                background: 'var(--s-surface)',
                padding: '48px 20px',
                textAlign: 'center',
                fontSize: 13,
                color: 'var(--tx-muted)',
              }}
            >
              Scegli un file dall'elenco.
            </div>
          ) : (
            <>
              <FileHeader
                path={file.data.path}
                modules={summary?.modules ?? []}
                canWrite={canWrite}
                onLinks={() => setLinkOpen(true)}
              />

              <Editor
                text={text}
                readOnly={!canWrite}
                onChange={setContent}
                versions={file.data.versions}
                index={Math.min(versionIndex, file.data.versions.length - 1)}
                menuOpen={versionMenu}
                onToggleMenu={() => setVersionMenu((v) => !v)}
                onPick={(i) => {
                  setVersionIndex(i);
                  setVersionMenu(false);
                }}
              />

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 16,
                  padding: '13px 20px',
                  border: '1px solid var(--bd-subtle)',
                  borderRadius: 'var(--r-lg)',
                  background: 'var(--s-surface)',
                  flexWrap: 'wrap',
                }}
              >
                <span style={{ fontSize: 12.5, color: 'var(--tx-muted)' }}>
                  <DraftLine version={version} dirty={dirty} />
                </span>
                {canWrite ? (
                  <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      onClick={() => setContent(null)}
                      disabled={!dirty}
                      style={{
                        height: 34,
                        padding: '0 14px',
                        border: '1px solid var(--bd-subtle)',
                        borderRadius: 'var(--r-sm)',
                        background: 'transparent',
                        color: dirty ? 'var(--tx-secondary)' : 'var(--tx-disabled)',
                        fontFamily: 'var(--font-ui)',
                        fontSize: 12.5,
                        cursor: dirty ? 'pointer' : 'default',
                      }}
                    >
                      Annulla
                    </button>
                    <button
                      type="button"
                      onClick={() => saveDraft.mutate({ versionId: version.id, content: text })}
                      disabled={!dirty || saveDraft.isPending}
                      style={{
                        height: 34,
                        padding: '0 14px',
                        border: '1px solid var(--bd-strong)',
                        borderRadius: 'var(--r-sm)',
                        background: 'var(--s-elevated)',
                        color: dirty ? 'var(--tx-primary)' : 'var(--tx-disabled)',
                        fontFamily: 'var(--font-ui)',
                        fontSize: 12.5,
                        fontWeight: 600,
                        cursor: dirty ? 'pointer' : 'default',
                      }}
                    >
                      {saveDraft.isPending ? 'Salvo…' : 'Salva bozza'}
                    </button>
                  </span>
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>

      {linkOpen && file.data && summary ? (
        <LinksDialog
          file={file.data}
          modules={tree.data?.modules ?? []}
          current={summary.modules}
          keepVersionId={version?.id ?? file.data.versions[0]?.id ?? 0}
          onClose={() => setLinkOpen(false)}
          onSaved={async () => {
            setLinkOpen(false);
            setVersionIndex(0);
            await invalidate();
          }}
        />
      ) : null}

      {newOpen ? (
        <NewFileDialog
          modules={tree.data?.modules ?? []}
          onClose={() => setNewOpen(false)}
          onCreated={async (path) => {
            setNewOpen(false);
            setSelected(path);
            setVersionIndex(0);
            await invalidate();
          }}
        />
      ) : null}

      {publishOpen ? (
        <PublishDialog
          pending={pending}
          busy={publish.isPending}
          onClose={() => setPublishOpen(false)}
          onConfirm={() => publish.mutate()}
        />
      ) : null}

      {menu === null ? null : (
        <RowMenu
          at={{ x: menu.x, y: menu.y }}
          label={menu.row.kind === 'dir' ? `${menu.row.key}/` : (menu.row.path ?? menu.row.key)}
          folder={menu.row.kind === 'dir'}
          onClose={() => setMenu(null)}
          onDelete={() => {
            setToDelete({ path: menu.row.key, folder: menu.row.kind === 'dir' });
            setMenu(null);
            remove.reset();
          }}
        />
      )}

      {toDelete === null ? null : (
        <DeleteDialog
          target={toDelete}
          files={doomed}
          busy={remove.isPending}
          // Non promette «non è stato cancellato niente»: la cancellazione è
          // una transazione sola, ma un errore di rete può arrivare dopo che il
          // server l'ha eseguita. Ricaricare dice com'è rimasta davvero.
          error={
            remove.error === null ? null : 'Cancellazione non riuscita. Ricarica per vedere com’è rimasta.'
          }
          onClose={() => setToDelete(null)}
          onConfirm={() => remove.mutate(toDelete)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function DraftLine({ version, dirty }: { version: ConfigVersion; dirty: boolean }) {
  if (dirty) return <>Modifiche non salvate.</>;
  if (version.draft !== null) {
    return (
      <>
        Bozza non pubblicata, salvata da{' '}
        <span style={{ color: 'var(--tx-secondary)', fontWeight: 600 }}>{version.draftBy}</span>
      </>
    );
  }
  if (version.published === null) return <>Mai pubblicato: i server usano ancora il default del jar.</>;
  return (
    <>
      Pubblicato da{' '}
      <span style={{ color: 'var(--tx-secondary)', fontWeight: 600 }}>{version.publishedBy}</span>
    </>
  );
}

function FileHeader({
  path,
  modules,
  canWrite,
  onLinks,
}: {
  path: string;
  modules: readonly string[];
  canWrite: boolean;
  onLinks: () => void;
}) {
  return (
    <div
      style={{
        border: '1px solid var(--bd-subtle)',
        borderRadius: 'var(--r-lg)',
        background: 'var(--s-surface)',
        padding: '16px 20px',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 20,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700 }}>
          {titleOf(path)}
        </div>
        <div style={{ marginTop: 5, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--tx-muted)' }}>
          {path}
        </div>
        <div style={{ marginTop: 9, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {modules.map((m) => (
            <span key={m} style={pillStyle(m)}>
              {m}
            </span>
          ))}
          {modules.length === 0 ? (
            <span style={{ fontSize: 11.5, color: 'var(--tx-muted)' }}>
              Nessun modulo legato: non lo riceve nessun server.
            </span>
          ) : null}
        </div>
      </div>
      {canWrite ? (
        <button
          type="button"
          onClick={onLinks}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: 32,
            padding: '0 13px',
            border: '1px solid var(--bd-strong)',
            borderRadius: 'var(--r-sm)',
            background: 'var(--s-elevated)',
            color: 'var(--tx-primary)',
            fontFamily: 'var(--font-ui)',
            fontSize: 12.5,
            fontWeight: 600,
            cursor: 'pointer',
            flex: 'none',
          }}
        >
          Gestisci versioni e legami
        </button>
      ) : null}
    </div>
  );
}

/**
 * L'editor: numeri di riga a sinistra, testo a destra.
 *
 * IL GUTTER E LA TEXTAREA SCORRONO INSIEME, e non e' un vezzo: sono due
 * elementi diversi, e senza sincronizzarli i numeri resterebbero fermi mentre
 * il testo scorre — cioe' indicherebbero la riga sbagliata, che e' peggio di
 * non averli.
 */
function Editor({
  text,
  readOnly,
  onChange,
  versions,
  index,
  menuOpen,
  onToggleMenu,
  onPick,
}: {
  text: string;
  readOnly: boolean;
  onChange: (value: string) => void;
  versions: readonly ConfigVersion[];
  index: number;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onPick: (index: number) => void;
}) {
  const gutter = useRef<HTMLDivElement>(null);
  const lines = text === '' ? 1 : text.split('\n').length;
  const split = versions.length > 1;
  const current = versions[index];

  return (
    <section
      style={{
        border: '1px solid var(--bd-subtle)',
        borderRadius: 'var(--r-lg)',
        background: 'var(--s-surface)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '9px 16px',
          borderBottom: '1px solid var(--bd-subtle)',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--tx-muted)' }}>
          {lines} righe · UTF-8
        </span>
        {split ? (
          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 9 }}>
            <span
              style={{
                fontSize: 10.5,
                fontWeight: 600,
                letterSpacing: '.12em',
                textTransform: 'uppercase',
                color: 'var(--tx-muted)',
              }}
            >
              Versione
            </span>
            <span style={{ position: 'relative', display: 'inline-flex' }}>
              <button
                type="button"
                onClick={onToggleMenu}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  height: 28,
                  padding: '0 11px',
                  border: '1px solid var(--bd-strong)',
                  borderRadius: 'var(--r-sm)',
                  background: 'var(--s-inset)',
                  color: 'var(--tx-primary)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11.5,
                  cursor: 'pointer',
                }}
              >
                {current?.modules.join(', ') || 'senza modulo'}
                <svg
                  viewBox="0 0 24 24"
                  width="12"
                  height="12"
                  fill="none"
                  stroke="var(--tx-muted)"
                  strokeWidth="1.5"
                  style={{ transform: menuOpen ? 'rotate(-90deg)' : 'rotate(90deg)' }}
                  aria-hidden="true"
                >
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </button>
              {menuOpen ? (
                <span
                  style={{
                    position: 'absolute',
                    top: 32,
                    right: 0,
                    zIndex: 30,
                    width: 240,
                    padding: 5,
                    border: '1px solid var(--bd-strong)',
                    borderRadius: 'var(--r-md)',
                    background: 'var(--s-overlay)',
                    boxShadow: 'var(--e3)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 1,
                  }}
                >
                  {versions.map((v, i) => (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => onPick(i)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        textAlign: 'left',
                        padding: '8px 10px',
                        border: 'none',
                        borderRadius: 'var(--r-sm)',
                        background: i === index ? 'var(--ac-soft)' : 'transparent',
                        cursor: 'pointer',
                      }}
                    >
                      <span
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 11.5,
                          color: i === index ? 'var(--ac-text)' : 'var(--tx-secondary)',
                        }}
                      >
                        {v.modules.join(', ') || 'senza modulo'}
                      </span>
                    </button>
                  ))}
                </span>
              ) : null}
            </span>
          </span>
        ) : null}
      </div>
      <div style={{ display: 'flex', alignItems: 'stretch', padding: '10px 0', minHeight: 320 }}>
        <div
          ref={gutter}
          aria-hidden="true"
          style={{
            width: 44,
            flex: 'none',
            paddingRight: 10,
            textAlign: 'right',
            fontFamily: 'var(--font-mono)',
            fontSize: 11.5,
            lineHeight: '22px',
            color: 'var(--tx-disabled)',
            fontVariantNumeric: 'tabular-nums',
            overflow: 'hidden',
            maxHeight: 520,
          }}
        >
          {/* I numeri di riga: la posizione E' l'identita', qui — la riga 12
              e' la riga 12, e non c'e' nient'altro che possa identificarla. */}
          {Array.from({ length: lines }, (_, i) => i + 1).map((n) => (
            <div key={n}>{n}</div>
          ))}
        </div>
        <textarea
          value={text}
          readOnly={readOnly}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          onScroll={(e) => {
            if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
          }}
          style={{
            flex: 1,
            minWidth: 0,
            maxHeight: 520,
            minHeight: 300,
            padding: '0 14px',
            border: 'none',
            outline: 'none',
            resize: 'vertical',
            background: 'transparent',
            color: 'var(--tx-primary)',
            fontFamily: 'var(--font-mono)',
            fontSize: 12.5,
            lineHeight: '22px',
            whiteSpace: 'pre',
            overflowWrap: 'normal',
            overflowX: 'auto',
          }}
        />
      </div>
    </section>
  );
}
