<script setup lang="ts">
import { formatDate, type Client, type Member } from '@profitbash/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import { computed, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../api';
import InlineError from '../components/common/InlineError.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import { errorMessageKey } from '../i18n';
import { useActiveOrgId, useSessionStore } from '../stores/session';

/**
 * Kundenzugang eines Clients (`phase-6.md` 6.3c, F3): Kunden-Nutzer anlegen (nur lesend, sehen nur diesen Client in
 * Dashboard und Explorer), Link zum Passwort-Setzen neu erzeugen, Zugang entziehen. Ohne E-Mail-Versand: Der Admin gibt
 * den Link selbst weiter, wie in der Mitgliederverwaltung.
 */
const props = defineProps<{
  /** `null` = geschlossen. */
  client: Client | null;
}>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const id = useId();
const session = useSessionStore();
const orgId = useActiveOrgId();
const queryClient = useQueryClient();
const locale = computed(() => session.preferences.locale);
const clientId = computed(() => props.client?.id ?? null);

const queryKey = computed(() => ['client-access', orgId.value, clientId.value] as const);
const users = useQuery({
  queryKey,
  queryFn: () => api.clientAccess.list(clientId.value!),
  enabled: computed(() => clientId.value !== null),
});
const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKey.value });
const errorText = (error: unknown) =>
  t(errorMessageKey(error instanceof ApiError ? error.code : 'UNKNOWN'));

const statusLabel = (member: Member) =>
  member.status === 'pending'
    ? t('members.status.pending', { date: formatDate(member.linkExpiresAt, locale.value) })
    : t(`members.status.${member.status}`);
const statusDot: Record<Member['status'], string> = {
  active: 'bg-lime',
  pending: 'bg-warn',
  expired: 'bg-loss',
};

const form = ref({ email: '', name: '' });
const error = ref<string | null>(null);
/** Link, der gerade angezeigt wird (nur einmal sichtbar). */
const shownLink = ref<{ name: string; url: string; expiresAt: string } | null>(null);
const copied = ref(false);
/** Mitglied, dessen Entziehen gerade bestätigt werden soll. */
const removingId = ref<string | null>(null);

function showLink(name: string, link: { url: string; expiresAt: string }) {
  shownLink.value = { name, ...link };
  copied.value = false;
  error.value = null;
}

watch(clientId, () => {
  form.value = { email: '', name: '' };
  error.value = null;
  shownLink.value = null;
  removingId.value = null;
});

const create = useMutation({
  mutationFn: () =>
    api.clientAccess.create(clientId.value!, {
      email: form.value.email.trim(),
      name: form.value.name.trim(),
    }),
  onSuccess: async ({ member, link }) => {
    showLink(member.name, link);
    form.value = { email: '', name: '' };
    await invalidate();
  },
  onError: (cause) => (error.value = errorText(cause)),
});

function submit() {
  if (!form.value.email.trim() || !form.value.name.trim()) {
    error.value = t('members.create.required');
    return;
  }
  error.value = null;
  create.mutate();
}

const renewLink = useMutation({
  mutationFn: (member: Member) => api.clientAccess.renewLink(clientId.value!, member.id),
  onSuccess: (link, member) => {
    showLink(member.name, link);
    return invalidate();
  },
  onError: (cause) => (error.value = errorText(cause)),
});

const remove = useMutation({
  mutationFn: (member: Member) => api.clientAccess.remove(clientId.value!, member.id),
  onSuccess: async () => {
    removingId.value = null;
    shownLink.value = null;
    error.value = null;
    await invalidate();
  },
  onError: (cause) => (error.value = errorText(cause)),
});

async function copyLink() {
  if (!shownLink.value) return;
  try {
    await navigator.clipboard.writeText(shownLink.value.url);
    copied.value = true;
  } catch {
    copied.value = false;
  }
}
</script>

<template>
  <Dialog
    :visible="client !== null"
    modal
    :header="t('connections.clientAccess.title', { client: client?.name ?? '' })"
    :style="{ width: 'min(36rem, calc(100vw - 2rem))' }"
    @update:visible="(visible) => !visible && emit('close')"
  >
    <div class="flex flex-col gap-space-lg">
      <p class="text-body-sm text-ink-secondary">{{ t('connections.clientAccess.description') }}</p>

      <InlineError
        v-if="users.isError.value && !users.data.value"
        :message="t('connections.clientAccess.loadFailed')"
        retryable
        :retrying="users.isFetching.value"
        @retry="users.refetch()"
      />
      <div v-else-if="!users.data.value" class="flex flex-col gap-space-sm" aria-busy="true">
        <SkeletonBlock v-for="n in 2" :key="n" height="3rem" />
      </div>
      <p v-else-if="users.data.value.length === 0" class="text-body-sm text-ink-secondary">
        {{ t('connections.clientAccess.empty') }}
      </p>
      <ul v-else :aria-label="t('connections.clientAccess.list')" class="flex flex-col">
        <li
          v-for="member in users.data.value"
          :key="member.id"
          class="flex flex-col gap-space-sm rounded-control px-space-sm py-space-sm odd:bg-well/50"
        >
          <div class="flex flex-col gap-space-sm sm:flex-row sm:items-center sm:justify-between">
            <div class="flex min-w-0 flex-col">
              <span class="truncate text-body-md font-medium text-ink">{{ member.name }}</span>
              <span class="break-all font-data text-data-sm text-ink-secondary">{{
                member.email
              }}</span>
              <span class="flex items-center gap-space-sm text-body-sm text-ink">
                <span
                  :class="['size-2 shrink-0 rounded-full', statusDot[member.status]]"
                  aria-hidden="true"
                />
                {{ statusLabel(member) }}
              </span>
            </div>
            <div class="flex shrink-0 items-center gap-space-xs">
              <Button
                icon="pi pi-link"
                :label="t('members.renewLink')"
                severity="secondary"
                text
                size="small"
                :aria-label="t('members.renewLinkFor', { name: member.name })"
                :loading="renewLink.isPending.value && renewLink.variables.value?.id === member.id"
                @click="renewLink.mutate(member)"
              />
              <Button
                icon="pi pi-trash"
                severity="danger"
                text
                rounded
                size="small"
                :aria-label="t('connections.clientAccess.removeFor', { name: member.name })"
                @click="removingId = member.id"
              />
            </div>
          </div>
          <div
            v-if="removingId === member.id"
            class="flex flex-col gap-space-sm rounded-control bg-well p-space-sm"
          >
            <p class="text-body-sm text-ink">
              {{ t('connections.clientAccess.removeText', { name: member.name }) }}
            </p>
            <div class="flex justify-end gap-space-sm">
              <Button
                :label="t('common.cancel')"
                severity="secondary"
                text
                size="small"
                :disabled="remove.isPending.value"
                @click="removingId = null"
              />
              <Button
                data-client-access-remove-confirm
                :label="t('connections.clientAccess.removeConfirm')"
                severity="danger"
                size="small"
                :loading="remove.isPending.value"
                @click="remove.mutate(member)"
              />
            </div>
          </div>
        </li>
      </ul>

      <!-- Link (nur einmal sichtbar) -->
      <div
        v-if="shownLink"
        class="flex flex-col gap-space-sm rounded-control bg-violet-wash p-space-md"
      >
        <p class="text-body-sm text-ink">
          {{ t('members.link.text', { date: formatDate(shownLink.expiresAt, locale) }) }}
        </p>
        <label :for="`${id}-link`" class="text-body-sm font-semibold text-ink">
          {{ t('members.link.title', { name: shownLink.name }) }}
        </label>
        <InputText
          :id="`${id}-link`"
          data-client-access-link
          :model-value="shownLink.url"
          readonly
          fluid
          class="font-data text-data-sm"
          @focus="($event.target as HTMLInputElement).select()"
        />
        <p v-if="copied" role="status" class="text-body-sm text-lime-deep">
          {{ t('members.link.copied') }}
        </p>
        <Button
          icon="pi pi-copy"
          :label="t('members.link.copy')"
          size="small"
          class="self-end"
          @click="copyLink"
        />
      </div>

      <form class="flex flex-col gap-space-md" novalidate @submit.prevent="submit">
        <h3 class="text-body-md font-semibold text-ink">
          {{ t('connections.clientAccess.addTitle') }}
        </h3>
        <InlineError v-if="error" :message="error" />
        <div class="grid grid-cols-1 gap-space-md sm:grid-cols-2">
          <div class="flex flex-col gap-space-sm">
            <label :for="`${id}-email`" class="text-body-sm font-semibold text-ink">
              {{ t('members.create.email') }}
            </label>
            <InputText
              :id="`${id}-email`"
              v-model="form.email"
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
              data-client-access-name
              autocomplete="off"
              fluid
            />
          </div>
        </div>
        <p class="text-body-sm text-ink-secondary">{{ t('members.create.hint') }}</p>
        <div class="flex justify-end gap-space-sm">
          <Button
            type="button"
            :label="t('common.close')"
            severity="secondary"
            text
            @click="emit('close')"
          />
          <Button
            type="submit"
            icon="pi pi-user-plus"
            :label="t('connections.clientAccess.add')"
            :loading="create.isPending.value"
          />
        </div>
      </form>
    </div>
  </Dialog>
</template>
