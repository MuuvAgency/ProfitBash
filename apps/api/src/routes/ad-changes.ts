import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import {
  PLACEMENT_PERCENTAGE_LIMIT,
  SP_BID_LIMITS,
  SP_DAILY_BUDGET_LIMITS,
} from '@profitbash/amazon-ads';
import {
  AD_CHANGE_OPEN_LIST_LIMIT,
  AdChangeError,
  closeBulkFileSubmission,
  discardPendingAdChanges,
  dismissFailedAdChanges,
  finishAdChangeSubmission,
  getAdChangeSubmission,
  getBulkFileSubmissionRows,
  getProfileEntitiesSyncedAt,
  listAdChangeHistory,
  listAdChangeSubmissions,
  listOpenAdChanges,
  listPendingAdChanges,
  listSubmissionConnections,
  recordAdChangeResults,
  retryAdChanges,
  revertAdChanges,
  stageAdChanges,
  submitAdChanges,
  type AdChangeRecord,
  type AdChangeSubmissionSummary,
  type DbOrTx,
  type PendingAdChange,
} from '@profitbash/db';
import { checkAdChanges, type AdChangeLimitLookup } from '@profitbash/engine';
import {
  adChangeHistoryRequestSchema,
  adChangeHistoryResponseSchema,
  adChangeSubmissionDetailSchema,
  adChangeSubmissionsResponseSchema,
  closeAdChangeSubmissionRequestSchema,
  closeAdChangeSubmissionResponseSchema,
  discardAdChangesRequestSchema,
  discardAdChangesResponseSchema,
  dismissAdChangesRequestSchema,
  dismissAdChangesResponseSchema,
  errorResponseSchema,
  idParamSchema,
  openAdChangesResponseSchema,
  pendingAdChangesResponseSchema,
  retryAdChangesRequestSchema,
  retryAdChangesResponseSchema,
  revertAdChangesRequestSchema,
  revertAdChangesResponseSchema,
  slugify,
  stageAdChangesRequestSchema,
  stageAdChangesResponseSchema,
  submitAdChangesRequestSchema,
  submitAdChangesResponseSchema,
  type AdChange,
  type AdChangeCheck,
  type AdChangeSubmission,
} from '@profitbash/shared';
import { buildSubmissionBulkFile } from '@profitbash/worker';
import { bodyLimit } from 'hono/body-limit';
import type { AppDeps, AppEnv } from '../context';
import { ApiError } from '../errors';
import { requireFeature, requireSession } from '../middleware';
import { toIso } from './serialize';

/**
 * Änderungen an Amazon-Werbung (`docs/tasks/phase-3.md` 3.4), Feature `changes`: Warenkorb je Nutzer, Übermitteln
 * (über die API oder als Bulk-Datei), Übermittlungen der Organisation, erneut versuchen, verwerfen, Revert, Verlauf.
 * Lesen mit Recht `view`, alles Schreibende mit `write`. Gelesen und geschrieben wird über `@profitbash/db`
 * (Access-Layer, ADR 002); die Prüfungen vor dem Übermitteln rechnet `@profitbash/engine`.
 */

const json = <T>(schema: T) => ({ 'application/json': { schema } });
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Sammeländerungen (bis 5000 je Anfrage) sind größer als das allgemeine Body-Limit. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const WRITE_PATH = /^\/api\/ads\/changes\/(pending|pending\/discard|submit|retry|dismiss|revert)$/;

/** Diese Requests nimmt das allgemeine Body-Limit aus; ihr Limit sitzt an der Route. */
export function isAdChangesWrite(method: string, path: string): boolean {
  return method === 'POST' && WRITE_PATH.test(path);
}

const errors = {
  400: { description: 'Ungültige Eingabe.', content: json(errorResponseSchema) },
  401: { description: 'Nicht angemeldet.', content: json(errorResponseSchema) },
  403: {
    description: 'Feature nicht gebucht oder kein Recht.',
    content: json(errorResponseSchema),
  },
};
const notFound = {
  404: { description: 'Übermittlung nicht gefunden.', content: json(errorResponseSchema) },
};
const conflict = (description: string) => ({
  409: { description, content: json(errorResponseSchema) },
});
const TAGS = ['Änderungen'];

const pendingRoute = createRoute({
  method: 'get',
  path: '/ads/changes/pending',
  tags: TAGS,
  summary: 'Warenkorb des Nutzers mit den Prüfungen vor dem Übermitteln',
  responses: {
    200: { description: 'Warenkorb.', content: json(pendingAdChangesResponseSchema) },
    401: errors[401],
    403: errors[403],
  },
});

const stageRoute = createRoute({
  method: 'post',
  path: '/ads/changes/pending',
  tags: TAGS,
  summary: 'Änderungen in den Warenkorb legen (Recht „write“)',
  description:
    'Gültige Änderungen werden übernommen, auch wenn andere derselben Anfrage abgelehnt werden. Den Wert „vorher“ ' +
    'liest der Server aus der Entity. Derselbe Wert wie der Stand nimmt eine vorgemerkte Änderung zurück.',
  request: { body: { content: json(stageAdChangesRequestSchema), required: true } },
  responses: {
    200: { description: 'Ergebnis je Änderung.', content: json(stageAdChangesResponseSchema) },
    ...errors,
  },
});

const discardRoute = createRoute({
  method: 'post',
  path: '/ads/changes/pending/discard',
  tags: TAGS,
  summary: 'Eigene vorgemerkte Änderungen verwerfen (Recht „write“)',
  request: { body: { content: json(discardAdChangesRequestSchema), required: true } },
  responses: {
    200: { description: 'Verworfen.', content: json(discardAdChangesResponseSchema) },
    ...errors,
  },
});

const submitRoute = createRoute({
  method: 'post',
  path: '/ads/changes/submit',
  tags: TAGS,
  summary: 'Warenkorb übermitteln: über die API oder als Bulk-Datei (Recht „write“)',
  description:
    'Je Profil entsteht eine Übermittlung. Liegt ein Wert außerhalb der Grenzen von Amazon, wird nichts übermittelt ' +
    '(`limitsExceeded`). Warnungen (Gebot oder Budget um mehr als 50 % geändert, mehr als 200 Änderungen) brauchen ' +
    '`confirmWarnings` (`needsConfirmation`). Als Bulk-Datei: Änderungen, die nicht in die Datei passen, scheitern ' +
    'sofort (`bulkFileSkipped`).',
  request: { body: { content: json(submitAdChangesRequestSchema), required: true } },
  responses: {
    200: { description: 'Ergebnis.', content: json(submitAdChangesResponseSchema) },
    ...errors,
    ...conflict('Ein Profil ohne Connection lässt sich nur als Bulk-Datei übermitteln.'),
  },
});

const openRoute = createRoute({
  method: 'get',
  path: '/ads/changes/open',
  tags: TAGS,
  summary:
    'Offene Änderungen aller Nutzer (vorgemerkt oder übermittelt ohne Ergebnis), für die Anzeige je Entity',
  responses: {
    200: { description: 'Offene Änderungen.', content: json(openAdChangesResponseSchema) },
    401: errors[401],
    403: errors[403],
  },
});

const historyRoute = createRoute({
  method: 'post',
  path: '/ads/changes/history',
  tags: TAGS,
  summary:
    'Verlauf: übermittelte Änderungen einer Entity, eines Profils oder aller sichtbaren Profile',
  request: { body: { content: json(adChangeHistoryRequestSchema), required: true } },
  responses: {
    200: { description: 'Verlauf, neueste zuerst.', content: json(adChangeHistoryResponseSchema) },
    ...errors,
  },
});

const submissionsRoute = createRoute({
  method: 'get',
  path: '/ads/changes/submissions',
  tags: TAGS,
  summary: 'Übermittlungen der Organisation, neueste zuerst (höchstens 100)',
  responses: {
    200: { description: 'Übermittlungen.', content: json(adChangeSubmissionsResponseSchema) },
    401: errors[401],
    403: errors[403],
  },
});

const submissionRoute = createRoute({
  method: 'get',
  path: '/ads/changes/submissions/{id}',
  tags: TAGS,
  summary: 'Eine Übermittlung mit dem Ergebnis je Änderung',
  request: { params: idParamSchema },
  responses: {
    200: { description: 'Übermittlung.', content: json(adChangeSubmissionDetailSchema) },
    ...errors,
    ...notFound,
  },
});

const bulkFileRoute = createRoute({
  method: 'get',
  path: '/ads/changes/submissions/{id}/bulk-file',
  tags: TAGS,
  summary: 'Bulk-Datei einer Übermittlung zum Hochladen in der Werbekonsole (Recht „write“)',
  description:
    'Enthält die Änderungen, die als übermittelt oder angewendet gelten. Portfolio und Enddatum der Kampagnenzeilen ' +
    'stammen vom letzten Sync bzw. Import (`entitiesSyncedAt` der Übermittlung).',
  request: { params: idParamSchema },
  responses: {
    200: {
      description: 'Die Datei (.xlsx).',
      content: { [XLSX]: { schema: { type: 'string', format: 'binary' } } },
    },
    ...errors,
    ...notFound,
    ...conflict('Keine Übermittlung per Bulk-Datei oder keine Zeile für die Datei.'),
  },
});

const closeRoute = createRoute({
  method: 'post',
  path: '/ads/changes/submissions/{id}/close',
  tags: TAGS,
  summary:
    'Übermittlung per Bulk-Datei von Hand abschließen: hochgeladen oder verworfen (Recht „write“)',
  request: {
    params: idParamSchema,
    body: { content: json(closeAdChangeSubmissionRequestSchema), required: true },
  },
  responses: {
    200: { description: 'Abgeschlossen.', content: json(closeAdChangeSubmissionResponseSchema) },
    ...errors,
    ...notFound,
    ...conflict('Keine offene Übermittlung per Bulk-Datei.'),
  },
});

const retryRoute = createRoute({
  method: 'post',
  path: '/ads/changes/retry',
  tags: TAGS,
  summary: 'Fehlgeschlagene Änderungen erneut versuchen, als neue Übermittlung (Recht „write“)',
  request: { body: { content: json(retryAdChangesRequestSchema), required: true } },
  responses: {
    200: { description: 'Ergebnis.', content: json(retryAdChangesResponseSchema) },
    ...errors,
    ...conflict('Ein Profil ohne Connection lässt sich nur als Bulk-Datei übermitteln.'),
  },
});

const dismissRoute = createRoute({
  method: 'post',
  path: '/ads/changes/dismiss',
  tags: TAGS,
  summary: 'Fehlgeschlagene Änderungen verwerfen (Recht „write“)',
  request: { body: { content: json(dismissAdChangesRequestSchema), required: true } },
  responses: {
    200: { description: 'Verworfen.', content: json(dismissAdChangesResponseSchema) },
    ...errors,
  },
});

const revertRoute = createRoute({
  method: 'post',
  path: '/ads/changes/revert',
  tags: TAGS,
  summary: 'Angewendete Änderungen zurücknehmen, als neue Übermittlung (Recht „write“)',
  description:
    'Eine ganze Übermittlung oder einzelne Änderungen. Weicht der Stand vom Wert nach der Übermittlung ab, kommt ' +
    '`conflict` zurück und nichts wird übermittelt; erst mit `overwriteChanged` wird überschrieben.',
  request: { body: { content: json(revertAdChangesRequestSchema), required: true } },
  responses: {
    200: { description: 'Ergebnis.', content: json(revertAdChangesResponseSchema) },
    ...errors,
    ...conflict('Ein Profil ohne Connection lässt sich nur als Bulk-Datei übermitteln.'),
  },
});

// ---------------------------------------------------------------------------
// Antworten
// ---------------------------------------------------------------------------

function serializeChange(change: AdChangeRecord): AdChange {
  const { entity, resolvedAt, createdAt, updatedAt, ...rest } = change;
  return {
    ...rest,
    entity:
      entity === null
        ? null
        : {
            targetType: null,
            keywordText: null,
            matchType: null,
            expression: null,
            asin: null,
            sku: null,
            ...entity,
          },
    resolvedAt: toIso(resolvedAt),
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
}

function serializeSubmission(submission: AdChangeSubmissionSummary): AdChangeSubmission {
  return {
    ...submission,
    createdAt: submission.createdAt.toISOString(),
    startedAt: toIso(submission.startedAt),
    finishedAt: toIso(submission.finishedAt),
  };
}

/** Grenzen von Amazon je Ad-Typ, Land und Feld (`limits.ts`); ohne bekannte Grenze entscheidet Amazon. */
const limitFor: AdChangeLimitLookup = ({ adProduct, countryCode, field }) => {
  if (adProduct !== 'SPONSORED_PRODUCTS') return null;
  if (field === 'placement') return PLACEMENT_PERCENTAGE_LIMIT;
  const table = field === 'budget' ? SP_DAILY_BUDGET_LIMITS : SP_BID_LIMITS;
  return Object.hasOwn(table, countryCode) ? table[countryCode]! : null;
};

function check(changes: readonly PendingAdChange[]): AdChangeCheck {
  return checkAdChanges(changes, { limitFor });
}

const STATUS_BY_CODE = {
  PROFILE_HAS_NO_CONNECTION: 409,
  SUBMISSION_NOT_OPEN: 409,
  SUBMISSION_NOT_BULK_FILE: 409,
} as const;

function toApiError(error: unknown): unknown {
  return error instanceof AdChangeError
    ? new ApiError(STATUS_BY_CODE[error.code], error.code, error.message)
    : error;
}

export function registerAdChangeRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  const { db } = deps;
  const view = [requireSession(deps), requireFeature(deps, 'changes', 'view')];
  const write = [requireSession(deps), requireFeature(deps, 'changes', 'write')];
  const largeBody = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: () => {
      throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Der Request-Body ist zu groß.');
    },
  });
  /** Nutzer und aktive Organisation (die Guards garantieren beides). */
  const actor = (c: { get(key: 'auth'): AppEnv['Variables']['auth'] }) => {
    const auth = c.get('auth');
    return { userId: auth.user.id, orgId: auth.activeOrganization!.organizationId };
  };
  const noMember = () => new ApiError(403, 'FEATURE_FORBIDDEN', 'Kein Mitglied der Organisation.');
  const submissionNotFound = () =>
    new ApiError(404, 'SUBMISSION_NOT_FOUND', 'Übermittlung nicht gefunden.');

  /** Plant je Connection den Job ein, in der Transaktion der Übermittlung. */
  const enqueue = async (tx: DbOrTx, submissions: readonly AdChangeSubmissionSummary[]) => {
    const connections = await listSubmissionConnections(
      tx,
      submissions.map((submission) => submission.id),
    );
    for (const connection of connections) {
      await deps.jobs.enqueueAdChangesSubmit(connection, { tx });
    }
  };

  /**
   * Bulk-Datei: Änderungen, die nicht in die Datei passen, gelten nicht als übermittelt. Sie scheitern gleich
   * nach dem Übermitteln mit Grund; die Zusammenfassungen kommen danach frisch aus der Datenbank.
   */
  async function settleBulkFiles(
    who: { userId: string; orgId: string },
    submissions: readonly AdChangeSubmissionSummary[],
  ) {
    const skipped: { changeId: string; code: string; message: string }[] = [];
    const settled: AdChangeSubmissionSummary[] = [];
    for (const submission of submissions) {
      if (submission.channel !== 'bulk_file') {
        settled.push(submission);
        continue;
      }
      const found = await getBulkFileSubmissionRows(db, { ...who, submissionId: submission.id });
      const file = found ? buildSubmissionBulkFile(found.rows) : null;
      if (!file || file.skipped.length === 0) {
        settled.push(submission);
        continue;
      }
      const now = new Date();
      const scope = { organizationId: who.orgId, submissionId: submission.id, now };
      await recordAdChangeResults(db, {
        ...scope,
        results: file.skipped.map((skip) => ({ ...skip, outcome: 'failed' })),
      });
      // Ist nichts mehr offen, ist die Übermittlung damit abgeschlossen.
      await finishAdChangeSubmission(db, scope);
      skipped.push(...file.skipped);
      const fresh = await getAdChangeSubmission(db, { ...who, submissionId: submission.id });
      settled.push(fresh?.submission ?? submission);
    }
    return { submissions: settled.map(serializeSubmission), bulkFileSkipped: skipped };
  }

  app.openapi({ ...pendingRoute, middleware: view }, async (c) => {
    const changes = await listPendingAdChanges(db, actor(c));
    if (changes === null) throw noMember();
    return c.json(
      {
        changes: changes.map((change) => ({
          ...serializeChange(change),
          otherUsers: change.otherUsers,
        })),
        check: check(changes),
      },
      200,
    );
  });

  app.openapi({ ...stageRoute, middleware: [largeBody, ...write] }, async (c) => {
    const body = c.req.valid('json');
    const result = await stageAdChanges(db, { ...actor(c), ...body });
    if (result === null) throw noMember();
    return c.json(result, 200);
  });

  app.openapi({ ...discardRoute, middleware: [largeBody, ...write] }, async (c) => {
    const { changeIds } = c.req.valid('json');
    const discarded = await discardPendingAdChanges(db, {
      ...actor(c),
      ...(changeIds && { changeIds }),
    });
    if (discarded === null) throw noMember();
    return c.json({ discarded }, 200);
  });

  app.openapi({ ...submitRoute, middleware: [largeBody, ...write] }, async (c) => {
    const who = actor(c);
    const body = c.req.valid('json');
    const cart = await listPendingAdChanges(db, who);
    if (cart === null) throw noMember();
    const wanted = body.changeIds && new Set(body.changeIds);
    const selected = cart.filter(
      (change) =>
        (body.profileId === undefined || change.profileId === body.profileId) &&
        (wanted === undefined || wanted.has(change.id)),
    );
    const result = check(selected);
    if (result.violations.length > 0) {
      return c.json({ status: 'limitsExceeded' as const, check: result }, 200);
    }
    if ((result.largeChanges.length > 0 || result.tooMany) && !body.confirmWarnings) {
      return c.json({ status: 'needsConfirmation' as const, check: result }, 200);
    }
    try {
      const submitted = await submitAdChanges(db, {
        ...who,
        channel: body.channel,
        ...(body.profileId && { profileId: body.profileId }),
        // Genau die geprüften Änderungen: Was seit der Prüfung dazukam, bleibt im Warenkorb.
        changeIds: selected.map((change) => change.id),
        enqueue,
      });
      if (submitted === null) throw noMember();
      return c.json(
        {
          status: 'submitted' as const,
          dropped: submitted.dropped,
          blocked: submitted.blocked,
          ...(await settleBulkFiles(who, submitted.submissions)),
        },
        200,
      );
    } catch (error) {
      throw toApiError(error);
    }
  });

  app.openapi({ ...openRoute, middleware: view }, async (c) => {
    const changes = await listOpenAdChanges(db, actor(c));
    if (changes === null) throw noMember();
    return c.json({ changes, truncated: changes.length >= AD_CHANGE_OPEN_LIST_LIMIT }, 200);
  });

  app.openapi({ ...historyRoute, middleware: view }, async (c) => {
    const body = c.req.valid('json');
    const changes = await listAdChangeHistory(db, {
      ...actor(c),
      ...(body.entityType && { entityType: body.entityType }),
      ...(body.entityId && { entityId: body.entityId }),
      ...(body.profileId && { profileId: body.profileId }),
      ...(body.limit && { limit: body.limit }),
    });
    if (changes === null) throw noMember();
    return c.json(
      {
        changes: changes.map(({ channel, createdByName, ...change }) => ({
          ...serializeChange(change),
          channel,
          createdByName,
        })),
      },
      200,
    );
  });

  app.openapi({ ...submissionsRoute, middleware: view }, async (c) => {
    const submissions = await listAdChangeSubmissions(db, actor(c));
    if (submissions === null) throw noMember();
    return c.json({ submissions: submissions.map(serializeSubmission) }, 200);
  });

  app.openapi({ ...submissionRoute, middleware: view }, async (c) => {
    const found = await getAdChangeSubmission(db, {
      ...actor(c),
      submissionId: c.req.valid('param').id,
    });
    if (!found) throw submissionNotFound();
    return c.json(
      {
        submission: serializeSubmission(found.submission),
        changes: found.changes.map(({ followUp, ...change }) => ({
          ...serializeChange(change),
          followUp,
        })),
        entitiesSyncedAt: toIso(await getProfileEntitiesSyncedAt(db, found.submission.profileId)),
      },
      200,
    );
  });

  app.openapi({ ...bulkFileRoute, middleware: write }, async (c) => {
    let found: Awaited<ReturnType<typeof getBulkFileSubmissionRows>>;
    try {
      found = await getBulkFileSubmissionRows(db, {
        ...actor(c),
        submissionId: c.req.valid('param').id,
      });
    } catch (error) {
      throw toApiError(error);
    }
    if (!found) throw submissionNotFound();
    const file = buildSubmissionBulkFile(found.rows);
    if (file.content === null) {
      throw new ApiError(
        409,
        'BULK_FILE_EMPTY',
        'Keine Änderung dieser Übermittlung passt in die Bulk-Datei.',
      );
    }
    const { accountName, countryCode, createdAt } = found.submission;
    const name = [
      'profitbash-aenderungen',
      slugify(accountName) || 'konto',
      countryCode.toLowerCase(),
      createdAt.toISOString().slice(0, 10),
    ].join('-');
    // Kopie in einen eigenen Puffer: `Response` nimmt keine Sicht auf einen geteilten.
    return c.body(new Uint8Array(file.content).buffer, 200, {
      'Content-Type': XLSX,
      'Content-Disposition': `attachment; filename="${name}.xlsx"`,
      'Cache-Control': 'no-store',
    });
  });

  app.openapi({ ...closeRoute, middleware: write }, async (c) => {
    try {
      const closed = await closeBulkFileSubmission(db, {
        ...actor(c),
        submissionId: c.req.valid('param').id,
        outcome: c.req.valid('json').outcome,
      });
      if (!closed) throw submissionNotFound();
      return c.json(closed, 200);
    } catch (error) {
      throw toApiError(error);
    }
  });

  app.openapi({ ...retryRoute, middleware: [largeBody, ...write] }, async (c) => {
    const who = actor(c);
    try {
      const result = await retryAdChanges(db, { ...who, ...c.req.valid('json'), enqueue });
      if (result === null) throw noMember();
      return c.json(
        { skipped: result.skipped, ...(await settleBulkFiles(who, result.submissions)) },
        200,
      );
    } catch (error) {
      throw toApiError(error);
    }
  });

  app.openapi({ ...dismissRoute, middleware: [largeBody, ...write] }, async (c) => {
    const dismissed = await dismissFailedAdChanges(db, { ...actor(c), ...c.req.valid('json') });
    if (dismissed === null) throw noMember();
    return c.json({ dismissed }, 200);
  });

  app.openapi({ ...revertRoute, middleware: [largeBody, ...write] }, async (c) => {
    const who = actor(c);
    const body = c.req.valid('json');
    try {
      const result = await revertAdChanges(db, {
        ...who,
        channel: body.channel,
        ...(body.submissionId && { submissionId: body.submissionId }),
        ...(body.changeIds && { changeIds: body.changeIds }),
        ...(body.overwriteChanged && { overwriteChanged: true }),
        enqueue,
      });
      if (result === null) throw noMember();
      if (result.status === 'conflict') return c.json(result, 200);
      return c.json(
        {
          status: 'submitted' as const,
          skipped: result.skipped,
          ...(await settleBulkFiles(who, result.submissions)),
        },
        200,
      );
    } catch (error) {
      throw toApiError(error);
    }
  });
}
