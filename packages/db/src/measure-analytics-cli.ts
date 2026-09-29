import { databaseUrlSchema, loadEnv } from '@profitbash/shared/env';
import { sql } from 'drizzle-orm';
import { queryDashboard, queryExplorerRows, queryTimeSeries } from './ads-analytics';
import { createDb } from './client';

/**
 * Misst die Abfragen von Dashboard und Explorer mit den Demo-Daten (`pnpm demo:load`), wie für die Definition of Done von
 * Phase 2 festgehalten: alle sichtbaren Profile, die letzten 30 Tage vor dem heutigen Datum (Vergleich: die 30 Tage davor),
 * Anzeigewährung automatisch, je Abfrage 3 Läufe. Nur lesend; als Nutzer gilt der erste Admin der Organisation „muuv“.
 *
 * `pnpm analytics:measure` (braucht `DATABASE_URL` der Entwicklungs-DB).
 */
const env = loadEnv(databaseUrlSchema);
const { db, close } = createDb(env.DATABASE_URL, { max: 2 });

const [admin] = await db.execute<{ user_id: string; organization_id: string }>(sql`
  select m.user_id, m.organization_id from members m join organizations o on o.id = m.organization_id
   where o.slug = 'muuv' and m.role = 'admin' order by m.created_at limit 1`);
if (!admin)
  throw new Error(
    'Kein Admin in der Organisation „muuv“ (erst `pnpm db:seed` und `pnpm demo:load`).',
  );

const day = (offset: number) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};
const base = {
  userId: admin.user_id,
  orgId: admin.organization_id,
  period: { from: day(-30), to: day(-1) },
  currency: 'auto' as const,
  attribution: 'console' as const,
};
const comparison = { from: day(-60), to: day(-31) };

async function time(label: string, run: () => Promise<unknown>) {
  const ms: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const start = performance.now();
    await run();
    ms.push(Math.round(performance.now() - start));
  }
  console.log(`${label.padEnd(44)} ${ms.join(' / ')} ms`);
}

console.log(
  `Zeitraum ${base.period.from} bis ${base.period.to}, Vergleich ${comparison.from} bis ${comparison.to}`,
);
for (const level of [
  'portfolio',
  'campaign',
  'adGroup',
  'target',
  'productAd',
  'searchTerm',
] as const) {
  await time(`Zeilen ${level} ohne Vergleich`, () => queryExplorerRows(db, { ...base, level }));
}
for (const level of ['target', 'searchTerm'] as const) {
  await time(`Zeilen ${level} mit Vergleich (nachgeladen)`, () =>
    queryExplorerRows(db, { ...base, level, comparison }),
  );
}
await time('Dashboard mit Vergleich', () => queryDashboard(db, { ...base, comparison }));
await time('Tagesreihe Kampagnen (Hero-Kachel)', () =>
  queryTimeSeries(db, { ...base, level: 'campaign', filter: { includeRemoved: true } }),
);
await time('Tagesreihe Targets', () => queryTimeSeries(db, { ...base, level: 'target' }));
await close();
