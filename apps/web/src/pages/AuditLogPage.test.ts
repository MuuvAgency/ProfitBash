import type { AuditEvent } from '@profitbash/shared';
import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, stubFetch, type RecordedRequest } from '../test/fetch-stub';
import { meFixture } from '../test/fixtures';
import { cleanupMounted, mountWithApp } from '../test/mount';

/** Seite „Audit-Log“ (`phase-6.md` 6.1): Liste, Filter aus der URL, Seiten, Zustände. */

const ANNA = { id: '00000000-0000-4000-8000-0000000000a1', name: 'Anna', email: 'anna@muuv.test' };
const event = (n: number, patch: Partial<AuditEvent> = {}): AuditEvent => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  createdAt: '2026-10-11T08:00:00.000Z',
  action: 'tag.create',
  actor: ANNA,
  target: { type: 'tag', id: 't1', name: 'Hero' },
  ...patch,
});

type Responder = (request: RecordedRequest) => Response | Promise<Response>;
function routes(overrides: Record<string, Responder | Response> = {}) {
  return {
    'GET /api/me': json(meFixture({ orgRole: 'admin' })),
    'GET /api/settings/ui-state/shell/sidebar': json({ value: null }),
    'GET /api/ads/changes/pending': json({ changes: [], check: null }),
    'GET /api/notifications/unread-count': json({ count: 0 }),
    'GET /api/audit-events/filters': json({ areas: ['member', 'tag'], actors: [ANNA] }),
    'GET /api/audit-events': (request: RecordedRequest) => {
      if (new URLSearchParams(request.search).get('cursor') === event(2).id) {
        return json({ events: [event(1, { action: 'member.create' })], nextCursor: null });
      }
      return json({
        events: [
          event(3, { action: 'neu.unbekannt', actor: null, target: { type: 'neu', id: 'n1' } }),
          event(2),
        ],
        nextCursor: event(2).id,
      });
    },
    ...overrides,
  };
}

async function mountPage(
  path = '/admin/audit',
  overrides: Record<string, Responder | Response> = {},
) {
  const stub = stubFetch(routes(overrides));
  const mounted = await mountWithApp(undefined, { path });
  await flushPromises();
  return { ...mounted, ...stub };
}

const rows = () => [...document.querySelectorAll('[data-audit-event]')];
const listRequests = (requests: RecordedRequest[]) =>
  requests.filter((r) => r.method === 'GET' && r.path === '/api/audit-events');
const button = (label: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);

afterEach(() => {
  cleanupMounted();
  vi.unstubAllGlobals();
});

describe('Seite „Audit-Log“', () => {
  it('listet Ereignisse mit Handelndem, lesbarer Aktion und Details', async () => {
    await mountPage();
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    const [first, second] = rows();
    // Unbekannte Aktion: der Schlüssel selbst; kein Nutzer: „System“.
    expect(first!.textContent).toContain('neu.unbekannt');
    expect(first!.textContent).toContain('System');
    expect(second!.textContent).toContain('Tag angelegt');
    expect(second!.textContent).toContain('Anna');
    expect(second!.textContent).toContain('Hero');
    expect(second!.querySelector('details pre')?.textContent).toContain('"name": "Hero"');
    expect(document.querySelector('h1')?.textContent).toContain('Audit-Log');
  });

  it('kennzeichnet Aktionen aus einer Impersonation mit dem Nutzer, als der gehandelt wurde', async () => {
    const BEN = '00000000-0000-4000-8000-0000000000b2';
    await mountPage('/admin/audit', {
      'GET /api/audit-events': json({
        events: [
          event(5, { target: { type: 'tag', id: 't1', impersonatedUserId: ANNA.id } }),
          event(4, { target: { type: 'tag', id: 't2', impersonatedUserId: BEN } }),
          event(3),
        ],
        nextCursor: null,
      }),
    });
    await vi.waitFor(() => expect(rows()).toHaveLength(3));
    // Name, wenn der Nutzer selbst im Log vorkommt; sonst ein allgemeiner Hinweis (die ID steht in den Details).
    expect(rows()[0]!.querySelector('[data-audit-impersonated]')?.textContent).toContain(
      'als Anna',
    );
    expect(rows()[1]!.querySelector('[data-audit-impersonated]')?.textContent).toContain(
      'als anderer Nutzer',
    );
    expect(rows()[2]!.querySelector('[data-audit-impersonated]')).toBeNull();
  });

  it('lädt ältere Ereignisse über den Cursor nach', async () => {
    const { requests } = await mountPage();
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    button('Ältere laden')!.click();
    await vi.waitFor(() => expect(rows()).toHaveLength(3));
    expect(rows()[2]!.textContent).toContain('Mitglied angelegt');
    expect(button('Ältere laden')).toBeUndefined();
    expect(new URLSearchParams(listRequests(requests).at(-1)!.search).get('cursor')).toBe(
      event(2).id,
    );
  });

  it('übernimmt die Filter aus der URL, den Zeitraum als lokale Tagesgrenzen', async () => {
    const { requests } = await mountPage(
      `/admin/audit?area=tag&actor=${ANNA.id}&from=2026-10-01&to=2026-10-11`,
    );
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    const query = new URLSearchParams(listRequests(requests)[0]!.search);
    expect(query.get('area')).toBe('tag');
    expect(query.get('actorUserId')).toBe(ANNA.id);
    expect(query.get('from')).toBe(new Date(2026, 9, 1).toISOString());
    // Der letzte Tag gehört ganz dazu.
    expect(query.get('to')).toBe(new Date(2026, 9, 12).toISOString());
  });

  it('ignoriert ungültige Filter in der URL', async () => {
    const { requests } = await mountPage('/admin/audit?area=Tag%25&actor=1&from=gestern');
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    expect(listRequests(requests)[0]!.search).toBe('');
  });

  it('zeigt den leeren Zustand, mit Filter samt „Filter zurücksetzen“', async () => {
    const empty = { 'GET /api/audit-events': json({ events: [], nextCursor: null }) };
    await mountPage('/admin/audit', empty);
    await vi.waitFor(() => expect(document.body.textContent).toContain('Noch keine Ereignisse'));
    cleanupMounted();
    const { router } = await mountPage('/admin/audit?area=tag', empty);
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Keine Ereignisse für diesen Filter.'),
    );
    button('Filter zurücksetzen')!.click();
    await vi.waitFor(() => expect(router.currentRoute.value.query).toEqual({}));
  });

  it('zeigt einen Fehler mit „Erneut versuchen“, wenn das Laden scheitert', async () => {
    await mountPage('/admin/audit', {
      'GET /api/audit-events': json({ error: { code: 'INTERNAL', message: 'kaputt' } }, 500),
    });
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Das Audit-Log konnte nicht geladen werden.'),
    );
    expect(button('Erneut versuchen')).toBeDefined();
  });
});
