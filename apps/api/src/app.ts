import { OpenAPIHono, type Hook } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { requestId } from 'hono/request-id';
import type { AppDeps, AppEnv } from './context';
import { ApiError, createErrorHandler, errorResponse, notFoundHandler } from './errors';
import { consoleLogger } from './logger';
import { csrfProtection, requestLogger } from './middleware';
import { registerAmazonOAuthRoutes } from './routes/amazon-oauth';
import { registerClientRoutes } from './routes/clients';
import { registerConnectionRoutes } from './routes/connections';
import { registerHealthRoutes } from './routes/health';
import { registerMeRoutes } from './routes/me';
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
const PUBLIC_AUTH_PATHS = ['/sign-in/email', '/sign-out', '/get-session', '/ok', '/error'];
const PUBLIC_AUTH_PREFIXES = ['/organization/'];

function isPublicAuthPath(path: string): boolean {
  const authPath = path.slice('/api/auth'.length);
  return (
    PUBLIC_AUTH_PATHS.includes(authPath) ||
    PUBLIC_AUTH_PREFIXES.some((prefix) => authPath.startsWith(prefix))
  );
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
  app.use(
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: () => {
        throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Der Request-Body ist zu groß.');
      },
    }),
  );
  app.use(csrfProtection(deps.appUrl));

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

  app.doc31('/openapi.json', {
    openapi: '3.1.0',
    info: { title: 'ProfitBash API', version: deps.version },
  });

  return app;
}
