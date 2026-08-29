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
import { type Edit, keyEdit } from '../lib/editor-keys.ts';
import { paint } from '../lib/minimessage.ts';
import { canOpen } from '../lib/modules.ts';
import { highlightYaml, type Token, type TokenKind } from '../lib/yaml-highlight.ts';

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
 * Scrive una modifica dentro la textarea.
 *
 * PASSA DA `execCommand` E NON DA `setState`, e non e' nostalgia: e' l'unico
 * modo rimasto perche' Ctrl+Z continui a funzionare. Cambiando il valore da
 * JavaScript il browser butta via la cronologia dei annullamenti, e un editor
 * in cui Tab funziona ma «annulla» non piu' e' un cattivo affare. Se il
 * browser dice di no si ripiega sul modo diretto, che qualcosa fa comunque.
 */
function apply(box: HTMLTextAreaElement, edit: Edit): void {
  box.setSelectionRange(edit.from, edit.to);
  const ok = document.execCommand('insertText', false, edit.insert);
  if (!ok) {
    box.value = box.value.slice(0, edit.from) + edit.insert + box.value.slice(edit.to);
  }
  box.setSelectionRange(edit.selectFrom, edit.selectTo);
}

/**
 * Le misure del testo, scritte UNA VOLTA per i due strati che devono
 * combaciare.
 *
 * Duplicarle vorrebbe dire che un giorno qualcuno ne cambia una e non l'altra:
 * mezzo pixel di interlinea, e alla ventesima riga il colore e' un rigo piu'
 * in basso delle parole.
 */
const TEXT_METRICS: React.CSSProperties = {
  padding: '0 14px',
  fontFamily: 'var(--font-mono)',
  fontSize: 12.5,
  lineHeight: '22px',
  whiteSpace: 'pre',
  overflowWrap: 'normal',
  tabSize: 2,
};

/** Il colore di ogni genere di pezzo. I codici hanno il loro, vedi `codeStyle`. */
const KIND: Record<TokenKind, string> = {
  key: 'var(--yml-key)',
  string: 'var(--yml-string)',
  number: 'var(--yml-number)',
  literal: 'var(--yml-literal)',
  comment: 'var(--yml-comment)',
  punct: 'var(--yml-punct)',
  anchor: 'var(--yml-anchor)',
  // I tag: uno stesso grigio per tutti, vedi `--yml-tag`.
  code: 'var(--yml-tag)',
  plain: 'var(--tx-primary)',
};

/**
 * Il testo colorato, dietro alla textarea.
 *
 * TRE STRATI SOVRAPPOSTI AL PIXEL: i numeri di riga, questo, e sopra a tutti
 * una textarea con il testo trasparente e il solo cursore visibile. Si scrive
 * nella textarea e si legge qui — e' l'unico modo di avere il colore senza
 * rinunciare a un campo di testo vero, con il suo annulla, il suo
 * incolla e la sua selezione.
 *
 * DIPENDE DA DUE COSE, e tutt'e due sono scritte: che i pezzi di una riga
 * rimessi insieme diano la riga (`highlightYaml`), e che qui sotto le misure
 * — carattere, corpo, interlinea, margini — siano IDENTICHE a quelle della
 * textarea. Sbagliarne una fa scivolare il colore rispetto al testo, e si vede
 * subito perche' si vede doppio.
 */
/**
 * Come si disegna un pezzo.
 *
 * IL GRASSETTO NON PUO' SPOSTARE NIENTE, ed e' il motivo per cui non e'
 * `font-weight`. Sotto c'e' una textarea che scrive con lo stesso carattere in
 * tondo: se il grassetto fosse largo mezzo pixel in piu', da quel punto in poi
 * le due righe divergerebbero e si leggerebbe doppio. `-webkit-text-stroke`
 * ingrossa il tratto in fase di disegno e non tocca la misura, per definizione:
 * qualunque cosa faccia il carattere, la colonna resta dov'era.
 *
 * (Misurato prima di scegliere: in questo motore anche il grassetto sintetico
 * lascia la larghezza identica al millesimo. Ma «oggi si comporta bene» e «non
 * puo' comportarsi male» sono due garanzie diverse, e qui la seconda costa
 * uguale.)
 *
 * L'OFFUSCATO NON SI OFFUSCA: in gioco `<obfuscated>` fa ballare i caratteri,
 * qui e' il testo che si sta scrivendo. Si segna con una sottolineatura
 * tratteggiata, che dice «questo ballera'» senza toglierlo di mano.
 */
function spanStyle(token: Token): React.CSSProperties {
  const style = token.style;
  const colour = style?.colour;
  const decor = [
    style?.underlined === true ? 'underline' : '',
    style?.strikethrough === true ? 'line-through' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return {
    // Il tag si vede col suo colore; il testo con quello che il tag gli da'.
    // Senza colore proprio resta quello del suo genere — chiave, numero,
    // commento — cioe' esattamente cio' che si vedeva prima.
    ...(colour === undefined ? { color: KIND[token.kind] } : paint(colour)),
    ...(style?.bold === true ? { WebkitTextStroke: '0.25px' } : {}),
    ...(style?.italic === true ? { fontStyle: 'italic' } : {}),
    ...(decor === '' ? {} : { textDecoration: decor }),
    ...(style?.obfuscated === true
      ? { textDecoration: `${decor} underline dotted`.trim(), textUnderlineOffset: 2 }
      : {}),
  };
}

function Highlight({ text, tags }: { text: string; tags: boolean }) {
  const rows = useMemo(() => highlightYaml(text), [text]);
  return (
    <>
      {rows.map((row, line) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: la riga E' la sua posizione
        <span key={line}>
          {row.map((token, at) =>
            // SPENTI I TAG, SPARISCONO DAVVERO: nasconderli lasciando il loro
            // spazio darebbe il messaggio a buchi, che non e' come si vedra'
            // in gioco — e vederlo com'e' in gioco e' tutto il punto.
            !tags && token.kind === 'code' ? null : (
              // biome-ignore lint/suspicious/noArrayIndexKey: idem, il pezzo e' la sua posizione nella riga
              <span key={at} style={spanStyle(token)}>
                {token.text}
              </span>
            ),
          )}
          {line < rows.length - 1 ? '\n' : null}
        </span>
      ))}
    </>
  );
}

/**
 * L'editor: numeri di riga a sinistra, testo a destra.
 *
 * IL GUTTER, IL COLORE E LA TEXTAREA SCORRONO INSIEME, e non e' un vezzo: sono
 * tre elementi diversi, e senza sincronizzarli i numeri resterebbero fermi
 * mentre il testo scorre — cioe' indicherebbero la riga sbagliata, che e'
 * peggio di non averli — e il colore resterebbe indietro rispetto alle parole
 * che colora.
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
  const mirror = useRef<HTMLPreElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  // I tag si possono spegnere per leggere il messaggio come uscira` in gioco.
  const [tags, setTags] = useState(true);
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
        {/* SPEGNERE I TAG per leggere il messaggio come uscira' in gioco.
            Mentre sono spenti NON SI SCRIVE, e si vede: il testo cambia
            colonna, perche' i tag tolti occupavano spazio. E' un'anteprima —
            il modo di rispondere a «come verra'» senza avviare un server. */}
        <button
          type="button"
          onClick={() => setTags((on) => !on)}
          aria-pressed={!tags}
          title={tags ? 'Nascondi i tag e leggi il messaggio' : 'Rimetti i tag e torna a scrivere'}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            height: 24,
            padding: '0 9px',
            border: `1px solid ${tags ? 'var(--bd-subtle)' : 'rgba(219,110,25,.45)'}`,
            borderRadius: 'var(--r-sm)',
            background: tags ? 'transparent' : 'var(--ac-soft)',
            color: tags ? 'var(--tx-muted)' : 'var(--ac-text)',
            fontFamily: 'var(--font-ui)',
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          <svg
            viewBox="0 0 24 24"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
            <circle cx="12" cy="12" r="2.6" />
            {tags ? null : <path d="m4 20 16-16" />}
          </svg>
          {tags ? 'Anteprima' : 'Solo testo'}
        </button>
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
        <div style={{ position: 'relative', display: 'flex', flex: 1, minWidth: 0 }}>
          <pre
            ref={mirror}
            aria-hidden={tags}
            onScroll={(e) => {
              // Serve SOLO senza i tag, quando e' questo strato a scorrere
              // perche' la textarea sotto e' nascosta. Da qui i numeri di riga
              // e la textarea seguono, cosi' riaccendendo i tag ci si ritrova
              // dove si era rimasti invece che in cima al file.
              if (tags) return;
              if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
              if (box.current) box.current.scrollTop = e.currentTarget.scrollTop;
            }}
            style={{
              // Le stesse misure della textarea, una per una. Sono la ragione
              // per cui i due strati restano incolonnati.
              ...TEXT_METRICS,
              position: 'absolute',
              inset: 0,
              margin: 0,
              overflow: tags ? 'hidden' : 'auto',
              pointerEvents: tags ? 'none' : 'auto',
            }}
          >
            <Highlight text={text} tags={tags} />
          </pre>
          <textarea
            ref={box}
            value={text}
            readOnly={readOnly}
            spellCheck={false}
            className="code-area"
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (readOnly || e.ctrlKey || e.metaKey || e.altKey) return;
              const area = e.currentTarget;
              const edit = keyEdit({
                text: area.value,
                from: area.selectionStart,
                to: area.selectionEnd,
                key: e.key,
                shift: e.shiftKey,
              });
              if (edit === null) return;
              e.preventDefault();
              apply(area, edit);
              onChange(area.value);
            }}
            onScroll={(e) => {
              if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
              // Anche in orizzontale: una riga lunga scorre di lato, e il
              // colore deve scorrere con lei.
              if (mirror.current) {
                mirror.current.scrollTop = e.currentTarget.scrollTop;
                mirror.current.scrollLeft = e.currentTarget.scrollLeft;
              }
            }}
            style={{
              ...TEXT_METRICS,
              position: 'relative',
              flex: 1,
              minWidth: 0,
              maxHeight: 520,
              minHeight: 300,
              border: 'none',
              outline: 'none',
              resize: 'vertical',
              background: 'transparent',
              // IL TESTO E' TRASPARENTE: quello che si legge lo disegna lo
              // strato sotto. Restano il cursore, che senza `caretColor`
              // sparirebbe con il resto, e la selezione, che il browser
              // disegna come sfondo e quindi si vede lo stesso.
              color: 'transparent',
              caretColor: 'var(--tx-primary)',
              overflowX: 'auto',
              // SENZA I TAG NON SI SCRIVE, e la textarea si nasconde invece di
              // sparire: `visibility` la toglie dalla vista e dal fuoco ma le
              // lascia il suo spazio, che e' quello che tiene in piedi
              // l'altezza del riquadro — e con essa la posizione del testo
              // sopra. Un `display: none` farebbe collassare tutto.
              //
              // E' un'anteprima, non una modalita' di modifica: il testo che
              // si vede li' non e' piu' incolonnato con quello vero, perche' i
              // tag tolti erano larghi.
              ...(tags ? {} : { visibility: 'hidden' as const }),
            }}
          />
        </div>
      </div>
    </section>
  );
}
