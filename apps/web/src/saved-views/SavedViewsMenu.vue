<script setup lang="ts">
import {
  MAX_SAVED_VIEW_NAME_LENGTH,
  type SavedView,
  type SavedViewArea,
  type SavedViewState,
} from '@profitbash/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import Popover from 'primevue/popover';
import { computed, ref, useId, useTemplateRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { api, ApiError } from '../api';
import InlineError from '../components/common/InlineError.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import { errorMessageKey } from '../i18n';
import { useSessionStore } from '../stores/session';
import { matchingView } from './view-state';

/**
 * Menü „Ansichten“ (`phase-2.md` F8, 2.9) für Dashboard und Explorer: speichern, laden, umbenennen, aktuellen Stand
 * übernehmen, freigeben, Link kopieren, löschen. Viewer speichern nur persönlich. Ein Link mit `?view=<id>` lädt die
 * Ansicht, sobald die Seite bereit ist. Laden übernimmt die Seite (`apply`), wie selbst eingestellt.
 */
const props = defineProps<{
  area: SavedViewArea;
  /** Aktueller Zustand; `null`, solange die Seite nicht bereit ist. */
  current: SavedViewState | null;
  /** Pfad für „Link kopieren“ (`/dashboard`, `/ads/explorer`). */
  linkPath: string;
}>();
const emit = defineEmits<{ apply: [view: SavedView] }>();

const { t } = useI18n();
const id = useId();
const route = useRoute();
const router = useRouter();
const session = useSessionStore();
const queryClient = useQueryClient();
const popover = useTemplateRef<InstanceType<typeof Popover>>('popover');
const open = ref(false);

const feature = computed(() => (props.area === 'dashboard' ? 'dashboard' : 'sp-explorer'));
/** Freigeben: Recht `write` im Feature des Bereichs (Editor, Admin). */
const canShareNew = computed(() => session.me?.features[feature.value]?.write ?? false);

const queryKey = computed(() => ['saved-views', props.area] as const);
const views = useQuery({
  queryKey,
  queryFn: () => api.savedViews.list(props.area),
  staleTime: 60_000,
});
const own = computed(() => views.data.value?.filter((v) => v.own) ?? []);
const team = computed(() => views.data.value?.filter((v) => !v.own) ?? []);
const active = computed(() =>
  props.current && views.data.value ? matchingView(views.data.value, props.current) : null,
);

const notice = ref<string | null>(null);

function apply(view: SavedView) {
  popover.value?.hide();
  notice.value = view.hiddenItems > 0 ? t('savedViews.hiddenItems', view.hiddenItems) : null;
  emit('apply', view);
}

// --- Link mit ?view=<id> -------------------------------------------------------------------

const pendingViewId = computed(() => {
  const value = route.query.view;
  return typeof value === 'string' ? value : null;
});
/** Erst laden, wenn die Seite bereit ist (sonst überschriebe deren Ausgangszustand die Ansicht); jede ID nur einmal. */
const viewToLoad = computed(() => (props.current !== null ? pendingViewId.value : null));
let loadedViewId: string | null = null;
watch(
  viewToLoad,
  async (viewId) => {
    if (!viewId || viewId === loadedViewId) return;
    loadedViewId = viewId;
    try {
      apply(await api.savedViews.get(viewId));
    } catch {
      notice.value = t('savedViews.linkNotFound');
      const { view: _view, ...query } = route.query;
      void router.replace({ path: route.path, query, state: history.state as never });
    }
  },
  { immediate: true },
);

// --- Dialog: speichern, umbenennen, löschen -------------------------------------------------

type DialogMode = { kind: 'create' } | { kind: 'rename' | 'delete'; view: SavedView };
const dialog = ref<DialogMode | null>(null);
const name = ref('');
const shared = ref(false);
const dialogError = ref<string | null>(null);

function openDialog(mode: DialogMode) {
  popover.value?.hide();
  dialog.value = mode;
  name.value = mode.kind === 'create' ? '' : mode.view.name;
  shared.value = false;
  dialogError.value = null;
}

const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKey.value });
const errorText = (error: unknown) =>
  t(errorMessageKey(error instanceof ApiError ? error.code : 'UNKNOWN'));

const save = useMutation({
  mutationFn: async (mode: DialogMode) => {
    if (mode.kind === 'delete') return api.savedViews.remove(mode.view.id);
    if (mode.kind === 'rename') return api.savedViews.update(mode.view.id, { name: name.value });
    return api.savedViews.create({
      name: name.value,
      area: props.area,
      shared: shared.value,
      state: props.current!,
    });
  },
  onSuccess: async () => {
    dialog.value = null;
    await invalidate();
  },
  onError: (error) => (dialogError.value = errorText(error)),
});

function submit() {
  const mode = dialog.value;
  if (!mode) return;
  if (mode.kind !== 'delete' && !name.value.trim()) {
    dialogError.value = t('savedViews.nameRequired');
    return;
  }
  if (mode.kind === 'create' && !props.current) return;
  dialogError.value = null;
  save.mutate(mode);
}

// --- Aktionen in der Liste ------------------------------------------------------------------

const actionError = ref<string | null>(null);
const change = useMutation({
  mutationFn: ({
    view,
    patch,
  }: {
    view: SavedView;
    patch: Parameters<typeof api.savedViews.update>[1];
  }) => api.savedViews.update(view.id, patch),
  onSuccess: () => {
    actionError.value = null;
    return invalidate();
  },
  onError: (error) => (actionError.value = errorText(error)),
});

function overwrite(view: SavedView) {
  if (props.current) change.mutate({ view, patch: { state: props.current } });
}
function toggleShared(view: SavedView) {
  change.mutate({ view, patch: { shared: !view.shared } });
}

const copied = ref<string | null>(null);
async function copyLink(view: SavedView) {
  const url = new URL(
    router.resolve({ path: props.linkPath, query: { view: view.id } }).href,
    location.origin,
  );
  try {
    await navigator.clipboard.writeText(url.href);
    copied.value = view.id;
    setTimeout(() => (copied.value = copied.value === view.id ? null : copied.value), 2000);
  } catch {
    actionError.value = t('savedViews.copyFailed');
  }
}

const dialogTitle = computed(() => {
  const mode = dialog.value;
  if (!mode) return '';
  return t(`savedViews.dialog.${mode.kind}`);
});
</script>

<template>
  <div class="flex flex-col items-end gap-space-xs">
    <Button
      data-saved-views
      :label="active ? active.name : t('savedViews.button')"
      icon="pi pi-bookmark"
      icon-pos="left"
      severity="secondary"
      size="small"
      aria-haspopup="dialog"
      :aria-expanded="open"
      @click="popover?.toggle($event)"
    />
    <p
      v-if="notice"
      role="status"
      class="flex items-center gap-space-xs text-body-sm text-ink-secondary"
    >
      <i class="pi pi-info-circle text-warn" aria-hidden="true" />{{ notice }}
      <button
        type="button"
        class="text-ink-tertiary hover:text-ink"
        :aria-label="t('savedViews.dismiss')"
        @click="notice = null"
      >
        <i class="pi pi-times text-[0.625rem]" aria-hidden="true" />
      </button>
    </p>

    <Popover
      ref="popover"
      :aria-label="t('savedViews.title')"
      @show="open = true"
      @hide="open = false"
    >
      <div class="flex w-[min(22rem,calc(100vw-3rem))] flex-col gap-space-md p-space-xs">
        <h2 class="text-headline-sm text-ink">{{ t('savedViews.title') }}</h2>

        <InlineError
          v-if="views.isError.value && !views.data.value"
          :message="t('savedViews.loadFailed')"
          retryable
          :retrying="views.isFetching.value"
          @retry="views.refetch()"
        />
        <div v-else-if="!views.data.value" class="flex flex-col gap-space-sm" aria-busy="true">
          <SkeletonBlock v-for="n in 3" :key="n" height="2rem" />
        </div>
        <p v-else-if="views.data.value.length === 0" class="text-body-sm text-ink-secondary">
          {{ t('savedViews.empty') }}
        </p>
        <template v-else>
          <InlineError v-if="actionError" :message="actionError" />
          <section
            v-for="group in [
              { key: 'own', label: t('savedViews.own'), items: own },
              { key: 'team', label: t('savedViews.team'), items: team },
            ].filter((g) => g.items.length > 0)"
            :key="group.key"
            class="flex flex-col gap-space-xs"
          >
            <h3 class="text-label-eyebrow uppercase text-ink-tertiary">{{ group.label }}</h3>
            <ul class="flex flex-col">
              <li
                v-for="view in group.items"
                :key="view.id"
                :data-saved-view="view.id"
                class="flex items-center gap-space-xs rounded-control hover:bg-well"
              >
                <button
                  type="button"
                  class="flex min-h-11 min-w-0 flex-1 flex-col items-start px-space-sm text-left"
                  :aria-current="active?.id === view.id ? 'true' : undefined"
                  @click="apply(view)"
                >
                  <span class="flex max-w-full items-center gap-space-xs text-body-sm text-ink">
                    <i
                      v-if="active?.id === view.id"
                      class="pi pi-check text-[0.75rem] text-violet"
                      aria-hidden="true"
                    />
                    <span class="truncate">{{ view.name }}</span>
                    <i
                      v-if="view.shared && view.own"
                      v-tooltip="t('savedViews.sharedHint')"
                      class="pi pi-users text-[0.75rem] text-ink-tertiary"
                      :aria-label="t('savedViews.sharedHint')"
                    />
                  </span>
                  <span v-if="!view.own" class="text-body-sm text-ink-tertiary">
                    {{ t('savedViews.by', { name: view.owner.name }) }}
                  </span>
                </button>
                <div class="flex shrink-0 items-center">
                  <Button
                    icon="pi pi-link"
                    text
                    rounded
                    size="small"
                    severity="secondary"
                    :aria-label="
                      copied === view.id
                        ? t('savedViews.copied')
                        : t('savedViews.copyLink', { name: view.name })
                    "
                    @click="copyLink(view)"
                  />
                  <template v-if="view.canEdit">
                    <Button
                      icon="pi pi-refresh"
                      text
                      rounded
                      size="small"
                      severity="secondary"
                      :disabled="!current || change.isPending.value"
                      :aria-label="t('savedViews.overwrite', { name: view.name })"
                      @click="overwrite(view)"
                    />
                    <Button
                      v-if="view.canShare || view.shared"
                      :icon="view.shared ? 'pi pi-user' : 'pi pi-users'"
                      text
                      rounded
                      size="small"
                      severity="secondary"
                      :disabled="change.isPending.value"
                      :aria-label="
                        view.shared
                          ? t('savedViews.unshare', { name: view.name })
                          : t('savedViews.share', { name: view.name })
                      "
                      @click="toggleShared(view)"
                    />
                    <Button
                      icon="pi pi-pencil"
                      text
                      rounded
                      size="small"
                      severity="secondary"
                      :aria-label="t('savedViews.rename', { name: view.name })"
                      @click="openDialog({ kind: 'rename', view })"
                    />
                    <Button
                      icon="pi pi-trash"
                      text
                      rounded
                      size="small"
                      severity="danger"
                      :aria-label="t('savedViews.delete', { name: view.name })"
                      @click="openDialog({ kind: 'delete', view })"
                    />
                  </template>
                </div>
              </li>
            </ul>
          </section>
        </template>

        <Button
          data-saved-views-create
          icon="pi pi-plus"
          :label="t('savedViews.saveCurrent')"
          size="small"
          :disabled="!current"
          @click="openDialog({ kind: 'create' })"
        />
      </div>
    </Popover>

    <Dialog
      :visible="dialog !== null"
      modal
      :closable="!save.isPending.value"
      :header="dialogTitle"
      :style="{ width: 'min(26rem, calc(100vw - 2rem))' }"
      @update:visible="(visible) => !visible && (dialog = null)"
    >
      <form class="flex flex-col gap-space-lg" novalidate @submit.prevent="submit">
        <InlineError v-if="dialogError" :message="dialogError" />
        <p v-if="dialog?.kind === 'delete'" class="text-body-md text-ink">
          {{ t('savedViews.deleteConfirm', { name: dialog.view.name }) }}
        </p>
        <template v-else>
          <div class="flex flex-col gap-space-sm">
            <label :for="`${id}-name`" class="text-body-sm font-semibold text-ink">
              {{ t('savedViews.name') }}
            </label>
            <InputText
              :id="`${id}-name`"
              v-model="name"
              data-saved-view-name
              autocomplete="off"
              :maxlength="MAX_SAVED_VIEW_NAME_LENGTH"
              fluid
              autofocus
            />
          </div>
          <label
            v-if="dialog?.kind === 'create' && canShareNew"
            class="flex min-h-11 items-center gap-space-sm text-body-sm text-ink"
          >
            <input
              v-model="shared"
              type="checkbox"
              data-saved-view-shared
              class="size-4 accent-violet"
            />
            {{ t('savedViews.shareWithTeam') }}
          </label>
          <p v-else-if="dialog?.kind === 'create'" class="text-body-sm text-ink-secondary">
            {{ t('savedViews.personalOnly') }}
          </p>
        </template>
        <div class="flex justify-end gap-space-sm">
          <Button
            type="button"
            :label="t('common.cancel')"
            severity="secondary"
            text
            :disabled="save.isPending.value"
            @click="dialog = null"
          />
          <Button
            type="submit"
            data-saved-view-submit
            :label="dialog?.kind === 'delete' ? t('savedViews.deleteAction') : t('common.save')"
            :severity="dialog?.kind === 'delete' ? 'danger' : undefined"
            :loading="save.isPending.value"
          />
        </div>
      </form>
    </Dialog>
  </div>
</template>
