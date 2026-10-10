<script setup lang="ts">
import { useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { GUARDRAIL_FIELDS, type GuardrailInputs, type GuardrailKey } from './guardrail-form';

/** Felder der Leitplanken, für die Organisation und (mit Platzhaltern der geerbten Werte) je Client. */
defineProps<{
  form: 'defaults' | 'client';
  invalid: ReadonlySet<GuardrailKey>;
  /** Geerbte Werte, gezeigt in leeren Feldern. */
  placeholders?: GuardrailInputs;
  disabled?: boolean;
}>();
const inputs = defineModel<GuardrailInputs>({ required: true });
const { t } = useI18n();
const id = useId();
</script>

<template>
  <div :data-guardrails="form" class="grid gap-space-md sm:grid-cols-2">
    <div v-for="field in GUARDRAIL_FIELDS" :key="field.key" class="flex flex-col gap-space-xs">
      <label :for="`${id}-${field.key}`" class="text-label-eyebrow uppercase text-ink-tertiary">
        {{ t(`automations.guardrail.${field.key}.label`) }}
      </label>
      <input
        :id="`${id}-${field.key}`"
        v-model="inputs[field.key]"
        :data-guardrail="field.key"
        type="text"
        :inputmode="field.integer ? 'numeric' : 'decimal'"
        autocomplete="off"
        :disabled="disabled"
        :placeholder="placeholders?.[field.key]"
        :aria-invalid="invalid.has(field.key) ? 'true' : undefined"
        :aria-describedby="`${id}-${field.key}-hint`"
        :class="[
          'h-11 min-w-0 rounded-control bg-well px-space-md font-data text-ink outline-none focus-visible:ring-2 disabled:opacity-60',
          invalid.has(field.key) ? 'ring-2 ring-loss' : 'focus-visible:ring-violet',
        ]"
      />
      <p
        :id="`${id}-${field.key}-hint`"
        :class="[
          'text-body-sm',
          invalid.has(field.key) ? 'text-on-loss-wash' : 'text-ink-secondary',
        ]"
      >
        {{ t(`automations.guardrail.${field.key}.hint`) }}
      </p>
    </div>
  </div>
</template>
