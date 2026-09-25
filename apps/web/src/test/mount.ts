import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PrimeVue from 'primevue/config';
import Tooltip from 'primevue/tooltip';
import type { Component } from 'vue';
import { createMemoryHistory } from 'vue-router';
import { i18n } from '../i18n';
import { createAppRouter, installGuards } from '../router';
import { useSessionStore } from '../stores/session';

/**
 * Montiert eine Komponente mit Router, Pinia, i18n, PrimeVue (ohne Styles) und TanStack Query,
 * wie in der App. `path` ist die Start-URL; die Guards laufen mit.
 */
export async function mountWithApp(component: Component, { path = '/' } = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createAppRouter(createMemoryHistory());
  installGuards(router, useSessionStore());
  await router.push(path);
  await router.isReady();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = mount(component, {
    attachTo: document.body,
    global: {
      plugins: [
        pinia,
        router,
        i18n,
        [PrimeVue, { unstyled: true }],
        [VueQueryPlugin, { queryClient }],
      ],
      directives: { tooltip: Tooltip },
    },
  });
  await flushPromises();
  return { wrapper, router, queryClient };
}
