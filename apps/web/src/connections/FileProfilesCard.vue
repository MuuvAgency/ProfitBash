<script setup lang="ts">
import type { Client, Profile, ProfilePatch } from '@profitbash/shared';
import Button from 'primevue/button';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import InlineError from '../components/common/InlineError.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import FileImportsDialog from './FileImportsDialog.vue';
import FileImportWatcher from './FileImportWatcher.vue';
import ProfileGrid from './ProfileGrid.vue';
import { useFileProfilesQuery, useRefreshFileProfiles } from './queries';

/** Profile ohne Connection (`phase-1.md` 1.11a); ihre Daten kommen per Datei-Import. */
const props = defineProps<{ clients: Client[]; clientsReady: boolean; showRemoved: boolean }>();
const emit = defineEmits<{
  create: [];
  patch: [profile: Profile, patch: ProfilePatch];
  createClient: [profile: Profile];
}>();

const { t } = useI18n();
const profilesQuery = useFileProfilesQuery();
const allProfiles = computed(() => profilesQuery.data.value ?? []);
// Heute setzt nichts `removedAt` an Datei-Profilen; der Filter gilt wie bei den Connections für später (1.11d).
const profiles = computed(() =>
  props.showRemoved ? allProfiles.value : allProfiles.value.filter((p) => !p.removedAt),
);

/** Profil des Dialogs „Dateien“; aus der Liste gelesen, damit „Letzter Import“ nach dem Neuladen stimmt. */
const filesProfileId = ref<string | null>(null);
const filesProfile = computed(
  () => allProfiles.value.find((p) => p.id === filesProfileId.value) ?? null,
);

/** Hochgeladene Dateien bis zum Ende ihres Imports verfolgen, auch nach dem Schließen des Dialogs. */
const refreshFileProfiles = useRefreshFileProfiles();
const uploads = ref<{ profileId: string; importId: string }[]>([]);
function onUploaded(profileId: string, importId: string) {
  uploads.value = [...uploads.value, { profileId, importId }];
}
function onImportDone(importId: string) {
  uploads.value = uploads.value.filter((u) => u.importId !== importId);
  void refreshFileProfiles();
}
</script>

<template>
  <section
    class="flex flex-col gap-space-lg rounded-tile bg-tile p-space-lg shadow-tile"
    :aria-label="t('connections.fileProfiles.title')"
  >
    <header class="flex flex-col gap-space-md lg:flex-row lg:items-start lg:justify-between">
      <div class="flex min-w-0 items-start gap-space-md">
        <span
          class="flex size-12 shrink-0 items-center justify-center rounded-control bg-panel text-on-panel"
          aria-hidden="true"
        >
          <i class="pi pi-file-import text-headline-sm" />
        </span>
        <div class="flex min-w-0 flex-col gap-space-xs">
          <h2 class="text-headline-sm text-ink">{{ t('connections.fileProfiles.title') }}</h2>
          <p class="text-body-sm text-ink-secondary">
            {{ t('connections.fileProfiles.description') }}
          </p>
        </div>
      </div>
      <Button
        :label="t('connections.fileProfiles.create')"
        icon="pi pi-plus"
        severity="secondary"
        variant="outlined"
        class="shrink-0"
        @click="emit('create')"
      />
    </header>

    <div v-if="profilesQuery.isPending.value" class="flex flex-col gap-space-sm" aria-busy="true">
      <SkeletonBlock v-for="n in 2" :key="n" height="2.5rem" />
    </div>
    <InlineError
      v-else-if="profilesQuery.isError.value"
      :message="t('connections.fileProfiles.loadError')"
      retryable
      :retrying="profilesQuery.isFetching.value"
      @retry="profilesQuery.refetch()"
    />
    <p v-else-if="profiles.length === 0" class="text-body-md text-ink-secondary">
      {{
        allProfiles.length === 0
          ? t('connections.fileProfiles.empty')
          : t('connections.fileProfiles.emptyFiltered')
      }}
    </p>
    <div
      v-else
      class="-mx-space-lg overflow-x-auto"
      role="region"
      :aria-label="t('connections.fileProfiles.title')"
    >
      <ProfileGrid
        :profiles="profiles"
        :clients="clients"
        :clients-ready="clientsReady"
        file-imports
        @open-files="(profile) => (filesProfileId = profile.id)"
        @patch="(profile, patch) => emit('patch', profile, patch)"
        @create-client="(profile) => emit('createClient', profile)"
      />
    </div>
    <FileImportsDialog
      :profile="filesProfile"
      @close="filesProfileId = null"
      @uploaded="onUploaded"
      @finished="refreshFileProfiles"
    />
    <FileImportWatcher
      v-for="upload in uploads"
      :key="upload.importId"
      :profile-id="upload.profileId"
      :import-id="upload.importId"
      @done="onImportDone(upload.importId)"
    />
  </section>
</template>
