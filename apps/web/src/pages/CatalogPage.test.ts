import { DEFAULT_STRUCTURE_CATALOG } from '@profitbash/shared';
import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, stubFetch, type RecordedRequest } from '../test/fetch-stub';
import { meFixture } from '../test/fixtures';
import { cleanupMounted, mountWithApp } from '../test/mount';

/** Seite „Struktur-Katalog“ (`phase-4.md` 4.2, F11): Admins ändern, alle lesen, Presets je Client. */

const C1 = '00000000-0000-4000-8000-0000000000c1';
const catalogResponse = (overrides: Record<string, unknown> = {}) => ({
  catalog: structuredClone(DEFAULT_STRUCTURE_CATALOG),
  version: 3,
  updatedAt: '2026-10-09T08:00:00.000Z',
  clientPresets: [],
  clients: [{ id: C1, name: 'Waldkauz' }],
  ...overrides,
});

type Responder = (request: RecordedRequest) => Response | Promise<Response>;
function routes(overrides: Record<string, Responder | Response> = {}) {
  return {
    'GET /api/me': json(meFixture()),
    'GET /api/settings/ui-state/shell/sidebar': json({ value: null }),
    'GET /api/ads/changes/pending': json({ changes: [], check: null }),
    'GET /api/ads/tools/catalog': json(catalogResponse()),
    ...overrides,
  };
}

async function mountPage(overrides: Record<string, Responder | Response> = {}) {
  const stub = stubFetch(routes(overrides));
  const mounted = await mountWithApp(undefined, { path: '/ads/tools/catalog' });
  await flushPromises();
  return { ...mounted, ...stub };
}

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
async function tab(name: string) {
  (await found<HTMLButtonElement>(`[data-catalog-tab="${name}"]`)).click();
  await flushPromises();
}
const puts = (requests: RecordedRequest[], path: string) =>
  requests.filter((r) => r.method === 'PUT' && r.path === path).map((r) => r.body);

afterEach(() => {
  cleanupMounted();
  vi.unstubAllGlobals();
});

describe('Seite „Struktur-Katalog“', () => {
  it('zeigt die Presets mit ihren Bausteinen', async () => {
    await mountPage();
    const preset = await found('[data-preset="muuv-standard"]');
    expect(preset.textContent).toContain('Standard');
    expect(
      preset.querySelector<HTMLInputElement>('input[data-preset-block="SP-AUTO"]')!.checked,
    ).toBe(true);
    expect(
      preset.querySelector<HTMLInputElement>('input[data-preset-block="SP-KW-PHRASE"]')!.checked,
    ).toBe(false);
  });

  it('speichert Änderungen am Preset mit der gelesenen Version', async () => {
    const { requests } = await mountPage({
      'PUT /api/ads/tools/catalog': (request) =>
        json(catalogResponse({ version: 4, catalog: (request.body as { catalog: unknown }).catalog })),
    });
    await type('[data-preset="launch"] [data-preset-name]', 'Neustart');
    (
      await found<HTMLInputElement>(
        '[data-preset="launch"] input[data-preset-block="SP-KW-PHRASE"]',
      )
    ).click();
    await flushPromises();
    (await found<HTMLButtonElement>('[data-catalog-save]')).click();
    await flushPromises();

    const [body] = puts(requests, '/api/ads/tools/catalog') as {
      catalog: typeof DEFAULT_STRUCTURE_CATALOG;
      version: number;
    }[];
    expect(body!.version).toBe(3);
    const launch = body!.catalog.presets.find((preset) => preset.key === 'launch')!;
    expect(launch.name).toBe('Neustart');
    expect(launch.blocks.map((entry) => entry.block)).toContain('SP-KW-PHRASE');
    // Danach ist der Entwurf der gespeicherte Stand.
    await vi.waitFor(() => expect(document.body.textContent).toContain('Gespeichert.'));
    expect(document.body.textContent).not.toContain('Ungespeicherte Änderungen');
  });

  it('ändert Werte eines Bausteins (Komma als Dezimaltrenner)', async () => {
    const { requests } = await mountPage({
      'PUT /api/ads/tools/catalog': json(catalogResponse({ version: 4 })),
    });
    await tab('blocks');
    await type('[data-block="SP-AUTO"] [data-block-bid]', '0,52');
    await type('[data-block="SP-AUTO"] [data-block-top]', '15');
    (await found<HTMLButtonElement>('[data-catalog-save]')).click();
    await flushPromises();
    const [body] = puts(requests, '/api/ads/tools/catalog') as {
      catalog: typeof DEFAULT_STRUCTURE_CATALOG;
    }[];
    const auto = body!.catalog.blocks.find((block) => block.key === 'SP-AUTO')!;
    expect(auto.defaultBid).toBe('0.52');
    expect(auto.placements?.topOfSearch).toBe(15);
  });

  it('sperrt das Speichern bei ungültigem Katalog und nennt den Grund', async () => {
    await mountPage();
    await tab('edges');
    await choose('[data-edge-from]', 'SP-BRAND-DEF');
    await choose('[data-edge-to]', 'SP-KW-EXACT');
    (await found<HTMLButtonElement>('[data-edge-add]')).click();
    await flushPromises();
    expect((await found('[data-catalog-issues]')).textContent).toContain(
      'Marken-Bausteine graduieren nie',
    );
    expect((await found<HTMLButtonElement>('[data-catalog-save]')).disabled).toBe(true);
  });

  it('zeigt eine Vorschau des Namensschemas', async () => {
    await mountPage();
    await tab('naming');
    expect((await found('[data-naming-preview]')).textContent).toContain(
      'SP | EXACT1 | Flaschen | trinkflasche 1l',
    );
    await type('[data-naming-pattern]', '{country}-{adType}-{block}');
    expect((await found('[data-naming-preview]')).textContent).toContain('DE-SP-EXACT1');
  });

  it('meldet einen Konflikt beim Speichern', async () => {
    await mountPage({
      'PUT /api/ads/tools/catalog': json(
        { error: { code: 'STRUCTURE_CATALOG_VERSION_CONFLICT', message: 'x' } },
        409,
      ),
    });
    await type('[data-preset="launch"] [data-preset-name]', 'Neustart');
    (await found<HTMLButtonElement>('[data-catalog-save]')).click();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('inzwischen von jemand anderem geändert'),
    );
  });

  it('zeigt Editoren alles nur lesend, lässt sie aber Presets je Client setzen', async () => {
    const { requests } = await mountPage({
      'GET /api/me': json(meFixture({ orgRole: 'editor' })),
      [`PUT /api/ads/tools/client-presets/${C1}`]: new Response(null, { status: 204 }),
    });
    await found('[data-preset="muuv-standard"]');
    expect(document.querySelector('[data-catalog-save]')).toBeNull();
    expect(
      document.querySelector<HTMLInputElement>('[data-preset="launch"] [data-preset-name]')!
        .disabled,
    ).toBe(true);
    await tab('assignments');
    await choose(`[data-client-preset="${C1}"]`, 'launch');
    expect(puts(requests, `/api/ads/tools/client-presets/${C1}`)).toEqual([
      { presetKey: 'launch' },
    ]);
  });

  it('lädt auf Wunsch die Startwerte in den Entwurf', async () => {
    const custom = structuredClone(DEFAULT_STRUCTURE_CATALOG);
    custom.presets[0]!.name = 'Eigener Name';
    await mountPage({ 'GET /api/ads/tools/catalog': json(catalogResponse({ catalog: custom })) });
    expect(
      (await found<HTMLInputElement>('[data-preset="muuv-standard"] [data-preset-name]')).value,
    ).toBe('Eigener Name');
    (await found<HTMLButtonElement>('[data-catalog-defaults]')).click();
    await flushPromises();
    expect(
      (await found<HTMLInputElement>('[data-preset="muuv-standard"] [data-preset-name]')).value,
    ).toBe('Muuv-Standard');
  });
});
