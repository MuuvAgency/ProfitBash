import { describe, expect, it } from 'vitest';
import { groupedIssues, issueText } from './issues';

/** Hinweise des Setups (`phase-4.md` 4.5): sortiert, „Gebote aus dem Profil“ zusammengefasst, mit Bezeichnungen. */

const t = (key: string, params?: Record<string, unknown>) =>
  `${key} ${JSON.stringify(params ?? {})}`;
const te = () => true;

describe('Hinweise des Setups', () => {
  it('fasst Gebote aus dem Profil zusammen und sortiert Fehler nach vorn', () => {
    const grouped = groupedIssues([
      { severity: 'info', code: 'bidFromProfile', block: 'SP-KW-EXACT' },
      { severity: 'warning', code: 'keywordAlreadyExact', keyword: 'x', existing: 'y' },
      { severity: 'info', code: 'bidFromProfile', block: 'SP-CAT' },
      { severity: 'error', code: 'noProducts' },
    ]);
    expect(grouped.map((issue) => issue.code)).toEqual([
      'noProducts',
      'keywordAlreadyExact',
      'bidFromProfileGrouped',
    ]);
    const labels: Record<string, string> = { 'SP-KW-EXACT': 'Exakt', 'SP-CAT': 'Kategorie' };
    expect(issueText(t, te, grouped[2]!, (key) => labels[key] ?? key)).toContain(
      '"blocks":"Exakt, Kategorie"',
    );
  });

  it('nennt Bausteine mit ihrer Bezeichnung und übersetzt Namensbefunde', () => {
    expect(
      issueText(
        t,
        te,
        { severity: 'info', code: 'skippedNoKeywords', block: 'SP-KW-EXACT' },
        () => 'Exakt',
      ),
    ).toContain('"block":"Exakt"');
    expect(
      issueText(t, te, {
        severity: 'error',
        code: 'campaignNameInvalid',
        campaign: 'X',
        issue: 'onlyDigits',
      }),
    ).toContain('setup.nameIssue.onlyDigits');
  });
});
