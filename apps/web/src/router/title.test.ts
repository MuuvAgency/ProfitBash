import { describe, expect, it } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import { createAppRouter } from './index';
import { pageTitleKey } from './title';

const router = createAppRouter(createMemoryHistory());
const keyFor = (path: string) => pageTitleKey(router.resolve(path));

describe('pageTitleKey', () => {
  it('nimmt den Menüeintrag, auch auf Unterseiten', () => {
    expect(keyFor('/ads/budgets')).toBe('nav.budgets');
    expect(keyFor('/ads/tools/campaign-setup')).toBe('nav.tools');
  });

  it('kennt die Seiten außerhalb der Navigation', () => {
    expect(keyFor('/login')).toBe('login.pageTitle');
    expect(keyFor('/settings')).toBe('nav.settings');
    expect(keyFor('/forbidden')).toBe('forbidden.title');
    expect(keyFor('/gibt/es/nicht')).toBe('notFound.title');
  });

  it('liefert für die Startseite keinen eigenen Titel', () => {
    expect(keyFor('/')).toBeNull();
  });
});
