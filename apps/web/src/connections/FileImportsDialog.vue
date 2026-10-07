<script setup lang="ts">
import {
  FILE_IMPORT_MAX_BYTES,
  formatDateTime,
  formatNumber,
  type FileImport,
  type FileImportKind,
  type Profile,
} from '@profitbash/shared';
import Button from 'primevue/button';
import Checkbox from 'primevue/checkbox';
import Dialog from 'primevue/dialog';
import Select from 'primevue/select';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError } from '../api';
import InlineError from '../components/common/InlineError.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import { errorMessageKey } from '../i18n';
import { useSessionStore } from '../stores/session';
import { useJobRunLabels } from '../sync/labels';
import { isOpenFileImport, useFileImportsQuery, useUploadFileImport } from './queries';
import { useFileStalenessHints } from './staleness';

/**
 * Upload und Verlauf der Datei-Importe eines Profils ohne Connection (`phase-1.md` 1.11f). Den Import macht der
 * Job `file-import` im Hintergrund; der Verlauf fragt nach, solange eine Datei wartet oder läuft.
 */
const props = defineProps<{ profile: Profile | null }>();
const emit = defineEmits<{
  close: [];
  /** Datei angenommen; die Karte verfolgt den Import weiter, auch wenn der Dialog schließt. */
  uploaded: [profileId: string, importId: string];
  /** Eine im Verlauf laufende Datei ist fertig: Profile neu laden. */
  finished: [];
}>();

const { t } = useI18n();
const session = useSessionStore();
const labels = useJobRunLabels();

const profileId = computed(() => props.profile?.id ?? null);
const importsQuery = useFileImportsQuery(profileId);
const upload = useUploadFileImport();

const kind = ref<FileImportKind>('bulk');
const file = ref<File | null>(null);
const complete = ref(false);
const errorKey = ref<string | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

watch(profileId, () => {
  kind.value = 'bulk';
  file.value = null;
  complete.value = false;
  errorKey.value = null;
  upload.reset();
});

// Tagesberichte importiert erst 1.11e; bis dahin sichtbar, aber nicht wählbar.
const kindOptions = computed(() => [
  { value: 'bulk', label: t('connections.fileImports.kind.bulk'), disabled: false },
  {
    value: 'daily_report',
    label: t('connections.fileImports.kind.daily_reportPending'),
    disabled: true,
  },
]);

const title = computed(() =>
  props.profile
    ? t('connections.fileImports.title', {
        account: props.profile.accountName,
        country: props.profile.countryCode,
      })
    : '',
);

const staleHints = useFileStalenessHints(() => props.profile);

/** Größte Datei für Hinweis und Fehlertext (aus `FILE_IMPORT_MAX_BYTES`). */
const maxSize = computed(
  () => `${formatNumber(FILE_IMPORT_MAX_BYTES / (1024 * 1024), session.preferences.locale)} MB`,
);

const removed = computed(() => Boolean(props.profile?.removedAt));
const imports = computed(() => importsQuery.data.value ?? []);

// Dateien, die im Verlauf als wartend oder laufend zu sehen waren; endet eine, ändern sich „Letzter Import“ und die
// Hinweise am Profil. Je ID, damit ein leerer Verlauf (Dialog geschlossen) nichts auslöst.
const seenOpen = new Set<string>();
watch(imports, (list) => {
  let finished = false;
  for (const fileImport of list) {
    if (isOpenFileImport(fileImport)) seenOpen.add(fileImport.id);
    else if (seenOpen.delete(fileImport.id)) finished = true;
  }
  if (finished) emit('finished');
});

function onFileChange(event: Event) {
  const target = event.target as HTMLInputElement;
  file.value = target.files?.[0] ?? null;
  errorKey.value = null;
  upload.reset();
}

async function submit() {
  if (!props.profile) return;
  if (!file.value) {
    errorKey.value = 'connections.fileImports.upload.required';
    return;
  }
  if (file.value.size > FILE_IMPORT_MAX_BYTES) {
    errorKey.value = errorMessageKey('FILE_TOO_LARGE');
    return;
  }
  errorKey.value = null;
  try {
    const created = await upload.mutateAsync({
      profileId: props.profile.id,
      kind: kind.value,
      file: file.value,
      complete: kind.value === 'bulk' && complete.value,
    });
    emit('uploaded', created.profileId, created.id);
    file.value = null;
    complete.value = false;
    if (fileInput.value) fileInput.value.value = '';
  } catch (error) {
    errorKey.value = errorMessageKey(error instanceof ApiError ? error.code : 'UNKNOWN');
  }
}

const STATUS_DOT = {
  pending: 'bg-ink-tertiary',
  running: 'bg-violet animate-pulse',
  imported: 'bg-lime',
  failed: 'bg-loss',
} as const;

function result(fileImport: FileImport) {
  return labels.counterParts(fileImport);
}
</script>

<template>
  <Dialog
    :visible="profile !== null"
    modal
    :closable="!upload.isPending.value"
    :close-on-escape="!upload.isPending.value"
    :header="title"
    :style="{ width: 'min(56rem, calc(100vw - 2rem))' }"
    @update:visible="(value) => !value && emit('close')"
  >
    <div class="flex flex-col gap-space-lg">
      <ul
        v-if="staleHints.length > 0"
        class="flex flex-col gap-space-xs rounded-control bg-well px-space-md py-space-sm text-body-sm text-ink"
      >
        <li v-for="hint in staleHints" :key="hint" class="flex items-start gap-space-sm">
          <i class="pi pi-exclamation-triangle mt-0.5 text-warn" aria-hidden="true" />
          {{ hint }}
        </li>
      </ul>

      <section class="flex flex-col gap-space-md" aria-labelledby="file-import-upload-title">
        <h3 id="file-import-upload-title" class="text-body-md font-semibold text-ink">
          {{ t('connections.fileImports.upload.title') }}
        </h3>
        <p v-if="removed" class="text-body-sm text-ink-secondary">
          {{ t('connections.fileImports.upload.removedProfile') }}
        </p>
        <form v-else class="flex flex-col gap-space-md" novalidate @submit.prevent="submit">
          <InlineError v-if="errorKey" :message="t(errorKey, { size: maxSize })" />
          <p
            v-if="upload.isSuccess.value"
            role="status"
            class="rounded-control bg-violet-wash px-space-md py-space-sm text-body-sm text-ink"
          >
            {{ t('connections.fileImports.upload.accepted') }}
          </p>
          <div class="grid gap-space-md md:grid-cols-2">
            <div class="flex flex-col gap-space-sm">
              <label id="file-import-kind-label" class="text-body-sm font-semibold text-ink">
                {{ t('connections.fileImports.upload.kind') }}
              </label>
              <Select
                v-model="kind"
                :options="kindOptions"
                option-label="label"
                option-value="value"
                option-disabled="disabled"
                aria-labelledby="file-import-kind-label"
                fluid
              />
            </div>
            <div class="flex flex-col gap-space-sm">
              <label for="file-import-file" class="text-body-sm font-semibold text-ink">
                {{ t('connections.fileImports.upload.file') }}
              </label>
              <input
                id="file-import-file"
                ref="fileInput"
                type="file"
                :accept="kind === 'bulk' ? '.xlsx' : '.xlsx,.csv'"
                aria-describedby="file-import-file-hint"
                class="rounded-control border border-outline bg-tile px-space-sm py-space-xs text-body-sm text-ink file:mr-space-sm file:rounded-control file:border-0 file:bg-well file:px-space-sm file:py-space-xs file:text-ink"
                @change="onFileChange"
              />
              <p id="file-import-file-hint" class="text-body-sm text-ink-secondary">
                {{ t('connections.fileImports.upload.fileHint', { size: maxSize }) }}
              </p>
            </div>
          </div>
          <div v-if="kind === 'bulk'" class="flex flex-col gap-space-xs">
            <div class="flex items-center gap-space-sm">
              <Checkbox
                v-model="complete"
                input-id="file-import-complete"
                binary
                aria-describedby="file-import-complete-hint"
              />
              <label for="file-import-complete" class="text-body-sm font-semibold text-ink">
                {{ t('connections.fileImports.upload.complete') }}
              </label>
            </div>
            <p
              id="file-import-complete-hint"
              class="flex items-start gap-space-sm text-body-sm text-ink-secondary"
            >
              <i class="pi pi-info-circle mt-0.5" aria-hidden="true" />
              {{ t('connections.fileImports.upload.completeHint') }}
            </p>
          </div>
          <div class="flex justify-end">
            <Button
              type="submit"
              :label="t('connections.fileImports.upload.submit')"
              icon="pi pi-upload"
              :loading="upload.isPending.value"
            />
          </div>
        </form>
      </section>

      <section class="flex flex-col gap-space-md" aria-labelledby="file-import-history-title">
        <h3 id="file-import-history-title" class="text-body-md font-semibold text-ink">
          {{ t('connections.fileImports.history.title') }}
        </h3>
        <div
          v-if="importsQuery.isPending.value"
          class="flex flex-col gap-space-sm"
          aria-busy="true"
        >
          <SkeletonBlock v-for="n in 3" :key="n" height="2.5rem" />
        </div>
        <InlineError
          v-else-if="importsQuery.isError.value"
          :message="t('connections.fileImports.history.loadError')"
          retryable
          :retrying="importsQuery.isFetching.value"
          @retry="importsQuery.refetch()"
        />
        <p v-else-if="imports.length === 0" class="text-body-md text-ink-secondary">
          {{ t('connections.fileImports.history.empty') }}
        </p>
        <div v-else class="overflow-x-auto">
          <table class="w-full min-w-[40rem] border-collapse text-left text-body-sm">
            <thead>
              <tr class="border-b border-line text-ink-secondary">
                <th scope="col" class="py-space-xs pr-space-md font-semibold">
                  {{ t('connections.fileImports.history.uploadedAt') }}
                </th>
                <th scope="col" class="py-space-xs pr-space-md font-semibold">
                  {{ t('connections.fileImports.history.file') }}
                </th>
                <th scope="col" class="py-space-xs pr-space-md font-semibold">
                  {{ t('connections.fileImports.history.status') }}
                </th>
                <th scope="col" class="py-space-xs font-semibold">
                  {{ t('connections.fileImports.history.result') }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="fileImport in imports"
                :key="fileImport.id"
                class="border-b border-line align-top last:border-b-0"
              >
                <td class="py-space-sm pr-space-md font-data whitespace-nowrap text-ink">
                  {{ formatDateTime(fileImport.createdAt, session.preferences.locale) }}
                </td>
                <td class="py-space-sm pr-space-md text-ink">
                  <span class="break-all">{{ fileImport.fileName }}</span>
                  <span class="block text-ink-secondary">
                    {{ t(`connections.fileImports.kind.${fileImport.kind}`) }}
                    <template v-if="fileImport.complete">
                      · {{ t('connections.fileImports.history.complete') }}
                    </template>
                  </span>
                </td>
                <td class="py-space-sm pr-space-md whitespace-nowrap text-ink">
                  <span class="inline-flex items-center gap-1.5">
                    <span
                      :class="['size-2 shrink-0 rounded-full', STATUS_DOT[fileImport.status]]"
                      aria-hidden="true"
                    />
                    {{ t(`connections.fileImports.status.${fileImport.status}`) }}
                  </span>
                </td>
                <td class="py-space-sm text-ink">
                  <span v-if="fileImport.status === 'imported'">
                    <template v-for="(part, index) in result(fileImport)" :key="part.key">
                      <template v-if="index > 0"> · </template>
                      <span class="font-data">{{ part.value }}</span> {{ part.label }}
                    </template>
                  </span>
                  <span v-if="fileImport.error" class="block text-loss">
                    {{ fileImport.error }}
                  </span>
                  <span
                    v-if="(fileImport.counters.unmatchedCampaigns ?? 0) > 0"
                    class="mt-space-xs flex items-start gap-space-sm text-ink"
                  >
                    <i class="pi pi-exclamation-triangle mt-0.5 text-warn" aria-hidden="true" />
                    {{ t('connections.fileImports.history.unmatched') }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  </Dialog>
</template>
