import { formatDateTime, type JobRun } from '@profitbash/shared';
import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, stubFetch } from '../test/fetch-stub';
import { JOB_RUNS_POLL_INTERVAL_MS } from '../sync/queries';
import { CONNECTION_ID, connectionFixture, jobRunFixture, meFixture } from '../test/fixtures';
import { cleanupMounted, mountWithApp } from '../test/mount';

// Key-Reihenfolge wie aus Postgres (`jsonb` sortiert nach Länge), nicht wie geschrieben.
const succeeded = jobRunFixture({
  startedAt: '2026-09-26T03:00:00.000Z',
  counters: {
    retries: 2,
    created: 1,
    removed: 2,
    deferred: 1,
    profiles: 4,
    requests: 12,
    throttled: 1,
    reassigned: 0,
    removalDeferred: 0,
  },
});
const failed = jobRunFixture({
  job: 'token-refresh',
  status: 'failed',
  startedAt: '2026-09-26T04:00:00.000Z',
  finishedAt: '2026-09-26T04:03:12.400Z',
  error: 'Amazon hat nicht wie erwartet geantwortet.\nHTTP 503 nach 3 Versuchen.',
  counters: { profiles: 0 },
});
const running = jobRunFixture({
  status: 'running',
  startedAt: '2026-09-26T05:00:00.000Z',
  finishedAt: null,
  counters: {},
});

const pending = () => new Promise<Response>(() => {});

function routes(runs: JobRun[] | (() => Response | Promise<Response>) = [running, failed]) {
  return {
    'GET /api/me': json(meFixture()),
    'GET /api/job-runs': typeof runs === 'function' ? runs : json({ jobRuns: runs }),
  };
}

async function mountPage(path = '/ops/sync') {
  return mountWithApp(undefined, { path });
}

type Wrapper = Awaited<ReturnType<typeof mountPage>>['wrapper'];

function rows(wrapper: Wrapper) {
  // Kopfzeile ausnehmen: Datenzeilen tragen eine Zeilen-ID.
  return wrapper.findAll('[role="row"][row-id]');
}

function row(wrapper: Wrapper, run: JobRun) {
  return wrapper.find(`[role="row"][row-id="${run.id}"]`);
}

/** Wartet auf die Zeile samt Vue-Zellen (AG Grid rendert sie asynchron). */
async function waitForRow(wrapper: Wrapper, run: JobRun) {
  await vi.waitFor(() => expect(row(wrapper, run).find('[col-id="status"]').text()).not.toBe(''));
  return row(wrapper, run);
}

function button(wrapper: Wrapper, label: string) {
  const found = wrapper.findAll('button').filter((b) => b.text() === label);
  expect(found, `Button „${label}“`).toHaveLength(1);
  return found[0]!;
}

/** PrimeVue (ohne Styles) markiert den Ladezustand in `data-p`. */
const isLoading = (b: ReturnType<typeof button>) =>
  (b.attributes('data-p') ?? '').split(' ').includes('loading');

/** Filter-Auswahl über ihr sichtbares Label (PrimeVue-Select, Overlay am <body>). */
function filter(wrapper: Wrapper, label: string) {
  const labelElement = wrapper.findAll('label').find((l) => l.text() === label);
  expect(labelElement, `Label „${label}“`).toBeDefined();
  return wrapper.get(`[role="combobox"][aria-labelledby="${labelElement!.attributes('id')}"]`);
}

async function choose(wrapper: Wrapper, label: string, optionLabel: string) {
  await filter(wrapper, label).trigger('click');
  await flushPromises();
  const option = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (o) => o.getAttribute('aria-label') === optionLabel,
  );
  expect(option, `Option „${optionLabel}“`).toBeDefined();
  // PrimeVue wählt Optionen auf `mousedown` (vor dem Blur des Comboboxes).
  option!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  await flushPromises();
}

const jobRunRequests = (requests: ReturnType<typeof stubFetch>['requests']) =>
  requests.filter((r) => r.path === '/api/job-runs').map((r) => r.search);

afterEach(() => {
  cleanupMounted();
  vi.unstubAllGlobals();
});

describe('SyncStatusPage', () => {
  it('ist die Seite hinter „Betrieb → Sync-Status“ (kein Platzhalter)', async () => {
    stubFetch(routes());
    const { wrapper } = await mountPage();
    await waitForRow(wrapper, running);
    expect(wrapper.get('h1').text()).toBe('Sync-Status');
    expect(wrapper.find('[role="region"][aria-label="Jobläufe"]').exists()).toBe(true);
  });

  it('zeigt je Lauf Status, Job, Connection, Start, Dauer und Ergebnis, neueste zuerst', async () => {
    stubFetch(routes([running, failed, succeeded]));
    const { wrapper } = await mountPage();
    await waitForRow(wrapper, succeeded);

    expect(rows(wrapper).map((r) => r.attributes('row-id'))).toEqual([
      running.id,
      failed.id,
      succeeded.id,
    ]);

    const success = row(wrapper, succeeded);
    for (const text of [
      'Erfolgreich',
      'Profil-Sync',
      'ads@muuv.test',
      formatDateTime(succeeded.startedAt, 'de-DE'),
      '4,2 Sek.',
    ]) {
      expect(success.text()).toContain(text);
    }
    // Bekannte Zähler in fester Reihenfolge, Nullwerte fehlen.
    // Anfragezähler (1.3) nach den fachlichen Zählern.
    expect(success.get('[col-id="result"]').text()).toBe(
      '4 Profile · 1 neu · 2 entfernt · 12 Anfragen · 1 gedrosselt · 2 Wiederholungen · 1 Mal zurückgestellt',
    );
    // Zahlen in Mono.
    expect(success.findAll('[col-id="result"] .font-data').map((n) => n.text())).toEqual([
      '4',
      '1',
      '2',
      '12',
      '1',
      '2',
      '1',
    ]);
    // Zeitstempel und Dauer in Mono.
    const started = success.get('[col-id="startedAt"]');
    expect(started.classes()).toContain('font-data');
    expect(success.get('[col-id="duration"]').classes()).toContain('font-data');

    const failedRow = row(wrapper, failed);
    expect(failedRow.text()).toContain('Fehlgeschlagen');
    expect(failedRow.text()).toContain('Token-Refresh');
    expect(failedRow.text()).toContain('3 Min. 12 Sek.');
    // Zähler und Fehlertext teilen sich die Spalte „Ergebnis“.
    const result = failedRow.get('[col-id="result"]');
    expect(result.text()).toContain('0 Profile');
    expect(result.text()).toContain('Amazon hat nicht wie erwartet geantwortet.');

    const runningRow = row(wrapper, running);
    expect(runningRow.text()).toContain('Läuft');
    expect(runningRow.get('[col-id="duration"]').text()).toBe('–');
  });

  it('zeigt die Amazon-Datenjobs (1.7) mit ihren Zählern in fester Reihenfolge', async () => {
    const poll = jobRunFixture({
      id: '55555555-5555-4555-8555-555555555555',
      job: 'amazon-requests-poll',
      counters: {
        rows: 1200,
        failed: 1,
        imported: 5,
        requests: 9,
        requested: 3,
        superseded: 1,
        exportsWaiting: 0,
        placeholdersCreated: 7,
      },
    });
    const reports = jobRunFixture({
      id: '66666666-6666-4666-8666-666666666666',
      job: 'reports-sync',
      startedAt: '2026-09-26T02:00:00.000Z',
      counters: {
        profiles: 2,
        requested: 19,
        backfillsCompleted: 1,
        failedSinceLastRun: 2,
        continued: 1,
      },
    });
    stubFetch(routes([poll, reports]));
    const { wrapper } = await mountPage();
    await waitForRow(wrapper, reports);

    const pollRow = row(wrapper, poll);
    expect(pollRow.text()).toContain('Amazon-Aufträge abholen');
    expect(pollRow.get('[col-id="result"]').text()).toBe(
      '3 angefordert · 5 Dateien importiert · 1 überholt · 1.200 Zeilen · 7 Platzhalter angelegt · 1 Auftrag gescheitert · 9 Anfragen',
    );
    const reportsRow = row(wrapper, reports);
    expect(reportsRow.text()).toContain('Report-Anforderung');
    expect(reportsRow.get('[col-id="result"]').text()).toBe(
      '2 Profile · 19 angefordert · 1 Historie vollständig · 2 seit dem letzten Lauf gescheitert · 1 Mal fortgesetzt',
    );
  });

  it('zeigt statt einer fehlenden Connection den Platzhalter', async () => {
    const orphan = jobRunFixture({ connection: null });
    stubFetch(routes([orphan]));
    const { wrapper } = await mountPage();
    expect((await waitForRow(wrapper, orphan)).get('[col-id="connection"]').text()).toBe('–');
  });

  it('klappt den Fehlertext auf und wieder zu', async () => {
    stubFetch(routes());
    const { wrapper } = await mountPage();
    const failedRow = await waitForRow(wrapper, failed);

    // Nur Läufe mit Fehlertext haben den Schalter.
    expect(row(wrapper, running).find('[col-id="result"] button').exists()).toBe(false);

    const toggle = failedRow.get('[col-id="result"] button');
    expect(toggle.text()).toBe('Fehler anzeigen');
    expect(toggle.attributes('aria-expanded')).toBe('false');
    expect(failedRow.text()).toContain('Amazon hat nicht wie erwartet geantwortet.');
    expect(failedRow.text()).not.toContain('HTTP 503');

    await toggle.trigger('click');
    await flushPromises();
    const expanded = row(wrapper, failed).get('[col-id="result"] button');
    expect(expanded.text()).toBe('Fehler ausblenden');
    expect(expanded.attributes('aria-expanded')).toBe('true');
    const details = wrapper.get(`#${expanded.attributes('aria-controls')}`);
    expect(details.text()).toBe(failed.error);

    await expanded.trigger('click');
    await flushPromises();
    expect(row(wrapper, failed).text()).not.toContain('HTTP 503');
  });

  it('filtert nach Job und Status und hält die Filter in der URL', async () => {
    const { requests } = stubFetch(routes());
    const { wrapper, router } = await mountPage('/ops/sync?status=failed');
    await waitForRow(wrapper, failed);
    expect(jobRunRequests(requests)).toEqual(['?status=failed']);
    expect(filter(wrapper, 'Status').text()).toBe('Fehlgeschlagen');
    expect(filter(wrapper, 'Job').text()).toBe('Alle');

    await choose(wrapper, 'Job', 'Token-Refresh');
    await vi.waitFor(() =>
      expect(jobRunRequests(requests)).toContain('?job=token-refresh&status=failed'),
    );
    expect(router.currentRoute.value.query).toEqual({ job: 'token-refresh', status: 'failed' });

    await choose(wrapper, 'Status', 'Alle');
    await vi.waitFor(() => expect(jobRunRequests(requests)).toContain('?job=token-refresh'));
    expect(router.currentRoute.value.query).toEqual({ job: 'token-refresh' });
  });

  it('zeigt nach einem Org-Wechsel nie die Läufe der vorherigen Org', async () => {
    let calls = 0;
    stubFetch(routes(() => (++calls === 1 ? json({ jobRuns: [failed] }) : pending())));
    const { wrapper, session } = await mountPage();
    await waitForRow(wrapper, failed);

    session.me!.activeOrganizationId = 'org-2';
    await vi.waitFor(() => expect(calls).toBe(2));
    await flushPromises();
    expect(row(wrapper, failed).exists()).toBe(false);
    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(true);
  });

  it('zeigt nach „Jetzt synchronisieren“ über den Link den neuen Lauf, sobald er startet', async () => {
    const syncPath = `/api/connections/${CONNECTION_ID}/sync`;
    let started = false;
    const { requests } = stubFetch({
      ...routes(() => json({ jobRuns: started ? [running, failed] : [failed] })),
      'GET /api/connections': json({ connections: [connectionFixture()] }),
      [`GET /api/connections/${CONNECTION_ID}/profiles`]: json({ profiles: [] }),
      'GET /api/clients': json({ clients: [] }),
      [`POST ${syncPath}`]: json({ status: 'queued' }, 202),
    });
    // Die Seite war schon einmal offen: Ihre Daten liegen im Cache.
    const { wrapper, router } = await mountPage('/ops/sync?job=profiles-sync');
    await waitForRow(wrapper, failed);
    await router.push('/admin/connections');
    await vi.waitFor(() => expect(wrapper.text()).toContain('Jetzt synchronisieren'));

    await button(wrapper, 'Jetzt synchronisieren').trigger('click');
    await vi.waitFor(() => expect(wrapper.find('[role="status"] a').exists()).toBe(true));
    await wrapper.get('[role="status"] a').trigger('click');
    await waitForRow(wrapper, failed);
    const before = jobRunRequests(requests).length;

    // Der Worker startet den Lauf erst nach dem Klick; die Seite fragt von selbst nach.
    started = true;
    await vi.waitFor(() => expect(row(wrapper, running).exists()).toBe(true), {
      timeout: JOB_RUNS_POLL_INTERVAL_MS + 2_000,
    });
    expect(jobRunRequests(requests).length).toBeGreaterThan(before);
  }, 15_000);

  it('ignoriert unbekannte Filterwerte in der URL', async () => {
    const { requests } = stubFetch(routes());
    const { wrapper } = await mountPage('/ops/sync?job=job-runs-cleanup&status=egal');
    await waitForRow(wrapper, failed);
    expect(jobRunRequests(requests)).toEqual(['']);
    expect(filter(wrapper, 'Job').text()).toBe('Alle');
  });

  it('lädt über „Aktualisieren“ neu', async () => {
    const { requests } = stubFetch(routes());
    const { wrapper } = await mountPage();
    await waitForRow(wrapper, failed);
    await button(wrapper, 'Aktualisieren').trigger('click');
    await vi.waitFor(() => expect(jobRunRequests(requests)).toHaveLength(2));
  });

  it('zeigt den Ladezustand am Button nur beim Aktualisieren, nicht beim Nachfragen im Hintergrund', async () => {
    let calls = 0;
    stubFetch(routes(() => (++calls === 1 ? json({ jobRuns: [failed] }) : pending())));
    const { wrapper, queryClient } = await mountPage();
    await waitForRow(wrapper, failed);

    // Hintergrund (wie beim Nachfragen alle paar Sekunden).
    void queryClient.refetchQueries({ queryKey: ['job-runs'] });
    await vi.waitFor(() => expect(calls).toBe(2));
    await flushPromises();
    expect(isLoading(button(wrapper, 'Aktualisieren'))).toBe(false);

    await button(wrapper, 'Aktualisieren').trigger('click');
    await flushPromises();
    expect(isLoading(button(wrapper, 'Aktualisieren'))).toBe(true);
  });

  it('lässt die Tabelle stehen, wenn das Nachladen scheitert', async () => {
    let fail = false;
    stubFetch(
      routes(() =>
        fail
          ? json({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500)
          : json({ jobRuns: [failed] }),
      ),
    );
    const { wrapper } = await mountPage();
    await waitForRow(wrapper, failed);
    fail = true;
    await button(wrapper, 'Aktualisieren').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.get('[role="alert"]').text()).toContain(
        'Die Jobläufe konnten nicht aktualisiert werden.',
      ),
    );
    expect(row(wrapper, failed).exists()).toBe(true);
  });

  it('zeigt einen Ladezustand', async () => {
    stubFetch(routes(pending));
    const { wrapper } = await mountPage();
    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(true);
  });

  it('zeigt einen leeren Zustand ohne Läufe', async () => {
    stubFetch(routes([]));
    const { wrapper } = await mountPage();
    await vi.waitFor(() => expect(wrapper.text()).toContain('Noch keine Jobläufe'));
    expect(wrapper.find('[role="region"][aria-label="Jobläufe"]').exists()).toBe(false);
  });

  it('bietet bei leerem Filterergebnis das Zurücksetzen an', async () => {
    const { requests } = stubFetch(routes([]));
    const { wrapper, router } = await mountPage('/ops/sync?job=profiles-sync');
    await vi.waitFor(() => expect(wrapper.text()).toContain('Keine Jobläufe für diesen Filter.'));
    await button(wrapper, 'Filter zurücksetzen').trigger('click');
    await vi.waitFor(() => expect(jobRunRequests(requests)).toEqual(['?job=profiles-sync', '']));
    expect(router.currentRoute.value.query).toEqual({});
  });

  it('zeigt einen Fehler mit „Erneut versuchen“', async () => {
    let fail = true;
    stubFetch(
      routes(() =>
        fail
          ? json({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500)
          : json({ jobRuns: [failed] }),
      ),
    );
    const { wrapper } = await mountPage();
    await vi.waitFor(() =>
      expect(wrapper.get('[role="alert"]').text()).toContain(
        'Die Jobläufe konnten nicht geladen werden.',
      ),
    );
    fail = false;
    await button(wrapper, 'Erneut versuchen').trigger('click');
    await waitForRow(wrapper, failed);
  });
});
