<script setup lang="ts">
import Button from 'primevue/button';
import { computed, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError } from '../../api';
import type { CampaignBlocksData, StructureCatalogData } from '../../api/client';
import InlineError from '../../components/common/InlineError.vue';
import SkeletonBlock from '../../components/common/SkeletonBlock.vue';
import { errorMessageKey } from '../../i18n';
import { useActiveOrgId } from '../../stores/session';
import {
  useCampaignBlocks,
  useProductGroups,
  useSetCampaignBlocks,
  useToolRights,
} from '../queries';
import { inputClass, labelClass } from './draft';

/**
 * Baustein je Kampagne (`phase-5.md` 5.11a): Kampagnen aus einem Setup kennen ihn, für Bestand schlägt der Name einen
 * vor, der erst nach Bestätigung zählt. Gespeichert wird sofort (nicht mit dem Katalog) und gegen den gespeicherten
 * Katalog, wie die Presets je Client.
 */
type Campaign = CampaignBlocksData['campaigns'][number];
const props = defineProps<{ data: StructureCatalogData }>();
const { t } = useI18n();
const id = useId();
const { canWrite } = useToolRights();
// Die sichtbaren Profile kommen mit den Produktgruppen (wie auf den anderen Tools-Seiten).
const groups = useProductGroups();
const profileId = ref<string | null>(null);
watch(useActiveOrgId(), () => (profileId.value = null));
const query = useCampaignBlocks(profileId);
const save = useSetCampaignBlocks();
const errorKey = ref<string | null>(null);

const blocks = computed(() => new Map(props.data.catalog.blocks.map((b) => [b.key, b])));
const blockLabel = (key: string) => blocks.value.get(key)?.label ?? key;
const options = (campaign: Campaign) =>
  props.data.catalog.blocks.filter((block) => block.adProduct === campaign.adProduct);
const campaignName = (campaign: Campaign) => campaign.name ?? t('catalog.campaigns.unnamed');
const campaigns = computed(() => query.data.value?.campaigns ?? []);
const open = computed(() =>
  campaigns.value.filter((c) => c.blockKey === null && c.suggestedBlockKey !== null),
);
const assigned = computed(() => campaigns.value.filter((c) => c.blockKey !== null).length);

async function assign(assignments: { campaignId: string; blockKey: string | null }[]) {
  if (!profileId.value || assignments.length === 0) return;
  errorKey.value = null;
  try {
    await save.mutateAsync({ profileId: profileId.value, assignments });
  } catch (error) {
    errorKey.value = errorMessageKey(error instanceof ApiError ? error.code : 'UNKNOWN');
  }
  // Ändert der Server nichts (Fehler, oder „kein Baustein“ bei einer Kampagne aus dem Setup), zeigt die Auswahl
  // sonst weiter die Eingabe statt des geltenden Werts.
  rendered.value++;
}
const rendered = ref(0);
const confirmAll = () =>
  // Die API nimmt höchstens 500 je Aufruf; der Rest steht danach weiter als Vorschlag da.
  assign(
    open.value
      .slice(0, 500)
      .map((c) => ({ campaignId: c.campaignId, blockKey: c.suggestedBlockKey })),
  );
</script>

<template>
  <section
    class="flex min-w-0 flex-col gap-space-md rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg"
  >
    <p class="max-w-prose text-body-sm text-ink-secondary">
      {{ t('catalog.campaigns.description') }}
    </p>
    <InlineError
      v-if="groups.isError.value"
      :message="t('catalog.campaigns.profilesFailed')"
      retryable
      :retrying="groups.isFetching.value"
      @retry="groups.refetch()"
    />
    <SkeletonBlock v-else-if="!groups.data.value" shape="tile" height="3rem" />
    <div v-else class="flex max-w-md min-w-0 flex-col gap-space-xs">
      <label :for="`${id}-profile`" :class="labelClass">{{ t('catalog.campaigns.profile') }}</label>
      <select :id="`${id}-profile`" v-model="profileId" data-campaign-profile :class="inputClass">
        <option :value="null" disabled>{{ t('catalog.campaigns.chooseProfile') }}</option>
        <option v-for="item in groups.data.value.profiles" :key="item.id" :value="item.id">
          {{ item.accountName }} ({{ item.countryCode }})
        </option>
      </select>
    </div>

    <template v-if="profileId">
      <InlineError v-if="errorKey" :message="t(errorKey)" />
      <InlineError
        v-if="query.isError.value"
        data-campaigns-error
        :message="t('catalog.campaigns.loadFailed')"
        retryable
        :retrying="query.isFetching.value"
        @retry="query.refetch()"
      />
      <SkeletonBlock v-else-if="!query.data.value" shape="tile" height="12rem" />
      <p v-else-if="campaigns.length === 0" class="text-body-md text-ink-secondary">
        {{ t('catalog.campaigns.empty') }}
      </p>
      <template v-else>
        <div class="flex flex-wrap items-center gap-space-md">
          <span class="text-body-sm text-ink-secondary">
            {{ t('catalog.campaigns.summary', { assigned, total: campaigns.length }) }}
          </span>
          <Button
            v-if="canWrite && open.length > 0"
            data-campaign-confirm-all
            class="ml-auto"
            severity="secondary"
            size="small"
            icon="pi pi-check"
            :label="t('catalog.campaigns.confirmAll', { count: open.length })"
            :disabled="save.isPending.value"
            @click="confirmAll"
          />
        </div>
        <p v-if="query.data.value.truncated" class="text-body-sm text-warn">
          {{ t('catalog.campaigns.truncated', { count: campaigns.length }) }}
        </p>
        <ul class="flex flex-col">
          <li
            v-for="campaign in campaigns"
            :key="campaign.campaignId"
            :data-campaign="campaign.campaignId"
            class="flex flex-wrap items-center gap-x-space-md gap-y-space-xs border-b border-line py-space-sm last:border-b-0"
          >
            <div class="flex min-w-0 flex-1 basis-64 flex-col">
              <span class="break-words text-body-md text-ink">{{ campaignName(campaign) }}</span>
              <span class="text-body-sm text-ink-secondary">
                {{ campaign.adProduct }}
                <template v-if="campaign.source">
                  · {{ t(`catalog.campaigns.source.${campaign.source}`) }}
                </template>
                <template v-else-if="campaign.suggestedBlockKey">
                  ·
                  {{
                    t('catalog.campaigns.suggestion', {
                      block: blockLabel(campaign.suggestedBlockKey),
                    })
                  }}
                </template>
              </span>
            </div>
            <Button
              v-if="canWrite && campaign.blockKey === null && campaign.suggestedBlockKey"
              data-campaign-confirm
              severity="secondary"
              variant="text"
              size="small"
              :label="t('catalog.campaigns.confirm')"
              :aria-label="
                t('catalog.campaigns.confirmLabel', {
                  block: blockLabel(campaign.suggestedBlockKey),
                  name: campaignName(campaign),
                })
              "
              :disabled="save.isPending.value"
              @click="
                assign([{ campaignId: campaign.campaignId, blockKey: campaign.suggestedBlockKey }])
              "
            />
            <select
              :key="rendered"
              :value="campaign.blockKey ?? ''"
              :aria-label="t('catalog.campaigns.block', { name: campaignName(campaign) })"
              :disabled="!canWrite || save.isPending.value"
              :class="[inputClass, 'basis-64']"
              @change="
                assign([
                  {
                    campaignId: campaign.campaignId,
                    blockKey: ($event.target as HTMLSelectElement).value || null,
                  },
                ])
              "
            >
              <option value="">{{ t('catalog.campaigns.none') }}</option>
              <option v-for="block in options(campaign)" :key="block.key" :value="block.key">
                {{ block.label }}
              </option>
            </select>
          </li>
        </ul>
      </template>
    </template>
  </section>
</template>
