/**
 * Felder für das Log eines unerwarteten Fehlers. Fehlgeschlagene Drizzle-Abfragen tragen die
 * Parameterwerte in Meldung und Stack (verschlüsselte Tokens, E-Mails); geloggt werden dann nur SQL
 * mit Platzhaltern, Postgres-Code und Constraint. Auch die Postgres-Meldung bleibt draußen, sie
 * zitiert Eingabewerte.
 */
export function errorLogFields(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { error: String(err) };
  if (isDbQueryError(err)) {
    const cause = (err.cause ?? {}) as { code?: unknown; constraint_name?: unknown };
    return {
      error: 'Datenbankabfrage fehlgeschlagen.',
      query: err.query,
      dbCode: cause.code,
      dbConstraint: cause.constraint_name,
      stack: err.stack
        ?.split('\n')
        .filter((line) => line.trimStart().startsWith('at '))
        .join('\n'),
    };
  }
  return { error: err.message, stack: err.stack };
}

/** Fehlgeschlagene Drizzle-Abfrage (Meldung und Stack enthalten die Parameterwerte). */
export function isDbQueryError(err: unknown): err is Error & { query: string } {
  return err instanceof Error && 'query' in err && typeof err.query === 'string' && 'params' in err;
}
