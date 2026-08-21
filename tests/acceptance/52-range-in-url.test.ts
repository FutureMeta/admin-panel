// Il periodo vive nella URL, e ci resta anche cambiando schermata.
//
// COSA RISOLVE. Prima il periodo stava in uno stato di React: funzionava
// finche' nessuno ricaricava la pagina e finche' nessuno mandava a un collega
// il collegamento a un grafico. Ricaricando si tornava a sette giorni;
// incollato in chat, un grafico dell'anno arrivava come una settimana, senza
// che niente lo dicesse.
//
// PERCHE' QUESTO TEST ESISTE. Il router NON conserva i parametri di ricerca da
// solo, e lo si scopre solo provandolo: la prima versione di questa modifica
// compilava, il selettore funzionava, e il periodo spariva al primo
// collegamento verso un'altra schermata — cioe' proprio nel gesto piu'
// frequente. Nessun typecheck poteva dirlo. Questo test costruisce un router
// con la stessa forma di quello vero e guarda gli indirizzi che produce.

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  retainSearchParams,
} from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RANGE, isRange, rangeSearch } from '#web/lib/range.ts';

/** La stessa forma dell'albero vero: il periodo sta sul GUSCIO. */
function routerAt(href: string) {
  const root = createRootRoute({});
  const shell = createRoute({
    getParentRoute: () => root,
    id: 'shell',
    validateSearch: rangeSearch,
    search: { middlewares: [retainSearchParams(['range'])] },
  });
  const overview = createRoute({ getParentRoute: () => shell, path: '/panoramica' });
  const entry = createRoute({ getParentRoute: () => shell, path: '/dettaglio-modalita' });
  const detail = createRoute({ getParentRoute: () => shell, path: '/dettaglio-modalita/$key' });
  const users = createRoute({ getParentRoute: () => shell, path: '/utenti' });

  return createRouter({
    routeTree: root.addChildren([shell.addChildren([overview, entry, detail, users])]),
    history: createMemoryHistory({ initialEntries: [href] }),
  });
}

describe('il periodo si legge dalla URL', () => {
  it('riconosce i cinque periodi del contratto e nient`altro', () => {
    for (const r of ['24h', '7d', '30d', '90d', '1y']) expect(isRange(r), r).toBe(true);
    for (const r of ['7g', 'settimana', '', '1Y', 'always', null, 7])
      expect(isRange(r), String(r)).toBe(false);
  });

  it('un periodo valido si tiene', () => {
    expect(rangeSearch({ range: '30d' })).toEqual({ range: '30d' });
  });

  it('un periodo impossibile SPARISCE invece di restare in barra', () => {
    // Le due alternative sono peggiori: bloccare la pagina per un parametro
    // decorativo, oppure disegnare il predefinito lasciando nell'indirizzo una
    // parola che non ha avuto nessun effetto.
    expect(rangeSearch({ range: 'settimana' })).toEqual({});
    expect(rangeSearch({ range: '' })).toEqual({});
    expect(rangeSearch({})).toEqual({});
  });

  it('gli altri parametri non li tocca, ma non li dichiara nemmeno', () => {
    // `validateSearch` decide la forma della ricerca: quello che non e` un
    // periodo non e` affar suo, e non deve finire nel valore validato.
    expect(rangeSearch({ range: '1y', mode: 'duels' })).toEqual({ range: '1y' });
  });
});

describe('il periodo sopravvive alla navigazione', () => {
  /**
   * L'indirizzo che il router produrrebbe per quella navigazione.
   *
   * Il cast c'e` perche' questo router non e` quello REGISTRATO: `main.tsx`
   * dichiara il proprio nel modulo di TanStack, e i tipi delle destinazioni
   * vengono da li'. Qui se ne costruisce uno con la stessa FORMA per poterlo
   * interrogare, e per lui le rotte sono generiche. E` il tipo a non poter
   * sapere, non il test a girare intorno a un controllo.
   */
  const href = (r: ReturnType<typeof routerAt>, opts: unknown) =>
    r.buildLocation(opts as Parameters<typeof r.buildLocation>[0]).href;

  it('un collegamento a una modalita` se lo porta dietro', () => {
    // E` LA REGRESSIONE VERA. Senza il middleware questo produceva
    // `/dettaglio-modalita/duels` e basta: cambiando modalita` il periodo
    // tornava a sette giorni, e chi stava guardando un anno se ne accorgeva
    // dal grafico, non da un messaggio.
    const r = routerAt('/panoramica?range=30d');
    expect(href(r, { to: '/dettaglio-modalita/$key', params: { key: 'duels' } })).toBe(
      '/dettaglio-modalita/duels?range=30d',
    );
  });

  it('e cosi` il rimando dell`ingresso, che e` una navigazione come le altre', () => {
    const r = routerAt('/panoramica?range=1y');
    expect(href(r, { to: '/dettaglio-modalita/$key', params: { key: 'towny' }, replace: true })).toBe(
      '/dettaglio-modalita/towny?range=1y',
    );
  });

  it('tornare alla panoramica non ricomincia da capo', () => {
    const r = routerAt('/dettaglio-modalita/duels?range=90d');
    expect(href(r, { to: '/panoramica' })).toBe('/panoramica?range=90d');
  });

  it('cambiare periodo resta sulla schermata dove si e`', () => {
    // `to: '.'`: la barra in alto non sa su quale schermata si trova, e non
    // deve saperlo.
    const r = routerAt('/dettaglio-modalita/duels?range=24h');
    expect(href(r, { to: '.', search: (p: { range?: string }) => ({ ...p, range: '7d' }) })).toBe(
      '/dettaglio-modalita/duels?range=7d',
    );
  });

  it('una URL nuda non si riempie del predefinito', () => {
    // «Non ha scelto» e «ha scelto sette giorni» devono restare distinguibili:
    // e` la differenza per cui il predefinito un giorno si puo` cambiare senza
    // rompere i collegamenti gia` in giro.
    const r = routerAt('/panoramica');
    expect(href(r, { to: '/dettaglio-modalita/$key', params: { key: 'duels' } })).toBe(
      '/dettaglio-modalita/duels',
    );
    expect(DEFAULT_RANGE).toBe('7d');
  });
});
