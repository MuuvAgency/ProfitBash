import type { AgChartTheme } from 'ag-charts-community';
import { colorRoles, fonts } from '../theme/tokens';

export type ColorScheme = 'light' | 'dark';

/**
 * Chart-Theme aus den Design-Tokens (DESIGN.md §4 „Charts“). AG Charts zeichnet auf Canvas und kennt keine
 * CSS-Variablen; deshalb die Werte je Farbschema direkt aus `tokens.ts`.
 */
export function chartTheme(scheme: ColorScheme) {
  const role = (name: keyof typeof colorRoles) => colorRoles[name][scheme];
  const colors = {
    primary: role('violet'),
    positive: role('lime-deep'),
    negative: role('loss'),
    provisional: role('ink-tertiary'),
    ink: role('ink'),
    muted: role('ink-secondary'),
    subtle: role('ink-tertiary'),
    grid: role('line'),
    tooltip: role('tile-peak'),
  };
  const agTheme: AgChartTheme = {
    baseTheme: scheme === 'dark' ? 'ag-default-dark' : 'ag-default',
    palette: {
      fills: [colors.primary, colors.positive, colors.subtle],
      strokes: [colors.primary, colors.positive, colors.subtle],
    },
    params: {
      fontFamily: fonts.sans,
      chartBackgroundColor: 'transparent',
      backgroundColor: 'transparent',
      foregroundColor: colors.ink,
      textColor: colors.muted,
      subtleTextColor: colors.subtle,
      gridLineColor: colors.grid,
      axisLineColor: colors.grid,
      tooltipBackgroundColor: colors.tooltip,
      tooltipTextColor: colors.ink,
      tooltipSubtleTextColor: colors.muted,
    },
  };
  return { colors, agTheme, monoFont: fonts.mono };
}

export type ChartThemeTokens = ReturnType<typeof chartTheme>;
