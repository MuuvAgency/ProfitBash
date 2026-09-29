<script setup lang="ts">
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { ApiError } from '../api';
import BrandMark from '../components/brand/BrandMark.vue';
import InlineError from '../components/common/InlineError.vue';
import { errorMessageKey } from '../i18n';
import { homePath } from '../navigation/navigation';
import { safeRedirect } from '../router/guard';
import { useSessionStore } from '../stores/session';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const session = useSessionStore();

const email = ref('');
const password = ref('');
const showPassword = ref(false);
const submitting = ref(false);
const errorKey = ref<string | null>(null);

const sessionExpired = computed(() => route.query.reason === 'expired' && !errorKey.value);
const passwordSet = computed(() => route.query.reason === 'passwordSet' && !errorKey.value);

async function submit() {
  errorKey.value = null;
  const trimmedEmail = email.value.trim();
  if (!trimmedEmail || !password.value) {
    errorKey.value = 'login.required';
    return;
  }
  submitting.value = true;
  try {
    await session.signIn({ email: trimmedEmail, password: password.value });
    if (session.status !== 'authenticated' || !session.me) {
      errorKey.value = errorMessageKey(session.loadError?.code ?? 'UNKNOWN');
      return;
    }
    await router.replace(safeRedirect(route.query.redirect) ?? homePath(session.me));
  } catch (error) {
    errorKey.value = errorMessageKey(error instanceof ApiError ? error.code : 'UNKNOWN');
    password.value = '';
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <main
    class="flex min-h-dvh items-center justify-center bg-canvas p-margin-mobile sm:p-margin lg:p-space-xl"
  >
    <div
      class="grid w-full max-w-6xl overflow-hidden rounded-hero bg-tile shadow-raised lg:grid-cols-[46fr_54fr]"
    >
      <!-- Markenfläche -->
      <section
        class="relative flex flex-col justify-between gap-space-xl overflow-hidden bg-panel p-space-xl text-on-panel lg:p-hero"
      >
        <BrandMark size="lg" />

        <div class="flex max-w-md flex-col gap-space-md">
          <p class="font-data text-label-eyebrow uppercase tracking-widest text-on-panel-muted">
            {{ t('login.eyebrow') }}
          </p>
          <p class="text-headline-lg xl:text-display">
            {{ t('login.headline') }}
          </p>
          <p class="text-body-lg text-on-panel-muted">{{ t('login.intro') }}</p>
        </div>

        <!-- Abstrakte Datenlinie, rein dekorativ -->
        <div class="hidden rounded-tile bg-on-panel/5 p-space-lg lg:block" aria-hidden="true">
          <svg viewBox="0 0 340 110" class="h-28 w-full overflow-visible" fill="none">
            <path d="M0 30H340M0 70H340" class="stroke-on-panel/10" stroke-dasharray="3 4" />
            <path
              d="M0 96 C60 88 100 82 150 70 S240 52 280 40 S320 30 340 26"
              class="stroke-violet"
              stroke-width="2"
              stroke-linecap="round"
            />
            <path
              d="M0 90 C50 80 90 72 140 58 S220 38 260 24 S320 12 340 10"
              class="stroke-lime"
              stroke-width="2.5"
              stroke-linecap="round"
            />
            <circle cx="340" cy="10" r="4.5" class="fill-lime" />
            <circle cx="340" cy="10" r="9" class="stroke-lime/50" stroke-width="1.5" />
          </svg>
        </div>
      </section>

      <!-- Formular -->
      <section class="flex flex-col justify-center p-space-xl lg:p-hero">
        <div class="mx-auto flex w-full max-w-md flex-col gap-space-xl">
          <div class="flex flex-col gap-space-xs">
            <h1 class="text-headline-lg text-ink">{{ t('login.heading') }}</h1>
            <p class="text-body-md text-ink-secondary">{{ t('login.subheading') }}</p>
          </div>

          <p
            v-if="sessionExpired"
            role="status"
            class="rounded-control bg-violet-wash px-space-md py-space-sm text-body-sm text-ink"
          >
            {{ t('login.sessionExpired') }}
          </p>
          <p
            v-if="passwordSet"
            role="status"
            class="rounded-control bg-violet-wash px-space-md py-space-sm text-body-sm text-ink"
          >
            {{ t('login.passwordSet') }}
          </p>

          <form class="flex flex-col gap-space-lg" novalidate @submit.prevent="submit">
            <InlineError v-if="errorKey" :message="t(errorKey)" />

            <div class="flex flex-col gap-space-sm">
              <label for="login-email" class="text-body-sm font-semibold text-ink">
                {{ t('login.email') }}
              </label>
              <InputText
                id="login-email"
                v-model="email"
                type="email"
                name="email"
                autocomplete="username"
                inputmode="email"
                size="large"
                fluid
                :invalid="errorKey === 'login.required' && !email.trim()"
                class="font-data"
              />
            </div>

            <div class="flex flex-col gap-space-sm">
              <label for="login-password" class="text-body-sm font-semibold text-ink">
                {{ t('login.password') }}
              </label>
              <div class="relative">
                <InputText
                  id="login-password"
                  v-model="password"
                  :type="showPassword ? 'text' : 'password'"
                  name="password"
                  autocomplete="current-password"
                  size="large"
                  fluid
                  :invalid="errorKey === 'login.required' && !password"
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
            </div>

            <Button
              type="submit"
              size="large"
              fluid
              :loading="submitting"
              :label="submitting ? t('login.submitting') : t('login.submit')"
              icon="pi pi-arrow-right"
              icon-pos="right"
            />
          </form>

          <p class="text-body-sm text-ink-secondary">{{ t('login.noAccount') }}</p>
        </div>
      </section>
    </div>
  </main>
</template>
