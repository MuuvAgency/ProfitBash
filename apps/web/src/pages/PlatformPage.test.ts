import type { PlatformOrganization } from '@profitbash/shared';
import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, stubFetch, type RecordedRequest } from '../test/fetch-stub';
import { meFixture } from '../test/fixtures';
import { cleanupMounted, mountWithApp } from '../test/mount';

/** Seite „Plattform“ (`phase-6.md` 6.4): Reiter Orgs · Entitlements · Staff, nur Superadmins. */

const org = (n: number, patch: Partial<PlatformOrganization> = {}): PlatformOrganization => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  name: 'Muuv',
  slug: 'muuv',
  type: 'internal',
  customerOrg: false,
  memberCount: 3,
  client: null,
  features: ['dashboard', 'tags'],
  createdAt: '2026-09-25T08:00:00.000Z',
  ...patch,
});
const MUUV = org(1);
const NORDWIND = org(2, {
  name: 'Nordwind GmbH',
  slug: 'kunde-nordwind',
  type: 'client',
  customerOrg: true,
  memberCount: 1,
  client: { id: org(9).id, name: 'Nordwind', ownerOrganizationId: MUUV.id },
  features: ['dashboard'],
});
const ADA = { id: org(11).id, name: 'Ada', email: 'ada@muuv.test', isSelf: true };
const PIA = { id: org(12).id, name: 'Pia', email: 'pia@muuv.test', isSelf: false };

type Responder = (request: RecordedRequest) => Response | Promise<Response>;
function routes(overrides: Record<string, Responder | Response> = {}) {
  return {
    'GET /api/me': json(meFixture({ platformRole: 'superadmin' })),
    'GET /api/settings/ui-state/shell/sidebar': json({ value: null }),
    'GET /api/ads/changes/pending': json({ changes: [], check: null }),
    'GET /api/notifications/unread-count': json({ count: 0 }),
    'GET /api/platform/organizations': json({ organizations: [MUUV, NORDWIND] }),
    'GET /api/platform/staff': json({ staff: [ADA, PIA] }),
    'GET /api/platform/audit-events': json({
      events: [
        {
          id: org(21).id,
          createdAt: '2026-10-12T08:00:00.000Z',
          action: 'platform.staff_grant',
          actor: { id: ADA.id, name: 'Ada', email: ADA.email },
          target: { type: 'user', id: PIA.id, email: PIA.email },
        },
      ],
      nextCursor: null,
    }),
    ...overrides,
  };
}

async function mountPage(
  path = '/admin/platform',
  overrides: Record<string, Responder | Response> = {},
) {
  const stub = stubFetch(routes(overrides));
  const mounted = await mountWithApp(undefined, { path });
  await flushPromises();
  return { ...mounted, ...stub };
}

const q = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const all = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];
const set = (selector: string, value: string) => {
  const input = q<HTMLInputElement>(selector);
  input.value = value;
  input.dispatchEvent(new Event('input'));
};
const written = (requests: RecordedRequest[]) => requests.filter((r) => r.method !== 'GET');

afterEach(() => {
  cleanupMounted();
  vi.unstubAllGlobals();
});

describe('Seite „Plattform“', () => {
  it('ist nur für Superadmins erreichbar', async () => {
    const { router } = await mountPage('/admin/platform', {
      'GET /api/me': json(meFixture({ orgRole: 'admin' })),
    });
    expect(router.currentRoute.value.name).toBe('forbidden');
  });

  it('listet die Organisationen mit Typ, Mitgliedern und Client', async () => {
    await mountPage();
    await vi.waitFor(() => expect(all('[data-platform-org]')).toHaveLength(2));
    const [muuv, nordwind] = all('[data-platform-org]');
    expect(muuv!.textContent).toContain('Muuv');
    expect(muuv!.textContent).toContain('Agentur');
    expect(muuv!.textContent).toContain('3 Mitglieder');
    expect(nordwind!.textContent).toContain('Kunden-Org');
    expect(nordwind!.textContent).toContain('Client: Nordwind');
    expect(nordwind!.textContent).toContain('1 Mitglied');
    expect(q('[role=tab][aria-selected=true]').textContent).toContain('Orgs');
  });

  it('legt eine Organisation an und benennt eine um', async () => {
    const { requests } = await mountPage('/admin/platform', {
      'POST /api/platform/organizations': json(org(3, { name: 'Zwei', slug: 'zwei' }), 201),
      [`PATCH /api/platform/organizations/${MUUV.id}`]: json({ ...MUUV, name: 'Muuv GmbH' }),
    });
    await vi.waitFor(() => expect(all('[data-platform-org]')).toHaveLength(2));
    q('[data-platform-org-create]').click();
    await vi.waitFor(() => expect(q('[data-platform-org-name]')).not.toBeNull());
    set('[data-platform-org-name]', ' Zwei ');
    q('[data-platform-org-submit]').click();
    await vi.waitFor(() => expect(written(requests)).toHaveLength(1));
    expect(written(requests)[0]).toMatchObject({
      method: 'POST',
      path: '/api/platform/organizations',
      body: { name: 'Zwei' },
    });

    // Die neue Organisation gehört ins Account-Menü: `/api/me` wird neu geladen.
    await vi.waitFor(() =>
      expect(requests.filter((r) => r.path === '/api/me').length).toBeGreaterThan(1),
    );
    await vi.waitFor(() => expect(document.querySelector('[data-platform-org-name]')).toBeNull());
    q('[data-platform-org="muuv"] [data-platform-org-rename]').click();
    await vi.waitFor(() =>
      expect(q<HTMLInputElement>('[data-platform-org-name]').value).toBe('Muuv'),
    );
    set('[data-platform-org-name]', 'Muuv GmbH');
    q('[data-platform-org-submit]').click();
    await vi.waitFor(() => expect(written(requests)).toHaveLength(2));
    expect(written(requests)[1]).toMatchObject({ method: 'PATCH', body: { name: 'Muuv GmbH' } });
  });

  it('zeigt die Mitglieder einer Organisation und startet „Als Nutzer ansehen“', async () => {
    let impersonating = false;
    const { requests, router } = await mountPage('/admin/platform', {
      'GET /api/me': () =>
        json(
          impersonating
            ? { ...meFixture({ orgRole: 'editor' }), impersonatedBy: { id: ADA.id, name: 'Ada' } }
            : meFixture({ platformRole: 'superadmin' }),
        ),
      [`GET /api/platform/organizations/${MUUV.id}/members`]: json({
        members: [
          { userId: ADA.id, name: 'Ada', email: ADA.email, role: 'admin', superadmin: true },
          { userId: PIA.id, name: 'Pia', email: PIA.email, role: 'editor', superadmin: false },
        ],
      }),
      'POST /api/platform/impersonation': () => {
        impersonating = true;
        return new Response(null, { status: 204 });
      },
    });
    await vi.waitFor(() => expect(all('[data-platform-org]')).toHaveLength(2));
    q('[data-platform-org="muuv"] [data-platform-org-members]').click();
    await vi.waitFor(() => expect(all('[data-platform-member]')).toHaveLength(2));
    // Superadmins lassen sich nicht ansehen.
    expect(
      document.querySelector('[data-platform-member="ada@muuv.test"] [data-platform-impersonate]'),
    ).toBeNull();
    q('[data-platform-member="pia@muuv.test"] [data-platform-impersonate]').click();
    await vi.waitFor(() => expect(written(requests).length).toBeGreaterThan(0));
    expect(written(requests)[0]).toMatchObject({
      method: 'POST',
      path: '/api/platform/impersonation',
      body: { userId: PIA.id },
    });
    // Danach gilt die Session des Nutzers: Startseite statt Plattform-Admin, Banner in der Shell.
    await vi.waitFor(() => expect(router.currentRoute.value.path).not.toContain('/admin/platform'));
    await vi.waitFor(() =>
      expect(document.querySelector('[data-impersonation-banner]')).not.toBeNull(),
    );
  });

  it('zeigt den Fehler der API im Dialog', async () => {
    await mountPage('/admin/platform', {
      'POST /api/platform/organizations': json(
        { error: { code: 'PLATFORM_SLUG_TAKEN', message: 'x' } },
        409,
      ),
    });
    await vi.waitFor(() => expect(all('[data-platform-org]')).toHaveLength(2));
    q('[data-platform-org-create]').click();
    await vi.waitFor(() => expect(q('[data-platform-org-name]')).not.toBeNull());
    set('[data-platform-org-name]', 'Muuv');
    q('[data-platform-org-submit]').click();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        'Eine Organisation mit diesem Namen gibt es schon.',
      ),
    );
  });

  it('Entitlements: schaltet ein Feature und bietet Kunden-Orgs nur Dashboard und Explorer an', async () => {
    const { requests } = await mountPage('/admin/platform/entitlements', {
      [`PUT /api/platform/organizations/${MUUV.id}/entitlements`]: (request) =>
        json({ ...MUUV, features: (request.body as { features: string[] }).features }),
    });
    await vi.waitFor(() => expect(all('[data-platform-entitlements]')).toHaveLength(2));
    expect(q('[role=tab][aria-selected=true]').textContent).toContain('Entitlements');
    const boxes = (slug: string) =>
      all(`[data-platform-entitlements="${slug}"] input[type=checkbox]`) as HTMLInputElement[];
    expect(boxes('muuv').length).toBeGreaterThan(5);
    expect(boxes('muuv').filter((box) => box.checked)).toHaveLength(2);
    expect(boxes('kunde-nordwind')).toHaveLength(2);
    expect(q('[data-platform-entitlements="kunde-nordwind"]').textContent).toContain('Explorer');

    const goals = q<HTMLInputElement>(
      '[data-platform-entitlements="muuv"] [data-feature="goals"] input',
    );
    goals.click();
    await vi.waitFor(() => expect(written(requests)).toHaveLength(1));
    expect(written(requests)[0]!.body).toEqual({ features: ['dashboard', 'tags', 'goals'] });
  });

  it('Staff: das Protokoll lädt ältere Ereignisse über den Cursor nach', async () => {
    const event = (n: number, action: string) => ({
      id: org(n).id,
      createdAt: '2026-10-12T08:00:00.000Z',
      action,
      actor: null,
      target: { type: 'user', id: PIA.id, email: PIA.email },
    });
    const { requests } = await mountPage('/admin/platform/staff', {
      'GET /api/platform/audit-events': ({ search }) =>
        new URLSearchParams(search).has('cursor')
          ? json({ events: [event(22, 'platform.staff_grant')], nextCursor: null })
          : json({ events: [event(21, 'platform.staff_revoke')], nextCursor: org(21).id }),
    });
    const more = () =>
      [...q('[data-platform-events]').querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === 'Ältere laden',
      );
    await vi.waitFor(() => expect(more()).toBeDefined());
    more()!.click();
    await vi.waitFor(() =>
      expect(q('[data-platform-events]').querySelectorAll('li')).toHaveLength(2),
    );
    expect(more()).toBeUndefined();
    const last = requests.filter((r) => r.path === '/api/platform/audit-events').at(-1)!;
    expect(new URLSearchParams(last.search).get('cursor')).toBe(org(21).id);
  });

  it('Staff: vergibt die Rolle über die E-Mail, entzieht sie nach Rückfrage und zeigt das Protokoll', async () => {
    const { requests } = await mountPage('/admin/platform/staff', {
      'POST /api/platform/staff': new Response(null, { status: 204 }),
      [`DELETE /api/platform/staff/${PIA.id}`]: new Response(null, { status: 204 }),
    });
    await vi.waitFor(() => expect(all('[data-platform-staff]')).toHaveLength(2));
    expect(q('[data-platform-staff="ada@muuv.test"]').textContent).toContain('(du)');
    expect(q('[data-platform-events]').textContent).toContain('Plattform-Admin ernannt');
    expect(q('[data-platform-events]').textContent).toContain('pia@muuv.test');

    set('[data-platform-staff-email]', 'neu@muuv.test');
    q('[data-platform-staff-submit]').click();
    await vi.waitFor(() => expect(written(requests)).toHaveLength(1));
    expect(written(requests)[0]).toMatchObject({
      method: 'POST',
      body: { email: 'neu@muuv.test' },
    });

    q('[data-platform-staff="pia@muuv.test"] [data-platform-staff-revoke]').click();
    await vi.waitFor(() => expect(q('[data-platform-staff-confirm]')).not.toBeNull());
    expect(written(requests)).toHaveLength(1);
    q('[data-platform-staff-confirm]').click();
    await vi.waitFor(() => expect(written(requests)).toHaveLength(2));
    expect(written(requests)[1]).toMatchObject({
      method: 'DELETE',
      path: `/api/platform/staff/${PIA.id}`,
    });
  });

  it('zeigt Fehler mit „Erneut versuchen“ und den leeren Zustand des Protokolls', async () => {
    const failed = json({ error: { code: 'INTERNAL', message: 'kaputt' } }, 500);
    await mountPage('/admin/platform', { 'GET /api/platform/organizations': failed });
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        'Die Organisationen konnten nicht geladen werden.',
      ),
    );
    cleanupMounted();
    await mountPage('/admin/platform/staff', {
      'GET /api/platform/staff': failed,
      'GET /api/platform/audit-events': json({ events: [], nextCursor: null }),
    });
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Das Team konnte nicht geladen werden.'),
    );
    expect(document.body.textContent).toContain('Noch keine Ereignisse');
  });
});
