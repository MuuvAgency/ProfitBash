import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import pluginVue from 'eslint-plugin-vue';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  // `.claude/`: Worktrees paralleler Sessions (eigene Kopien des Repos samt node_modules).
  globalIgnores(['**/dist/**', '**/coverage/**', 'design/**', '.claude/**']),
  js.configs.recommended,
  tseslint.configs.recommended,
  pluginVue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
  },
  {
    languageOptions: { globals: globals.node },
    rules: {
      // Bewusst ungenutzte Werte mit `_` kennzeichnen, z. B. beim Weglassen von Feldern per Destructuring.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    // Typisierte Regeln: nicht abgewartete Promises sind in Job- und Request-Code fast immer Fehler.
    files: ['**/*.{ts,vue}'],
    languageOptions: {
      parserOptions: {
        projectService: {
          // Konfigurationsdateien außerhalb der tsconfig-Projekte
          allowDefaultProject: ['*.ts', 'packages/db/drizzle.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.vue'],
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    files: ['apps/web/src/**'],
    languageOptions: { globals: globals.browser },
  },
  prettier,
]);
