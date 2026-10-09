<script setup lang="ts">
import { formatDateTime, formatNumber } from '@profitbash/shared';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import { computed, nextTick, onMounted, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError } from '../api';
import type {
  AdChangeChannelData,
  AdChangeSubmissionData,
  RevertAdChangesData,
  RevertAdChangesInput,
  SubmittedAdChangeData,
} from '../api/client';
import EmptyState from '../components/common/EmptyState.vue';
import InlineError from '../components/common/InlineError.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import { errorMessageKey } from '../i18n';
import { useSessionStore } from '../stores/session';
import ChangeSummary from './ChangeSummary.vue';
import { downloadBlob } from './download';
import { changeSubject, changeValueText } from './labels';
import {
  useBulkFileDownload,
  useChangeRights,
  useCloseSubmission,
  useDismissChanges,
  useRetryChanges,
  useRevertChanges,
  useSubmission,
  useSubmissions,
} from './queries';

/**
 * Übermittlungen (`phase-3.md` 3.6): Liste der Organisation und eine Übermittlung mit dem Ergebnis je Änderung.
 * Folgeschritte: fehlgeschlagene Änderungen erneut versuchen oder verwerfen, angewendete zurücknehmen (mit Rückfrage,
 * wenn sich der Wert seitdem geändert hat, F8), Bulk-Datei herunterladen und von Hand abschließen (F2).
 */
const props = defineProps<{ submissionId: string | null }>();

const i18n = useI18n();
const { t, te } = i18n;
const id = useId();
const session = useSessionStore();
const locale = computed(() => session.preferences.locale);
const labels = computed(() => ({ t, te, locale: locale.value }));
const { canWrite } = useChangeRights();

const submissions = useSubmissions(computed(() => true));
const list = computed(() => submissions.data.value ?? []);
const selectedId = computed(() => props.submissionId);
const detail = useSubmission(selectedId);
const selected = computed(() => detail.data.value ?? null);
const notFound = computed(
  () => detail.error.value instanceof ApiError && detail.error.value.status === 404,
);

/** Die geöffnete Übermittlung steht unter der Liste: beim Öffnen dorthin springen (vor allem auf dem Handy). */
const detailSection = ref<HTMLElement>();
async function showDetail() {
  if (!selectedId.value) return;
  await nextTick();
  detailSection.value?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  detailSection.value?.focus({ preventScroll: true });
}
watch(selectedId, showDetail);
// Auch nach dem Übermitteln (die Seite wechselt hierher) und bei einem Link auf eine Übermittlung.
onMounted(showDetail);

function statusText(submission: AdChangeSubmissionData): string {
  return submission.status === 'pending'
    ? t(`changes.submission.waiting.${submission.channel}`)
    : t(`changes.submission.status.${submission.status}`);
}
function countTexts(submission: AdChangeSubmissionData): string[] {
  return (['applied', 'failed', 'submitted', 'dismissed'] as const)
    .filter((key) => submission.counts[key] > 0)
    .map((key) =>
      t(`changes.submission.count.${key}`, {
        count: formatNumber(String(submission.counts[key]), locale.value),
      }),
    );
}
const detailLink = (submissionId: string) => ({
  path: '/ads/changes',
  query: { tab: 'submissions', submission: submissionId },
});

// --- Folgeschritte ---------------------------------------------------------------------------

const retry = useRetryChanges();
const dismiss = useDismissChanges();
const revert = useRevertChanges();
const close = useCloseSubmission();
const download = useBulkFileDownload();
const busy = computed(
  () =>
    retry.isPending.value ||
    dismiss.isPending.value ||
    revert.isPending.value ||
    close.isPending.value ||
    download.isPending.value,
);

interface Notice {
  text: string;
  /** Die neue Übermittlung eines Folgeschritts. */
  submissionId: string | null;
  details: string[];
}
const notice = ref<Notice | null>(null);
const errorText = ref<string | null>(null);
const conflict = ref<{
  request: RevertAdChangesInput;
  conflicts: Extract<RevertAdChangesData, { status: 'conflict' }>['conflicts'];
} | null>(null);

/** Weg für erneute Versuche und Reverts: Standard ist der Weg der Übermittlung. */
const followUpChannel = ref<AdChangeChannelData>('api');
watch(
  () => selected.value?.submission.id,
  () => {
    if (selected.value) followUpChannel.value = selected.value.submission.channel;
    notice.value = null;
    errorText.value = null;
  },
  { immediate: true },
);

const skipReason = (reason: string) =>
  t(te(`changes.skip.${reason}`) ? `changes.skip.${reason}` : `changes.rejection.${reason}`);
function skippedTexts(skipped: { reason: string }[]): string[] {
  const byReason = new Map<string, number>();
  for (const item of skipped) byReason.set(item.reason, (byReason.get(item.reason) ?? 0) + 1);
  return [...byReason].map(([reason, count]) =>
    t('changes.action.skipped', { count, reason: skipReason(reason) }),
  );
}
function followUpNotice(result: {
  submissions: AdChangeSubmissionData[];
  skipped: { reason: string }[];
  bulkFileSkipped: { message: string }[];
}): Notice {
  const created = result.submissions[0] ?? null;
  return {
    text: created
      ? t(`changes.action.created.${created.channel}`)
      : t('changes.action.nothingCreated'),
    submissionId: created?.id ?? null,
    details: [
      ...skippedTexts(result.skipped),
      ...result.bulkFileSkipped.map((item) => t('changes.action.bulkFileSkipped', item)),
    ],
  };
}

async function run(action: () => Promise<Notice | null>) {
  if (busy.value) return;
  errorText.value = null;
  notice.value = null;
  try {
    notice.value = await action();
  } catch (error) {
    // Eine offene Rückfrage verdeckte die Meldung sonst.
    conflict.value = null;
    closing.value = null;
    errorText.value = t(errorMessageKey(error instanceof ApiError ? error.code : 'UNKNOWN'));
  }
}

const retryChange = (change: SubmittedAdChangeData) =>
  run(async () =>
    followUpNotice(
      await retry.mutateAsync({ changeIds: [change.id], channel: followUpChannel.value }),
    ),
  );
const dismissChange = (change: SubmittedAdChangeData) =>
  run(async () => {
    await dismiss.mutateAsync([change.id]);
    return { text: t('changes.action.dismissed'), submissionId: null, details: [] };
  });

function sendRevert(request: RevertAdChangesInput) {
  return run(async () => {
    const result = await revert.mutateAsync(request);
    if (result.status === 'conflict') {
      conflict.value = { request, conflicts: result.conflicts };
      return null;
    }
    conflict.value = null;
    return followUpNotice(result);
  });
}
const revertChange = (change: SubmittedAdChangeData) =>
  sendRevert({ changeIds: [change.id], channel: followUpChannel.value });
const revertAll = () =>
  selected.value &&
  sendRevert({ submissionId: selected.value.submission.id, channel: followUpChannel.value });

/** Abschließen von Hand ist endgültig (verworfen bzw. als angewendet in die Entities geschrieben): mit Rückfrage. */
const closing = ref<'applied' | 'discarded' | null>(null);
const openCount = computed(
  () => (selected.value?.changes ?? []).filter((change) => change.status === 'submitted').length,
);
const closeSubmission = (outcome: 'applied' | 'discarded') =>
  run(async () => {
    await close.mutateAsync({ id: selected.value!.submission.id, outcome });
    closing.value = null;
    return { text: t(`changes.action.closed.${outcome}`), submissionId: null, details: [] };
  });
const downloadFile = () =>
  run(async () => {
    const file = await download.mutateAsync(selected.value!.submission.id);
    downloadBlob(file.fileName, file.blob);
    return null;
  });

// --- Was sich an einer Änderung tun lässt ---------------------------------------------------------

const isBulkFile = computed(() => selected.value?.submission.channel === 'bulk_file');
const openBulkFile = computed(
  () => isBulkFile.value && selected.value?.submission.status === 'pending',
);
/**
 * Ein Folgeschritt sperrt wie beim Server, solange er offen oder angewendet ist. Ist er gescheitert, geht es an ihm
 * weiter (dort „Erneut versuchen“); wurde er verworfen, ist die Änderung wieder frei.
 */
const followUpBlocks = (change: SubmittedAdChangeData, origin: 'retry' | 'revert') =>
  change.followUp?.origin === origin && change.followUp.status !== 'dismissed';
/** Eine überholte Änderung trüge beim erneuten Versuch den älteren Wert über den neueren. */
const canRetry = (change: SubmittedAdChangeData) =>
  change.status === 'failed' &&
  change.errorCode !== 'SUPERSEDED' &&
  !followUpBlocks(change, 'retry');
const canDismiss = (change: SubmittedAdChangeData) => change.status === 'failed';
/** Archivieren lässt sich bei Amazon nicht zurücknehmen. */
const canRevert = (change: SubmittedAdChangeData) =>
  change.status === 'applied' &&
  !followUpBlocks(change, 'revert') &&
  !(change.field === 'state' && change.after === 'ARCHIVED');
const revertible = computed(() => (selected.value?.changes ?? []).some(canRevert));
const downloadable = computed(
  () =>
    isBulkFile.value &&
    (selected.value?.changes ?? []).some(
      (change) => change.status === 'submitted' || change.status === 'applied',
    ),
);

function changeStatusText(change: SubmittedAdChangeData): string {
  return change.status === 'submitted' && isBulkFile.value
    ? t('changes.change.waitingUpload')
    : t(`changes.change.status.${change.status}`);
}
function errorOf(change: SubmittedAdChangeData): string | null {
  if (change.status !== 'failed' && change.status !== 'dismissed') return null;
  const known = change.errorCode && te(`changes.failure.${change.errorCode}`);
  const message = known ? t(`changes.failure.${change.errorCode}`) : change.errorMessage;
  if (!message) return change.errorCode;
  return known || !change.errorCode ? message : `${message} (${change.errorCode})`;
}
const followUpText = (change: SubmittedAdChangeData) =>
  change.followUp
    ? t(`changes.followUp.${change.followUp.origin}`, {
        status: t(`changes.followUp.status.${change.followUp.status}`),
      })
    : null;

const conflictRows = computed(() =>
  (conflict.value?.conflicts ?? []).map((item) => {
    const change = selected.value?.changes.find((c) => c.id === item.changeId);
    const value = (text: string | null) =>
      changeValueText(change?.field ?? null, text, change?.currencyCode ?? null, labels.value);
    return {
      id: item.changeId,
      name: change ? changeSubject(change, labels.value).name : t('explorer.unknownName'),
      text: t('changes.conflict.values', {
        expected: value(item.expected),
        current: value(item.current),
      }),
    };
  }),
);
</script>

<template>
  <section class="flex flex-col gap-gutter" :aria-label="t('changes.tab.submissions')">
    <InlineError
      v-if="submissions.isError.value && !submissions.data.value"
      :message="t('changes.submission.loadFailed')"
      retryable
      :retrying="submissions.isFetching.value"
      @retry="submissions.refetch()"
    />
    <div v-else-if="!submissions.data.value" class="flex flex-col gap-space-sm" aria-busy="true">
      <SkeletonBlock v-for="n in 4" :key="n" height="3rem" />
    </div>
    <EmptyState
      v-else-if="list.length === 0 && !submissionId"
      icon="send"
      :title="t('changes.submission.empty.title')"
      :text="t('changes.submission.empty.text')"
    />
    <section
      v-else-if="list.length > 0"
      class="flex min-w-0 flex-col gap-space-sm rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg"
    >
      <h2 class="text-headline-sm text-ink">{{ t('changes.submission.listTitle') }}</h2>
      <ul class="flex flex-col">
        <li
          v-for="submission in list"
          :key="submission.id"
          :data-submission="submission.id"
          :class="[
            'grid grid-cols-1 gap-space-xs rounded-control px-space-sm py-space-md sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1.3fr)_minmax(0,1.6fr)_auto] sm:items-center sm:gap-space-md',
            submission.id === submissionId ? 'bg-violet-wash' : 'odd:bg-well',
          ]"
        >
          <div class="flex min-w-0 flex-col">
            <p class="font-data text-body-sm text-ink">
              {{ formatDateTime(submission.createdAt, locale) }}
            </p>
            <p class="truncate text-body-sm text-ink-secondary">
              {{ submission.createdByName ?? t('changes.submission.unknownUser') }}
            </p>
          </div>
          <div class="flex min-w-0 flex-col">
            <p class="truncate text-body-md font-semibold text-ink">
              {{ submission.accountName }} · {{ submission.countryCode }}
            </p>
            <p class="text-body-sm text-ink-secondary">
              {{ t(`changes.channel.${submission.channel}`) }}
            </p>
          </div>
          <div class="flex min-w-0 flex-col">
            <p class="text-body-md text-ink">{{ statusText(submission) }}</p>
            <p class="font-data text-body-sm text-ink-secondary">
              {{ countTexts(submission).join(' · ') }}
            </p>
          </div>
          <RouterLink
            data-open
            :to="detailLink(submission.id)"
            :aria-current="submission.id === submissionId ? 'true' : undefined"
            class="flex min-h-11 items-center rounded-control px-space-md text-body-sm font-semibold text-violet outline-none hover:bg-violet-wash focus-visible:ring-2 focus-visible:ring-violet"
          >
            {{ t('changes.submission.open') }}
          </RouterLink>
        </li>
      </ul>
    </section>

    <section
      v-if="submissionId"
      ref="detailSection"
      tabindex="-1"
      :aria-label="t('changes.submission.detailLabel')"
      data-submission-detail
      class="flex min-w-0 flex-col gap-space-md rounded-tile bg-tile p-space-md shadow-tile outline-none sm:p-space-lg"
    >
      <InlineError v-if="notFound" :message="t('changes.submission.notFound')" />
      <InlineError
        v-else-if="detail.isError.value && !selected"
        :message="t('changes.submission.detailFailed')"
        retryable
        :retrying="detail.isFetching.value"
        @retry="detail.refetch()"
      />
      <div v-else-if="!selected" class="flex flex-col gap-space-sm" aria-busy="true">
        <SkeletonBlock width="16rem" height="1.75rem" />
        <SkeletonBlock v-for="n in 3" :key="n" height="3rem" />
      </div>

      <template v-else>
        <header class="flex flex-wrap items-start justify-between gap-space-md">
          <div class="flex min-w-0 flex-col gap-space-xs">
            <p class="text-label-eyebrow uppercase text-ink-tertiary">
              {{ t(`changes.channel.${selected.submission.channel}`) }} ·
              {{ statusText(selected.submission) }}
            </p>
            <h2 class="text-headline-sm text-ink">
              {{ selected.submission.accountName }} · {{ selected.submission.countryCode }}
            </h2>
            <p class="font-data text-body-sm text-ink-secondary">
              {{ formatDateTime(selected.submission.createdAt, locale) }} ·
              {{ selected.submission.createdByName ?? t('changes.submission.unknownUser') }}
            </p>
          </div>
          <div v-if="canWrite" class="flex flex-wrap items-end gap-space-sm">
            <div class="flex flex-col gap-space-xs">
              <label :for="`${id}-channel`" class="text-label-eyebrow uppercase text-ink-tertiary">
                {{ t('changes.action.channel') }}
              </label>
              <select
                :id="`${id}-channel`"
                v-model="followUpChannel"
                data-followup-channel
                class="h-9 rounded-control bg-well px-space-sm text-body-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-violet"
              >
                <option value="api">{{ t('changes.channel.api') }}</option>
                <option value="bulk_file">{{ t('changes.channel.bulk_file') }}</option>
              </select>
            </div>
            <Button
              v-if="downloadable"
              data-download
              :label="t('changes.action.download')"
              icon="pi pi-download"
              size="small"
              :loading="download.isPending.value"
              :disabled="busy"
              @click="downloadFile"
            />
            <Button
              v-if="openBulkFile"
              data-close="applied"
              :label="t('changes.action.closeApplied')"
              severity="secondary"
              size="small"
              :disabled="busy"
              @click="closing = 'applied'"
            />
            <Button
              v-if="openBulkFile"
              data-close="discarded"
              :label="t('changes.action.closeDiscarded')"
              severity="secondary"
              variant="text"
              size="small"
              :disabled="busy"
              @click="closing = 'discarded'"
            />
            <Button
              v-if="revertible"
              data-revert-all
              :label="t('changes.action.revertAll')"
              icon="pi pi-undo"
              severity="secondary"
              size="small"
              :disabled="busy"
              @click="revertAll"
            />
          </div>
        </header>

        <!-- `error` nennt bei wartenden Übermittlungen den Grund des Wartens (z. B. Drosselung), sonst den Fehler. -->
        <p
          v-if="selected.submission.error && selected.submission.status !== 'failed'"
          role="status"
          class="rounded-control bg-well px-space-md py-space-sm text-body-sm text-ink"
        >
          <i class="pi pi-clock mr-space-xs text-warn" aria-hidden="true" />{{
            selected.submission.error
          }}
        </p>
        <InlineError v-else-if="selected.submission.error" :message="selected.submission.error" />
        <p
          v-if="isBulkFile"
          class="rounded-control bg-well px-space-md py-space-sm text-body-sm text-ink"
        >
          <i class="pi pi-info-circle mr-space-xs text-warn" aria-hidden="true" />{{
            selected.entitiesSyncedAt
              ? t('changes.submission.entitiesSyncedAt', {
                  date: formatDateTime(selected.entitiesSyncedAt, locale),
                })
              : t('changes.submission.entitiesNeverSynced')
          }}
          <template v-if="openBulkFile"> {{ t('changes.submission.bulkFileHint') }}</template>
        </p>
        <InlineError v-if="errorText" :message="errorText" />
        <div
          v-if="notice"
          data-action-notice
          role="status"
          class="flex flex-col gap-space-xs rounded-control bg-violet-wash px-space-md py-space-sm text-body-sm text-ink"
        >
          <p class="font-semibold">
            {{ notice.text }}
            <RouterLink
              v-if="notice.submissionId"
              :to="detailLink(notice.submissionId)"
              class="ml-space-xs text-violet hover:underline"
              >{{ t('changes.action.openCreated') }}</RouterLink
            >
          </p>
          <p v-for="line in notice.details" :key="line">{{ line }}</p>
        </div>

        <ul class="flex flex-col">
          <li
            v-for="change in selected.changes"
            :key="change.id"
            :data-change="change.id"
            class="grid grid-cols-1 gap-space-sm rounded-control px-space-sm py-space-md odd:bg-well sm:grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)_minmax(0,1.6fr)_auto] sm:items-center sm:gap-space-md"
          >
            <ChangeSummary :change="change" />
            <div class="flex min-w-0 flex-col gap-0.5 text-body-sm">
              <p
                :class="[
                  'font-semibold',
                  change.status === 'applied'
                    ? 'text-lime-deep'
                    : change.status === 'failed'
                      ? 'text-on-loss-wash'
                      : 'text-ink',
                ]"
              >
                {{ changeStatusText(change) }}
              </p>
              <p v-if="errorOf(change)" class="break-words text-ink-secondary">
                {{ errorOf(change) }}
              </p>
              <p v-if="change.followUp" class="text-ink-secondary">
                <RouterLink
                  v-if="change.followUp.submissionId"
                  :to="detailLink(change.followUp.submissionId)"
                  class="text-violet hover:underline"
                  >{{ followUpText(change) }}</RouterLink
                >
                <template v-else>{{ followUpText(change) }}</template>
              </p>
            </div>
            <div v-if="canWrite" class="flex flex-wrap gap-space-xs">
              <Button
                v-if="canRetry(change)"
                data-retry
                :label="t('changes.action.retry')"
                severity="secondary"
                size="small"
                :disabled="busy"
                @click="retryChange(change)"
              />
              <Button
                v-if="canDismiss(change)"
                data-dismiss
                :label="t('changes.action.dismiss')"
                severity="secondary"
                variant="text"
                size="small"
                :disabled="busy"
                @click="dismissChange(change)"
              />
              <Button
                v-if="canRevert(change)"
                data-revert
                :label="t('changes.action.revert')"
                severity="secondary"
                variant="text"
                size="small"
                :disabled="busy"
                @click="revertChange(change)"
              />
            </div>
          </li>
        </ul>
      </template>
    </section>

    <Dialog
      :visible="closing !== null"
      modal
      :closable="!close.isPending.value"
      :header="closing ? t(`changes.close.title.${closing}`) : ''"
      :style="{ width: 'min(30rem, calc(100vw - 2rem))' }"
      @update:visible="(next) => !next && (closing = null)"
    >
      <div v-if="closing" class="flex flex-col gap-space-lg">
        <p class="text-body-md text-ink">
          {{ t(`changes.close.text.${closing}`, { count: openCount }, openCount) }}
        </p>
        <div class="flex justify-end gap-space-sm">
          <Button
            type="button"
            :label="t('common.cancel')"
            severity="secondary"
            variant="text"
            :disabled="close.isPending.value"
            @click="closing = null"
          />
          <Button
            type="button"
            data-confirm-close
            :label="t(`changes.close.confirm.${closing}`)"
            :severity="closing === 'discarded' ? 'danger' : undefined"
            :loading="close.isPending.value"
            @click="closeSubmission(closing)"
          />
        </div>
      </div>
    </Dialog>

    <Dialog
      :visible="conflict !== null"
      modal
      :closable="!revert.isPending.value"
      :header="t('changes.conflict.title')"
      :style="{ width: 'min(34rem, calc(100vw - 2rem))' }"
      @update:visible="(next) => !next && (conflict = null)"
    >
      <div v-if="conflict" class="flex flex-col gap-space-lg">
        <p class="text-body-md text-ink">{{ t('changes.conflict.text') }}</p>
        <ul class="flex max-h-64 flex-col gap-space-sm overflow-y-auto">
          <li v-for="row in conflictRows" :key="row.id" class="flex flex-col text-body-sm">
            <span class="font-semibold text-ink">{{ row.name }}</span>
            <span class="font-data text-ink-secondary">{{ row.text }}</span>
          </li>
        </ul>
        <div class="flex justify-end gap-space-sm">
          <Button
            type="button"
            :label="t('common.cancel')"
            severity="secondary"
            variant="text"
            :disabled="revert.isPending.value"
            @click="conflict = null"
          />
          <Button
            type="button"
            data-confirm-overwrite
            :label="t('changes.conflict.confirm')"
            severity="danger"
            :loading="revert.isPending.value"
            @click="sendRevert({ ...conflict.request, overwriteChanged: true })"
          />
        </div>
      </div>
    </Dialog>
  </section>
</template>
