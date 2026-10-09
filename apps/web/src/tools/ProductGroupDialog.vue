<script setup lang="ts">
import {
  formatNumber,
  MAX_PRODUCT_GROUP_NAME_LENGTH,
  MAX_SKU_LENGTH,
  normalizeProductGroupName,
  productGroupItemKey,
} from '@profitbash/shared';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import { computed, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError } from '../api';
import type { ProductGroupData, ProductGroupListData } from '../api/client';
import InlineError from '../components/common/InlineError.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import { errorMessageKey } from '../i18n';
import { useSessionStore } from '../stores/session';
import { useAdvertisedProducts, useSaveProductGroup, useStructureCatalog } from './queries';

/**
 * Produktgruppe anlegen oder ändern (`phase-4.md` 4.1, F2): Profil (nur beim Anlegen), Name, Produkte aus den
 * beworbenen Produkten des Profils oder von Hand, ein Produkt als Hero. Die SKU-Regel (Seller Pflicht, Vendor keine)
 * prüft die Handeingabe sofort; die API prüft sie noch einmal.
 */
const props = defineProps<{
  /** `null` = neue Gruppe. */
  group: ProductGroupData | null;
  profiles: ProductGroupListData['profiles'];
  clients: ProductGroupListData['clients'];
  /** Alle Gruppen (Namen für „auch in“). */
  groups: ProductGroupData[];
  maxItems: number;
  /** Vorauswahl beim Anlegen (Filter der Seite). */
  initialProfileId: string | null;
}>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const id = useId();
const session = useSessionStore();
type Item = ProductGroupData['items'][number];

const profileId = ref<string | null>(props.group?.profileId ?? props.initialProfileId);
const name = ref(props.group?.name ?? '');
const presetKey = ref<string | null>(props.group?.presetKey ?? null);
const items = ref<Item[]>(props.group ? props.group.items.map((item) => ({ ...item })) : []);
const manualAsin = ref('');
const manualSku = ref('');
const manualErrorKey = ref<string | null>(null);
const profile = computed(() => props.profiles.find((p) => p.id === profileId.value) ?? null);
const clientName = (clientId: string | null) =>
  props.clients.find((client) => client.id === clientId)?.name ?? t('productGroups.noClient');

// Beim Wechsel des Profils (nur beim Anlegen) passen gewählte Produkte nicht mehr.
watch(profileId, (next, previous) => {
  if (previous === undefined || next === previous) return;
  items.value = [];
  // Die SKU-Regel hängt am Profil; ein verstecktes SKU-Feld darf keinen alten Wert behalten.
  manualAsin.value = '';
  manualSku.value = '';
  manualErrorKey.value = null;
});

const keys = computed(() => new Set(items.value.map(productGroupItemKey)));
const heroKey = computed(() => {
  const hero = items.value.find((item) => item.isHero);
  return hero ? productGroupItemKey(hero) : '';
});
function setHero(key: string) {
  for (const item of items.value) item.isHero = productGroupItemKey(item) === key;
}
function removeItem(key: string) {
  items.value = items.value.filter((item) => productGroupItemKey(item) !== key);
}
/** Schlüssel für Attribute im DOM (Tests, Radio-Werte); intern zählt `productGroupItemKey`. */
const domKey = (item: { asin: string; sku: string | null }) => `${item.asin}|${item.sku ?? ''}`;
const full = computed(() => items.value.length >= props.maxItems);

// --- Preset ----------------------------------------------------------------------------

const catalog = useStructureCatalog();
const presets = computed(() => catalog.data.value?.catalog.presets ?? []);
/** Preset, das ohne eigenes gilt: das des Clients, sonst der Standard. */
const inheritedPreset = computed(() => {
  const data = catalog.data.value;
  if (!data) return null;
  const clientKey = data.clientPresets.find(
    (e) => e.clientId === profile.value?.clientId,
  )?.presetKey;
  return (
    data.catalog.presets.find((preset) => preset.key === clientKey) ??
    data.catalog.presets.find((preset) => preset.isDefault) ??
    null
  );
});

// --- Beworbene Produkte --------------------------------------------------------------------

const advertised = useAdvertisedProducts(profileId);
const search = ref('');
const groupNames = computed(() => new Map(props.groups.map((group) => [group.id, group.name])));
const products = computed(() => {
  const query = search.value.trim().toUpperCase();
  return (advertised.data.value?.products ?? []).filter(
    (product) =>
      !query ||
      product.asin.includes(query) ||
      (product.sku?.toUpperCase().includes(query) ?? false),
  );
});
const otherGroups = (groupIds: string[]) =>
  groupIds
    .filter((groupId) => groupId !== props.group?.id)
    .map((groupId) => groupNames.value.get(groupId))
    .filter((groupName): groupName is string => groupName !== undefined);

function togglePick(product: { asin: string; sku: string | null }) {
  const key = productGroupItemKey(product);
  if (keys.value.has(key)) removeItem(key);
  else if (!full.value) items.value.push({ asin: product.asin, sku: product.sku, isHero: false });
}

// --- Handeingabe ---------------------------------------------------------------------------

function addManual() {
  const asin = manualAsin.value.trim().toUpperCase();
  const sku = manualSku.value.trim() || null;
  manualErrorKey.value = null;
  if (!/^[A-Z0-9]{10}$/.test(asin)) manualErrorKey.value = 'productGroups.manual.invalidAsin';
  else if (sku !== null && sku.length > MAX_SKU_LENGTH) {
    manualErrorKey.value = 'productGroups.manual.skuTooLong';
  } else if (profile.value?.accountType === 'seller' && sku === null) {
    manualErrorKey.value = 'productGroups.manual.skuRequired';
  } else if (profile.value?.accountType === 'vendor' && sku !== null) {
    manualErrorKey.value = 'productGroups.manual.skuNotAllowed';
  } else if (keys.value.has(productGroupItemKey({ asin, sku }))) {
    manualErrorKey.value = 'productGroups.manual.duplicate';
  } else if (full.value) {
    manualErrorKey.value = 'productGroups.field.tooMany';
  }
  if (manualErrorKey.value) return;
  items.value.push({ asin, sku, isHero: false });
  manualAsin.value = '';
  manualSku.value = '';
}

// --- Speichern -----------------------------------------------------------------------------

const save = useSaveProductGroup();
const saveErrorKey = ref<string | null>(null);
const cleanName = computed(() => normalizeProductGroupName(name.value));
const nameTooLong = computed(() => cleanName.value.length > MAX_PRODUCT_GROUP_NAME_LENGTH);
const canSave = computed(
  () =>
    profileId.value !== null &&
    cleanName.value.length > 0 &&
    !nameTooLong.value &&
    items.value.length > 0 &&
    items.value.length <= props.maxItems &&
    !save.isPending.value,
);

async function submit() {
  if (!canSave.value) return;
  saveErrorKey.value = null;
  try {
    await save.mutateAsync({
      ...(props.group && { id: props.group.id }),
      profileId: profileId.value!,
      name: cleanName.value,
      presetKey: presetKey.value,
      items: items.value.map(({ asin, sku, isHero }) => ({ asin, sku, isHero })),
    });
    emit('close');
  } catch (error) {
    saveErrorKey.value = errorMessageKey(error instanceof ApiError ? error.code : 'UNKNOWN');
  }
}

const inputClass =
  'h-11 min-w-0 rounded-control bg-well px-space-md text-body-md text-ink outline-none focus-visible:ring-2 focus-visible:ring-violet';
const labelClass = 'text-label-eyebrow uppercase text-ink-tertiary';
</script>

<template>
  <Dialog
    visible
    modal
    :closable="!save.isPending.value"
    :close-on-escape="!save.isPending.value"
    :header="t(group ? 'productGroups.edit.title' : 'productGroups.create')"
    :style="{ width: 'min(44rem, calc(100vw - 2rem))' }"
    @update:visible="(next) => !next && emit('close')"
  >
    <form class="flex flex-col gap-space-lg" @submit.prevent="submit">
      <InlineError v-if="saveErrorKey" :message="t(saveErrorKey)" />

      <div v-if="!group" class="flex flex-col gap-space-xs">
        <label :for="`${id}-profile`" :class="labelClass">{{
          t('productGroups.field.profile')
        }}</label>
        <select :id="`${id}-profile`" v-model="profileId" data-group-profile :class="inputClass">
          <option :value="null" disabled>{{ t('productGroups.field.chooseProfile') }}</option>
          <option v-for="option in profiles" :key="option.id" :value="option.id">
            {{ option.accountName }} ({{ option.countryCode }}) · {{ clientName(option.clientId) }}
          </option>
        </select>
        <p class="text-body-sm text-ink-secondary">{{ t('productGroups.field.profileHint') }}</p>
      </div>
      <p v-else-if="profile" class="text-body-md text-ink-secondary">
        {{ t('productGroups.field.profile') }}: {{ profile.accountName }} ({{
          profile.countryCode
        }}) · {{ clientName(profile.clientId) }}
      </p>

      <div class="flex flex-col gap-space-xs">
        <label :for="`${id}-name`" :class="labelClass">{{ t('productGroups.field.name') }}</label>
        <input
          :id="`${id}-name`"
          v-model="name"
          data-group-name
          type="text"
          autocomplete="off"
          :aria-invalid="nameTooLong ? 'true' : undefined"
          :aria-describedby="nameTooLong ? `${id}-name-hint` : undefined"
          :class="[inputClass, nameTooLong && 'ring-2 ring-loss']"
        />
        <p v-if="nameTooLong" :id="`${id}-name-hint`" class="text-body-sm text-on-loss-wash">
          {{ t('productGroups.field.nameTooLong', { max: MAX_PRODUCT_GROUP_NAME_LENGTH }) }}
        </p>
      </div>

      <div v-if="presets.length > 0" class="flex flex-col gap-space-xs">
        <label :for="`${id}-preset`" :class="labelClass">{{
          t('productGroups.field.preset')
        }}</label>
        <select :id="`${id}-preset`" v-model="presetKey" data-group-preset :class="inputClass">
          <option :value="null">
            {{ t('productGroups.field.presetInherit')
            }}{{ inheritedPreset ? ` (${inheritedPreset.name})` : '' }}
          </option>
          <option v-for="preset in presets" :key="preset.key" :value="preset.key">
            {{ preset.name }}
          </option>
        </select>
        <p class="text-body-sm text-ink-secondary">{{ t('productGroups.field.presetHint') }}</p>
      </div>

      <fieldset class="flex min-w-0 flex-col gap-space-sm">
        <legend :class="['mb-space-xs', labelClass]">{{ t('productGroups.field.items') }}</legend>
        <p class="text-body-sm text-ink-secondary">
          {{ t('productGroups.field.itemsHint', { max: maxItems }) }}
        </p>
        <p v-if="items.length === 0" class="text-body-md text-ink-secondary">
          {{ t('productGroups.field.noItems') }}
        </p>
        <label
          v-if="items.length > 0"
          class="flex min-h-11 items-center gap-space-sm text-body-md text-ink-secondary"
        >
          <input
            type="radio"
            name="group-hero"
            value=""
            :checked="heroKey === ''"
            class="size-4 accent-violet"
            @change="setHero('')"
          />
          {{ t('productGroups.noHero') }}
        </label>
        <ul v-if="items.length > 0" class="flex flex-col rounded-control bg-well px-space-md">
          <li
            v-for="item in items"
            :key="productGroupItemKey(item)"
            data-item
            class="flex min-h-11 items-center gap-x-space-sm border-b border-line py-space-xs last:border-b-0"
          >
            <label
              class="flex min-w-0 flex-1 flex-wrap items-center gap-x-space-sm text-body-md text-ink"
            >
              <input
                type="radio"
                name="group-hero"
                :value="domKey(item)"
                :checked="heroKey === productGroupItemKey(item)"
                :aria-label="`${t('productGroups.field.heroLegend')}: ${item.asin}`"
                class="size-4 accent-violet"
                @change="setHero(productGroupItemKey(item))"
              />
              <span class="font-data tabular-nums">{{ item.asin }}</span>
              <span class="truncate font-data text-body-sm text-ink-secondary">
                {{ item.sku ?? t('productGroups.field.noSku') }}
              </span>
              <span
                v-if="item.isHero"
                class="rounded-full bg-violet-wash px-space-sm text-label-eyebrow uppercase text-violet"
                >{{ t('productGroups.hero') }}</span
              >
            </label>
            <Button
              icon="pi pi-times"
              severity="secondary"
              variant="text"
              size="small"
              type="button"
              :aria-label="t('productGroups.field.removeItem', { asin: item.asin })"
              @click="removeItem(productGroupItemKey(item))"
            />
          </li>
        </ul>
      </fieldset>

      <section class="flex min-w-0 flex-col gap-space-sm">
        <h3 :class="labelClass">{{ t('productGroups.advertised.title') }}</h3>
        <p v-if="!profileId" class="text-body-md text-ink-secondary">
          {{ t('productGroups.advertised.chooseProfileFirst') }}
        </p>
        <InlineError
          v-else-if="advertised.isError.value"
          :message="t('productGroups.advertised.loadFailed')"
          retryable
          :retrying="advertised.isFetching.value"
          @retry="advertised.refetch()"
        />
        <SkeletonBlock v-else-if="!advertised.data.value" shape="tile" height="8rem" />
        <p
          v-else-if="advertised.data.value.products.length === 0"
          class="text-body-md text-ink-secondary"
        >
          {{ t('productGroups.advertised.empty') }}
        </p>
        <template v-else>
          <label :for="`${id}-search`" class="sr-only">{{
            t('productGroups.advertised.search')
          }}</label>
          <input
            :id="`${id}-search`"
            v-model="search"
            data-product-search
            type="search"
            autocomplete="off"
            :placeholder="t('productGroups.advertised.search')"
            :class="inputClass"
          />
          <p v-if="advertised.data.value.truncated" class="text-body-sm text-ink-secondary">
            {{
              t('productGroups.advertised.truncated', {
                count: formatNumber(
                  String(advertised.data.value.products.length),
                  session.preferences.locale,
                ),
              })
            }}
          </p>
          <p v-if="products.length === 0" class="text-body-md text-ink-secondary">
            {{ t('productGroups.advertised.noMatch') }}
          </p>
          <ul
            v-else
            class="flex max-h-64 flex-col overflow-y-auto rounded-control bg-well px-space-md"
          >
            <li
              v-for="product in products"
              :key="productGroupItemKey(product)"
              class="border-b border-line last:border-b-0"
            >
              <label
                class="flex min-h-11 flex-wrap items-center gap-x-space-sm py-space-xs text-body-md text-ink"
              >
                <input
                  type="checkbox"
                  :data-product-pick="domKey(product)"
                  :checked="keys.has(productGroupItemKey(product))"
                  :disabled="full && !keys.has(productGroupItemKey(product))"
                  class="size-4 accent-violet"
                  @change="togglePick(product)"
                />
                <span class="font-data tabular-nums">{{ product.asin }}</span>
                <span class="font-data text-body-sm text-ink-secondary">
                  {{ product.sku ?? t('productGroups.field.noSku') }}
                </span>
                <span v-if="!product.enabled" class="text-body-sm text-ink-tertiary">
                  {{ t('productGroups.advertised.paused') }}
                </span>
                <span
                  v-if="otherGroups(product.groupIds).length > 0"
                  class="text-body-sm text-ink-tertiary"
                >
                  {{
                    t('productGroups.advertised.otherGroups', {
                      names: otherGroups(product.groupIds).join(', '),
                    })
                  }}
                </span>
              </label>
            </li>
          </ul>
        </template>
      </section>

      <section v-if="profileId" class="flex min-w-0 flex-col gap-space-sm">
        <h3 :class="labelClass">{{ t('productGroups.manual.title') }}</h3>
        <div class="flex flex-wrap items-end gap-space-sm">
          <div class="flex min-w-0 flex-1 basis-36 flex-col gap-space-xs">
            <label :for="`${id}-asin`" class="text-body-sm text-ink-secondary">{{
              t('productGroups.manual.asin')
            }}</label>
            <input
              :id="`${id}-asin`"
              v-model="manualAsin"
              data-manual-asin
              type="text"
              autocomplete="off"
              :class="[inputClass, 'font-data']"
              @keydown.enter.prevent="addManual"
            />
          </div>
          <div
            v-if="profile?.accountType !== 'vendor'"
            class="flex min-w-0 flex-1 basis-36 flex-col gap-space-xs"
          >
            <label :for="`${id}-sku`" class="text-body-sm text-ink-secondary">{{
              t('productGroups.manual.sku')
            }}</label>
            <input
              :id="`${id}-sku`"
              v-model="manualSku"
              data-manual-sku
              type="text"
              autocomplete="off"
              :class="[inputClass, 'font-data']"
              @keydown.enter.prevent="addManual"
            />
          </div>
          <Button
            type="button"
            data-manual-add
            icon="pi pi-plus"
            severity="secondary"
            :label="t('productGroups.manual.add')"
            @click="addManual"
          />
        </div>
        <p v-if="manualErrorKey" role="alert" class="text-body-sm text-on-loss-wash">
          {{
            t(manualErrorKey, {
              max: manualErrorKey.endsWith('tooMany') ? maxItems : MAX_SKU_LENGTH,
            })
          }}
        </p>
      </section>

      <div class="flex justify-end gap-space-sm">
        <Button
          type="button"
          :label="t('common.cancel')"
          severity="secondary"
          variant="text"
          :disabled="save.isPending.value"
          @click="emit('close')"
        />
        <Button
          type="submit"
          data-group-save
          :label="t('common.save')"
          :loading="save.isPending.value"
          :disabled="!canSave"
        />
      </div>
    </form>
  </Dialog>
</template>
