<script setup lang="ts">
import { MIN_PASSWORD_LENGTH } from '@profitbash/shared';
import { useQuery } from '@tanstack/vue-query';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { api, ApiError } from '../api';
import BrandMark from '../components/brand/BrandMark.vue';
import InlineError from '../components/common/InlineError.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import { errorMessageKey } from '../i18n';

/**
 * Passwort über den einmaligen Link setzen (`phase-2.md` F9, 2.10), öffentlich, ohne Session. Das Token steht im Fragment
 * (`/set-password#…`), geht nur im Body an die API und wird sofort aus der Adresszeile entfernt (Verlauf, Bildschirmfotos).
 * Danach geht es zur Anmeldung (Dominik, 2026-09-29).
 */
const { t } = useI18n();
const router = useRouter();

const token = ref(globalThis.location?.hash.slice(1) ?? '');
onMounted(() => {
  if (globalThis.location?.hash) {
    history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  }
});

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const info = useQuery({
  queryKey: ['password-link', token],
  queryFn: () => api.passwordLinks.inspect(token.value),
  enabled: TOKEN.test(token.value),
  retry: false,
  staleTime: Infinity,
});

const password = ref('');
const repeat = ref('');
const showPassword = ref(false);
const submitting = ref(false);
const errorKey = ref<string | null>(null);

async function submit() {
  errorKey.value = null;
  if (password.value.length < MIN_PASSWORD_LENGTH) {
    errorKey.value = 'setPassword.tooShort';
    return;
  }
  if (password.value !== repeat.value) {
    errorKey.value = 'setPassword.mismatch';
    return;
  }
  submitting.value = true;
  try {
    await api.passwordLinks.redeem(token.value, password.value);
    await router.replace({ path: '/login', query: { reason: 'passwordSet' } });
  } catch (error) {
    errorKey.value = errorMessageKey(error instanceof ApiError ? error.code : 'UNKNOWN');
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <main class="flex min-h-dvh items-center justify-center bg-canvas p-margin-mobile sm:p-margin">
    <section
      class="flex w-full max-w-md flex-col gap-space-xl rounded-hero bg-tile p-space-xl shadow-raised"
    >
      <BrandMark size="md" />
      <div class="flex flex-col gap-space-xs">
        <h1 class="text-headline-lg text-ink">{{ t('setPassword.heading') }}</h1>
        <p v-if="info.data.value" class="text-body-md text-ink-secondary">
          {{ t('setPassword.for', { name: info.data.value.name }) }}
          <span class="font-data text-data-sm">{{ info.data.value.email }}</span>
        </p>
      </div>

      <InlineError
        v-if="!TOKEN.test(token) || info.isError.value"
        :message="t('setPassword.invalid')"
      />
      <div v-else-if="!info.data.value" class="flex flex-col gap-space-sm" aria-busy="true">
        <SkeletonBlock v-for="n in 3" :key="n" height="2.75rem" />
      </div>
      <form v-else class="flex flex-col gap-space-lg" novalidate @submit.prevent="submit">
        <InlineError v-if="errorKey" :message="t(errorKey, { min: MIN_PASSWORD_LENGTH })" />
        <!-- Benutzername für Passwort-Manager -->
        <input
          type="email"
          class="sr-only"
          autocomplete="username"
          :value="info.data.value.email"
          readonly
          tabindex="-1"
          aria-hidden="true"
        />
        <div class="flex flex-col gap-space-sm">
          <label for="set-password" class="text-body-sm font-semibold text-ink">
            {{ t('setPassword.password') }}
          </label>
          <div class="relative">
            <InputText
              id="set-password"
              v-model="password"
              :type="showPassword ? 'text' : 'password'"
              autocomplete="new-password"
              fluid
              class="pr-12 font-data"
            />
            <Button
              type="button"
              variant="text"
              severity="secondary"
              :icon="showPassword ? 'pi pi-eye-slash' : 'pi pi-eye'"
              :aria-label="showPassword ? t('login.hidePassword') : t('login.showPassword')"
              :aria-pressed="showPassword"
              class="absolute top-1/2 right-1 -translate-y-1/2"
              @click="showPassword = !showPassword"
            />
          </div>
          <p class="text-body-sm text-ink-secondary">
            {{ t('setPassword.hint', { min: MIN_PASSWORD_LENGTH }) }}
          </p>
        </div>
        <div class="flex flex-col gap-space-sm">
          <label for="set-password-repeat" class="text-body-sm font-semibold text-ink">
            {{ t('setPassword.repeat') }}
          </label>
          <InputText
            id="set-password-repeat"
            v-model="repeat"
            :type="showPassword ? 'text' : 'password'"
            autocomplete="new-password"
            fluid
            class="font-data"
          />
        </div>
        <Button
          type="submit"
          data-set-password-submit
          fluid
          :loading="submitting"
          :label="t('setPassword.submit')"
        />
      </form>
    </section>
  </main>
</template>
