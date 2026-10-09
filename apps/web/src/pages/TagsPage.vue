<script setup lang="ts">
import {
  formatNumber,
  MAX_TAG_NAME_LENGTH,
  normalizeTagName,
  TAG_COLORS,
  TAG_ENTITY_TYPES,
  type TagColor,
} from '@profitbash/shared';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import { computed, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError } from '../api';
import type { TagData } from '../api/client';
import EmptyState from '../components/common/EmptyState.vue';
import InlineError from '../components/common/InlineError.vue';
import PageHeader from '../components/common/PageHeader.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import { errorMessageKey } from '../i18n';
import { useSessionStore } from '../stores/session';
import { tagDotClass } from '../tags/colors';
import { useDeleteTag, useSaveTag, useTagRights, useTags } from '../tags/queries';
import TagChip from '../tags/TagChip.vue';

/**
 * Seite „Tags“ (`phase-3.md` 3.7, F7): eigene Tags der Organisation anlegen, umbenennen, umfärben und löschen.
 * Zugewiesen wird im Explorer (markierte Zeilen → „Tags zuweisen“); gefiltert in der Filterleiste von Dashboard
 * und Explorer.
 */
const { t } = useI18n();
const id = useId();
const session = useSessionStore();
const locale = computed(() => session.preferences.locale);
const { canWrite } = useTagRights();
const tagsQuery = useTags();
const tags = computed(() => tagsQuery.data.value ?? []);
const count = (value: number) => formatNumber(String(value), locale.value);

// --- Anlegen und Ändern ------------------------------------------------------------------

const save = useSaveTag();
const editOpen = ref(false);
const editing = ref<TagData | null>(null);
const name = ref('');
const color = ref<TagColor>('violet');
const saveErrorKey = ref<string | null>(null);

function openEdit(tag: TagData | null) {
  editing.value = tag;
  name.value = tag?.name ?? '';
  color.value = tag?.color ?? 'violet';
  saveErrorKey.value = null;
  save.reset();
  editOpen.value = true;
}

const cleanName = computed(() => normalizeTagName(name.value));
const nameTooLong = computed(() => cleanName.value.length > MAX_TAG_NAME_LENGTH);
const canSave = computed(
  () => cleanName.value.length > 0 && !nameTooLong.value && !save.isPending.value,
);

async function submit() {
  if (!canSave.value) return;
  saveErrorKey.value = null;
  try {
    await save.mutateAsync({
      ...(editing.value && { id: editing.value.id }),
      name: cleanName.value,
      color: color.value,
    });
    editOpen.value = false;
  } catch (error) {
    saveErrorKey.value = errorMessageKey(error instanceof ApiError ? error.code : 'UNKNOWN');
  }
}

// --- Löschen -----------------------------------------------------------------------------

const remove = useDeleteTag();
const deleting = ref<TagData | null>(null);
const deleteErrorKey = ref<string | null>(null);
const assignments = (tag: TagData) =>
  TAG_ENTITY_TYPES.reduce((sum, type) => sum + tag.counts[type], 0);

function openDelete(tag: TagData) {
  deleting.value = tag;
  deleteErrorKey.value = null;
  remove.reset();
}

async function confirmDelete() {
  if (!deleting.value || remove.isPending.value) return;
  deleteErrorKey.value = null;
  try {
    await remove.mutateAsync(deleting.value.id);
    deleting.value = null;
  } catch (error) {
    deleteErrorKey.value = errorMessageKey(error instanceof ApiError ? error.code : 'UNKNOWN');
  }
}
</script>

<template>
  <div class="flex flex-col gap-gutter">
    <PageHeader
      :eyebrow="t('explorer.eyebrow')"
      :title="t('tags.title')"
      :description="t('tags.description')"
    />

    <InlineError
      v-if="tagsQuery.isError.value"
      :message="t('tags.loadFailed')"
      retryable
      :retrying="tagsQuery.isFetching.value"
      @retry="tagsQuery.refetch()"
    />
    <SkeletonBlock v-else-if="!tagsQuery.data.value" shape="tile" height="14rem" />

    <template v-else>
      <EmptyState
        v-if="tags.length === 0"
        icon="tags"
        :title="t('tags.empty.title')"
        :text="t(canWrite ? 'tags.empty.text' : 'tags.empty.textViewer')"
      />
      <section
        v-else
        class="flex min-w-0 flex-col gap-space-md rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg"
      >
        <ul class="flex flex-col" data-tag-list>
          <li
            v-for="tag in tags"
            :key="tag.id"
            class="flex flex-wrap items-center gap-x-space-md gap-y-space-xs border-b border-line py-space-sm last:border-b-0"
          >
            <span class="min-w-0 flex-1 basis-48"
              ><TagChip :name="tag.name" :color="tag.color"
            /></span>
            <span class="font-data text-body-sm text-ink-secondary">
              {{
                TAG_ENTITY_TYPES.filter((type) => tag.counts[type] > 0)
                  .map((type) =>
                    t(`tags.count.${type}`, { count: count(tag.counts[type]) }, tag.counts[type]),
                  )
                  .join(' · ') || t('tags.count.none')
              }}
            </span>
            <span v-if="canWrite" class="flex gap-space-xs">
              <Button
                icon="pi pi-pencil"
                severity="secondary"
                variant="text"
                size="small"
                :aria-label="t('tags.edit.action', { name: tag.name })"
                @click="openEdit(tag)"
              />
              <Button
                icon="pi pi-trash"
                severity="secondary"
                variant="text"
                size="small"
                :aria-label="t('tags.delete.action', { name: tag.name })"
                @click="openDelete(tag)"
              />
            </span>
          </li>
        </ul>
      </section>

      <div v-if="canWrite" class="flex flex-wrap items-center gap-space-md">
        <Button icon="pi pi-plus" data-tag-new :label="t('tags.create')" @click="openEdit(null)" />
        <p class="max-w-prose text-body-sm text-ink-secondary">{{ t('tags.howTo') }}</p>
      </div>
    </template>

    <Dialog
      :visible="editOpen"
      modal
      :closable="!save.isPending.value"
      :close-on-escape="!save.isPending.value"
      :header="t(editing ? 'tags.edit.title' : 'tags.create')"
      :style="{ width: 'min(28rem, calc(100vw - 2rem))' }"
      @update:visible="(next) => !next && (editOpen = false)"
    >
      <form class="flex flex-col gap-space-lg" @submit.prevent="submit">
        <InlineError v-if="saveErrorKey" :message="t(saveErrorKey)" />
        <div class="flex flex-col gap-space-xs">
          <label :for="`${id}-name`" class="text-label-eyebrow uppercase text-ink-tertiary">
            {{ t('tags.field.name') }}
          </label>
          <input
            :id="`${id}-name`"
            v-model="name"
            data-tag-name
            type="text"
            autocomplete="off"
            :aria-invalid="nameTooLong ? 'true' : undefined"
            :aria-describedby="nameTooLong ? `${id}-name-hint` : undefined"
            :class="[
              'h-11 rounded-control bg-well px-space-md text-ink outline-none focus-visible:ring-2',
              nameTooLong ? 'ring-2 ring-loss' : 'focus-visible:ring-violet',
            ]"
          />
          <p v-if="nameTooLong" :id="`${id}-name-hint`" class="text-body-sm text-on-loss-wash">
            {{ t('tags.field.nameTooLong', { max: MAX_TAG_NAME_LENGTH }) }}
          </p>
        </div>
        <fieldset class="flex flex-col gap-space-xs">
          <legend class="mb-space-xs text-label-eyebrow uppercase text-ink-tertiary">
            {{ t('tags.field.color') }}
          </legend>
          <div class="flex flex-wrap gap-x-space-md">
            <label
              v-for="option in TAG_COLORS"
              :key="option"
              class="flex min-h-11 items-center gap-space-sm text-body-md text-ink"
            >
              <input
                v-model="color"
                type="radio"
                name="tag-color"
                :value="option"
                class="size-4 accent-violet"
              />
              <span :class="['size-3 rounded-full', tagDotClass(option)]" aria-hidden="true" />
              {{ t(`tags.color.${option}`) }}
            </label>
          </div>
        </fieldset>
        <div class="flex justify-end gap-space-sm">
          <Button
            type="button"
            :label="t('common.cancel')"
            severity="secondary"
            variant="text"
            :disabled="save.isPending.value"
            @click="editOpen = false"
          />
          <Button
            type="submit"
            data-tag-save
            :label="t('common.save')"
            :loading="save.isPending.value"
            :disabled="!canSave"
          />
        </div>
      </form>
    </Dialog>

    <Dialog
      :visible="deleting !== null"
      modal
      :closable="!remove.isPending.value"
      :close-on-escape="!remove.isPending.value"
      :header="t('tags.delete.title')"
      :style="{ width: 'min(28rem, calc(100vw - 2rem))' }"
      @update:visible="(next) => !next && (deleting = null)"
    >
      <div v-if="deleting" class="flex flex-col gap-space-lg">
        <InlineError v-if="deleteErrorKey" :message="t(deleteErrorKey)" />
        <p class="text-body-md text-ink">
          {{
            t(
              'tags.delete.text',
              { name: deleting.name, count: count(assignments(deleting)) },
              assignments(deleting),
            )
          }}
        </p>
        <div class="flex justify-end gap-space-sm">
          <Button
            type="button"
            :label="t('common.cancel')"
            severity="secondary"
            variant="text"
            :disabled="remove.isPending.value"
            @click="deleting = null"
          />
          <Button
            type="button"
            data-tag-delete
            severity="danger"
            :label="t('tags.delete.confirm')"
            :loading="remove.isPending.value"
            @click="confirmDelete"
          />
        </div>
      </div>
    </Dialog>
  </div>
</template>
