import type { Notification } from '@profitbash/shared';
import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, stubFetch, type RecordedRequest } from '../test/fetch-stub';
import { meFixture } from '../test/fixtures';
import { cleanupMounted, mountWithApp } from '../test/mount';

/** Seite „Benachrichtigungen“ (`phase-5.md` 5.2b): Liste, Filter, gelesen setzen, Seiten, Zustände. */

const P1 = '00000000-0000-4000-8000-0000000000a1';
const item = (seq: number, patch: Partial<Notification> = {}): Notification => ({
  id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
  seq,
  kind: 'bulk_file_stale',
  severity: 'warning',
  profileId: P1,
  profileName: 'Nordwind DE',
  params: { days: 9 },
  link: null,
  createdAt: '2026-10-10T08:00:00.000Z',
  readAt: null,
  ...patch,
});

type Responder = (request: RecordedRequest) => Response | Promise<Response>;
function routes(overrides: Record<string, Responder | Response> = {}) {
  return {
    'GET /api/me': json(meFixture()),
    'GET /api/settings/ui-state/shell/sidebar': json({ value: null }),
    'GET /api/ads/changes/pending': json({ changes: [], check: null }),
    'GET /api/notifications/unread-count': json({ count: 1 }),
    'GET /api/notifications': (request: RecordedRequest) => {
      const query = new URLSearchParams(request.search);
      if (query.get('before') === '3') {
        return json({ items: [item(2, { readAt: '2026-10-10T09:00:00.000Z' })], nextBefore: null });
      }
      return json({
        items: [
          item(4, {
            kind: 'file_import_failed',
            severity: 'error',
            params: { fileName: 'bulk.xlsx', error: 'Spalte fehlt.' },
            link: '/admin/connections',
          }),
          item(3, { readAt: '2026-10-10T09:00:00.000Z' }),
        ],
        nextBefore: 3,
      });
    },
    'POST /api/notifications/read': json({ updated: 1 }),
    ...overrides,
  };
}

async function mountPage(overrides: Record<string, Responder | Response> = {}) {
  const stub = stubFetch(routes(overrides));
  const mounted = await mountWithApp(undefined, { path: '/notifications' });
  await flushPromises();
  return { ...mounted, ...stub };
}

const button = (label: string) =>
  [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label,
  );
const listRequests = (requests: RecordedRequest[]) =>
  requests.filter((r) => r.method === 'GET' && r.path === '/api/notifications');
const items = () => [...document.querySelectorAll('[data-notification]')];

afterEach(() => {
  cleanupMounted();
  vi.unstubAllGlobals();
});

describe('Seite „Benachrichtigungen“', () => {
  it('listet Benachrichtigungen mit Titel, Text, Profil und Lesestatus', async () => {
    await mountPage();
    await vi.waitFor(() => expect(items()).toHaveLength(2));
    const [first, second] = items();
    expect(first!.textContent).toContain('Import fehlgeschlagen');
    expect(first!.textContent).toContain('bulk.xlsx (Nordwind DE): Spalte fehlt.');
    expect(first!.getAttribute('data-unread')).toBe('true');
    expect(second!.getAttribute('data-unread')).toBe('false');
    expect(second!.textContent).toContain('Seit 9 Tagen keine neue Bulk-Datei für Nordwind DE.');
    expect(document.querySelector('h1')?.textContent).toContain('Benachrichtigungen');
  });

  it('bietet die Profile der Liste als Filter an, auch mit Daten aus dem Cache', async () => {
    const { router } = await mountPage({ 'GET /api/settings': json({}) });
    const profileLabel = () => document.querySelector('#notifications-filter-profile');
    await vi.waitFor(() => expect(profileLabel()).not.toBeNull());
    await router.push('/settings');
    await flushPromises();
    await router.push('/notifications');
    await flushPromises();
    await vi.waitFor(() => expect(items()).toHaveLength(2));
    expect(profileLabel()).not.toBeNull();
  });

  it('setzt Filter und gemerkte Profile beim Wechsel der Organisation zurück', async () => {
    const { session } = await mountPage();
    const profileLabel = () => document.querySelector('#notifications-filter-profile');
    await vi.waitFor(() => expect(profileLabel()).not.toBeNull());
    button('Ungelesen')!.click();
    await flushPromises();
    session.me = { ...session.me!, activeOrganizationId: '00000000-0000-4000-8000-0000000000ff' };
    await flushPromises();
    expect(button('Alle')!.getAttribute('aria-pressed')).toBe('true');
    await vi.waitFor(() => expect(items()).toHaveLength(2));
    // Die Profile kommen aus der Liste der neuen Organisation (hier dieselbe Antwort), nicht aus der alten.
    expect(profileLabel()).not.toBeNull();
  });

  it('setzt einzelne und alle auf gelesen', async () => {
    const { requests } = await mountPage();
    await vi.waitFor(() => expect(items()).toHaveLength(2));
    button('Als gelesen markieren')!.click();
    await flushPromises();
    button('Alle als gelesen markieren')!.click();
    await flushPromises();
    const posts = requests.filter((r) => r.method === 'POST');
    expect(posts.map((r) => r.body)).toEqual([{ ids: [item(4).id] }, { all: true }]);
    // Danach neu geladen.
    expect(listRequests(requests).length).toBeGreaterThan(1);
  });

  it('öffnet den Link und setzt die Benachrichtigung dabei auf gelesen', async () => {
    const { requests, router } = await mountPage({
      'GET /api/admin/connections': json({ connections: [] }),
    });
    await vi.waitFor(() => expect(items()).toHaveLength(2));
    const link = items()[0]!.querySelector<HTMLAnchorElement>('a[href="/admin/connections"]');
    expect(link).not.toBeNull();
    link!.click();
    await flushPromises();
    expect(requests.find((r) => r.method === 'POST')?.body).toEqual({ ids: [item(4).id] });
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/admin/connections'));
  });

  it('lädt ältere nach und filtert nach ungelesen', async () => {
    const { requests } = await mountPage();
    await vi.waitFor(() => expect(items()).toHaveLength(2));
    button('Ältere laden')!.click();
    await vi.waitFor(() => expect(items()).toHaveLength(3));
    expect(listRequests(requests).at(-1)!.search).toContain('before=3');

    button('Ungelesen')!.click();
    await flushPromises();
    expect(listRequests(requests).at(-1)!.search).toContain('unread=true');
  });

  it('zeigt einen leeren Zustand', async () => {
    await mountPage({ 'GET /api/notifications': json({ items: [], nextBefore: null }) });
    await vi.waitFor(() => expect(document.body.textContent).toContain('Keine Benachrichtigungen'));
  });

  it('zeigt einen Fehler mit erneutem Versuch', async () => {
    let fail = true;
    await mountPage({
      'GET /api/notifications': () =>
        fail
          ? json({ error: { code: 'INTERNAL', message: 'kaputt' } }, 500)
          : json({ items: [item(1)], nextBefore: null }),
    });
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        'Die Benachrichtigungen konnten nicht geladen werden.',
      ),
    );
    fail = false;
    button('Erneut versuchen')!.click();
    await vi.waitFor(() => expect(items()).toHaveLength(1));
  });
});
