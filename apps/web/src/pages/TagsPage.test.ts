import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, stubFetch, type RecordedRequest } from '../test/fetch-stub';
import { meFixture } from '../test/fixtures';
import { cleanupMounted, mountWithApp } from '../test/mount';

/** Seite „Tags“ (`phase-3.md` 3.7): eigene Tags anlegen, ändern, löschen. */

const T1 = '00000000-0000-4000-8000-0000000000e1';
const T2 = '00000000-0000-4000-8000-0000000000e2';
const tag = (id: string, name: string, color: string, campaign = 0, target = 0) => ({
  id,
  name,
  color,
  counts: { campaign, ad_group: 0, target, product_ad: 0 },
  createdAt: '2026-10-09T08:00:00.000Z',
  updatedAt: '2026-10-09T08:00:00.000Z',
});

type Responder = (request: RecordedRequest) => Response | Promise<Response>;
function routes(overrides: Record<string, Responder | Response> = {}) {
  return {
    'GET /api/me': json(meFixture()),
    'GET /api/settings/ui-state/shell/sidebar': json({ value: null }),
    'GET /api/ads/changes/pending': json({ changes: [], check: null }),
    'GET /api/ads/tags': json({
      tags: [tag(T1, 'Bestseller', 'lime', 2, 1200), tag(T2, 'Winter', 'violet')],
      maxTags: 200,
    }),
    ...overrides,
  };
}

async function mountPage(overrides: Record<string, Responder | Response> = {}) {
  const stub = stubFetch(routes(overrides));
  const mounted = await mountWithApp(undefined, { path: '/ads/tags' });
  await flushPromises();
  return { ...mounted, ...stub };
}

const button = (label: string) =>
  [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim().includes(label) || b.getAttribute('aria-label') === label,
  );
const sent = (requests: RecordedRequest[], method: string) =>
  requests.filter((r) => r.method === method && r.path.startsWith('/api/ads/tags'));

async function typeName(value: string) {
  const input = await vi.waitFor(() => {
    const found = document.querySelector<HTMLInputElement>('[data-tag-name]');
    if (!found) throw new Error('kein Namensfeld');
    return found;
  });
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flushPromises();
}

afterEach(() => {
  cleanupMounted();
  vi.unstubAllGlobals();
});

describe('Seite „Tags“', () => {
  it('listet die Tags mit ihren Zuweisungen', async () => {
    await mountPage();
    const list = await vi.waitFor(() => {
      const found = document.querySelector('[data-tag-list]');
      if (!found) throw new Error('keine Liste');
      return found;
    });
    expect(list.textContent).toContain('Bestseller');
    expect(list.textContent).toContain('2 Kampagnen · 1.200 Targets');
    expect(list.textContent).toContain('Noch nicht zugewiesen');
  });

  it('legt ein Tag mit Name und Farbe aus der Palette an', async () => {
    const { requests } = await mountPage({
      'POST /api/ads/tags': json(tag('00000000-0000-4000-8000-0000000000e3', 'Sale', 'red'), 201),
    });
    await vi.waitFor(() => expect(document.querySelector('[data-tag-new]')).not.toBeNull());
    document.querySelector<HTMLButtonElement>('[data-tag-new]')!.click();
    await typeName('  Sale   2026 ');
    document.querySelector<HTMLInputElement>('input[name="tag-color"][value="red"]')!.click();
    await flushPromises();
    document.querySelector<HTMLButtonElement>('[data-tag-save]')!.click();
    await flushPromises();

    expect(sent(requests, 'POST').map((r) => r.body)).toEqual([
      { name: 'Sale 2026', color: 'red' },
    ]);
    // Danach lädt die Liste neu und der Dialog ist zu.
    expect(sent(requests, 'GET').length).toBeGreaterThan(1);
    await vi.waitFor(() => expect(document.querySelector('[data-tag-name]')).toBeNull());
  });

  it('meldet einen vergebenen Namen im Dialog', async () => {
    await mountPage({
      'POST /api/ads/tags': json(
        { error: { code: 'TAG_NAME_TAKEN', message: 'Ein Tag mit diesem Namen gibt es schon.' } },
        409,
      ),
    });
    await vi.waitFor(() => expect(document.querySelector('[data-tag-new]')).not.toBeNull());
    document.querySelector<HTMLButtonElement>('[data-tag-new]')!.click();
    await typeName('Winter');
    document.querySelector<HTMLButtonElement>('[data-tag-save]')!.click();

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Ein Tag mit diesem Namen gibt es schon.'),
    );
    expect(document.querySelector('[data-tag-name]')).not.toBeNull();
  });

  it('sperrt das Speichern ohne Namen und bei zu langem Namen', async () => {
    await mountPage();
    await vi.waitFor(() => expect(document.querySelector('[data-tag-new]')).not.toBeNull());
    document.querySelector<HTMLButtonElement>('[data-tag-new]')!.click();
    await typeName('   ');
    const save = () => document.querySelector<HTMLButtonElement>('[data-tag-save]')!;
    expect(save().disabled).toBe(true);
    await typeName('x'.repeat(41));
    expect(save().disabled).toBe(true);
    expect(document.body.textContent).toContain('Höchstens 40 Zeichen.');
  });

  it('ändert ein Tag (Name und Farbe vorbelegt)', async () => {
    const { requests } = await mountPage({
      [`PATCH /api/ads/tags/${T2}`]: json(tag(T2, 'Winter', 'ink')),
    });
    await vi.waitFor(() => expect(button('Tag „Winter“ ändern')).toBeDefined());
    button('Tag „Winter“ ändern')!.click();
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLInputElement>('[data-tag-name]')?.value).toBe('Winter'),
    );
    expect(
      document.querySelector<HTMLInputElement>('input[name="tag-color"][value="violet"]')!.checked,
    ).toBe(true);
    document.querySelector<HTMLInputElement>('input[name="tag-color"][value="ink"]')!.click();
    await flushPromises();
    document.querySelector<HTMLButtonElement>('[data-tag-save]')!.click();
    await flushPromises();

    expect(sent(requests, 'PATCH').map((r) => r.body)).toEqual([{ name: 'Winter', color: 'ink' }]);
  });

  it('löscht ein Tag erst nach Rückfrage mit der Zahl der Zuweisungen', async () => {
    const { requests } = await mountPage({
      [`DELETE /api/ads/tags/${T1}`]: new Response(null, { status: 204 }),
    });
    await vi.waitFor(() => expect(button('Tag „Bestseller“ löschen')).toBeDefined());
    button('Tag „Bestseller“ löschen')!.click();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('von 1.202 Einträgen gelöst'),
    );
    expect(sent(requests, 'DELETE')).toHaveLength(0);

    document.querySelector<HTMLButtonElement>('[data-tag-delete]')!.click();
    await flushPromises();
    expect(sent(requests, 'DELETE').map((r) => r.path)).toEqual([`/api/ads/tags/${T1}`]);
  });

  it('Leerzustand, Fehler und Viewer ohne Aktionen', async () => {
    await mountPage({ 'GET /api/ads/tags': json({ tags: [], maxTags: 200 }) });
    await vi.waitFor(() => expect(document.body.textContent).toContain('Noch keine Tags'));
    cleanupMounted();
    vi.unstubAllGlobals();

    await mountPage({
      'GET /api/ads/tags': json({ error: { code: 'INTERNAL', message: 'kaputt' } }, 500),
    });
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Die Tags konnten nicht geladen werden.'),
    );
    cleanupMounted();
    vi.unstubAllGlobals();

    await mountPage({ 'GET /api/me': json(meFixture({ orgRole: 'viewer' })) });
    await vi.waitFor(() => expect(document.body.textContent).toContain('Bestseller'));
    expect(document.querySelector('[data-tag-new]')).toBeNull();
    expect(button('Tag „Winter“ ändern')).toBeUndefined();
  });
});
