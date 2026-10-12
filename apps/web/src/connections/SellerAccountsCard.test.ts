import type { SellerAccount, SellerConnection } from '@profitbash/shared';
import { DOMWrapper, flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, stubFetch } from '../test/fetch-stub';
import { clientFixture, meFixture } from '../test/fixtures';
import { cleanupMounted, mountWithApp } from '../test/mount';
import SellerAccountsCard from './SellerAccountsCard.vue';

const CONNECTION_ID = '7a1e8a2b-3c4f-4a6b-9d7e-1f2a3b4c5d6e';
const nordwind = clientFixture();

const account = (overrides: Partial<SellerAccount> = {}): SellerAccount => ({
  id: '8b1e8a2b-3c4f-4a6b-9d7e-1f2a3b4c5d6e',
  connectionId: CONNECTION_ID,
  clientId: null,
  amazonSellerId: 'A1MOCKSELLER01',
  marketplaceId: 'A1PA6795UKMFR9',
  storeName: 'Nordwind Shop',
  countryCode: 'DE',
  currencyCode: 'EUR',
  timezone: 'Europe/Berlin',
  isHidden: false,
  removedAt: null,
  syncedAt: '2026-10-12T08:00:00.000Z',
  ...overrides,
});
const de = account();
const nl = account({
  id: '9c1e8a2b-3c4f-4a6b-9d7e-1f2a3b4c5d6e',
  marketplaceId: 'A1805IZSGTT6HS',
  countryCode: 'NL',
  removedAt: '2026-10-01T03:00:00.000Z',
});
const connection = (overrides: Partial<SellerConnection> = {}): SellerConnection => ({
  id: CONNECTION_ID,
  region: 'eu',
  amazonSellerId: 'A1MOCKSELLER01',
  status: 'active',
  consentedAt: '2026-10-12T08:00:00.000Z',
  accounts: [de, nl],
  ...overrides,
});

function routes(overrides: Parameters<typeof stubFetch>[0] = {}) {
  return {
    'GET /api/me': json(meFixture()),
    'GET /api/seller-connections': json({ connections: [connection()] }),
    ...overrides,
  };
}

async function mountCard(props: { showRemoved?: boolean } = {}) {
  const mounted = await mountWithApp(
    {
      components: { SellerAccountsCard },
      data: () => ({ clients: [nordwind], showRemoved: props.showRemoved ?? false }),
      template:
        '<SellerAccountsCard :clients="clients" :clients-ready="true" :show-removed="showRemoved" />',
    },
    { path: '/admin/connections' },
  );
  await flushPromises();
  return mounted.wrapper;
}

type Wrapper = Awaited<ReturnType<typeof mountCard>>;
const button = (wrapper: Wrapper | DOMWrapper<Element>, label: string) => {
  const found = wrapper.findAll('button').filter((b) => b.text() === label);
  expect(found, `Button „${label}“`).toHaveLength(1);
  return found[0]!;
};
const dialog = () => {
  const element = document.body.querySelector<HTMLElement>('[role="dialog"]');
  return element ? new DOMWrapper(element) : null;
};

afterEach(() => {
  cleanupMounted();
  vi.unstubAllGlobals();
});

describe('SellerAccountsCard', () => {
  it('zeigt Ladezustand, dann Connection mit Seller-ID und Konten; entfernte nur auf Wunsch', async () => {
    stubFetch(routes());
    const wrapper = await mountCard();

    expect(wrapper.text()).toContain('Seller-Konten');
    expect(wrapper.text()).toContain('A1MOCKSELLER01');
    const rows = wrapper.findAll('tbody tr');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text()).toContain('Deutschland');
    expect(rows[0]!.text()).toContain('Nordwind Shop');
    expect(rows[0]!.find('.font-data').text()).toBe('EUR');

    cleanupMounted();
    const withRemoved = await mountCard({ showRemoved: true });
    expect(withRemoved.findAll('tbody tr')).toHaveLength(2);
    expect(withRemoved.text()).toContain('Entfernt');
  });

  it('zeigt den leeren Zustand und den Fehlerzustand mit „Erneut versuchen“', async () => {
    stubFetch(routes({ 'GET /api/seller-connections': json({ connections: [] }) }));
    const empty = await mountCard();
    expect(empty.text()).toContain('Noch kein Seller-Konto verbunden.');
    cleanupMounted();

    stubFetch(
      routes({
        'GET /api/seller-connections': json(
          { error: { code: 'INTERNAL_ERROR', message: 'x' } },
          500,
        ),
      }),
    );
    const failed = await mountCard();
    expect(failed.text()).toContain('Die Seller-Konten konnten nicht geladen werden.');
    button(failed, 'Erneut versuchen');
  });

  it('verbindet über „Token eintragen“ und schickt die Zugangsdaten nur an die API', async () => {
    const { requests } = stubFetch(
      routes({
        'POST /api/seller-connections': json(
          { connectionId: CONNECTION_ID, accounts: 2, skippedMarketplaceIds: [] },
          201,
        ),
      }),
    );
    const wrapper = await mountCard();
    await button(wrapper, 'Seller-Konto verbinden').trigger('click');
    await flushPromises();
    const form = dialog()!;
    expect(form.text()).toContain('Seller-ID');

    // Leere Pflichtfelder: nichts wird gesendet.
    await form.get('form').trigger('submit');
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(0);
    expect(form.text()).toContain('Bitte fülle alle Felder aus.');

    await form.get('#seller-connection-seller-id').setValue(' a1mockseller01 ');
    await form.get('#seller-connection-client-id').setValue('amzn1.application-oa2-client.x');
    await form.get('#seller-connection-client-secret').setValue('SECRET');
    await form.get('#seller-connection-refresh-token').setValue('Atzr|token');
    expect(form.get('#seller-connection-client-secret').attributes('type')).toBe('password');
    await form.get('form').trigger('submit');
    await flushPromises();

    const post = requests.find((r) => r.method === 'POST')!;
    expect(post.body).toEqual({
      region: 'eu',
      amazonSellerId: 'A1MOCKSELLER01',
      clientId: 'amzn1.application-oa2-client.x',
      clientSecret: 'SECRET',
      refreshToken: 'Atzr|token',
    });
    expect(dialog()).toBeNull();
    // Die Liste wird danach neu geladen.
    expect(
      requests.filter((r) => r.path === '/api/seller-connections' && r.method === 'GET'),
    ).toHaveLength(2);
  });

  it('zeigt die Meldung der API, wenn Amazon die Zugangsdaten ablehnt, und lässt den Dialog offen', async () => {
    stubFetch(
      routes({
        'POST /api/seller-connections': json(
          { error: { code: 'SP_ROLE_MISSING', message: 'x' } },
          400,
        ),
      }),
    );
    const wrapper = await mountCard();
    await button(wrapper, 'Seller-Konto verbinden').trigger('click');
    await flushPromises();
    const form = dialog()!;
    await form.get('#seller-connection-seller-id').setValue('A1MOCKSELLER01');
    await form.get('#seller-connection-client-id').setValue('c');
    await form.get('#seller-connection-client-secret').setValue('s');
    await form.get('#seller-connection-refresh-token').setValue('Atzr|token');
    await form.get('form').trigger('submit');
    await flushPromises();

    expect(dialog()!.text()).toContain('Selling Partner Insights');
  });

  it('öffnet „Neu verbinden“ mit Region und Seller-ID der Connection', async () => {
    stubFetch(
      routes({
        'GET /api/seller-connections': json({
          connections: [connection({ status: 'reauth_required' })],
        }),
      }),
    );
    const wrapper = await mountCard();
    expect(wrapper.text()).toContain('Neu verbinden nötig');
    await button(wrapper, 'Neu verbinden').trigger('click');
    await flushPromises();
    const sellerId = dialog()!.get<HTMLInputElement>('#seller-connection-seller-id');
    expect(sellerId.element.value).toBe('A1MOCKSELLER01');
    expect(sellerId.attributes('readonly')).toBeDefined();
  });

  it('gleicht Konten ab, blendet aus und meldet Fehler der Aktion', async () => {
    const { requests } = stubFetch(
      routes({
        [`POST /api/seller-connections/${CONNECTION_ID}/sync`]: json({
          connectionId: CONNECTION_ID,
          accounts: 1,
          skippedMarketplaceIds: [],
        }),
        [`PATCH /api/seller-accounts/${de.id}`]: json(
          { error: { code: 'INTERNAL_ERROR', message: 'x' } },
          500,
        ),
      }),
    );
    const wrapper = await mountCard();

    await button(wrapper, 'Konten abgleichen').trigger('click');
    await flushPromises();
    expect(requests.some((r) => r.path.endsWith('/sync'))).toBe(true);

    await wrapper.get('input[role="switch"]').setValue(true);
    await flushPromises();
    const patch = requests.find((r) => r.method === 'PATCH')!;
    expect(patch.body).toEqual({ isHidden: true });
    expect(wrapper.text()).toContain('Das Seller-Konto konnte nicht geändert werden.');
  });
});
