import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  clean: true,
  sourcemap: true,
  // Workspace-Pakete liefern TypeScript-Quellcode und werden deshalb mitgebündelt.
  noExternal: [/^@profitbash\//],
});
