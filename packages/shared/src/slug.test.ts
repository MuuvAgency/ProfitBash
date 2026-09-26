import { describe, expect, it } from 'vitest';
import { isSlug, slugify } from './slug';

describe('slugify', () => {
  it('macht aus einem Namen einen kleingeschriebenen Slug mit Bindestrichen', () => {
    expect(slugify('Soapi')).toBe('soapi');
    expect(slugify('Evertag GmbH & Co. KG')).toBe('evertag-gmbh-co-kg');
    expect(slugify('  Aliseo  Home  ')).toBe('aliseo-home');
  });

  it('schreibt Umlaute und ß aus und entfernt übrige Akzente', () => {
    expect(slugify('Grüne Äpfel Öl')).toBe('gruene-aepfel-oel');
    expect(slugify('Straße')).toBe('strasse');
    expect(slugify('Café Crème')).toBe('cafe-creme');
  });

  it('liefert einen leeren String, wenn nichts Verwertbares übrig bleibt', () => {
    expect(slugify('!!!')).toBe('');
    expect(slugify('日本')).toBe('');
  });

  it('kürzt auf höchstens 64 Zeichen ohne Bindestrich am Ende', () => {
    const slug = slugify(`${'a'.repeat(63)} b`);
    expect(slug).toBe('a'.repeat(63));
    expect(slugify('x'.repeat(100))).toHaveLength(64);
  });
});

describe('isSlug', () => {
  it('akzeptiert nur Slugs im Format von slugify', () => {
    expect(isSlug('soapi')).toBe(true);
    expect(isSlug('evertag-2')).toBe(true);
    expect(isSlug('')).toBe(false);
    expect(isSlug('Soapi')).toBe(false);
    expect(isSlug('-soapi')).toBe(false);
    expect(isSlug('so--api')).toBe(false);
    expect(isSlug('a'.repeat(65))).toBe(false);
  });
});
