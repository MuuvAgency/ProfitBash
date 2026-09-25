import { defineConfig } from 'drizzle-kit';

// `generate` braucht keine Datenbank. Für `drizzle-kit studio` wird DATABASE_URL_DIRECT genutzt.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL_DIRECT ?? '' },
  strict: true,
});
