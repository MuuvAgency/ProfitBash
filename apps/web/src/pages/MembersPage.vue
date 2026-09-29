<script setup lang="ts">
import { formatDate, ORG_ROLES, type Member, type OrgRole } from '@profitbash/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import Select from 'primevue/select';
import { computed, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../api';
import InlineError from '../components/common/InlineError.vue';
import PageHeader from '../components/common/PageHeader.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import { errorMessageKey } from '../i18n';
import { useSessionStore } from '../stores/session';

/**
 * Mitglieder (`phase-2.md` F9, 2.10, nur Org-Admins): Liste mit Rolle und Status, anlegen mit einmaligem Link zum Setzen
 * des Passworts (ohne E-Mail-Versand: der Admin gibt den Link selbst weiter), Rolle ändern, Link neu erzeugen, entfernen.
 * Den letzten Admin und das eigene Konto schützt der Server.
 */
const { t } = useI18n();
const id = useId();
const session = useSessionStore();
const queryClient = useQueryClient();
const locale = computed(() => session.preferences.locale);

const queryKey = ['members'] as const;
const members = useQuery({ queryKey, queryFn: () => api.members.list() });
const invalidate = () => queryClient.invalidateQueries({ queryKey });
const errorText = (error: unknown) =>
  t(errorMessageKey(error instanceof ApiError ? error.code : 'UNKNOWN'));

const roleOptions = computed(() =>
  ORG_ROLES.map((role) => ({ value: role, label: t(`account.role.${role}`) })),
);

const statusLabel = (member: Member) =>
  member.status === 'pending'
    ? t('members.status.pending', { date: formatDate(member.linkExpiresAt, locale.value) })
    : t(`members.status.${member.status}`);
const statusDot: Record<Member['status'], string> = {
  active: 'bg-lime',
  pending: 'bg-warn',
  expired: 'bg-loss',
};

// --- Zeilenaktionen ----------------------------------------------------------------------

const rowError = ref<{ memberId: string; message: string } | null>(null);

const changeRole = useMutation({
  mutationFn: ({ member, role }: { member: Member; role: OrgRole }) =>
    api.members.updateRole(member.id, role),
  onSuccess: () => {
    rowError.value = null;
    return invalidate();
  },
  onError: (error, { member }) => {
    rowError.value = { memberId: member.id, message: errorText(error) };
    // Auswahl zurück auf den gespeicherten Stand.
    void invalidate();
  },
});

/** Link, der gerade angezeigt wird (nur einmal sichtbar). */
const shownLink = ref<{ name: string; url: string; expiresAt: string } | null>(null);
const copied = ref(false);

const renewLink = useMutation({
  mutationFn: (member: Member) => api.members.renewLink(member.id),
  onSuccess: (link, member) => {
    rowError.value = null;
    shownLink.value = { name: member.name, ...link };
    copied.value = false;
    return invalidate();
  },
  onError: (error, member) => (rowError.value = { memberId: member.id, message: errorText(error) }),
});

/** Rückfrage vor Aktionen mit Folgen: neuer Link für ein aktives Konto, eigene Rolle herabsetzen. */
const pendingConfirm = ref<
  { kind: 'renew'; member: Member } | { kind: 'demoteSelf'; member: Member; role: OrgRole } | null
>(null);

function onRenew(member: Member) {
  if (member.status === 'active') pendingConfirm.value = { kind: 'renew', member };
  else renewLink.mutate(member);
}
function onRole(member: Member, role: OrgRole) {
  if (member.isSelf && member.role === 'admin' && role !== 'admin') {
    pendingConfirm.value = { kind: 'demoteSelf', member, role };
  } else changeRole.mutate({ member, role });
}
function confirmPending() {
  const pending = pendingConfirm.value;
  pendingConfirm.value = null;
  if (pending?.kind === 'renew') renewLink.mutate(pending.member);
  else if (pending) changeRole.mutate({ member: pending.member, role: pending.role });
}

async function copyLink() {
  if (!shownLink.value) return;
  try {
    await navigator.clipboard.writeText(shownLink.value.url);
    copied.value = true;
  } catch {
    copied.value = false;
  }
}

// --- Anlegen -----------------------------------------------------------------------------

const createOpen = ref(false);
const form = ref<{ email: string; name: string; role: OrgRole }>({
  email: '',
  name: '',
  role: 'editor',
});
const createError = ref<string | null>(null);

function openCreate() {
  form.value = { email: '', name: '', role: 'editor' };
  createError.value = null;
  createOpen.value = true;
}

const create = useMutation({
  mutationFn: () =>
    api.members.create({
      email: form.value.email.trim(),
      name: form.value.name.trim(),
      role: form.value.role,
    }),
  onSuccess: async ({ member, link }) => {
    createOpen.value = false;
    shownLink.value = { name: member.name, ...link };
    copied.value = false;
    await invalidate();
  },
  onError: (error) => (createError.value = errorText(error)),
});

function submitCreate() {
  if (!form.value.email.trim() || !form.value.name.trim()) {
    createError.value = t('members.create.required');
    return;
  }
  createError.value = null;
  create.mutate();
}

// --- Entfernen ---------------------------------------------------------------------------

const toRemove = ref<Member | null>(null);
const removeError = ref<string | null>(null);
const remove = useMutation({
  mutationFn: (member: Member) => api.members.remove(member.id),
  onSuccess: async () => {
    toRemove.value = null;
    await invalidate();
  },
  onError: (error) => (removeError.value = errorText(error)),
});
function askRemove(member: Member) {
  removeError.value = null;
  toRemove.value = member;
}
</script>

<template>
  <div class="flex flex-col gap-gutter">
    <PageHeader
      :eyebrow="t('members.eyebrow')"
      :title="t('nav.members')"
      :description="t('members.description')"
    >
      <template #actions>
        <Button
          data-member-create
          icon="pi pi-user-plus"
          :label="t('members.create.button')"
          size="small"
          @click="openCreate"
        />
      </template>
    </PageHeader>

    <section
      class="flex flex-col gap-space-md rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg"
    >
      <InlineError
        v-if="members.isError.value && !members.data.value"
        :message="t('members.loadFailed')"
        retryable
        :retrying="members.isFetching.value"
        @retry="members.refetch()"
      />
      <div v-else-if="!members.data.value" class="flex flex-col gap-space-sm" aria-busy="true">
        <SkeletonBlock v-for="n in 4" :key="n" height="3rem" />
      </div>
      <p v-else-if="members.data.value.length === 0" class="text-body-sm text-ink-secondary">
        {{ t('members.empty') }}
      </p>
      <template v-else>
        <div
          class="hidden grid-cols-[minmax(0,2fr)_11rem_minmax(0,1.4fr)_auto] gap-space-md border-b border-line px-space-sm pb-space-sm text-label-eyebrow uppercase text-ink-tertiary md:grid"
          aria-hidden="true"
        >
          <span>{{ t('members.column.member') }}</span>
          <span>{{ t('members.column.role') }}</span>
          <span>{{ t('members.column.status') }}</span>
          <span class="sr-only">{{ t('members.column.actions') }}</span>
        </div>
        <ul :aria-label="t('nav.members')" class="flex flex-col">
          <li
            v-for="member in members.data.value"
            :key="member.id"
            :data-member="member.email"
            class="grid grid-cols-1 gap-space-sm rounded-control px-space-sm py-space-md odd:bg-well/50 md:grid-cols-[minmax(0,2fr)_11rem_minmax(0,1.4fr)_auto] md:items-center md:gap-space-md"
          >
            <div class="flex min-w-0 flex-col">
              <span class="truncate text-body-md font-medium text-ink">
                {{ member.name }}
                <span v-if="member.isSelf" class="text-body-sm font-normal text-ink-tertiary">
                  {{ t('members.self') }}
                </span>
              </span>
              <span class="break-all font-data text-data-sm text-ink-secondary">{{
                member.email
              }}</span>
            </div>
            <div>
              <Select
                :model-value="member.role"
                :options="roleOptions"
                option-label="label"
                option-value="value"
                size="small"
                fluid
                :aria-label="t('members.roleOf', { name: member.name })"
                :disabled="changeRole.isPending.value"
                @update:model-value="(role: OrgRole) => onRole(member, role)"
              />
            </div>
            <span class="flex items-center gap-space-sm text-body-sm text-ink">
              <span
                :class="['size-2 shrink-0 rounded-full', statusDot[member.status]]"
                aria-hidden="true"
              />
              {{ statusLabel(member) }}
            </span>
            <div class="flex items-center gap-space-xs md:justify-end">
              <Button
                icon="pi pi-link"
                :label="t('members.renewLink')"
                severity="secondary"
                text
                size="small"
                :aria-label="t('members.renewLinkFor', { name: member.name })"
                :loading="renewLink.isPending.value && renewLink.variables.value?.id === member.id"
                @click="onRenew(member)"
              />
              <Button
                v-if="!member.isSelf"
                icon="pi pi-trash"
                severity="danger"
                text
                rounded
                size="small"
                :aria-label="t('members.removeFor', { name: member.name })"
                @click="askRemove(member)"
              />
            </div>
            <InlineError
              v-if="rowError?.memberId === member.id"
              :message="rowError.message"
              class="md:col-span-4"
            />
          </li>
        </ul>
      </template>
    </section>

    <!-- Anlegen -->
    <Dialog
      v-model:visible="createOpen"
      modal
      :closable="!create.isPending.value"
      :header="t('members.create.title')"
      :style="{ width: 'min(28rem, calc(100vw - 2rem))' }"
    >
      <form class="flex flex-col gap-space-lg" novalidate @submit.prevent="submitCreate">
        <InlineError v-if="createError" :message="createError" />
        <div class="flex flex-col gap-space-sm">
          <label :for="`${id}-email`" class="text-body-sm font-semibold text-ink">
            {{ t('members.create.email') }}
          </label>
          <InputText
            :id="`${id}-email`"
            v-model="form.email"
            data-member-email
            type="email"
            autocomplete="off"
            inputmode="email"
            fluid
            class="font-data"
          />
        </div>
        <div class="flex flex-col gap-space-sm">
          <label :for="`${id}-name`" class="text-body-sm font-semibold text-ink">
            {{ t('members.create.name') }}
          </label>
          <InputText
            :id="`${id}-name`"
            v-model="form.name"
            data-member-name
            autocomplete="off"
            fluid
          />
        </div>
        <div class="flex flex-col gap-space-sm">
          <label :for="`${id}-role`" class="text-body-sm font-semibold text-ink">
            {{ t('members.create.role') }}
          </label>
          <Select
            v-model="form.role"
            :input-id="`${id}-role`"
            :options="roleOptions"
            option-label="label"
            option-value="value"
            fluid
          />
        </div>
        <p class="text-body-sm text-ink-secondary">{{ t('members.create.hint') }}</p>
        <div class="flex justify-end gap-space-sm">
          <Button
            type="button"
            :label="t('common.cancel')"
            severity="secondary"
            text
            :disabled="create.isPending.value"
            @click="createOpen = false"
          />
          <Button
            type="submit"
            data-member-submit
            :label="t('members.create.submit')"
            :loading="create.isPending.value"
          />
        </div>
      </form>
    </Dialog>

    <!-- Link (nur einmal sichtbar) -->
    <Dialog
      :visible="shownLink !== null"
      modal
      :header="t('members.link.title', { name: shownLink?.name ?? '' })"
      :style="{ width: 'min(34rem, calc(100vw - 2rem))' }"
      @update:visible="(visible) => !visible && (shownLink = null)"
    >
      <div v-if="shownLink" class="flex flex-col gap-space-lg">
        <p class="text-body-md text-ink">
          {{ t('members.link.text', { date: formatDate(shownLink.expiresAt, locale) }) }}
        </p>
        <div class="flex flex-col gap-space-sm">
          <label :for="`${id}-link`" class="text-body-sm font-semibold text-ink">
            {{ t('members.link.label') }}
          </label>
          <InputText
            :id="`${id}-link`"
            data-member-link
            :model-value="shownLink.url"
            readonly
            fluid
            class="font-data text-data-sm"
            @focus="($event.target as HTMLInputElement).select()"
          />
        </div>
        <p v-if="copied" role="status" class="text-body-sm text-lime-deep">
          {{ t('members.link.copied') }}
        </p>
        <div class="flex justify-end gap-space-sm">
          <Button :label="t('common.close')" severity="secondary" text @click="shownLink = null" />
          <Button icon="pi pi-copy" :label="t('members.link.copy')" @click="copyLink" />
        </div>
      </div>
    </Dialog>

    <!-- Rückfrage -->
    <Dialog
      :visible="pendingConfirm !== null"
      modal
      :header="pendingConfirm ? t(`members.confirm.${pendingConfirm.kind}.title`) : ''"
      :style="{ width: 'min(28rem, calc(100vw - 2rem))' }"
      @update:visible="(visible) => !visible && (pendingConfirm = null)"
    >
      <div v-if="pendingConfirm" class="flex flex-col gap-space-lg">
        <p class="text-body-md text-ink">
          {{
            t(`members.confirm.${pendingConfirm.kind}.text`, { name: pendingConfirm.member.name })
          }}
        </p>
        <div class="flex justify-end gap-space-sm">
          <Button
            :label="t('common.cancel')"
            severity="secondary"
            text
            @click="pendingConfirm = null"
          />
          <Button
            data-member-confirm
            :label="t(`members.confirm.${pendingConfirm.kind}.action`)"
            @click="confirmPending"
          />
        </div>
      </div>
    </Dialog>

    <!-- Entfernen -->
    <Dialog
      :visible="toRemove !== null"
      modal
      :closable="!remove.isPending.value"
      :header="t('members.remove.title')"
      :style="{ width: 'min(28rem, calc(100vw - 2rem))' }"
      @update:visible="(visible) => !visible && (toRemove = null)"
    >
      <div v-if="toRemove" class="flex flex-col gap-space-lg">
        <InlineError v-if="removeError" :message="removeError" />
        <p class="text-body-md text-ink">{{ t('members.remove.text', { name: toRemove.name }) }}</p>
        <div class="flex justify-end gap-space-sm">
          <Button
            :label="t('common.cancel')"
            severity="secondary"
            text
            :disabled="remove.isPending.value"
            @click="toRemove = null"
          />
          <Button
            data-member-remove-confirm
            :label="t('members.remove.confirm')"
            severity="danger"
            :loading="remove.isPending.value"
            @click="remove.mutate(toRemove)"
          />
        </div>
      </div>
    </Dialog>
  </div>
</template>
