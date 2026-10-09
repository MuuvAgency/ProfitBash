<script setup lang="ts">
import { effectivePreset, formatNumber, type StructureCatalog } from '@profitbash/shared';
import Button from 'primevue/button';
import { computed, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError } from '../../api';
import type {
  AdChangeChannelData,
  PlannedCampaignData,
  ProductGroupListData,
  SetupDraftData,
  SetupIssueData,
} from '../../api/client';
import InlineError from '../../components/common/InlineError.vue';
import { errorMessageKey } from '../../i18n';
import { useSessionStore } from '../../stores/session';
import { inputClass, labelClass } from '../catalog/draft';
import {
  useDiscardSetupDraft,
  usePlanSetup,
  useSaveSetupDraft,
  useSubmitSetupDraft,
  useToolRights,
} from '../queries';
import {
  emptyTexts,
  inputsToTexts,
  textsToInputs,
  type SetupInputs,
  type SetupTexts,
} from './inputs';
import { groupedIssues, issueText, sortedIssues } from './issues';

/**
 * Assistent des Kampagnen-Setups (`phase-4.md` 4.5): Profil → Produktgruppe → Preset → Keywords und Ziele → Vorschau
 * (Namen, Gebote, Budgets, Hinweise) → Entwurf speichern → übermitteln. Neue Kampagnen sind aktiv vorbelegt und je
 * Entwurf auf pausiert umstellbar (F6). Ein übermittelter oder verworfener Entwurf ist nur noch lesbar.
 */
const props = defineProps<{
  draft: SetupDraftData | null;
  groups: ProductGroupListData;
  catalog: StructureCatalog;
  clientPresets: readonly { clientId: string; presetKey: string }[];
}>();
const emit = defineEmits<{ close: [] }>();

const { t, te } = useI18n();
const id = useId();
const session = useSessionStore();
const locale = computed(() => session.preferences.locale);
const { canWrite } = useToolRights();

const draftId = ref<string | null>(props.draft?.id ?? null);
const version = ref(props.draft?.version ?? 0);
const status = ref(props.draft?.status ?? 'draft');
const editable = computed(() => canWrite.value && status.value === 'draft');

const profileId = ref<string | null>(props.draft?.profileId ?? null);
const productGroupId = ref<string | null>(props.draft?.productGroupId ?? null);
const presetKey = ref<string | null>(props.draft?.presetKey ?? null);
const texts = ref<SetupTexts>(props.draft ? inputsToTexts(props.draft.inputs) : emptyTexts());
const unlocks = ref<SetupInputs['unlocks']>({ ...(props.draft?.inputs.unlocks ?? {}) });
const useProfileBids = ref(true);
const name = ref(props.draft?.name ?? '');
const paused = ref(props.draft?.campaignState === 'PAUSED');
// Eigene Kopie: Die Vorschau ist bearbeitbar, der Cache von Vue Query bleibt unberührt (structuredClone scheitert an
// reaktiven Proxies).
const campaigns = ref<PlannedCampaignData[]>(
  props.draft ? (JSON.parse(JSON.stringify(props.draft.campaigns)) as PlannedCampaignData[]) : [],
);
const hints = ref<SetupIssueData[]>([]);
const rateNote = ref<string | null>(null);
const profileBidsNote = ref<string | null>(null);

const profile = computed(() => props.groups.profiles.find((p) => p.id === profileId.value) ?? null);
const profileGroups = computed(() =>
  props.groups.groups.filter((group) => group.profileId === profileId.value),
);
const group = computed(
  () => profileGroups.value.find((g) => g.id === productGroupId.value) ?? null,
);
const preset = computed(() => props.catalog.presets.find((p) => p.key === presetKey.value) ?? null);
const blockLabel = (key: string) =>
  props.catalog.blocks.find((block) => block.key === key)?.label ?? key;
/** Bausteine des Presets, die sich freischalten lassen: vCPM bei SB/SD, Off-Amazon bei SP. */
const unlockable = computed(() =>
  (preset.value?.blocks ?? []).flatMap((entry) => {
    const block = props.catalog.blocks.find((b) => b.key === entry.block);
    return block ? [{ key: block.key, label: block.label, vcpm: block.adProduct !== 'SP' }] : [];
  }),
);

// Profil gewechselt: Gruppe zurücksetzen; Gruppe gewechselt: Preset der Gruppe bzw. des Clients vorbelegen.
watch(profileId, () => {
  if (!profileGroups.value.some((g) => g.id === productGroupId.value)) productGroupId.value = null;
});
watch(productGroupId, (next) => {
  if (!next || props.draft) return;
  const clientId = profile.value?.clientId ?? null;
  presetKey.value = effectivePreset(props.catalog, {
    productGroup: group.value?.presetKey ?? null,
    client: props.clientPresets.find((entry) => entry.clientId === clientId)?.presetKey ?? null,
  }).key;
});
// Der Plan passt nach einer Änderung der Eingaben nicht mehr: neu planen.
const planStale = ref(false);
watch([profileId, productGroupId, presetKey, texts, unlocks], () => (planStale.value = true), {
  deep: true,
});

// --- Planen ------------------------------------------------------------------------------

const planMutation = usePlanSetup();
const planErrorKey = ref<string | null>(null);
const canPlan = computed(
  () => editable.value && profileId.value && productGroupId.value && presetKey.value,
);
async function plan() {
  if (!canPlan.value || planMutation.isPending.value) return;
  planErrorKey.value = null;
  try {
    const result = await planMutation.mutateAsync({
      profileId: profileId.value!,
      productGroupId: productGroupId.value!,
      presetKey: presetKey.value!,
      inputs: textsToInputs(texts.value, unlocks.value),
      useProfileBids: useProfileBids.value,
    });
    campaigns.value = result.campaigns;
    hints.value = result.hints;
    const currency = result.campaigns[0]?.currencyCode ?? profile.value?.countryCode ?? '';
    rateNote.value =
      result.eurRate.rate === '1'
        ? null
        : t('setup.preview.eurRate', {
            rate: result.eurRate.rate,
            currency,
            date: result.eurRate.date,
          });
    const bids = [
      ...Object.entries(result.profileBids.keyword ?? {}).map(
        ([match, value]) => `${match} ${value}`,
      ),
      ...(result.profileBids.product ? [`ASIN ${result.profileBids.product}`] : []),
      ...(result.profileBids.category ? [`Kategorie ${result.profileBids.category}`] : []),
    ];
    profileBidsNote.value = bids.length
      ? t('setup.preview.fromProfile', { values: bids.join(', ') })
      : null;
    planStale.value = false;
    if (!name.value) name.value = group.value?.name ?? '';
  } catch (error) {
    planErrorKey.value =
      error instanceof ApiError ? errorMessageKey(error.code) : 'setup.planFailed';
  }
}

// --- Vorschau bearbeiten -----------------------------------------------------------------

const MONEY = /^\d{1,7}(\.\d{1,2})?$/;
const money = (value: string) => formatNumber(value, locale.value, { minimumFractionDigits: 2 });
const amountValid = (value: string) => MONEY.test(value);
const allAmountsValid = computed(() =>
  campaigns.value.every(
    (campaign) => amountValid(campaign.dailyBudget) && amountValid(campaign.adGroup.defaultBid),
  ),
);
function removeCampaign(index: number) {
  campaigns.value = campaigns.value.filter((_, position) => position !== index);
}
const issues = computed(() => groupedIssues(hints.value));
const hasErrors = computed(() => hints.value.some((hint) => hint.severity === 'error'));

// --- Speichern, Verwerfen, Übermitteln ---------------------------------------------------

const save = useSaveSetupDraft();
const discard = useDiscardSetupDraft();
const submit = useSubmitSetupDraft();
const notice = ref<string | null>(null);
const actionErrorKey = ref<string | null>(null);
const channel = ref<AdChangeChannelData>('bulk_file');
const submitted = ref<{
  id: string;
  items: number;
  unsupported: number;
  channel: AdChangeChannelData;
} | null>(null);
const rejected = ref<SetupIssueData[]>([]);

const canSave = computed(
  () =>
    editable.value &&
    campaigns.value.length > 0 &&
    name.value.trim() !== '' &&
    allAmountsValid.value &&
    profileId.value !== null &&
    presetKey.value !== null,
);

async function saveDraft(): Promise<boolean> {
  if (!canSave.value || save.isPending.value) return false;
  actionErrorKey.value = null;
  notice.value = null;
  try {
    const saved = await save.mutateAsync({
      id: draftId.value,
      version: version.value,
      draft: {
        profileId: profileId.value!,
        productGroupId: productGroupId.value,
        presetKey: presetKey.value!,
        name: name.value,
        campaignState: paused.value ? 'PAUSED' : 'ENABLED',
        inputs: textsToInputs(texts.value, unlocks.value),
        campaigns: campaigns.value,
      },
    });
    draftId.value = saved.id;
    version.value = saved.version;
    notice.value = t('setup.saved');
    return true;
  } catch (error) {
    actionErrorKey.value =
      error instanceof ApiError ? errorMessageKey(error.code) : 'setup.saveFailed';
    return false;
  }
}

async function submitDraft() {
  if (!editable.value || submit.isPending.value) return;
  // Ungespeicherte Änderungen zuerst sichern (übermittelt wird der gespeicherte Stand).
  if (!draftId.value || dirty.value) {
    if (!(await saveDraft())) return;
  }
  actionErrorKey.value = null;
  rejected.value = [];
  try {
    const result = await submit.mutateAsync({
      id: draftId.value!,
      version: version.value,
      channel: channel.value,
    });
    if (result.status === 'rejected') {
      rejected.value = sortedIssues(result.issues);
      return;
    }
    status.value = 'submitted';
    submitted.value = {
      id: result.submission.id,
      items: result.items,
      unsupported: result.unsupported,
      channel: channel.value,
    };
  } catch (error) {
    actionErrorKey.value =
      error instanceof ApiError ? errorMessageKey(error.code) : 'setup.submitFailed';
  }
}

async function discardDraft() {
  if (!draftId.value || !editable.value || discard.isPending.value) return;
  try {
    await discard.mutateAsync({ id: draftId.value, version: version.value });
    emit('close');
  } catch (error) {
    actionErrorKey.value =
      error instanceof ApiError ? errorMessageKey(error.code) : 'setup.saveFailed';
  }
}

/** Seit dem letzten Speichern geändert (dann sichert „Übermitteln“ zuerst). */
const savedSnapshot = ref(props.draft ? snapshot() : '');
function snapshot() {
  return JSON.stringify([name.value, paused.value, campaigns.value, texts.value, unlocks.value]);
}
const dirty = computed(() => snapshot() !== savedSnapshot.value);
watch(version, () => (savedSnapshot.value = snapshot()));
</script>

<template>
  <section
    data-setup-editor
    class="flex min-w-0 flex-col gap-space-lg rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg"
  >
    <p v-if="!editable && status !== 'draft'" class="text-body-sm text-ink-secondary">
      {{ t('setup.readOnly') }}
    </p>

    <!-- 1–3: Profil, Produktgruppe, Preset -->
    <div class="grid gap-space-md sm:grid-cols-3">
      <div class="flex min-w-0 flex-col gap-space-xs">
        <label :for="`${id}-profile`" :class="labelClass">{{ t('setup.profile') }}</label>
        <select
          :id="`${id}-profile`"
          v-model="profileId"
          data-setup-profile
          :disabled="!editable || draftId !== null"
          :class="inputClass"
        >
          <option :value="null" disabled>{{ t('setup.chooseProfile') }}</option>
          <option v-for="item in groups.profiles" :key="item.id" :value="item.id">
            {{ item.accountName }} ({{ item.countryCode }})
          </option>
        </select>
      </div>
      <div class="flex min-w-0 flex-col gap-space-xs">
        <label :for="`${id}-group`" :class="labelClass">{{ t('setup.group') }}</label>
        <select
          :id="`${id}-group`"
          v-model="productGroupId"
          data-setup-group
          :disabled="!editable || !profileId"
          :class="inputClass"
        >
          <option :value="null" disabled>{{ t('setup.chooseGroup') }}</option>
          <option v-for="item in profileGroups" :key="item.id" :value="item.id">
            {{ item.name }}
          </option>
        </select>
        <p v-if="profileId && profileGroups.length === 0" class="text-body-sm text-ink-secondary">
          {{ t('setup.noGroups') }}
        </p>
      </div>
      <div class="flex min-w-0 flex-col gap-space-xs">
        <label :for="`${id}-preset`" :class="labelClass">{{ t('setup.preset') }}</label>
        <select
          :id="`${id}-preset`"
          v-model="presetKey"
          data-setup-preset
          :disabled="!editable"
          :aria-describedby="`${id}-preset-hint`"
          :class="inputClass"
        >
          <option v-for="item in catalog.presets" :key="item.key" :value="item.key">
            {{ item.name }}
          </option>
        </select>
        <p :id="`${id}-preset-hint`" class="text-body-sm text-ink-secondary">
          {{ t('setup.presetHint') }}
        </p>
      </div>
    </div>

    <!-- 4: Keywords und Ziele -->
    <fieldset class="flex min-w-0 flex-col gap-space-md" :disabled="!editable">
      <legend :class="[labelClass, 'mb-space-sm']">{{ t('setup.step.inputs') }}</legend>
      <div class="grid gap-space-md md:grid-cols-2">
        <div
          v-for="field in [
            { key: 'keywords', label: 'setup.keywords' },
            { key: 'single', label: 'setup.single' },
            { key: 'brandTerms', label: 'setup.brandTerms' },
            { key: 'productTargets', label: 'setup.productTargets' },
            { key: 'singleProducts', label: 'setup.singleProducts' },
            { key: 'categories', label: 'setup.categories' },
          ] as const"
          :key="field.key"
          class="flex min-w-0 flex-col gap-space-xs"
        >
          <label :for="`${id}-${field.key}`" :class="labelClass">{{ t(field.label) }}</label>
          <textarea
            :id="`${id}-${field.key}`"
            v-model="texts[field.key]"
            :data-setup-input="field.key"
            :data-setup-keywords="field.key === 'keywords' ? '' : undefined"
            :data-setup-single="field.key === 'single' ? '' : undefined"
            rows="4"
            spellcheck="false"
            :class="[inputClass, 'h-auto py-space-sm font-data']"
          />
        </div>
      </div>
      <div v-if="unlockable.length" class="flex flex-col gap-space-xs">
        <span :class="labelClass">{{ t('setup.unlocks') }}</span>
        <p class="text-body-sm text-ink-secondary">{{ t('setup.unlockHint') }}</p>
        <div class="flex flex-wrap gap-x-space-lg gap-y-space-xs">
          <label
            v-for="block in unlockable"
            :key="block.key"
            class="flex items-center gap-space-xs text-body-sm text-ink"
          >
            <input
              type="checkbox"
              :checked="block.vcpm ? unlocks[block.key]?.vcpm : unlocks[block.key]?.offAmazon"
              @change="
                unlocks = {
                  ...unlocks,
                  [block.key]: {
                    ...unlocks[block.key],
                    [block.vcpm ? 'vcpm' : 'offAmazon']: ($event.target as HTMLInputElement)
                      .checked,
                  },
                }
              "
            />
            {{
              t(block.vcpm ? 'setup.unlockVcpm' : 'setup.unlockOffAmazon', { block: block.label })
            }}
          </label>
        </div>
      </div>
      <label class="flex items-center gap-space-xs text-body-sm text-ink">
        <input v-model="useProfileBids" type="checkbox" />
        {{ t('setup.useProfileBids') }}
      </label>
      <div>
        <Button
          data-setup-plan
          icon="pi pi-sitemap"
          :label="campaigns.length ? t('setup.replan') : t('setup.plan')"
          :disabled="!canPlan"
          :loading="planMutation.isPending.value"
          @click="plan"
        />
      </div>
      <InlineError v-if="planErrorKey" :message="t(planErrorKey)" />
    </fieldset>

    <!-- 5: Vorschau -->
    <template v-if="campaigns.length">
      <div class="flex flex-col gap-space-xs">
        <h3 :class="labelClass">
          {{ t('setup.step.preview') }} ·
          {{
            t(
              'setup.preview.campaigns',
              { count: formatNumber(String(campaigns.length), locale) },
              campaigns.length,
            )
          }}
        </h3>
        <p v-if="rateNote" class="text-body-sm text-ink-secondary">{{ rateNote }}</p>
        <p v-if="profileBidsNote" class="text-body-sm text-ink-secondary">{{ profileBidsNote }}</p>
      </div>
      <ul v-if="issues.length" data-setup-hints class="flex flex-col gap-space-xs">
        <li
          v-for="(issue, index) in issues"
          :key="index"
          :class="[
            'rounded-control px-space-md py-space-xs text-body-sm',
            issue.severity === 'error'
              ? 'bg-loss-wash text-on-loss-wash'
              : issue.severity === 'warning'
                ? 'border-l-4 border-warn bg-well text-ink'
                : 'bg-well text-ink-secondary',
          ]"
        >
          <span class="font-semibold">{{ t(`setup.severity.${issue.severity}`) }}:</span>
          {{ issueText(t, te, issue, blockLabel) }}
        </li>
      </ul>
      <!-- `relative`: Der unsichtbare Spaltentitel (`sr-only`, absolut) bleibt so im Scroll-Bereich. -->
      <div class="relative min-w-0 overflow-x-auto">
        <table class="w-full min-w-[40rem] text-left text-body-sm">
          <thead class="text-label-eyebrow uppercase text-ink-tertiary">
            <tr>
              <th class="py-space-xs pr-space-md">{{ t('setup.preview.name') }}</th>
              <th class="py-space-xs pr-space-md">{{ t('setup.preview.type') }}</th>
              <th class="py-space-xs pr-space-md text-right">{{ t('setup.preview.budget') }}</th>
              <th class="py-space-xs pr-space-md text-right">
                {{ t('setup.preview.defaultBid') }}
              </th>
              <th class="py-space-xs pr-space-md text-right">{{ t('setup.preview.ads') }}</th>
              <th class="py-space-xs pr-space-md text-right">{{ t('setup.preview.targets') }}</th>
              <th class="py-space-xs pr-space-md text-right">
                {{ t('setup.preview.negatives') }}
              </th>
              <th class="py-space-xs"><span class="sr-only">—</span></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(campaign, index) in campaigns"
              :key="campaign.name"
              data-setup-campaign
              class="border-t border-line align-top"
            >
              <td class="py-space-xs pr-space-md">
                <span data-campaign-name class="break-words font-data text-ink">{{
                  campaign.name
                }}</span>
              </td>
              <td class="py-space-xs pr-space-md text-ink-secondary">
                {{ campaign.adProduct }} · {{ blockLabel(campaign.block) }}
              </td>
              <td class="py-space-xs pr-space-md text-right">
                <input
                  v-if="editable"
                  v-model="campaign.dailyBudget"
                  inputmode="decimal"
                  :aria-label="t('setup.preview.budgetLabel', { name: campaign.name })"
                  :aria-invalid="!amountValid(campaign.dailyBudget)"
                  :class="[inputClass, 'h-9 w-24 text-right font-data tabular-nums']"
                />
                <span v-else class="font-data tabular-nums">{{ money(campaign.dailyBudget) }}</span>
              </td>
              <td class="py-space-xs pr-space-md text-right">
                <input
                  v-if="editable"
                  v-model="campaign.adGroup.defaultBid"
                  inputmode="decimal"
                  :aria-label="t('setup.preview.bidLabel', { name: campaign.name })"
                  :aria-invalid="!amountValid(campaign.adGroup.defaultBid)"
                  :class="[inputClass, 'h-9 w-24 text-right font-data tabular-nums']"
                />
                <span v-else class="font-data tabular-nums">{{
                  money(campaign.adGroup.defaultBid)
                }}</span>
              </td>
              <td class="py-space-xs pr-space-md text-right font-data tabular-nums">
                {{ formatNumber(String(campaign.ads.length), locale) }}
              </td>
              <td class="py-space-xs pr-space-md text-right font-data tabular-nums">
                {{ formatNumber(String(campaign.targets.length), locale) }}
              </td>
              <td class="py-space-xs pr-space-md text-right font-data tabular-nums">
                {{ formatNumber(String(campaign.negatives.length), locale) }}
              </td>
              <td class="py-space-xs text-right">
                <Button
                  v-if="editable"
                  icon="pi pi-times"
                  severity="secondary"
                  variant="text"
                  size="small"
                  :aria-label="t('setup.preview.remove', { name: campaign.name })"
                  @click="removeCampaign(index)"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="!allAmountsValid" role="alert" class="text-body-sm text-on-loss-wash">
        {{ t('setup.preview.invalidAmount') }}
      </p>

      <!-- Zustand neuer Kampagnen (F6), Name, Speichern und Übermitteln -->
      <div class="flex flex-col gap-space-sm">
        <label class="flex items-center gap-space-xs text-body-md text-ink">
          <input v-model="paused" data-setup-paused type="checkbox" :disabled="!editable" />
          {{ t('setup.state.label') }}
        </label>
        <p
          data-setup-state-note
          :class="[
            'rounded-control px-space-md py-space-xs text-body-sm',
            paused ? 'bg-well text-ink-secondary' : 'bg-violet-wash text-ink',
          ]"
        >
          {{ t(paused ? 'setup.state.paused' : 'setup.state.active') }}
        </p>
      </div>
      <div class="flex flex-wrap items-end gap-space-md">
        <div class="flex min-w-0 flex-1 basis-64 flex-col gap-space-xs">
          <label :for="`${id}-name`" :class="labelClass">{{ t('setup.name') }}</label>
          <input
            :id="`${id}-name`"
            v-model="name"
            data-setup-name
            type="text"
            maxlength="120"
            :disabled="!editable"
            :class="inputClass"
          />
        </div>
        <Button
          v-if="editable"
          data-setup-save
          icon="pi pi-save"
          severity="secondary"
          :label="t('setup.save')"
          :disabled="!canSave || planStale"
          :loading="save.isPending.value"
          @click="saveDraft"
        />
      </div>
      <div v-if="editable" class="flex flex-wrap items-end gap-space-md">
        <div class="flex min-w-0 flex-col gap-space-xs">
          <label :for="`${id}-channel`" :class="labelClass">{{ t('setup.channel') }}</label>
          <select :id="`${id}-channel`" v-model="channel" data-setup-channel :class="inputClass">
            <option value="bulk_file">{{ t('setup.channelBulk') }}</option>
            <option value="api">{{ t('setup.channelApi') }}</option>
          </select>
        </div>
        <Button
          data-setup-submit
          icon="pi pi-send"
          :label="t('setup.submit')"
          :disabled="!canSave || planStale || hasErrors"
          :loading="submit.isPending.value || save.isPending.value"
          @click="submitDraft"
        />
        <Button
          v-if="draftId"
          icon="pi pi-trash"
          severity="secondary"
          variant="text"
          :label="t('setup.discard')"
          :loading="discard.isPending.value"
          @click="discardDraft"
        />
      </div>
      <p v-if="editable" class="text-body-sm text-ink-secondary">{{ t('setup.submitHint') }}</p>
    </template>

    <p v-if="notice" role="status" class="text-body-sm text-ink-secondary">{{ notice }}</p>
    <InlineError v-if="actionErrorKey" :message="t(actionErrorKey)" />
    <div v-if="rejected.length" data-setup-issues role="alert" class="flex flex-col gap-space-xs">
      <p class="text-body-sm font-semibold text-on-loss-wash">{{ t('setup.rejected') }}</p>
      <ul class="flex flex-col gap-space-xs">
        <li
          v-for="(issue, index) in rejected"
          :key="index"
          class="rounded-control bg-loss-wash px-space-md py-space-xs text-body-sm text-on-loss-wash"
        >
          {{ issueText(t, te, issue, blockLabel) }}
        </li>
      </ul>
    </div>
    <div
      v-if="submitted"
      data-setup-submitted
      role="status"
      class="flex flex-col gap-space-xs rounded-control bg-violet-wash p-space-md text-body-sm text-ink"
    >
      <p>
        {{
          t(submitted.channel === 'api' ? 'setup.submittedApi' : 'setup.submitted', {
            items: formatNumber(String(submitted.items), locale),
          })
        }}
      </p>
      <p v-if="submitted.unsupported">
        {{
          t(
            'setup.unsupported',
            { count: formatNumber(String(submitted.unsupported), locale) },
            submitted.unsupported,
          )
        }}
      </p>
      <RouterLink
        :to="{ path: '/ads/changes', query: { tab: 'submissions', submission: submitted.id } }"
        class="font-semibold text-violet underline"
      >
        {{ t('setup.toChanges') }}
      </RouterLink>
    </div>

    <div class="flex justify-end">
      <Button
        severity="secondary"
        variant="text"
        :label="t('setup.close')"
        @click="emit('close')"
      />
    </div>
  </section>
</template>
