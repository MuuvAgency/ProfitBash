<script setup lang="ts">
import { computed, ref, toRef, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import InlineError from '../../components/common/InlineError.vue';
import { inputClass, labelClass } from '../catalog/draft';
import { useSetupBrands } from '../queries';
import { creativeFormIssues, type CreativeForm } from './creative';

/**
 * Werbemittel für die Sponsored-Brands-Kampagnen eines Entwurfs (`phase-4.md` 4.10, ein Satz je Entwurf): Marke aus
 * dem letzten Bulk-Import (Blatt „Brand Assets Data“), Markenname, optional Logo und Titel der Kollektion, Video
 * für das Format „Video“. Asset-IDs kopiert man aus der Asset-Bibliothek der Werbekonsole.
 */
const props = defineProps<{
  profileId: string | null;
  disabled: boolean;
  /** Das Preset hat einen Video-Baustein: Die Video-ID ist dann Pflicht (sonst sperrt die Prüfung). */
  needsVideo: boolean;
}>();
const form = defineModel<CreativeForm>({ required: true });

const { t } = useI18n();
const id = useId();
const brands = useSetupBrands(toRef(props, 'profileId'));
const brandList = computed(() => brands.data.value?.brands ?? []);
const issues = computed(() => new Set(creativeFormIssues(form.value)));
const touched = ref(false);

function update(key: keyof CreativeForm, value: string) {
  touched.value = true;
  form.value = { ...form.value, [key]: value };
}
function pickBrand(brandEntityId: string) {
  const brand = brandList.value.find((entry) => entry.brandEntityId === brandEntityId);
  form.value = {
    ...form.value,
    brandEntityId,
    // Den Namen der Marke vorbelegen, wenn noch keiner eingetragen ist.
    brandName:
      form.value.brandName.trim() === '' && brand?.name ? brand.name : form.value.brandName,
  };
}

interface Field {
  key: Exclude<keyof CreativeForm, 'brandEntityId'>;
  label: string;
  maxlength: number;
}
const fields = computed((): Field[] => [
  { key: 'brandName', label: 'setup.creative.brandName', maxlength: 30 },
  { key: 'logoAssetId', label: 'setup.creative.logoAssetId', maxlength: 220 },
  { key: 'adTitle', label: 'setup.creative.adTitle', maxlength: 32 },
  ...(props.needsVideo
    ? [{ key: 'videoAssetId' as const, label: 'setup.creative.videoAssetId', maxlength: 220 }]
    : []),
]);
</script>

<template>
  <fieldset class="flex min-w-0 flex-col gap-space-sm" :disabled="disabled" data-setup-creative>
    <legend :class="[labelClass, 'mb-space-xs']">{{ t('setup.creative.title') }}</legend>
    <p class="text-body-sm text-ink-secondary">{{ t('setup.creative.hint') }}</p>
    <div class="grid gap-space-md md:grid-cols-2">
      <div class="flex min-w-0 flex-col gap-space-xs">
        <label :for="`${id}-brand`" :class="labelClass">{{ t('setup.creative.brand') }}</label>
        <select
          :id="`${id}-brand`"
          :value="form.brandEntityId"
          data-setup-creative-brand
          :class="inputClass"
          @change="pickBrand(($event.target as HTMLSelectElement).value)"
        >
          <option value="">{{ t('setup.creative.noBrand') }}</option>
          <option
            v-for="brand in brandList"
            :key="brand.brandEntityId"
            :value="brand.brandEntityId"
          >
            {{ brand.name ? `${brand.name} (${brand.brandEntityId})` : brand.brandEntityId }}
          </option>
        </select>
        <InlineError v-if="brands.isError.value" :message="t('setup.creative.brandsFailed')" />
        <p
          v-else-if="brands.isSuccess.value && brandList.length === 0"
          class="text-body-sm text-ink-secondary"
        >
          {{ t('setup.creative.noBrands') }}
        </p>
      </div>
      <div v-for="field in fields" :key="field.key" class="flex min-w-0 flex-col gap-space-xs">
        <label :for="`${id}-${field.key}`" :class="labelClass">{{ t(field.label) }}</label>
        <input
          :id="`${id}-${field.key}`"
          :value="form[field.key]"
          :data-setup-creative-field="field.key"
          :maxlength="field.maxlength"
          :aria-invalid="touched && issues.has(field.key) ? 'true' : undefined"
          :aria-describedby="
            touched && issues.has(field.key) ? `${id}-${field.key}-hint` : undefined
          "
          :class="[
            inputClass,
            field.key.endsWith('AssetId') && 'font-data',
            touched && issues.has(field.key) && 'ring-2 ring-loss',
          ]"
          spellcheck="false"
          @input="update(field.key, ($event.target as HTMLInputElement).value)"
        />
        <p
          v-if="touched && issues.has(field.key)"
          :id="`${id}-${field.key}-hint`"
          class="text-body-sm text-on-loss-wash"
          aria-live="polite"
        >
          {{ t(`setup.creative.invalid.${field.key}`) }}
        </p>
      </div>
    </div>
  </fieldset>
</template>
