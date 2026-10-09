import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, stubFetch, type RecordedRequest } from '../test/fetch-stub';
import { meFixture } from '../test/fixtures';
import { cleanupMounted, mountWithApp } from '../test/mount';

/** Seite „Produktgruppen“ (`phase-4.md` 4.1): Gruppen je Profil anlegen, ändern, löschen. */

const P1 = '00000000-0000-4000-8000-0000000000a1';
const P2 = '00000000-0000-4000-8000-0000000000a2';
const C1 = '00000000-0000-4000-8000-0000000000c1';
const G1 = '00000000-0000-4000-8000-0000000000b1';
const G2 = '00000000-0000-4000-8000-0000000000b2';

const group = (id: string, profileId: string, name: string, items: unknown[]) => ({
  id,
  profileId,
  name,
  items,
  createdAt: '2026-10-09T08:00:00.000Z',
  updatedAt: '2026-10-09T08:00:00.000Z',
});
const listResponse = (groups: unknown[]) => ({
  groups,
  profiles: [
    { id: P1, accountName: 'Waldkauz DE', countryCode: 'DE', accountType: 'seller', clientId: C1 },
    {
      id: P2,
      accountName: 'Waldkauz Vendor',
      countryCode: 'FR',
      accountType: 'vendor',
      clientId: null,
    },
  ],
  clients: [{ id: C1, name: 'Waldkauz' }],
  maxGroups: 2000,
  maxItems: 100,
});
const flaschen = group(G1, P1, 'Flaschen', [
  { asin: 'B0FLASCHE1', sku: 'FL-750', isHero: true },
  { asin: 'B0FLASCHE2', sku: 'FL-500', isHero: false },
]);
const vendorGroup = group(G2, P2, 'Dosen', [{ asin: 'B0DOSE0001', sku: null, isHero: false }]);

type Responder = (request: RecordedRequest) => Response | Promise<Response>;
function routes(overrides: Record<string, Responder | Response> = {}) {
  return {
    'GET /api/me': json(meFixture()),
    'GET /api/settings/ui-state/shell/sidebar': json({ value: null }),
    'GET /api/ads/changes/pending': json({ changes: [], check: null }),
    'GET /api/ads/tools/product-groups': json(listResponse([flaschen, vendorGroup])),
    'GET /api/ads/tools/advertised-products': json({
      truncated: false,
      products: [
        {
          asin: 'B0FLASCHE1',
          sku: 'FL-750',
          adProducts: ['SPONSORED_PRODUCTS'],
          enabled: true,
          groupIds: [G1],
        },
        {
          asin: 'B0BECHER01',
          sku: 'BE-1',
          adProducts: ['SPONSORED_PRODUCTS', 'SPONSORED_BRANDS'],
          enabled: false,
          groupIds: [],
        },
      ],
    }),
    ...overrides,
  };
}

async function mountPage(
  overrides: Record<string, Responder | Response> = {},
  path = '/ads/tools/product-groups',
) {
  const stub = stubFetch(routes(overrides));
  const mounted = await mountWithApp(undefined, { path });
  await flushPromises();
  return { ...mounted, ...stub };
}

const button = (label: string) =>
  [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim().includes(label) || b.getAttribute('aria-label') === label,
  );
const sent = (requests: RecordedRequest[], method: string) =>
  requests.filter((r) => r.method === method && r.path.startsWith('/api/ads/tools/product-groups'));
const found = <T extends Element>(selector: string) =>
  vi.waitFor(() => {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error(`nicht gefunden: ${selector}`);
    return element;
  });
async function type(selector: string, value: string) {
  const input = await found<HTMLInputElement>(selector);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flushPromises();
}
async function choose(selector: string, value: string) {
  const select = await found<HTMLSelectElement>(selector);
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await flushPromises();
}

afterEach(() => {
  cleanupMounted();
  vi.unstubAllGlobals();
});

describe('Seite „Produktgruppen“', () => {
  it('listet die Gruppen je Profil mit Client, Hero und Zahl der Produkte', async () => {
    await mountPage();
    const list = await found('[data-group-list]');
    expect(list.textContent).toContain('Flaschen');
    expect(list.textContent).toContain('Waldkauz DE');
    expect(list.textContent).toContain('Waldkauz');
    expect(list.textContent).toContain('B0FLASCHE1');
    expect(list.textContent).toContain('2 Produkte');
    expect(list.textContent).toContain('Dosen');
  });

  it('filtert nach Profil', async () => {
    await mountPage();
    await choose('[data-profile-filter]', P2);
    const list = await found('[data-group-list]');
    expect(list.textContent).toContain('Dosen');
    expect(list.textContent).not.toContain('Flaschen');
  });

  it('öffnet „Tools“ auf den Produktgruppen', async () => {
    const { router } = await mountPage({}, '/ads/tools');
    await vi.waitFor(() =>
      expect(router.currentRoute.value.path).toBe('/ads/tools/product-groups'),
    );
  });

  it('zeigt einen leeren Zustand und für Viewer keine Schaltflächen zum Ändern', async () => {
    await mountPage({
      'GET /api/me': json(meFixture({ orgRole: 'viewer' })),
      'GET /api/ads/tools/product-groups': json(listResponse([])),
    });
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Noch keine Produktgruppen'),
    );
    expect(document.querySelector('[data-group-new]')).toBeNull();
  });

  it('zeigt einen Fehler mit erneutem Versuch', async () => {
    await mountPage({
      'GET /api/ads/tools/product-groups': json({ error: { code: 'X', message: 'kaputt' } }, 500),
    });
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        'Die Produktgruppen konnten nicht geladen werden.',
      ),
    );
  });

  it('legt eine Gruppe aus beworbenen Produkten und einer Handeingabe an', async () => {
    const { requests } = await mountPage({
      'POST /api/ads/tools/product-groups': json(group(G2, P1, 'Becher', []), 201),
    });
    (await found<HTMLButtonElement>('[data-group-new]')).click();
    await choose('[data-group-profile]', P1);
    await type('[data-group-name]', '  Becher  ');

    const pick = await found<HTMLInputElement>('input[data-product-pick="B0BECHER01|BE-1"]');
    pick.click();
    await flushPromises();
    // Schon in einer anderen Gruppe: Hinweis, trotzdem wählbar.
    expect(document.body.textContent).toContain('auch in: Flaschen');

    await type('[data-manual-asin]', 'b0becher02');
    await type('[data-manual-sku]', 'BE-2');
    (await found<HTMLButtonElement>('[data-manual-add]')).click();
    await flushPromises();
    (await found<HTMLInputElement>('input[name="group-hero"][value="B0BECHER02|BE-2"]')).click();
    await flushPromises();

    (await found<HTMLButtonElement>('[data-group-save]')).click();
    await flushPromises();
    expect(sent(requests, 'POST').map((r) => r.body)).toEqual([
      {
        profileId: P1,
        name: 'Becher',
        items: [
          { asin: 'B0BECHER01', sku: 'BE-1', isHero: false },
          { asin: 'B0BECHER02', sku: 'BE-2', isHero: true },
        ],
      },
    ]);
    await vi.waitFor(() => expect(document.querySelector('[data-group-name]')).toBeNull());
  });

  it('prüft die Handeingabe (ASIN-Format, SKU-Pflicht bei Sellern, doppelte Produkte)', async () => {
    await mountPage();
    (await found<HTMLButtonElement>('[data-group-new]')).click();
    await choose('[data-group-profile]', P1);
    const add = await found<HTMLButtonElement>('[data-manual-add]');

    await type('[data-manual-asin]', 'B0KURZ');
    add.click();
    await flushPromises();
    expect(document.body.textContent).toContain('Eine ASIN hat 10 Zeichen');

    await type('[data-manual-asin]', 'B0BECHER02');
    await type('[data-manual-sku]', '');
    add.click();
    await flushPromises();
    expect(document.body.textContent).toContain('Seller-Profile brauchen je Produkt eine SKU.');

    await type('[data-manual-sku]', 'BE-2');
    add.click();
    await flushPromises();
    await type('[data-manual-asin]', 'B0BECHER02');
    await type('[data-manual-sku]', 'BE-2');
    add.click();
    await flushPromises();
    expect(document.body.textContent).toContain('Das Produkt ist schon in der Gruppe.');
    expect(document.querySelectorAll('[data-item]')).toHaveLength(1);
  });

  it('ändert eine Gruppe (Profil fest, Produkte vorbelegt) und entfernt ein Produkt', async () => {
    const { requests } = await mountPage({
      [`PATCH /api/ads/tools/product-groups/${G1}`]: json(flaschen),
    });
    await vi.waitFor(() => expect(button('Produktgruppe „Flaschen“ ändern')).toBeDefined());
    button('Produktgruppe „Flaschen“ ändern')!.click();
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLInputElement>('[data-group-name]')?.value).toBe('Flaschen'),
    );
    expect(document.querySelector('[data-group-profile]')).toBeNull();
    expect(document.querySelectorAll('[data-item]')).toHaveLength(2);

    button('Produkt B0FLASCHE2 entfernen')!.click();
    await flushPromises();
    await type('[data-group-name]', 'Trinkflaschen');
    (await found<HTMLButtonElement>('[data-group-save]')).click();
    await flushPromises();

    expect(sent(requests, 'PATCH').map((r) => r.body)).toEqual([
      { name: 'Trinkflaschen', items: [{ asin: 'B0FLASCHE1', sku: 'FL-750', isHero: true }] },
    ]);
  });

  it('meldet einen vergebenen Namen im Dialog', async () => {
    await mountPage({
      [`PATCH /api/ads/tools/product-groups/${G1}`]: json(
        { error: { code: 'PRODUCT_GROUP_NAME_TAKEN', message: 'vergeben' } },
        409,
      ),
    });
    await vi.waitFor(() => expect(button('Produktgruppe „Flaschen“ ändern')).toBeDefined());
    button('Produktgruppe „Flaschen“ ändern')!.click();
    (await found<HTMLButtonElement>('[data-group-save]')).click();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        'Eine Produktgruppe mit diesem Namen gibt es im Profil schon.',
      ),
    );
  });

  it('löscht eine Gruppe nach Rückfrage', async () => {
    const { requests } = await mountPage({
      [`DELETE /api/ads/tools/product-groups/${G1}`]: new Response(null, { status: 204 }),
    });
    await vi.waitFor(() => expect(button('Produktgruppe „Flaschen“ löschen')).toBeDefined());
    button('Produktgruppe „Flaschen“ löschen')!.click();
    (await found<HTMLButtonElement>('[data-group-delete]')).click();
    await flushPromises();
    expect(sent(requests, 'DELETE').map((r) => r.path)).toEqual([
      `/api/ads/tools/product-groups/${G1}`,
    ]);
  });
});
