import type { SetupIssueData } from '../../api/client';

type Translate = (key: string, params?: Record<string, unknown>) => string;

/** Text eines Hinweises der Plan-Engine bzw. der Prüfung (`setup.issue.<code>`), mit Parametern. */
export function issueText(
  t: Translate,
  te: (key: string) => boolean,
  issue: SetupIssueData,
): string {
  const params: Record<string, unknown> = { ...issue };
  if (typeof issue.issue === 'string' && te(`setup.nameIssue.${issue.issue}`)) {
    params.issue = t(`setup.nameIssue.${issue.issue}`);
  }
  const key = `setup.issue.${issue.code}`;
  return te(key) ? t(key, params) : t('setup.issue.unknown', { code: issue.code });
}

const ORDER = { error: 0, warning: 1, info: 2 } as const;

/** Fehler zuerst, dann Warnungen, dann Hinweise (sonst in der Reihenfolge der Engine). */
export const sortedIssues = (issues: readonly SetupIssueData[]) =>
  [...issues].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
