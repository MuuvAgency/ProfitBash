import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyColorScheme,
  readCachedTheme,
  resolveColorScheme,
  toggledTheme,
  writeCachedTheme,
} from './mode';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  document.documentElement.classList.remove('dark');
});

describe('resolveColorScheme', () => {
  it('folgt bei „system“ dem Betriebssystem', () => {
    expect(resolveColorScheme('system', true)).toBe('dark');
    expect(resolveColorScheme('system', false)).toBe('light');
  });

  it('nimmt feste Einstellungen unabhängig vom System', () => {
    expect(resolveColorScheme('light', true)).toBe('light');
    expect(resolveColorScheme('dark', false)).toBe('dark');
  });
});

describe('toggledTheme', () => {
  it('schaltet auf das Gegenteil der aktuell sichtbaren Darstellung', () => {
    expect(toggledTheme('dark')).toBe('light');
    expect(toggledTheme('light')).toBe('dark');
  });
});

describe('applyColorScheme', () => {
  it('setzt die Klasse `dark` am Wurzelelement', () => {
    applyColorScheme('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    applyColorScheme('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});

describe('Theme-Cache für den ersten Paint', () => {
  it('merkt sich die letzte Einstellung', () => {
    writeCachedTheme('dark');
    expect(readCachedTheme()).toBe('dark');
  });

  it('liefert „system“ bei fehlendem oder ungültigem Wert', () => {
    expect(readCachedTheme()).toBe('system');
    localStorage.setItem('profitbash.theme', 'lila');
    expect(readCachedTheme()).toBe('system');
  });

  it('übersteht gesperrten Speicher', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(readCachedTheme()).toBe('system');
    expect(() => writeCachedTheme('dark')).not.toThrow();
  });
});
