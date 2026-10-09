import {
  adChangeFieldKind,
  formatCurrency,
  MISSING_VALUE,
  type AdChangeField,
  type Locale,
} from '@profitbash/shared';
import type { PendingAdChangeData, SubmittedAdChangeData } from '../api/client';
import { amazonLabel, targetLabel, type Labels } from '../explorer/amazon-labels';

/** Lesbare Texte für Änderungen (`phase-3.md` 3.6): was geändert wird und von welchem auf welchen Wert. */

export type ChangeLabels = Labels & { locale: Locale };
type Change = PendingAdChangeData | SubmittedAdChangeData;

export interface ChangeSubject {
  /** Art der Entity bzw. „Neues Negative“. */
  kind: string;
  name: string;
  /** Kampagne bzw. Kampagne › Ad Group, in der die Entity liegt. */
  path: string | null;
}

export function changeSubject(change: Change, labels: ChangeLabels): ChangeSubject {
  const { t } = labels;
  const unknown = t('explorer.unknownName');
  const campaign = change.campaignName ?? unknown;
  const parents = [campaign, ...(change.adGroupName ? [change.adGroupName] : [])].join(' › ');
  if (change.operation === 'create') {
    const negative = change.negative;
    const name =
      negative?.type === 'keyword'
        ? `${negative.keywordText} · ${amazonLabel('matchType', negative.matchType, labels)}`
        : negative
          ? t('changes.subject.asin', { asin: negative.asin })
          : unknown;
    return { kind: t('changes.subject.newNegative'), name, path: parents };
  }
  const kind = t(`changes.entity.${change.entityType}`);
  switch (change.entityType) {
    case 'campaign':
      return { kind, name: campaign, path: null };
    case 'ad_group':
      return { kind, name: change.adGroupName ?? unknown, path: campaign };
    case 'product_ad': {
      const name = [change.entity?.asin, change.entity?.sku].filter(Boolean).join(' · ');
      return { kind, name: name || unknown, path: parents };
    }
    default: {
      const entity = change.entity;
      const name = entity
        ? targetLabel(
            {
              keywordText: entity.keywordText,
              matchType: entity.matchType,
              expression: entity.expression,
            },
            labels,
          )
        : null;
      return { kind, name: name ?? unknown, path: parents };
    }
  }
}

/** Wert eines Felds zur Anzeige: Betrag mit Währung, Platzierung in Prozent, Zustand bzw. Strategie übersetzt. */
export function changeValueText(
  field: AdChangeField | null,
  value: string | null,
  currencyCode: string | null,
  labels: ChangeLabels,
): string {
  if (value === null || field === null) return MISSING_VALUE;
  const kind = adChangeFieldKind(field);
  if (kind === 'money') return formatCurrency(value, currencyCode ?? '', labels.locale);
  if (kind === 'percent') return labels.t('changes.percentValue', { value });
  if (field === 'bidding_strategy') return amazonLabel('biddingStrategy', value, labels) ?? value;
  const key = `explorer.state.${value}`;
  return labels.te(key) ? labels.t(key) : value;
}
