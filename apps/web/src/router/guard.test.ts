import { describe, expect, it } from 'vitest';
import type { RouteMeta } from 'vue-router';
import { meFixture } from '../test/fixtures';
import { resolveGuard, safeRedirect, type GuardSession } from './guard';

function target(meta: RouteMeta, fullPath = '/ads/budgets', query: Record<string, string> = {}) {
  return { fullPath, meta, query };
}

const anonymous: GuardSession = { status: 'anonymous' };
const failed: GuardSession = { status: 'error' };
const as = (me = meFixture()): GuardSession => ({ status: 'authenticated', me });

describe('safeRedirect', () => {
  it('erlaubt interne Pfade inklusive Query und Hash', () => {
    expect(safeRedirect('/ads/explorer?range=30d#grid')).toBe('/ads/explorer?range=30d#grid');
  });

  it('verwirft fremde Origins und protokoll-relative URLs', () => {
    for (const value of [
      'https://evil.test',
      '//evil.test',
      '/\\evil.test',
      'javascript:alert(1)',
      'dashboard',
    ]) {
      expect(safeRedirect(value)).toBeNull();
    }
  });

  it('verwirft leere Werte, Listen und die Login-Seite selbst', () => {
    expect(safeRedirect('')).toBeNull();
    expect(safeRedirect(undefined)).toBeNull();
    expect(safeRedirect(['/dashboard'])).toBeNull();
    expect(safeRedirect('/login?redirect=/x')).toBeNull();
  });
});

describe('resolveGuard', () => {
  it('schickt Nicht-Angemeldete mit Rücksprung zum Login', () => {
    expect(resolveGuard(target({ requiresAuth: true }), anonymous)).toEqual({
      name: 'login',
      query: { redirect: '/ads/budgets' },
    });
  });

  it('lässt den Rücksprung bei der Startseite weg', () => {
    expect(resolveGuard(target({ requiresAuth: true }, '/'), anonymous)).toEqual({ name: 'login' });
  });

  it('lässt öffentliche Seiten ohne Session zu', () => {
    expect(resolveGuard(target({ guestOnly: true }, '/login'), anonymous)).toBe(true);
  });

  it('leitet Angemeldete vom Login zum sicheren Rücksprung oder zur Startseite', () => {
    const login = (redirect?: string) =>
      target({ guestOnly: true }, '/login', redirect ? { redirect } : {});
    expect(resolveGuard(login('/ads/tags/x'), as())).toEqual({ path: '/ads/tags/x' });
    expect(resolveGuard(login('//evil.test'), as())).toEqual({ path: '/dashboard' });
    expect(resolveGuard(login(), as(meFixture({ features: ['profit'] })))).toEqual({
      path: '/profit/pnl',
    });
  });

  it('leitet die Startseite auf den ersten sichtbaren Eintrag', () => {
    expect(resolveGuard(target({ requiresAuth: true, home: true }, '/'), as())).toEqual({
      path: '/dashboard',
    });
  });

  it('sperrt Features ohne view-Recht', () => {
    const meta: RouteMeta = { requiresAuth: true, feature: 'budgets' };
    expect(resolveGuard(target(meta), as(meFixture({ features: [] })))).toEqual({
      name: 'forbidden',
    });
    expect(resolveGuard(target(meta), as())).toBe(true);
  });

  it('sperrt Admin-Seiten für Nicht-Admins der aktiven Organisation', () => {
    const meta: RouteMeta = { requiresAuth: true, requiresOrgAdmin: true };
    expect(resolveGuard(target(meta), as(meFixture({ orgRole: 'editor' })))).toEqual({
      name: 'forbidden',
    });
    expect(resolveGuard(target(meta), as(meFixture({ orgRole: 'admin' })))).toBe(true);
  });

  it('sperrt Plattform-Seiten für Nicht-Superadmins', () => {
    const meta: RouteMeta = { requiresAuth: true, requiresSuperadmin: true };
    expect(resolveGuard(target(meta), as())).toEqual({ name: 'forbidden' });
    expect(resolveGuard(target(meta), as(meFixture({ platformRole: 'superadmin' })))).toBe(true);
  });

  it('lässt die Navigation zu, wenn die Session nicht geladen werden konnte (die Shell zeigt den Fehler)', () => {
    expect(resolveGuard(target({ requiresAuth: true, feature: 'budgets' }), failed)).toBe(true);
    expect(resolveGuard(target({ guestOnly: true }, '/login'), failed)).toBe(true);
  });
});
