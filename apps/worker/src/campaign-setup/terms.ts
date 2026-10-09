import type { CampaignSetupItemRow } from '@profitbash/db';
import { comparableSearchTerm } from '@profitbash/engine';

/**
 * Begriff einer Setup-Zeile für die Kopplung „Negativ in der Quelle“ ↔ neues Ziel (`phase-4.md` 4.6): Keywords in
 * Vergleichsform, ASINs groß; `null` für Zeilen ohne Begriff. Ein Negativ in der Quelle geht nur raus, wenn ein Ziel
 * mit demselben Begriff angelegt wird, sonst verlöre die Quelle den Traffic ohne Ersatz.
 */
export function setupTermKey(row: CampaignSetupItemRow): string | null {
  const payload = row.payload;
  switch (payload.entity) {
    case 'keyword':
      return `kw:${comparableSearchTerm(payload.text)}`;
    case 'product_target':
      return payload.expression.type === 'category'
        ? null
        : `asin:${payload.expression.value.toUpperCase()}`;
    case 'source_negative':
      return payload.negative.type === 'keyword'
        ? `kw:${comparableSearchTerm(payload.negative.text)}`
        : `asin:${payload.negative.asin.toUpperCase()}`;
    default:
      return null;
  }
}

export const HARVEST_TARGET_NOT_CREATED = {
  code: 'HARVEST_TARGET_NOT_CREATED',
  message: 'Das neue Ziel dieses Begriffs wird nicht angelegt; die Quelle bleibt unverändert.',
} as const;
