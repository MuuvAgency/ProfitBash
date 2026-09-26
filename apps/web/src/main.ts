import '@fontsource-variable/jetbrains-mono';
import '@fontsource-variable/space-grotesk';
import 'primeicons/primeicons.css';
import './styles/main.css';

import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { createPinia } from 'pinia';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import Tooltip from 'primevue/tooltip';
import { createApp } from 'vue';
import App from './App.vue';
import { ApiError } from './api';
import { i18n } from './i18n';
import { createAppRouter, installGuards } from './router';
import { installSessionSync } from './router/session-sync';
import { installStaleChunkReload } from './router/stale-chunks';
import { pageTitleKey } from './router/title';
import { useSessionStore } from './stores/session';
import { applyColorScheme, readCachedTheme, resolveColorScheme } from './theme/mode';
import { preset } from './theme/preset';

// Nach einem Deploy fehlen die Chunks der alten Version: einmal neu laden statt zu hängen.
installStaleChunkReload();

// Theme vor dem ersten Paint setzen (Einstellung aus dem letzten Besuch), sonst blitzt es hell auf.
applyColorScheme(
  resolveColorScheme(readCachedTheme(), matchMedia('(prefers-color-scheme: dark)').matches),
);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Client-Fehler (4xx) werden nicht wiederholt, Netzwerk- und Serverfehler höchstens zweimal.
      retry: (failureCount, error) =>
        failureCount < 2 &&
        !(error instanceof ApiError && error.status >= 400 && error.status < 500),
    },
  },
});

const app = createApp(App);
const pinia = createPinia();
const router = createAppRouter();

app.use(pinia);
app.use(i18n);
app.use(PrimeVue, {
  theme: {
    preset,
    options: {
      darkModeSelector: '.dark',
      // Muss zur Layer-Reihenfolge in styles/main.css passen.
      cssLayer: { name: 'primevue', order: 'theme, base, primevue' },
    },
  },
  locale: {
    aria: {
      close: i18n.global.t('common.close'),
      navigation: i18n.global.t('nav.label'),
    },
  },
});
app.use(ToastService);
app.directive('tooltip', Tooltip);
app.use(VueQueryPlugin, { queryClient });

const session = useSessionStore(pinia);
installGuards(router, session);

installSessionSync(router, session, queryClient);

router.afterEach((to) => {
  const { t } = i18n.global;
  const titleKey = pageTitleKey(to);
  document.title = titleKey ? `${t(titleKey)} · ${t('app.name')}` : t('app.name');
});

app.use(router);
app.mount('#app');
