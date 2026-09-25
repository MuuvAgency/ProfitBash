import type { QueryClient } from '@tanstack/vue-query';
import { watch } from 'vue';
import type { Router } from 'vue-router';
import { onUnauthorized } from '../api';
import type { useSessionStore } from '../stores/session';

/**
 * Hält Router und Session im Einklang:
 * - 401 eines eigenen Endpunkts bei angemeldetem Nutzer: abmelden, Cache leeren, Login mit Rücksprung.
 * - Verlässt die Session den Fehlerzustand (z. B. nach „Erneut versuchen“), laufen die Guards für die
 *   aktuelle Seite erneut: Startseite weiterleiten, Rechte prüfen, bei abgelaufener Session zum Login.
 */
export function installSessionSync(
  router: Router,
  session: ReturnType<typeof useSessionStore>,
  queryClient: QueryClient,
): () => void {
  const stopUnauthorized = onUnauthorized(() => {
    if (session.status !== 'authenticated') return;
    session.markSignedOut();
    queryClient.clear();
    const { fullPath } = router.currentRoute.value;
    void router.push({ name: 'login', query: { redirect: fullPath, reason: 'expired' } });
  });

  const stopWatch = watch(
    () => session.status,
    (status, previous) => {
      const current = router.currentRoute.value;
      if (previous !== 'error' || status === 'error' || !current.meta.requiresAuth) return;
      void router.replace({ path: current.fullPath, force: true });
    },
  );

  return () => {
    stopUnauthorized();
    stopWatch();
  };
}
