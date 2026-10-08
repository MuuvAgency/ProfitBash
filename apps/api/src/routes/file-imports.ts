import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  AccessDeniedError,
  BULK_PERIOD_ISSUE_MESSAGES,
  createFileImport,
  FileImportError,
  listFileImports,
} from '@profitbash/db';
import {
  BULK_PERIOD_MAX_DAYS,
  bulkPeriodIssue,
  errorResponseSchema,
  FILE_IMPORT_KINDS,
  FILE_IMPORT_MAX_BYTES,
  fileImportListSchema,
  fileImportSchema,
  idParamSchema,
  parseBulkPeriod,
} from '@profitbash/shared';
import { bodyLimit } from 'hono/body-limit';
import type { AppDeps, AppEnv } from '../context';
import { ApiError } from '../errors';
import { orgAdminOnly } from '../middleware';

/**
 * Datei-Import aus der Werbekonsole (`phase-1.md` 1.11c): Upload je Profil ohne Connection und Verlauf der
 * Importe. Den Import selbst macht der Job `file-import` im Worker.
 */

const json = <T>(schema: T) => ({ 'application/json': { schema } });

/** Platz für die Multipart-Hülle (Boundary, Feldnamen) zusätzlich zur Datei. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const UPLOAD_PATH = /^\/api\/profiles\/[^/]+\/file-imports$/;

/** Upload-Requests nimmt das allgemeine Body-Limit aus; ihr Limit sitzt an der Route. */
export function isFileUpload(method: string, path: string): boolean {
  return method === 'POST' && UPLOAD_PATH.test(path);
}

/** Nur der Dateiname, ohne Pfad (Browser unter Windows schicken ihn teils mit) und ohne Steuerzeichen. */
function baseName(name: string): string {
  // Steuer- und Formatzeichen (z. B. Richtungswechsel, die einen Namen anders aussehen lassen) entfernen.
  const base =
    name
      .replace(/[\p{Cc}\p{Cf}]/gu, '')
      .split(/[\\/]/)
      .pop()
      ?.trim() ?? '';
  return (base || 'datei').slice(0, 255);
}

const periodDay = (which: string) =>
  // Leerer Text gilt wie ein fehlendes Feld (HTML-Formulare senden leere Datumsfelder mit).
  z
    .union([z.iso.date(), z.literal('')])
    .optional()
    .describe(
      `${which} Tag des Zeitraums, über den die Datei ihre Kennzahlen summiert (YYYY-MM-DD, eingeschlossen). Nur für ` +
        `Dateien, deren Name keinen Zeitraum trägt: beide Tage oder keiner, höchstens ${BULK_PERIOD_MAX_DAYS} Tage, ` +
        'nicht in der Zukunft, höchstens ein Jahr zurück. Trägt der Dateiname einen Zeitraum, gilt der und die Felder werden ignoriert.',
    );

const uploadSchema = z
  .object({
    kind: z.enum(FILE_IMPORT_KINDS),
    // Für OpenAPI als Binärfeld beschreiben (der Generator kennt `z.file()` nicht).
    file: z.file().meta({ type: 'string', format: 'binary' }),
    /** Datei enthält alle Entities (Bulk-Datei aller Kampagnen): der Import markiert Fehlendes als entfernt. */
    complete: z.enum(['true', 'false']).optional(),
    /** Zeitraum von Hand (`phase-2b.md` 2b.2c), für umbenannte Dateien: ohne ihn bleiben deren Suchbegriffe weg. */
    periodStart: periodDay('Erster'),
    periodEnd: periodDay('Letzter'),
  })
  .superRefine((value, ctx) => {
    // Der Dateiname der Werbekonsole gewinnt (wie im Import, `parseBulkPeriod`): Trägt er einen Zeitraum, werden
    // die Felder ignoriert und über ihre Schreibweise hinaus nicht geprüft.
    if (parseBulkPeriod(baseName(value.file.name))) return;
    // „Kein Tag in der Zukunft“ und „höchstens ein Jahr zurück“ prüft `createFileImport` mit dem Kalendertag in
    // der Zeitzone des Profils.
    const issue = bulkPeriodIssue({ startDate: value.periodStart, endDate: value.periodEnd });
    if (issue) {
      ctx.addIssue({
        code: 'custom',
        path: [!value.periodStart ? 'periodStart' : 'periodEnd'],
        message: BULK_PERIOD_ISSUE_MESSAGES[issue],
      });
    }
  });

const errors = {
  400: {
    description: 'Ungültige Eingabe, ungültiger Zeitraum oder leere Datei.',
    content: json(errorResponseSchema),
  },
  401: { description: 'Nicht angemeldet.', content: json(errorResponseSchema) },
  403: { description: 'Keine Admin-Rolle.', content: json(errorResponseSchema) },
  404: { description: 'Profil nicht gefunden.', content: json(errorResponseSchema) },
};

const uploadRoute = createRoute({
  method: 'post',
  path: '/profiles/{id}/file-imports',
  tags: ['Datei-Import'],
  summary: 'Datei aus der Werbekonsole hochladen und den Import einplanen (nur Admin)',
  request: {
    params: idParamSchema,
    body: { required: true, content: { 'multipart/form-data': { schema: uploadSchema } } },
  },
  responses: {
    201: { description: 'Datei angenommen, Import eingeplant.', content: json(fileImportSchema) },
    ...errors,
    409: { description: 'Das Profil hat eine Connection.', content: json(errorResponseSchema) },
    413: { description: 'Datei zu groß.', content: json(errorResponseSchema) },
  },
});

const listRoute = createRoute({
  method: 'get',
  path: '/profiles/{id}/file-imports',
  tags: ['Datei-Import'],
  summary: 'Letzte Datei-Importe eines Profils (nur Admin)',
  request: { params: idParamSchema },
  responses: {
    200: { description: 'Importe, neueste zuerst.', content: json(fileImportListSchema) },
    ...errors,
  },
});

const STATUS_BY_CODE = {
  PROFILE_NOT_FOUND: 404,
  PROFILE_HAS_CONNECTION: 409,
  EMPTY_FILE: 400,
  INVALID_PERIOD: 400,
} as const;

function toApiError(error: unknown): unknown {
  if (error instanceof FileImportError) {
    return new ApiError(STATUS_BY_CODE[error.code], error.code, error.message);
  }
  if (error instanceof AccessDeniedError) return new ApiError(403, 'FORBIDDEN', error.message);
  return error;
}

export function registerFileImportRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  const { db } = deps;
  const tooLarge = () => {
    throw new ApiError(413, 'FILE_TOO_LARGE', 'Die Datei ist größer als erlaubt (50 MB).');
  };
  const uploadLimit = bodyLimit({
    maxSize: FILE_IMPORT_MAX_BYTES + MULTIPART_OVERHEAD_BYTES,
    onError: tooLarge,
  });
  const orgOf = (auth: AppEnv['Variables']['auth']) => auth.activeOrganization!.organizationId;

  app.openapi({ ...uploadRoute, middleware: [uploadLimit, ...orgAdminOnly(deps)] }, async (c) => {
    const auth = c.get('auth');
    const organizationId = orgOf(auth);
    const profileId = c.req.valid('param').id;
    const { kind, file, complete, periodStart, periodEnd } = c.req.valid('form');
    if (file.size > FILE_IMPORT_MAX_BYTES) tooLarge();
    try {
      const created = await createFileImport(db, {
        userId: auth.user.id,
        orgId: organizationId,
        profileId,
        kind,
        complete: complete === 'true',
        fileName: baseName(file.name),
        // Nur für Dateien ohne Zeitraum im Namen; sonst verwirft `createFileImport` die Angabe (Dateiname gewinnt).
        period: periodStart && periodEnd ? { startDate: periodStart, endDate: periodEnd } : null,
        content: new Uint8Array(await file.arrayBuffer()),
        enqueue: (tx) => deps.jobs.enqueueFileImport({ organizationId, profileId }, { tx }),
      });
      return c.json(created, 201);
    } catch (error) {
      throw toApiError(error);
    }
  });

  app.openapi({ ...listRoute, middleware: orgAdminOnly(deps) }, async (c) => {
    const auth = c.get('auth');
    try {
      const fileImports = await listFileImports(db, {
        userId: auth.user.id,
        orgId: orgOf(auth),
        profileId: c.req.valid('param').id,
      });
      return c.json({ fileImports }, 200);
    } catch (error) {
      throw toApiError(error);
    }
  });
}
