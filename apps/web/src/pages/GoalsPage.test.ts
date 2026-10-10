import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, stubFetch, type RecordedRequest } from '../test/fetch-stub';
import { meFixture } from '../test/fixtures';
import { cleanupMounted, mountWithApp } from '../test/mount';

/** Seite „Ziele“ (`phase-5.md` 5.3): Ziel-ACoS bzw. -ROAS je Client, Profil und Produktgruppe, mit Rechner. */

const C1 = '00000000-0000-4000-8000-0000000000c1';
const P1 = '00000000-0000-4000-8000-0000000000a1';
const P2 = '00000000-0000-4000-8000-0000000000a2';
const G1 = '00000000-0000-4000-8000-0000000000b1';
const G2 = '00000000-0000-4000-8000-0000000000b2';
const GOAL = '00000000-0000-4000-8000-0000000000d1';
const goal = (metric: 'acos' | 'roas', acos: string, roas: string, id = GOAL) => ({
  id,
  metric,
  value: metric === 'acos' ? acos : roas,
  acos,
  roas,
  updatedAt: '2026-10-10T08:00:00.000Z',
});
const overview = {
  clients: [
    {
      id: C1,
      name: 'Kunde Eins',
      goal: goal('acos', '25', '4'),
      profiles: [
        {
          id: P1,
          accountName: 'Shop DE',
          countryCode: 'DE',
          goal: null,
          productGroups: [
            { id: G1, name: 'Bestseller', goal: goal('acos', '12.5', '8', G2) },
            { id: G2, name: 'Neuheiten', goal: null },
          ],
        },
      ],
    },
  ],
  unassignedProfiles: [
    { id: P2, accountName: 'Solo FR', countryCode: 'FR', goal: null, productGroups: [] },
  ],
};

type Responder = (request: RecordedRequest) => Response | Promise<Response>;
async function mountPage(overrides: Record<string, Responder | Response> = {}) {
  const stub = stubFetch({
    'GET /api/me': json(meFixture()),
    'GET /api/settings/ui-state/shell/sidebar': json({ value: null }),
    'GET /api/ads/changes/pending': json({ changes: [], check: null }),
    'GET /api/ads/goals': json(overview),
    ...overrides,
  });
  const mounted = await mountWithApp(undefined, { path: '/ads/goals' });
  await flushPromises();
  return { ...mounted, ...stub };
}

const button = (label: string) =>
  [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim().includes(label) || b.getAttribute('aria-label') === label,
  );
const row = (id: string) => document.querySelector(`[data-goal-row="${id}"]`);
const sent = (requests: RecordedRequest[], method: string) =>
  requests.filter((r) => r.method === method && r.path.startsWith('/api/ads/goals'));

async function type(selector: string, value: string) {
  const input = await vi.waitFor(() => {
    const found = document.querySelector<HTMLInputElement>(selector);
    if (!found) throw new Error(`kein Feld ${selector}`);
    return found;
  });
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flushPromises();
}
async function openEdit(label: string) {
  await vi.waitFor(() => expect(button(label)).toBeDefined());
  button(label)!.click();
  await vi.waitFor(() => expect(document.querySelector('[data-goal-value]')).not.toBeNull());
}

afterEach(() => {
  cleanupMounted();
  vi.unstubAllGlobals();
});

describe('Seite „Ziele“', () => {
  it('zeigt je Client eigene und geerbte Ziele, Profile ohne Client getrennt', async () => {
    await mountPage();
    await vi.waitFor(() => expect(row(C1)).not.toBeNull());

    expect(row(C1)!.textContent).toContain('Kunde Eins');
    expect(row(C1)!.textContent).toContain('ACoS 25 %');
    expect(row(C1)!.textContent).toContain('ROAS 4');
    // Profil ohne eigenes Ziel erbt vom Client, Gruppe ohne Ziel ebenso; die Gruppe mit Ziel zeigt ihr eigenes.
    expect(row(P1)!.textContent).toContain('ACoS 25 %');
    expect(row(P1)!.textContent).toContain('gilt vom Client');
    expect(row(G1)!.textContent).toContain('ACoS 12,5 %');
    expect(row(G1)!.textContent).not.toContain('gilt vom');
    expect(row(G2)!.textContent).toContain('gilt vom Client');
    expect(row(P2)!.textContent).toContain('Kein Ziel');
    expect(document.body.textContent).toContain('Ohne Client');
    expect(document.body.textContent).toContain('braucht Umsatzdaten (Phase 7)');
  });

  it('setzt ein Ziel als ROAS und zeigt den ACoS als Vorschau', async () => {
    const { requests } = await mountPage({ 'PUT /api/ads/goals': json(goal('roas', '20', '5')) });
    await openEdit('Ziel für „Shop DE · DE“ bearbeiten');
    document.querySelector<HTMLInputElement>('input[name="goal-metric"][value="roas"]')!.click();
    await type('[data-goal-value]', '5');
    expect(document.querySelector('[data-goal-preview]')!.textContent).toContain('ACoS 20 %');
    document.querySelector<HTMLButtonElement>('[data-goal-save]')!.click();
    await flushPromises();

    expect(sent(requests, 'PUT').map((r) => r.body)).toEqual([
      { scope: { type: 'profile', id: P1 }, metric: 'roas', value: '5' },
    ]);
    expect(sent(requests, 'GET').length).toBeGreaterThan(1);
    await vi.waitFor(() => expect(document.querySelector('[data-goal-value]')).toBeNull());
  });

  it('sperrt das Speichern bei ungültigem Wert und meldet Fehler der API', async () => {
    await mountPage({
      'PUT /api/ads/goals': json(
        { error: { code: 'GOAL_NOT_FOUND', message: 'Ziel oder Ziel-Objekt nicht gefunden.' } },
        404,
      ),
    });
    await openEdit('Ziel für „Kunde Eins“ bearbeiten');
    const save = () => document.querySelector<HTMLButtonElement>('[data-goal-save]')!;
    expect(document.querySelector<HTMLInputElement>('[data-goal-value]')!.value).toBe('25');
    await type('[data-goal-value]', '120');
    expect(save().disabled).toBe(true);
    expect(document.body.textContent).toContain('ACoS über 0 bis 100 %');
    await type('[data-goal-value]', '30,5');
    expect(save().disabled).toBe(false);
    save().click();

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Dieses Ziel oder sein Objekt gibt es nicht'),
    );
  });

  it('rechnet den Ziel-ACoS auf dem Server und übernimmt ihn', async () => {
    const { requests } = await mountPage({
      'POST /api/ads/goals/calculate': json({
        breakEvenAcos: '40',
        targetAcos: '25',
        targetRoas: '4',
      }),
    });
    await openEdit('Ziel für „Neuheiten“ bearbeiten');
    button('Rechner')!.click();
    await type('[data-calc="price"]', '20');
    await type('[data-calc="unitCost"]', '6');
    await type('[data-calc="fees"]', '6');
    await type('[data-calc="margin"]', '15');
    document.querySelector<HTMLButtonElement>('[data-calc-run]')!.click();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-calc-result]')?.textContent).toContain('40 %'),
    );
    expect(sent(requests, 'POST').map((r) => r.body)).toEqual([
      { price: '20', unitCost: '6', fees: '6', margin: '15' },
    ]);

    document.querySelector<HTMLButtonElement>('[data-calc-apply]')!.click();
    await flushPromises();
    expect(document.querySelector<HTMLInputElement>('[data-goal-value]')!.value).toBe('25');
    expect(
      document.querySelector<HTMLInputElement>('input[name="goal-metric"][value="acos"]')!.checked,
    ).toBe(true);
  });

  it('entfernt ein Ziel', async () => {
    const { requests } = await mountPage({
      [`DELETE /api/ads/goals/${GOAL}`]: new Response(null, { status: 204 }),
    });
    await openEdit('Ziel für „Kunde Eins“ bearbeiten');
    document.querySelector<HTMLButtonElement>('[data-goal-delete]')!.click();
    await flushPromises();

    expect(sent(requests, 'DELETE').map((r) => r.path)).toEqual([`/api/ads/goals/${GOAL}`]);
    await vi.waitFor(() => expect(document.querySelector('[data-goal-value]')).toBeNull());
  });

  it('Leerzustand, Fehler und Viewer ohne Aktionen', async () => {
    await mountPage({ 'GET /api/ads/goals': json({ clients: [], unassignedProfiles: [] }) });
    await vi.waitFor(() => expect(document.body.textContent).toContain('Noch keine Profile'));
    cleanupMounted();
    vi.unstubAllGlobals();

    await mountPage({
      'GET /api/ads/goals': json({ error: { code: 'INTERNAL', message: 'kaputt' } }, 500),
    });
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Die Ziele konnten nicht geladen werden.'),
    );
    cleanupMounted();
    vi.unstubAllGlobals();

    await mountPage({ 'GET /api/me': json(meFixture({ orgRole: 'viewer' })) });
    await vi.waitFor(() => expect(row(C1)).not.toBeNull());
    expect(button('Ziel für „Kunde Eins“ bearbeiten')).toBeUndefined();
  });
});
