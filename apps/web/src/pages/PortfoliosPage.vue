<script setup lang="ts">
import { formatCurrency, formatDay, formatNumber } from '@profitbash/shared';
import Button from 'primevue/button';
import { computed, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError } from '../api';
import type { CreatePortfolioInput } from '../api/client';
import EmptyState from '../components/common/EmptyState.vue';
import InlineError from '../components/common/InlineError.vue';
import PageHeader from '../components/common/PageHeader.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import { errorMessageKey } from '../i18n';
import { useSessionStore } from '../stores/session';
import { inputClass, labelClass } from '../tools/catalog/draft';
import {
  useCreatePortfolio,
  usePortfolios,
  useProductGroups,
  useToolRights,
} from '../tools/queries';
import ToolsTabs from '../tools/ToolsTabs.vue';

/**
 * Seite „Portfolio“ (`phase-4.md` 4.7, F9): Portfolios eines Profils mit Budget und Zahl der Kampagnen, dazu
 * angelegte, noch nicht importierte. Ein neues Portfolio (Name, optional Budget monatlich oder im Zeitraum) geht als
 * Bulk-Datei raus (Seite „Änderungen“); zuordnen lässt es sich im Kampagnen-Setup erst nach dem nächsten Import.
 */
const { t } = useI18n();
const id = useId();
const session = useSessionStore();
const locale = computed(() => session.preferences.locale);
const { canWrite } = useToolRights();
const groups = useProductGroups();
const profileId = ref<string | null>(null);
const portfolios = usePortfolios(profileId);

const amount = (value: string, currency: string | null) =>
  currency ? formatCurrency(value, currency, locale.value) : formatNumber(value, locale.value);
function budgetText(entry: {
  budgetAmount: string | null;
  budgetCurrencyCode: string | null;
  budgetPolicy: string | null;
  budgetStartDate: string | null;
  budgetEndDate: string | null;
}): string {
  if (entry.budgetAmount === null || entry.budgetPolicy === null || entry.budgetPolicy === 'NO_CAP')
    return t('portfolios.list.noBudget');
  const policy = t(`portfolios.policy.${entry.budgetPolicy}`);
  const period = entry.budgetStartDate
    ? entry.budgetEndDate
      ? t('portfolios.periodRange', {
          start: formatDay(entry.budgetStartDate, locale.value),
          end: formatDay(entry.budgetEndDate, locale.value),
        })
      : t('portfolios.period', { start: formatDay(entry.budgetStartDate, locale.value) })
    : '';
  return [amount(entry.budgetAmount, entry.budgetCurrencyCode), policy, period]
    .filter(Boolean)
    .join(' · ');
}
const submissionLink = (submissionId: string) => ({
  path: '/ads/changes',
  query: { tab: 'submissions', submission: submissionId },
});

// --- Neues Portfolio ---------------------------------------------------------------------

const create = useCreatePortfolio();
const name = ref('');
const withBudget = ref(false);
const budgetAmount = ref('');
const policy = ref<'monthlyRecurring' | 'dateRange'>('monthlyRecurring');
const startDate = ref('');
const endDate = ref('');
const errorKey = ref<string | null>(null);
const created = ref<string | null>(null);
watch(profileId, () => {
  created.value = null;
  errorKey.value = null;
});

const MONEY = /^\d{1,7}(\.\d{1,2})?$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const valid = computed(() => {
  if (name.value.trim() === '') return false;
  if (!withBudget.value) return true;
  if (!MONEY.test(budgetAmount.value) || !/[1-9]/.test(budgetAmount.value)) return false;
  if (!DAY.test(startDate.value)) return false;
  return endDate.value === '' || (DAY.test(endDate.value) && endDate.value >= startDate.value);
});
const touched = ref(false);

async function submit() {
  touched.value = true;
  if (!profileId.value || !valid.value || create.isPending.value) return;
  errorKey.value = null;
  const body: CreatePortfolioInput = {
    profileId: profileId.value,
    name: name.value,
    budget: withBudget.value
      ? {
          amount: budgetAmount.value,
          policy: policy.value,
          startDate: startDate.value,
          endDate: endDate.value === '' ? null : endDate.value,
        }
      : null,
  };
  try {
    const result = await create.mutateAsync(body);
    created.value = result.submission.id;
    name.value = '';
    withBudget.value = false;
    budgetAmount.value = '';
    startDate.value = '';
    endDate.value = '';
    touched.value = false;
  } catch (error) {
    errorKey.value =
      error instanceof ApiError ? errorMessageKey(error.code) : 'portfolios.form.failed';
  }
}
</script>

<template>
  <div class="flex flex-col gap-gutter">
    <PageHeader
      :eyebrow="t('portfolios.eyebrow')"
      :title="t('portfolios.title')"
      :description="t('portfolios.description')"
    />
    <ToolsTabs current="portfolios" />

    <InlineError
      v-if="groups.isError.value"
      :message="t('portfolios.loadFailed')"
      retryable
      :retrying="groups.isFetching.value"
      @retry="groups.refetch()"
    />
    <SkeletonBlock v-else-if="!groups.data.value" shape="tile" height="10rem" />
    <template v-else>
      <div class="flex max-w-md min-w-0 flex-col gap-space-xs">
        <label :for="`${id}-profile`" :class="labelClass">{{ t('portfolios.profile') }}</label>
        <select
          :id="`${id}-profile`"
          v-model="profileId"
          data-portfolio-profile
          :class="inputClass"
        >
          <option :value="null" disabled>{{ t('portfolios.chooseProfile') }}</option>
          <option v-for="item in groups.data.value.profiles" :key="item.id" :value="item.id">
            {{ item.accountName }} ({{ item.countryCode }})
          </option>
        </select>
      </div>

      <template v-if="profileId">
        <InlineError
          v-if="portfolios.isError.value"
          data-portfolio-error
          :message="t('portfolios.loadFailed')"
          retryable
          :retrying="portfolios.isFetching.value"
          @retry="portfolios.refetch()"
        />
        <SkeletonBlock v-else-if="!portfolios.data.value" shape="tile" height="10rem" />
        <template v-else>
          <section
            class="flex min-w-0 flex-col gap-space-sm rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg"
          >
            <h2 class="text-label-eyebrow uppercase text-ink-tertiary">
              {{ t('portfolios.list.title') }}
            </h2>
            <EmptyState
              v-if="portfolios.data.value.portfolios.length === 0"
              data-portfolio-empty
              icon="folder"
              :title="t('portfolios.list.title')"
              :text="t('portfolios.empty')"
            />
            <!-- `relative`: Absolut positionierte Inhalte bleiben im Scroll-Bereich (Handy). -->
            <div v-else class="relative min-w-0 overflow-x-auto">
              <table class="w-full min-w-[36rem] text-left text-body-sm">
                <thead class="text-label-eyebrow uppercase text-ink-tertiary">
                  <tr>
                    <th class="py-space-xs pr-space-md">{{ t('portfolios.list.name') }}</th>
                    <th class="py-space-xs pr-space-md">{{ t('portfolios.list.budget') }}</th>
                    <th class="py-space-xs pr-space-md text-right">
                      {{ t('portfolios.list.campaigns') }}
                    </th>
                    <th class="py-space-xs">{{ t('portfolios.list.state') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="entry in portfolios.data.value.portfolios"
                    :key="entry.id"
                    :data-portfolio="entry.id"
                    class="border-t border-line align-top"
                  >
                    <td class="py-space-xs pr-space-md text-ink">
                      {{ entry.name ?? t('portfolios.list.unnamed') }}
                    </td>
                    <td class="py-space-xs pr-space-md font-data tabular-nums text-ink-secondary">
                      {{ budgetText(entry) }}
                    </td>
                    <td class="py-space-xs pr-space-md text-right font-data tabular-nums">
                      {{ formatNumber(String(entry.campaigns), locale) }}
                    </td>
                    <td class="py-space-xs text-ink-secondary">{{ entry.state ?? '—' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section
            v-if="portfolios.data.value.pending.length"
            class="flex min-w-0 flex-col gap-space-sm rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg"
          >
            <h2 class="text-label-eyebrow uppercase text-ink-tertiary">
              {{ t('portfolios.pending.title') }}
            </h2>
            <p class="text-body-sm text-ink-secondary">{{ t('portfolios.pending.hint') }}</p>
            <ul class="flex flex-col">
              <li
                v-for="entry in portfolios.data.value.pending"
                :key="entry.itemId"
                data-portfolio-pending
                class="flex flex-wrap items-center gap-x-space-md gap-y-space-xs border-b border-line py-space-sm last:border-b-0"
              >
                <span class="min-w-0 flex-1 basis-48 text-body-md text-ink">{{ entry.name }}</span>
                <span class="text-body-sm text-ink-secondary">
                  {{ t(`portfolios.pending.${entry.status}`) }}
                </span>
                <RouterLink
                  :to="submissionLink(entry.submissionId)"
                  class="text-body-sm font-semibold text-violet underline"
                >
                  {{ t('portfolios.pending.toSubmission') }}
                </RouterLink>
              </li>
            </ul>
          </section>
        </template>

        <section
          v-if="canWrite"
          data-portfolio-form
          class="flex min-w-0 flex-col gap-space-md rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg"
        >
          <h2 class="text-label-eyebrow uppercase text-ink-tertiary">
            {{ t('portfolios.form.title') }}
          </h2>
          <div class="flex max-w-md min-w-0 flex-col gap-space-xs">
            <label :for="`${id}-name`" :class="labelClass">{{ t('portfolios.form.name') }}</label>
            <input
              :id="`${id}-name`"
              v-model="name"
              data-portfolio-name
              type="text"
              maxlength="128"
              :class="inputClass"
            />
          </div>
          <label class="flex items-center gap-space-xs text-body-md text-ink">
            <input v-model="withBudget" data-portfolio-budget-toggle type="checkbox" />
            {{ t('portfolios.form.withBudget') }}
          </label>
          <div v-if="withBudget" class="grid gap-space-md sm:grid-cols-2 lg:grid-cols-4">
            <div class="flex min-w-0 flex-col gap-space-xs">
              <label :for="`${id}-amount`" :class="labelClass">
                {{ t('portfolios.form.amount') }}
              </label>
              <input
                :id="`${id}-amount`"
                v-model="budgetAmount"
                data-portfolio-amount
                inputmode="decimal"
                :class="[inputClass, 'font-data tabular-nums']"
              />
            </div>
            <div class="flex min-w-0 flex-col gap-space-xs">
              <label :for="`${id}-policy`" :class="labelClass">
                {{ t('portfolios.form.policy') }}
              </label>
              <select
                :id="`${id}-policy`"
                v-model="policy"
                data-portfolio-policy
                :class="inputClass"
              >
                <option value="monthlyRecurring">
                  {{ t('portfolios.form.monthlyRecurring') }}
                </option>
                <option value="dateRange">{{ t('portfolios.form.dateRange') }}</option>
              </select>
            </div>
            <div class="flex min-w-0 flex-col gap-space-xs">
              <label :for="`${id}-start`" :class="labelClass">
                {{ t('portfolios.form.start') }}
              </label>
              <input
                :id="`${id}-start`"
                v-model="startDate"
                data-portfolio-start
                type="date"
                :class="inputClass"
              />
            </div>
            <div class="flex min-w-0 flex-col gap-space-xs">
              <label :for="`${id}-end`" :class="labelClass">{{ t('portfolios.form.end') }}</label>
              <input
                :id="`${id}-end`"
                v-model="endDate"
                data-portfolio-end
                type="date"
                :class="inputClass"
              />
            </div>
          </div>
          <p v-if="touched && !valid" role="alert" class="text-body-sm text-on-loss-wash">
            {{ t('portfolios.form.invalid') }}
          </p>
          <div>
            <Button
              data-portfolio-create
              icon="pi pi-plus"
              :label="t('portfolios.form.create')"
              :loading="create.isPending.value"
              @click="submit"
            />
          </div>
          <InlineError v-if="errorKey" :message="t(errorKey)" />
          <div
            v-if="created"
            data-portfolio-created
            role="status"
            class="flex flex-col gap-space-xs rounded-control bg-violet-wash p-space-md text-body-sm text-ink"
          >
            <p>{{ t('portfolios.form.created') }}</p>
            <RouterLink :to="submissionLink(created)" class="font-semibold text-violet underline">
              {{ t('portfolios.form.toChanges') }}
            </RouterLink>
          </div>
        </section>
      </template>
    </template>
  </div>
</template>
