<script setup lang="ts">
import { LOCALES, THEMES, type Settings, type Theme } from '@profitbash/shared';
import RadioButton from 'primevue/radiobutton';
import Select from 'primevue/select';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import InlineError from '../components/common/InlineError.vue';
import PageHeader from '../components/common/PageHeader.vue';
import { formatPreview } from '../settings/preview';
import { useSessionStore } from '../stores/session';

const { t } = useI18n();
const session = useSessionStore();

const THEME_ICONS: Record<Theme, string> = {
  system: 'pi-desktop',
  light: 'pi-sun',
  dark: 'pi-moon',
};

const localeOptions = computed(() =>
  LOCALES.map((locale) => ({ value: locale, label: t(`settings.locale.options.${locale}`) })),
);
const preview = computed(() => formatPreview(session.preferences.locale));

// --- Speichern ----------------------------------------------------------------------------

/**
 * Ergebnis der Änderungen seit der letzten Nutzeraktion. Ein Fehler bleibt stehen, bis der Nutzer
 * wieder etwas ändert, auch wenn ein späterer Save klappt (sonst ginge die Rücknahme unbemerkt unter).
 */
const outcome = ref<'saved' | 'failed' | null>(null);
let latest = 0;

async function update(patch: Partial<Settings>) {
  const request = ++latest;
  outcome.value = null;
  try {
    await session.updatePreferences(patch);
    if (request === latest && outcome.value !== 'failed') outcome.value = 'saved';
  } catch {
    outcome.value = 'failed';
  }
}
</script>

<template>
  <div class="flex max-w-3xl flex-col gap-space-xl">
    <PageHeader
      :title="t('nav.settings')"
      :eyebrow="t('settings.eyebrow')"
      :description="t('settings.description')"
    >
      <!-- Im Kopf statt über den Einstellungen: Die Meldung verschiebt so nichts unter dem Cursor.
           Die Region bleibt stehen, nur der Inhalt wechselt (sonst liest ein Screenreader ihn nicht vor). -->
      <template #actions>
        <p role="status" class="flex items-center gap-space-sm text-body-sm text-ink-secondary">
          <template v-if="outcome === 'saved'">
            <i class="pi pi-check-circle text-lime-deep" aria-hidden="true" />{{
              t('settings.saved')
            }}
          </template>
        </p>
      </template>
    </PageHeader>

    <InlineError v-if="outcome === 'failed'" :message="t('settings.saveFailed')" />

    <section class="flex flex-col gap-space-md rounded-tile bg-tile p-space-lg shadow-tile">
      <fieldset class="flex flex-col gap-space-md" aria-describedby="settings-theme-hint">
        <!-- Überschrift in der Legende: Die Sprungnavigation über Überschriften findet beide Bereiche. -->
        <legend class="mb-space-xs">
          <h2 class="text-headline-sm text-ink">{{ t('settings.theme.title') }}</h2>
        </legend>
        <p id="settings-theme-hint" class="text-body-sm text-ink-secondary">
          {{ t('settings.theme.hint') }}
        </p>
        <div class="grid gap-space-sm sm:grid-cols-3">
          <!-- Die ganze Kachel ist das Label: Klick auf Symbol oder Rand wählt ebenfalls aus. -->
          <label
            v-for="theme in THEMES"
            :key="theme"
            :for="`settings-theme-${theme}`"
            class="flex cursor-pointer items-center gap-space-sm rounded-control bg-well px-space-md py-space-sm text-body-md text-ink"
          >
            <RadioButton
              :input-id="`settings-theme-${theme}`"
              name="settings-theme"
              :value="theme"
              :model-value="session.preferences.theme"
              @update:model-value="(value: Theme) => update({ theme: value })"
            />
            <i :class="['pi', THEME_ICONS[theme], 'text-ink-secondary']" aria-hidden="true" />
            <span class="flex-1">{{ t(`settings.theme.${theme}`) }}</span>
          </label>
        </div>
      </fieldset>
    </section>

    <section class="flex flex-col gap-space-md rounded-tile bg-tile p-space-lg shadow-tile">
      <div class="flex flex-col gap-space-xs">
        <h2 class="text-headline-sm text-ink">{{ t('settings.locale.title') }}</h2>
        <p class="text-body-sm text-ink-secondary">{{ t('settings.locale.hint') }}</p>
      </div>
      <div class="flex w-full flex-col gap-space-xs sm:w-96">
        <label id="settings-locale-label" class="text-body-sm text-ink-secondary">
          {{ t('settings.locale.label') }}
        </label>
        <Select
          :model-value="session.preferences.locale"
          :options="localeOptions"
          option-label="label"
          option-value="value"
          aria-labelledby="settings-locale-label"
          fluid
          @update:model-value="(value: Settings['locale']) => update({ locale: value })"
        />
      </div>
      <div class="flex flex-col gap-space-sm">
        <h3 class="text-label-eyebrow uppercase text-ink-tertiary">
          {{ t('settings.locale.previewTitle') }}
        </h3>
        <dl
          data-testid="format-preview"
          class="grid gap-x-space-lg gap-y-space-sm rounded-control bg-well p-space-md sm:grid-cols-2"
        >
          <div
            v-for="entry in preview"
            :key="entry.key"
            class="flex items-baseline justify-between gap-space-md"
          >
            <dt class="text-body-sm text-ink-secondary">
              {{ t(`settings.locale.preview.${entry.key}`) }}
            </dt>
            <dd class="font-data text-data-md text-ink">{{ entry.value }}</dd>
          </div>
        </dl>
      </div>
    </section>
  </div>
</template>
