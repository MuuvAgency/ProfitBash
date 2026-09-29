import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computed, defineComponent, isProxy } from 'vue';
import { api } from '../api';
import type { AnalyticsQueryBody } from '../analytics/filters';
import { useExplorerRows } from './queries';
import { explorerStateFromRoute } from './state';

afterEach(() => vi.restoreAllMocks());

describe('useExplorerRows', () => {
  it('hält die Zeilen flach (shallow): keine reaktiven Proxys für bis zu 10 000 Zeilen (2.13)', async () => {
    const response = { rows: [{ id: 'r1', attributes: { amazonId: '1' } }] };
    vi.spyOn(api.analytics, 'explorerRows').mockResolvedValue(
      response as unknown as Awaited<ReturnType<typeof api.analytics.explorerRows>>,
    );
    let result: ReturnType<typeof useExplorerRows> | undefined;
    const Host = defineComponent({
      setup() {
        result = useExplorerRows(
          computed(() => ({ comparison: null }) as unknown as AnalyticsQueryBody),
          computed(() => explorerStateFromRoute('/ads/explorer/campaigns', {})),
          computed(() => true),
        );
        return () => null;
      },
    });
    mount(Host, {
      global: { plugins: [[VueQueryPlugin, { queryClient: new QueryClient() }]] },
    });
    await vi.waitFor(async () => {
      await flushPromises();
      expect(result!.data.value).toBeDefined();
    });
    expect(isProxy(result!.data.value)).toBe(false);
    expect(isProxy(result!.data.value!.rows[0])).toBe(false);
  });
});
