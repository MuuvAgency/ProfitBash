import { DEFAULT_AUTOMATION_RULES } from '@profitbash/shared';
import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, stubFetch, type RecordedRequest } from '../test/fetch-stub';
import { meFixture, type MeFixtureOptions } from '../test/fixtures';
import { cleanupMounted, mountWithApp } from '../test/mount';

/** Seite „Automationen“, Tab „Regeln“ (`phase-5.md` 5.6b): Liste mit Reihenfolge, Bearbeiten, Vorschau. */

const C1 = '00000000-0000-4000-8000-0000000000c1';
const GONE = '00000000-0000-4000-8000-0000000000c9';
const [R1, R2, R3] = DEFAULT_AUTOMATION_RULES.map((rule) => rule.id) as [string, string, string];
const stored = (rules: unknown = DEFAULT_AUTOMATION_RULES, version = 3) => ({
  rules,
  version,
  updatedAt: '2026-10-10T08:00:00.000Z',
});
const settings = {
  defaults: {
    maxBidChangePercent: 25,
    bidFloorCpcPercent: 50,
    bidFloorEur: null,
    maxBidEur: '3.00',
    minClicks: 15,
    minSpendEur: '10.00',
    maxBudgetDecreasePercent: 20,
  },
  canEditDefaults: true,
  clients: [{ id: C1, name: 'Kunde Eins', mode: 'shadow', responsibleUserId: null, overrides: {} }],
  members: [],
};

type Responder = (request: RecordedRequest) => Response | Promise<Response>;
async function mountRules(
  overrides: Record<string, Responder | Response> = {},
  me: MeFixtureOptions = {},
) {
  const stub = stubFetch({
    'GET /api/me': json(meFixture(me)),
    'GET /api/settings/ui-state/shell/sidebar': json({ value: null }),
    'GET /api/ads/changes/pending': json({ changes: [], check: null }),
    'GET /api/ads/automations/settings': json(settings),
    'GET /api/ads/automations/rules': json(stored()),
    ...overrides,
  });
  const mounted = await mountWithApp(undefined, { path: '/ads/automations' });
  await flushPromises();
  $<HTMLButtonElement>('[data-automation-tab="rules"]')!.click();
  await vi.waitFor(() => expect($(`[data-rule-row="${R1}"]`)).not.toBeNull());
  return { ...mounted, ...stub };
}

const $ = <T extends HTMLElement = HTMLInputElement>(selector: string) =>
  document.querySelector<T>(selector);
const row = (id: string) => $<HTMLElement>(`[data-rule-row="${id}"]`)!;
const inRow = <T extends HTMLElement = HTMLButtonElement>(id: string, selector: string) =>
  row(id).querySelector<T>(selector);
const order = () =>
  [...document.querySelectorAll<HTMLElement>('[data-rule-row]')].map((li) => li.dataset.ruleRow);
const field = <T extends HTMLElement = HTMLInputElement>(name: string, condition?: number) =>
  $<T>(
    `[data-rule-form] ${condition === undefined ? '' : `[data-condition="${condition}"] `}[data-rule-field="${name}"]`,
  )!;
const sent = (requests: RecordedRequest[], method: string) =>
  requests
    .filter((r) => r.method === method && r.path.startsWith('/api/ads/automations/rules'))
    .map((r) => [r.path, r.body]);

async function click(element: HTMLElement | null | undefined) {
  element!.click();
  await flushPromises();
}
async function type(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flushPromises();
}
async function choose(select: HTMLSelectElement, value: string) {
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await flushPromises();
}

afterEach(() => {
  cleanupMounted();
  vi.unstubAllGlobals();
});

describe('Seite „Automationen“: Regeln', () => {
  it('zeigt die Regeln in ihrer Reihenfolge mit Bedingungen und Aktion, ohne die Vorschau zu laden', async () => {
    const { requests } = await mountRules();

    expect($('[role="tab"][aria-selected="true"]')!.textContent).toContain('Regeln');
    expect(order()).toEqual([R1, R2, R3]);
    expect(row(R1).textContent).toContain('Viele Klicks ohne Bestellung');
    expect(row(R1).textContent).toContain('Klicks ≥ 30');
    expect(row(R1).textContent).toContain('Bestellungen ≤ 0');
    expect(row(R1).textContent).toContain('Gebot −20 %');
    expect(row(R2).textContent).toContain('ACoS ≥ 150 % des Ziels');
    // Beträge mit geschütztem Leerzeichen vor der Währung.
    expect(row(R3).textContent).toContain('Ausgaben ≥ 50,00\u00a0€');
    expect(row(R3).textContent).toContain('Budget −10 %');
    expect(row(R1).textContent).toContain('Alle Clients');
    expect(inRow<HTMLInputElement>(R3, '[data-rule-enabled]')!.checked).toBe(false);
    expect(sent(requests, 'POST')).toEqual([]);
    // Ohne Änderung gibt es nichts zu speichern.
    expect($<HTMLButtonElement>('[data-rules-save]')!.disabled).toBe(true);
  });

  it('wechselt die Tabs mit den Pfeiltasten', async () => {
    await mountRules();
    const tab = $<HTMLElement>('[data-automation-tab="rules"]')!;
    tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await flushPromises();
    expect($('[role="tab"][aria-selected="true"]')!.textContent).toContain('Einstellungen');
    expect(document.activeElement).toBe($('[data-automation-tab="settings"]'));
  });

  it('speichert Reihenfolge und Schalter als ganze Liste mit der gelesenen Version', async () => {
    const [first, second, third] = DEFAULT_AUTOMATION_RULES;
    const next = [second, first, { ...third, enabled: true }];
    const { requests } = await mountRules({
      'PUT /api/ads/automations/rules': json(stored(next, 4)),
    });
    // Die erste Regel kann nicht weiter nach oben, die letzte nicht weiter nach unten.
    expect(inRow(R1, '[data-rule-up]')!.disabled).toBe(true);
    expect(inRow(R3, '[data-rule-down]')!.disabled).toBe(true);

    await click(inRow(R2, '[data-rule-up]'));
    expect(order()).toEqual([R2, R1, R3]);
    await click(inRow(R3, '[data-rule-enabled]'));
    await click($('[data-rules-save]'));

    expect(sent(requests, 'PUT')).toEqual([
      ['/api/ads/automations/rules', { rules: next, version: 3 }],
    ]);
    await vi.waitFor(() => expect(document.body.textContent).toContain('Gespeichert.'));
    expect($<HTMLButtonElement>('[data-rules-save]')!.disabled).toBe(true);
  });

  it('legt eine Regel im Dialog an; ungültige Werte sind markiert und sperren das Übernehmen', async () => {
    const { requests } = await mountRules({
      'PUT /api/ads/automations/rules': (request) =>
        json(stored((request.body as { rules: unknown }).rules, 4)),
    });
    await click($('[data-rule-add]'));
    const apply = () => $<HTMLButtonElement>('[data-rule-apply]')!;
    expect(apply().disabled).toBe(true);

    await type(field('name'), 'Teure Klicks');
    await choose(field<HTMLSelectElement>('client'), C1);
    await choose(field<HTMLSelectElement>('metric', 0), 'cpc');
    await choose(field<HTMLSelectElement>('comparator', 0), 'gt');
    await type(field('value', 0), '1,5x');
    expect(field('value', 0).getAttribute('aria-invalid')).toBe('true');
    expect(apply().disabled).toBe(true);
    await type(field('value', 0), '1,50');
    await click($('[data-condition-add]'));
    await choose(field<HTMLSelectElement>('metric', 1), 'acos');
    await click(field('relative', 1));
    await type(field('value', 1), '120');
    await choose(field<HTMLSelectElement>('action-type'), 'set');
    await type(field('action-value'), '0,40');
    await click(apply());

    expect($('[data-rule-form]')).toBeNull();
    expect(order()).toHaveLength(4);
    const added = order()[3]!;
    expect(row(added).textContent).toContain('CPC > 1,50\u00a0€');
    expect(row(added).textContent).toContain('Gebot auf 0,40\u00a0€');
    expect(row(added).textContent).toContain('Kunde Eins');

    await click($('[data-rules-save]'));
    const [, body] = sent(requests, 'PUT')[0]!;
    expect((body as { rules: unknown[] }).rules[3]).toEqual({
      id: added,
      name: 'Teure Klicks',
      level: 'target',
      conditions: [
        { metric: 'cpc', comparator: 'gt', value: '1.50' },
        { metric: 'acos', comparator: 'gte', value: '120', relativeToGoal: true },
      ],
      action: { type: 'set', field: 'bid', value: '0.40' },
      clientId: C1,
      enabled: true,
    });
  });

  it('bearbeitet eine Regel (Ebene Kampagne ändert das Budget, Pausieren ohne Wert) und löscht eine', async () => {
    const { requests } = await mountRules({
      'PUT /api/ads/automations/rules': (request) =>
        json(stored((request.body as { rules: unknown }).rules, 4)),
    });
    await click(inRow(R1, '[data-rule-edit]'));
    expect(field('name').value).toBe('Viele Klicks ohne Bestellung');
    expect(field('action-value').value).toBe('-20');
    await choose(field<HTMLSelectElement>('level'), 'campaign');
    await type(field('action-value'), '-12,5');
    await click($('[data-rule-apply]'));
    expect(row(R1).textContent).toContain('Budget −12,5 %');

    await click(inRow(R2, '[data-rule-edit]'));
    await choose(field<HTMLSelectElement>('action-type'), 'pause');
    expect($('[data-rule-form] [data-rule-field="action-value"]')).toBeNull();
    await click($('[data-rule-apply]'));
    expect(row(R2).textContent).toContain('Pausieren');

    await click(inRow(R3, '[data-rule-delete]'));
    expect(order()).toEqual([R1, R2]);
    await click($('[data-rules-save]'));
    const rules = (sent(requests, 'PUT')[0]![1] as { rules: { action: unknown }[] }).rules;
    expect(rules.map((rule) => rule.action)).toEqual([
      { type: 'changePercent', field: 'budget', value: '-12.5' },
      { type: 'pause' },
    ]);
  });

  it('rechnet die Vorschau nur auf Knopfdruck, auch für ungespeicherte Listen; eine Änderung verwirft sie', async () => {
    const { requests } = await mountRules({
      'POST /api/ads/automations/rules/preview': json({
        counts: [
          { ruleId: R2, entities: 1234 },
          { ruleId: R1, entities: 0 },
          { ruleId: R3, entities: 1 },
        ],
        targets: 5400,
        campaigns: 12,
      }),
    });
    await click(inRow(R2, '[data-rule-up]'));
    await click($('[data-rules-preview]'));

    const [first, second, third] = DEFAULT_AUTOMATION_RULES;
    expect(sent(requests, 'POST')).toEqual([
      ['/api/ads/automations/rules/preview', { rules: [second, first, third] }],
    ]);
    await vi.waitFor(() =>
      expect(inRow(R2, '[data-rule-count]')!.textContent).toContain('1.234 Targets'),
    );
    expect(inRow(R1, '[data-rule-count]')!.textContent).toContain('0 Targets');
    expect(inRow(R3, '[data-rule-count]')!.textContent).toContain('1 Kampagne');
    expect($('[data-rules-preview-summary]')!.textContent).toContain('5.400');

    await click(inRow(R1, '[data-rule-enabled]'));
    expect($('[data-rule-count]')).toBeNull();
    expect($('[data-rules-preview-summary]')).toBeNull();
  });

  it('meldet einen Konflikt beim Speichern und behält den Entwurf; Verwerfen lädt den Stand des Servers', async () => {
    await mountRules({
      'PUT /api/ads/automations/rules': json(
        { error: { code: 'AUTOMATION_RULES_VERSION_CONFLICT', message: 'x' } },
        409,
      ),
    });
    await click(inRow(R2, '[data-rule-up]'));
    await click($('[data-rules-save]'));
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('inzwischen von jemand anderem geändert'),
    );
    expect(order()).toEqual([R2, R1, R3]);
    await click($('[data-rules-discard]'));
    expect(order()).toEqual([R1, R2, R3]);
    expect(document.body.textContent).not.toContain('inzwischen von jemand anderem geändert');
  });

  it('verwirft den Entwurf beim Wechsel der Organisation (sonst landete er in der anderen)', async () => {
    let calls = 0;
    const third = DEFAULT_AUTOMATION_RULES[2];
    const { session } = await mountRules({
      'GET /api/ads/automations/rules': () => json(calls++ === 0 ? stored() : stored([third], 7)),
    });
    await click(inRow(R2, '[data-rule-up]'));
    session.me = { ...session.me!, activeOrganizationId: 'org-2' };
    await vi.waitFor(() => expect(order()).toEqual([R3]));
    expect($<HTMLButtonElement>('[data-rules-save]')!.disabled).toBe(true);
  });

  it('kennzeichnet Regeln eines Clients, den es nicht mehr gibt', async () => {
    const [first, second] = DEFAULT_AUTOMATION_RULES;
    await mountRules({
      'GET /api/ads/automations/rules': json(stored([first, { ...second, clientId: GONE }])),
    });
    expect(inRow<HTMLElement>(R2, '[data-rule-unknown-client]')!.textContent).toContain(
      'Client gelöscht oder nicht sichtbar',
    );
    expect(inRow(R1, '[data-rule-unknown-client]')).toBeNull();
  });

  it('Viewer lesen die Regeln und rechnen die Vorschau, ändern aber nichts', async () => {
    await mountRules({}, { orgRole: 'viewer' });
    expect(row(R1).textContent).toContain('Klicks ≥ 30');
    expect(row(R3).textContent).toContain('Abgeschaltet');
    for (const selector of [
      '[data-rule-up]',
      '[data-rule-edit]',
      '[data-rule-delete]',
      '[data-rule-enabled]',
      '[data-rule-add]',
      '[data-rules-save]',
    ]) {
      expect($(selector)).toBeNull();
    }
    expect($('[data-rules-preview]')).not.toBeNull();
  });

  it('zeigt Ladefehler mit erneutem Versuch und einen leeren Zustand', async () => {
    let calls = 0;
    const stub = stubFetch({
      'GET /api/me': json(meFixture()),
      'GET /api/settings/ui-state/shell/sidebar': json({ value: null }),
      'GET /api/ads/changes/pending': json({ changes: [], check: null }),
      'GET /api/ads/automations/settings': json(settings),
      'GET /api/ads/automations/rules': () =>
        calls++ === 0
          ? json({ error: { code: 'INTERNAL', message: 'x' } }, 500)
          : json(stored([], 1)),
    });
    await mountWithApp(undefined, { path: '/ads/automations' });
    await flushPromises();
    await click($('[data-automation-tab="rules"]'));
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Die Regeln konnten nicht geladen werden'),
    );
    const retry = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Erneut versuchen'),
    );
    await click(retry);
    await vi.waitFor(() => expect(document.body.textContent).toContain('Noch keine Regel'));
    expect(stub.requests.length).toBeGreaterThan(0);
  });
});
