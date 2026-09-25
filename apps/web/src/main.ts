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
import { ApiError, onUnauthorized } from './api';
import { i18n } from './i18n';
import { NAVIGATION } from './navigation/navigation';
import { createAppRouter, installGuards } from './router';
import { useSessionStore } from './stores/session';
import { applyColorScheme, readCachedTheme, resolveColorScheme } from './theme/mode';
import { preset } from './theme/preset';

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

// Session abgelaufen oder widerrufen: abmelden und nach dem Login an dieselbe Stelle zurück.
onUnauthorized(() => {
  if (session.status !== 'authenticated') return;
  session.markSignedOut();
  queryClient.clear();
  const { fullPath } = router.currentRoute.value;
  void router.push({ name: 'login', query: { redirect: fullPath, reason: 'expired' } });
});

const navLabels = new Map(
  NAVIGATION.flatMap((group) => group.items).map((item) => [item.id, item.labelKey]),
);
router.afterEach((to) => {
  const { t } = i18n.global;
  const labelKey =
    to.name === 'login' ? 'login.pageTitle' : navLabels.get(to.meta.navItemId ?? String(to.name));
  document.title = labelKey ? `${t(labelKey)} · ${t('app.name')}` : t('app.name');
});

app.use(router);
app.mount('#app');
