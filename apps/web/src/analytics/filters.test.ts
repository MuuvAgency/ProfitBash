import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILTER_STATE,
  filterStateFromQuery,
  filterStateToQuery,
  fromTreeSelection,
  MAX_FILTER_TAGS,
  parseStoredFilters,
  sanitizeFilterState,
  toAnalyticsQuery,
  toTreeSelection,
  type FilterOptionsLike,
  type FilterState,
} from './filters';

const C1 = '00000000-0000-4000-8000-0000000000c1';
const C2 = '00000000-0000-4000-8000-0000000000c2';
const P1 = '00000000-0000-4000-8000-0000000000a1';
const P2 = '00000000-0000-4000-8000-0000000000a2';
const P3 = '00000000-0000-4000-8000-0000000000a3';
const P4 = '00000000-0000-4000-8000-0000000000a4';

/** C1: P1, P2 · C2: P3 · ohne Client: P4 */
const options: FilterOptionsLike = {
  clients: [
    { id: C1, name: 'Waldkauz' },
    { id: C2, name: 'Lumen' },
  ],
  profiles: [
    { id: P1, clientId: C1 },
    { id: P2, clientId: C1 },
    { id: P3, clientId: C2 },
    { id: P4, clientId: null },
  ],
};

const state = (patch: Partial<FilterState>): FilterState => ({ ...DEFAULT_FILTER_STATE, ...patch });

describe('filterStateFromQuery / filterStateToQuery', () => {
  it('ohne Parameter in der URL: letzte Auswahl aus ui_state', () => {
    const stored = state({ clientIds: [C1], profileIds: [P1], comparison: 'off' });
    expect(filterStateFromQuery({}, stored)).toEqual(stored);
  });

  it('ohne Parameter und ohne gespeicherte Auswahl: Standard', () => {
    expect(filterStateFromQuery({}, null)).toEqual(DEFAULT_FILTER_STATE);
    expect(DEFAULT_FILTER_STATE).toMatchObject({
      period: { preset: 'last30' },
      comparison: 'previous',
      currency: 'auto',
      attribution: 'console',
      clientIds: [],
      withoutClient: false,
      profileIds: null,
    });
  });

  it('Standardwerte erscheinen nicht in der URL', () => {
    expect(filterStateToQuery(DEFAULT_FILTER_STATE)).toEqual({});
  });

  it('kurzer Zustand hin und zurück', () => {
    const full = state({
      clientIds: [C2, C1],
      withoutClient: true,
      period: { preset: 'custom', range: { from: '2026-05-01', to: '2026-05-31' } },
      comparison: 'previousYear',
      currency: 'GBP',
      attribution: 'clicks14d',
    });
    const query = filterStateToQuery(full);
    expect(query).toEqual({
      clients: `${C1},${C2}`,
      nc: '1',
      period: 'custom',
      from: '2026-05-01',
      to: '2026-05-31',
      cmp: 'previousYear',
      cur: 'GBP',
      attr: 'clicks14d',
    });
    expect(filterStateFromQuery(query, null)).toEqual({ ...full, clientIds: [C1, C2] });
  });

  it('Profile stehen nie in der URL, nur ein Merker; die IDs kommen aus ui_state', () => {
    const selected = state({ clientIds: [C1], profileIds: [P1] });
    const query = filterStateToQuery(selected);
    expect(query).toEqual({ clients: C1, pf: '1' });
    expect(JSON.stringify(query)).not.toContain(P1);
    expect(filterStateFromQuery(query, selected)).toEqual(selected);
  });

  it('Link ohne Profil-Merker: gespeicherte Profile gelten nicht', () => {
    const stored = state({ clientIds: [C1], profileIds: [P1] });
    expect(filterStateFromQuery({ clients: C2 }, stored)).toEqual(state({ clientIds: [C2] }));
  });

  it('unbekannte oder kaputte Werte fallen auf den Standard zurück', () => {
    expect(
      filterStateFromQuery(
        {
          period: 'last90',
          cmp: 'x',
          cur: 'euro',
          attr: '7d',
          clients: 'kein-uuid',
          from: '2026-13-01',
        },
        null,
      ),
    ).toEqual(DEFAULT_FILTER_STATE);
    // frei gewählt ohne gültigen Zeitraum → Standard
    expect(filterStateFromQuery({ period: 'custom', from: '2026-05-10' }, null).period).toEqual({
      preset: 'last30',
    });
    // `from` nach `to`
    expect(
      filterStateFromQuery({ period: 'custom', from: '2026-05-10', to: '2026-05-01' }, null).period,
    ).toEqual({ preset: 'last30' });
  });

  it('andere Parameter der Seite (z. B. Reiter im Explorer) zählen nicht als Filter', () => {
    const stored = state({ comparison: 'off' });
    expect(filterStateFromQuery({ level: 'target' }, stored)).toEqual(stored);
  });
});

describe('parseStoredFilters', () => {
  it('nimmt gültige Werte an, verwirft ungültige', () => {
    const stored = state({ clientIds: [C1], currency: 'SEK' });
    expect(parseStoredFilters(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
    expect(parseStoredFilters(null)).toBeNull();
    expect(parseStoredFilters({ period: 'kaputt' })).toBeNull();
  });
});

describe('parseStoredFilters (Grenzen)', () => {
  it('zu viele Profile: nur die Profilauswahl entfällt, der Rest bleibt', () => {
    const many = Array.from(
      { length: 2000 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(
      parseStoredFilters(state({ clientIds: [C1], profileIds: many, comparison: 'off' })),
    ).toEqual(state({ clientIds: [C1], comparison: 'off' }));
  });
});

describe('sanitizeFilterState', () => {
  it('„Ohne Client“ entfällt, wenn es keine Profile ohne Client gibt', () => {
    const withClients = { ...options, profiles: options.profiles.filter((p) => p.clientId) };
    expect(sanitizeFilterState(state({ withoutClient: true }), withClients).withoutClient).toBe(
      false,
    );
  });

  it('entfernt Clients und Profile, die der Nutzer nicht (mehr) sieht', () => {
    const unknown = '00000000-0000-4000-8000-0000000000ff';
    expect(
      sanitizeFilterState(state({ clientIds: [C1, unknown], profileIds: [P1, unknown] }), options),
    ).toEqual(state({ clientIds: [C1], profileIds: [P1] }));
  });

  it('Profile außerhalb der gewählten Clients fallen weg; bleibt keins, gilt der ganze Client', () => {
    expect(sanitizeFilterState(state({ clientIds: [C1], profileIds: [P3] }), options)).toEqual(
      state({ clientIds: [C1] }),
    );
  });

  it('Anzeigewährung, die nicht wählbar ist → automatisch', () => {
    expect(
      sanitizeFilterState(state({ currency: 'JPY' }), { ...options, currencies: ['EUR', 'USD'] })
        .currency,
    ).toBe('auto');
  });
});

describe('toAnalyticsQuery', () => {
  it('baut die Anfrage mit Zeitraum und Vergleich', () => {
    expect(toAnalyticsQuery(DEFAULT_FILTER_STATE, '2026-09-10')).toEqual({
      period: { from: '2026-08-11', to: '2026-09-09' },
      comparison: { from: '2026-07-12', to: '2026-08-10' },
      currency: 'auto',
      attribution: 'console',
    });
  });

  it('Auswahl nur, wenn eingeschränkt; Vergleich aus = null', () => {
    expect(
      toAnalyticsQuery(
        state({ clientIds: [C1], withoutClient: true, profileIds: [P1], comparison: 'off' }),
        '2026-09-10',
      ),
    ).toMatchObject({
      clientIds: [C1],
      withoutClient: true,
      profileIds: [P1],
      comparison: null,
    });
  });
});

describe('Baumauswahl (Clients › Profile)', () => {
  it('alles gewählt = keine Einschränkung, und umgekehrt', () => {
    const all = toTreeSelection(DEFAULT_FILTER_STATE, options);
    expect(all[`client:${C1}`]).toEqual({ checked: true, partialChecked: false });
    expect(all[`profile:${P4}`]).toEqual({ checked: true, partialChecked: false });
    expect(all['none']).toEqual({ checked: true, partialChecked: false });
    expect(fromTreeSelection(all, options)).toEqual({
      clientIds: [],
      withoutClient: false,
      profileIds: null,
    });
  });

  it('nichts gewählt gilt als alles', () => {
    expect(fromTreeSelection({}, options)).toEqual({
      clientIds: [],
      withoutClient: false,
      profileIds: null,
    });
  });

  it('ganze Clients ohne Profil-Liste', () => {
    const keys = {
      [`client:${C2}`]: { checked: true, partialChecked: false },
      [`profile:${P3}`]: { checked: true, partialChecked: false },
      none: { checked: true, partialChecked: false },
      [`profile:${P4}`]: { checked: true, partialChecked: false },
    };
    expect(fromTreeSelection(keys, options)).toEqual({
      clientIds: [C2],
      withoutClient: true,
      profileIds: null,
    });
    expect(toTreeSelection(state({ clientIds: [C2], withoutClient: true }), options)).toEqual(keys);
  });

  it('teilweise gewählter Client: Profil-Liste über alle gewählten Profile', () => {
    const keys = {
      [`client:${C1}`]: { checked: false, partialChecked: true },
      [`profile:${P2}`]: { checked: true, partialChecked: false },
      [`client:${C2}`]: { checked: true, partialChecked: false },
      [`profile:${P3}`]: { checked: true, partialChecked: false },
    };
    const selection = fromTreeSelection(keys, options);
    expect(selection).toEqual({ clientIds: [C1, C2], withoutClient: false, profileIds: [P2, P3] });
    expect(toTreeSelection(state(selection), options)).toEqual(keys);
  });
});

describe('Tags in der Filterleiste (phase-3.md 3.7)', () => {
  const T1 = '00000000-0000-4000-8000-0000000000d1';
  const T2 = '00000000-0000-4000-8000-0000000000d2';

  it('stehen als kurze Liste in der URL und kommen von dort zurück', () => {
    const query = filterStateToQuery(state({ tagIds: [T2, T1] }));
    expect(query).toEqual({ tags: `${T1},${T2}` });
    expect(filterStateFromQuery(query, null).tagIds).toEqual([T1, T2]);
    expect(filterStateToQuery(state({}))).toEqual({});
  });

  it('kaputte oder zu viele Tags in der URL gelten als kein Filter', () => {
    expect(filterStateFromQuery({ tags: 'x' }, null).tagIds).toEqual([]);
    const many = Array.from({ length: MAX_FILTER_TAGS + 1 }, (_, i) =>
      T1.replace(/d1$/, String(10 + i)),
    );
    expect(filterStateFromQuery({ tags: many.join(',') }, null).tagIds).toEqual([]);
  });

  it('gespeicherte Auswahl: mit Tags, und ohne das Feld (ältere Einträge) ohne Filter', () => {
    const stored = JSON.parse(JSON.stringify(state({ tagIds: [T1] }))) as Record<string, unknown>;
    expect(parseStoredFilters(stored)?.tagIds).toEqual([T1]);
    delete stored.tagIds;
    expect(parseStoredFilters(stored)?.tagIds).toEqual([]);
  });

  it('gehen nur eingeschränkt in die Anfrage', () => {
    expect(toAnalyticsQuery(state({ tagIds: [T1] }), '2026-10-09').tagIds).toEqual([T1]);
    expect('tagIds' in toAnalyticsQuery(state({}), '2026-10-09')).toBe(false);
  });

  it('Tags, die es nicht mehr gibt, fallen weg (nur wenn die Tags bekannt sind)', () => {
    const chosen = state({ tagIds: [T1, T2] });
    expect(sanitizeFilterState(chosen, { ...options, tags: [{ id: T2 }] }).tagIds).toEqual([T2]);
    expect(sanitizeFilterState(chosen, options).tagIds).toEqual([T1, T2]);
  });
});
