<script setup lang="ts">
import { formatNumber, MAX_AD_CHANGES_PER_REQUEST } from '@profitbash/shared';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError } from '../api';
import type {
  AdChangeChannelData,
  AdChangeCheckData,
  PendingAdChangeData,
  SubmitAdChangesData,
} from '../api/client';
import EmptyState from '../components/common/EmptyState.vue';
import InlineError from '../components/common/InlineError.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import { errorMessageKey } from '../i18n';
import { useSessionStore } from '../stores/session';
import ChangeSummary from './ChangeSummary.vue';
import { changeSubject, changeValueText } from './labels';
import { useChangeRights, useDiscardChanges, usePendingChanges, useSubmitChanges } from './queries';

/**
 * Ausstehend (`phase-3.md` 3.6): der eigene Warenkorb je Profil (eine Übermittlung gilt je Profil), mit den
 * Prüfungen des Servers. Verstöße gegen Grenzen von Amazon sperren das Übermitteln des Profils; Warnungen nach F6
 * werden beim Übermitteln bestätigt. Übermittelt werden genau die gezeigten Änderungen (`changeIds`), damit die
 * Bestätigung nichts deckt, was inzwischen dazukam.
 */
export type Submitted = Extract<SubmitAdChangesData, { status: 'submitted' }>;
const emit = defineEmits<{ submitted: [result: Submitted] }>();

const i18n = useI18n();
const { t } = i18n;
const session = useSessionStore();
const locale = computed(() => session.preferences.locale);
const labels = computed(() => ({ t, te: i18n.te, locale: locale.value }));
const { canWrite } = useChangeRights();

const pending = usePendingChanges();
const changes = computed(() => pending.data.value?.changes ?? []);
const check = computed(() => pending.data.value?.check ?? null);

interface Group {
  profileId: string;
  title: string;
  changes: PendingAdChangeData[];
  blocked: boolean;
}
const violations = computed(
  () =>
    new Map((check.value?.violations ?? []).map((violation) => [violation.changeId, violation])),
);
const largeChanges = computed(
  () => new Map((check.value?.largeChanges ?? []).map((large) => [large.changeId, large])),
);
const groups = computed<Group[]>(() => {
  const byProfile = new Map<string, Group>();
  for (const change of changes.value) {
    const group = byProfile.get(change.profileId) ?? {
      profileId: change.profileId,
      title: `${change.accountName} · ${change.countryCode}`,
      changes: [],
      blocked: false,
    };
    group.changes.push(change);
    group.blocked ||= violations.value.has(change.id);
    byProfile.set(change.profileId, group);
  }
  return [...byProfile.values()].sort((a, b) => a.title.localeCompare(b.title, locale.value));
});

// --- Hinweise je Änderung --------------------------------------------------------------------

function violationText(change: PendingAdChangeData): string | null {
  const violation = violations.value.get(change.id);
  if (!violation) return null;
  if (violation.code === 'tooLong' || violation.code === 'tooManyWords') {
    return t(`changes.violation.${violation.code}`, { max: violation.max });
  }
  const limit = violation.code === 'belowMinimum' ? violation.min : violation.max;
  return t(`changes.violation.${violation.code}`, {
    limit: changeValueText(change.field, String(limit), change.currencyCode, labels.value),
  });
}

/** „+60 %“ bzw. „−50,05 %“; ohne „vorher“ steht dabei, womit verglichen wurde (Standardgebot der Ad Group). */
function largeChangeText(change: PendingAdChangeData): string | null {
  const large = largeChanges.value.get(change.id);
  if (!large) return null;
  const negative = large.changePercent.startsWith('-');
  const percent = `${negative ? '−' : '+'}${formatNumber(large.changePercent.replace('-', ''), locale.value)}`;
  return change.before === null && change.comparisonBefore !== null
    ? t('changes.pending.largeChangeDefaultBid', {
        percent,
        value: changeValueText(
          change.field,
          change.comparisonBefore,
          change.currencyCode,
          labels.value,
        ),
      })
    : t('changes.pending.largeChange', { percent });
}

// --- Übermitteln -----------------------------------------------------------------------------

const submit = useSubmitChanges();
const discard = useDiscardChanges();
const busy = computed(() => submit.isPending.value || discard.isPending.value);
const errorText = ref<string | null>(null);
/** Rückfrage nach F6: Warnungen des Servers und die Anfrage, die mit Bestätigung erneut gesendet wird. */
const confirmation = ref<{
  check: AdChangeCheckData;
  request: { channel: AdChangeChannelData; profileId?: string; changeIds?: string[] };
} | null>(null);
const discardAllOpen = ref(false);

const apiError = (error: unknown) =>
  t(errorMessageKey(error instanceof ApiError ? error.code : 'UNKNOWN'));

async function send(
  request: { channel: AdChangeChannelData; profileId?: string; changeIds?: string[] },
  confirmWarnings = false,
) {
  errorText.value = null;
  try {
    const result = await submit.mutateAsync({
      ...request,
      ...(confirmWarnings && { confirmWarnings: true }),
    });
    confirmation.value = null;
    if (result.status === 'submitted') emit('submitted', result);
    else if (result.status === 'needsConfirmation') {
      confirmation.value = { check: result.check, request };
    } else errorText.value = t('changes.pending.limitsExceeded');
  } catch (error) {
    confirmation.value = null;
    errorText.value = apiError(error);
  }
}

function submitGroup(group: Group, channel: AdChangeChannelData) {
  if (busy.value || group.blocked) return;
  const changeIds = group.changes.map((change) => change.id);
  // Die gezeigten Änderungen; mehr als eine Anfrage fasst (selten): das ganze Profil.
  void send(
    changeIds.length <= MAX_AD_CHANGES_PER_REQUEST
      ? { channel, changeIds }
      : { channel, profileId: group.profileId },
  );
}

async function discardChanges(changeIds?: string[]) {
  errorText.value = null;
  try {
    await discard.mutateAsync(changeIds);
  } catch (error) {
    errorText.value = apiError(error);
  } finally {
    discardAllOpen.value = false;
  }
}
</script>

<template>
  <section class="flex flex-col gap-gutter" :aria-label="t('changes.tab.pending')">
    <InlineError
      v-if="pending.isError.value && !pending.data.value"
      :message="t('changes.pending.loadFailed')"
      retryable
      :retrying="pending.isFetching.value"
      @retry="pending.refetch()"
    />
    <div v-else-if="!pending.data.value" class="flex flex-col gap-space-sm" aria-busy="true">
      <SkeletonBlock shape="tile" height="10rem" />
      <SkeletonBlock shape="tile" height="10rem" />
    </div>
    <EmptyState
      v-else-if="changes.length === 0"
      icon="inbox"
      :title="t('changes.pending.empty.title')"
      :text="t('changes.pending.empty.text')"
    >
      <RouterLink
        to="/ads/explorer"
        class="rounded-control px-space-md py-space-sm text-body-md font-semibold text-violet outline-none hover:bg-violet-wash focus-visible:ring-2 focus-visible:ring-violet"
      >
        {{ t('changes.pending.empty.action') }}
      </RouterLink>
    </EmptyState>

    <template v-else>
      <InlineError v-if="errorText" :message="errorText" />
      <p
        v-if="check?.tooMany"
        role="status"
        class="rounded-control bg-well px-space-md py-space-sm text-body-sm text-ink"
      >
        <i class="pi pi-info-circle mr-space-xs text-warn" aria-hidden="true" />{{
          t('changes.pending.tooMany', {
            count: formatNumber(String(check.tooMany.count), locale),
            limit: formatNumber(String(check.tooMany.limit), locale),
          })
        }}
      </p>
      <div class="flex flex-wrap items-center justify-between gap-space-md">
        <p class="font-data text-body-sm text-ink-secondary">
          {{
            t(
              'changes.pending.count',
              { count: formatNumber(String(changes.length), locale) },
              changes.length,
            )
          }}
        </p>
        <Button
          v-if="canWrite"
          data-discard-all
          :label="t('changes.pending.discardAll')"
          icon="pi pi-trash"
          severity="secondary"
          variant="text"
          size="small"
          :disabled="busy"
          @click="discardAllOpen = true"
        />
      </div>

      <section
        v-for="group in groups"
        :key="group.profileId"
        :data-profile="group.profileId"
        class="flex min-w-0 flex-col gap-space-md rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg"
      >
        <header class="flex flex-wrap items-center justify-between gap-space-md">
          <div class="flex min-w-0 flex-col">
            <h2 class="text-headline-sm text-ink">{{ group.title }}</h2>
            <p class="font-data text-body-sm text-ink-secondary">
              {{
                t(
                  'changes.pending.count',
                  { count: formatNumber(String(group.changes.length), locale) },
                  group.changes.length,
                )
              }}
            </p>
          </div>
          <div v-if="canWrite" class="flex flex-wrap gap-space-sm">
            <Button
              data-submit="bulk_file"
              :label="t('changes.pending.submitBulkFile')"
              icon="pi pi-file-excel"
              severity="secondary"
              size="small"
              :disabled="busy || group.blocked"
              @click="submitGroup(group, 'bulk_file')"
            />
            <Button
              data-submit="api"
              :label="t('changes.pending.submitApi')"
              icon="pi pi-send"
              size="small"
              :disabled="busy || group.blocked"
              @click="submitGroup(group, 'api')"
            />
          </div>
        </header>
        <p v-if="group.blocked" class="text-body-sm text-on-loss-wash">
          <i class="pi pi-exclamation-triangle mr-space-xs" aria-hidden="true" />{{
            t('changes.pending.blocked')
          }}
        </p>

        <ul class="flex flex-col">
          <li
            v-for="change in group.changes"
            :key="change.id"
            :data-change="change.id"
            class="grid grid-cols-1 gap-space-sm rounded-control px-space-sm py-space-md odd:bg-well sm:grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)_minmax(0,1.6fr)_auto] sm:items-center sm:gap-space-md"
          >
            <ChangeSummary :change="change" />
            <div class="flex min-w-0 flex-col gap-space-xs text-body-sm">
              <p v-if="violationText(change)" class="text-on-loss-wash">
                <i class="pi pi-ban mr-space-xs" aria-hidden="true" />{{ violationText(change) }}
              </p>
              <p v-if="largeChangeText(change)" class="text-ink">
                <i class="pi pi-exclamation-triangle mr-space-xs text-warn" aria-hidden="true" />{{
                  largeChangeText(change)
                }}
              </p>
              <p v-if="change.otherUsers.length" class="text-ink-secondary">
                <i class="pi pi-users mr-space-xs" aria-hidden="true" />{{
                  t('changes.pending.otherUsers', {
                    names: change.otherUsers.map((user) => user.name).join(', '),
                  })
                }}
              </p>
            </div>
            <Button
              v-if="canWrite"
              data-discard
              icon="pi pi-times"
              severity="secondary"
              variant="text"
              size="small"
              :aria-label="
                t('changes.pending.discardOne', { name: changeSubject(change, labels).name })
              "
              :disabled="busy"
              @click="discardChanges([change.id])"
            />
          </li>
        </ul>
      </section>
    </template>

    <Dialog
      :visible="confirmation !== null"
      modal
      :closable="!submit.isPending.value"
      :header="t('changes.confirm.title')"
      :style="{ width: 'min(32rem, calc(100vw - 2rem))' }"
      @update:visible="(next) => !next && (confirmation = null)"
    >
      <div v-if="confirmation" class="flex flex-col gap-space-lg">
        <ul class="flex flex-col gap-space-sm text-body-md text-ink">
          <li v-if="confirmation.check.largeChanges.length">
            <i class="pi pi-exclamation-triangle mr-space-xs text-warn" aria-hidden="true" />{{
              t(
                'changes.confirm.largeChanges',
                { count: confirmation.check.largeChanges.length },
                confirmation.check.largeChanges.length,
              )
            }}
          </li>
          <li v-if="confirmation.check.tooMany">
            <i class="pi pi-exclamation-triangle mr-space-xs text-warn" aria-hidden="true" />{{
              t('changes.confirm.tooMany', confirmation.check.tooMany)
            }}
          </li>
        </ul>
        <p class="text-body-sm text-ink-secondary">{{ t('changes.confirm.text') }}</p>
        <div class="flex justify-end gap-space-sm">
          <Button
            type="button"
            :label="t('common.cancel')"
            severity="secondary"
            variant="text"
            :disabled="submit.isPending.value"
            @click="confirmation = null"
          />
          <Button
            type="button"
            data-confirm-warnings
            :label="t('changes.confirm.submit')"
            :loading="submit.isPending.value"
            @click="send(confirmation.request, true)"
          />
        </div>
      </div>
    </Dialog>

    <Dialog
      v-model:visible="discardAllOpen"
      modal
      :header="t('changes.pending.discardAll')"
      :style="{ width: 'min(28rem, calc(100vw - 2rem))' }"
    >
      <div class="flex flex-col gap-space-lg">
        <p class="text-body-md text-ink">
          {{ t('changes.pending.discardAllText', { count: changes.length }, changes.length) }}
        </p>
        <div class="flex justify-end gap-space-sm">
          <Button
            type="button"
            :label="t('common.cancel')"
            severity="secondary"
            variant="text"
            @click="discardAllOpen = false"
          />
          <Button
            type="button"
            data-confirm-discard
            :label="t('changes.pending.discardAllConfirm')"
            severity="danger"
            :loading="discard.isPending.value"
            @click="discardChanges()"
          />
        </div>
      </div>
    </Dialog>
  </section>
</template>
