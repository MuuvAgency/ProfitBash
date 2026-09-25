import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import Tooltip from 'primevue/tooltip';
import { h, type Component } from 'vue';
import { createMemoryHistory, RouterView } from 'vue-router';
import { i18n } from '../i18n';
import { createAppRouter, installGuards } from '../router';
import { installSessionSync } from '../router/session-sync';
import { useSessionStore } from '../stores/session';

let cleanups: (() => void)[] = [];

/** In `afterEach` aufrufen: entfernt Listener und montierte Komponenten. */
export function cleanupMounted() {
  cleanups.forEach((cleanup) => cleanup());
  cleanups = [];
  document.body.innerHTML = '';
}

/**
 * Montiert eine Komponente mit Router, Pinia, i18n, PrimeVue (ohne Styles) und TanStack Query,
 * verdrahtet wie in main.ts. `path` ist die Start-URL; die Guards laufen mit.
 * Ohne `component` wird die App über `RouterView` gerendert (Shell, Seiten).
 */
export async function mountWithApp(component?: Component, { path = '/' } = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const session = useSessionStore();
  const router = createAppRouter(createMemoryHistory());
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  installGuards(router, session);
  cleanups.push(installSessionSync(router, session, queryClient));
  await router.push(path);
  await router.isReady();
  const wrapper = mount(component ?? { render: () => h(RouterView) }, {
    attachTo: document.body,
    global: {
      plugins: [
        pinia,
        router,
        i18n,
        [PrimeVue, { unstyled: true }],
        ToastService,
        [VueQueryPlugin, { queryClient }],
      ],
      directives: { tooltip: Tooltip },
    },
  });
  cleanups.push(() => wrapper.unmount());
  await flushPromises();
  return { wrapper, router, queryClient, session };
}
