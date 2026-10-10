import type { Notification } from '@profitbash/shared';
import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, stubFetch, type RecordedRequest } from '../test/fetch-stub';
import { meFixture } from '../test/fixtures';
import { cleanupMounted, mountWithApp } from '../test/mount';

/** Glocke in der Shell (`phase-5.md` 5.2b): Zähler, neueste im Popover, alle gelesen, Abfrage beim Fokus. */

const item = (seq: number): Notification => ({
  id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
  seq,
  kind: 'file_import_imported',
  severity: 'success',
  profileId: null,
  profileName: null,
  params: { fileName: `datei-${seq}.xlsx` },
  link: null,
  createdAt: '2026-10-10T08:00:00.000Z',
  readAt: null,
});

type Responder = (request: RecordedRequest) => Response | Promise<Response>;
async function mountShell(count: number, overrides: Record<string, Responder | Response> = {}) {
  const stub = stubFetch({
    'GET /api/me': json(meFixture()),
    'GET /api/settings/ui-state/shell/sidebar': json({ value: null }),
    'GET /api/ads/changes/pending': json({ changes: [], check: null }),
    'GET /api/notifications/unread-count': json({ count }),
    'GET /api/notifications': json({ items: [item(2), item(1)], nextBefore: null }),
    'POST /api/notifications/read': json({ updated: 2 }),
    'GET /api/settings': json({}),
    ...overrides,
  });
  const mounted = await mountWithApp(undefined, { path: '/settings' });
  await flushPromises();
  return { ...mounted, ...stub };
}

const bells = () => [
  ...document.querySelectorAll<HTMLButtonElement>('button[data-notification-bell]'),
];

afterEach(() => {
  cleanupMounted();
  vi.unstubAllGlobals();
});

describe('Glocke', () => {
  it('zeigt die Zahl der ungelesenen in Sidebar und mobiler Kopfzeile', async () => {
    await mountShell(3);
    await vi.waitFor(() => expect(bells().length).toBeGreaterThanOrEqual(2));
    for (const bell of bells()) {
      expect(bell.getAttribute('aria-label')).toBe('Benachrichtigungen, 3 ungelesen');
      expect(bell.textContent).toContain('3');
    }
  });

  it('ohne ungelesene ohne Zahl; bei mehr als 99 gekürzt', async () => {
    await mountShell(0);
    await vi.waitFor(() => expect(bells().length).toBeGreaterThan(0));
    expect(bells()[0]!.getAttribute('aria-label')).toBe('Benachrichtigungen');
    expect(bells()[0]!.textContent?.trim()).toBe('');
    cleanupMounted();
    await mountShell(250);
    await vi.waitFor(() => expect(bells()[0]!.textContent).toContain('99+'));
  });

  it('öffnet die neuesten und setzt alle auf gelesen', async () => {
    const { requests, wrapper } = await mountShell(2);
    await vi.waitFor(() => expect(bells().length).toBeGreaterThan(0));
    await wrapper.find('[data-notification-bell]').trigger('click');
    await vi.waitFor(() => expect(document.querySelectorAll('[data-notification]').length).toBe(2));
    expect(document.body.textContent).toContain('datei-2.xlsx ist importiert.');
    expect(requests.find((r) => r.path === '/api/notifications')?.search).toContain('limit=5');
    const allRead = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Alle als gelesen markieren',
    );
    allRead!.click();
    await flushPromises();
    expect(requests.find((r) => r.method === 'POST')?.body).toEqual({ all: true });
    expect(document.querySelector('a[href="/notifications"]')).not.toBeNull();
  });

  it('fragt den Zähler beim Fokus des Fensters neu ab', async () => {
    const { requests } = await mountShell(1);
    await vi.waitFor(() => expect(bells().length).toBeGreaterThan(0));
    const before = requests.filter((r) => r.path === '/api/notifications/unread-count').length;
    window.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() =>
      expect(
        requests.filter((r) => r.path === '/api/notifications/unread-count').length,
      ).toBeGreaterThan(before),
    );
  });
});
