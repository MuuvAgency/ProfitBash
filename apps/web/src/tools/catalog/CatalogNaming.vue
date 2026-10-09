<script setup lang="ts">
import {
  campaignNameIssues,
  MAX_CAMPAIGN_NAME_LENGTH,
  renderCampaignName,
} from '@profitbash/engine/naming';
import { MAX_NAMING_PATTERN_LENGTH, NAMING_PLACEHOLDERS } from '@profitbash/shared';
import { computed, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { inputClass, labelClass, useCatalogDraft } from './draft';

/** Namensschema mit Platzhaltern und Vorschau an Beispielen (`phase-4.md` 4.2, F3). */
const { t } = useI18n();
const id = useId();
const { draft, canEdit } = useCatalogDraft();

/** Beispiele mit erfundenen Werten; die Kürzel kommen aus den Bausteinen des Entwurfs. */
const examples = computed(() => {
  const code = (key: string) => draft.value.blocks.find((block) => block.key === key)?.code;
  return [
    { adType: 'SP', block: code('SP-KW-EXACT-SINGLE'), target: 'trinkflasche 1l' },
    { adType: 'SP', block: code('SP-AUTO'), target: null },
    { adType: 'SD', block: code('SD-RT-PURCHASE'), target: '60D' },
  ]
    .filter((example) => example.block)
    .map((example) =>
      renderCampaignName(draft.value.naming.pattern, {
        ...example,
        group: 'Flaschen',
        client: 'Waldkauz',
        country: 'DE',
      }),
    );
});
/** `{name}` als Text (geschweifte Klammern im Template wären Mustache-Syntax). */
const placeholderText = (name: string) => '{' + name + '}';
const issues = computed(() => new Set(examples.value.flatMap((name) => campaignNameIssues(name))));
</script>

<template>
  <section
    class="flex min-w-0 flex-col gap-space-md rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg"
  >
    <div class="flex flex-col gap-space-xs">
      <label :for="`${id}-pattern`" :class="labelClass">{{ t('catalog.naming.pattern') }}</label>
      <input
        :id="`${id}-pattern`"
        v-model="draft.naming.pattern"
        data-naming-pattern
        type="text"
        autocomplete="off"
        :maxlength="MAX_NAMING_PATTERN_LENGTH"
        :disabled="!canEdit"
        :aria-describedby="`${id}-hint`"
        :class="[inputClass, 'font-data']"
      />
      <p :id="`${id}-hint`" class="text-body-sm text-ink-secondary">
        {{ t('catalog.naming.hint') }}
      </p>
    </div>
    <div class="flex flex-col gap-space-xs">
      <h3 :class="labelClass">{{ t('catalog.naming.placeholders') }}</h3>
      <ul class="flex flex-wrap gap-x-space-lg gap-y-space-xs">
        <li v-for="name in NAMING_PLACEHOLDERS" :key="name" class="text-body-sm text-ink-secondary">
          <code class="font-data text-ink">{{ placeholderText(name) }}</code>
          {{ t(`catalog.naming.placeholder.${name}`) }}
        </li>
      </ul>
    </div>
    <div class="flex flex-col gap-space-xs">
      <h3 :class="labelClass">{{ t('catalog.naming.preview') }}</h3>
      <ul data-naming-preview class="flex flex-col gap-space-xs rounded-control bg-well p-space-md">
        <li v-for="name in examples" :key="name" class="break-all font-data text-body-sm text-ink">
          {{ name }}
        </li>
      </ul>
      <p v-if="issues.has('tooLong')" role="alert" class="text-body-sm text-on-loss-wash">
        {{ t('catalog.naming.tooLong', { max: MAX_CAMPAIGN_NAME_LENGTH }) }}
      </p>
      <p
        v-if="issues.has('invalidCharacters')"
        data-naming-invalid
        role="alert"
        class="text-body-sm text-on-loss-wash"
      >
        {{ t('catalog.naming.invalidCharacters') }}
      </p>
    </div>
  </section>
</template>
