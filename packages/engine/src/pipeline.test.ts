import type { AutomationRule } from '@profitbash/shared/automation-rules';
import { describe, expect, it } from 'vitest';
import {
  decideCampaign,
  decideTarget,
  type CampaignDecisionInput,
  type TargetDecisionInput,
} from './pipeline';

/** Pipeline je Entity (`phase-5.md` 5.7): erste passende Regel, sonst Optimizer, danach Leitplanken. */

const guardrails = {
  maxBidChangePercent: 50,
  bidFloorCpcPercent: 50,
  bidFloor: null,
  maxBid: null,
  minClicks: 15,
  minSpend: '10.00',
};
const rule = (patch: Partial<AutomationRule> = {}): AutomationRule => ({
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Viele Klicks ohne Bestellung',
  level: 'target',
  conditions: [
    { metric: 'clicks', comparator: 'gte', value: '30' },
    { metric: 'orders', comparator: 'lte', value: '0' },
  ],
  action: { type: 'changePercent', field: 'bid', value: '-20' },
  clientId: null,
  enabled: true,
  ...patch,
});
/** Target mit 40 Klicks, 40 € Ausgaben, 100 € Umsatz, 4 Bestellungen (ACoS 40 %, CPC 1.00). */
const target = (patch: Partial<TargetDecisionInput> = {}): TargetDecisionInput => ({
  target: {
    state: 'ENABLED',
    bid: '1.00',
    metrics: { clicks: 40, spend: '40.00', sales: '100.00' },
  },
  adGroup: {
    state: 'ENABLED',
    defaultBid: '0.60',
    metrics: { clicks: 200, spend: '180.00', sales: '600.00' },
  },
  campaign: {
    state: 'ENABLED',
    costType: null,
    metrics: { clicks: 1000, spend: '900.00', sales: '2500.00' },
  },
  goalAcos: '20',
  guardrails,
  limit: null,
  rules: [],
  clientId: null,
  impressions: 5000,
  orders: 4,
  eurRate: '1',
  protectedTerm: false,
  ...patch,
});
const withoutOrders = { orders: 0 };

describe('decideTarget', () => {
  it('ohne passende Regel rechnet der Optimizer', () => {
    expect(decideTarget(target({ rules: [rule()] }))).toEqual({
      kind: 'proposal',
      field: 'bid',
      before: '1',
      after: '0.53',
      source: 'optimizer',
      ruleId: null,
      limitedBy: [],
      desired: '0.5218',
      valuePerClick: '2.6089',
    });
  });

  it('die erste passende Regel gewinnt vor dem Optimizer; die Leitplanken begrenzen auch sie', () => {
    expect(decideTarget(target({ ...withoutOrders, rules: [rule()] }))).toEqual({
      kind: 'proposal',
      field: 'bid',
      before: '1',
      after: '0.8',
      source: 'rule',
      ruleId: rule().id,
      limitedBy: [],
      desired: '0.8',
    });
    const tight = { ...guardrails, maxBidChangePercent: 10 };
    expect(
      decideTarget(target({ ...withoutOrders, rules: [rule()], guardrails: tight })),
    ).toMatchObject({ after: '0.9', desired: '0.8', limitedBy: ['weeklyChange'] });
  });

  it('eine Regel braucht keine Mindestdaten, der Optimizer schon', () => {
    const few = target({
      ...withoutOrders,
      target: {
        state: 'ENABLED',
        bid: '1.00',
        metrics: { clicks: 5, spend: '2.00', sales: '0' },
      },
    });
    expect(decideTarget(few)).toEqual({ kind: 'none', reason: 'insufficientData', ruleId: null });
    const eager = rule({ conditions: [{ metric: 'clicks', comparator: 'gte', value: '5' }] });
    expect(decideTarget({ ...few, rules: [eager] })).toMatchObject({
      source: 'rule',
      after: '0.8',
    });
  });

  it('Regeln rechnen ohne eigenes Gebot mit dem Standardgebot und mit dem Ausgangsgebot aus Änderungen', () => {
    const noBid = target({ ...withoutOrders, rules: [rule()] });
    noBid.target = { ...noBid.target, bid: null };
    // 0.60 − 20 % = 0.48, der Boden (50 % des CPC 1.00) hält bei 0.50.
    expect(decideTarget(noBid)).toMatchObject({
      before: '0.6',
      after: '0.5',
      desired: '0.48',
      limitedBy: ['bidFloor'],
    });
    expect(decideTarget({ ...noBid, base: '2.00', windowStart: '2.00' })).toMatchObject({
      before: '2',
      after: '1.6',
    });
    noBid.adGroup = { ...noBid.adGroup, defaultBid: null };
    expect(decideTarget(noBid)).toEqual({ kind: 'none', reason: 'noBase', ruleId: rule().id });
  });

  it('Beträge der Regel sind in EUR und werden in die Währung des Profils umgerechnet', () => {
    const set = rule({ action: { type: 'set', field: 'bid', value: '0.50' } });
    expect(
      decideTarget(target({ ...withoutOrders, rules: [set], eurRate: '1.5', limit: null })),
    ).toMatchObject({ after: '0.75', desired: '0.75' });
  });

  it('pausiert per Regel; geschützte Begriffe lassen „pausieren“ und „setzen“ aus', () => {
    const pause = rule({ action: { type: 'pause' } });
    expect(decideTarget(target({ ...withoutOrders, rules: [pause] }))).toEqual({
      kind: 'proposal',
      field: 'state',
      before: 'ENABLED',
      after: 'PAUSED',
      source: 'rule',
      ruleId: pause.id,
      limitedBy: [],
    });
    const guarded = { ...withoutOrders, protectedTerm: true };
    expect(decideTarget(target({ ...guarded, rules: [pause] }))).toEqual({
      kind: 'none',
      reason: 'protectedTerm',
      ruleId: pause.id,
    });
    const set = rule({ action: { type: 'set', field: 'bid', value: '0.10' } });
    expect(decideTarget(target({ ...guarded, rules: [set] }))).toMatchObject({
      reason: 'protectedTerm',
    });
    // Prozentuale Senkungen bleiben erlaubt (der Boden gilt wie für jedes Target).
    expect(decideTarget(target({ ...guarded, rules: [rule()] }))).toMatchObject({ after: '0.8' });
  });

  it('nichts für inaktive Entities und vCPM-Kampagnen, auch wenn eine Regel passt', () => {
    const paused = target({ ...withoutOrders, rules: [rule()] });
    paused.adGroup = { ...paused.adGroup, state: 'PAUSED' };
    expect(decideTarget(paused)).toEqual({ kind: 'none', reason: 'inactive', ruleId: null });
    const vcpm = target({ ...withoutOrders, rules: [rule()] });
    vcpm.campaign = { ...vcpm.campaign, costType: 'vcpm' };
    expect(decideTarget(vcpm)).toEqual({ kind: 'none', reason: 'vcpm', ruleId: null });
  });

  it('hält eine Leitplanke die Regel ganz auf, gibt es keinen Vorschlag, aber den Grund', () => {
    const floored = target({ ...withoutOrders, rules: [rule()], windowStart: '2.00' });
    // Wochenrahmen: 50 % von 2.00 = 1.00 = Basis.
    expect(decideTarget(floored)).toEqual({
      kind: 'none',
      reason: 'unchanged',
      ruleId: rule().id,
      limitedBy: ['weeklyChange'],
    });
  });
});

const campaignRule = rule({
  id: '00000000-0000-4000-8000-000000000002',
  level: 'campaign',
  conditions: [{ metric: 'spend', comparator: 'gte', value: '50' }],
  action: { type: 'changePercent', field: 'budget', value: '-30' },
});
const campaign = (patch: Partial<CampaignDecisionInput> = {}): CampaignDecisionInput => ({
  state: 'ENABLED',
  budget: '20.00',
  metrics: { impressions: 9000, clicks: 100, orders: 3, spend: '80.00', sales: '100.00' },
  goalAcos: '20',
  maxBudgetDecreasePercent: 20,
  limit: { min: '1.00', max: '1000000.00' },
  rules: [campaignRule],
  clientId: null,
  eurRate: '1',
  ...patch,
});

describe('decideCampaign', () => {
  it('ändert das Budget per Regel, begrenzt durch die Leitplanke', () => {
    expect(decideCampaign(campaign())).toEqual({
      kind: 'proposal',
      field: 'budget',
      before: '20',
      after: '16',
      source: 'rule',
      ruleId: campaignRule.id,
      limitedBy: ['budgetDecrease'],
      desired: '14',
    });
  });

  it('ohne passende Regel, inaktiv oder ohne Tagesbudget: kein Vorschlag', () => {
    expect(decideCampaign(campaign({ rules: [] }))).toEqual({
      kind: 'none',
      reason: 'noRule',
      ruleId: null,
    });
    expect(decideCampaign(campaign({ state: 'PAUSED' }))).toMatchObject({ reason: 'inactive' });
    expect(decideCampaign(campaign({ budget: null }))).toEqual({
      kind: 'none',
      reason: 'noBase',
      ruleId: campaignRule.id,
    });
  });

  it('pausiert per Regel', () => {
    const pause = { ...campaignRule, action: { type: 'pause' as const } };
    expect(decideCampaign(campaign({ rules: [pause] }))).toMatchObject({
      field: 'state',
      after: 'PAUSED',
    });
  });
});
