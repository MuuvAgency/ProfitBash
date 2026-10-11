import { describe, expect, it } from 'vitest';
import { runChecks, type ChecksInput } from './checks';

/** Prüfungen „kein Geld verbrennen“ (`phase-5.md` 5.10): Befunde je Lauf aus Struktur und Zeitraumsummen. */

const sums = (spend: string, sales: string, orders = 0, clicks = 10) => ({
  impressions: clicks * 100,
  clicks,
  orders,
  spend,
  sales,
});
const settings: ChecksInput['settings'] = {
  enabled: { vcpm: true, placement: true, spendNoOrders: true, noGoal: true, noCap: true },
  placementMinPercent: 50,
  spendNoOrdersMinEur: '20',
};
const campaign = (
  id: string,
  patch: Partial<ChecksInput['campaigns'][number]> = {},
): ChecksInput['campaigns'][number] => ({
  id,
  state: 'ENABLED',
  costType: null,
  metrics: sums('100', '500', 5),
  placements: [],
  capped: true,
  ...patch,
});
const check = (patch: Partial<ChecksInput>) =>
  runChecks({
    settings,
    profileId: 'p1',
    eurRate: '1',
    goalAcos: '25',
    campaigns: [],
    targets: [],
    ...patch,
  });

describe('runChecks', () => {
  it('ohne Auffälligkeiten keine Befunde', () => {
    expect(check({ campaigns: [campaign('c1')] })).toEqual([]);
  });

  it('vcpm: aktive Kampagnen mit Kostenart vCPM', () => {
    expect(
      check({
        campaigns: [
          campaign('c1', { costType: 'VCPM' }),
          campaign('c2', { costType: 'vcpm', state: 'PAUSED' }),
          campaign('c3', { costType: 'CPC' }),
        ],
      }),
    ).toEqual([
      {
        kind: 'vcpm',
        entityType: 'campaign',
        entityId: 'c1',
        campaignId: 'c1',
        key: '',
        detail: {},
      },
    ]);
  });

  it('placement: Anpassung ab der Schwelle bei ACoS der Platzierung über dem Ziel', () => {
    const findings = check({
      campaigns: [
        campaign('c1', {
          placements: [
            // 40 % ACoS bei Ziel 25 %
            { placement: 'PLACEMENT_TOP', percent: 50, metrics: sums('40', '100', 1) },
            // unter der Schwelle
            { placement: 'PLACEMENT_PRODUCT_PAGE', percent: 49, metrics: sums('40', '100', 1) },
            // ACoS im Ziel
            { placement: 'PLACEMENT_REST_OF_SEARCH', percent: 90, metrics: sums('20', '100', 1) },
          ],
        }),
      ],
    });
    expect(findings).toEqual([
      {
        kind: 'placement',
        entityType: 'campaign',
        entityId: 'c1',
        campaignId: 'c1',
        key: 'PLACEMENT_TOP',
        detail: {
          percent: 50,
          acos: '40',
          goalAcos: '25',
          basis: 'placement',
          spend: '40',
          sales: '100',
        },
      },
    ]);
  });

  it('placement: ohne Kennzahlen der Platzierung zählt der ACoS der Kampagne; Ausgaben ohne Umsatz liegen über jedem Ziel', () => {
    const [byCampaign] = check({
      campaigns: [
        campaign('c1', {
          metrics: sums('300', '600', 6),
          placements: [{ placement: 'PLACEMENT_TOP', percent: 100, metrics: null }],
        }),
      ],
    });
    expect(byCampaign).toMatchObject({
      key: 'PLACEMENT_TOP',
      detail: { acos: '50', basis: 'campaign' },
    });
    const [noSales] = check({
      campaigns: [
        campaign('c1', {
          placements: [{ placement: 'PLACEMENT_TOP', percent: 100, metrics: sums('5', '0') }],
        }),
      ],
    });
    expect(noSales).toMatchObject({ detail: { acos: null, basis: 'placement' } });
    // Ohne Ausgaben, ohne Ziel oder pausiert: nichts.
    expect(
      check({
        goalAcos: null,
        settings: { ...settings, enabled: { ...settings.enabled, noGoal: false } },
        campaigns: [
          campaign('c1', {
            placements: [{ placement: 'PLACEMENT_TOP', percent: 100, metrics: sums('40', '100') }],
          }),
        ],
      }),
    ).toEqual([]);
    expect(
      check({
        campaigns: [
          campaign('c1', {
            metrics: null,
            placements: [{ placement: 'PLACEMENT_TOP', percent: 100, metrics: sums('0', '0') }],
          }),
        ],
      }),
    ).toEqual([]);
  });

  it('spendNoOrders: aktive Targets mit Ausgaben ab der Schwelle (EUR, umgerechnet) ohne Bestellung', () => {
    const targets = [
      { id: 't1', campaignId: 'c1', state: 'ENABLED', metrics: sums('200', '0', 0, 80) },
      { id: 't2', campaignId: 'c1', state: 'ENABLED', metrics: sums('199.99', '0') },
      { id: 't3', campaignId: 'c1', state: 'ENABLED', metrics: sums('500', '900', 3) },
      { id: 't4', campaignId: 'c1', state: 'PAUSED', metrics: sums('500', '0') },
      { id: 't5', campaignId: 'c2', state: 'ENABLED', metrics: sums('500', '0') },
    ];
    // Ein Euro sind 10 der Profilwährung: Schwelle 200.
    expect(
      check({
        eurRate: '10',
        campaigns: [campaign('c1'), campaign('c2', { state: 'PAUSED' })],
        targets,
      }),
    ).toEqual([
      {
        kind: 'spendNoOrders',
        entityType: 'target',
        entityId: 't1',
        campaignId: 'c1',
        key: '',
        detail: { spend: '200', clicks: 80 },
      },
    ]);
  });

  it('noGoal und noCap: je Profil ein Hinweis mit der Zahl der aktiven Kampagnen', () => {
    expect(
      check({
        goalAcos: null,
        campaigns: [
          campaign('c1', { capped: false }),
          campaign('c2', { capped: false }),
          campaign('c3'),
          campaign('c4', { capped: false, state: 'PAUSED' }),
        ],
      }),
    ).toEqual([
      {
        kind: 'noGoal',
        entityType: 'profile',
        entityId: 'p1',
        campaignId: null,
        key: '',
        detail: { campaigns: 3 },
      },
      {
        kind: 'noCap',
        entityType: 'profile',
        entityId: 'p1',
        campaignId: null,
        key: '',
        detail: { campaigns: 2 },
      },
    ]);
  });

  it('abgeschaltete Prüfungen liefern nichts', () => {
    expect(
      check({
        goalAcos: null,
        settings: {
          ...settings,
          enabled: {
            vcpm: false,
            placement: false,
            spendNoOrders: false,
            noGoal: false,
            noCap: false,
          },
        },
        campaigns: [campaign('c1', { costType: 'VCPM', capped: false })],
        targets: [{ id: 't1', campaignId: 'c1', state: 'ENABLED', metrics: sums('200', '0') }],
      }),
    ).toEqual([]);
  });
});
