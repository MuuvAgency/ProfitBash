import {
  AD_PRODUCTS,
  ATTRIBUTION_SETTINGS,
  CONNECTION_JOB_NAMES,
  SYNC_STATUS_JOB_NAMES,
} from '@profitbash/shared';
import { COMPARISON_MODES, PERIOD_PRESETS } from '../analytics/periods';
import { describe, expect, it } from 'vitest';
import { NAVIGATION } from '../navigation/navigation';
import { errorMessageKey, i18n } from './index';

const { te, t } = i18n.global;

describe('i18n', () => {
  it('ist Deutsch als Standard', () => {
    expect(i18n.global.locale.value).toBe('de');
  });

  it('hat Texte für alle Menügruppen und -einträge', () => {
    const keys = NAVIGATION.flatMap((group) => [
      group.labelKey,
      ...group.items.map((i) => i.labelKey),
    ]);
    expect(keys.filter((key) => !te(key))).toEqual([]);
  });

  it('hat Texte für alle Jobs im Sync-Status (je Connection und plattformweit geteilt)', () => {
    expect(SYNC_STATUS_JOB_NAMES.filter((job) => !te(`sync.job.${job}`))).toEqual([]);
    expect(SYNC_STATUS_JOB_NAMES).toEqual(expect.arrayContaining(['fx-rates-sync']));
    expect(CONNECTION_JOB_NAMES).toEqual(
      expect.arrayContaining(['entities-sync', 'reports-sync', 'amazon-requests-poll']),
    );
  });

  it('übersetzt bekannte Fehlercodes und fällt sonst auf einen allgemeinen Text zurück', () => {
    expect(t(errorMessageKey('INVALID_EMAIL_OR_PASSWORD'))).toBe(
      'E-Mail-Adresse oder Passwort ist falsch.',
    );
    expect(errorMessageKey('NETWORK_ERROR')).toBe('errors.NETWORK_ERROR');
    expect(errorMessageKey('IRGENDWAS_NEUES')).toBe('errors.UNKNOWN');
    expect(te(errorMessageKey('IRGENDWAS_NEUES'))).toBe(true);
  });

  it('hat Texte für alle Optionen der Filterleiste und alle Ad-Typen', () => {
    const keys = [
      ...PERIOD_PRESETS.map((preset) => `analytics.period.${preset}`),
      ...COMPARISON_MODES.map((mode) => `analytics.comparison.${mode}`),
      ...ATTRIBUTION_SETTINGS.map((setting) => `analytics.attribution.${setting}`),
      ...AD_PRODUCTS.map((adProduct) => `analytics.adProduct.${adProduct}`),
    ];
    expect(keys.filter((key) => !te(key))).toEqual([]);
  });

  it('nennt die Phase auf Platzhalterseiten', () => {
    expect(t('placeholder.title', { phase: 5 })).toBe('Kommt in Phase 5');
  });

  it('hat eigene Texte für die Fehlercodes der API', () => {
    for (const code of ['FORBIDDEN', 'VALIDATION_ERROR', 'NOT_FOUND', 'NO_ACTIVE_ORGANIZATION']) {
      expect(errorMessageKey(code)).toBe(`errors.${code}`);
    }
  });
});
