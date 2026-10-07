import {
  FILE_BULK_STALE_AFTER_DAYS,
  FILE_METRICS_STALE_AFTER_DAYS,
  fileDataStaleness,
  type Profile,
} from '@profitbash/shared';
import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { useI18n } from 'vue-i18n';

/**
 * Texte der Hinweise auf veraltete Daten eines Profils ohne Connection (1.11f). Stand beim Berechnen (`new Date()`
 * ist nicht reaktiv); die Profilliste lädt nach jedem fertigen Import neu.
 */
export function useFileStalenessHints(profile: MaybeRefOrGetter<Profile | null>) {
  const { t } = useI18n();
  return computed(() => {
    const value = toValue(profile);
    if (!value) return [];
    return fileDataStaleness(value, new Date()).map((hint) =>
      hint === 'noBulk'
        ? t('connections.fileProfiles.noBulk')
        : hint === 'bulkStale'
          ? t('connections.fileProfiles.bulkStale', { days: FILE_BULK_STALE_AFTER_DAYS })
          : t('connections.fileProfiles.metricsStale', { days: FILE_METRICS_STALE_AFTER_DAYS }),
    );
  });
}
