<script setup lang="ts">
import type { TagEntityType } from '@profitbash/shared';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import { ApiError } from '../api';
import type { AssignTagsData, TagData } from '../api/client';
import InlineError from '../components/common/InlineError.vue';
import { errorMessageKey } from '../i18n';
import { useAssignTags } from './queries';
import { ownTagIds } from './row-tags';
import TagChip from './TagChip.vue';

/**
 * Tags für markierte Zeilen des Explorers (`phase-3.md` 3.7, Bulk): je Tag ein Häkchen. Vorbelegt ist, was alle
 * markierten Zeilen tragen; ein Strich heißt „manche“. Geändert wird nur, was der Nutzer anfasst: Häkchen setzen
 * hängt das Tag an alle, Häkchen entfernen löst es von allen.
 */
const props = defineProps<{
  visible: boolean;
  entityType: TagEntityType;
  rows: { id: string; attributes: Record<string, unknown> }[];
  tags: TagData[];
}>();
const emit = defineEmits<{ close: []; assigned: [] }>();

const { t } = useI18n();
const assign = useAssignTags();

/** Vom Nutzer gesetzte Häkchen; ohne Eintrag bleibt das Tag, wie es ist. */
const choices = ref<Record<string, boolean>>({});
const result = ref<AssignTagsData | null>(null);
const errorKey = ref<string | null>(null);

watch(
  () => props.visible,
  (visible) => {
    if (!visible) return;
    choices.value = {};
    result.value = null;
    errorKey.value = null;
    assign.reset();
  },
  { immediate: true },
);

type Coverage = 'all' | 'some' | 'none';
const coverage = computed(() => {
  const counts = new Map<string, number>();
  for (const row of props.rows) {
    for (const id of ownTagIds(row.attributes)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return new Map(
    props.tags.map((tag): [string, Coverage] => {
      const count = counts.get(tag.id) ?? 0;
      return [tag.id, count === 0 ? 'none' : count === props.rows.length ? 'all' : 'some'];
    }),
  );
});
const checked = (tag: TagData) => choices.value[tag.id] ?? coverage.value.get(tag.id) === 'all';
const indeterminate = (tag: TagData) =>
  choices.value[tag.id] === undefined && coverage.value.get(tag.id) === 'some';

function toggle(tag: TagData, next: boolean) {
  choices.value = { ...choices.value, [tag.id]: next };
}

const changes = computed(() => {
  const addTagIds: string[] = [];
  const removeTagIds: string[] = [];
  for (const tag of props.tags) {
    const choice = choices.value[tag.id];
    const before = coverage.value.get(tag.id);
    if (choice === true && before !== 'all') addTagIds.push(tag.id);
    if (choice === false && before !== 'none') removeTagIds.push(tag.id);
  }
  return { addTagIds, removeTagIds };
});
const canSubmit = computed(
  () =>
    changes.value.addTagIds.length + changes.value.removeTagIds.length > 0 &&
    props.rows.length > 0 &&
    !assign.isPending.value,
);

async function submit() {
  if (!canSubmit.value) return;
  errorKey.value = null;
  try {
    result.value = await assign.mutateAsync({
      entityType: props.entityType,
      entityIds: props.rows.map((row) => row.id),
      ...changes.value,
    });
    emit('assigned');
  } catch (error) {
    errorKey.value = errorMessageKey(error instanceof ApiError ? error.code : 'UNKNOWN');
  }
}
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    :closable="!assign.isPending.value"
    :close-on-escape="!assign.isPending.value"
    :header="t('tags.assign.title', { count: rows.length }, rows.length)"
    :style="{ width: 'min(30rem, calc(100vw - 2rem))' }"
    @update:visible="(next) => !next && emit('close')"
  >
    <div v-if="result" class="flex flex-col gap-space-lg">
      <div
        data-assign-result
        role="status"
        class="flex flex-col gap-space-xs text-body-sm text-ink"
      >
        <p class="font-semibold">
          <i class="pi pi-check-circle mr-space-xs text-lime-deep" aria-hidden="true" />{{
            t('tags.assign.result.added', { count: result.added }, result.added)
          }}
        </p>
        <p v-if="result.removed > 0" class="text-ink-secondary">
          {{ t('tags.assign.result.removed', { count: result.removed }, result.removed) }}
        </p>
        <p v-if="result.skippedEntities > 0" class="text-on-loss-wash">
          {{
            t(
              'tags.assign.result.skipped',
              { count: result.skippedEntities },
              result.skippedEntities,
            )
          }}
        </p>
      </div>
      <div class="flex justify-end">
        <Button type="button" :label="t('common.close')" @click="emit('close')" />
      </div>
    </div>

    <form v-else class="flex flex-col gap-space-lg" @submit.prevent="submit">
      <InlineError v-if="errorKey" :message="t(errorKey)" />
      <p v-if="tags.length === 0" class="text-body-md text-ink-secondary">
        {{ t('tags.assign.noTags') }}
        <RouterLink :to="{ name: 'tags' }" class="font-medium text-violet hover:underline">{{
          t('tags.assign.manage')
        }}</RouterLink>
      </p>
      <fieldset v-else class="flex max-h-80 flex-col overflow-y-auto">
        <legend class="mb-space-xs text-label-eyebrow uppercase text-ink-tertiary">
          {{ t('tags.assign.legend') }}
        </legend>
        <label
          v-for="tag in tags"
          :key="tag.id"
          class="flex min-h-11 items-center gap-space-sm text-body-md text-ink"
        >
          <input
            type="checkbox"
            class="size-4 accent-violet"
            :data-tag="tag.id"
            :checked="checked(tag)"
            :indeterminate="indeterminate(tag)"
            @change="toggle(tag, ($event.target as HTMLInputElement).checked)"
          />
          <TagChip :name="tag.name" :color="tag.color" />
          <span v-if="indeterminate(tag)" class="text-body-sm text-ink-secondary">
            {{ t('tags.assign.some') }}
          </span>
        </label>
      </fieldset>
      <p v-if="tags.length > 0" class="text-body-sm text-ink-secondary">
        {{ t('tags.assign.hint') }}
      </p>
      <div class="flex justify-end gap-space-sm">
        <Button
          type="button"
          :label="t('common.cancel')"
          severity="secondary"
          variant="text"
          :disabled="assign.isPending.value"
          @click="emit('close')"
        />
        <Button
          type="submit"
          data-assign-submit
          :label="t('tags.assign.submit')"
          :loading="assign.isPending.value"
          :disabled="!canSubmit"
        />
      </div>
    </form>
  </Dialog>
</template>
