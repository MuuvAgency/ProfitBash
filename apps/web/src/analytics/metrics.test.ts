import { CHANGE_KEYS } from '@profitbash/shared';
import { describe, expect, it } from 'vitest';
import { changeTone, formatChange, formatMetricValue, METRIC_POLARITY } from './metrics';

const nbsp = '\u00a0';

describe('changeTone (Farbe nach Bedeutung, Dominik 2026-09-28)', () => {
  it('kennt jede Kennzahl mit Veränderung', () => {
    expect(Object.keys(METRIC_POLARITY).sort()).toEqual([...CHANGE_KEYS].sort());
  });

  it('mehr Umsatz, ROAS, Käufe, Klicks = gut', () => {
    for (const key of [
      'sales',
      'roas',
      'purchases',
      'clicks',
      'impressions',
      'ctr',
      'cvr',
    ] as const) {
      expect(changeTone(key, '0.1')).toBe('positive');
      expect(changeTone(key, '-0.1')).toBe('negative');
    }
  });

  it('mehr ACoS, CPC, CPM = schlecht', () => {
    for (const key of ['acos', 'cpc', 'cpm', 'vcpm'] as const) {
      expect(changeTone(key, '0.1')).toBe('negative');
      expect(changeTone(key, '-0.1')).toBe('positive');
    }
  });

  it('Spend ist neutral; keine Veränderung neutral; ohne Wert null', () => {
    expect(changeTone('cost', '0.5')).toBe('neutral');
    expect(changeTone('sales', '0')).toBe('neutral');
    expect(changeTone('sales', null)).toBeNull();
  });
});

describe('formatChange', () => {
  it('mit Vorzeichen, eine Nachkommastelle', () => {
    expect(formatChange('0.1234', 'de-DE')).toBe(`+12,3${nbsp}%`);
    expect(formatChange('-0.031', 'de-DE')).toBe(`-3,1${nbsp}%`);
    expect(formatChange('0', 'de-DE')).toBe(`0,0${nbsp}%`);
    expect(formatChange(null, 'de-DE')).toBe('–');
  });

  it('winzige Veränderungen, die auf 0 gerundet werden, ohne Vorzeichen', () => {
    expect(formatChange('0.00001', 'de-DE')).toBe(`0,0${nbsp}%`);
    expect(formatChange('-0.0001', 'de-DE')).toBe(`0,0${nbsp}%`);
    expect(formatChange('-0.0004999', 'de-DE')).toBe(`0,0${nbsp}%`);
    expect(formatChange('-0.0005', 'de-DE')).toBe(`-0,1${nbsp}%`);
  });

  it('auf 0 gerundet ist neutral (keine Farbe)', () => {
    expect(changeTone('sales', '0.0004')).toBe('neutral');
    expect(changeTone('acos', '-0.0001')).toBe('neutral');
  });
});

describe('formatMetricValue', () => {
  const ctx = { currency: 'EUR', locale: 'de-DE' as const };

  it('Beträge in der Währung, Anteile als Prozent, ROAS als Faktor, Zähler ganz', () => {
    expect(formatMetricValue('cost', '1234.5', ctx)).toBe(`1.234,50${nbsp}€`);
    expect(formatMetricValue('cpc', '0.4567', ctx)).toBe(`0,46${nbsp}€`);
    expect(formatMetricValue('acos', '0.241', ctx)).toBe(`24,1${nbsp}%`);
    expect(formatMetricValue('roas', '3.9', ctx)).toBe('3,90');
    expect(formatMetricValue('clicks', '12034', ctx)).toBe('12.034');
  });

  it('fehlender Wert: –', () => {
    expect(formatMetricValue('sales', null, ctx)).toBe('–');
  });
});
