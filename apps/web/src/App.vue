<script setup lang="ts">
import { onMounted, ref } from 'vue';

// Platzhalter bis Aufgabe 0.8 (Login, App-Shell, Design-Tokens, i18n).
// Prüft, dass der Vite-Proxy /api an die lokale API weiterleitet.
const apiStatus = ref<'prüfe …' | 'erreichbar' | 'nicht erreichbar'>('prüfe …');

onMounted(async () => {
  try {
    const res = await fetch('/api/health');
    apiStatus.value = res.ok ? 'erreichbar' : 'nicht erreichbar';
  } catch {
    apiStatus.value = 'nicht erreichbar';
  }
});
</script>

<template>
  <main>
    <h1>ProfitBash</h1>
    <p>API: {{ apiStatus }}</p>
  </main>
</template>
