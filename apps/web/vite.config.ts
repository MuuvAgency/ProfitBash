/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig, loadEnv } from 'vite';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig(({ mode }) => {
  // Liest die gemeinsame .env im Repo-Root. Im Client landen nur Variablen mit VITE_-Präfix.
  const env = loadEnv(mode, repoRoot, '');
  const apiPort = env.API_PORT ?? '8787';

  return {
    plugins: [vue(), tailwindcss()],
    envDir: repoRoot,
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: {
      port: 5173,
      strictPort: true,
      // Alle Browser-Requests laufen über eine Origin: /api geht an die lokale API.
      proxy: {
        '/api': { target: `http://localhost:${apiPort}` },
      },
    },
    test: {
      environment: 'happy-dom',
    },
  };
});
