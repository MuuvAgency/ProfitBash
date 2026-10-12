<script setup lang="ts">
import {
  CUSTOMER_ORG_FEATURES,
  FEATURE_KEYS,
  formatDateTime,
  type FeatureKey,
  type PlatformOrganization,
  type PlatformStaff,
} from '@profitbash/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import Button from 'primevue/button';
import Checkbox from 'primevue/checkbox';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import { computed, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { api, ApiError } from '../api';
import InlineError from '../components/common/InlineError.vue';
import PageHeader from '../components/common/PageHeader.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import { errorMessageKey } from '../i18n';
import { useSessionStore } from '../stores/session';

/**
 * Plattform-Admin (`phase-6.md` 6.4, F5; nur Superadmins): Reiter Orgs (Liste, anlegen, umbenennen), Entitlements
 * (Features je Organisation) und Staff (Plattform-Rolle vergeben und entziehen, Protokoll). Den letzten Superadmin
 * und die Features für Kunden-Orgs schützt der Server.
 */
const { t, te } = useI18n();
const id = useId();
const route = useRoute();
const router = useRouter();
const session = useSessionStore();
const queryClient = useQueryClient();
const locale = computed(() => session.preferences.locale);
const errorText = (error: unknown) =>
  t(errorMessageKey(error instanceof ApiError ? error.code : 'UNKNOWN'));

// --- Reiter (im Pfad: `/admin/platform/staff`) ---------------------------------------------

const TABS = ['orgs', 'entitlements', 'staff'] as const;
const tab = computed(() => {
  const wanted = [route.params.subpath].flat()[0];
  return TABS.find((name) => name === wanted) ?? 'orgs';
});
const tabId = (name: string) => `${id}-tab-${name}`;
const openTab = (name: (typeof TABS)[number]) => router.replace(`/admin/platform/${name}`);
async function moveTab(step: number) {
  const next = TABS[(TABS.indexOf(tab.value) + step + TABS.length) % TABS.length]!;
  await openTab(next);
  document.getElementById(tabId(next))?.focus();
}

// --- Organisationen ------------------------------------------------------------------------

const orgsKey = ['platform', 'organizations'] as const;
const orgs = useQuery({ queryKey: orgsKey, queryFn: () => api.platform.organizations() });
/** Jede Änderung antwortet mit der geänderten Organisation. */
function storeOrg(next: PlatformOrganization) {
  queryClient.setQueryData<PlatformOrganization[]>(orgsKey, (list = []) =>
    list.some((org) => org.id === next.id)
      ? list.map((org) => (org.id === next.id ? next : org))
      : [...list, next],
  );
}

/** Dialog zum Anlegen (`org` leer) oder Umbenennen. */
const nameDialog = ref<{ org: PlatformOrganization | null; name: string } | null>(null);
const nameError = ref<string | null>(null);
function openNameDialog(org: PlatformOrganization | null) {
  nameError.value = null;
  nameDialog.value = { org, name: org?.name ?? '' };
}
const saveName = useMutation({
  mutationFn: ({ org, name }: { org: PlatformOrganization | null; name: string }) =>
    org ? api.platform.renameOrganization(org.id, name) : api.platform.createOrganization(name),
  onSuccess: async (next, { org }) => {
    storeOrg(next);
    nameDialog.value = null;
    // Der Anlegende ist Mitglied der neuen Organisation: Sie gehört ins Account-Menü.
    if (!org) await session.reload();
  },
  onError: (error) => (nameError.value = errorText(error)),
});
function submitName() {
  const dialog = nameDialog.value;
  if (!dialog) return;
  const name = dialog.name.trim();
  if (!name) {
    nameError.value = t('platform.orgs.nameRequired');
    return;
  }
  nameError.value = null;
  saveName.mutate({ org: dialog.org, name });
}

// Mitglieder einer Organisation (aufklappbar) und „Als Nutzer ansehen“ (6.5).
const openOrgId = ref<string | null>(null);
const orgMembers = useQuery({
  queryKey: computed(() => ['platform', 'members', openOrgId.value] as const),
  queryFn: () => api.platform.members(openOrgId.value!),
  enabled: computed(() => openOrgId.value !== null),
});
const impersonateError = ref<string | null>(null);
const impersonate = useMutation({
  mutationFn: (userId: string) => api.platform.startImpersonation(userId),
  onSuccess: async () => {
    // Ab jetzt gilt die Session des Nutzers: nichts vom Superadmin Geladenes behalten.
    queryClient.clear();
    await session.reload();
    await router.replace('/');
  },
  onError: (error) => (impersonateError.value = errorText(error)),
});

// --- Entitlements --------------------------------------------------------------------------

const featureLabel = (feature: string) => {
  const path = `platform.feature.${feature.replace(/-/g, '_')}`;
  return te(path) ? t(path) : feature;
};
const featuresFor = (org: PlatformOrganization): readonly FeatureKey[] =>
  org.customerOrg ? CUSTOMER_ORG_FEATURES : FEATURE_KEYS;
const entitlementError = ref<{ orgId: string; message: string } | null>(null);
const setEntitlements = useMutation({
  mutationFn: ({ org, features }: { org: PlatformOrganization; features: FeatureKey[] }) =>
    api.platform.setEntitlements(org.id, features),
  onSuccess: (next) => {
    entitlementError.value = null;
    storeOrg(next);
  },
  onError: (error, { org }) => {
    entitlementError.value = { orgId: org.id, message: errorText(error) };
    // Häkchen zurück auf den gespeicherten Stand.
    void queryClient.invalidateQueries({ queryKey: orgsKey });
  },
});
function toggleFeature(org: PlatformOrganization, feature: FeatureKey, enabled: boolean) {
  const current = featuresFor(org).filter((key) => org.features.includes(key));
  const features = enabled ? [...current, feature] : current.filter((key) => key !== feature);
  setEntitlements.mutate({ org, features });
}

// --- Staff ---------------------------------------------------------------------------------

const staffKey = ['platform', 'staff'] as const;
const eventsKey = ['platform', 'audit-events'] as const;
const onStaffTab = computed(() => tab.value === 'staff');
const staff = useQuery({
  queryKey: staffKey,
  queryFn: () => api.platform.staff(),
  enabled: onStaffTab,
});
const eventPages = useInfiniteQuery({
  queryKey: eventsKey,
  queryFn: ({ pageParam }) => api.platform.auditEvents(pageParam),
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last) => last.nextCursor ?? undefined,
  enabled: onStaffTab,
  staleTime: 0,
});
const events = computed(() => eventPages.data.value?.pages.flatMap((page) => page.events));
const refreshStaff = () =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: staffKey }),
    queryClient.invalidateQueries({ queryKey: eventsKey }),
  ]);

const grantEmail = ref('');
const grantError = ref<string | null>(null);
const grant = useMutation({
  mutationFn: (email: string) => api.platform.grantStaff(email),
  onSuccess: async () => {
    grantEmail.value = '';
    await refreshStaff();
  },
  onError: (error) => (grantError.value = errorText(error)),
});
function submitGrant() {
  const email = grantEmail.value.trim();
  if (!email) {
    grantError.value = t('platform.staff.emailRequired');
    return;
  }
  grantError.value = null;
  grant.mutate(email);
}

const toRevoke = ref<PlatformStaff | null>(null);
const revokeError = ref<string | null>(null);
const revoke = useMutation({
  mutationFn: (member: PlatformStaff) => api.platform.revokeStaff(member.id),
  onSuccess: async (_result, member) => {
    toRevoke.value = null;
    // Eigene Rolle abgegeben: `/api/me` neu laden, der Guard führt von der Seite weg.
    if (member.isSelf) {
      await session.reload();
      await router.replace('/');
    } else await refreshStaff();
  },
  onError: (error) => (revokeError.value = errorText(error)),
});
function askRevoke(member: PlatformStaff) {
  revokeError.value = null;
  toRevoke.value = member;
}

const actionLabel = (action: string) => {
  const path = `audit.action.${action.replace('.', ':')}`;
  return te(path) ? t(path) : action;
};
</script>

<template>
  <div class="flex flex-col gap-gutter">
    <PageHeader
      :eyebrow="t('platform.eyebrow')"
      :title="t('nav.platform')"
      :description="t('platform.description')"
    >
      <template v-if="tab === 'orgs'" #actions>
        <Button
          data-platform-org-create
          icon="pi pi-plus"
          :label="t('platform.orgs.create')"
          size="small"
          @click="openNameDialog(null)"
        />
      </template>
    </PageHeader>

    <div
      role="tablist"
      :aria-label="t('platform.tabsLabel')"
      class="flex gap-space-xs overflow-x-auto"
    >
      <button
        v-for="name in TABS"
        :id="tabId(name)"
        :key="name"
        type="button"
        role="tab"
        :aria-controls="`${id}-panel`"
        :aria-selected="tab === name"
        :tabindex="tab === name ? 0 : -1"
        :class="[
          'whitespace-nowrap rounded-control px-space-md py-space-sm text-body-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-violet',
          tab === name
            ? 'bg-violet-wash font-semibold text-violet'
            : 'text-ink-secondary hover:bg-violet-wash hover:text-ink',
        ]"
        @click="openTab(name)"
        @keydown.right.prevent="moveTab(1)"
        @keydown.left.prevent="moveTab(-1)"
      >
        {{ t(`platform.tabs.${name}`) }}
      </button>
    </div>

    <div
      :id="`${id}-panel`"
      role="tabpanel"
      :aria-labelledby="tabId(tab)"
      class="flex flex-col gap-gutter"
    >
      <!-- Orgs und Entitlements teilen die Liste der Organisationen. -->
      <section
        v-if="tab !== 'staff'"
        class="flex flex-col gap-space-md rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg"
      >
        <InlineError
          v-if="orgs.isError.value && !orgs.data.value"
          :message="t('platform.orgs.loadError')"
          retryable
          :retrying="orgs.isFetching.value"
          @retry="orgs.refetch()"
        />
        <div v-else-if="!orgs.data.value" class="flex flex-col gap-space-sm" aria-busy="true">
          <SkeletonBlock v-for="n in 3" :key="n" height="3rem" />
        </div>
        <p v-else-if="orgs.data.value.length === 0" class="text-body-sm text-ink-secondary">
          {{ t('platform.orgs.empty') }}
        </p>

        <ul v-else-if="tab === 'orgs'" :aria-label="t('platform.orgs.label')" class="flex flex-col">
          <li
            v-for="org in orgs.data.value"
            :key="org.id"
            :data-platform-org="org.slug"
            class="flex flex-wrap items-center gap-x-space-md gap-y-space-xs rounded-control px-space-sm py-space-md odd:bg-well/50"
          >
            <div class="flex min-w-0 flex-1 basis-48 flex-col">
              <span class="truncate text-body-md font-medium text-ink">{{ org.name }}</span>
              <span class="break-all font-data text-data-sm text-ink-secondary">{{
                org.slug
              }}</span>
            </div>
            <span class="text-body-sm text-ink">
              {{ org.customerOrg ? t('platform.orgs.customer') : t('platform.orgs.agency') }}
              <span v-if="org.client" class="text-ink-secondary">
                · {{ t('platform.orgs.client', { name: org.client.name }) }}
              </span>
            </span>
            <span class="font-data text-data-sm tabular-nums text-ink-secondary">
              {{ t('platform.orgs.members', org.memberCount) }}
            </span>
            <Button
              data-platform-org-members
              :icon="openOrgId === org.id ? 'pi pi-chevron-up' : 'pi pi-users'"
              :label="t('platform.orgs.showMembers')"
              severity="secondary"
              text
              size="small"
              :aria-expanded="openOrgId === org.id"
              :aria-label="t('platform.orgs.membersOf', { name: org.name })"
              @click="openOrgId = openOrgId === org.id ? null : org.id"
            />
            <Button
              data-platform-org-rename
              icon="pi pi-pencil"
              :label="t('platform.orgs.rename')"
              severity="secondary"
              text
              size="small"
              :aria-label="t('platform.orgs.renameFor', { name: org.name })"
              @click="openNameDialog(org)"
            />
            <div v-if="openOrgId === org.id" class="flex basis-full flex-col gap-space-sm">
              <InlineError
                v-if="orgMembers.isError.value"
                :message="t('platform.orgs.membersLoadError')"
                retryable
                :retrying="orgMembers.isFetching.value"
                @retry="orgMembers.refetch()"
              />
              <SkeletonBlock v-else-if="!orgMembers.data.value" height="2.5rem" />
              <p
                v-else-if="orgMembers.data.value.length === 0"
                class="text-body-sm text-ink-secondary"
              >
                {{ t('platform.orgs.membersEmpty') }}
              </p>
              <ul
                v-else
                :aria-label="t('platform.orgs.membersOf', { name: org.name })"
                class="flex flex-col divide-y divide-line"
              >
                <li
                  v-for="member in orgMembers.data.value"
                  :key="member.userId"
                  :data-platform-member="member.email"
                  class="flex flex-wrap items-center gap-x-space-md gap-y-space-xs py-space-sm"
                >
                  <div class="flex min-w-0 flex-1 basis-48 flex-col">
                    <span class="truncate text-body-sm font-medium text-ink">{{
                      member.name
                    }}</span>
                    <span class="break-all font-data text-data-sm text-ink-secondary">{{
                      member.email
                    }}</span>
                  </div>
                  <span class="text-body-sm text-ink-secondary">
                    {{
                      te(`account.role.${member.role}`)
                        ? t(`account.role.${member.role}`)
                        : member.role
                    }}
                    <template v-if="member.superadmin">
                      · {{ t('platform.orgs.superadmin') }}
                    </template>
                  </span>
                  <Button
                    v-if="!member.superadmin"
                    data-platform-impersonate
                    icon="pi pi-eye"
                    :label="t('platform.orgs.impersonate')"
                    severity="secondary"
                    text
                    size="small"
                    :aria-label="t('platform.orgs.impersonateFor', { name: member.name })"
                    :loading="
                      impersonate.isPending.value && impersonate.variables.value === member.userId
                    "
                    @click="impersonate.mutate(member.userId)"
                  />
                </li>
              </ul>
              <InlineError v-if="impersonateError" :message="impersonateError" />
            </div>
          </li>
        </ul>

        <template v-else>
          <p class="text-body-sm text-ink-secondary">{{ t('platform.entitlements.hint') }}</p>
          <ul :aria-label="t('platform.orgs.label')" class="flex flex-col">
            <li
              v-for="org in orgs.data.value"
              :key="org.id"
              :data-platform-entitlements="org.slug"
              class="flex flex-col gap-space-sm rounded-control px-space-sm py-space-md odd:bg-well/50"
            >
              <div class="flex flex-col">
                <span class="text-body-md font-medium text-ink">{{ org.name }}</span>
                <span v-if="org.customerOrg" class="text-body-sm text-ink-secondary">
                  {{ t('platform.entitlements.customerHint') }}
                </span>
              </div>
              <div
                role="group"
                :aria-label="t('platform.entitlements.groupLabel', { name: org.name })"
                class="flex flex-wrap gap-x-space-lg gap-y-space-sm"
              >
                <span
                  v-for="feature in featuresFor(org)"
                  :key="feature"
                  :data-feature="feature"
                  class="flex items-center gap-space-sm"
                >
                  <Checkbox
                    :input-id="`${id}-${org.id}-${feature}`"
                    binary
                    :model-value="org.features.includes(feature)"
                    :disabled="setEntitlements.isPending.value"
                    @update:model-value="(on: boolean) => toggleFeature(org, feature, on)"
                  />
                  <label :for="`${id}-${org.id}-${feature}`" class="text-body-sm text-ink">
                    {{ featureLabel(feature) }}
                  </label>
                </span>
              </div>
              <InlineError
                v-if="entitlementError?.orgId === org.id"
                :message="entitlementError.message"
              />
            </li>
          </ul>
        </template>
      </section>

      <template v-else>
        <section
          class="flex flex-col gap-space-md rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg"
        >
          <InlineError
            v-if="staff.isError.value && !staff.data.value"
            :message="t('platform.staff.loadError')"
            retryable
            :retrying="staff.isFetching.value"
            @retry="staff.refetch()"
          />
          <div v-else-if="!staff.data.value" class="flex flex-col gap-space-sm" aria-busy="true">
            <SkeletonBlock v-for="n in 2" :key="n" height="3rem" />
          </div>
          <ul v-else :aria-label="t('platform.staff.label')" class="flex flex-col">
            <li
              v-for="member in staff.data.value"
              :key="member.id"
              :data-platform-staff="member.email"
              class="flex flex-wrap items-center gap-space-sm rounded-control px-space-sm py-space-md odd:bg-well/50"
            >
              <div class="flex min-w-0 flex-1 basis-48 flex-col">
                <span class="truncate text-body-md font-medium text-ink">
                  {{ member.name }}
                  <span v-if="member.isSelf" class="text-body-sm font-normal text-ink-tertiary">
                    {{ t('platform.staff.self') }}
                  </span>
                </span>
                <span class="break-all font-data text-data-sm text-ink-secondary">{{
                  member.email
                }}</span>
              </div>
              <Button
                data-platform-staff-revoke
                icon="pi pi-user-minus"
                :label="t('platform.staff.revoke')"
                severity="danger"
                text
                size="small"
                :aria-label="t('platform.staff.revokeFor', { name: member.name })"
                @click="askRevoke(member)"
              />
            </li>
          </ul>

          <form
            class="flex flex-col gap-space-sm border-t border-line pt-space-md"
            novalidate
            @submit.prevent="submitGrant"
          >
            <label :for="`${id}-staff-email`" class="text-body-sm font-semibold text-ink">
              {{ t('platform.staff.email') }}
            </label>
            <div class="flex flex-wrap gap-space-sm">
              <InputText
                :id="`${id}-staff-email`"
                v-model="grantEmail"
                data-platform-staff-email
                type="email"
                autocomplete="off"
                inputmode="email"
                class="min-w-0 flex-1 basis-64 font-data"
              />
              <Button
                type="submit"
                data-platform-staff-submit
                icon="pi pi-user-plus"
                :label="t('platform.staff.grant')"
                :loading="grant.isPending.value"
              />
            </div>
            <p class="text-body-sm text-ink-secondary">{{ t('platform.staff.grantHint') }}</p>
            <InlineError v-if="grantError" :message="grantError" />
          </form>
        </section>

        <section
          data-platform-events
          class="flex flex-col gap-space-md rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg"
        >
          <h2 class="text-headline-sm text-ink">{{ t('platform.staff.events') }}</h2>
          <InlineError
            v-if="eventPages.isError.value && !events"
            :message="t('platform.staff.eventsLoadError')"
            retryable
            :retrying="eventPages.isFetching.value"
            @retry="eventPages.refetch()"
          />
          <div v-else-if="!events" class="flex flex-col gap-space-sm" aria-busy="true">
            <SkeletonBlock v-for="n in 2" :key="n" height="2rem" />
          </div>
          <p v-else-if="events.length === 0" class="text-body-sm text-ink-secondary">
            {{ t('platform.staff.eventsEmpty') }}
          </p>
          <ul v-else class="flex flex-col divide-y divide-line">
            <li
              v-for="event in events"
              :key="event.id"
              class="grid gap-x-space-md gap-y-space-xs py-space-sm md:grid-cols-[13rem_14rem_1fr]"
            >
              <span class="font-data text-body-sm text-ink-secondary">
                {{ formatDateTime(event.createdAt, locale) }}
              </span>
              <span class="min-w-0 truncate text-body-sm" :title="event.actor?.email">
                {{ event.actor?.name ?? t('audit.system') }}
              </span>
              <span class="min-w-0 break-words text-body-md">
                {{ actionLabel(event.action) }}
                <span v-if="typeof event.target.email === 'string'" class="text-ink-secondary">
                  · {{ event.target.email }}
                </span>
              </span>
            </li>
          </ul>
          <div v-if="eventPages.hasNextPage.value" class="flex justify-center">
            <Button
              :label="t('audit.loadMore')"
              variant="text"
              size="small"
              :loading="eventPages.isFetchingNextPage.value"
              @click="eventPages.fetchNextPage()"
            />
          </div>
          <InlineError
            v-if="eventPages.isError.value && events"
            :message="t('platform.staff.eventsLoadError')"
          />
        </section>
      </template>
    </div>

    <!-- Anlegen und Umbenennen -->
    <Dialog
      :visible="nameDialog !== null"
      modal
      :closable="!saveName.isPending.value"
      :header="nameDialog?.org ? t('platform.orgs.renameTitle') : t('platform.orgs.create')"
      :style="{ width: 'min(28rem, calc(100vw - 2rem))' }"
      @update:visible="(visible) => !visible && (nameDialog = null)"
    >
      <form
        v-if="nameDialog"
        class="flex flex-col gap-space-lg"
        novalidate
        @submit.prevent="submitName"
      >
        <InlineError v-if="nameError" :message="nameError" />
        <div class="flex flex-col gap-space-sm">
          <label :for="`${id}-org-name`" class="text-body-sm font-semibold text-ink">
            {{ t('platform.orgs.name') }}
          </label>
          <InputText
            :id="`${id}-org-name`"
            v-model="nameDialog.name"
            data-platform-org-name
            autocomplete="off"
            maxlength="120"
            fluid
          />
        </div>
        <p v-if="!nameDialog.org" class="text-body-sm text-ink-secondary">
          {{ t('platform.orgs.createHint') }}
        </p>
        <div class="flex justify-end gap-space-sm">
          <Button
            type="button"
            :label="t('common.cancel')"
            severity="secondary"
            text
            :disabled="saveName.isPending.value"
            @click="nameDialog = null"
          />
          <Button
            type="submit"
            data-platform-org-submit
            :label="t('common.save')"
            :loading="saveName.isPending.value"
          />
        </div>
      </form>
    </Dialog>

    <!-- Rolle entziehen -->
    <Dialog
      :visible="toRevoke !== null"
      modal
      :closable="!revoke.isPending.value"
      :header="t('platform.staff.confirmTitle')"
      :style="{ width: 'min(28rem, calc(100vw - 2rem))' }"
      @update:visible="(visible) => !visible && (toRevoke = null)"
    >
      <div v-if="toRevoke" class="flex flex-col gap-space-lg">
        <InlineError v-if="revokeError" :message="revokeError" />
        <p class="text-body-md text-ink">
          {{
            toRevoke.isSelf
              ? t('platform.staff.confirmSelf')
              : t('platform.staff.confirmText', { name: toRevoke.name })
          }}
        </p>
        <div class="flex justify-end gap-space-sm">
          <Button
            :label="t('common.cancel')"
            severity="secondary"
            text
            :disabled="revoke.isPending.value"
            @click="toRevoke = null"
          />
          <Button
            data-platform-staff-confirm
            :label="t('platform.staff.revoke')"
            severity="danger"
            :loading="revoke.isPending.value"
            @click="revoke.mutate(toRevoke)"
          />
        </div>
      </div>
    </Dialog>
  </div>
</template>
