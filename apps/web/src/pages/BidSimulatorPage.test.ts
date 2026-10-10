import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, stubFetch } from '../test/fetch-stub';
import { meFixture } from '../test/fixtures';
import { cleanupMounted, mountWithApp } from '../test/mount';

/** Seite „Gebots-Simulator“ (`phase-4.md` 4.8, F12): Spanne des Gebots je Platzierung, Amazon Business, Zielgruppe. */

async function mountPage(path = '/ads/tools/bid-simulator') {
  stubFetch({
    'GET /api/me': json(meFixture()),
    'GET /api/settings/ui-state/shell/sidebar': json({ value: null }),
    'GET /api/ads/changes/pending': json({ changes: [], check: null }),
  });
  const mounted = await mountWithApp(undefined, { path });
  await flushPromises();
  return mounted;
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
async function click(selector: string) {
  (await found<HTMLElement>(selector)).click();
  await flushPromises();
}
/** Text ohne Unterschied zwischen Leerzeichen und geschütztem Leerzeichen (Währungen). */
const plain = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ');
const rowText = (key: string) =>
  plain(document.querySelector(`[data-stack-row="${key}"]`)?.textContent);

afterEach(() => {
  cleanupMounted();
  vi.unstubAllGlobals();
});

describe('Seite „Gebots-Simulator“', () => {
  it('übernimmt eine Kampagne aus dem Explorer und zeigt die Spanne je Platzierung', async () => {
    await mountPage(
      '/ads/tools/bid-simulator?name=SP%20Flaschen&strategy=SALES_UP_AND_DOWN&currency=EUR&top=50&pp=0&ros=0',
    );
    expect((await found('[data-simulator-source]')).textContent).toContain('SP Flaschen');
    await type('[data-simulator-bid]', '1.00');
    // 1,00 × 1,5 = 1,50; hoch und runter: 0,00 bis 3,00
    expect(rowText('top|-|-')).toContain('0,00 €');
    expect(rowText('top|-|-')).toContain('3,00 €');
    expect(rowText('productPages|-|-')).toContain('2,00 €');
    expect(rowText('top|-|-')).toContain('Anfang der Suchergebnisse');
    expect(rowText('top|-|-')).not.toContain('%');
    expect(plain((await found('[data-simulator-highest]')).textContent)).toContain('3,00 €');
  });

  it('rechnet Amazon Business und Zielgruppen mit ein', async () => {
    await mountPage('/ads/tools/bid-simulator?strategy=NONE&top=50');
    await type('[data-simulator-bid]', '1.00');
    await type('[data-simulator-ab]', '100');
    await click('[data-simulator-add-audience]');
    await type('[data-simulator-audience-label="0"]', 'Wiederkäufer');
    await type('[data-simulator-audience-percent="0"]', '100');
    expect(rowText('top|ab|0')).toContain('6,00');
    expect(rowText('productPages|ab|-')).toContain('2,00');
  });

  it('erklärt ungültige Eingaben statt zu rechnen', async () => {
    await mountPage();
    await type('[data-simulator-top]', '950');
    expect((await found('[data-simulator-invalid]')).textContent).toContain('900');
    expect(document.querySelector('[data-stack-row]')).toBeNull();
  });

  it('nimmt das Dezimalkomma und unterscheidet Zielgruppen mit gleichem Namen', async () => {
    await mountPage('/ads/tools/bid-simulator?strategy=NONE&top=0');
    await type('[data-simulator-bid]', '0,85');
    expect(document.querySelector('[data-simulator-invalid]')).toBeNull();
    await click('[data-simulator-add-audience]');
    await click('[data-simulator-add-audience]');
    await type('[data-simulator-audience-label="0"]', 'Gleich');
    await type('[data-simulator-audience-label="1"]', 'Gleich');
    await type('[data-simulator-audience-percent="1"]', '100');
    const keys = [...document.querySelectorAll('[data-stack-row]')].map((row) =>
      row.getAttribute('data-stack-row'),
    );
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(9);
    expect(rowText('top|-|1')).toContain('1,70');
  });

  it('lehnt Prozent in anderer Schreibweise ab und markiert das Feld', async () => {
    await mountPage();
    await type('[data-simulator-top]', '1e2');
    await found('[data-simulator-invalid]');
    expect(
      (await found<HTMLInputElement>('[data-simulator-top]')).getAttribute('aria-invalid'),
    ).toBe('true');
  });

  it('liest eine neue Query beim Wechsel innerhalb der Seite neu ein', async () => {
    const { router } = await mountPage('/ads/tools/bid-simulator?name=A&top=50');
    expect((await found('[data-simulator-source]')).textContent).toContain('A');
    await router.push('/ads/tools/bid-simulator');
    await flushPromises();
    expect(document.querySelector('[data-simulator-source]')).toBeNull();
    expect((await found<HTMLInputElement>('[data-simulator-top]')).value).toBe('0');
  });
});
