<script setup lang="ts">
import { AUTOMATION_MODES, type AutomationMode, type Guardrails } from '@profitbash/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import { computed, ref, useId, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../api';
import type { AutomationSettingsData } from '../api/client';
import GuardrailFields from '../automations/GuardrailFields.vue';
import ChecksTab from '../automations/ChecksTab.vue';
import ProposalsTab from '../automations/ProposalsTab.vue';
import RulesTab from '../automations/RulesTab.vue';
import RunsTab from '../automations/RunsTab.vue';
import {
  parseGuardrailInputs,
  toGuardrailInputs,
  type GuardrailInputs,
} from '../automations/guardrail-form';
import InlineError from '../components/common/InlineError.vue';
import PageHeader from '../components/common/PageHeader.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import { errorMessageKey } from '../i18n';
import { useActiveOrgId, useSessionStore } from '../stores/session';

/**
 * Seite „Automationen & Regeln“ (`phase-5.md` 5.4, 5.6b): Tabs „Einstellungen“ (Leitplanken der Organisation, je
 * Client Modus, zuständiger Nutzer und überschriebene Werte), „Regeln“, „Vorschläge“, „Läufe“ (5.8) und
 * „Prüfungen“ (5.10).
 */
const { t } = useI18n();
const id = useId();
const session = useSessionStore();
const orgId = useActiveOrgId();
const queryClient = useQueryClient();
const canWrite = computed(() => session.me?.features.automations.write ?? false);

const TABS = ['settings', 'rules', 'proposals', 'runs', 'checks'] as const;
// `?tab=` öffnet einen Tab direkt (Link aus der Benachrichtigung zu neuen Befunden).
const wanted = useRoute().query.tab;
const tab = ref<(typeof TABS)[number]>(TABS.find((name) => name === wanted) ?? 'settings');
const tabId = (name: string) => `${id}-tab-${name}`;
function moveTab(step: number) {
  const next = TABS[(TABS.indexOf(tab.value) + step + TABS.length) % TABS.length]!;
  tab.value = next;
  document.getElementById(tabId(next))?.focus();
}

const queryKey = computed(() => ['automation-settings', orgId.value] as const);
const settingsQuery = useQuery({
  queryKey,
  queryFn: () => api.automations.settings(),
  enabled: computed(() => orgId.value !== null),
});
const data = computed(() => settingsQuery.data.value);
/** Jede Änderung antwortet mit dem neuen Stand. */
const store = (next: AutomationSettingsData) => queryClient.setQueryData(queryKey.value, next);
const failure = (error: unknown) =>
  errorMessageKey(error instanceof ApiError ? error.code : 'UNKNOWN');

// --- Leitplanken der Organisation --------------------------------------------------------

const defaults = ref<GuardrailInputs>(toGuardrailInputs({}));
// Nur bei geänderten Werten neu füllen: Ein Nachladen beim Fokus verwirft so keine Eingaben.
watch(
  () => JSON.stringify(data.value?.defaults),
  () => data.value && (defaults.value = toGuardrailInputs(data.value.defaults)),
  { immediate: true },
);
const canEditDefaults = computed(() => canWrite.value && (data.value?.canEditDefaults ?? false));
const parsedDefaults = computed(() => parseGuardrailInputs(defaults.value, false));
const saveDefaults = useMutation({
  mutationFn: (guardrails: Guardrails) => api.automations.saveDefaults(guardrails),
  onSuccess: store,
});
function submitDefaults() {
  const value = parsedDefaults.value.value;
  if (value && !saveDefaults.isPending.value) saveDefaults.mutate(value as Guardrails);
}

// --- Je Client ---------------------------------------------------------------------------

type ClientRow = AutomationSettingsData['clients'][number];
const editing = ref<ClientRow | null>(null);
const mode = ref<AutomationMode>('shadow');
const responsible = ref('');
const overrides = ref<GuardrailInputs>(toGuardrailInputs({}));
const clientErrorKey = ref<string | null>(null);
const parsedOverrides = computed(() => parseGuardrailInputs(overrides.value, true));
const placeholders = computed(() => toGuardrailInputs(data.value?.defaults ?? {}));
const memberName = (userId: string | null) =>
  data.value?.members.find((member) => member.userId === userId)?.name ?? null;

const saveClient = useMutation({
  mutationFn: (input: {
    clientId: string;
    body: Parameters<typeof api.automations.setClient>[1];
  }) => api.automations.setClient(input.clientId, input.body),
  onSuccess: store,
});

function openClient(row: ClientRow) {
  editing.value = row;
  mode.value = row.mode;
  responsible.value = row.responsibleUserId ?? '';
  overrides.value = toGuardrailInputs(row.overrides);
  clientErrorKey.value = null;
}
async function submitClient() {
  const row = editing.value;
  const value = parsedOverrides.value.value;
  if (!row || !value || saveClient.isPending.value) return;
  clientErrorKey.value = null;
  try {
    await saveClient.mutateAsync({
      clientId: row.id,
      body: {
        mode: mode.value,
        // Leer im Modus „Warenkorb“: zuständig ist, wer speichert (setzt der Server).
        responsibleUserId: mode.value === 'cart' ? responsible.value || null : null,
        overrides: value,
      },
    });
    editing.value = null;
  } catch (error) {
    clientErrorKey.value = failure(error);
  }
}
</script>

<template>
  <div class="flex flex-col gap-gutter">
    <PageHeader
      :eyebrow="t('explorer.eyebrow')"
      :title="t('automations.title')"
      :description="t('automations.description')"
    />

    <div
      role="tablist"
      :aria-label="t('automations.title')"
      class="flex gap-space-xs overflow-x-auto"
    >
      <button
        v-for="name in TABS"
        :id="tabId(name)"
        :key="name"
        type="button"
        role="tab"
        :data-automation-tab="name"
        :aria-controls="`${id}-panel`"
        :aria-selected="tab === name"
        :tabindex="tab === name ? 0 : -1"
        :class="[
          'whitespace-nowrap rounded-control px-space-md py-space-sm text-body-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-violet',
          tab === name
            ? 'bg-violet-wash font-semibold text-violet'
            : 'text-ink-secondary hover:bg-violet-wash hover:text-ink',
        ]"
        @click="tab = name"
        @keydown.right.prevent="moveTab(1)"
        @keydown.left.prevent="moveTab(-1)"
      >
        {{ t(`automations.tabs.${name}`) }}
      </button>
    </div>

    <div
      :id="`${id}-panel`"
      role="tabpanel"
      :aria-labelledby="tabId(tab)"
      class="flex flex-col gap-gutter"
    >
      <!-- KeepAlive: Der ungespeicherte Entwurf der Regeln übersteht den Wechsel des Tabs. -->
      <KeepAlive>
        <RulesTab v-if="tab === 'rules'" :clients="data?.clients" :can-write="canWrite" />
      </KeepAlive>
      <ProposalsTab v-if="tab === 'proposals'" :can-write="canWrite" />
      <RunsTab v-else-if="tab === 'runs'" />
      <ChecksTab v-else-if="tab === 'checks'" :can-write="canWrite" />
      <template v-if="tab === 'settings'">
        <InlineError
          v-if="settingsQuery.isError.value"
          :message="t('automations.loadFailed')"
          retryable
          :retrying="settingsQuery.isFetching.value"
          @retry="settingsQuery.refetch()"
        />
        <SkeletonBlock v-else-if="!data" shape="tile" height="20rem" />

        <template v-else>
          <section
            class="flex min-w-0 flex-col gap-space-md rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg"
          >
            <div class="flex flex-col gap-space-xs">
              <h2 class="text-headline-sm text-ink">{{ t('automations.defaults.title') }}</h2>
              <p class="max-w-prose text-body-sm text-ink-secondary">
                {{ t('automations.defaults.text') }}
                <template v-if="!canEditDefaults">{{
                  t('automations.defaults.adminOnly')
                }}</template>
              </p>
            </div>
            <form
              class="flex flex-col gap-space-md"
              @submit.prevent="submitDefaults"
              @input="saveDefaults.reset()"
            >
              <InlineError
                v-if="saveDefaults.isError.value"
                :message="t(failure(saveDefaults.error.value))"
              />
              <GuardrailFields
                v-model="defaults"
                form="defaults"
                :invalid="parsedDefaults.invalid"
                :disabled="!canEditDefaults"
              />
              <div v-if="canEditDefaults" class="flex items-center gap-space-md">
                <Button
                  type="submit"
                  data-defaults-save
                  :label="t('common.save')"
                  :loading="saveDefaults.isPending.value"
                  :disabled="parsedDefaults.value === null"
                />
                <span
                  v-if="saveDefaults.isSuccess.value"
                  class="text-body-sm text-ink-secondary"
                  aria-live="polite"
                >
                  {{ t('automations.defaults.saved') }}
                </span>
              </div>
            </form>
          </section>

          <section
            class="flex min-w-0 flex-col gap-space-sm rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg"
          >
            <h2 class="text-headline-sm text-ink">{{ t('automations.clients.title') }}</h2>
            <p class="max-w-prose text-body-sm text-ink-secondary">
              {{ t('automations.clients.text') }}
            </p>
            <p v-if="data.clients.length === 0" class="text-body-md text-ink-secondary">
              {{ t('automations.clients.empty') }}
            </p>
            <ul v-else class="flex flex-col">
              <li
                v-for="row in data.clients"
                :key="row.id"
                :data-client-row="row.id"
                class="flex flex-wrap items-center gap-x-space-md gap-y-space-xs border-b border-line py-space-sm last:border-b-0"
              >
                <span class="min-w-0 flex-1 basis-48 truncate text-body-md text-ink">
                  {{ row.name }}
                </span>
                <span class="text-body-sm text-ink-secondary">
                  {{ t(`automations.mode.${row.mode}.label`) }}
                  <template v-if="row.mode === 'cart' && memberName(row.responsibleUserId)">
                    · {{ memberName(row.responsibleUserId) }}
                  </template>
                  · {{ t('automations.clients.overrides', Object.keys(row.overrides).length) }}
                </span>
                <Button
                  v-if="canWrite"
                  icon="pi pi-pencil"
                  severity="secondary"
                  variant="text"
                  size="small"
                  :aria-label="t('automations.client.action', { name: row.name })"
                  @click="openClient(row)"
                />
              </li>
            </ul>
          </section>
        </template>
      </template>
    </div>

    <Dialog
      :visible="editing !== null"
      modal
      :closable="!saveClient.isPending.value"
      :close-on-escape="!saveClient.isPending.value"
      :header="editing ? t('automations.client.title', { name: editing.name }) : ''"
      :style="{ width: 'min(40rem, calc(100vw - 2rem))' }"
      @update:visible="(next) => !next && (editing = null)"
    >
      <form v-if="editing" class="flex flex-col gap-space-lg" @submit.prevent="submitClient">
        <InlineError v-if="clientErrorKey" :message="t(clientErrorKey)" />
        <fieldset class="flex flex-col gap-space-xs">
          <legend class="mb-space-xs text-label-eyebrow uppercase text-ink-tertiary">
            {{ t('automations.client.mode') }}
          </legend>
          <label
            v-for="option in AUTOMATION_MODES"
            :key="option"
            class="flex min-h-11 items-start gap-space-sm py-space-xs text-body-md text-ink"
          >
            <input
              v-model="mode"
              type="radio"
              name="automation-mode"
              :value="option"
              class="mt-1 size-4 accent-violet"
            />
            <span>
              {{ t(`automations.mode.${option}.label`) }}
              <span class="block text-body-sm text-ink-secondary">
                {{ t(`automations.mode.${option}.hint`) }}
              </span>
            </span>
          </label>
        </fieldset>
        <div v-if="mode === 'cart'" class="flex flex-col gap-space-xs">
          <label :for="`${id}-responsible`" class="text-label-eyebrow uppercase text-ink-tertiary">
            {{ t('automations.client.responsible') }}
          </label>
          <select
            :id="`${id}-responsible`"
            v-model="responsible"
            data-client-responsible
            class="h-11 rounded-control bg-well px-space-md text-ink outline-none focus-visible:ring-2 focus-visible:ring-violet"
          >
            <option value="">{{ t('automations.client.responsibleSelf') }}</option>
            <option v-for="member in data?.members" :key="member.userId" :value="member.userId">
              {{ member.name }}
            </option>
          </select>
        </div>
        <div class="flex flex-col gap-space-sm">
          <p class="text-body-sm text-ink-secondary">{{ t('automations.client.overridesHint') }}</p>
          <GuardrailFields
            v-model="overrides"
            form="client"
            :invalid="parsedOverrides.invalid"
            :placeholders="placeholders"
          />
        </div>
        <div class="flex flex-wrap justify-end gap-space-sm">
          <Button
            type="button"
            :label="t('common.cancel')"
            severity="secondary"
            variant="text"
            :disabled="saveClient.isPending.value"
            @click="editing = null"
          />
          <Button
            type="submit"
            data-client-save
            :label="t('common.save')"
            :loading="saveClient.isPending.value"
            :disabled="parsedOverrides.value === null"
          />
        </div>
      </form>
    </Dialog>
  </div>
</template>
