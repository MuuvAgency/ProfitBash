<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import PendingPanel, { type Submitted } from '../changes/PendingPanel.vue';
import { usePendingCount } from '../changes/queries';
import SubmissionsPanel from '../changes/SubmissionsPanel.vue';
import PageHeader from '../components/common/PageHeader.vue';

/**
 * Änderungen (`phase-3.md` 3.6, `plan.md` §3): „Ausstehend“ (der eigene Warenkorb) und „Übermittlungen“ (Ergebnisse
 * der ganzen Organisation). Reiter und geöffnete Übermittlung stehen in der URL (`tab`, `submission`).
 */
const { t } = useI18n();
const route = useRoute();
const router = useRouter();

const tab = computed(() => (route.query.tab === 'submissions' ? 'submissions' : 'pending'));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const submissionId = computed(() => {
  const value = route.query.submission;
  return typeof value === 'string' && UUID.test(value) ? value : null;
});
const pendingCount = usePendingCount();

const tabs = computed(() => [
  {
    key: 'pending',
    label: pendingCount.value
      ? t('changes.tab.pendingCount', { count: pendingCount.value })
      : t('changes.tab.pending'),
    to: { path: '/ads/changes' },
  },
  {
    key: 'submissions',
    label: t('changes.tab.submissions'),
    to: { path: '/ads/changes', query: { tab: 'submissions' } },
  },
]);

/** Was beim letzten Übermitteln nicht mitging (entfallen, blockiert, nicht in die Bulk-Datei geschrieben). */
const submitNotice = ref<string[] | null>(null);
function onSubmitted(result: Submitted) {
  const lines = [
    result.submissions.length > 0
      ? t('changes.submitted.done', { count: result.submissions.length }, result.submissions.length)
      : t('changes.submitted.nothing'),
  ];
  if (result.dropped > 0) {
    lines.push(t('changes.submitted.dropped', { count: result.dropped }, result.dropped));
  }
  if (result.blocked.length > 0) {
    const reasons = [
      ...new Set(result.blocked.map((item) => t(`changes.rejection.${item.reason}`))),
    ];
    lines.push(
      t(
        'changes.submitted.blocked',
        { count: result.blocked.length, reasons: reasons.join(' ') },
        result.blocked.length,
      ),
    );
  }
  if (result.bulkFileSkipped.length > 0) {
    lines.push(
      t(
        'changes.submitted.bulkFileSkipped',
        { count: result.bulkFileSkipped.length },
        result.bulkFileSkipped.length,
      ),
    );
  }
  submitNotice.value = lines;
  const first = result.submissions[0];
  if (first) {
    void router.push({ path: '/ads/changes', query: { tab: 'submissions', submission: first.id } });
  }
}
</script>

<template>
  <div class="flex flex-col gap-gutter">
    <PageHeader
      :eyebrow="t('explorer.eyebrow')"
      :title="t('nav.changes')"
      :description="t('changes.description')"
    />

    <nav :aria-label="t('changes.tabs')" class="flex gap-space-xs overflow-x-auto">
      <RouterLink
        v-for="item in tabs"
        :key="item.key"
        :to="item.to"
        :data-tab="item.key"
        :aria-current="tab === item.key ? 'page' : undefined"
        :class="[
          'whitespace-nowrap rounded-control px-space-md py-space-sm text-body-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-violet',
          tab === item.key
            ? 'bg-violet font-semibold text-on-violet shadow-active'
            : 'text-ink-secondary hover:bg-violet-wash hover:text-ink',
        ]"
      >
        {{ item.label }}
      </RouterLink>
    </nav>

    <div
      v-if="submitNotice"
      data-submit-notice
      role="status"
      class="flex items-start gap-space-sm rounded-control bg-violet-wash px-space-md py-space-sm text-body-sm text-ink"
    >
      <i class="pi pi-info-circle mt-0.5 shrink-0 text-violet" aria-hidden="true" />
      <div class="flex min-w-0 flex-1 flex-col gap-space-xs">
        <p
          v-for="(line, index) in submitNotice"
          :key="line"
          :class="index === 0 ? 'font-semibold' : ''"
        >
          {{ line }}
        </p>
      </div>
      <button
        type="button"
        :aria-label="t('common.close')"
        class="flex size-8 shrink-0 items-center justify-center rounded-control text-ink-secondary outline-none hover:bg-tile focus-visible:ring-2 focus-visible:ring-violet"
        @click="submitNotice = null"
      >
        <i class="pi pi-times" aria-hidden="true" />
      </button>
    </div>

    <PendingPanel v-if="tab === 'pending'" @submitted="onSubmitted" />
    <SubmissionsPanel v-else :submission-id="submissionId" />
  </div>
</template>
