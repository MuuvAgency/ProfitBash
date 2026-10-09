import type { StructureCatalog } from '@profitbash/shared';

/**
 * Befunde von `structureCatalogSchema` als deutsche Meldungen mit Ort (`phase-4.md` 4.2): eigene Befunde tragen
 * `params.issue` und Schlüssel (übersetzt über `catalog.issue.<code>`, Schlüssel werden zu Bezeichnungen); Fehler in
 * Feldern nennen Baustein bzw. Preset und Feld aus dem Pfad.
 */
type Translate = (key: string, params?: Record<string, unknown>) => string;

/** Was die Seite von einem zod-Befund braucht (das Web hängt nicht direkt an zod). */
export interface CatalogIssue {
  code: string;
  path: readonly PropertyKey[];
  params?: Record<string, unknown> | undefined;
}

export function describeCatalogIssues(
  issues: readonly CatalogIssue[],
  draft: StructureCatalog,
  t: Translate,
): string[] {
  const blockLabel = (key: unknown) =>
    draft.blocks.find((block) => block.key === key)?.label ?? String(key);
  const presetName = (key: unknown) =>
    draft.presets.find((preset) => preset.key === key)?.name ?? String(key);

  const describe = (issue: CatalogIssue): string => {
    if (issue.code === 'custom' && issue.params && typeof issue.params.issue === 'string') {
      const { issue: code, ...params } = issue.params;
      return t(`catalog.issue.${String(code)}`, {
        ...params,
        ...('key' in params && { key: blockLabel(params.key) }),
        ...('block' in params && { block: blockLabel(params.block) }),
        ...('from' in params && { from: blockLabel(params.from) }),
        ...('to' in params && { to: blockLabel(params.to) }),
        ...('preset' in params && { preset: presetName(params.preset) }),
        ...(code === 'duplicatePreset' && { key: presetName(params.key) }),
        ...(code === 'namingUnknownPlaceholder' && { name: `{${String(params.name)}}` }),
      });
    }
    const [section, index] = issue.path;
    const field = [...issue.path].reverse().find((part) => typeof part === 'string');
    let where = t('catalog.where.catalog');
    if (section === 'blocks' && typeof index === 'number') {
      where = draft.blocks[index]?.label ?? where;
    } else if (section === 'presets' && typeof index === 'number') {
      const preset = draft.presets[index];
      where = preset?.name ?? where;
      // Ein Preset ohne Bausteine (Pfad endet auf `blocks`).
      if (issue.code === 'too_small' && issue.path.length === 3 && field === 'blocks') {
        return t('catalog.issue.presetNoBlocks', { preset: where });
      }
      const blockIndex = issue.path[3];
      if (typeof blockIndex === 'number') {
        where = `${where} · ${blockLabel(preset?.blocks[blockIndex]?.block)}`;
      }
    } else if (section === 'naming') where = t('catalog.where.naming');
    else if (section === 'edges') where = t('catalog.where.edges');
    return t('catalog.issue.field', {
      where,
      field: typeof field === 'string' ? t(`catalog.field.${field}`) : '',
    });
  };

  return [...new Set(issues.map(describe))];
}
