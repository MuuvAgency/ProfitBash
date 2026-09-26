/** Zeitstempel für JSON-Antworten (ISO 8601, UTC). */
export function toIso(date: Date | null): string | null {
  return date === null ? null : date.toISOString();
}

/**
 * Verletzt der Fehler (oder eine seiner Ursachen) den Unique-Constraint `constraint`?
 * Drizzle verpackt Postgres-Fehler in `cause`.
 */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const { code, constraint_name: name } = current as {
      code?: unknown;
      constraint_name?: unknown;
    };
    if (code === '23505' && name === constraint) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
