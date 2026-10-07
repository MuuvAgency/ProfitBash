import { OpenAPIHono, type Hook } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { compress } from 'hono/compress';
import { requestId } from 'hono/request-id';
import type { AppDeps, AppEnv } from './context';
import { ApiError, createErrorHandler, errorResponse, notFoundHandler } from './errors';
import { consoleLogger } from './logger';
import { csrfProtection, requestLogger } from './middleware';
import { registerAmazonOAuthRoutes } from './routes/amazon-oauth';
import { registerAnalyticsRoutes } from './routes/analytics';
import { registerClientRoutes } from './routes/clients';
import { registerConnectionRoutes } from './routes/connections';
import { isFileUpload, registerFileImportRoutes } from './routes/file-imports';
import { registerHealthRoutes } from './routes/health';
import { registerJobRunRoutes } from './routes/job-runs';
import { registerMemberRoutes } from './routes/members';
import { registerMeRoutes } from './routes/me';
import { registerSavedViewRoutes } from './routes/saved-views';
import { registerSearchTermRoutes } from './routes/search-terms';
import { registerSettingsRoutes } from './routes/settings';

export type CreateAppOptions = Omit<AppDeps, 'logger'> & Partial<Pick<AppDeps, 'logger'>>;

/** Größter akzeptierter Request-Body. Schützt vor Speicherverbrauch durch riesige Bodies. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * better-auth-Endpunkte, die per HTTP erreichbar sind (Pfad unter `/api/auth`). Alle schreibenden
 * darunter erzeugen Audit-Events (siehe `auth.ts`). Weitere Endpunkte (Passwort ändern, Profil,
 * Admin-Plugin) werden erst freigegeben, wenn sie mit Audit und UI gebraucht werden.
 * Serverseitige Aufrufe über `auth.api.*` (z. B. im Seed) sind davon nicht betroffen.
 */
const PUBLIC_AUTH_PATHS = [
  '/sign-in/email',
  '/sign-out',
  '/get-session',
  '/ok',
  '/error',
  // Organisation wechseln (Account-Menü). Mitglieder verwaltet die App selbst (`/api/members`, 2.10): Die
  // better-auth-Endpunkte dafür (entfernen, Rolle, einladen, verlassen) kennen weder den Schutz des letzten Admins noch
  // das Beenden der Sessions und bleiben deshalb gesperrt.
  '/organization/set-active',
];

function isPublicAuthPath(path: string): boolean {
  return PUBLIC_AUTH_PATHS.includes(path.slice('/api/auth'.length));
}

/** Antwortet auf ungültige Eingaben (zod) im einheitlichen Fehlerformat. */
const validationHook: Hook<unknown, AppEnv, string, unknown> = (result, c) => {
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return errorResponse(c, 400, 'VALIDATION_ERROR', message);
  }
};

/** Baut die Hono-App. Getrennt vom Serverstart, damit Tests sie ohne Port nutzen können. */
export function createApp(options: CreateAppOptions) {
  const deps: AppDeps = { ...options, logger: options.logger ?? consoleLogger };
  const app = new OpenAPIHono<AppEnv>({ defaultHook: validationHook }).basePath('/api');

  app.onError(createErrorHandler(deps.logger));
  app.notFound(notFoundHandler);
  app.use(requestId({ limitLength: 128 }));
  app.use(requestLogger(deps.logger));
  const defaultBodyLimit = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: () => {
      throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Der Request-Body ist zu groß.');
    },
  });
  // Der Datei-Upload hat ein eigenes, größeres Limit an seiner Route (1.11c).
  app.use((c, next) =>
    isFileUpload(c.req.method, c.req.path) ? next() : defaultBodyLimit(c, next),
  );
  app.use(csrfProtection(deps.appUrl));
  // Auswertungen liefern bis zu 10 000 Zeilen mit Vergleich (mehrere MB JSON): komprimieren (F7).
  app.use('/ads/*', compress());

  // better-auth: Login, Logout, Session, Organisationen (Allowlist, siehe oben)
  app.on(['GET', 'POST'], '/auth/*', (c) => {
    if (!isPublicAuthPath(c.req.path)) return notFoundHandler(c);
    return deps.auth.handler(c.req.raw);
  });

  registerHealthRoutes(app, deps);
  registerMeRoutes(app, deps);
  registerSettingsRoutes(app, deps);
  registerAmazonOAuthRoutes(app, deps);
  registerConnectionRoutes(app, deps);
  registerClientRoutes(app, deps);
  registerJobRunRoutes(app, deps);
  registerFileImportRoutes(app, deps);
  registerAnalyticsRoutes(app, deps);
  registerSavedViewRoutes(app, deps);
  registerSearchTermRoutes(app, deps);
  registerMemberRoutes(app, deps);

  app.doc31('/openapi.json', {
    openapi: '3.1.0',
    info: { title: 'ProfitBash API', version: deps.version },
  });

  return app;
}
